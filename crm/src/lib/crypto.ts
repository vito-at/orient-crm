import crypto from "node:crypto";

/**
 * Шифрование секретов интеграции (App Secret, Page Access Token) — AES-256-GCM.
 * Ключ берётся из ENCRYPTION_KEY: 64 hex-символа (32 байта) или любая строка (тогда из неё выводится ключ через SHA-256).
 */
let weakKeyWarned = false;

export function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("ENCRYPTION_KEY не задан в .env");
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  // Требовать 64 hex сразу нельзя: всё, что уже зашифровано этим ключом, перестанет расшифровываться.
  // Слабый ключ (короткое слово) — только предупреждение в журнале; замена ключа — с перешифровкой данных
  if (!weakKeyWarned && raw.length < 32) {
    weakKeyWarned = true;
    console.warn("[crypto] ENCRYPTION_KEY короче 32 символов: паспорта и ключи интеграций защищены слабым ключом. Нужен ключ из `openssl rand -hex 32` с перешифровкой данных.");
  }
  return crypto.createHash("sha256").update(raw).digest();
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decrypt(payload: string | null | undefined): string | null {
  if (!payload) return null;
  const [v, ivB64, tagB64, dataB64] = payload.split(":");
  if (v !== "v1" || !ivB64 || !tagB64 || !dataB64) throw new Error("Неверный формат зашифрованного значения");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

/** Маска для отображения секрета в интерфейсе: «EAAG…x9Zq» */
export function maskSecret(s: string | null | undefined): string {
  if (!s) return "";
  if (s.length <= 8) return "••••";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}
