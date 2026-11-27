/**
 * Защита входа от подбора пароля. Неудачные попытки за последние 15 минут считаются трижды:
 * - пара «логин + IP»: после 5 ошибок вход для этой пары закрыт;
 * - IP: после 30 ошибок по любым логинам закрыт весь IP (перебор логинов с одного адреса);
 * - логин: после 20 ошибок с разных IP вход под этим логином закрыт, кроме IP, с которых под ним уже входили
 *   (подбор с множества адресов). Знакомые IP не запираются — иначе кто угодно мог бы закрыть администратору вход,
 *   вводя неверный пароль.
 * Хранится в памяти процесса (приложение — один процесс); после перезапуска счётчики обнуляются.
 */
const PAIR_MAX = 5;
const IP_MAX = 30;
const LOGIN_MAX = 20;
const WINDOW_MS = 15 * 60_000;
const KNOWN_IPS_PER_LOGIN = 10;
const MAX_KEYS = 10_000;

type Counter = { count: number; first: number };
const pairs = new Map<string, Counter>();
const ips = new Map<string, Counter>();
const logins = new Map<string, Counter>();
/** IP, с которых под логином был успешный вход */
const knownIps = new Map<string, string[]>();

const norm = (login: string) => login.trim().toLowerCase();
const pairKey = (login: string, ip: string) => `${norm(login)}|${ip}`;

function over(map: Map<string, Counter>, key: string, max: number, now: number): boolean {
  const c = map.get(key);
  if (!c) return false;
  if (now - c.first > WINDOW_MS) {
    map.delete(key);
    return false;
  }
  return c.count >= max;
}

function bump(map: Map<string, Counter>, key: string, now: number) {
  const c = map.get(key);
  if (!c || now - c.first > WINDOW_MS) map.set(key, { count: 1, first: now });
  else c.count++;
  if (map.size > MAX_KEYS) map.delete(map.keys().next().value as string);
}

/** Вход для этого логина с этого IP сейчас закрыт */
export function loginBlocked(login: string, ip: string, now = Date.now()): boolean {
  const l = norm(login);
  if (over(pairs, pairKey(l, ip), PAIR_MAX, now)) return true;
  if (over(ips, ip, IP_MAX, now)) return true;
  return over(logins, l, LOGIN_MAX, now) && !(knownIps.get(l) ?? []).includes(ip);
}

export function loginFailed(login: string, ip: string, now = Date.now()) {
  const l = norm(login);
  bump(pairs, pairKey(l, ip), now);
  bump(ips, ip, now);
  bump(logins, l, now);
}

export function loginSucceeded(login: string, ip: string) {
  const l = norm(login);
  pairs.delete(pairKey(l, ip));
  const known = (knownIps.get(l) ?? []).filter((x) => x !== ip);
  known.unshift(ip);
  knownIps.set(l, known.slice(0, KNOWN_IPS_PER_LOGIN));
  if (knownIps.size > MAX_KEYS) knownIps.delete(knownIps.keys().next().value as string);
}

/** Только для тестов: сбросить счётчики */
export function resetLoginGuard() {
  pairs.clear();
  ips.clear();
  logins.clear();
  knownIps.clear();
}

/** IP клиента за прокси Caddy */
export function clientIp(headers: Headers | undefined): string {
  return headers?.get("x-forwarded-for")?.split(",")[0]?.trim() || headers?.get("x-real-ip") || "unknown";
}
