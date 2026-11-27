/**
 * Интеграция с сайтом Orient Visa — формат обмена в docs/orient-visa-integration.md (читать перед изменениями).
 * Сайт присылает оплаченные заявки (POST /api/public/visa-application), CRM забирает анкету и документы
 * (GET {сайт}/api/integration/applications/{externalId}) и отправляет события (POST {сайт}/api/integration/crm-events)
 * через очередь с повторами.
 */
import crypto from "node:crypto";
import type { Prisma, VisaStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { guessMime } from "@/lib/mime";
import { docFileFields, logDocAccess } from "@/lib/doc-files";
import { notify } from "@/lib/notify";

/** Запись в базу: обычный клиент Prisma или транзакция (событие пишется вместе со сменой этапа) */
type Db = Prisma.TransactionClient;

export interface OrientVisaConfig {
  url: string;
  key: string;
  secret: string;
}

/** Адрес и ключи: из «Настройки → Визы и документы», иначе из окружения (SITE_URL, SITE_INTEGRATION_KEY, CRM_WEBHOOK_SECRET) */
export async function orientVisaConfig(): Promise<OrientVisaConfig | null> {
  const s = await prisma.appSettings.findUnique({ where: { id: 1 }, select: { orientVisaUrl: true, orientVisaKeyEnc: true, orientVisaSecretEnc: true } });
  const url = (s?.orientVisaUrl || process.env.SITE_URL || "").trim().replace(/\/$/, "");
  const key = decrypt(s?.orientVisaKeyEnc) || process.env.SITE_INTEGRATION_KEY || "";
  const secret = decrypt(s?.orientVisaSecretEnc) || process.env.CRM_WEBHOOK_SECRET || "";
  return url && key && secret ? { url, key, secret } : null;
}

export const hmacHex = (secret: string, body: string) => crypto.createHmac("sha256", secret).update(body).digest("hex");

/**
 * Подпись события для сайта, v2 (раздел 3 документа обмена): HMAC-SHA256 от «{X-Timestamp}.{X-Event-Id}.{тело}».
 * Сайт принимает событие, если время в пределах ±5 минут, — перехваченный запрос нельзя повторить позже.
 * На каждом повторе отметка времени и подпись создаются заново.
 */
export function eventHeaders(secret: string, eventId: string, body: string, now = Date.now()): Record<string, string> {
  const ts = String(Math.floor(now / 1000));
  return { "Content-Type": "application/json", "X-Event-Id": eventId, "X-Timestamp": ts, "X-Signature": `v2=${hmacHex(secret, `${ts}.${eventId}.${body}`)}` };
}

const appUrl = () => (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");

/** Подписанная ссылка на файл визы / отказа для сайта: живёт час, сайт скачивает файл сразу при получении события */
export function signedFileUrl(secret: string, documentId: string, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + 3600;
  const sig = hmacHex(secret, `${documentId}.${exp}`);
  return `${appUrl()}/api/public/visa-file/${documentId}?exp=${exp}&sig=${sig}`;
}

export function verifyFileSignature(secret: string, documentId: string, exp: string, sig: string, now = Date.now()): boolean {
  if (!/^\d+$/.test(exp) || Number(exp) * 1000 < now || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const want = hmacHex(secret, `${documentId}.${exp}`);
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig));
}

// ——— События CRM → сайт ———

export interface StatusEventInput {
  status: VisaStatus;
  comment?: string | null;
  rejectedDocuments?: string[];
  portalReference?: string | null;
  fileDocumentId?: string | null;
  proofType?: "OFFICIAL" | "EMAIL" | "SCREENSHOT" | null;
}

/** Событие о смене этапа: только для заявок с сайта. db — транзакция смены этапа: событие и этап пишутся вместе */
export async function enqueueStatusEvent(service: { id: string; externalId: string | null }, e: StatusEventInput, db: Db = prisma) {
  if (!service.externalId) return;
  const payload: Record<string, unknown> = { externalId: service.externalId, serviceId: service.id, type: "status", status: e.status };
  if (e.comment) payload.comment = e.comment;
  if (e.rejectedDocuments?.length) payload.rejectedDocuments = e.rejectedDocuments;
  if (e.portalReference) payload.portalReference = e.portalReference;
  // ссылка на файл подписывается в момент отправки (у каждой попытки — свежая)
  if (e.fileDocumentId) payload.fileDocumentId = e.fileDocumentId;
  if (e.proofType) payload.proofType = e.proofType;
  await db.siteEvent.create({ data: { serviceId: service.id, payload: payload as Prisma.InputJsonValue } });
}

export async function enqueueMessageEvent(service: { id: string; externalId: string | null }, text: string, db: Db = prisma) {
  if (!service.externalId) return;
  await db.siteEvent.create({ data: { serviceId: service.id, payload: { externalId: service.externalId, type: "message", text } } });
}

/** Пауза перед следующей попыткой: 1, 2, 4… минут, не больше 6 часов */
export const retryDelayMs = (attempts: number) => Math.min(6 * 60, 2 ** Math.max(0, attempts - 1)) * 60_000;

export type FetchFn = typeof fetch;

/**
 * Когда прекратить автоповторы события и показать «требует внимания» (кнопка «Повторить» на карточке визы):
 * сайт отвечает 4xx (кроме 408/429) — повтор не поможет, хватит 5 попыток (~30 минут); сеть и 5xx — 15 попыток (~2 суток).
 */
export const STUCK_AFTER = { rejected: 5, other: 15 } as const;
export function shouldStopRetrying(attempts: number, error: string): boolean {
  const code = /^HTTP (\d{3})/.exec(error)?.[1];
  const rejected = !!code && code.startsWith("4") && code !== "408" && code !== "429";
  return attempts >= (rejected ? STUCK_AFTER.rejected : STUCK_AFTER.other);
}

/**
 * Отправить события, которым пора. Внутри одной заявки — строго по порядку:
 * пока не ушло раннее событие, следующие не отправляются (сайт применяет статусы последовательно).
 * Событие, которое «требует внимания» (stuckAt), тоже держит следующие события своей заявки, пока его не повторят.
 */
export async function processSiteEvents(now = new Date(), fetchFn: FetchFn = fetch): Promise<number> {
  const cfg = await orientVisaConfig();
  if (!cfg) return 0;
  // все неотправленные (их мало): если взять только 100 самых старых, застрявшие события одних заявок
  // закрыли бы очередь остальным
  const pending = await prisma.siteEvent.findMany({ where: { sentAt: null }, orderBy: { createdAt: "asc" }, take: 2000 });
  const blocked = new Set<string>();
  let sent = 0;
  for (const ev of pending) {
    if (blocked.has(ev.serviceId)) continue;
    if (ev.stuckAt || ev.nextAt > now) {
      blocked.add(ev.serviceId);
      continue;
    }
    const p = { ...(ev.payload as Record<string, unknown>) };
    if (typeof p.fileDocumentId === "string") {
      const doc = await prisma.leadDocument.findUnique({ where: { id: p.fileDocumentId }, select: { id: true, fileName: true } });
      if (doc) p.file = { url: signedFileUrl(cfg.secret, doc.id, now.getTime()), name: doc.fileName };
      delete p.fileDocumentId;
    }
    const body = JSON.stringify(p);
    let error: string | null = null;
    try {
      const res = await fetchFn(`${cfg.url}/api/integration/crm-events`, {
        method: "POST",
        headers: eventHeaders(cfg.secret, ev.id, body),
        body,
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) error = `HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    if (!error) {
      await prisma.siteEvent.update({ where: { id: ev.id }, data: { sentAt: new Date(), attempts: { increment: 1 }, lastError: null } });
      sent++;
    } else {
      const stuck = shouldStopRetrying(ev.attempts + 1, error);
      await prisma.siteEvent.update({
        where: { id: ev.id },
        data: { attempts: { increment: 1 }, lastError: error.slice(0, 500), nextAt: new Date(now.getTime() + retryDelayMs(ev.attempts + 1)), ...(stuck ? { stuckAt: now } : {}) },
      });
      if (stuck) await notifyVisaProblem(ev.serviceId, "visaStuck", `visaStuck:${ev.id}`);
      blocked.add(ev.serviceId);
    }
  }
  return sent;
}

/** «Повторить» на карточке визы: события заявки снова отправляются, счётчик попыток с нуля */
export async function retrySiteEvents(serviceId: string, now = new Date()): Promise<number> {
  const { count } = await prisma.siteEvent.updateMany({ where: { serviceId, sentAt: null }, data: { stuckAt: null, attempts: 0, nextAt: now } });
  return count;
}

/** Уведомление о проблеме обмена с сайтом: исполнителю заявки (если есть) и администраторам — один раз на ключ */
async function notifyVisaProblem(serviceId: string, type: "visaStuck" | "visaFetch", key: string) {
  const s = await prisma.leadService.findUnique({ where: { id: serviceId }, select: { assigneeId: true, lead: { select: { name: true } } } });
  if (!s) return;
  const admins = (await prisma.user.findMany({ where: { role: "ADMIN", isActive: true }, select: { id: true } })).map((u) => u.id);
  const to = [...new Set([...(s.assigneeId ? [s.assigneeId] : []), ...admins])];
  await notify(to.map((userId) => ({ userId, type, key: `${key}:${userId}`, link: `/visa/${serviceId}`, data: { name: s.lead.name } })));
}

// ——— Анкета и документы с сайта ———

export interface SiteField {
  key: string;
  label: string;
  value: string | null;
}
export interface SiteTraveler {
  id: string;
  position: number;
  name: string;
  fields: SiteField[];
}
export interface SiteData {
  number: string | null;
  status: string | null;
  visaType: string | null;
  /** гражданство заявителя (ISO2); нет — Узбекистан */
  nationality?: string | null;
  urgent: boolean;
  travelDate: string | null;
  returnDate: string | null;
  contact: { name?: string | null; phone?: string | null; email?: string | null; telegram?: string | null } | null;
  travelers: SiteTraveler[];
  updatedAt: string | null;
}

interface SiteDocument {
  id: string;
  title: string;
  mime?: string | null;
  size?: number | null;
  status?: string | null;
  url?: string | null;
  /** файл уже передан в CRM и удалён с сайта (после documents_received): url = null */
  transferred?: boolean;
}

export function readSiteData(enc: string | null | undefined): SiteData | null {
  const raw = decrypt(enc);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SiteData;
  } catch {
    return null;
  }
}

/**
 * Ссылка на файл из анкеты сайта: скачиваем только с адреса сайта (`/api/integration/files/…`, зашифрованные файлы)
 * или с его хранилища `files.<домен сайта>` (старые незашифрованные файлы). Чужой адрес не скачиваем.
 */
export function isSiteFileUrl(fileUrl: string, siteUrl: string): boolean {
  let f: URL, site: URL;
  try {
    f = new URL(fileUrl);
    site = new URL(siteUrl);
  } catch {
    return false;
  }
  if (f.protocol !== site.protocol || f.username || f.password) return false;
  if (f.origin === site.origin) return true;
  const host = site.hostname.replace(/^www\./, "");
  return f.hostname === `files.${host}` && (f.port === "" || f.port === site.port);
}

const str = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? null : String(v));

/** Забрать анкету и документы заявки с сайта: анкета — зашифрованно в заявку, новые файлы — в документы CRM */
export async function fetchSiteApplication(serviceId: string, fetchFn: FetchFn = fetch): Promise<{ ok: boolean; added: number; error?: string }> {
  const s = await prisma.leadService.findUnique({ where: { id: serviceId }, select: { id: true, leadId: true, externalId: true, siteFetchTries: true } });
  if (!s?.externalId) return { ok: false, added: 0, error: "not a site application" };
  // неудача: счётчик попыток и время следующей (пауза растёт: 1, 2, 4… минут, до 6 часов)
  const tries = (s.siteFetchTries ?? 0) + 1;
  const retryAt = () => new Date(Date.now() + retryDelayMs(tries));
  const fail = async (error: string) => {
    await prisma.leadService.update({ where: { id: s.id }, data: { siteFetchError: error.slice(0, 500), siteFetchTries: { increment: 1 }, siteFetchNextAt: retryAt() } });
    await notifyFetchStopped(s.id, tries);
    return { ok: false, added: 0, error };
  };
  const cfg = await orientVisaConfig();
  if (!cfg) return fail("Не настроена связь с сайтом Orient Visa");

  let json: Record<string, unknown>;
  try {
    const res = await fetchFn(`${cfg.url}/api/integration/applications/${encodeURIComponent(s.externalId)}`, {
      headers: { Authorization: `Bearer ${cfg.key}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return fail(`HTTP ${res.status}`);
    json = (await res.json()) as Record<string, unknown>;
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }

  const travelersRaw = Array.isArray(json.travelers) ? (json.travelers as Record<string, unknown>[]) : [];
  const data: SiteData = {
    number: str(json.number),
    status: str(json.status),
    visaType: str(json.visaType),
    nationality: typeof json.nationality === "string" && /^[A-Za-z]{2}$/.test(json.nationality) ? json.nationality.toUpperCase() : null,
    urgent: !!json.urgent,
    travelDate: str(json.travelDate),
    returnDate: str(json.returnDate),
    contact: json.contact && typeof json.contact === "object" ? (json.contact as SiteData["contact"]) : null,
    travelers: travelersRaw.map((t, i) => ({
      id: str(t.id) ?? String(i),
      position: Number(t.position) || i + 1,
      name: str(t.name) ?? "",
      fields: (Array.isArray(t.fields) ? (t.fields as Record<string, unknown>[]) : []).map((f) => ({ key: str(f.key) ?? "", label: str(f.label) ?? str(f.key) ?? "", value: str(f.value) })),
    })),
    updatedAt: str(json.updatedAt),
  };

  // файлы: ссылки живут 10 минут — скачиваем сразу; уже скачанные (по id документа на сайте) не трогаем
  const have = new Set((await prisma.leadDocument.findMany({ where: { serviceId: s.id, externalId: { not: null } }, select: { externalId: true } })).map((d) => d.externalId));
  let added = 0;
  const errors: string[] = [];
  // переданные в CRM и удалённые с сайта файлы, которых в CRM нет (их удалили здесь) — повтор не поможет, только сообщаем
  const lost: string[] = [];
  for (const t of travelersRaw) {
    const docs = Array.isArray(t.documents) ? (t.documents as SiteDocument[]) : [];
    for (const d of docs) {
      if (!d?.id || have.has(d.id)) continue;
      if (!d.url) {
        if (d.transferred) lost.push(d.title);
        continue;
      }
      if (!isSiteFileUrl(d.url, cfg.url)) {
        errors.push(`${d.title}: ссылка не с адреса сайта`);
        continue;
      }
      try {
        const res = await fetchFn(d.url, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // после переадресаций файл всё равно должен прийти с адреса сайта или его хранилища
        if (res.url && !isSiteFileUrl(res.url, cfg.url)) throw new Error("файл отдан не с адреса сайта");
        if (Number(res.headers.get("content-length") ?? 0) > SITE_FILE_MAX) throw new Error("файл больше 25 МБ");
        const body = new Uint8Array(await res.arrayBuffer());
        if (body.length > SITE_FILE_MAX) throw new Error("файл больше 25 МБ");
        const mime = d.mime || res.headers.get("content-type")?.split(";")[0] || null;
        const ext = mime?.split("/")[1]?.replace("jpeg", "jpg") ?? "bin";
        const fileName = `${(d.title || "document").replace(/[\\/:*?"<>|\r\n]/g, " ").trim()}${t.name ? ` — ${str(t.name)}` : ""}.${ext}`;
        // уникальность (serviceId, externalId): если этот же документ параллельно сохранил воркер или кнопка
        // «Обновить с сайта», второй копии не будет
        const doc = await prisma.leadDocument
          .create({
            data: { serviceId: s.id, leadId: s.leadId, docType: d.title || "Документ", fileName: fileName.slice(0, 200), mime: guessMime(fileName, mime), ...docFileFields(body), externalId: d.id, travelerName: str(t.name) },
            select: { id: true, serviceId: true, fileName: true },
          })
          .catch((e: unknown) => {
            if ((e as { code?: string }).code === "P2002") return null;
            throw e;
          });
        have.add(d.id);
        if (!doc) continue;
        await logDocAccess([doc], "upload", null);
        added++;
      } catch (e) {
        errors.push(`${d.title}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  await prisma.leadService.update({
    where: { id: s.id },
    data: {
      siteDataEnc: encrypt(JSON.stringify(data)),
      ...(data.visaType ? { visaType: data.visaType } : {}),
      ...(data.nationality ? { nationality: data.nationality } : {}),
      ...(data.number ? { externalNumber: data.number } : {}),
      // не скачались не все файлы — попробуем ещё раз (ссылки при повторе будут новые)
      siteFetchNeeded: errors.length > 0,
      siteFetchedAt: new Date(),
      siteFetchError: errors.length ? errors.join("; ").slice(0, 500) : lost.length ? `Файлы уже удалены с сайта, а в CRM их нет: ${lost.join(", ")}`.slice(0, 500) : null,
      siteFetchTries: errors.length ? { increment: 1 } : 0,
      siteFetchNextAt: errors.length ? retryAt() : null,
    },
  });
  if (errors.length) await notifyFetchStopped(s.id, tries);
  // сохранённые файлы подтверждаем сайту — он удаляет их у себя (минимизация данных)
  await acknowledgeSiteDocuments(s.id);
  return { ok: !errors.length, added, error: errors[0] };
}

/**
 * Подтверждение получения документов сайту (раздел 3 документа обмена): {"type":"documents_received",
 * "documents":[{id, sha256}]}. Сайт удаляет у себя файлы с совпавшей суммой. Каждый документ подтверждается один раз;
 * файлы, сохранённые до шифрования, — после того как воркер их зашифрует и посчитает sha256.
 */
export async function acknowledgeSiteDocuments(serviceId: string, now = new Date()): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const s = await tx.leadService.findUnique({ where: { id: serviceId }, select: { id: true, externalId: true } });
    if (!s?.externalId) return 0;
    const docs = await tx.leadDocument.findMany({
      where: { serviceId, externalId: { not: null }, sha256: { not: null }, siteAckAt: null, purgedAt: null },
      select: { id: true, externalId: true, sha256: true },
    });
    if (!docs.length) return 0;
    // updateMany с условием siteAckAt = null: параллельный вызов не поставит то же подтверждение второй раз
    const { count } = await tx.leadDocument.updateMany({ where: { id: { in: docs.map((d) => d.id) }, siteAckAt: null }, data: { siteAckAt: now } });
    if (count !== docs.length) throw new Error("documents_received: документы подтверждаются параллельно");
    await tx.siteEvent.create({
      data: { serviceId, payload: { externalId: s.externalId, serviceId, type: "documents_received", documents: docs.map((d) => ({ id: d.externalId!, sha256: d.sha256! })) } },
    });
    return docs.length;
  });
}

/** Воркер: подтвердить сайту документы, которые ещё не подтверждены (после шифрования старых файлов и при сбоях) */
export async function acknowledgePendingSiteDocuments(): Promise<number> {
  if (!(await orientVisaConfig())) return 0;
  const services = await prisma.leadService.findMany({
    where: { externalId: { not: null }, documents: { some: { externalId: { not: null }, sha256: { not: null }, siteAckAt: null, purgedAt: null } } },
    select: { id: true },
    take: 50,
  });
  let n = 0;
  for (const s of services) n += await acknowledgeSiteDocuments(s.id).catch(() => 0);
  return n;
}

/** Файл с сайта — не больше 25 МБ */
const SITE_FILE_MAX = 25 * 1024 * 1024;
/** После стольких неудач подряд воркер перестаёт загружать анкету сам: исполнителю и администраторам уходит уведомление */
export const SITE_FETCH_MAX_TRIES = 30;

/** Автозагрузка остановилась (столько неудач подряд) — исполнителю и администраторам: нажать «Обновить с сайта» */
async function notifyFetchStopped(serviceId: string, tries: number) {
  if (tries === SITE_FETCH_MAX_TRIES) await notifyVisaProblem(serviceId, "visaFetch", `visaFetch:${serviceId}:${Date.now()}`);
}

/** Воркер: заявки, у которых надо (заново) забрать анкету — по времени следующей попытки, самые давние первыми */
export async function processSiteFetches(now = new Date()): Promise<number> {
  if (!(await orientVisaConfig())) return 0;
  const list = await prisma.leadService.findMany({
    where: { siteFetchNeeded: true, externalId: { not: null }, siteFetchTries: { lt: SITE_FETCH_MAX_TRIES }, OR: [{ siteFetchNextAt: null }, { siteFetchNextAt: { lte: now } }] },
    orderBy: [{ siteFetchNextAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    select: { id: true },
    take: 20,
  });
  let done = 0;
  for (const s of list) {
    if ((await fetchSiteApplication(s.id)).ok) done++;
  }
  return done;
}
