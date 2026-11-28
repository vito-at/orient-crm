import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServiceType, VisaStatus } from "@prisma/client";

/**
 * Сроки хранения на настоящей PostgreSQL (npm run test:db, в CI — после миграций и seed): проверяет, что запросы
 * purgeExpiredDocuments понимает база (связи, JSON переписки) и что удаляется ровно то, что решил владелец 28.11.2026.
 * Свои записи тест создаёт и удаляет сам; настройки сроков возвращает как были. Но очистка проходит по всей базе,
 * поэтому тест запускается только на базе на этой же машине (в CI — временной), никогда на рабочей.
 */

if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(process.env.DATABASE_URL ?? "")) {
  throw new Error("test:db запускается только на тестовой базе на localhost: очистка проходит по всей базе");
}
process.env.ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const { prisma } = await import("@/lib/db");
const { purgeExpiredDocuments } = await import("@/lib/doc-files");

const DAY = 86_400_000;
const now = new Date();
const ago = (days: number) => new Date(now.getTime() - days * DAY);
const tag = crypto.randomBytes(4).toString("hex");

const created = { leads: [] as string[], docs: [] as string[], conversation: "", client: "", status: "" };
let savedSettings: { docRetentionDays: number; tripDocRetentionDays: number; idleDocRetentionDays: number } | null = null;

/** Заявка с документами; updatedAt выставляется задним числом, как будто по заявке давно ничего не происходило */
async function service(
  leadId: string,
  o: { type: ServiceType; status?: VisaStatus; updatedDaysAgo: number; statusDaysAgo?: number; cancelledDaysAgo?: number; docsDaysAgo: number[]; purgedDaysAgo?: number },
) {
  const s = await prisma.leadService.create({
    data: {
      leadId,
      type: o.type,
      status: o.status ?? "NEW",
      statusAt: ago(o.statusDaysAgo ?? o.updatedDaysAgo),
      cancelledAt: o.cancelledDaysAgo === undefined ? null : ago(o.cancelledDaysAgo),
      purgedAt: o.purgedDaysAgo === undefined ? null : ago(o.purgedDaysAgo),
    },
  });
  const docs: string[] = [];
  for (const d of o.docsDaysAgo) {
    const doc = await prisma.leadDocument.create({
      data: { serviceId: s.id, leadId, docType: "Паспорт", fileName: `p-${tag}.pdf`, mime: "application/pdf", size: 4, data: Buffer.from("%PDF"), encrypted: false, createdAt: ago(d) },
    });
    docs.push(doc.id);
    created.docs.push(doc.id);
  }
  await prisma.$executeRaw`UPDATE "LeadService" SET "updatedAt" = ${ago(o.updatedDaysAgo)} WHERE "id" = ${s.id}`;
  return { id: s.id, docs };
}

async function lead(travelFrom: Date | null, travelTo: Date | null) {
  const l = await prisma.lead.create({ data: { source: "OTHER", name: `Тест сроков ${tag}`, clientId: created.client, statusId: created.status, travelFrom, travelTo } });
  created.leads.push(l.id);
  return l.id;
}

const S = {} as Record<string, { id: string; docs: string[] }>;
const files = { old: crypto.randomUUID(), fresh: crypto.randomUUID() };
const msgs = {} as Record<"old" | "fresh" | "incoming", string>;

beforeAll(async () => {
  savedSettings = await prisma.appSettings.findUnique({ where: { id: 1 }, select: { docRetentionDays: true, tripDocRetentionDays: true, idleDocRetentionDays: true } });
  await prisma.appSettings.upsert({
    where: { id: 1 },
    update: { docRetentionDays: 90, tripDocRetentionDays: 30, idleDocRetentionDays: 90 },
    create: { id: 1, docRetentionDays: 90, tripDocRetentionDays: 30, idleDocRetentionDays: 90 },
  });
  created.client = (await prisma.client.create({ data: { name: `Тест сроков ${tag}` } })).id;
  created.status = (await prisma.leadStatus.create({ data: { name: `Тест ${tag}`, order: 999 } })).id;

  const tripDone = await lead(ago(50), ago(40));
  S.tourAfterTrip = await service(tripDone, { type: "TOUR", updatedDaysAgo: 60, docsDaysAgo: [60, 55] });
  S.flightNewDoc = await service(tripDone, { type: "FLIGHTS", updatedDaysAgo: 60, docsDaysAgo: [60, 10] });
  const tripAhead = await lead(ago(-10), ago(-20));
  S.tourAhead = await service(tripAhead, { type: "TOUR", updatedDaysAgo: 100, docsDaysAgo: [100] });
  const oneWay = await lead(ago(45), null);
  S.oneWayFlight = await service(oneWay, { type: "FLIGHTS", updatedDaysAgo: 50, docsDaysAgo: [50] });
  const noDates = await lead(null, null);
  S.tourNoDatesIdle = await service(noDates, { type: "TOUR", updatedDaysAgo: 100, docsDaysAgo: [100] });
  S.insuranceNoDatesRecent = await service(noDates, { type: "INSURANCE", updatedDaysAgo: 80, docsDaysAgo: [80] });

  const visas = await lead(null, null);
  S.visaAbandoned = await service(visas, { type: "VISA", status: "IN_PROGRESS", updatedDaysAgo: 120, docsDaysAgo: [120] });
  S.visaWaitingWithComment = await service(visas, { type: "VISA", status: "PAID_WAITING", updatedDaysAgo: 120, docsDaysAgo: [120] });
  await prisma.visaEvent.create({ data: { serviceId: S.visaWaitingWithComment.id, comment: "Ждём ответа посольства", createdAt: ago(20) } });
  S.visaApprovedLongAgo = await service(visas, { type: "VISA", status: "APPROVED", updatedDaysAgo: 100, statusDaysAgo: 100, docsDaysAgo: [130] });
  S.visaApprovedRecently = await service(visas, { type: "VISA", status: "APPROVED", updatedDaysAgo: 30, statusDaysAgo: 30, docsDaysAgo: [60] });
  S.visaCancelledOnSite = await service(visas, { type: "VISA", status: "NEW", updatedDaysAgo: 100, cancelledDaysAgo: 100, docsDaysAgo: [110] });
  S.visaRecentlyChanged = await service(visas, { type: "VISA", status: "IN_PROGRESS", updatedDaysAgo: 5, docsDaysAgo: [120] });
  // очищена раньше, потом загрузили новый документ и снова бросили — новый документ тоже удаляется
  S.visaPurgedThenNewDoc = await service(visas, { type: "VISA", status: "IN_PROGRESS", updatedDaysAgo: 200, purgedDaysAgo: 200, docsDaysAgo: [95] });

  const conv = await prisma.conversation.create({ data: { channel: "TELEGRAM", externalId: `test-${tag}`, title: `Тест ${tag}` } });
  created.conversation = conv.id;
  for (const [key, token] of Object.entries(files) as ["old" | "fresh", string][]) {
    const at = key === "old" ? ago(100) : ago(10);
    await prisma.chatFile.create({ data: { token, name: "Ваучер.pdf", mime: "application/pdf", size: 4, data: Buffer.from("%PDF"), createdAt: at } });
    msgs[key] = (await prisma.chatMessage.create({ data: { conversationId: conv.id, direction: "OUT", attachments: [{ type: "file", url: `/api/chats/out/${token}`, name: "Ваучер.pdf" }], createdAt: new Date(at.getTime() + 2000) } })).id;
  }
  msgs.incoming = (await prisma.chatMessage.create({ data: { conversationId: conv.id, direction: "IN", attachments: [{ type: "image", fileId: "tg-file" }], createdAt: ago(200) } })).id;
});

afterAll(async () => {
  if (created.leads.length) await prisma.lead.deleteMany({ where: { id: { in: created.leads } } });
  if (created.docs.length) await prisma.documentAccess.deleteMany({ where: { documentId: { in: created.docs } } });
  if (created.conversation) await prisma.conversation.delete({ where: { id: created.conversation } });
  await prisma.chatFile.deleteMany({ where: { token: { in: Object.values(files) } } });
  if (created.status) await prisma.leadStatus.delete({ where: { id: created.status } });
  if (created.client) await prisma.client.delete({ where: { id: created.client } });
  if (savedSettings) await prisma.appSettings.update({ where: { id: 1 }, data: savedSettings });
  await prisma.$disconnect();
});

describe("ночная очистка на настоящей базе", () => {
  it("удаляет документы по решению владельца и не трогает остальные", async () => {
    const r = await purgeExpiredDocuments(now);
    const purged = new Set(
      (await prisma.leadDocument.findMany({ where: { id: { in: created.docs }, purgedAt: { not: null } }, select: { id: true } })).map((d) => d.id),
    );
    const state = (key: string) => S[key].docs.map((id) => purged.has(id));

    // туры и билеты: через 30 дней после возвращения (дата «по», без неё — «с»), если 30 дней не было новых документов
    expect(state("tourAfterTrip")).toEqual([true, true]);
    expect(state("flightNewDoc")).toEqual([false, false]);
    expect(state("tourAhead")).toEqual([false]);
    expect(state("oneWayFlight")).toEqual([true]);
    // без дат поездки — через 90 дней без движения
    expect(state("tourNoDatesIdle")).toEqual([true]);
    expect(state("insuranceNoDatesRecent")).toEqual([false]);
    // визы: брошенная — через 90 дней без движения; комментарий или изменение заявки — это движение
    expect(state("visaAbandoned")).toEqual([true]);
    expect(state("visaWaitingWithComment")).toEqual([false]);
    expect(state("visaRecentlyChanged")).toEqual([false]);
    // визы с итогом и отменённые на сайте — через 90 дней после итога / отмены, как раньше
    expect(state("visaApprovedLongAgo")).toEqual([true]);
    expect(state("visaApprovedRecently")).toEqual([false]);
    expect(state("visaCancelledOnSite")).toEqual([true]);
    expect(state("visaPurgedThenNewDoc")).toEqual([true]);

    const emptied = await prisma.leadDocument.findMany({ where: { id: { in: [...purged] } }, select: { data: true } });
    expect(emptied.every((d) => d.data.length === 0)).toBe(true);
    const log = await prisma.documentAccess.findMany({ where: { documentId: { in: [...purged] }, action: "purge" }, select: { documentId: true } });
    expect(new Set(log.map((l) => l.documentId))).toEqual(purged);
    expect(r.services).toBeGreaterThanOrEqual(7);
    expect(r.documents).toBeGreaterThanOrEqual(purged.size);

    // повторный запуск ничего не находит среди наших заявок
    const before = await prisma.documentAccess.count({ where: { documentId: { in: created.docs } } });
    await purgeExpiredDocuments(now);
    expect(await prisma.documentAccess.count({ where: { documentId: { in: created.docs } } })).toBe(before);
  });

  it("старый файл из переписки удалён, у сообщения вместо ссылки — пометка; свежие файлы и входящие не тронуты", async () => {
    expect(await prisma.chatFile.findUnique({ where: { token: files.old } })).toBeNull();
    expect(await prisma.chatFile.findUnique({ where: { token: files.fresh } })).not.toBeNull();
    const m = Object.fromEntries((await prisma.chatMessage.findMany({ where: { id: { in: Object.values(msgs) } } })).map((x) => [x.id, x.attachments]));
    expect(m[msgs.old]).toEqual([{ type: "file", name: "Ваучер.pdf", purged: true }]);
    expect(m[msgs.fresh]).toEqual([{ type: "file", url: `/api/chats/out/${files.fresh}`, name: "Ваучер.pdf" }]);
    expect(m[msgs.incoming]).toEqual([{ type: "image", fileId: "tg-file" }]);
  });
});
