// Active chain adapter, chosen by VITE_CHAIN (default "stellar"). Pages import
// `getChainAdapter()` and never touch a chain SDK. Stellar stays the default so
// the live product is unchanged.
//
// Solana status: REFERENCE ONLY — not active in production.
// The Solana adapter exists in `feat/solana-adapter` as a reference
// implementation; production never sets VITE_CHAIN=solana. Cutover stays
// gated until the Solana biometric wallet (step 4 in SOLANA_FRONTEND_PORT.md)
// proves out on devnet + devnet funding + a Solana ramp is live.
// See docs/comex-go-live-checklist.md for the canonical status statement.
//
// The Solana adapter is dynamically imported so its heavy deps (@solana/web3.js,
// @coral-xyz/anchor) are code-split out of the Stellar bundle and only loaded
// when VITE_CHAIN=solana. Hence getChainAdapter() is async.

import type { ChainAdapter, ChainId } from "./types.ts";
import { stellarAdapter } from "./stellar/adapter.ts";

export * from "./types.ts";

export function activeChainId(): ChainId {
  return (((import.meta.env.VITE_CHAIN ?? "stellar").toLowerCase()) as ChainId);
}

// Environment descriptor: the network values that must all belong to the same
// environment. Exported so tests can assert it and diagnostics can display it.
export interface ChainEnvironment {
  chain: ChainId;
  network: "mainnet" | "testnet" | "devnet";
  stellarPassphrase: string;
  stellarUsdcIssuer: string;
  solanaCluster: string;
  baseChainId: number;
}

const STELLAR_MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";
const STELLAR_TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const STELLAR_MAINNET_USDC_ISSUER =
  "GA5ZSEJYB37JRC5AVCIA5MOP4RWTM335X2KGX3IHOJAPPS5R34KKZVN";
const STELLAR_TESTNET_USDC_ISSUER =
  "GBBD47IF6LWK7P7MDEVMCWR7DPUWV3NY3DTQEVFL4OAT4AQH3ZLLFLA5";
const BASE_MAINNET_CHAIN_ID = 8453;
const BASE_SEPOLIA_CHAIN_ID = 84532;

function envValue(key: string): string | undefined {
  const value = (import.meta.env as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resolveNetwork(): "mainnet" | "testnet" | "devnet" {
  const raw = (envValue("VITE_NETWORK") ?? "mainnet").toLowerCase();
  if (raw === "mainnet" || raw === "testnet" || raw === "devnet") return raw;
  throw new Error(`unknown VITE_NETWORK: ${raw}`);
}

// Validate the whole chain configuration as a unit. Individually plausible
// values can still be mutually wrong; a mixed configuration must fail fast
// with a message naming the mismatched pair rather than producing a
// transaction against the wrong asset.
export function resolveChainEnvironment(): ChainEnvironment {
  const chain = activeChainId();
  const network = resolveNetwork();

  const stellarPassphrase =
    envValue("VITE_STELLAR_NETWORK") ??
    (network === "mainnet" ? STELLAR_MAINNET_PASSPHRASE : STELLAR_TESTNET_PASSPHRASE);
  const stellarUsdcIssuer =
    envValue("VITE_STELLAR_USD_ISSUER") ??
    (network === "mainnet" ? STELLAR_MAINNET_USDC_ISSUER : STELLAR_TESTNET_USDC_ISSUER);
  const solanaCluster = envValue("VITE_SOLANA_CLUSTER") ?? network;
  const baseChainId = Number(
    envValue("VITE_BASE_CHAIN_ID") ??
      (network === "mainnet" ? BASE_MAINNET_CHAIN_ID : BASE_SEPOLIA_CHAIN_ID),
  );

  const expectedPassphrase =
    network === "mainnet" ? STELLAR_MAINNET_PASSPHRASE : STELLAR_TESTNET_PASSPHRASE;
  if (stellarPassphrase !== expectedPassphrase) {
    throw new Error(
      `chain config mismatch: network=${network} but Stellar passphrase=${stellarPassphrase}`,
    );
  }

  const expectedIssuer =
    network === "mainnet" ? STELLAR_MAINNET_USDC_ISSUER : STELLAR_TESTNET_USDC_ISSUER;
  if (stellarUsdcIssuer !== expectedIssuer) {
    throw new Error(
      `chain config mismatch: network=${network} but Stellar USDC issuer=${stellarUsdcIssuer}`,
    );
  }

  const expectedCluster = network === "mainnet" ? "mainnet-beta" : network;
  if (solanaCluster !== expectedCluster && solanaCluster !== network) {
    throw new Error(
      `chain config mismatch: network=${network} but Solana cluster=${solanaCluster}`,
    );
  }

  const expectedBaseChainId =
    network === "mainnet" ? BASE_MAINNET_CHAIN_ID : BASE_SEPOLIA_CHAIN_ID;
  if (baseChainId !== expectedBaseChainId) {
    throw new Error(
      `chain config mismatch: network=${network} but Base chain id=${baseChainId}`,
    );
  }

  return {
    chain,
    network,
    stellarPassphrase,
    stellarUsdcIssuer,
    solanaCluster,
    baseChainId,
  };
}

let cached: ChainAdapter | null = null;

export async function getChainAdapter(): Promise<ChainAdapter> {
  if (cached) return cached;
  // Validate the whole configuration as a unit before building any adapter.
  resolveChainEnvironment();
  const id = activeChainId();
  switch (id) {
    case "stellar":
      cached = stellarAdapter;
      return cached;
    case "solana": {
      const { solanaAdapter } = await import("./solana/adapter.ts");
      cached = solanaAdapter;
      return cached;
    }
    default:
      throw new Error(`unknown VITE_CHAIN: ${id}`);
  }
}
