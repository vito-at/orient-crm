import { beforeEach, describe, expect, it, vi } from "vitest";

/** Очередь событий CRM → сайт (processSiteEvents): порядок внутри заявки, «требует внимания», «Повторить» — с поддельной базой */

process.env.ENCRYPTION_KEY = "a".repeat(64);
process.env.SITE_URL = "https://orientvisa.uz";
process.env.SITE_INTEGRATION_KEY = "site-key";
process.env.CRM_WEBHOOK_SECRET = "secret";

type Ev = { id: string; serviceId: string; payload: Record<string, unknown>; attempts: number; nextAt: Date; sentAt: Date | null; lastError: string | null; stuckAt: Date | null; createdAt: Date };

const db = vi.hoisted(() => ({ events: [] as Ev[], notified: [] as { userId: string; type: string; key: string }[] }));

vi.mock("@/lib/notify", () => ({ notify: async (items: { userId: string; type: string; key: string }[]) => void db.notified.push(...items) }));
vi.mock("@/lib/db", () => {
  const client = {
    appSettings: { findUnique: async () => null },
    siteEvent: {
      findMany: async () => db.events.filter((e) => !e.sentAt).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const e = db.events.find((x) => x.id === where.id)!;
        for (const [k, v] of Object.entries(data)) {
          if (k === "attempts" && typeof v === "object") e.attempts += (v as { increment: number }).increment;
          else (e as Record<string, unknown>)[k] = v;
        }
        return e;
      },
      updateMany: async ({ where, data }: { where: { serviceId: string; sentAt: null }; data: Partial<Ev> }) => {
        const list = db.events.filter((e) => e.serviceId === where.serviceId && !e.sentAt);
        list.forEach((e) => Object.assign(e, data));
        return { count: list.length };
      },
    },
    leadDocument: { findUnique: async () => null },
    leadService: { findUnique: async () => ({ assigneeId: "visa1", lead: { name: "Ali" } }) },
    user: { findMany: async () => [{ id: "admin1" }] },
  };
  return { prisma: client };
});

const { processSiteEvents, retrySiteEvents, STUCK_AFTER } = await import("@/lib/orient-visa");

const t0 = new Date("2026-11-28T10:00:00Z");
function ev(id: string, serviceId: string, minute: number, extra: Partial<Ev> = {}): Ev {
  return { id, serviceId, payload: { externalId: serviceId, type: "status", status: "IN_PROGRESS" }, attempts: 0, nextAt: t0, sentAt: null, lastError: null, stuckAt: null, createdAt: new Date(t0.getTime() + minute * 60_000), ...extra };
}
/** сайт: заявка «bad» всегда отвечает 422, остальные — 200 */
const site = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as { externalId: string };
  return body.externalId === "bad" ? new Response("unprocessable", { status: 422 }) : new Response("{}", { status: 200 });
}) as unknown as typeof fetch;

beforeEach(() => {
  db.events = [];
  db.notified = [];
});

describe("очередь событий на сайт (аудит 4.4)", () => {
  it("отклонённое событие после 5 попыток «требует внимания», уведомляет и не мешает другим заявкам", async () => {
    db.events = [ev("e1", "bad", 0), ev("e2", "bad", 1), ev("e3", "good", 2)];
    let now = t0;
    for (let i = 0; i < STUCK_AFTER.rejected; i++) {
      await processSiteEvents(now, site);
      now = new Date(now.getTime() + 7 * 3_600_000); // дольше любой паузы
    }
    const [e1, e2, e3] = db.events;
    expect(e3.sentAt).not.toBeNull();
    expect(e1.attempts).toBe(STUCK_AFTER.rejected);
    expect(e1.stuckAt).not.toBeNull();
    // порядок внутри заявки: следующее событие ждёт, пока первое не уйдёт
    expect(e2.attempts).toBe(0);
    expect(db.notified.map((n) => n.userId).sort()).toEqual(["admin1", "visa1"]);
    expect(db.notified.every((n) => n.type === "visaStuck")).toBe(true);
    // застрявшее событие больше не отправляется само
    await processSiteEvents(new Date(now.getTime() + 7 * 3_600_000), site);
    expect(e1.attempts).toBe(STUCK_AFTER.rejected);
  });

  it("«Повторить»: события заявки снова в очереди, счётчик с нуля", async () => {
    db.events = [ev("e1", "s1", 0, { attempts: 15, stuckAt: t0, lastError: "HTTP 503" }), ev("e2", "s1", 1)];
    expect(await retrySiteEvents("s1", t0)).toBe(2);
    expect(db.events[0]).toMatchObject({ stuckAt: null, attempts: 0, nextAt: t0 });
    expect(await processSiteEvents(t0, site)).toBe(2);
  });
});
