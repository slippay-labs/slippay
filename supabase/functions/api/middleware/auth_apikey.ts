import type { Context, Next } from "hono";
import { serviceClient } from "../lib/supabase.ts";
import { hashApiKey, legacyHashApiKey, isLegacyApiKeySunset, getLegacyApiKeySunsetDate } from "../lib/apikey.ts";

export async function requireApiKey(c: Context, next: Next) {
  if (c.get("merchant")) {
    await next();
    return;
  }
  const auth = c.req.header("authorization");
  if (!auth?.startsWith("Bearer sk_live_")) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  const plain = auth.slice("Bearer ".length);
  const sb = (c.get("supabase") as ReturnType<typeof serviceClient>) ?? serviceClient();

  const peppered = await hashApiKey(plain);
  const isSunset = isLegacyApiKeySunset();
  const sunsetDate = getLegacyApiKeySunsetDate();

  if (isSunset) {
    // Post-sunset: strictly require canonical peppered HMAC hash (Issue #193)
    const { data, error } = await sb
      .from("merchants")
      .select("*")
      .eq("api_key_hash", peppered)
      .eq("active", true)
      .maybeSingle();

    if (error || !data) {
      // Diagnostic check: did caller attempt authentication with a sunset legacy key?
      const legacy = await legacyHashApiKey(plain);
      const { data: legacyRow } = await sb
        .from("merchants")
        .select("id")
        .eq("api_key_hash", legacy)
        .eq("active", true)
        .maybeSingle();

      if (legacyRow) {
        return c.json(
          {
            error: "api_key_legacy_expired",
            message: `Legacy unpeppered API key hash scheme has sunset on ${sunsetDate}. Please rotate your API key via /me/rotate-key.`,
            sunset_date: sunsetDate,
          },
          401,
        );
      }
      return c.json({ error: "unauthenticated" }, 401);
    }

    c.set("merchant", data);
    c.set("supabase", sb);
    await next();
    return;
  }

  // Pre-sunset: accept legacy hash during migration window, but opportunistically upgrade
  const legacy = await legacyHashApiKey(plain);
  const { data, error } = await sb
    .from("merchants")
    .select("*")
    .in("api_key_hash", [peppered, legacy])
    .eq("active", true)
    .maybeSingle();

  if (error || !data) {
    return c.json({ error: "unauthenticated" }, 401);
  }

  // If authenticated via legacy hash, warn and asynchronously upgrade row to peppered HMAC
  if (data.api_key_hash === legacy) {
    console.warn(
      `[SECURITY WARN] Merchant ${data.id} authenticated with legacy SHA-256 key. Upgrading hash and requiring rotation before ${sunsetDate}.`,
    );
    c.header("x-api-key-warning", `legacy-hash-sunset-at-${sunsetDate}`);

    // Self-healing: persist upgraded peppered hash
    sb.from("merchants")
      .update({ api_key_hash: peppered, api_key_scheme: "peppered_hmac" })
      .eq("id", data.id)
      .then(({ error: updateErr }: { error: unknown }) => {
        if (updateErr) console.error("[ERROR] Failed to auto-upgrade legacy API key hash:", updateErr);
      });
  }

  c.set("merchant", data);
  c.set("supabase", sb);
  await next();
}
