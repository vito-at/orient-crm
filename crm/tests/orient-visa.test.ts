import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { eventHeaders, hmacHex, retryDelayMs, signedFileUrl, verifyFileSignature } from "@/lib/orient-visa";

describe("интеграция с сайтом Orient Visa", () => {
  it("подпись события — HMAC-SHA256 сырого тела в hex, как проверяет сайт", () => {
    const body = JSON.stringify({ externalId: "x", type: "status", status: "APPROVED" });
    expect(hmacHex("secret", body)).toBe(crypto.createHmac("sha256", "secret").update(body).digest("hex"));
  });

  it("подписанная ссылка на файл: работает час, подделка и чужой документ не проходят", () => {
    const now = Date.UTC(2026, 9, 19, 10, 0, 0);
    const url = new URL(signedFileUrl("s3cret", "doc1", now));
    const exp = url.searchParams.get("exp")!;
    const sig = url.searchParams.get("sig")!;
    expect(url.pathname).toBe("/api/public/visa-file/doc1");
    expect(verifyFileSignature("s3cret", "doc1", exp, sig, now + 59 * 60_000)).toBe(true);
    expect(verifyFileSignature("s3cret", "doc1", exp, sig, now + 61 * 60_000)).toBe(false);
    expect(verifyFileSignature("s3cret", "doc2", exp, sig, now)).toBe(false);
    expect(verifyFileSignature("other", "doc1", exp, sig, now)).toBe(false);
    expect(verifyFileSignature("s3cret", "doc1", String(Number(exp) + 3600), sig, now)).toBe(false);
  });

  it("повторы: 1, 2, 4… минут, не больше 6 часов", () => {
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(3)).toBe(4 * 60_000);
    expect(retryDelayMs(20)).toBe(6 * 3_600_000);
  });
});

describe("подпись событий для сайта v2", () => {
  it("HMAC от «время.id события.тело», время — unix-секунды", () => {
    const body = JSON.stringify({ externalId: "e1", type: "status", status: "IN_PROGRESS" });
    const h = eventHeaders("secret", "ev1", body, 1_764_100_000_123);
    expect(h["X-Event-Id"]).toBe("ev1");
    expect(h["X-Timestamp"]).toBe("1764100000");
    expect(h["X-Signature"]).toBe(`v2=${crypto.createHmac("sha256", "secret").update(`1764100000.ev1.${body}`).digest("hex")}`);
    // повтор позже — новое время и новая подпись
    expect(eventHeaders("secret", "ev1", body, 1_764_100_060_000)["X-Signature"]).not.toBe(h["X-Signature"]);
  });
});
