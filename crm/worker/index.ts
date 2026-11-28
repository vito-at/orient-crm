/**
 * Фоновый воркер: опрос Meta по расписанию, загрузка расходов на рекламу, обновление курса USD.
 * Запуск: npm run worker (в Docker — отдельный сервис worker).
 */
import cron from "node-cron";
import { prisma } from "../src/lib/db";
import { backfillOrganic, fixPhonelessLeads, fixUnnamedLeads, syncLeads } from "../src/lib/meta/sync";
import { createTripFollowUps } from "../src/lib/leads/trip-followup";
import { scanNotifications } from "../src/lib/notify";
import { processAiReplies } from "../src/lib/chats/ai";
import { acknowledgePendingSiteDocuments, processSiteEvents, processSiteFetches } from "../src/lib/orient-visa";
import { encryptStoredDocuments, purgeExpiredDocuments } from "../src/lib/doc-files";
import { syncSpend } from "../src/lib/meta/insights";
import { backfillConversions, sendPendingConversions } from "../src/lib/meta/capi";
import { isRateStale, RATE_RETRY_UNTIL_HOUR, updateUsdRate } from "../src/lib/rates";
import { distributeQueue } from "../src/lib/leads/distribution";
import { endIdleShifts } from "../src/lib/shift";
import { i18nFor } from "../src/i18n/instance";
import type { TKey } from "../src/i18n/core";
import { createJobGuard } from "./guard";

// журнал воркера — по-русски
const { t } = i18nFor("ru");

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);
/** задачи по расписанию не накладываются, зависшая задача не блокирует свою работу навсегда (worker/guard.ts) */
const job = createJobGuard(log);

/** Каждую минуту проверяем, не пора ли синхронизироваться (интервал задаётся в настройках) */
async function tickLeads() {
  try {
    const i = await prisma.metaIntegration.findUnique({ where: { id: 1 } });
    if (!i?.enabled) return;
    const intervalMs = Math.max(1, i.pollIntervalMin) * 60_000;
    if (i.lastSyncAt && Date.now() - i.lastSyncAt.getTime() < intervalMs - 5_000) return;
    const r = await syncLeads("CRON");
    if (r.skipped) log("Синхронизация пропущена:", t(r.skipped as TKey));
    else log(`Синхронизация: форм ${r.formsChecked}, получено ${r.fetched}, новых ${r.created}, дублей ${r.duplicates}`, r.errors.length ? r.errors : "");
    const organic = await backfillOrganic().catch((e) => (log("Признак органики:", e instanceof Error ? e.message : e), 0));
    if (organic) log(`Признак органики получен для ${organic} лидов`);
  } catch (e) {
    log("Ошибка синхронизации лидов:", e);
  }
}

/** Отметка «воркер жив» раз в минуту: давно не отмечался — администратор видит предупреждение в CRM */
async function heartbeat() {
  const now = new Date();
  await prisma.appSettings.upsert({ where: { id: 1 }, update: { workerSeenAt: now }, create: { id: 1, workerSeenAt: now } });
}

async function tickSpend() {
  try {
    const i = await prisma.metaIntegration.findUnique({ where: { id: 1 } });
    if (!i?.enabled || !i.adAccountId) return;
    // первый запуск — за 90 дней, дальше — последние 3 дня (Meta уточняет расходы задним числом)
    const r = await syncSpend(i.lastSpendSyncAt ? 3 : 90);
    log("Расходы на рекламу:", r);
  } catch (e) {
    log("Ошибка загрузки расходов:", e);
  }
}

/**
 * Курс USD: каждый день в 07:00 по Ташкенту. Если не получилось — повтор каждые 30 минут до 12:00.
 * Пока курс за сегодня не обновлён, сотрудники видят уведомление (см. RateNotice).
 */
async function tickRate(force = false) {
  try {
    const s = await prisma.appSettings.findUnique({ where: { id: 1 } });
    if (!s || s.usdRateSource !== "IPAK_YULI") return;
    if (!force && !isRateStale(s.usdRateUpdatedAt)) return;
    const r = await updateUsdRate();
    log("Курс USD:", r);
  } catch (e) {
    log("Ошибка обновления курса:", e);
  }
}

/** Conversions API: повтор событий, которые не ушли сразу при смене статуса */
async function tickConversions() {
  try {
    // досылка статусов, сменённых, пока Conversions API был выключен (за последние 7 дней)
    const queued = await backfillConversions();
    const r = await sendPendingConversions();
    if (queued || r.sent || r.failed) log("Conversions API:", { ...r, queued });
  } catch (e) {
    log("Ошибка Conversions API:", e);
  }
}

const leads = job("Лиды Meta", tickLeads);
cron.schedule("* * * * *", job("Воркер жив", heartbeat));
cron.schedule("* * * * *", leads);
cron.schedule("*/5 * * * *", job("Conversions API", tickConversions));
// напоминания «Спросить, как прошла поездка» — каждый час (задача ставится на 11:00 дня после возвращения)
// уведомления о просроченных задачах — каждые 10 минут
cron.schedule("*/10 * * * *", job("Уведомления", () => scanNotifications()));
// ИИ-ассистент: страховка, если ответ после вебхука не прошёл (перезапуск, сбой)
// сайт Orient Visa: события о визах с повторами и загрузка анкет/документов
cron.schedule("* * * * *", job("Orient Visa, события", () => processSiteEvents()));
cron.schedule("* * * * *", job("Orient Visa, анкеты", () => processSiteFetches()));
// документы клиентов: старые файлы шифруются понемногу, сохранённые с сайта подтверждаются ему (сайт удаляет у себя),
// по сроку хранения после выдачи визы / отказа паспорта и анкета удаляются (раз в сутки ночью)
cron.schedule(
  "* * * * *",
  job("Документы, шифрование/подтверждение", async () => {
    const n = await encryptStoredDocuments();
    if (n) log(`Документы зашифрованы: ${n}`);
    const acked = await acknowledgePendingSiteDocuments();
    if (acked) log(`Сайту подтверждено получение документов: ${acked}`);
  }),
);
cron.schedule(
  "23 3 * * *",
  job("Срок хранения документов", async () => {
    const r = await purgeExpiredDocuments();
    if (r.services || r.chatFiles) log("Удалено по сроку хранения:", r);
  }),
  { timezone: "Asia/Tashkent" },
);
// очередь лидов: страховка раздачи (после действий она идёт сразу)
cron.schedule("* * * * *", job("Очередь лидов", async () => {
  const n = await distributeQueue();
  if (n) log(`Лиды из очереди выданы: ${n}`);
}));
// «В работе» выключается само, если менеджер час ничего не делал в CRM
cron.schedule("* * * * *", job("Конец смены", async () => {
  const n = await endIdleShifts();
  if (n) log(`«В работе» выключено (час без действий): ${n}`);
}));
cron.schedule("* * * * *", job("ИИ-ассистент", () => processAiReplies()));
cron.schedule("7 * * * *", job("Задачи после поездки", async () => {
  const n = await createTripFollowUps();
  if (n) log(`Задачи после поездки: ${n}`);
}));
cron.schedule("17 * * * *", job("Расходы на рекламу", tickSpend));
cron.schedule("0 7 * * *", job("Курс USD", () => tickRate(true)), { timezone: "Asia/Tashkent" });
cron.schedule(`*/30 7-${RATE_RETRY_UNTIL_HOUR - 1} * * *`, job("Курс USD", () => tickRate()), { timezone: "Asia/Tashkent" });

log("Воркер запущен");
void heartbeat().catch((e) => log("Воркер жив:", e));
void leads();
// лиды «Без имени», чьё имя было в своём вопросе формы, — один раз при запуске
void fixUnnamedLeads()
  .then((n) => n && log(`Имя из ответов формы записано в ${n} лидов`))
  .catch((e) => log("Имена из ответов формы:", e));
// лиды без телефона, чей номер был в своём вопросе формы, — один раз при запуске
void fixPhonelessLeads()
  .then((n) => n && log(`Телефон из ответов формы записан в ${n} лидов`))
  .catch((e) => log("Телефоны из ответов формы:", e));
// при запуске воркера после 07:00 — догоняем пропущенное обновление
void tickRate();

async function shutdown() {
  log("Остановка воркера");
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
