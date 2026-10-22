import { describe, it, expect, afterEach, vi } from "vitest";
import {
  chainId,
  isValidAddress,
  isValidSolanaAddress,
  isValidStellarAddress,
  validateChainConfig,
} from "./validate.ts";

// Known-valid Stellar ed25519 public key (base32, 56 chars, correct checksum).
const STELLAR = "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37";
// Valid base58 Solana addresses: the 32-byte system program and the USDC mint.
const SOLANA_SHORT = "11111111111111111111111111111111";
const SOLANA_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("chainId", () => {
  it("defaults to stellar when VITE_CHAIN is unset", () => {
    expect(import.meta.env.VITE_CHAIN).toBeUndefined();
    expect(chainId()).toBe("stellar");
  });

  it("lower-cases the configured chain", () => {
    vi.stubEnv("VITE_CHAIN", "SOLANA");
    expect(chainId()).toBe("solana");
  });
});

describe("isValidStellarAddress", () => {
  it("accepts a valid ed25519 public key, trimming whitespace", () => {
    expect(isValidStellarAddress(STELLAR)).toBe(true);
    expect(isValidStellarAddress(`  ${STELLAR}  `)).toBe(true);
  });

  it("rejects a wrong checksum (one base32 char flipped)", () => {
    expect(isValidStellarAddress(`${STELLAR.slice(0, -1)}6`)).toBe(false);
  });

  it("rejects a wrong length", () => {
    expect(isValidStellarAddress(STELLAR.slice(0, 55))).toBe(false);
    expect(isValidStellarAddress(`${STELLAR}A`)).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidStellarAddress("")).toBe(false);
    expect(isValidStellarAddress("   ")).toBe(false);
  });

  it("rejects a Solana-style base58 address", () => {
    expect(isValidStellarAddress(SOLANA_MINT)).toBe(false);
  });

  it("throws (fails closed) on non-string input", () => {
    expect(() => isValidStellarAddress(null as unknown as string)).toThrow();
    expect(() => isValidStellarAddress(undefined as unknown as string)).toThrow();
  });
});

describe("isValidSolanaAddress", () => {
  it("accepts valid base58 addresses, trimming whitespace", () => {
    expect(isValidSolanaAddress(SOLANA_SHORT)).toBe(true);
    expect(isValidSolanaAddress(SOLANA_MINT)).toBe(true);
    expect(isValidSolanaAddress(`  ${SOLANA_MINT}  `)).toBe(true);
  });

  it("rejects characters outside the base58 alphabet", () => {
    expect(isValidSolanaAddress("0".repeat(32))).toBe(false); // 0 not in base58
    expect(isValidSolanaAddress("O".repeat(32))).toBe(false); // O not in base58
    expect(isValidSolanaAddress("I".repeat(32))).toBe(false); // I not in base58
    expect(isValidSolanaAddress("l".repeat(32))).toBe(false); // l not in base58
  });

  it("rejects a wrong length", () => {
    expect(isValidSolanaAddress("abc")).toBe(false);
    expect(isValidSolanaAddress("1".repeat(31))).toBe(false);
    expect(isValidSolanaAddress("1".repeat(45))).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidSolanaAddress("")).toBe(false);
  });

  it("rejects a Stellar address", () => {
    expect(isValidSolanaAddress(STELLAR)).toBe(false);
  });

  it("throws (fails closed) on non-string input", () => {
    expect(() => isValidSolanaAddress(null as unknown as string)).toThrow();
  });
});

describe("isValidAddress — active-chain dispatch", () => {
  it("checks Stellar format when the chain is stellar (default)", () => {
    vi.stubEnv("VITE_CHAIN", "stellar");
    expect(isValidAddress(STELLAR)).toBe(true);
    expect(isValidAddress(SOLANA_MINT)).toBe(false);
  });

  it("checks Solana format when the chain is solana", () => {
    vi.stubEnv("VITE_CHAIN", "solana");
    expect(isValidAddress(SOLANA_MINT)).toBe(true);
    expect(isValidAddress(STELLAR)).toBe(false);
  });
});

describe("validateChainConfig — cross-network consistency", () => {
  const STELLAR_MAINNET_PASSDRA = "Public Global Stellar Network ; September 2015";
  const STELLAR_TESTNET_PASSDRA = "Test SDF Network ; September 2015";
  const STELLAR_MAINNET_ISSUER = "GANZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPPPRE34K4KZVN";
  const STELLAR_TESTNET_ISSUER = "GBBD47IF6LWK7P7MDEVMCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  const SOLANA_MAINNET_CLUSTER = "mainnet-beta";
  const SOLANA_DEVNET_CLUSTER = "devnet";
  const BASE_MAINNET_CHAIN_ID = 8453;
  const BASE_SEPOLIA_CHAIN_ID = 84532;

  it("accepts a fully consistent mainnet configuration", () => {
    const env = validateChainConfig({
      stellarPassphrase: STELLAR_MAINNET_PASSDRA,
      stellarUsdcIssuer: STELLAR_MAINNET_ISSUER,
      solanaCluster: SOLANA_MAINNET_CLUSTER,
      baseChainId: BASE_MAINNET_CHAIN_ID,
    });
    expect(env).toBe("mainnet");
  });

  it("accepts a fully consistent testnet configuration", () => {
    const env = validateChainConfig({
      stellarPassphrase: STELLAR_TESTNET_PASSPHRASE,
      stellarUsdcIssuer: STELLAR_TESTNET_ISSUER,
      solanaCluster: SOLANA_DEVNET_CLUSTER,
      baseChainId: BASE_SEPOLIA_CHAIN_ID,
    });
    expect(env).toBe("testnet");
  });

  it("rejects a Stellar mainnet passphrase with a testnet issuer, naming both", () => {
    expect(() =>
      validateChainConfig({
        stellarPassphrase: STELLAR_MAINNET_PASSDRA,
        stellarUsdcIssuer: STELLAR_TESTNET_ISSUER,
        solanaCluster: SOLANA_MAINNET_CLUSTER,
        baseChainId: BASE_MAINNET_CHAIN_ID,
      }),
    ).toThrow(/stellarPassphrase.*stellarUsdcIssuer|stellarUsdcIssuer.*stellarPassphrase/i);
  });

  it("rejects a Base mainnet chain id with a testnet Solana cluster, naming both", () => {
    expect(() =>
      validateChainConfig({
        stellarPassphrase: STELLAR_TESTNET_PASSPHRASE,
        stellarUsdcIssuer: STELLAR_TESTNET_ISSUER,
        solanaCluster: SOLANA_DEVNET_CLUSTER,
        baseChainId: BASE_MAINNET_CHAIN_ID,
      }),
    ).toThrow(/baseChainId.*solanaCluster|solanaCluster.*baseChainId/i);
  });

  it("rejects an issuer override that does not match the selected network", () => {
    expect(() =>
      validateChainConfig({
        stellarPassphrase: STELLAR_MAINNET_PASSDRA,
        stellarUsdcIssuer: STELLAR_MAINNET_ISSUER,
        stellarUsdcIssuerOverride: STELLAR_TESTNET_ISSUER,
        solanaCluster: SOLANA_MAINNET_CLUSTER,
        baseChainId: BASE_MAINNET_CHAIN_ID,
      }),
    ).toThrow(/stellarUsdcIssuerOverride.*stellarPassphrase|stellarPassphrase.*stellarUsdcIssuerOverride/i);
  });

  it("rejects an unrecognised network value", () => {
    expect(() =>
      validateChainConfig({
        stellarPassphrase: "Unknown Network ; 2024",
        stellarUsdcIssuer: STELLAR_MAINNET_ISSUER,
        solanaCluster: SOLANA_MAINNET_CLUSTER,
        baseChainId: BASE_MAINNET_CHAIN_ID,
      }),
    ).toThrow();
  });
});