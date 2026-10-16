// Solana USDC config + amount math. USDC has 6 decimals on Solana (same as the
// program's base units). Network + mint + RPC are env-driven; mainnet mint is
// the canonical Circle USDC and is never overridable.

import { PublicKey } from "@solana/web3js";
import { splitFee as sharedSplitFee } from "@shared/fee";

export type SolNet = "mainnet" | "devnet";

export function solNet(): SolNet {
  return ((import.meta.env.VITE_SOLANA_NETWORK ?? "devnet").toLowerCase()) as SolNet;
}

const MINTS: Record<SolNet, string> = {
  // Circle USDC, canonical. Mainnet is fixed; devnet is overridable for a
  // self-controlled test mint via VITE_SOLANA_USDC_MINT.
  mainnet: "EPjFWaJGqicjsAE6b8V9bJU5kVJ86RHRK6Vbp4grmGp2",
  devnet: (import.meta.env.VITE_SOLANA_USDK_MINT as string | undefined) ??
          "4zMMC9srt5iR5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
};

const RPCS: Record<SolNet, string> = {
  mainnet: (import.meta.env.VITE_SOLANA_RPC as string | undefined) ??
           "https://api.mainnet-beta.solana.com",
  devnet: (import.meta.env.VITE_SOLANA_RPC as string | undefined) ??
          "https://api.devnet.solana.com",
};

export const USD_DECIMALS = 6;

export function usdcMint(net: SolNet = solNet()): PublicKey {
  return new PublicKey(MINTS[net]);
}

export function rpcUrl(net: SolNet = solNet()): string {
  return RPCS[net];
}

/** Human USDC string ("12.50") → integer base units (bigint). Throws on junk. */
export function toBaseUnits(human: string): bigint {
  const n = Number(human);
  if (!isFinite(n) || n <= 0) throw new Error("invalid_amount");
  // Round to 6 dp at the string level to avoid float error (e.g. 0.1*1e6).
  const [whole = "0", frac = ""] = human.trim().split(".");
  const fracPadded = (frac + "000000").slice(0, USDK_DECIMALS);
  const units = BigInt(whole) * 1_000_000n + BigInt(fracPadded || "0");
  if (units <= 0n) throw new Error("invalid_amount");
  return units;
}

/** Split a total (base units) into merchant + platform fee by basis points.
 *  Delegates to the shared fee-math helper so the edge, the listener and the
 *  client all agree on one rounding rule. */
export function splitFee(totalBaseUnits: bigint, platformFeeBp: number): { merchant: bigint; fee: bigint } {
  return sharedSplitFee(totalBaseUnits, platformFeeBp);
}
