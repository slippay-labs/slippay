import { describe, it, expect, afterEach, vi } from "vitest";
import {
  chainId,
  isValidSolanaAddress,
  isValidStellarAddress,
} from "./validate.ts";

// Known-valid Stellar ed25519 public key (base32, 56 chars, correct checksum).
const STELLAR = "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37";
// Valid base58 Solana address: the USDC mint.
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
});
