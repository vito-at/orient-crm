import crypto from "node:crypto";

/**
 * Отпечаток пароля и двухфакторного входа сотрудника. Записывается во «вход» (JWT) и сверяется с базой при каждом
 * запросе: смена пароля, включение, выключение или сброс 2FA меняют отпечаток — все прежние входы перестают работать.
 * HMAC на AUTH_SECRET: по отпечатку ничего нельзя узнать о пароле.
 */
export function sessionStamp(u: { passwordHash: string; totpEnabledAt: Date | null }, secret = process.env.AUTH_SECRET ?? ""): string {
  return crypto
    .createHmac("sha256", `session-stamp:${secret}`)
    .update(`${u.passwordHash}|${u.totpEnabledAt?.getTime() ?? 0}`)
    .digest("hex")
    .slice(0, 32);
}
