/**
 * Двухфакторный вход: одноразовые коды TOTP (RFC 6238 — Google Authenticator, Microsoft Authenticator и т. п.):
 * HMAC-SHA1, шаг 30 секунд, 6 цифр. Секрет хранится у пользователя зашифрованным (User.totpSecretEnc).
 * Для визовых специалистов обязателен: у них доступ к паспортам клиентов.
 */
import crypto from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP = 30;

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("Неверный секрет");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Новый секрет: 20 случайных байт в base32 (32 символа) */
export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));

/** Код на шаге времени step (номер 30-секундного интервала) */
export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const off = h[h.length - 1] & 15;
  const n = ((h[off] & 127) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

export const totpStep = (now = Date.now()) => Math.floor(now / 1000 / STEP);

/**
 * Проверка кода: принимается текущий и соседние интервалы (±30 с — часы телефона могут отставать).
 * Возвращает шаг совпавшего кода (чтобы не принять тот же код второй раз) или null.
 */
export function verifyTotp(secret: string, code: string, now = Date.now()): number | null {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const cur = totpStep(now);
  for (const step of [cur, cur - 1, cur + 1]) {
    const want = totpAt(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(want), Buffer.from(c))) return step;
  }
  return null;
}

/** Ссылка для QR-кода в приложении-аутентификаторе */
export function otpauthUrl(secret: string, account: string, issuer = "Orient Travel CRM"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;
}

/** Последний принятый шаг по пользователю — один код нельзя использовать дважды (процесс приложения один) */
const usedSteps = new Map<string, number>();
export function consumeTotpStep(userId: string, step: number): boolean {
  if ((usedSteps.get(userId) ?? -1) >= step) return false;
  usedSteps.set(userId, step);
  if (usedSteps.size > 10_000) usedSteps.delete(usedSteps.keys().next().value as string);
  return true;
}
