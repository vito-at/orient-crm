import { redirect } from "next/navigation";
import { cache } from "react";
import type { User } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "./db";
import { sessionStamp } from "./session-stamp";
import { docsNeedTotp, needsTotp, totpRequiredFor } from "./totp-policy";
import type { TKey } from "@/i18n/core";

export type CurrentUser = Pick<User, "id" | "name" | "login" | "role"> & {
  /** вход был с кодом двухфакторной защиты */
  totp?: boolean;
};

/** Текущий пользователь из БД (проверяем, что он не заблокирован). */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await auth();
  if (!session?.user?.id) return null;
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, name: true, login: true, role: true, isActive: true, passwordHash: true, totpEnabledAt: true },
  });
  if (!user || !user.isActive) return null;
  // роль сменили после входа (например, менеджер стал визовиком) — старый вход недействителен, нужно войти заново:
  // иначе до конца срока входа доступ по старой роли (или бесконечная переадресация при повышении визовика)
  if (session.user.role && session.user.role !== user.role) return null;
  // сменили пароль, включили, выключили или сбросили 2FA — все прежние входы недействительны (украденный вход не живёт дальше).
  // Входы, выданные до появления отпечатка, тоже: один раз войти заново
  if (session.user.stamp !== sessionStamp(user)) return null;
  return { id: user.id, name: user.name, login: user.login, role: user.role, totp: !!session.user.totp };
});

// правила двухфакторного входа — в lib/totp-policy.ts (без зависимостей от Next.js, проверяются тестами)
export { docsNeedTotp, needsTotp, totpRequiredFor };

/**
 * Текущий пользователь или переход на вход. Визового специалиста и администратора без двухфакторного входа отправляет
 * на «Мой профиль» (это дублирует middleware: переадресация после формы входа его обходит). without2fa — для общего макета
 * и самой страницы профиля.
 */
export async function requireUser(opts?: { without2fa?: boolean }): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!opts?.without2fa && needsTotp(user)) redirect("/account");
  return user;
}

export async function requireAdmin(): Promise<CurrentUser> {
  const user = await requireUser();
  if (user.role !== "ADMIN") redirect("/");
  return user;
}

export function isAdmin(user: Pick<User, "role">) {
  return user.role === "ADMIN";
}

/** Нет доступа; message — ключ перевода (err.*), переводится в runAction */
export class AccessError extends Error {
  constructor(message: TKey = "err.noAccess") {
    super(message);
  }
}
