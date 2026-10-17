import { describe, it, expect, beforeEach } from "vitest";
import {
  signCheckoutTokenWithSecret,
  verifyCheckoutTokenWithSecret,
  _resetCheckoutTokenKeyCacheForTest,
  DEFAULT_CHECKOUT_TOKEN_PURPOSE,
  CHECKOUT_TOKEN_VERSION,
} from "../src/checkout-token.ts";
import { b64url, b64urlDecode } from "../src/encoding.ts";

const TEST_SECRET = "supersecretkeyformanagingcheckouttokens123456789";
const ALT_SECRET = "anotherdifferentsecretkeyforunit-testing-tokens-987654";

describe("Checkout Token Primitive (Issue #189 & Issue #214)", () => {
  beforeEach(() => {
    _resetCheckoutTokenKeyCacheForTest();
  });

  it("mints an expiring, purpose-bound token with correct structure", async () => {
    const orderId = "order_abc_123";
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 1800; // 30 minutes

    const token = await signCheckoutTokenWithSecret(TEST_SECRET, orderId, exp);
    expect(token).toBeDefined();

    const parts = token.split(".");
    expect(parts.length).toBe(4);
    expect(parts[0]).toBe(CHECKOUT_TOKEN_VERSION);
    expect(parts[1]).toBe(DEFAULT_CHECKOUT_TOKEN_PURPOSE);
    expect(parts[2]).toBe(String(exp));

    // Signature must be valid base64url of 32 bytes (HMAC-SHA256)
    const sigBytes = b64urlDecode(parts[3]!);
    expect(sigBytes.length).toBe(32);
    expect(b64url(sigBytes)).toBe(parts[3]);
  });

  it("accepts a valid token within expiration window", async () => {
    const orderId = "order_valid_1";
    const now = 1700000000;
    const exp = now + 600;

    const token = await signCheckoutTokenWithSecret(TEST_SECRET, orderId, exp);
    const valid = await verifyCheckoutTokenWithSecret(TEST_SECRET, orderId, token, {
      nowUnix: now + 300,
    });
    expect(valid).toBe(true);
  });

  describe("Table-Driven Security & Tampering Protections (Issue #214)", () => {
    const orderId = "order_secure_target";
    const now = 1700000000;
    const exp = now + 1800;

    it("verifies expected valid baseline token", async () => {
      const token = await signCheckoutTokenWithSecret(TEST_SECRET, orderId, exp);
      const res = await verifyCheckoutTokenWithSecret(TEST_SECRET, orderId, token, {
        nowUnix: now,
      });
      expect(res).toBe(true);
    });

    it("rejects subject substitution (token for order A used for order B)", async () => {
      const tokenA = await signCheckoutTokenWithSecret(TEST_SECRET, "order_AAA", exp);
      const res = await verifyCheckoutTokenWithSecret(TEST_SECRET, "order_BBB", tokenA, {
        nowUnix: now,
      });
      expect(res).toBe(false);
    });

    it("rejects purpose mismatch (checkout_read token used for order_write)", async () => {
      const token = await signCheckoutTokenWithSecret(TEST_SECRET, orderId, {
        expiresAt: exp,
        purpose: "checkout_read",
      });

      // Default verify expects checkout_read -> true
      expect(await verifyCheckoutTokenWithSecret(TEST_SECRET, orderId, token, { nowUnix: now })).toBe(true);

      // Verifying for order_write -> false
      const res = await verifyCheckoutTokenWithSecret(TEST_SECRET, orderId, token, {
        expectedPurpose: "order_write",
        nowUnix: now,
      });
      expect(res).toBe(false);
    });

    it("rejects purpose tampering in serialized token", async () => {
      const token = await signCheckoutTokenWithSecret(TEST_SECRET, orderId, {
        expiresAt: exp,
        purpose: "checkout_read",
      });

      // Attacker changes purpose part in token to admin_override
      const parts = token.split(".");
      parts[1] = "admin_override";
      const tampered = parts.join(".");

      const res = await verifyCheckoutTokenWithSecret(TEST_SECRET, orderId, tampered, {
        expectedPurpose: "admin_override",
        nowUnix: now,
      });
      expect(res).toBe(false);
    });

    it("rejects single-character mutation in signature (tampering)", async () => {
      const token = await signCheckoutTokenWithSecret(TEST_SECRET, orderId, exp);
      const parts = token.split(".");
      const sig = parts[3]!;
      const mutatedSig = sig.slice(0, -1) + (sig.endsWith("a") ? "b" : "a");
      parts[3] = mutatedSig;
      const tampered = parts.join(".");

      const res = await verifyCheckoutTokenWithSecret(TEST_SECRET, orderId, tampered, {
        nowUnix: now,
      });
      expect(res).toBe(false);
    });

    it("rejects timestamp tampering (attempting to extend expiry)", async () => {
      const token = await signCheckoutTokenWithSecret(TEST_SECRET, orderId, exp);
      const parts = token.split(".");
      // Attacker tries to increase expiry from exp to exp + 100000
      parts[2] = String(exp + 100000);
      const tampered = parts.join(".");

      const res = await verifyCheckoutTokenWithSecret(TEST_SECRET, orderId, tampered, {
        nowUnix: now,
      });
      expect(res).toBe(false);
    });

    it("rejects secret substitution (token signed by another party)", async () => {
      const forgedToken = await signCheckoutTokenWithSecret(ALT_SECRET, orderId, exp);
      const res = await verifyCheckoutTokenWithSecret(TEST_SECRET, orderId, forgedToken, {
        nowUnix: now,
      });
      expect(res).toBe(false);
    });

    it("handles boundary expiry conditions precisely (1s inside vs 1s outside)", async () => {
      const token = await signCheckoutTokenWithSecret(TEST_SECRET, orderId, exp);

      // Exactly 1 second inside window (exp - 1) -> accepted
      expect(
        await verifyCheckoutTokenWithSecret(TEST_SECRET, orderId, token, {
          nowUnix: exp - 1,
        }),
      ).toBe(true);

      // Exactly at expiry second -> accepted
      expect(
        await verifyCheckoutTokenWithSecret(TEST_SECRET, orderId, token, {
          nowUnix: exp,
        }),
      ).toBe(true);

      // Exactly 1 second outside window (exp + 1) -> rejected
      expect(
        await verifyCheckoutTokenWithSecret(TEST_SECRET, orderId, token, {
          nowUnix: exp + 1,
        }),
      ).toBe(false);

      // 100 seconds outside window -> rejected
      expect(
        await verifyCheckoutTokenWithSecret(TEST_SECRET, orderId, token, {
          nowUnix: exp + 100,
        }),
      ).toBe(false);
    });

    it("gracefully rejects non-base64, truncated, or wrong-length signatures without throwing", async () => {
      const testCases = [
        "",                                    // empty
        "short",                               // too short
        "v1.not.enough.parts.extra",           // too many parts
        "v2.checkout_read.1700000000.abcd",    // wrong version
        "v1.checkout_read.notanumber.abcd",    // invalid exp number
        "v1.checkout_read.-5.abcd",            // negative exp
        "v1.checkout_read.1700000000.???invalid_base64!!!", // invalid base64 chars
        `v1.checkout_read.1700000000.${b64url(new Uint8Array(16))}`, // wrong sig byte length (16 instead of 32)
        `v1.checkout_read.1700000000.${b64url(new Uint8Array(64))}`, // wrong sig byte length (64 instead of 32)
        "null",
        "undefined",
      ];

      for (const tc of testCases) {
        const res = await verifyCheckoutTokenWithSecret(TEST_SECRET, orderId, tc, {
          nowUnix: now,
        });
        expect(res).toBe(false);
      }
    });

    it("rejects empty or missing orderId", async () => {
      const token = await signCheckoutTokenWithSecret(TEST_SECRET, orderId, exp);
      expect(await verifyCheckoutTokenWithSecret(TEST_SECRET, "", token)).toBe(false);
    });
  });
});
