import { describe, expect, it } from "vitest";
import { createJobGuard } from "../worker/guard";

describe("задачи воркера не накладываются", () => {
  it("пока запуск идёт, второй пропускается; после окончания — снова запускается", async () => {
    const logs: unknown[][] = [];
    const job = createJobGuard((...a) => logs.push(a));
    let runs = 0;
    let release!: () => void;
    const run = job("events", () => {
      runs++;
      return new Promise<void>((r) => (release = r));
    });
    const first = run();
    await run();
    expect(runs).toBe(1);
    release();
    await first;
    const third = run();
    expect(runs).toBe(2);
    release();
    await third;
    expect(logs).toEqual([]);
  });

  it("зависший запуск не блокирует задачу навсегда", async () => {
    const logs: unknown[][] = [];
    let t = 0;
    const job = createJobGuard((...a) => logs.push(a), () => t);
    let runs = 0;
    const run = job("fetches", () => (runs++, new Promise(() => {})), 10 * 60_000);
    void run();
    t = 5 * 60_000;
    void run();
    expect(runs).toBe(1);
    t = 11 * 60_000;
    void run();
    expect(runs).toBe(2);
    expect(String(logs[0]?.[0])).toContain("зависла");
  });

  it("ошибка задачи пишется в журнал и не мешает следующему запуску", async () => {
    const logs: unknown[][] = [];
    const job = createJobGuard((...a) => logs.push(a));
    let runs = 0;
    const run = job("purge", async () => {
      runs++;
      throw new Error("boom");
    });
    await run();
    await run();
    expect(runs).toBe(2);
    expect(logs.length).toBe(2);
  });
});
