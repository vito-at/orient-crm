import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, consumeTotpStep, otpauthUrl, totpAt, verifyTotp } from "@/lib/totp";

// RFC 6238, приложение B: секрет «12345678901234567890» (ASCII), SHA-1, 8 цифр → последние 6 цифр
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("TOTP", () => {
  it("base32 туда и обратно", () => {
    expect(RFC_SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode(RFC_SECRET).toString()).toBe("12345678901234567890");
  });
  it("коды совпадают с RFC 6238", () => {
    // T = 59 с → шаг 1 → 94287082; T = 1111111109 → 07081804; T = 2000000000 → 69279037
    expect(totpAt(RFC_SECRET, 1)).toBe("287082");
    expect(totpAt(RFC_SECRET, Math.floor(1111111109 / 30))).toBe("081804");
    expect(totpAt(RFC_SECRET, Math.floor(2000000000 / 30))).toBe("279037");
  });
  it("принимает соседний интервал и отклоняет чужой код", () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30_000);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step), now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 3), now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "12a456", now)).toBeNull();
  });
  it("один код нельзя использовать дважды", () => {
    expect(consumeTotpStep("u1", 100)).toBe(true);
    expect(consumeTotpStep("u1", 100)).toBe(false);
    expect(consumeTotpStep("u1", 101)).toBe(true);
  });
  it("ссылка для приложения", () => {
    expect(otpauthUrl("ABC", "vika")).toBe("otpauth://totp/Orient%20Travel%20CRM%3Avika?secret=ABC&issuer=Orient%20Travel%20CRM&algorithm=SHA1&digits=6&period=30");
  });
});
