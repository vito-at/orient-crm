/**
 * Файлы документов клиентов (паспорта, анкеты, визы): хранятся в базе зашифрованными AES-256-GCM тем же ключом
 * ENCRYPTION_KEY, что и анкета с сайта (siteDataEnc). Каждый просмотр, скачивание, загрузка и удаление пишется
 * в журнал DocumentAccess. Через docRetentionDays дней после выдачи визы / отказа содержимое удаляется
 * (минимизация персональных данных — docs/orient-visa-integration.md, раздел 3).
 */
import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getKey } from "@/lib/crypto";

/** Признак зашифрованного файла: «OTD1» + iv (12) + тег (16) + шифртекст */
const MAGIC = Buffer.from("OTD1");

export function encryptBytes(plain: Uint8Array): Uint8Array<ArrayBuffer> {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return new Uint8Array(Buffer.concat([MAGIC, iv, cipher.getAuthTag(), enc]));
}

/** Расшифровка; старые файлы, сохранённые до шифрования, возвращаются как есть */
export function decryptBytes(stored: Uint8Array, encrypted: boolean): Buffer {
  const buf = Buffer.from(stored);
  if (!encrypted) return buf;
  if (buf.length < 32 || !buf.subarray(0, 4).equals(MAGIC)) throw new Error("Повреждённый зашифрованный файл");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), buf.subarray(4, 16));
  decipher.setAuthTag(buf.subarray(16, 32));
  return Buffer.concat([decipher.update(buf.subarray(32)), decipher.final()]);
}

export const sha256Hex = (data: Uint8Array) => crypto.createHash("sha256").update(data).digest("hex");

/** Поля для сохранения нового файла документа: зашифрованное содержимое, размер и SHA-256 исходника */
export function docFileFields(plain: Uint8Array) {
  return { data: encryptBytes(plain), encrypted: true, size: plain.length, sha256: sha256Hex(plain) };
}

export type DocAction = "view" | "download" | "upload" | "delete" | "purge" | "site";

export async function logDocAccess(
  docs: { id: string; serviceId?: string | null; fileName: string }[],
  action: DocAction,
  userId: string | null,
  ip?: string | null,
  tx: Prisma.TransactionClient = prisma,
) {
  if (!docs.length) return;
  await tx.documentAccess.createMany({
    data: docs.map((d) => ({ documentId: d.id, serviceId: d.serviceId ?? null, fileName: d.fileName, action, userId, ip: ip ?? null })),
  });
}

/** Шифрование файлов, сохранённых до появления шифрования, — понемногу, чтобы не держать базу (воркер) */
export async function encryptStoredDocuments(batch = 20): Promise<number> {
  const docs = await prisma.leadDocument.findMany({ where: { encrypted: false, purgedAt: null }, select: { id: true, data: true }, take: batch });
  for (const d of docs) {
    const plain = Buffer.from(d.data);
    // updateMany с условием: если файл за это время зашифровали или удалили, не трогаем
    await prisma.leadDocument.updateMany({ where: { id: d.id, encrypted: false }, data: { data: encryptBytes(plain), encrypted: true, sha256: sha256Hex(plain) } });
  }
  return docs.length;
}

/**
 * Срок хранения: через docRetentionDays дней после выдачи визы / отказа удаляются файлы документов и анкета с сайта.
 * Записи о документах (тип, имя файла, кто загрузил) остаются с пометкой «удалён по сроку хранения».
 */
export async function purgeExpiredDocuments(now = new Date()): Promise<{ services: number; documents: number }> {
  const s = await prisma.appSettings.findUnique({ where: { id: 1 }, select: { docRetentionDays: true } });
  const days = s?.docRetentionDays ?? 0;
  if (days <= 0) return { services: 0, documents: 0 };
  const before = new Date(now.getTime() - days * 86_400_000);
  const services = await prisma.leadService.findMany({
    where: { type: "VISA", status: { in: ["APPROVED", "REJECTED"] }, statusAt: { lt: before }, OR: [{ purgedAt: null }, { documents: { some: { purgedAt: null } } }] },
    select: { id: true, documents: { where: { purgedAt: null }, select: { id: true, serviceId: true, fileName: true } } },
    take: 50,
  });
  let documents = 0;
  for (const svc of services) {
    await prisma.$transaction(async (tx) => {
      await tx.leadDocument.updateMany({ where: { id: { in: svc.documents.map((d) => d.id) } }, data: { data: Buffer.alloc(0), purgedAt: now } });
      await tx.leadService.update({ where: { id: svc.id }, data: { siteDataEnc: null, purgedAt: now } });
      await logDocAccess(svc.documents, "purge", null, null, tx);
    });
    documents += svc.documents.length;
  }
  return { services: services.length, documents };
}
