import { describe, it, expect } from "vitest";
import { redactUrlToken } from "../src/redact.ts";

describe("redactUrlToken", () => {
  it("redacts query parameter t in full URLs", () => {
    const original = "https://app.slippay.cc/checkout/order-123?t=abcdef1234567890&embed=1";
    const redacted = redactUrlToken(original);
    expect(redacted).toBe("https://app.slippay.cc/checkout/order-123?t=[REDACTED]&embed=1");
  });

  it("redacts query parameter t in relative path URLs", () => {
    const original = "/v1/orders/ord-999?t=secrettokenvalue";
    const redacted = redactUrlToken(original);
    expect(redacted).toBe("/v1/orders/ord-999?t=[REDACTED]");
  });

  it("leaves URLs without t untouched", () => {
    const url = "https://app.slippay.cc/checkout/order-123?status=pending";
    expect(redactUrlToken(url)).toBe(url);
  });

  it("handles empty and arbitrary strings gracefully", () => {
    expect(redactUrlToken("")).toBe("");
    expect(redactUrlToken("not a valid url but has ?t=abc&foo=bar")).toBe("not a valid url but has ?t=[REDACTED]&foo=bar");
  });
});
