import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { generateApiKey, hashApiKey, verifyApiKey, prefixOf } from "../lib/apikey.ts";
import { isApiKey, extractBearerApiKey, API_KEY_PREFIX_TEST } from "@slippay/shared";

Deno.env.set("API_KEY_PEPPER", "test-pepper-at-least-32-characters-long");

Deno.test("generateApiKey returns sk_live_ + 64 hex by default, and supports sk_test_", () => {
  const { plain: liveKey } = generateApiKey();
  if (!liveKey.startsWith("sk_live_")) throw new Error("missing sk_live_ prefix");
  assertEquals(liveKey.length, "sk_live_".length + 64);

  const { plain: testKey } = generateApiKey(API_KEY_PREFIX_TEST);
  if (!testKey.startsWith("sk_test_")) throw new Error("missing sk_test_ prefix");
  assertEquals(testKey.length, "sk_test_".length + 64);
});

Deno.test("extractBearerApiKey accepts sk_live_ and sk_test_ prefixes", () => {
  assertEquals(extractBearerApiKey("Bearer sk_live_1234567890abcdef"), "sk_live_1234567890abcdef");
  assertEquals(extractBearerApiKey("Bearer sk_test_1234567890abcdef"), "sk_test_1234567890abcdef");
  assertEquals(extractBearerApiKey("Bearer sk_fake_1234567890abcdef"), null);
  assertEquals(extractBearerApiKey("Bearer random_token"), null);
  assertEquals(extractBearerApiKey("Basic sk_live_123"), null);
  assertEquals(extractBearerApiKey(null), null);
  assertEquals(extractBearerApiKey(undefined), null);
});

Deno.test("isApiKey validates recognized key prefixes", () => {
  assertEquals(isApiKey("sk_live_abc"), true);
  assertEquals(isApiKey("sk_test_abc"), true);
  assertEquals(isApiKey("sk_other_abc"), false);
  assertEquals(isApiKey("jwt.token.here"), false);
});

Deno.test("hashApiKey is deterministic and != plain", async () => {
  const k = "sk_live_" + "a".repeat(64);
  const h1 = await hashApiKey(k);
  const h2 = await hashApiKey(k);
  assertEquals(h1, h2);
  assertNotEquals(h1, k);
});

Deno.test("verifyApiKey accepts correct, rejects wrong (constant-time)", async () => {
  const { plain, hash } = await (async () => {
    const k = generateApiKey();
    return { plain: k.plain, hash: await hashApiKey(k.plain) };
  })();
  assertEquals(await verifyApiKey(plain, hash), true);
  assertEquals(await verifyApiKey(plain.replace(/.$/, "Z"), hash), false);
});

Deno.test("prefixOf returns prefix plus 4 chars (12 chars total)", () => {
  const prefix = prefixOf("sk_live_abcdefgh1234567890");
  assertEquals(prefix, "sk_live_abcd");
  assertEquals(prefix.length, 12);
});
