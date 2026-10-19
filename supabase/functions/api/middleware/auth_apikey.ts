import type { Context, Next } from "hono";
import { serviceClient } from "../lib/supabase.ts";
import { hashCandidates } from "../lib/apikey.ts";

export async function requireApiKey(c: Context, next: Next) {
  const auth = c.req.header("authorization");
  if (!auth?.startsWith("Bearer sk_live_")) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  const plain = auth.slice("Bearer ".length);
  const sb = serviceClient();

  // Look up every candidate hash in one exact-match query on the indexed
  // column. `hashCandidates` owns the legacy branch so the rotation can be
  // completed by editing one function.
  const candidates = await hashCandidates(plain);
  const { data, error } = await sb
    .from("merchants")
    .select("*")
    .in("api_key_hash", candidates)
    .eq("active", true)
    .maybeSingle();
  if (error || !data) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  c.set("merchant", data);
  c.set("supabase", sb);
  await next();
}
