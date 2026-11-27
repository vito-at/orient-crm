import type { Role } from "@prisma/client";

/**
 * Кому без двухфакторного входа работать нельзя: визовому специалисту (паспорта клиентов) и администратору
 * (все паспорта, настройки, ключи интеграций, выгрузки). Пока не включит защиту, его отправляет на «Мой профиль».
 */
export const totpRequiredFor = (role: Role) => role === "VISA" || role === "ADMIN";

/** Вошёл без кода, а 2FA для его роли обязательна */
export const needsTotp = (user: { role: Role; totp?: boolean }) => totpRequiredFor(user.role) && !user.totp;

/** Документы клиентов (паспорта) открываются только после входа с кодом — в том числе менеджерам по своим лидам */
export const docsNeedTotp = (user: { totp?: boolean }) => !user.totp;
