import { beforeEach, describe, expect, it, vi } from "vitest";

/** Отмена заявки на сайте (cancelSiteApplication): возврат, отмена, удаление аккаунта — с поддельной базой */

process.env.ENCRYPTION_KEY = "a".repeat(64);

type Svc = {
  id: string;
  externalId: string;
  assigneeId: string | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  closed: boolean;
  siteFetchNeeded: boolean;
  siteDataEnc: string | null;
  purgedAt: Date | null;
};
type Doc = { id: string; serviceId: string; fileName: string; data: Buffer; purgedAt: Date | null };

const db = vi.hoisted(() => ({
  services: [] as Svc[],
  docs: [] as Doc[],
  events: [] as Record<string, unknown>[],
  access: [] as Record<string, unknown>[],
  notified: [] as { userId: string; type: string; key: string }[],
}));

vi.mock("@/lib/notify", () => ({ notify: async (items: { userId: string; type: string; key: string }[]) => void db.notified.push(...items) }));
vi.mock("@/lib/db", () => {
  const client = {
    leadService: {
      findUnique: async ({ where }: { where: { externalId: string } }) => {
        const s = db.services.find((x) => x.externalId === where.externalId);
        return s ? { ...s, lead: { name: "Ali" } } : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Svc> }) => Object.assign(db.services.find((x) => x.id === where.id)!, data),
    },
    leadDocument: {
      findMany: async ({ where }: { where: { serviceId: string; purgedAt: null } }) =>
        db.docs.filter((d) => d.serviceId === where.serviceId && !d.purgedAt).map(({ id, serviceId, fileName }) => ({ id, serviceId, fileName })),
      updateMany: async ({ where, data }: { where: { id: { in: string[] } }; data: Partial<Doc> }) => {
        const list = db.docs.filter((d) => where.id.in.includes(d.id));
        list.forEach((d) => Object.assign(d, data));
        return { count: list.length };
      },
    },
    visaEvent: { create: async ({ data }: { data: Record<string, unknown> }) => void db.events.push(data) },
    documentAccess: { createMany: async ({ data }: { data: Record<string, unknown>[] }) => void db.access.push(...data) },
    user: { findMany: async () => [{ id: "visa1" }, { id: "visa2" }] },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(client),
  };
  return { prisma: client };
});

const { cancelSiteApplication } = await import("@/lib/orient-visa");

const t0 = new Date("2026-11-28T10:00:00Z");
const t1 = new Date("2026-11-29T10:00:00Z");

beforeEach(() => {
  db.services = [
    { id: "s1", externalId: "app1", assigneeId: "visa1", cancelledAt: null, cancelReason: null, closed: false, siteFetchNeeded: true, siteDataEnc: "v1:anketa", purgedAt: null },
    { id: "s2", externalId: "app2", assigneeId: null, cancelledAt: null, cancelReason: null, closed: false, siteFetchNeeded: false, siteDataEnc: null, purgedAt: null },
  ];
  db.docs = [
    { id: "d1", serviceId: "s1", fileName: "Паспорт.pdf", data: Buffer.from("pdf"), purgedAt: null },
    { id: "d2", serviceId: "s1", fileName: "Фото.jpg", data: Buffer.from("jpg"), purgedAt: null },
  ];
  db.events = [];
  db.access = [];
  db.notified = [];
});

describe("отмена заявки на сайте (аудит, п. 15)", () => {
  it("возврат денег: заявка закрыта, загрузка с сайта остановлена, исполнитель уведомлён, документы остаются до срока хранения", async () => {
    expect(await cancelSiteApplication("app1", "refunded", t0)).toEqual({ id: "s1", applied: true });
    expect(db.services[0]).toMatchObject({ cancelledAt: t0, cancelReason: "refunded", closed: true, siteFetchNeeded: false, siteDataEnc: "v1:anketa" });
    expect(db.events).toEqual([{ serviceId: "s1", comment: "Заявка отменена на сайте: клиенту вернули деньги" }]);
    expect(db.notified).toEqual([expect.objectContaining({ userId: "visa1", type: "visaCancelled" })]);
    expect(db.docs.every((d) => !d.purgedAt)).toBe(true);
  });

  it("повтор того же события ничего не меняет", async () => {
    await cancelSiteApplication("app1", "refunded", t0);
    expect(await cancelSiteApplication("app1", "refunded", t1)).toEqual({ id: "s1", applied: false });
    expect(await cancelSiteApplication("app1", "cancelled", t1)).toEqual({ id: "s1", applied: false });
    expect(db.services[0].cancelledAt).toBe(t0);
    expect(db.events).toHaveLength(1);
    expect(db.notified).toHaveLength(1);
  });

  it("клиент удалил аккаунт: документы и анкета удаляются сразу, даже если заявку уже отменили", async () => {
    await cancelSiteApplication("app1", "refunded", t0);
    expect(await cancelSiteApplication("app1", "account_deleted", t1)).toEqual({ id: "s1", applied: true });
    expect(db.services[0]).toMatchObject({ cancelledAt: t0, cancelReason: "account_deleted", siteDataEnc: null, purgedAt: t1 });
    expect(db.docs.map((d) => [d.purgedAt, d.data.length])).toEqual([
      [t1, 0],
      [t1, 0],
    ]);
    expect(db.access).toEqual([expect.objectContaining({ documentId: "d1", action: "purge" }), expect.objectContaining({ documentId: "d2", action: "purge" })]);
    expect(db.events.at(-1)).toEqual({ serviceId: "s1", comment: "Клиент удалил аккаунт на сайте: документы и анкета удалены" });
    expect(await cancelSiteApplication("app1", "account_deleted", t1)).toEqual({ id: "s1", applied: false });
  });

  it("без исполнителя уведомляются все визовые специалисты; неизвестная заявка — null", async () => {
    await cancelSiteApplication("app2", "cancelled", t0);
    expect(db.notified.map((n) => n.userId)).toEqual(["visa1", "visa2"]);
    expect(await cancelSiteApplication("nope", "cancelled", t0)).toBeNull();
  });
});
