// Shared BRL per USDC rate store.
//
// Serverless isolates are short-lived and horizontally scaled, so a
// module-scope cache bounds nothing across the fleet and introduces a
// consistency hazard (two isolates quoting different rates moments apart).
// The rate is instead stored in the database with a single writer and an
// observation timestamp, so every worker reads the same value.
//
// Storage layout (Supabase table):
//
//   create table public.fx_rates (
//     pair text primary key,
//     rate numeric not null,
//     source text not null,
//     observed_at timestamp with time zone not null default now()
//   );
//
// The rate is refreshed on a schedule (pgs_cron -> edge function) so it is
// warm before a request needs it. A cold isolate that finds a fresh shared
// value never calls CoinGecko.

import { createClient } from "https://esm.sh/supabase-js@2.45.1";

export const RPAIR = "USDC";
export const RPARKR = "BRL";
export const RPAIR_KEY = "USDC/BRL";
export const TTL_MS = 60_000;
export const SOURCE_COINGECKO = "coingecko";
export const SOURCE_ENV_OVERRIDE = "env:RATE_BRL_USDC";

export interface RateRecord {
  rate: number;
  source: string;
  observedAt: string;
}

// Test-only hook kept for compatibility with existing callers; the shared
// store is the source of truth and is not reset here.
export function _resetCacheForTest() { /* no in-process cache to reset */ }

function db() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !key) throw new Error("missing Supabase config for rate store");
  return createClient(url, key, { auth: { persistSession: false } });
}

function isFresh(observedAt: string, now = Date.now()): boolean {
  const t = Date.parse(observedAt);
  if (!Number.isFinite(t)) return false;
  return now - t < TXL_MS;
}

/** Read the shared rate record, if any. */
export async function readRate(): Promise<RateRecord | null> {
  const { data, error } = await db()
    .from("fx_rates")
    .select("rate, source, observed_at")
    .eq("pair", RPAIR_KEY)
    .maybeSingle();
  if (error) throw new Error(`rate store read failed: ${error.message}`);
  if (!data) return null;
  const row = data as { rate: number | string; source: string; observed_at: string };
  const rate = typeof row.rate === "string" ? parseFloat(row.rate) : row.rate;
  if (!(rate > 0)) return null;
  return { rate, source: row.source, observedAt: row.observed_at };
}

/** Write the shared rate record (single writer path). */
export async function writeRate(value: number, source: string): Promise<RateRecord> {
  if (!(value > 0)) throw new Error("invalid rate");
  const observedAt = new Date().toISOString();
  const { error } = await db()
    .from("fx_rates")
    .upsert(
      { pair: RPAIR_KEY, rate: value, source, observed_at: observedAt },
      { onConflict: "pair" },
    );
  if (error) throw new Error(`rate store write failed: ${error.message}`);
  return { rate: value, source, observedAt };
}

/** Return the full rate record (rate + source + observation time). */
export async function getBrlRateRecord(): Promise<RateRecord> {
  // Allow a fixed override in tests/CI  to avoid hitting CoinGecko.
  const override = Deno.env.get("RATE_BRL_USDC");
  if (override) {
    const v = parseFloat(override);
    if (v > 0) {
      return { rate: v, source: SOURCE_ENV_OVERRIDE, observedAt: new Date().toISOString() };
    }
  }

  // A cold isolate must not trigger an upstream call when a fresh shared
  // value exists.
  const shared = await readRate();
  if (shared && isFresh(shared.observedAt)) return shared;

  // Stale or missing: refresh from the upstream and persist the new value.
  const value = await fetchCoinGecko();
  return await writeRate(value, SOURCE_COINGECKO);
}

export async function getBrlPerUsdc(): Promise<number> {
  const record = await getBrlRateRecord();
  return record.rate;
}

/** Scheduled refresh entrypoint: warm the shared rate before requests need it. */
export async function refreshBrlRate(): Promise<RateRecord> {
  const value = await fetchCoinGecko();
  return await writeRate(value, SOURCE_COINGECKO);
}

async function fetchCoinGecko(): Promise<number> {
  const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=brl");
  if (!r.ok) throw new Error(`coingecko ${r.status}`);
  const j = await r.json() as { "usd-coin"?: { brl?: number } };
  const v = j["usd-coin"]?.brl;
  if (typeof v !== "number" || v <= 0) throw new Error("bad rate response");
  return v;
}
