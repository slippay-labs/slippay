import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { bufToHex } from "@slippay/shared";
import {
  generateApiKey,
  hashApiKey,
  hashCandidates,
  verifyApiKey,
  prefixOf,
} from "../lib/apikey.ts";

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

Deno.test("hashCandidates returns the peppered hash and the one legacy SHA-256", async () => {
  const { plain } = generateApiKey();
  const [peppered, legacy] = await hashCandidates(plain);

  assertEquals(peppered, await hashApiKey(plain));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(plain));
  assertEquals(legacy, bufToHex(digest));
  assertNotEquals(peppered, legacy);
});

Deno.test("verifyApiKey accepts a legacy SHA-256 hash during rotation", async () => {
  const { plain } = generateApiKey();
  const [, legacy] = await hashCandidates(plain);
  assertEquals(await verifyApiKey(plain, legacy!), true);
});

Deno.test("prefixOf returns prefix plus 4 chars (12 chars total)", () => {
  const prefix = prefixOf("sk_live_abcdefgh1234567890");
  assertEquals(prefix, "sk_live_abcd");
  assertEquals(prefix.length, 12);
});
