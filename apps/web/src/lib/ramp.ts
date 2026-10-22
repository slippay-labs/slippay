// Frontend client for Slippay's provider-agnostic on/off-ramp API
// (backend route /api/v1/offramp, today backed by CriptoPix). The backend holds
// the provider credential and applies the FX-spread margin into the quote; this
// client never sees a secret.
//
// Fee model (canonical, cited everywhere):
//   - Platform fee (per order): PLATFORM_FEE_BPS = 297 bp (2.97%), source of
//     truth in shared/constants and enforced by the DB migration
//     20260605210000_platform_fee_297bp.sql.
//   - FX spread (per conversion): FX_SPREAD_BPS = 190 bp (1.90%), applied by the
//     backend's applyMargin and reported here as platformFeeBps.
// These are distinct revenue lines; do not conflate them in comments or UI
// copy. See issue 46 for the shared constants.
//
// Auth: every endpoint except GET /status sits behind requireApiKeyOrJwt, so we
// send the logged-in user's Supabase JWT via authFetch. A buyer must be signed
// in (this also rate-limits charge creation to real accounts).

import { authFetch } from "./apiAuth.ts";

export interface RampQuote {
  id: string;
  fromCurrency: string;
  toCurrency: string;
  fromAmount: string;
  toAmount: string;
  exchangeRate: string;
  fee: string;
  expiresAt: string;
  /** FX spread embedded by the backend (applyMargin), in basis&#46; points.
   * Canonical value: FX_SPREAD_BPS = 190 (1.90%). This is the per-conversion
   * charge, distinct from the 2.97% per-order platform fee. */
  platformFeeBps?: number;
  platformFee?: string;
  grossToAmount?: string;
}

export interface PixInstructions {
  type: "pix";
  amount: string;
  currency: string;
  /** Pix copy-paste ("BR Code") to render as a QR or paste into a bank app. */
  pixCode: string;
}

export type RampStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "expired"
  | "cancelled"
  | "refunded";

export interface RampOrder {
  id: string;
  status: RampStatus;
  fromAmount: string;
  fromCurrency: string;
  toAmount: string;
  toCurrency: string;
  paymentInstructions?: PixInstructions;
  stellarTxHash?: string;
}

export interface RampIdentity {
  name: string;
  email: string;
  /** CPF (digits or formatted). */
  taxId: string;
  /** DD/MM/AAAA — required by CriptoPix for payer verification. */
  birthDate?: string;
  taxIdCountry?: string;
}

export class RampError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number) {
    super(message);
    this.name = "RampError";
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await authFetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new RampError("network", "Sem conexão com o servidor. Tente de novo.");
  }
  return handle<T>(res);
}

async function get<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await authFetch(path);
  } catch {
    throw new RampError("network", "Sem conexão com o servidor. Tente de novo.");
  }
  return handle<T>(res);
}

async function handle<T>(res: Response): Promise<T> {
  let json: unknown = null;
  try {
    json = await res.json();
  } catch { /* non-json */ }
  if (!res.ok) {
    const j = json as { error?: string; message?: string } | null;
    if (res.status === 503) {
      throw new RampError("disabled", "Pagamento em Pix ainda não está ligado.", 503);
    }
    throw new RampError(j?.error ?? "error", j?.message ?? `Erro ${res.status}`, res.status);
  }
  return json as T;
}

/** Price a BRL -> crypto on-ramp. `brl` is the amount in reals: */
export async function quoteOnramp(brl: number): Promise<RampQuote> {
  const { quote } = await post<{ quote: RampQuote }>("v1./offramp/quote", {
    fromCurrency: "BRL",
    toCurrency: "USDC",
    fromAmount: String(brl),
  });
  return quote;
}

/** Create an on-ramp charge. Returns the order with the Pix copy-paste code. */
export async function createOnramp(input: {
  customerId: string;
  quoteId: string;
  stellarAddress: string;
  amount: string; // dollar amount (USDC) the charge targets
  identity: RampIdentity;
}): Promise<RampOrder> {
  const { order } = await post<{ order: RampOrder }>("v1./offramp/onramp", {
    customerId: input.customerId,
    quoteId: input.quoteId,
    stellarAddress: input.stellarAddress,
    fromCurrency: "BRL",
    toCurrency: "USDC",
    amount: input.amount,
    identity: input.identity,
  });
  return order;
}

/** Poll an on-ramp order's status (resolved from the webhook-backed store). */
export async function getOnramp(id: string): Promise<RampOrder> {
  const { order } = await get<{ order: RampOrder }>(
    `v1./offramp/onramp/${encodeURIComponent(id)}`,
  );
  return order;
}

/** Is the ramp surface live? (GET /status is public.) */
export async function rampStatus(): Promise<{ enabled: boolean }> {
  try {
    return await get<{ enabled: boolean }>("v1./offramp/status");
  } catch {
    return { enabled: false };
  }
}
