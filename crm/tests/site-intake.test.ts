import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Приём заявок с сайта POST /api/public/visa-application (аудит 27.11, п. 28): ключ, повторы с тем же externalId,
 * одновременные повторы, обязательные поля, отмена. База, создание лида и уведомления — поддельные.
 */

const KEY = "site-key-0123456789abcdef0123456789";

const st = vi.hoisted(() => ({
  keyHash: null as string | null,
  services: [] as { id: string; externalId: string | null; assigneeId: string | null; lead: { name: string } }[],
  leads: [] as Record<string, unknown>[],
  created: [] as Record<string, unknown>[],
  events: [] as Record<string, unknown>[],
  notified: [] as { userId: string; type: string }[],
  after: [] as (() => unknown)[],
  cancels: [] as [string, string][],
  failCreate: null as null | { code: string },
}));

vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => void st.after.push(fn) }));
vi.mock("@/lib/session", () => ({ AccessError: class extends Error {} }));
vi.mock("@/lib/notify", () => ({ notify: async (items: { userId: string; type: string }[]) => void st.notified.push(...items) }));
vi.mock("@/lib/orient-visa", () => ({
  SITE_CANCEL_REASONS: ["refunded", "cancelled", "account_deleted"],
  cancelSiteApplication: async (externalId: string, reason: string) => {
    st.cancels.push([externalId, reason]);
    const s = st.services.find((x) => x.externalId === externalId);
    return s ? { id: s.id, applied: true } : null;
  },
  fetchSiteApplication: async () => undefined,
}));
vi.mock("@/lib/leads/service", () => ({
  createLead: async (input: Record<string, unknown> & { inTransaction: (tx: unknown, lead: { id: string }) => Promise<void> }) => {
    if (st.failCreate) {
      // параллельный запрос с тем же externalId успел создать заявку — наша транзакция откатывается
      st.services.push({ id: "svc-parallel", externalId: "app-race", assigneeId: null, lead: { name: "X" } });
      throw st.failCreate;
    }
    const lead = { id: `lead${st.leads.length + 1}` };
    st.leads.push(input);
    const tx = {
      leadService: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          st.created.push(data);
          return { id: `svc${st.created.length}`, externalNumber: (data.externalNumber as string | null) ?? null };
        },
      },
      visaEvent: { create: async ({ data }: { data: Record<string, unknown> }) => void st.events.push(data) },
    };
    await input.inTransaction(tx, lead);
    return lead;
  },
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: { findUnique: async () => ({ siteApiKeyHash: st.keyHash }) },
    leadService: { findUnique: async ({ where }: { where: { externalId: string } }) => st.services.find((s) => s.externalId === where.externalId) ?? null },
    user: { findMany: async () => [{ id: "visa1" }, { id: "visa2" }] },
  },
}));

const { POST } = await import("@/app/api/public/visa-application/route");

const post = (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${KEY}` }) =>
  POST(new NextRequest("http://crm.test/api/public/visa-application", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }));
const app = { name: "Ali Valiyev", phone: "90 123 45 67", country: "Таиланд", externalId: "app1", externalNumber: "OV-1001", travelers: 2, paidAmount: 450000 };

beforeEach(() => {
  st.keyHash = crypto.createHash("sha256").update(KEY).digest("hex");
  st.services = [];
  st.leads = [];
  st.created = [];
  st.events = [];
  st.notified = [];
  st.after = [];
  st.cancels = [];
  st.failCreate = null;
});

describe("ключ сайта", () => {
  it("без ключа, с чужим ключом и когда ключ в CRM не задан — 401, заявка не создаётся", async () => {
    expect((await post(app, {})).status).toBe(401);
    expect((await post(app, { authorization: "Bearer wrong-key" })).status).toBe(401);
    st.keyHash = null;
    expect((await post(app)).status).toBe(401);
    expect(st.leads).toEqual([]);
  });

  it("ключ принимается и в заголовке X-Api-Key; неверный JSON — 400", async () => {
    expect((await post("{not json", { "x-api-key": KEY })).status).toBe(400);
  });
});

describe("новая заявка", () => {
  it("создаются лид «Сайт» и визовая заявка, сразу переданная визовикам; анкета догружается с сайта", async () => {
    const res = await post(app);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, id: "svc1" });
    expect(st.leads[0]).toMatchObject({ source: "WEBSITE", name: "Ali Valiyev", phone: "+998901234567", serviceType: "VISA", destination: "Таиланд", travelers: 2 });
    expect(st.created[0]).toMatchObject({ type: "VISA", source: "WEBSITE", externalId: "app1", externalNumber: "OV-1001", siteFetchNeeded: true, paidAmount: 450000 });
    expect(st.created[0].handedAt).toBeInstanceOf(Date);
    expect(st.events).toEqual([{ serviceId: "svc1", status: "NEW", comment: "Заявка с сайта Orient Visa OV-1001, оплачена" }]);
    expect(st.notified.map((n) => [n.userId, n.type])).toEqual([
      ["visa1", "visaNew"],
      ["visa2", "visaNew"],
    ]);
    expect(st.after).toHaveLength(1);
  });

  it("без имени, телефона и страны — 422 со списком полей", async () => {
    const res = await post({ externalId: "app2", phone: "abc" });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("Required: name, phone, country");
    expect(st.leads).toEqual([]);
  });
});

describe("повторы", () => {
  it("повтор с тем же externalId — 200 с тем же id, второй лид не создаётся", async () => {
    st.services.push({ id: "svc-existing", externalId: "app1", assigneeId: "visa2", lead: { name: "Ali" } });
    const res = await post(app);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: "svc-existing" });
    expect(st.leads).toEqual([]);
    expect(st.notified).toEqual([]);
  });

  it("одновременный повтор: транзакция откатилась на уникальном externalId — возвращается заявка параллельного запроса", async () => {
    st.failCreate = { code: "P2002" };
    const res = await post({ ...app, externalId: "app-race" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: "svc-parallel" });
  });
});

describe("отмена на сайте", () => {
  it("без причины — 422, неизвестная заявка — 404, известная — 200", async () => {
    expect((await post({ event: "cancelled", externalId: "app1", reason: "whatever" })).status).toBe(422);
    expect((await post({ event: "cancelled", externalId: "nope", reason: "refunded" })).status).toBe(404);
    st.services.push({ id: "svc-existing", externalId: "app1", assigneeId: null, lead: { name: "Ali" } });
    const res = await post({ event: "cancelled", externalId: "app1", reason: "account_deleted" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: "svc-existing", result: "applied" });
    expect(st.cancels).toEqual([
      ["nope", "refunded"],
      ["app1", "account_deleted"],
    ]);
    expect(st.leads).toEqual([]);
  });
});
