import { beforeEach, describe, expect, it } from "vitest";
import { loginBlocked, loginFailed, loginSucceeded, resetLoginGuard } from "@/lib/login-guard";

describe("защита входа от подбора пароля", () => {
  beforeEach(() => resetLoginGuard());

  it("после 5 ошибок пара «логин + IP» закрыта на 15 минут, другой IP — нет", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) loginFailed("Admin", "1.1.1.1", t0);
    expect(loginBlocked("admin", "1.1.1.1", t0 + 1000)).toBe(true);
    expect(loginBlocked("admin", "2.2.2.2", t0 + 1000)).toBe(false);
    expect(loginBlocked("admin", "1.1.1.1", t0 + 16 * 60_000)).toBe(false);
  });

  it("успешный вход сбрасывает счётчик", () => {
    for (let i = 0; i < 4; i++) loginFailed("manager", "3.3.3.3");
    loginSucceeded("manager", "3.3.3.3");
    loginFailed("manager", "3.3.3.3");
    expect(loginBlocked("manager", "3.3.3.3")).toBe(false);
  });

  it("перебор логинов с одного IP: после 30 ошибок закрыт весь IP", () => {
    const t0 = 2_000_000;
    for (let i = 0; i < 30; i++) loginFailed(`user${i}`, "4.4.4.4", t0);
    expect(loginBlocked("someone", "4.4.4.4", t0 + 1000)).toBe(true);
    expect(loginBlocked("someone", "5.5.5.5", t0 + 1000)).toBe(false);
    expect(loginBlocked("someone", "4.4.4.4", t0 + 16 * 60_000)).toBe(false);
  });

  it("подбор пароля с разных IP: логин закрыт для новых IP, а знакомый IP входит", () => {
    const t0 = 3_000_000;
    loginSucceeded("admin", "10.0.0.1");
    for (let i = 0; i < 20; i++) loginFailed("admin", `6.6.6.${i}`, t0);
    expect(loginBlocked("admin", "7.7.7.7", t0 + 1000)).toBe(true);
    expect(loginBlocked("admin", "10.0.0.1", t0 + 1000)).toBe(false);
    expect(loginBlocked("manager", "7.7.7.7", t0 + 1000)).toBe(false);
    expect(loginBlocked("admin", "7.7.7.7", t0 + 16 * 60_000)).toBe(false);
  });
});
