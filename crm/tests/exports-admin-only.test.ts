import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Выгрузка в Excel лидов и списка клиентов с телефонами — только администратору (аудит 27.11, п. 21; решение владельца
 * 28.11.2026: уходящий менеджер не унесёт базу клиентов). Остальные отчёты менеджер выгружает как раньше.
 */

type Role = "ADMIN" | "MANAGER" | "VISA";

const st = vi.hoisted(() => ({
  user: null as null | { id: string; name: string; login: string; role: Role },
  leadQueries: 0,
  clientTables: 0,
  funnelTables: 0,
}));

vi.mock("@/lib/session", () => ({ getCurrentUser: async () => st.user }));
vi.mock("@/lib/db", () => ({
  prisma: {
    lead: {
      findMany: async () => {
        st.leadQueries++;
        return [];
      },
    },
  },
}));
vi.mock("@/lib/reports/excel", () => ({ buildWorkbook: async () => Buffer.from("xlsx") }));
vi.mock("@/lib/reports/data", () => ({
  readFilters: async () => {
    const { i18nFor } = await import("@/i18n/instance");
    const period = { from: new Date("2026-11-01T00:00:00Z"), to: new Date("2026-11-28T00:00:00Z") };
    return { t: i18nFor("ru").t, locale: "ru", period, currency: "USD", managerId: null, rate: 12800, costRate: 12800 };
  },
}));
vi.mock("@/lib/reports/visas", () => ({ visasTable: async () => ({ table: { title: "", columns: [], rows: [] } }) }));
vi.mock("@/lib/reports/tables", async (orig) => ({
  ...(await orig<typeof import("@/lib/reports/tables")>()),
  clientsTable: async () => {
    st.clientTables++;
    return { title: "Клиенты", columns: [], rows: [] };
  },
  funnelTable: async () => {
    st.funnelTables++;
    return { table: { title: "Воронка", columns: [], rows: [] } };
  },
}));

const leadsExport = (await import("@/app/api/leads/export/route")).GET;
const reportsExport = (await import("@/app/api/reports/export/route")).GET;

const as = (role: Role) => ({ id: `${role.toLowerCase()}1`, name: role, login: role.toLowerCase(), role });
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

beforeEach(() => {
  st.user = null;
  st.leadQueries = 0;
  st.clientTables = 0;
  st.funnelTables = 0;
});

describe("выгрузка лидов", () => {
  it("без входа — 401, менеджер и визовый специалист — 403, база не запрашивается", async () => {
    const get = () => leadsExport(new NextRequest("http://crm.test/api/leads/export?status=new"));
    expect((await get()).status).toBe(401);
    st.user = as("MANAGER");
    expect((await get()).status).toBe(403);
    st.user = as("VISA");
    expect((await get()).status).toBe(403);
    expect(st.leadQueries).toBe(0);
  });

  it("администратор получает файл Excel", async () => {
    st.user = as("ADMIN");
    const res = await leadsExport(new NextRequest("http://crm.test/api/leads/export"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(XLSX);
    expect(st.leadQueries).toBe(1);
  });
});

describe("выгрузка отчётов", () => {
  const get = (tab: string) => reportsExport(new NextRequest(`http://crm.test/api/reports/export?tab=${tab}`));

  it("список клиентов с телефонами менеджеру не выгружается", async () => {
    st.user = as("MANAGER");
    expect((await get("clients")).status).toBe(403);
    expect(st.clientTables).toBe(0);
  });

  it("администратор выгружает клиентов, менеджер — другие отчёты, как раньше", async () => {
    st.user = as("ADMIN");
    expect((await get("clients")).status).toBe(200);
    expect(st.clientTables).toBe(1);
    st.user = as("MANAGER");
    const res = await get("funnel");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(XLSX);
    expect(st.funnelTables).toBe(1);
  });
});
