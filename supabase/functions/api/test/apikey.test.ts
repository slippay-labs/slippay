import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { generateApiKey, hashApiKey, verifyApiKey, prefixOf } from "../lib/apikey.ts";

Deno.test("generateApiKey returns sk_live_ + 64 hex", () => {
  const { plain } = generateApiKey();
  if (!plain.startsWith("sk_live_")) throw new Error("missing prefix");
  assertEquals(plain.length, "sk_live_".length + 64);
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

Deno.test("generateApiKey and prefixOf support sk_test_ keys", () => {
  const { plain } = generateApiKey("sk_test_");
  assertEquals(plain.startsWith("sk_test_"), true);
  assertEquals(plain.length, "sk_test_".length + 64);

  const prefix = prefixOf("sk_test_xyz1234567890");
  assertEquals(prefix, "sk_test_xyz1");
  assertEquals(prefix.length, 12);
});

Deno.test("extractBearerApiKey correctly extracts valid prefixes and rejects unknown", async () => {
  const { extractBearerApiKey, hasApiKeyPrefix } = await import("@slippay/shared");

  assertEquals(hasApiKeyPrefix("sk_live_abc"), true);
  assertEquals(hasApiKeyPrefix("sk_test_abc"), true);
  assertEquals(hasApiKeyPrefix("sk_fake_abc"), false);
  assertEquals(hasApiKeyPrefix("Bearer sk_live_abc"), false);

  assertEquals(extractBearerApiKey("Bearer sk_live_123456"), "sk_live_123456");
  assertEquals(extractBearerApiKey("Bearer sk_test_123456"), "sk_test_123456");
  assertEquals(extractBearerApiKey("Bearer sk_unknown_123"), null);
  assertEquals(extractBearerApiKey("Bearer jwt.token.here"), null);
  assertEquals(extractBearerApiKey("Basic sk_live_123"), null);
  assertEquals(extractBearerApiKey(null), null);
  assertEquals(extractBearerApiKey(undefined), null);
});

