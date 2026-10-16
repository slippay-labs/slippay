import { describe, it, expect, beforeEach } from "vitest";
import {
  signWebhook,
  verifyWebhook,
  __resetReplayCache,
  __setReplayCacheNow,
  DEFAULT_TOLERANCE_S,
} from "../src/crypto.js";

describe("signWebhook", () => {
  it("returns t=<unix>,v1=<hmac> format", async () => {
    const sig = await signWebhook("secret", '{"a":1}', 1700000000);
    expect(sig).toMatch(/^t=1700000000,v1=[a-f0-9]{64}$/);
  });
});

describe("verifyWebhook", () => {
  beforeEach(() => {
    __resetReplayCache();
  });

  it("accepts a fresh signature within tolerance window", async () => {
    const now = Math.floor(Date.now() / 1000);
    const sig = await signWebhook("secret", "body", now);
    expect(await verifyWebhook("secret", "body", sig, now)).toBe(true);
  });

  it("rejects expired signature", async () => {
    const now = Math.floor(Date.now() / 1000);
    const old = now - (DEFAULT_TOLERANCE_S + 60);
    const sig = await signWebhook("secret", "body", old);
    expect(await verifyWebhook("secret", "body", sig, now)).toBe(false);
  });

  it("rejects forged signature", async () => {
    const sig = "t=1,v1=" + "0".repeat(64);
    expect(await verifyWebhook("secret", "body", sig, 1)).toBe(false);
  });

  it("rejects the same signed request submitted twice within the tolerance window", async () => {
    const now = Math.floor(Date.now() / 1000);
    const sig = await signWebhook("secret", "body", now);
    expect(await verifyWebhook("secret", "body", sig, now)).toBe(true);
    expect(await verifyWebhook("secret", "body", sig, now)).toBe(false);
  });

  it("rejects a body replayed under a different delivery id", async () => {
    const now = Math.floor(Date.now() / 1000);
    const sig = await signWebhook("secret", "body", now);
    expect(await verifyWebhook("secret", "body", sig, now, "delivery-1")).toBe(true);
    expect(await verifyWebhook("secret", "body", sig, now, "delivery-2")).toBe(false);
  });

  it("allows the same signature after the tolerance window has passed", async () => {
    const now = Math.floor(Date.now() / 1000);
    const sig = await signWebhook("secret", "body", now);
    expect(await verifyWebhook("secret", "body", sig, now)).toBe(true);
    __setReplayCacheNow(now + DEFAULT_TOLERANCE_S + 1);
    expect(await verifyWebhook("secret", "body", sig, now)).toBe(false);
  });

  it("honours a custom tolerance window", async () => {
    const now = Math.floor(Date.now() / 1000);
    const sig = await signWebhook("secret", "body", now - 60);
    expect(await verifyWebhook("secret", "body", sig, now, "d", 30)).toBe(false);
    expect(await verifyWebhook("secret", "body", sig, now, "d", 120)).toBe(true);
  });
});
