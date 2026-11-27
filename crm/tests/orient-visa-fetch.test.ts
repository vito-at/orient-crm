import { beforeEach, describe, expect, it, vi } from "vitest";

/** Загрузка анкеты и файлов с сайта Orient Visa (fetchSiteApplication) — с поддельной базой и поддельным fetch */

process.env.ENCRYPTION_KEY = "a".repeat(64);
process.env.SITE_URL = "https://orientvisa.uz";
process.env.SITE_INTEGRATION_KEY = "site-key";
process.env.CRM_WEBHOOK_SECRET = "secret";

type Doc = { id: string; serviceId: string; externalId: string | null; fileName: string; sha256: string | null; siteAckAt: Date | null; purgedAt: Date | null };

const db = vi.hoisted(() => ({
  docs: [] as Doc[],
  serviceUpdates: [] as Record<string, unknown>[],
  events: [] as Record<string, unknown>[],
  access: [] as Record<string, unknown>[],
  /** имитация параллельной загрузки: этот externalId «уже сохранил» другой процесс */
  raceExternalId: null as string | null,
}));

vi.mock("@/lib/db", () => {
  const leadDocument = {
    findMany: async ({ where }: { where: { serviceId: string; siteAckAt?: null } }) =>
      db.docs.filter((d) => d.serviceId === where.serviceId && d.externalId && (where.siteAckAt === undefined || (!d.siteAckAt && d.sha256 && !d.purgedAt))),
    create: async ({ data }: { data: Doc & Record<string, unknown> }) => {
      if (db.raceExternalId === data.externalId || db.docs.some((d) => d.serviceId === data.serviceId && d.externalId === data.externalId)) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      const doc: Doc = { id: `doc${db.docs.length + 1}`, serviceId: data.serviceId, externalId: data.externalId, fileName: data.fileName, sha256: data.sha256, siteAckAt: null, purgedAt: null };
      db.docs.push(doc);
      return { id: doc.id, serviceId: doc.serviceId, fileName: doc.fileName };
    },
    updateMany: async ({ where, data }: { where: { id: { in: string[] } }; data: { siteAckAt: Date } }) => {
      const list = db.docs.filter((d) => where.id.in.includes(d.id) && !d.siteAckAt);
      list.forEach((d) => (d.siteAckAt = data.siteAckAt));
      return { count: list.length };
    },
  };
  const leadService = {
    findUnique: async () => ({ id: "s1", leadId: "l1", externalId: "app1" }),
    update: async ({ data }: { data: Record<string, unknown> }) => {
      db.serviceUpdates.push(data);
      return {};
    },
  };
  const client = {
    appSettings: { findUnique: async () => null },
    leadService,
    leadDocument,
    documentAccess: { createMany: async ({ data }: { data: Record<string, unknown>[] }) => void db.access.push(...data) },
    siteEvent: { create: async ({ data }: { data: Record<string, unknown> }) => void db.events.push(data) },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(client),
  };
  return { prisma: client };
});

const { fetchSiteApplication, isSiteFileUrl } = await import("@/lib/orient-visa");

const SITE = "https://orientvisa.uz";
const fileLink = (id: string) => `${SITE}/api/integration/files/${id}?exp=1764300000&sig=${"0".repeat(64)}`;

function application(docs: { id: string; title: string; url: string | null; transferred?: boolean; mime?: string }[]) {
  return {
    id: "app1",
    number: "OV-000123",
    status: "PAID",
    visaType: "Туристическая",
    nationality: "uz",
    travelers: [{ id: "t1", position: 1, name: "ALI VALIEV", fields: [{ key: "passport_number", label: "Номер паспорта", value: "FA1234567" }], documents: docs }],
  };
}

/** fetch сайта: анкета по Bearer-ключу, файлы — по адресам из files */
function siteFetch(app: unknown, files: Record<string, { status?: number; body?: string; type?: string }>) {
  const calls: { url: string; auth: string | null }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
    if (url === `${SITE}/api/integration/applications/app1`) return Response.json(app);
    const f = files[url];
    if (!f) return new Response("not found", { status: 404 });
    return new Response(f.body ?? "", { status: f.status ?? 200, headers: { "content-type": f.type ?? "application/pdf" } });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

beforeEach(() => {
  db.docs = [];
  db.serviceUpdates = [];
  db.events = [];
  db.access = [];
  db.raceExternalId = null;
});

describe("ссылка на файл сайта", () => {
  it("принимается только с адреса сайта или его хранилища files.<домен>", () => {
    expect(isSiteFileUrl(fileLink("f1"), SITE)).toBe(true);
    expect(isSiteFileUrl("https://files.orientvisa.uz/orient-visa/a.jpg?X-Amz-Signature=1", SITE)).toBe(true);
    expect(isSiteFileUrl("https://files.orientvisa.uz/a.jpg", "https://www.orientvisa.uz")).toBe(true);
    expect(isSiteFileUrl("https://evil.example/api/integration/files/f1", SITE)).toBe(false);
    expect(isSiteFileUrl("https://orientvisa.uz.evil.example/x", SITE)).toBe(false);
    expect(isSiteFileUrl("http://orientvisa.uz/api/integration/files/f1", SITE)).toBe(false);
    expect(isSiteFileUrl("https://user:pw@orientvisa.uz/x", SITE)).toBe(false);
    expect(isSiteFileUrl("https://localhost:9000/x", SITE)).toBe(false);
    expect(isSiteFileUrl("не ссылка", SITE)).toBe(false);
  });
});

describe("загрузка анкеты и документов с сайта", () => {
  it("скачивает файлы по новым ссылкам сайта, сохраняет анкету и подтверждает получение", async () => {
    const { fn, calls } = siteFetch(application([{ id: "f1", title: "Паспорт", url: fileLink("f1"), mime: "application/pdf" }]), {
      [fileLink("f1")]: { body: "%PDF-1.4 passport" },
    });
    const r = await fetchSiteApplication("s1", fn);
    expect(r).toEqual({ ok: true, added: 1, error: undefined });
    expect(calls[0]).toEqual({ url: `${SITE}/api/integration/applications/app1`, auth: "Bearer site-key" });
    expect(calls[1].url).toBe(fileLink("f1"));
    expect(calls[1].auth).toBeNull(); // подпись уже в адресе, ключ сайта по ссылке не уходит
    expect(db.docs).toHaveLength(1);
    expect(db.docs[0]).toMatchObject({ externalId: "f1", fileName: "Паспорт — ALI VALIEV.pdf" });
    expect(db.access).toEqual([expect.objectContaining({ documentId: "doc1", action: "upload" })]);
    const upd = db.serviceUpdates.at(-1)!;
    expect(upd).toMatchObject({ siteFetchNeeded: false, siteFetchError: null, siteFetchTries: 0, nationality: "UZ", externalNumber: "OV-000123" });
    expect(String(upd.siteDataEnc)).toMatch(/^v1:/);
    expect(db.events).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ type: "documents_received", documents: [{ id: "f1", sha256: db.docs[0].sha256 }] }) }),
    ]);
  });

  it("ссылку не с адреса сайта не скачивает и считает ошибкой", async () => {
    const evil = "https://evil.example/api/integration/files/f1";
    const { fn, calls } = siteFetch(application([{ id: "f1", title: "Паспорт", url: evil }]), { [evil]: { body: "x" } });
    const r = await fetchSiteApplication("s1", fn);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Паспорт: ссылка не с адреса сайта");
    expect(calls.map((c) => c.url)).not.toContain(evil);
    expect(db.docs).toHaveLength(0);
    expect(db.serviceUpdates.at(-1)).toMatchObject({ siteFetchNeeded: true });
  });

  it("просроченная ссылка (403) — ошибка с повтором, остальные файлы сохраняются", async () => {
    const { fn } = siteFetch(
      application([
        { id: "f1", title: "Паспорт", url: fileLink("f1") },
        { id: "f2", title: "Фотография", url: fileLink("f2"), mime: "image/jpeg" },
      ]),
      { [fileLink("f1")]: { status: 403 }, [fileLink("f2")]: { body: "jpeg", type: "image/jpeg" } },
    );
    const r = await fetchSiteApplication("s1", fn);
    expect(r).toMatchObject({ ok: false, added: 1, error: "Паспорт: HTTP 403" });
    expect(db.docs.map((d) => d.externalId)).toEqual(["f2"]);
    expect(db.serviceUpdates.at(-1)).toMatchObject({ siteFetchNeeded: true, siteFetchTries: { increment: 1 } });
  });

  it("уже скачанный документ не скачивает второй раз", async () => {
    db.docs.push({ id: "old", serviceId: "s1", externalId: "f1", fileName: "Паспорт.pdf", sha256: "x", siteAckAt: new Date(), purgedAt: null });
    const { fn, calls } = siteFetch(application([{ id: "f1", title: "Паспорт", url: fileLink("f1") }]), { [fileLink("f1")]: { body: "pdf" } });
    const r = await fetchSiteApplication("s1", fn);
    expect(r).toMatchObject({ ok: true, added: 0 });
    expect(calls).toHaveLength(1);
    expect(db.docs).toHaveLength(1);
  });

  it("если тот же документ параллельно сохранил другой процесс — без дубля и без ошибки", async () => {
    db.raceExternalId = "f1";
    const { fn } = siteFetch(application([{ id: "f1", title: "Паспорт", url: fileLink("f1") }]), { [fileLink("f1")]: { body: "pdf" } });
    const r = await fetchSiteApplication("s1", fn);
    expect(r).toMatchObject({ ok: true, added: 0 });
    expect(db.docs).toHaveLength(0);
    expect(db.access).toHaveLength(0);
  });

  it("файл уже передан и удалён с сайта, а в CRM его нет — сообщение без повторов", async () => {
    const { fn } = siteFetch(application([{ id: "f1", title: "Паспорт", url: null, transferred: true }]), {});
    const r = await fetchSiteApplication("s1", fn);
    expect(r.ok).toBe(true);
    expect(db.serviceUpdates.at(-1)).toMatchObject({ siteFetchNeeded: false, siteFetchError: "Файлы уже удалены с сайта, а в CRM их нет: Паспорт" });
  });

  it("сайт не отдал анкету — ошибка и счётчик попыток", async () => {
    const fn = vi.fn(async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const r = await fetchSiteApplication("s1", fn);
    expect(r).toEqual({ ok: false, added: 0, error: "HTTP 503" });
    expect(db.serviceUpdates.at(-1)).toEqual({ siteFetchError: "HTTP 503", siteFetchTries: { increment: 1 } });
  });
});
