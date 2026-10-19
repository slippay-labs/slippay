import { describe, it, expect } from "vitest";
import {
  NETWORK,
  DEFAULT_PLATFORM_FEE_BP,
  ORDER_DEFAULT_EXPIRY_MINUTES,
  API_KEY_PREFIX,
  API_KEY_PREFIX_TEST,
  API_KEY_PREFIXES,
  hasApiKeyPrefix,
  extractBearerApiKey,
  API_KEY_BYTES,
  STELLAR_ADDRESS_LENGTH,
  MEMO_HASH_HEX_LENGTH,
  ASSET_CODES,
  USDC_ASSET_CODE,
} from "../src/index.ts";

describe("packages/shared constants invariants", () => {
  describe("DEFAULT_PLATFORM_FEE_BP", () => {
    it("matches the exact default platform fee expectation (297 bps = 2.97%)", () => {
      // Must fail if DEFAULT_PLATFORM_FEE_BP is changed without updating the expectation
      expect(DEFAULT_PLATFORM_FEE_BP).toBe(297);
    });

    it("satisfies database constraint for merchants.platform_fee_bp (between 0 and 1000)", () => {
      expect(Number.isInteger(DEFAULT_PLATFORM_FEE_BP)).toBe(true);
      expect(DEFAULT_PLATFORM_FEE_BP).toBeGreaterThanOrEqual(0);
      expect(DEFAULT_PLATFORM_FEE_BP).toBeLessThanOrEqual(1000);
    });
  });

  describe("NETWORK configuration", () => {
    it("exposes valid testnet network configuration", () => {
      expect(NETWORK.testnet).toBeDefined();
      expect(NETWORK.testnet.horizon).toBe("https://horizon-testnet.stellar.org");
      expect(NETWORK.testnet.passphrase).toBe("Test SDF Network ; September 2015");
      // Non-empty issuer value with valid Stellar address length
      expect(typeof NETWORK.testnet.usdc_issuer).toBe("string");
      expect(NETWORK.testnet.usdc_issuer.length).toBe(STELLAR_ADDRESS_LENGTH);
      expect(NETWORK.testnet.usdc_issuer.startsWith("G")).toBe(true);
    });

    it("exposes valid mainnet network configuration", () => {
      expect(NETWORK.mainnet).toBeDefined();
      expect(NETWORK.mainnet.horizon).toBe("https://horizon.stellar.org");
      expect(NETWORK.mainnet.passphrase).toBe("Public Global Stellar Network ; September 2015");
      // Non-empty issuer value with valid Stellar address length
      expect(typeof NETWORK.mainnet.usdc_issuer).toBe("string");
      expect(NETWORK.mainnet.usdc_issuer.length).toBe(STELLAR_ADDRESS_LENGTH);
      expect(NETWORK.mainnet.usdc_issuer.startsWith("G")).toBe(true);
    });

    it("ensures both network entries have non-empty issuer and horizon values", () => {
      for (const [networkName, config] of Object.entries(NETWORK)) {
        expect(config.horizon, `${networkName} horizon URL must be non-empty`).toBeTruthy();
        expect(config.horizon.startsWith("https://"), `${networkName} horizon must use HTTPS`).toBe(true);
        expect(config.usdc_issuer, `${networkName} usdc_issuer must be non-empty`).toBeTruthy();
        expect(config.usdc_issuer.length, `${networkName} usdc_issuer must be 56 characters`).toBe(56);
      }
    });
  });

  describe("ORDER_DEFAULT_EXPIRY_MINUTES", () => {
    it("is configured to 30 minutes and is a positive integer", () => {
      expect(ORDER_DEFAULT_EXPIRY_MINUTES).toBe(30);
      expect(Number.isInteger(ORDER_DEFAULT_EXPIRY_MINUTES)).toBe(true);
      expect(ORDER_DEFAULT_EXPIRY_MINUTES).toBeGreaterThan(0);
    });
  });

  describe("API key configuration and derived key length", () => {
    it("defines the standard live and test prefixes and entropy byte size", () => {
      expect(API_KEY_PREFIX).toBe("sk_live_");
      expect(API_KEY_PREFIX_TEST).toBe("sk_test_");
      expect(API_KEY_PREFIXES).toEqual(["sk_live_", "sk_test_"]);
      expect(API_KEY_BYTES).toBe(32);
    });

    it("recognizes both live and test prefixes correctly", () => {
      expect(hasApiKeyPrefix("sk_live_12345")).toBe(true);
      expect(hasApiKeyPrefix("sk_test_12345")).toBe(true);
      expect(hasApiKeyPrefix("sk_sandbox_12345")).toBe(false);
      expect(hasApiKeyPrefix("Bearer sk_live_123")).toBe(false);
    });

    it("extracts bearer API keys cleanly", () => {
      expect(extractBearerApiKey("Bearer sk_live_abc123")).toBe("sk_live_abc123");
      expect(extractBearerApiKey("Bearer sk_test_xyz789")).toBe("sk_test_xyz789");
      expect(extractBearerApiKey("Bearer sk_fake_000000")).toBeNull();
      expect(extractBearerApiKey("Bearer jwt.token.here")).toBeNull();
      expect(extractBearerApiKey("Basic sk_live_abc123")).toBeNull();
      expect(extractBearerApiKey(null)).toBeNull();
      expect(extractBearerApiKey(undefined)).toBeNull();
    });

    it("asserts derived key length numerically (prefix + 2 hex chars per byte)", () => {
      // 32 random bytes hex-encoded produce 64 hexadecimal characters
      // sk_live_ and sk_test_ prefix are 8 characters -> Total derived API key length is 72
      for (const prefix of API_KEY_PREFIXES) {
        const prefixLength = prefix.length;
        const hexEntropyLength = API_KEY_BYTES * 2;
        const derivedKeyLength = prefixLength + hexEntropyLength;

        expect(prefixLength).toBe(8);
        expect(hexEntropyLength).toBe(64);
        expect(derivedKeyLength).toBe(72);
      }
    });
  });

  describe("Stellar ledger constants", () => {
    it("enforces standard Stellar public address and memo hash lengths", () => {
      expect(STELLAR_ADDRESS_LENGTH).toBe(56);
      expect(MEMO_HASH_HEX_LENGTH).toBe(64);
      expect(ASSET_CODES.USDC).toBe("USDC");
      expect(USDC_ASSET_CODE).toBe("USDC");
    });
  });
});
