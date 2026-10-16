import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  validateChainEnvironment,
  readChainEnvironmentConfig,
  getChainEnvironmentDescriptor,
  resetChainEnvironmentDescriptorForTesting,
} from "../src/lib/chain/env.ts";

describe("Chain Environment Consistency at Startup", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    resetChainEnvironmentDescriptorForTesting();
  });

  it("produces a valid testnet descriptor under default testnet env vars", () => {
    vi.stubEnv("VITE_STELLAR_NETWORK", "TESTNET");
    vi.stubEnv("VITE_BASE_NETWORK", "sepolia");
    vi.stubEnv("VITE_SOLANA_NETWORK", "devnet");

    const config = readChainEnvironmentConfig();
    const desc = validateChainEnvironment(config);
    expect(desc.tier).toBe("testnet");
    expect(desc.stellar.network).toBe("TESTNET");
    expect(desc.base.chainId).toBe(84532);
    expect(desc.solana.network).toBe("devnet");
  });

  it("produces a valid mainnet descriptor under consistent mainnet env vars", () => {
    vi.stubEnv("VITE_STELLAR_NETWORK", "PUBLIC");
    vi.stubEnv("VITE_BASE_NETWORK", "mainnet");
    vi.stubEnv("VITE_SOLANA_NETWORK", "mainnet");

    const config = readChainEnvironmentConfig();
    const desc = validateChainEnvironment(config);
    expect(desc.tier).toBe("mainnet");
    expect(desc.stellar.network).toBe("PUBLIC");
    expect(desc.base.chainId).toBe(8453);
    expect(desc.solana.network).toBe("mainnet");
  });

  it("fails fast with a message naming both values when mixing Stellar PUBLIC with Base sepolia", () => {
    vi.stubEnv("VITE_STELLAR_NETWORK", "PUBLIC");
    vi.stubEnv("VITE_BASE_NETWORK", "sepolia");

    const config = readChainEnvironmentConfig();
    expect(() => validateChainEnvironment(config)).toThrowError(
      /Inconsistent chain environment configuration: Stellar network "PUBLIC" \(mainnet\) conflicts with Base network "sepolia" \(testnet\)/
    );
  });

  it("fails fast with a message naming both values when mixing Stellar PUBLIC with Solana devnet", () => {
    vi.stubEnv("VITE_STELLAR_NETWORK", "PUBLIC");
    vi.stubEnv("VITE_SOLANA_NETWORK", "devnet");

    const config = readChainEnvironmentConfig();
    expect(() => validateChainEnvironment(config)).toThrowError(
      /Inconsistent chain environment configuration: Stellar network "PUBLIC" \(mainnet\) conflicts with Solana network "devnet" \(testnet\)/
    );
  });
});
