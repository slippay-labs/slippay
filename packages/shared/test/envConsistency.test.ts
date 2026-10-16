import { describe, it, expect } from "vitest";
import {
  validateChainEnvironment,
  validateIssuerOverride,
  ENVIRONMENTS,
} from "../src/envConsistency.ts";
import { NETWORK } from "../src/constants.ts";

describe("validateChainEnvironment", () => {
  it("accepts a fully consistent mainnet configuration", () => {
    const desc = validateChainEnvironment({
      stellarNetwork: "PUBLIC",
      stellarPassphrase: NETWORK.mainnet.passphrase,
      stellarUsdcIssuer: NETWORK.mainnet.usdc_issuer,
      solanaNetwork: "mainnet",
      solanaUsdcMint: "EPjFWaJGqicjsAE6b8V9bJU5kVJ86RHRK6Vbp4grmGp2",
      baseNetwork: "mainnet",
      baseChainId: 8453,
      baseUsdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    });
    expect(desc.tier).toBe("mainnet");
    expect(desc.stellar.network).toBe("PUBLIC");
    expect(desc.base.chainId).toBe(8453);
  });

  it("accepts a fully consistent testnet configuration", () => {
    const desc = validateChainEnvironment({
      stellarNetwork: "TESTNET",
      stellarPassphrase: NETWORK.testnet.passphrase,
      stellarUsdcIssuer: NETWORK.testnet.usdc_issuer,
      solanaNetwork: "devnet",
      solanaUsdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      baseNetwork: "sepolia",
      baseChainId: 84532,
      baseUsdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    });
    expect(desc.tier).toBe("testnet");
    expect(desc.stellar.network).toBe("TESTNET");
    expect(desc.base.chainId).toBe(84532);
  });

  it("rejects configuration mixing Stellar PUBLIC with testnet USDC issuer and names both", () => {
    expect(() =>
      validateChainEnvironment({
        stellarNetwork: "PUBLIC",
        stellarUsdcIssuer: NETWORK.testnet.usdc_issuer,
      })
    ).toThrowError(/Stellar network "PUBLIC" \(mainnet\) conflicts with Stellar USDC issuer "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" \(testnet\)/);
  });

  it("rejects configuration mixing Stellar PUBLIC with Base sepolia and names both", () => {
    expect(() =>
      validateChainEnvironment({
        stellarNetwork: "PUBLIC",
        baseNetwork: "sepolia",
      })
    ).toThrowError(/Stellar network "PUBLIC" \(mainnet\) conflicts with Base network "sepolia" \(testnet\)/);
  });

  it("rejects configuration mixing Stellar PUBLIC with Solana devnet and names both", () => {
    expect(() =>
      validateChainEnvironment({
        stellarNetwork: "PUBLIC",
        solanaNetwork: "devnet",
      })
    ).toThrowError(/Stellar network "PUBLIC" \(mainnet\) conflicts with Solana network "devnet" \(testnet\)/);
  });

  it("rejects configuration mixing Base mainnet with Base Sepolia chain ID 84532 and names both", () => {
    expect(() =>
      validateChainEnvironment({
        baseNetwork: "mainnet",
        baseChainId: 84532,
      })
    ).toThrowError(/Base network "mainnet" \(mainnet\) conflicts with Base chain ID "84532" \(testnet\)/);
  });

  it("throws on completely unknown Stellar network value", () => {
    expect(() =>
      validateChainEnvironment({
        stellarNetwork: "FOOBAR",
      })
    ).toThrowError(/Invalid Stellar network value: "FOOBAR"/);
  });
});

describe("validateIssuerOverride", () => {
  it("defaults to canonical issuer when override is absent or empty", () => {
    expect(validateIssuerOverride("PUBLIC")).toBe(NETWORK.mainnet.usdc_issuer);
    expect(validateIssuerOverride("PUBLIC", "")).toBe(NETWORK.mainnet.usdc_issuer);
    expect(validateIssuerOverride("TESTNET")).toBe(NETWORK.testnet.usdc_issuer);
    expect(validateIssuerOverride("TESTNET", "   ")).toBe(NETWORK.testnet.usdc_issuer);
  });

  it("accepts an arbitrary valid custom test override", () => {
    const custom = "GCUSTOMISSUER1234567890123456789012345678901234567890123456";
    expect(validateIssuerOverride("TESTNET", custom)).toBe(custom);
    expect(validateIssuerOverride("PUBLIC", custom)).toBe(custom);
  });

  it("rejects testnet issuer override on PUBLIC network and names both values", () => {
    expect(() =>
      validateIssuerOverride("PUBLIC", NETWORK.testnet.usdc_issuer)
    ).toThrowError(
      /STELLAR_USDC_ISSUER_OVERRIDE "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" is the testnet issuer, but network is PUBLIC \(mainnet\)/
    );
  });

  it("rejects mainnet issuer override on TESTNET network and names both values", () => {
    expect(() =>
      validateIssuerOverride("TESTNET", NETWORK.mainnet.usdc_issuer)
    ).toThrowError(
      /STELLAR_USDC_ISSUER_OVERRIDE "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" is the mainnet issuer, but network is TESTNET/
    );
  });
});
