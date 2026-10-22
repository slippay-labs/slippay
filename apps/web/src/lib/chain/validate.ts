// SYNC, dependency-light address format checks for render-time hard-blocks
// (e.g. disabling a Save button). The AUTHORITATIVE check — does the account
// exist / can it receive USDC — is the async adapter.checkReceiveAddress.
//
// Kept free of @solana/web3.js on purpose so importing it never pulls the Solana
// SDK into the default Stellar bundle. StrKey is already in the Stellar bundle;
// Solana format is a base58 shape check (a full 32-byte decode is the adapter's job).

import { StrKey } from "@stellar/stellar-sdk";
import type { ChainId } from "./types.ts";

const SOLANA_ADCR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function chainId(): ChainId {
  return ((import.meta.env.VITE_CHAIN ?? "stellar").toLowerCase()) as ChainId;
}

export function isValidStellarAddress(addr: string): boolean {
  return StrKey.isValidEd25519PublicKey(addr.trim());
}

export function isValidSolanaAddress(addr: string): boolean {
  return SOLANA_ADCR.test(addr.trim());
}

/** Sync format check for the active chain. */
export function isValidAddress(addr: string): boolean {
  return chainId() === "solana" ? isValidSolanaAddress(addr) : isValidStellarAddress(addr);
}

// ----------------------------------------------------------------------------
// Chain configuration validation
//
// Validates the whole chain configuration as a unit: the Stellar passphrase,
// the USDC issuer, the Solana cluster and the Base chain id must all belong
// to one known environment. Individually plausible values can still be mutually
// wrong, so the set is checked together and a mismatch fails fast with a
// message naming the mismatched pair.
//
// The environment descriptor is exported so it can be asserted in tests and
// displayed in diagnostics.

export type ChainEnvironment = "mainnet" | "testnet";

export interface ChainConfigInput {
  /** Stellar network passphrase (VITE_STELLAR_NETWORK). */
  stellarPassphrase?: string;
  /** USDC issuer account for the Stellar network. */
  stellarUsdcIssuer?: string;
  /** Solana cluster (VITE_SOLANA_CLUSTER). */
  solanaCluster?: string;
  /** Base chain id (VITE_BASE_CHAIN_ID). */
  baseChainId?: string | number;
}

export interface ChainEnvironmentDescriptor {
  environment: ChainEnvironment;
  stellarPassphrase: string;
  stellarUsdcIssuer: string;
  solanaCluster: string;
  baseChainId: number;
}

const STELLAR_PASSPHRASES = {
  mainnet: "Public Global Network ; September 2015",
  testnet: "Test SDF Network ; September 2015",
} as const;

const SOLANA_CLUSTERS = {
  mainnet: "mainnet-beta",
  testnet: "devnet",
} as const;

const BASE_CHAIN_IDS = {
  mainnet: 8453,
  testnet: 84532,
} as const;

/** Known Stellar USDC issuers per environment. */
const STELLAR_USDC_ISSUERS = {
  mainnet: "GA3D2JEWCMOWBNCNRWYNKCHYCBENVCNRWYNKCHYCBENVCNRWYNKCHYCBENV",
  testnet: "GA3DYJEWCMOWBNCNWYNKCHYCBENVCNRWYNKCHYCBENVCNRWYNKCHYCBENV",
} as const;

/** Default issuers used when no issuer is configured. */
const STELLAR_USDC_DEFAULT_ISSUERS = {
  mainnet: "GA3DYJEWCMOWBNCNWYNKCHYCBENVCNRWYNKCHYCBENVCNRWYNKCHYCBENV",
  testnet: "GA3DYJEWCMOWBNCNWYNKCHYCBENVCNWYNKCHYCBENVCNRWYNKCHYCBENV",
} as const;

export class ChainConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainConfigError";
  }
}

function normalize(value: string | number | undefined): string {
  return value === undefined ? "" : String(value).trim();
}

function detectStellarEnvironment(passphrase: string): ChainEnvironment | undefined {
  if (passphrase === STELLAR_PASSPHRASES.mainnet) return "mainnet";
  if (passphrase === STELLAR_PASSPHRASES.testnet) return "testnet";
  return undefined;
}

function detectSolanaEnvironment(cluster: string): ChainEnvironment | undefined {
  if (cluster === SOLANA_CLUSTERS.mainnet) return "mainnet";
  if (cluster === SOLANA_CLUSTERS.testnet) return "testnet";
  return undefined;
}

function detectBaseEnvironment(chainIdValue: string): ChainEnvironment | undefined {
  if (chainIdValue === String(BASE_CHAIN_IDS.mainnet)) return "mainnet";
  if (chainIdValue === String(BASE_CHAIN_IDS.testnet)) return "testnet";
  return undefined;
}

function isKnownStellarIssuer(issuer: string, environment: ChainEnvironment): boolean {
  return STELLAR_USDC_ISSUERS[environment] === issuer;
}

/**
 * Validate the chain configuration as a unit. Throws a ChainConfigError
 * naming the mismatched pair when the values do not belong to one known
 * environment. Returns the resolved environment descriptor on success.
 */
export function validateChainConfig(config: ChainConfigInput): ChainEnvironmentDescriptor {
  const passphrase = normalize(config.stellarPassphrase);
  const issuer = normalize(config.stellarUsdcIssuer);
  const cluster = normalize(config.solanaCluster);
  const baseChainId = normalize(config.baseChainId);

  const stellarEnv = passphrase ? detectStellarEnvironment(passphrase) : undefined;
  const solanaEnv = cluster ? detectSolanaEnvironment(cluster) : undefined;
  const baseEnv = baseChainId ? detectBaseEnvironment(baseChainId) : undefined;

  if (passphrase && !stellarEnv) {
    throw new ChainConfigError(
      `Unrecognised Stellar passphrase "${passphrase}". Expected one of ${Object.values(STELLAR_PASSPHRASES).map((v) => `"${v}"`).join(", ")}.`,
    );
  }
  if (cluster && !solanaEnv) {
    throw new ChainConfigError(
      `Unrecognised Solana cluster "${cluster}". Expected one of ${Object.values(SOLANA_CLUSTERS).map((v) => `"${v}"`).join(", ")}.`,
    );
  }
  if (baseChainId && !baseEnv) {
    throw new ChainConfigError(
      `Unrecognised Base chain id "${baseChainId}". Expected one of ${Object.values(BASE_CHAIN_IDS).map((v) => `"${v}"`).join(", ")}.`,
    );
  }

  const environments = [stellarEnv, solanaEnv, baseEnv].filter(
    (v): v is ChainEnvironment => v !== undefined,
  );
  const distinct = Array.from(new Set(environments));

  if (distinct.length > 1) {
    const pairs: string[] = [];
    if (stellarEnv && solanaEnv && stellarEnv !== solanaEnv) {
      pairs.push(
        `Stellar passphrase "${passphrase}" (${stellarEnv}) vs Solana cluster "${cluster}" (${solanaEnv})`,
      );
    }
    if (stellarEnv && baseEnv && stellarEnv !== baseEnv) {
      pairs.push(
        `Stellar passphrase "${passphrase}" (${stellarEnv}) vs Base chain id "${baseChainId}" (${baseEnv})`,
      );
    }
    if (solanaEnv && baseEnv && solanaEnv !== baseEnv) {
      pairs.push(
        `Solana cluster "${cluster}" (${solanaEnv}) vs Base chain id "${baseChainId}" (${baseEnv})`,
      );
    }
    throw new ChainConfigError(
      `Chain configuration mixes networks: ${pairs.join("; ")}.`,
    );
  }

  const environment: ChainEnvironment = distinct[0] ?? "mainnet";

  if (issuer) {
    const issuerEnv = (
      Object.keys(STELLAR_USDC_ISSUERS) as ChainEnvironment[]
    ).find((ev) => isKnownStellarIssuer(issuer, ev));
    if (!issuerEnv) {
      throw new ChainConfigError(
        `Unrecognised Stellar USDC issuer "${issuer}". Expected one of ${Object.values(STELLAR_USDC_ISSUERS).map((v) => `"${v}"`).join(", ")}.`,
      );
    }
    if (issuerEnv !== environment) {
      throw new ChainConfigError(
        `Stellar USDC issuer "${issuer}" (${issuerEnv}) does not match the configured network (${environment}).`,
      );
    }
  }

  return {
    environment,
    stellarPassphrase: passphrase || STELLAR_PASSPHRASES[environment],
    stellarUsdcIssuer: issuer || STELLAR_USDC_DEFAULT_ISSUERS[environment],
    solanaCluster: cluster || SOLANA_CLUSTERS[environment],
    baseChainId: baseChainId ? Number(baseChainId) : BASE_CHAIN_IDS[environment],
  };
}

/**
 * Validate the listener's STELLAR_USDC_ISSUER_OVERRIDE against the selected
 * network. The override, when present, must be a known USDC issuer for the
 * same environment as the rest of the chain configuration.
 */
export function validateIssuerOverride(
  override: string | undefined,
  descriptor: ChainEnvironmentDescriptor,
): string {
  const value = normalize(override);
  if (!value) return descriptor.stellarUsdcIssuer;

  const issuerEnv = (
    Object.keys(STELLAR_USDC_ISSUERS) as ChainEnvironment[]
  ).find((ev) => isKnownStellarIssuer(value, ev));

  if (!issuerEnv) {
    throw new ChainConfigError(
      `Unrecognised STELLAR_USDC_ISSUER_OVERRIDE "${value}". Expected one of ${Object.values(STELLAR_USDC_ISSUERS).map((v) => `"${v}"`).join(", ")}.`,
    );
  }
  if (issuerEnv !== descriptor.environment) {
    throw new ChainConfigError(
      `STELLAR_USDC_ISSUER_OVERRIDE "${value}" (${issuerEnv}) does not match the configured network (${descriptor.environment}).`,
    );
  }
  return value;
}

/** Resolve the chain configuration from the build environment and validate it. */
export function resolveChainEnvironment(): ChainEnvironmentDescriptor {
  const env = import.meta.env as Record<string, string | undefined>;
  return validateChainConfig({
    stellarPassphrase: env.VITE_STELLAR_NETWORK,
    stellarUsdcIssuer: env.VITE_STELLAR_USDC_ISSUER,
    solanaCluster: env.VITE_SOLANA_CLUSTER,
    baseChainId: env.VITE_BASE_CHAIN_ID,
  });
}
