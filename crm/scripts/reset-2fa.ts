/**
 * Сброс двухфакторного входа сотрудника из консоли сервера — на случай, когда телефон потерял единственный
 * администратор. Остальным сотрудникам 2FA сбрасывает администратор: «Настройки → Пользователи».
 * После сброса все входы сотрудника закрываются; при следующем входе CRM попросит включить 2FA заново.
 *
 * На сервере, в папке CRM:
 *   docker compose exec app npx tsx scripts/reset-2fa.ts <логин>
 */
import { PrismaClient } from "@prisma/client";

async function main() {
  const login = (process.argv[2] ?? "").trim().toLowerCase();
  if (!login) {
    console.error("Укажите логин: npx tsx scripts/reset-2fa.ts <логин>");
    process.exit(1);
  }
  const prisma = new PrismaClient();
  try {
    const { count } = await prisma.user.updateMany({ where: { login }, data: { totpSecretEnc: null, totpEnabledAt: null } });
    if (!count) {
      console.error(`Сотрудник с логином «${login}» не найден`);
      process.exit(1);
    }
    console.log(`Двухфакторный вход для «${login}» сброшен. При следующем входе CRM попросит включить его заново.`);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
