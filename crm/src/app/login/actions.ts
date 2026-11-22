"use server";

import { AuthError, CredentialsSignin } from "next-auth";
import { signIn } from "@/auth";
import { getI18n } from "@/i18n/server";
import { prisma } from "@/lib/db";

/** needCode — пароль верный, у пользователя двухфакторный вход: форма показывает поле для кода */
export type LoginState = { error: string | null; login: string; needCode?: boolean };

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const login = String(formData.get("login") ?? "");
  const code = String(formData.get("code") ?? "").trim();
  try {
    // визовый специалист сразу попадает в свой кабинет, а без двухфакторного входа — сначала включает его
    const u = await prisma.user.findUnique({ where: { login: login.trim().toLowerCase() }, select: { role: true, totpEnabledAt: true } });
    const redirectTo = u?.role === "VISA" ? (u.totpEnabledAt ? "/visa" : "/account") : "/";
    await signIn("credentials", { login, password: String(formData.get("password") ?? ""), ...(code ? { code } : {}), redirectTo });
    return { error: null, login };
  } catch (e) {
    if (e instanceof AuthError) {
      const { t } = await getI18n();
      const kind = e instanceof CredentialsSignin ? e.code : null;
      if (kind === "totp_required") return { error: null, login, needCode: true };
      if (kind === "totp_invalid") return { error: t("auth.codeInvalid"), login, needCode: true };
      return { error: t("auth.invalid"), login };
    }
    throw e; // редирект после успешного входа
  }
}
