/**
 * Файлы документов клиентов (паспорта, анкеты, визы): хранятся в базе зашифрованными AES-256-GCM тем же ключом
 * ENCRYPTION_KEY, что и анкета с сайта (siteDataEnc). Каждый просмотр, скачивание, загрузка и удаление пишется
 * в журнал DocumentAccess. По сроку хранения содержимое удаляется (purgeExpiredDocuments; минимизация персональных
 * данных — docs/orient-visa-integration.md, раздел 3).
 */
import crypto from "node:crypto";
import type { Prisma, ServiceType, VisaStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getKey } from "@/lib/crypto";
import { chatFileUrl } from "@/lib/chats/file-url";

/** Признак зашифрованного файла: «OTD1» + iv (12) + тег (16) + шифртекст */
const MAGIC = Buffer.from("OTD1");

export function encryptBytes(plain: Uint8Array): Uint8Array<ArrayBuffer> {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return new Uint8Array(Buffer.concat([MAGIC, iv, cipher.getAuthTag(), enc]));
}

/** Расшифровка; старые файлы, сохранённые до шифрования, возвращаются как есть */
export function decryptBytes(stored: Uint8Array, encrypted: boolean): Buffer {
  const buf = Buffer.from(stored);
  if (!encrypted) return buf;
  if (buf.length < 32 || !buf.subarray(0, 4).equals(MAGIC)) throw new Error("Повреждённый зашифрованный файл");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), buf.subarray(4, 16));
  decipher.setAuthTag(buf.subarray(16, 32));
  return Buffer.concat([decipher.update(buf.subarray(32)), decipher.final()]);
}

export const sha256Hex = (data: Uint8Array) => crypto.createHash("sha256").update(data).digest("hex");

/** Поля для сохранения нового файла документа: зашифрованное содержимое, размер и SHA-256 исходника */
export function docFileFields(plain: Uint8Array) {
  return { data: encryptBytes(plain), encrypted: true, size: plain.length, sha256: sha256Hex(plain) };
}

export type DocAction = "view" | "download" | "upload" | "delete" | "purge" | "site";

export async function logDocAccess(
  docs: { id: string; serviceId?: string | null; fileName: string }[],
  action: DocAction,
  userId: string | null,
  ip?: string | null,
  tx: Prisma.TransactionClient = prisma,
) {
  if (!docs.length) return;
  await tx.documentAccess.createMany({
    data: docs.map((d) => ({ documentId: d.id, serviceId: d.serviceId ?? null, fileName: d.fileName, action, userId, ip: ip ?? null })),
  });
}

/** Шифрование файлов, сохранённых до появления шифрования, — понемногу, чтобы не держать базу (воркер) */
export async function encryptStoredDocuments(batch = 20): Promise<number> {
  const docs = await prisma.leadDocument.findMany({ where: { encrypted: false, purgedAt: null }, select: { id: true, data: true }, take: batch });
  for (const d of docs) {
    const plain = Buffer.from(d.data);
    // updateMany с условием: если файл за это время зашифровали или удалили, не трогаем
    await prisma.leadDocument.updateMany({ where: { id: d.id, encrypted: false }, data: { data: encryptBytes(plain), encrypted: true, sha256: sha256Hex(plain) } });
  }
  return docs.length;
}

/**
 * Удалить файлы документов и анкету с сайта одной заявки. Записи о документах (тип, имя файла, кто загрузил)
 * остаются с пометкой «удалён по сроку хранения»; в журнал доступа — «удаление по сроку».
 */
export async function purgeServiceDocuments(tx: Prisma.TransactionClient, serviceId: string, now = new Date()): Promise<number> {
  const docs = await tx.leadDocument.findMany({ where: { serviceId, purgedAt: null }, select: { id: true, serviceId: true, fileName: true } });
  if (docs.length) await tx.leadDocument.updateMany({ where: { id: { in: docs.map((d) => d.id) } }, data: { data: Buffer.alloc(0), purgedAt: now } });
  await tx.leadService.update({ where: { id: serviceId }, data: { siteDataEnc: null, purgedAt: now } });
  await logDocAccess(docs, "purge", null, null, tx);
  return docs.length;
}

const DAY = 86_400_000;
const FINAL: VisaStatus[] = ["APPROVED", "REJECTED"];
/** Услуги, документы которых нужны только до конца поездки */
const TRIP_TYPES: ServiceType[] = ["FLIGHTS", "TOUR", "INSURANCE", "OTHER"];
/** За одну ночь — не больше BATCH × MAX_BATCHES заявок, остальные на следующую */
const BATCH = 50;
const MAX_BATCHES = 40;

export type RetentionSettings = { docRetentionDays: number; tripDocRetentionDays: number; idleDocRetentionDays: number };

/** По заявке не было движения с этой даты: она не менялась, не появлялось документов, этапов и комментариев */
const idleSince = (since: Date): Prisma.LeadServiceWhereInput => ({
  updatedAt: { lt: since },
  documents: { none: { createdAt: { gte: since } } },
  events: { none: { createdAt: { gte: since } } },
});

/**
 * Какие заявки пора очистить (решения владельца 22.11 и 28.11.2026), 0 дней — правило выключено:
 * - виза выдана, отказ или заявку отменили на сайте — через docRetentionDays дней;
 * - виза без итога — через idleDocRetentionDays дней без движения (брошенная);
 * - туры, авиабилеты, страховки и прочее — через tripDocRetentionDays дней после возвращения клиента (дата поездки «по»
 *   в лиде, а если её нет — «с»), когда столько же дней не было движения; если дат поездки нет — как брошенные.
 * Уже очищенная заявка снова попадает сюда, только если в неё загрузили новые документы.
 */
export function retentionWhere(s: RetentionSettings, now: Date): Prisma.LeadServiceWhereInput | null {
  const ago = (days: number) => new Date(now.getTime() - days * DAY);
  const rules: Prisma.LeadServiceWhereInput[] = [];
  if (s.docRetentionDays > 0) {
    const before = ago(s.docRetentionDays);
    rules.push({ type: "VISA", OR: [{ status: { in: FINAL }, statusAt: { lt: before } }, { cancelledAt: { lt: before } }] });
  }
  if (s.idleDocRetentionDays > 0) {
    const before = ago(s.idleDocRetentionDays);
    rules.push({ type: "VISA", status: { notIn: FINAL }, cancelledAt: null, ...idleSince(before) });
    rules.push({ type: { in: TRIP_TYPES }, lead: { travelFrom: null, travelTo: null }, ...idleSince(before) });
  }
  if (s.tripDocRetentionDays > 0) {
    const before = ago(s.tripDocRetentionDays);
    rules.push({ type: { in: TRIP_TYPES }, lead: { OR: [{ travelTo: { lt: before } }, { travelTo: null, travelFrom: { lt: before } }] }, ...idleSince(before) });
  }
  if (!rules.length) return null;
  return { AND: [{ OR: rules }, { OR: [{ purgedAt: null }, { documents: { some: { purgedAt: null } } }] }] };
}

/**
 * Файлы, отправленные клиентам из CRM (ChatFile), старше срока удаляются; в переписке вместо них — «удалён по сроку
 * хранения». Ссылка у сообщения убирается в той же транзакции, что и файл, поэтому битых вложений не остаётся.
 */
export async function purgeChatFiles(before: Date, batch = 200): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const files = await prisma.chatFile.findMany({ where: { createdAt: { lt: before } }, select: { id: true, token: true }, orderBy: { createdAt: "asc" }, take: batch });
    if (!files.length) break;
    const urls = files.map((f) => chatFileUrl(f.token));
    await prisma.$transaction([
      prisma.$executeRaw`UPDATE "ChatMessage" SET "attachments" = jsonb_set("attachments", '{0}', (("attachments" -> 0) - 'url') || '{"purged": true}'::jsonb)
        WHERE "direction" = 'OUT' AND "attachments" -> 0 ->> 'url' = ANY(${urls})`,
      prisma.chatFile.deleteMany({ where: { id: { in: files.map((f) => f.id) } } }),
    ]);
    total += files.length;
  }
  return total;
}

/**
 * Срок хранения (воркер, ночью): у подходящих заявок удаляются файлы документов и анкета с сайта
 * (purgeServiceDocuments), затем старые файлы из переписки. Перед удалением заявка проверяется ещё раз: если за это
 * время в неё загрузили документ, она остаётся.
 */
export async function purgeExpiredDocuments(now = new Date()): Promise<{ services: number; documents: number; chatFiles: number }> {
  const s = await prisma.appSettings.findUnique({ where: { id: 1 }, select: { docRetentionDays: true, tripDocRetentionDays: true, idleDocRetentionDays: true } });
  const settings: RetentionSettings = { docRetentionDays: s?.docRetentionDays ?? 0, tripDocRetentionDays: s?.tripDocRetentionDays ?? 0, idleDocRetentionDays: s?.idleDocRetentionDays ?? 0 };
  const where = retentionWhere(settings, now);
  let services = 0;
  let documents = 0;
  let cursor: string | null = null;
  for (let i = 0; where && i < MAX_BATCHES; i++) {
    const batch: { id: string }[] = await prisma.leadService.findMany({
      where: cursor ? { AND: [where, { id: { gt: cursor } }] } : where,
      select: { id: true },
      orderBy: { id: "asc" },
      take: BATCH,
    });
    if (!batch.length) break;
    for (const svc of batch) {
      const n = await prisma.$transaction(async (tx) => ((await tx.leadService.count({ where: { AND: [{ id: svc.id }, where] } })) ? purgeServiceDocuments(tx, svc.id, now) : null));
      if (n === null) continue;
      services++;
      documents += n;
    }
    cursor = batch[batch.length - 1].id;
  }
  const chatFiles = settings.idleDocRetentionDays > 0 ? await purgeChatFiles(new Date(now.getTime() - settings.idleDocRetentionDays * DAY)) : 0;
  return { services, documents, chatFiles };
}
