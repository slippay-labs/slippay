import type { SupabaseClient } from "supabase";

export const RATE_TTL_MS = 60_000;

export interface FxRateRecord {
  pair: string;
  rate: number;
  source: string;
  observed_at: string;
}

export interface SharedRateStore {
  get(pair: string): Promise<FxRateRecord | null>;
  set(record: FxRateRecord): Promise<void>;
}

export interface RateObservation {
  rate: number;
  source: string;
  observedAt: string;
}

export class DatabaseRateStore implements SharedRateStore {
  constructor(private sb: SupabaseClient) {}

  async get(pair: string): Promise<FxRateRecord | null> {
    try {
      const { data, error } = await this.sb
        .from("fx_rates")
        .select("pair, rate, source, observed_at")
        .eq("pair", pair)
        .maybeSingle();
      if (error || !data) return null;
      return {
        pair: data.pair,
        rate: Number(data.rate),
        source: data.source,
        observed_at: data.observed_at,
      };
    } catch {
      return null;
    }
  }

  async set(record: FxRateRecord): Promise<void> {
    try {
      await this.sb.from("fx_rates").upsert({
        pair: record.pair,
        rate: record.rate,
        source: record.source,
        observed_at: record.observed_at,
        updated_at: new Date().toISOString(),
      }, { onConflict: "pair" });
    } catch {
      // Non-blocking upsert failure
    }
  }
}

export class MemorySharedRateStore implements SharedRateStore {
  private store = new Map<string, FxRateRecord>();

  async get(pair: string): Promise<FxRateRecord | null> {
    return this.store.get(pair) ?? null;
  }

  async set(record: FxRateRecord): Promise<void> {
    this.store.set(record.pair, { ...record });
  }

  clear() {
    this.store.clear();
  }
}

export const defaultSharedStore = new MemorySharedRateStore();

export function _resetCacheForTest() {
  defaultSharedStore.clear();
}

export async function fetchCoinGecko(): Promise<number> {
  const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=brl");
  if (!r.ok) throw new Error(`coingecko ${r.status}`);
  const j = await r.json() as { "usd-coin"?: { brl?: number } };
  const v = j["usd-coin"]?.brl;
  if (typeof v !== "number" || v <= 0) throw new Error("bad rate response");
  return v;
}

const inFlight = new Map<string, Promise<RateObservation>>();

export async function getBrlPerUsdcObservation(
  sb?: SupabaseClient,
  customStore?: SharedRateStore,
  fetchFn: () => Promise<number> = fetchCoinGecko,
): Promise<RateObservation> {
  // Allow a fixed override in tests/CI to avoid hitting CoinGecko.
  const override = Deno.env.get("RATE_BRL_USDC");
  if (override) {
    const v = parseFloat(override);
    if (v > 0) {
      return {
        rate: v,
        source: "env_override",
        observedAt: new Date().toISOString(),
      };
    }
  }

  const store = customStore ?? (sb ? new DatabaseRateStore(sb) : defaultSharedStore);
  const pair = "BRL_USDC";

  // Check shared store outside the isolate
  const cached = await store.get(pair);
  if (cached) {
    const observedMs = new Date(cached.observed_at).getTime();
    if (Date.now() - observedMs < RATE_TTL_MS && cached.rate > 0) {
      return {
        rate: cached.rate,
        source: cached.source || "shared_cache",
        observedAt: cached.observed_at,
      };
    }
  }

  // Deduplicate concurrent upstream requests across simultaneous cold calls
  if (inFlight.has(pair)) {
    return await inFlight.get(pair)!;
  }

  const promise = (async () => {
    try {
      const rate = await fetchFn();
      const observedAt = new Date().toISOString();
      const source = "coingecko";

      const record: FxRateRecord = {
        pair,
        rate,
        source,
        observed_at: observedAt,
      };
      await store.set(record);

      return { rate, source, observedAt };
    } finally {
      inFlight.delete(pair);
    }
  })();

  inFlight.set(pair, promise);
  return await promise;
}

export async function getBrlPerUsdc(
  sb?: SupabaseClient,
  customStore?: SharedRateStore,
): Promise<number> {
  const obs = await getBrlPerUsdcObservation(sb, customStore);
  return obs.rate;
}

export async function refreshBrlRate(
  store: SharedRateStore,
  fetchFn: () => Promise<number> = fetchCoinGecko,
): Promise<FxRateRecord> {
  const rate = await fetchFn();
  const observedAt = new Date().toISOString();
  const record: FxRateRecord = {
    pair: "BRL_USDC",
    rate,
    source: "coingecko",
    observed_at: observedAt,
  };
  await store.set(record);
  return record;
}

