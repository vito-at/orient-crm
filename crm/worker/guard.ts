/**
 * Задачи воркера по расписанию не накладываются: пока предыдущий запуск идёт, новый пропускается.
 * Запуск дольше hangMs считается зависшим: это пишется в журнал, и следующий запуск разрешается
 * (иначе одна зависшая задача остановила бы свою работу навсегда). Ошибка задачи пишется в журнал и не роняет воркер.
 */
export function createJobGuard(log: (...args: unknown[]) => void, now: () => number = Date.now) {
  const running = new Map<string, number>();
  return function job(name: string, fn: () => Promise<unknown>, hangMs = 15 * 60_000) {
    return async (): Promise<void> => {
      const started = running.get(name);
      if (started !== undefined) {
        if (now() - started < hangMs) return;
        log(`Задача «${name}» идёт дольше ${Math.round(hangMs / 60_000)} мин — похоже, зависла; запускаю заново`);
      }
      const me = now();
      running.set(name, me);
      try {
        await fn();
      } catch (e) {
        log(`${name}:`, e);
      } finally {
        if (running.get(name) === me) running.delete(name);
      }
    };
  };
}
