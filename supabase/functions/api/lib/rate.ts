import { MIN_BRL_PER_USDC, MAX_BRL_PER_USDC } from "@slippay/shared";

let cache: { value: number; expires: number } | null = null;
const TTL_MS = 60_000;

export class RateOutOfRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateOutOfRangeError";
  }
}

export function _resetCacheForTest() {
  cache = null;
}

export function isProduction(): boolean {
  const env = Deno.env.get("ENVIRONMENT") ?? Deno.env.get("DENO_ENV") ?? Deno.env.get("NODE_ENV");
  return env?.toLowerCase() === "production";
}

export function isRateOverrideAllowed(): boolean {
  if (isProduction()) {
    return false;
  }
  const allow = Deno.env.get("ALLOW_RATE_OVERRIDE");
  if (allow === "false" || allow === "0") {
    return false;
  }
  return true;
}

export type RateSource = "override" | "live" | "cache";

export interface RateResult {
  rate: number;
  source: RateSource;
}

export async function getBrlPerUsdcWithSource(): Promise<RateResult> {
  const override = Deno.env.get("RATE_BRL_USDC");

  if (override !== undefined && override !== null && override !== "") {
    if (isProduction()) {
      console.warn("[SECURITY ALERT] Ignoring RATE_BRL_USDC override in production environment");
    } else if (!isRateOverrideAllowed()) {
      console.warn("[WARN] RATE_BRL_USDC override ignored because ALLOW_RATE_OVERRIDE is disabled");
    } else {
      const v = parseFloat(override);
      if (isNaN(v) || v < MIN_BRL_PER_USDC || v > MAX_BRL_PER_USDC) {
        throw new RateOutOfRangeError(
          `RATE_BRL_USDC override ${override} is outside allowed sane band [${MIN_BRL_PER_USDC}, ${MAX_BRL_PER_USDC}]`,
        );
      }
      console.warn(`[WARN] Active RATE_BRL_USDC override applied: ${v} BRL/USDC`);
      return { rate: v, source: "override" };
    }
  }

  if (cache && cache.expires > Date.now()) {
    return { rate: cache.value, source: "cache" };
  }

  const value = await fetchCoinGecko();
  cache = { value, expires: Date.now() + TTL_MS };
  return { rate: value, source: "live" };
}

export async function getBrlPerUsdc(): Promise<number> {
  const res = await getBrlPerUsdcWithSource();
  return res.rate;
}

async function fetchCoinGecko(): Promise<number> {
  const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=brl");
  if (!r.ok) throw new Error(`coingecko ${r.status}`);
  const j = await r.json() as { "usd-coin"?: { brl?: number } };
  const v = j["usd-coin"]?.brl;
  if (typeof v !== "number" || v <= 0) throw new Error("bad rate response");
  return v;
}
