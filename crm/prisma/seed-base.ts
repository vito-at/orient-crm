import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { PrismaClient } from "@prisma/client";
import { DEFAULT_LOSS_REASONS, DEFAULT_STATUSES } from "../src/lib/constants";

/** Справочники и настройки по умолчанию. Идемпотентно. */
export async function seedBase(prisma: PrismaClient) {
  if ((await prisma.leadStatus.count()) === 0) {
    await prisma.leadStatus.createMany({
      data: DEFAULT_STATUSES.map((s, i) => ({ ...s, order: i + 1, isSystem: s.isSystem ?? false })),
    });
  }
  if ((await prisma.lossReason.count()) === 0) {
    await prisma.lossReason.createMany({ data: DEFAULT_LOSS_REASONS.map((name, i) => ({ name, order: i + 1 })) });
  }
  await prisma.appSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  await prisma.metaIntegration.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });

  const login = (process.env.ADMIN_LOGIN || "admin").toLowerCase();
  const envPassword = process.env.ADMIN_PASSWORD ?? "";
  // на сервере администратор не создаётся с паролем «по умолчанию» (admin123 или из .env.example): без своего
  // ADMIN_PASSWORD пароль случайный и печатается один раз; для разработки остаётся admin123
  const weak = envPassword.length < 8 || envPassword === "change-me-admin-password";
  const password = weak && process.env.NODE_ENV === "production" ? crypto.randomBytes(12).toString("base64url") : envPassword || "admin123";
  const exists = await prisma.user.findUnique({ where: { login } });
  if (!exists) {
    await prisma.user.create({
      data: { login, name: "Администратор", role: "ADMIN", passwordHash: await bcrypt.hash(password, 10) },
    });
    if (password !== envPassword && process.env.NODE_ENV === "production") {
      console.log(`Администратор «${login}» создан со случайным паролем: ${password}\nСохраните его — больше он не покажется.`);
    }
  }
}
