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
//
// STALE RATE POLICY: a wrong price is worse than no price in a payments flow.
// When the live rate is unavailable we refuse to quote by default. Callers that
// genuinely need a degraded response can opt in explicitly via `allowStale`; the
// fallback is then bounded to the last known live rate and is never more
// favourable than it (in either direction).

const SPREAD_BPS = Number(import.meta.env.VITE_FX_SPREAD_BPS ?? 190);
const RATE_URL = "https://open.er-api.com/v6/latest/USD";
// Last-resort constant, only used when there is no live rate at all. It is not
// a price: callers must opt in to stale quotes and the result is flagged stale.
const FALLBACK_BRL_PER_USD = 5.4;
// Bound on how far a stale fallback may drift from the last live rate. This
// keeps a degraded quote from being more favourable than the last live price.
const MAX_STALE_DRIFT = 0.02 // 2%

const LIVE_TTL_MS = 60_000;
// How long a last-known live rate remains usable as a stale fallback bound.
const STALE_BOUND_TTL_MS = 6 * 60_000;

export const SPREAED_PCT = SPREAD_BPS / 100;

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
  ts: string;
}

// Result of a stale quote: the price is degraded and the caller must decide.
export interface StaleQuote extends Quote {
  stale: true;
}

export class StaleRateError extends Error {
  readonly code = "STALE_RATE" as const;
  constructor(message = "Cotacao indisponivel. Tente novamente em instantes.") {
    super(message);
    this.name = "StaleRateError";
  }
}

let cache: { rate: number; at: number } | null = null;
// Last known live rate — never expires for bounding purposes, but is subject to
// STALE_BOUND_TTL_MS so a very old rate cannot silently become the price.
let lastLive: { rate: number; at: number } | null = null;
// Cache the in-flight promise, not just the resolved value: concurrent cold
// callers (several components mounting in one frame) share a single request.
let inflight: Promise<{ rate: number; stale: boolean }> | null = null;

function clampStaleRate(rate: number): number {
  if (!lastLive || Date.now() - lastLive.at > STALE_BOUND_TTL_MS) return rate;
  // Never more favourable than the last live rate in either direction: clamp
  // the fallback into [live * (1 - d), live * (1 + d)]. A higher BRL/USD means
  // fewer USDC per BRL, so clamping to the upper bound keeps the user from
  // receiving more than the live price would have given.
  const lo = lastLive.rate * (1 - MAX_STALE_DRIFT);
  const hi = lastLive.rate * (1 + MAX_STALE_DRIFT);
  return Math.min(hi, Math.max(lo, rate));
}

async function fetchMidRate(): Promise<{ rate: number; stale: boolean }> {
  try {
    const r = await fetch(RATE_URL);
    const j = await r.json();
    const rate = Number(j?.rates?.BRL);
    if (Number.isFinite(rate) && rate > 0) {
      const at = Date.now();
      cache = { rate, at };
      lastLive = { rate, at };
      return { rate, stale: false };
    }
  } catch { /* fall through to stale fallback */ }
  // Prefer the last known live rate (bounded) over the hardcoded constant.
  const base = lastLive && Date.now() - lastLive.at <= STALE_BOUND_TTL_MS
    ? lastLive.rate
    : FALLBACK_BRL_PER_USD;
  return { rate: clampStaleRate(base), stale: true };
}

export async function midRateBRLperUSD(): Promise<{ rate: number; stale: boolean }> {
  if (cache && Date.now() - cache.at < LIVE_TTL_MS) return { rate: cache.rate, stale: false };
  if (inflight) return inflight;
  inflight = fetchMidRate().finally(() => { inflight = null; });
  return inflight;
}

export interface QuoteOptions {
  // Explicit opt-in to pricing from a stale/fallback rate. Defaults to false: a
  // caller that forgets to handle stale rates gets an error, not a wrong price.
  allowStale?: boolean;
}

function toQuote(brlIn: number, midRate: number, spreadBps: number, stale: boolean): Quote {
  const quotedRate = midRate * (1 + spreadBps / 10000);
  const usdcOut = brlIn > 0 ? brlIn / quotedRate : 0;
  const usdcAtMid = brlIn > 0 ? brlIn / midRate : 0;
  const marginUsd = usdcAtMid - usdcOut;
  return {
    brlIn, midRate, quotedRate, spreadBps,
    usdcOut, usdcAtMid, marginUsd, marginBrl: marginUsd * quotedRate,
    stale, ts: new Date().toISOString(),
  };
}

// Default path: refuses to price from a stale rate. Throws StaleRateError so the
// caller can surface a retry state instead of a wrong price.
export async function quoteBRLtoUSDC(brlIn: number, spreadBps = SPREAD_BPS): Promise<Quote>;
export async function quoteBRLtoUSDC(brlIn: number, spreadBps: number, opts: QuoteOptions & { allowStale: true }): Promise<StaleQuote>;
export async function quoteBRLtoUSDC(brlIn: number, spreadBps: number, opts: QuoteOptions): Promise<Quote>;
export async function quoteBRLtoUSDC(
  brlIn: number,
  spreadBps = SPREAD_BPS,
  opts: QuoteOptions = {},
): Promise<Quote> {
  const { rate: midRate, stale } = await midRateBRLperUSD();
  if (stale && !opts.allowStale) throw new StaleRateError();
  return toQuote(brlIn, midRate, spreadBps, stale);
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