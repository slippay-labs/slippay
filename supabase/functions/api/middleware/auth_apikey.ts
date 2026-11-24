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

  // Peppered hash is canonical; legacy is the read-side compat fallback
  // (see hashCandidates in lib/apikey.ts). Both still go through `.in()`
  // exact-match on the indexed column, so per-row time is constant.
  const { data, error } = await sb
    .from("merchants")
    .select("*")
    .in("api_key_hash", await hashCandidates(plain))
    .eq("active", true)
    .maybeSingle();
  if (error || !data) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  c.set("merchant", data);
  c.set("supabase", sb);
  await next();
}
