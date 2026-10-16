// FX quote engine — Pix (BRL) -> USDC. This is the real margin layer: SlipPay
// quotes the mid-market rate x (1 + spread) and keeps the difference. The spread
// fires on EVERY conversion (including users who only hold dollars), which is why
// it scales ~10x vs a per-transfer rail fee. Configurable via VITE_FX_SPREAD_BPS
// (default 190 = 1.90% — the price decided + shown on the landing; still ~3x
// cheaper than a bank's ~5% IOF+spread, while capturing healthy margin).
//
// HONEST STATE: this computes and records the SlipPay-quoted rate + captured
// margin. The margin is actually pocketed when BRL settles through a SlipPay-owned
// or rev-share anchor; while the conversion routes through a 3rd-party on-ramp,
// this is the pricing + measurement layer that makes the spread live the moment
// the anchor is connected.

import {
  DEFAULT_FX_SPREAD_BPS,
  MIN_FX_SPREAD_BPS,
  MAX_FX_SPREAD_BPS,
  resolveFxSpreadBps,
} from "@slippay/shared";

export const SPREAD_BPS = resolveFxSpreadBps(import.meta.env?.VITE_FX_SPREAD_BPS);

// Log active spread once at module startup (Acceptance criteria)
if (typeof console !== "undefined" && typeof console.info === "function") {
  console.info(`[SlipPay FX] Active spread configured: ${SPREAD_BPS} bps (${(SPREAD_BPS / 100).toFixed(2)}%)`);
}

const RATE_URL = "https://open.er-api.com/v6/latest/USD";
const FALLBACK_BRL_PER_USD = 5.4;
const DEFAULT_RATE_TIMEOUT_MS = 5000;

export const SPREAD_PCT = SPREAD_BPS / 100;

export type RateSource = "live" | "cache" | "fallback";

export interface RateResult {
  rate: number;
  stale: boolean;
  source: RateSource;
}

export interface Quote {
  brlIn: number;
  midRate: number;     // BRL per USD (mid-market)
  quotedRate: number;  // BRL per USD the user effectively pays (mid x (1+spread))
  spreadBps: number;
  usdcOut: number;     // USDC received at the SlipPay rate
  usdcAtMid: number;   // USDC at mid-market (for comparison)
  marginUsd: number;   // SlipPay's captured margin (USD)
  marginBrl: number;   // ...in BRL
  stale: boolean;      // live rate fetch failed -> fallback used
  source: RateSource;  // origin that produced the rate ("live" | "cache" | "fallback")
  ts: string;
}

export interface QuoteOptions {
  spreadBps?: number;
  allowStale?: boolean; // Must be true to quote when upstream live rate is unavailable (Issue #233)
}

export class StaleRateError extends Error {
  constructor(message = "Live FX rate unavailable. Quoting with a stale fallback requires explicit opt-in ({ allowStale: true }).") {
    super(message);
    this.name = "StaleRateError";
  }
}

let cache: { rate: number; at: number } | null = null;
let lastLiveRate: number | null = null;

export function _resetQuoteCache(): void {
  cache = null;
  lastLiveRate = null;
}

export async function midRateBRLperUSD(timeoutMs = DEFAULT_RATE_TIMEOUT_MS): Promise<RateResult> {
  if (cache && Date.now() - cache.at < 60_000) {
    return { rate: cache.rate, stale: false, source: "cache" };
  }

  try {
    const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined;

    const r = await fetch(RATE_URL, signal ? { signal } : undefined);

    // Assert r.ok: treat non-200/non-OK HTTP status as failure
    if (r.ok !== undefined && !r.ok) {
      throw new Error(`Upstream rate response not OK: status ${r.status}`);
    }

    // Assert content-type is JSON before parsing
    const contentType = r.headers?.get?.("content-type");
    if (contentType && !contentType.toLowerCase().includes("application/json")) {
      throw new Error(`Upstream rate response content-type is not JSON: ${contentType}`);
    }

    const j = await r.json();
    const rate = Number(j?.rates?.BRL);
    if (Number.isFinite(rate) && rate > 0) {
      cache = { rate, at: Date.now() };
      lastLiveRate = rate;
      return { rate, stale: false, source: "live" };
    }
  } catch {
    /* fall through to fallback */
  }

  // The fallback cannot produce a price more favourable than the last live rate (Issue #233)
  // In BRL/USD (buying USDC with BRL), a lower rate is more favourable to the buyer.
  // Therefore, the conservative fallback must be at least as high as lastLiveRate.
  const fallbackRate = lastLiveRate !== null
    ? Math.max(lastLiveRate, FALLBACK_BRL_PER_USD)
    : FALLBACK_BRL_PER_USD;

  return { rate: fallbackRate, stale: true, source: "fallback" };
}

export async function quoteBRLtoUSDC(
  brlIn: number,
  optionsOrSpread: QuoteOptions | number = SPREAD_BPS
): Promise<Quote> {
  const options: QuoteOptions = typeof optionsOrSpread === "number"
    ? { spreadBps: optionsOrSpread, allowStale: false }
    : {
        spreadBps: optionsOrSpread.spreadBps ?? SPREAD_BPS,
        allowStale: optionsOrSpread.allowStale ?? false,
      };

  const { rate: midRate, stale, source } = await midRateBRLperUSD();

  // Acceptance criteria: A caller cannot obtain a usable quote with stale: true unless it explicitly opts in.
  if (stale && !options.allowStale) {
    throw new StaleRateError(
      `Live FX rate unavailable. Quoting with a stale fallback rate (${midRate}) requires explicit opt-in ({ allowStale: true }).`
    );
  }

  const effectiveSpreadBps = options.spreadBps ?? SPREAD_BPS;
  const quotedRate = midRate * (1 + effectiveSpreadBps / 10000);
  const usdcOut = brlIn > 0 ? brlIn / quotedRate : 0;
  const usdcAtMid = brlIn > 0 ? brlIn / midRate : 0;
  const marginUsd = usdcAtMid - usdcOut;
  return {
    brlIn,
    midRate,
    quotedRate,
    spreadBps: effectiveSpreadBps,
    usdcOut,
    usdcAtMid,
    marginUsd,
    marginBrl: marginUsd * quotedRate,
    stale,
    source,
    ts: new Date().toISOString(),
  };
}

// Best-effort margin ledger: records the conversion intent + captured spread so
// revenue is measured per conversion. Lands in the backend ledger when the route
// exists; silently no-ops otherwise (measurement must never block the flow).
export async function recordConversionIntent(q: Quote, walletId?: string): Promise<void> {
  const base = (import.meta.env.VITE_RELAYER_BASE as string | undefined) ?? "https://api.slippay.cc/api/v1/relayer";
  try {
    await fetch(`${base.replace(/\/relayer$/, "")}/onramp/intent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        brlIn: q.brlIn, midRate: q.midRate, quotedRate: q.quotedRate, spreadBps: q.spreadBps,
        usdcOut: q.usdcOut, marginUsd: q.marginUsd, walletId: walletId ?? null, ts: q.ts,
      }),
      keepalive: true,
    });
  } catch { /* measurement is best-effort */ }
}
