import { describe, expect, it } from "vitest";
import { sessionStamp } from "@/lib/session-stamp";
import { docsNeedTotp, needsTotp, totpRequiredFor } from "@/lib/totp-policy";

describe("двухфакторный вход: кому обязателен", () => {
  it("визовому специалисту и администратору — обязателен, менеджеру — нет", () => {
    expect(totpRequiredFor("VISA")).toBe(true);
    expect(totpRequiredFor("ADMIN")).toBe(true);
    expect(totpRequiredFor("MANAGER")).toBe(false);
    expect(needsTotp({ role: "ADMIN", totp: false })).toBe(true);
    expect(needsTotp({ role: "ADMIN", totp: true })).toBe(false);
    expect(needsTotp({ role: "MANAGER", totp: false })).toBe(false);
  });
  it("документы клиентов открываются только после входа с кодом — любой роли", () => {
    expect(docsNeedTotp({ totp: false })).toBe(true);
    expect(docsNeedTotp({})).toBe(true);
    expect(docsNeedTotp({ totp: true })).toBe(false);
  });
});

describe("отпечаток входа", () => {
  const u = { passwordHash: "$2b$10$abc", totpEnabledAt: null };
  it("не меняется, пока не меняются пароль и 2FA", () => {
    expect(sessionStamp(u, "s")).toBe(sessionStamp({ ...u }, "s"));
    expect(sessionStamp(u, "s")).toMatch(/^[0-9a-f]{32}$/);
  });
  it("меняется при смене пароля, включении и сбросе 2FA", () => {
    const base = sessionStamp(u, "s");
    expect(sessionStamp({ ...u, passwordHash: "$2b$10$xyz" }, "s")).not.toBe(base);
    const on = sessionStamp({ ...u, totpEnabledAt: new Date("2026-11-27T10:00:00Z") }, "s");
    expect(on).not.toBe(base);
    // 2FA включили заново — отпечаток другой, чем при прошлом включении
    expect(sessionStamp({ ...u, totpEnabledAt: new Date("2026-11-28T10:00:00Z") }, "s")).not.toBe(on);
  });
  it("без секрета AUTH_SECRET отпечаток не подобрать: другой секрет — другой отпечаток", () => {
    expect(sessionStamp(u, "s1")).not.toBe(sessionStamp(u, "s2"));
  });
});
