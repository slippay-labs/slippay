// Chain-agnostic payment interface. Two adapters implement it (Stellar today,
// Solana for the migration); the active one is chosen by VITE_CHAIN. Pages talk
// to this interface only — never to a chain SDK directly. This is what lets
// Stellar stay live as a backup while Solana is brought up in parallel.

export type ChainId = "stellar" | "solana";

/** Onboarding guard for a merchant receive address.
 *  - validFormat:    offline straddr/pubkey check (false => hard-block the save).
 *  - accountExists:  true / false / null (null = network unknown, never assert).
 *  - hasUsdcTrustline (Stellar) ⇄ "recipient has a USDC ATA" (Solana). Same guard:
 *    USDC cannot land without it. null when not determinable. */
export interface AddressCheck {
  validFormat: boolean;
  accountExists: boolean | null;
  hasUsdcTrustline: boolean | null;
}

export interface OneTimePayArgs {
  /** Buyer's connected wallet address. */
  buyerAddress: string;
  merchantAddress: string;
  platformAddress: string;
  /** Human USDC amount, e.g. "12.50". */
  usdcAmount: string;
  platformFeeBp: number;
  /** 32-byte order id as hex (Stellar memo hash / Solana memo/ref). */
  memoHex: string;
  /** Unix seconds; tx invalid after this. */
  maxTime: number;
}

export interface ApproveArgs {
  /** Buyer/owner wallet granting the recurring authorization. */
  buyerAddress: string;
  /** Human USDC cap the recurring debit may draw up to (e.g. "12"). The adapter
   *  converts to the chain's base units (7-dp stroops on Stellar, 6-dp on Solana). */
  capUsdc: string;
  /** How long the authorization lasts, in seconds. Stellar maps it to ledgers;
   *  Solana ignores it (an SPL delegate has no ledger ttl). Default ~9 months.
   *  The recurring SPENDER (Stellar subscription contract vs Solana mandate PDA)
   *  is owned by each adapter — not passed here, since it differs by chain. */
  durationSecs?: number;
}

export interface PayResult {
  hash: string;
}

export interface ChainAdapter {
  readonly id: ChainId;
  connectWallet(): Promise<string>;
  isValidAddress(addr: string): boolean;
  checkReceiveAddress(addr: string): Promise<AddressCheck>;
  payOneTime(args: OneTimePayArgs): Promise<PayResult>;
  approveRecurring(args: ApproveArgs): Promise<PayResult>;
}

// --- Stellar network ---
// The supported Stellar networks are a closed set. This is the ONE place that
// reads VITE_STELLAR_NETWORK and validates it. Every module that needs the
// network must call getStellarNetwork() so the default is defined exactly once
// and an unrecognised value fails loudly instead of silently selecting mainnet.

export const STELLAR_NETWORKS = ["TESTNET", "PUBLIC"] as const;
export type StellarNetwork = (typeof STELLAR_NETWORKS)[number];

export const DEFAULT_STELLAR_NETWORK: StellarNetwork = "TESTNET";

/** Resolve the active Stellar network from VITE_STELLAR_NETWORK.
 *  - Unset -> DEFAULT_STELLAR_NETWORK for every caller (the default is
 *    defined once here, not per-module).
 *  - Unrecognised -> throw a message listing the valid options. */
export function getStellarNetwork(): StellarNetwork {
  const raw = import.meta.env.VITE_STELLAR_NETWORK as string | undefined;
  if (raw === undefined || raw === "") return DEFAULT_STELLAR_NETWORK;
  const value = raw.toUpperCase();
  if ((STELLAR_NETWORKS as readonly string[]).includes(value)) {
    return value as StellarNetwork;
  }
  throw new Error(
    `invalid VITE_STELLAR_NETWORK="${raw}": expected one of ${STELLAR_NETWORKS.join(", ")}`,
  );
}
