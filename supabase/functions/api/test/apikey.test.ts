import { assertEquals, assertNotEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Hono } from "hono";
import {
  generateApiKey,
  hashApiKey,
  legacyHashApiKey,
  verifyApiKey,
  isLegacyApiKeySunset,
  prefixOf,
  getLegacyHashMerchantCount,
} from "../lib/apikey.ts";
import { requireApiKey } from "../middleware/auth_apikey.ts";

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

Deno.test("verifyApiKey accepts peppered hash and respects sunset deadline", async () => {
  const plain = "sk_live_" + "1".repeat(64);
  const peppered = await hashApiKey(plain);
  const legacy = await legacyHashApiKey(plain);

  // Peppered hash always succeeds before and after sunset
  assertEquals(await verifyApiKey(plain, peppered, { now: Date.parse("2026-10-01T00:00:00Z") }), true);
  assertEquals(await verifyApiKey(plain, peppered, { now: Date.parse("2026-12-01T00:00:00Z") }), true);

  // Legacy SHA-256 succeeds before sunset
  assertEquals(await verifyApiKey(plain, legacy, { now: Date.parse("2026-10-01T00:00:00Z") }), true);

  // Legacy SHA-256 FAILS after sunset deadline (Issue #193)
  assertEquals(await verifyApiKey(plain, legacy, { now: Date.parse("2026-11-02T00:00:00Z") }), false);

  // Tampered key rejected
  assertEquals(await verifyApiKey(plain.replace(/.$/, "Z"), peppered), false);
});

Deno.test("isLegacyApiKeySunset checks timestamp against configured deadline", () => {
  // Before default sunset 2026-11-01T00:00:00Z
  assertEquals(isLegacyApiKeySunset(Date.parse("2026-10-31T23:59:59Z")), false);

  // Exactly at and after sunset
  assertEquals(isLegacyApiKeySunset(Date.parse("2026-11-01T00:00:00Z")), true);
  assertEquals(isLegacyApiKeySunset(Date.parse("2027-01-01T00:00:00Z")), true);
});

Deno.test("prefixOf returns prefix plus 4 chars (12 chars total)", () => {
  const prefix = prefixOf("sk_live_abcdefgh1234567890");
  assertEquals(prefix, "sk_live_abcd");
  assertEquals(prefix.length, 12);
});

Deno.test("getLegacyHashMerchantCount queries merchants with legacy_sha256 scheme", async () => {
  let queriedScheme: unknown = null;
  const mockSb = {
    from: (table: string) => ({
      select: (_cols: string, _opts?: unknown) => ({
        eq: (col1: string, val1: unknown) => ({
          eq: (_col2: string, _val2: unknown) => {
            if (col1 === "api_key_scheme") queriedScheme = val1;
            return Promise.resolve({ count: 7, error: null });
          },
        }),
      }),
    }),
  };

  const count = await getLegacyHashMerchantCount(mockSb as any);
  assertEquals(count, 7);
  assertEquals(queriedScheme, "legacy_sha256");
});

Deno.test("requireApiKey rejects sunset legacy keys with api_key_legacy_expired", async () => {
  // Force sunset deadline to the past
  Deno.env.set("LEGACY_API_KEY_SUNSET_DATE", "2026-01-01T00:00:00Z");

  const plain = "sk_live_" + "9".repeat(64);
  const legacyHash = await legacyHashApiKey(plain);

  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("supabase", {
      from: () => ({
        select: () => ({
          eq: (_col: string, val: unknown) => ({
            eq: () => ({
              maybeSingle: async () => {
                if (val === legacyHash) {
                  return { data: { id: "m_legacy", api_key_hash: legacyHash }, error: null };
                }
                return { data: null, error: null };
              },
            }),
          }),
          in: (_col: string, vals: unknown[]) => ({
            eq: () => ({
              maybeSingle: async () => {
                if (Array.isArray(vals) && vals.includes(legacyHash)) {
                  return { data: { id: "m_legacy", api_key_hash: legacyHash }, error: null };
                }
                return { data: null, error: null };
              },
            }),
          }),
        }),
        update: () => ({
          eq: () => Promise.resolve({ error: null }),
        }),
      }),
    });
    await next();
  });
  app.get("/test-auth", requireApiKey, (c) => c.json({ ok: true }));

  const res = await app.request("/test-auth", {
    headers: { authorization: `Bearer ${plain}` },
  });

  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, "api_key_legacy_expired");
  assert(body.message.includes("sunset"));

  Deno.env.delete("LEGACY_API_KEY_SUNSET_DATE");
});

Deno.test("requireApiKey accepts legacy key before sunset and warns with x-api-key-warning header", async () => {
  Deno.env.set("LEGACY_API_KEY_SUNSET_DATE", "2030-01-01T00:00:00Z");

  const plain = "sk_live_" + "8".repeat(64);
  const legacyHash = await legacyHashApiKey(plain);

  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("supabase", {
      from: () => ({
        select: () => ({
          in: (_col: string, vals: unknown[]) => ({
            eq: () => ({
              maybeSingle: async () => {
                if (Array.isArray(vals) && vals.includes(legacyHash)) {
                  return { data: { id: "m_legacy", api_key_hash: legacyHash }, error: null };
                }
                return { data: null, error: null };
              },
            }),
          }),
        }),
        update: () => ({
          eq: () => Promise.resolve({ error: null }),
        }),
      }),
    });
    await next();
  });
  app.get("/test-auth", requireApiKey, (c) => c.json({ ok: true }));

  const res = await app.request("/test-auth", {
    headers: { authorization: `Bearer ${plain}` },
  });

  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.ok, true);
  assert(res.headers.get("x-api-key-warning")?.includes("legacy-hash-sunset"));

  Deno.env.delete("LEGACY_API_KEY_SUNSET_DATE");
});

