"use server";

import QRCode from "qrcode";
import { signOut } from "@/auth";
import { prisma } from "@/lib/db";
import { runAction } from "@/lib/actions";
import { decrypt, encrypt } from "@/lib/crypto";
import { requireUser } from "@/lib/session";
import { ValidationError } from "@/lib/leads/service";
import { consumeTotpStep, newTotpSecret, otpauthUrl, verifyTotp } from "@/lib/totp";

/** Начать подключение двухфакторного входа: новый секрет (пока не включён) и QR-код для приложения */
export async function startTotpSetupAction() {
  return runAction(async () => {
    const user = await requireUser({ without2fa: true });
    const u = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { totpEnabledAt: true } });
    if (u.totpEnabledAt) throw new ValidationError("err.totpAlreadyOn");
    const secret = newTotpSecret();
    await prisma.user.update({ where: { id: user.id }, data: { totpSecretEnc: encrypt(secret), totpEnabledAt: null } });
    const qr = await QRCode.toString(otpauthUrl(secret, user.login), { type: "svg", margin: 1, width: 200 });
    return { secret, qr };
  });
}

/** Включить: код из приложения подтверждает, что QR отсканирован. После включения — выход, вход заново уже с кодом */
export async function confirmTotpAction(code: string) {
  const res = await runAction(async () => {
    const user = await requireUser({ without2fa: true });
    const u = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { totpSecretEnc: true, totpEnabledAt: true } });
    if (u.totpEnabledAt) throw new ValidationError("err.totpAlreadyOn");
    const secret = decrypt(u.totpSecretEnc);
    if (!secret) throw new ValidationError("err.totpNoSetup");
    const step = verifyTotp(secret, code);
    if (step === null || !consumeTotpStep(user.id, step)) throw new ValidationError("auth.codeInvalid");
    await prisma.user.update({ where: { id: user.id }, data: { totpEnabledAt: new Date() } });
  });
  if (!res.ok) return res;
  await signOut({ redirectTo: "/login" });
  return res;
}

/** Выключить (кроме визовых специалистов — у них обязателен): нужен текущий код */
export async function disableTotpAction(code: string) {
  return runAction(async () => {
    const user = await requireUser({ without2fa: true });
    if (user.role === "VISA") throw new ValidationError("err.totpRequired");
    const u = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { totpSecretEnc: true, totpEnabledAt: true } });
    const secret = decrypt(u.totpSecretEnc);
    if (!u.totpEnabledAt || !secret) return;
    const step = verifyTotp(secret, code);
    if (step === null || !consumeTotpStep(user.id, step)) throw new ValidationError("auth.codeInvalid");
    await prisma.user.update({ where: { id: user.id }, data: { totpSecretEnc: null, totpEnabledAt: null } });
  });
}
