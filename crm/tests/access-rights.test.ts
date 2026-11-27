import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/** Права доступа к документам клиентов (аудит 27.11, п. 28): кто какие паспорта видит, что пишется в журнал */

type Role = "ADMIN" | "MANAGER" | "VISA";
type Doc = { id: string; fileName: string; mime: string; data: Buffer; encrypted: boolean; purgedAt: Date | null; serviceId: string };

const st = vi.hoisted(() => ({
  user: null as null | { id: string; name: string; login: string; role: Role; totp?: boolean },
  doc: null as null | Doc,
  queries: [] as unknown[],
  logged: [] as { docs: { id: string }[]; action: string; userId: string; ip: string | null }[],
}));

vi.mock("@/lib/session", async () => {
  const policy = await import("@/lib/totp-policy");
  return { getCurrentUser: async () => st.user, docsNeedTotp: policy.docsNeedTotp };
});
vi.mock("@/lib/db", () => ({
  prisma: {
    leadDocument: {
      findFirst: async ({ where }: { where: unknown }) => {
        st.queries.push(where);
        return st.doc;
      },
    },
  },
}));
vi.mock("@/lib/doc-files", () => ({
  decryptBytes: (data: Buffer) => Buffer.from(data),
  logDocAccess: async (docs: { id: string }[], action: string, userId: string, ip: string | null) => void st.logged.push({ docs, action, userId, ip }),
}));

const { GET } = await import("@/app/api/docs/[id]/route");
const { documentScope, serviceScope, handedVisa } = await import("@/lib/visa");
const { leadScope } = await import("@/lib/access");

const as = (role: Role, totp = true, id = `${role.toLowerCase()}1`) => ({ id, name: id, login: id, role, totp });
const get = (query = "") =>
  GET(new NextRequest(`http://crm.test/api/docs/d1${query}`, { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" } }), { params: Promise.resolve({ id: "d1" }) });

beforeEach(() => {
  st.user = null;
  st.doc = { id: "d1", fileName: "Паспорт.pdf", mime: "application/pdf", data: Buffer.from("%PDF"), encrypted: true, purgedAt: null, serviceId: "s1" };
  st.queries = [];
  st.logged = [];
});

describe("кто какие заявки и документы видит", () => {
  it("администратор — всё, визовый специалист — только переданные ему визы, лидов он не видит", () => {
    expect(documentScope(as("ADMIN"))).toEqual({});
    expect(serviceScope(as("ADMIN"))).toEqual({});
    expect(handedVisa).toEqual({ type: "VISA", handedAt: { not: null } });
    expect(documentScope(as("VISA"))).toEqual({ service: handedVisa });
    expect(serviceScope(as("VISA"))).toEqual(handedVisa);
    expect(leadScope(as("VISA"))).toEqual({ id: { in: [] } });
  });

  it("менеджер — документы только своих лидов, даже нераспределённый лид не открывает чужие паспорта", () => {
    const m = as("MANAGER", true, "m1");
    expect(documentScope(m)).toEqual({ lead: { managerId: "m1" } });
    // сами нераспределённые лиды менеджер видит (кроме скрытых администратором), а их документы — нет
    expect(leadScope(m)).toEqual({ OR: [{ managerId: "m1" }, { managerId: null, hiddenFromManagers: false }] });
    expect(serviceScope(m)).toEqual({ lead: leadScope(m) });
  });
});

describe("выдача документа /api/docs/[id]", () => {
  it("без входа — 401, база не запрашивается", async () => {
    expect((await get()).status).toBe(401);
    expect(st.queries).toEqual([]);
  });

  it.each(["MANAGER", "ADMIN", "VISA"] as const)("%s без входа с кодом — переход в «Мой профиль», документ не ищется", async (role) => {
    st.user = as(role, false);
    const res = await get();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/account?need=docs");
    expect(st.queries).toEqual([]);
    expect(st.logged).toEqual([]);
  });

  it("поиск документа всегда ограничен правами пользователя", async () => {
    for (const role of ["ADMIN", "VISA", "MANAGER"] as const) {
      st.user = as(role);
      await get();
    }
    expect(st.queries).toEqual([{ id: "d1" }, { id: "d1", service: handedVisa }, { id: "d1", lead: { managerId: "manager1" } }]);
  });

  it("чужой документ — 404 без записи в журнал", async () => {
    st.user = as("MANAGER");
    st.doc = null;
    expect((await get()).status).toBe(404);
    expect(st.logged).toEqual([]);
  });

  it("удалённый по сроку хранения — 410 без записи в журнал", async () => {
    st.user = as("ADMIN");
    st.doc!.purgedAt = new Date("2026-11-01T00:00:00Z");
    expect((await get()).status).toBe(410);
    expect(st.logged).toEqual([]);
  });

  it("просмотр: файл не кэшируется, открывается в песочнице, просмотр записан с адресом клиента", async () => {
    st.user = as("VISA");
    const res = await get();
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("%PDF");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toBe(`inline; filename*=UTF-8''${encodeURIComponent("Паспорт.pdf")}`);
    expect(st.logged).toEqual([{ docs: [st.doc], action: "view", userId: "visa1", ip: "203.0.113.7" }]);
  });

  it("скачивание и файлы, которые браузер не показывает, отдаются вложением", async () => {
    st.user = as("ADMIN");
    expect((await get("?download=1")).headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(st.logged.at(-1)).toMatchObject({ action: "download", userId: "admin1" });
    st.doc!.mime = "text/html";
    expect((await get()).headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(st.logged.at(-1)).toMatchObject({ action: "view" });
  });
});
