import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Сроки хранения документов (аудит 27.11, п. 17; решение владельца 28.11.2026): какие заявки очищаются, обход пачками,
 * повторная проверка перед удалением, файлы из переписки. База поддельная; те же правила на настоящей базе —
 * tests/db/retention.dbtest.ts.
 */

process.env.ENCRYPTION_KEY = "a".repeat(64);

const db = vi.hoisted(() => ({
  settings: null as null | { docRetentionDays: number; tripDocRetentionDays: number; idleDocRetentionDays: number },
  pages: [] as { id: string }[][],
  findManyArgs: [] as { where: unknown; take: number }[],
  stillDue: new Set<string>(),
  purgedServices: [] as string[],
  docs: {} as Record<string, string[]>,
  access: [] as { documentId: string; action: string }[],
  chatFiles: [] as { id: string; token: string; createdAt: Date }[],
  raw: [] as { sql: string; values: unknown[] }[],
  deletedFiles: [] as string[],
}));

vi.mock("@/lib/db", () => {
  const client = {
    appSettings: { findUnique: async () => db.settings },
    leadService: {
      findMany: async (args: { where: unknown; take: number }) => {
        db.findManyArgs.push(args);
        return db.pages.shift() ?? [];
      },
      count: async ({ where }: { where: { AND: [{ id: string }, unknown] } }) => (db.stillDue.has(where.AND[0].id) ? 1 : 0),
      update: async ({ where }: { where: { id: string } }) => void db.purgedServices.push(where.id),
    },
    leadDocument: {
      findMany: async ({ where }: { where: { serviceId: string } }) => (db.docs[where.serviceId] ?? []).map((id) => ({ id, serviceId: where.serviceId, fileName: `${id}.pdf` })),
      updateMany: async ({ where }: { where: { id: { in: string[] } } }) => ({ count: where.id.in.length }),
    },
    documentAccess: { createMany: async ({ data }: { data: { documentId: string; action: string }[] }) => void db.access.push(...data) },
    chatFile: {
      findMany: async ({ where, take }: { where: { createdAt: { lt: Date } }; take: number }) =>
        db.chatFiles.filter((f) => f.createdAt < where.createdAt.lt).slice(0, take).map(({ id, token }) => ({ id, token })),
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        db.chatFiles = db.chatFiles.filter((f) => !where.id.in.includes(f.id));
        db.deletedFiles.push(...where.id.in);
        return { count: where.id.in.length };
      },
    },
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      db.raw.push({ sql: strings.join("$"), values });
      return Promise.resolve(1);
    },
    $transaction: async (arg: unknown) => (typeof arg === "function" ? (arg as (tx: unknown) => unknown)(client) : Promise.all(arg as Promise<unknown>[])),
  };
  return { prisma: client };
});

const { purgeExpiredDocuments, retentionWhere } = await import("@/lib/doc-files");
const { toMessageView } = await import("@/lib/chats/view");

const now = new Date("2026-11-28T00:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
const idle = (d: Date) => ({ updatedAt: { lt: d }, documents: { none: { createdAt: { gte: d } } }, events: { none: { createdAt: { gte: d } } } });
const TRIP = ["FLIGHTS", "TOUR", "INSURANCE", "OTHER"];

beforeEach(() => {
  db.settings = { docRetentionDays: 90, tripDocRetentionDays: 30, idleDocRetentionDays: 90 };
  db.pages = [];
  db.findManyArgs = [];
  db.stillDue = new Set();
  db.purgedServices = [];
  db.docs = {};
  db.access = [];
  db.chatFiles = [];
  db.raw = [];
  db.deletedFiles = [];
});

describe("какие заявки пора очистить", () => {
  it("визы по итогу, брошенные визы, услуги без дат и услуги после поездки; уже очищенные — только с новыми документами", () => {
    expect(retentionWhere({ docRetentionDays: 90, tripDocRetentionDays: 30, idleDocRetentionDays: 60 }, now)).toEqual({
      AND: [
        {
          OR: [
            { type: "VISA", OR: [{ status: { in: ["APPROVED", "REJECTED"] }, statusAt: { lt: ago(90) } }, { cancelledAt: { lt: ago(90) } }] },
            { type: "VISA", status: { notIn: ["APPROVED", "REJECTED"] }, cancelledAt: null, ...idle(ago(60)) },
            { type: { in: TRIP }, lead: { travelFrom: null, travelTo: null }, ...idle(ago(60)) },
            { type: { in: TRIP }, lead: { OR: [{ travelTo: { lt: ago(30) } }, { travelTo: null, travelFrom: { lt: ago(30) } }] }, ...idle(ago(30)) },
          ],
        },
        { OR: [{ purgedAt: null }, { documents: { some: { purgedAt: null } } }] },
      ],
    });
  });

  it("0 дней выключает своё правило; все нули — ничего не удаляется", () => {
    const only = (s: Parameters<typeof retentionWhere>[0]) => (retentionWhere(s, now) as { AND: [{ OR: unknown[] }] }).AND[0].OR;
    expect(only({ docRetentionDays: 90, tripDocRetentionDays: 0, idleDocRetentionDays: 0 })).toHaveLength(1);
    expect(only({ docRetentionDays: 0, tripDocRetentionDays: 30, idleDocRetentionDays: 0 })).toEqual([
      { type: { in: TRIP }, lead: { OR: [{ travelTo: { lt: ago(30) } }, { travelTo: null, travelFrom: { lt: ago(30) } }] }, ...idle(ago(30)) },
    ]);
    expect(only({ docRetentionDays: 0, tripDocRetentionDays: 0, idleDocRetentionDays: 90 })).toHaveLength(2);
    expect(retentionWhere({ docRetentionDays: 0, tripDocRetentionDays: 0, idleDocRetentionDays: 0 }, now)).toBeNull();
  });
});

describe("ночная очистка", () => {
  it("обходит заявки пачками по id, перед удалением проверяет заявку ещё раз и пишет удаление в журнал", async () => {
    db.pages = [[{ id: "s1" }, { id: "s2" }], [{ id: "s3" }], []];
    db.stillDue = new Set(["s1", "s3"]); // в s2 за это время загрузили документ — остаётся
    db.docs = { s1: ["d1", "d2"], s2: ["d9"], s3: ["d3"] };
    const r = await purgeExpiredDocuments(now);
    expect(r).toEqual({ services: 2, documents: 3, chatFiles: 0 });
    expect(db.purgedServices).toEqual(["s1", "s3"]);
    expect(db.access.map((a) => [a.documentId, a.action])).toEqual([
      ["d1", "purge"],
      ["d2", "purge"],
      ["d3", "purge"],
    ]);
    const where = retentionWhere(db.settings!, now);
    expect(db.findManyArgs.map((a) => a.where)).toEqual([where, { AND: [where, { id: { gt: "s2" } }] }, { AND: [where, { id: { gt: "s3" } }] }]);
  });

  it("все сроки выключены — база не перебирается", async () => {
    db.settings = { docRetentionDays: 0, tripDocRetentionDays: 0, idleDocRetentionDays: 0 };
    db.chatFiles = [{ id: "f1", token: "old-token-0123456789", createdAt: ago(400) }];
    expect(await purgeExpiredDocuments(now)).toEqual({ services: 0, documents: 0, chatFiles: 0 });
    expect(db.findManyArgs).toEqual([]);
    expect(db.deletedFiles).toEqual([]);
  });

  it("файлы из переписки старше срока удаляются, а у сообщений в той же транзакции убирается ссылка", async () => {
    db.chatFiles = [
      { id: "f1", token: "tok-one-0123456789", createdAt: ago(120) },
      { id: "f2", token: "tok-two-0123456789", createdAt: ago(91) },
      { id: "f3", token: "tok-new-0123456789", createdAt: ago(89) },
    ];
    const r = await purgeExpiredDocuments(now);
    expect(r.chatFiles).toBe(2);
    expect(db.deletedFiles).toEqual(["f1", "f2"]);
    expect(db.chatFiles.map((f) => f.id)).toEqual(["f3"]);
    expect(db.raw).toHaveLength(1);
    expect(db.raw[0].sql).toContain(`UPDATE "ChatMessage"`);
    expect(db.raw[0].values).toEqual([["/api/chats/out/tok-one-0123456789", "/api/chats/out/tok-two-0123456789"]]);
  });
});

describe("переписка", () => {
  it("удалённый по сроку файл показывается как удалённый, остальные вложения — как раньше", () => {
    const m = {
      id: "m1",
      conversationId: "c1",
      direction: "OUT" as const,
      text: null,
      attachments: [{ type: "file", name: "Ваучер.pdf", purged: true }, { type: "image", url: "/api/chats/out/abc" }, { type: "image", fileId: "tg1" }],
      externalId: null,
      senderId: null,
      error: null,
      isAi: false,
      createdAt: now,
    };
    expect(toMessageView(m).attachments).toEqual([
      { type: "file", name: "Ваучер.pdf", src: null, purged: true },
      { type: "image", name: null, src: "/api/chats/out/abc" },
      { type: "image", name: null, src: "/api/chats/file?m=m1&i=2" },
    ]);
  });
});
