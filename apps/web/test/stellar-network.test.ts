import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getStellarNetwork,
  SUPPORTED_STELLAR_NETWORKS,
} from "../src/lib/chain/types.ts";
import { decodeTx, localHash } from "../src/lib/txguard.ts";
import { attachSignature } from "../src/lib/privyWallet.ts";

describe("Stellar Network Validation (Issue #319)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves TESTNET as the consistent default when VITE_STELLAR_NETWORK is unset", () => {
    vi.stubEnv("VITE_STELLAR_NETWORK", "");
    expect(getStellarNetwork()).toBe("TESTNET");

    // also with undefined override
    expect(getStellarNetwork(undefined)).toBe("TESTNET");
  });

  it("normalizes and accepts valid networks case-insensitively with trimming", () => {
    expect(getStellarNetwork("TESTNET")).toBe("TESTNET");
    expect(getStellarNetwork("testnet")).toBe("TESTNET");
    expect(getStellarNetwork("  testnet  ")).toBe("TESTNET");

    expect(getStellarNetwork("PUBLIC")).toBe("PUBLIC");
    expect(getStellarNetwork("public")).toBe("PUBLIC");
    expect(getStellarNetwork("  PUBLIC  ")).toBe("PUBLIC");
  });

  it("throws descriptive error naming valid options when network is unsupported", () => {
    const invalidInputs = ["MAINNET", "FUTURENET", "LOCAL", "Stellar", "test_net", "invalid"];

    for (const invalid of invalidInputs) {
      expect(() => getStellarNetwork(invalid)).toThrowError(
        /Unsupported Stellar network: ".*"\. Valid options are: TESTNET, PUBLIC\./
      );
    }
  });

  it("throws descriptive error via env variable if invalid value is set in import.meta.env", () => {
    vi.stubEnv("VITE_STELLAR_NETWORK", "FUTURENET");
    expect(() => getStellarNetwork()).toThrowError(
      /Unsupported Stellar network: "FUTURENET"\. Valid options are: TESTNET, PUBLIC\./
    );
  });

  it("ensures txguard and privyWallet fail loudly with clear error on unsupported network without undefined SDK crash", () => {
    const fakeXdr = "AAAAAA==";
    // @ts-expect-error testing runtime guard against invalid cast
    expect(() => decodeTx(fakeXdr, "INVALID_NET")).toThrowError(
      /Unsupported Stellar network: "INVALID_NET"\. Expected TESTNET or PUBLIC\./
    );

    // @ts-expect-error testing runtime guard against invalid cast
    expect(() => localHash(fakeXdr, "INVALID_NET")).toThrowError(
      /Unsupported Stellar network: "INVALID_NET"\. Expected TESTNET or PUBLIC\./
    );

    // @ts-expect-error testing runtime guard against invalid cast
    expect(() => attachSignature(fakeXdr, "INVALID_NET", "GAA", Buffer.alloc(64))).toThrowError(
      /Unsupported Stellar network: "INVALID_NET"\. Expected TESTNET or PUBLIC\./
    );
  });

  it("exports SUPPORTED_STELLAR_NETWORKS containing exactly TESTNET and PUBLIC", () => {
    expect(SUPPORTED_STELLAR_NETWORKS).toEqual(["TESTNET", "PUBLIC"]);
  });
});
