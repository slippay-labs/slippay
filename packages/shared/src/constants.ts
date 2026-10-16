export const NETWORK = {
  testnet: {
    horizon: "https://horizon-testnet.stellar.org",
    passphrase: "Test SDF Network ; September 2015",
    // Circle USDC issuer on Stellar testnet — verified 2026-05-07
    // https://developers.circle.com/stablecoins/stellar
    usdc_issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    // PayPal PYUSD on Stellar testnet — VERIFY BEFORE USE.
    // Set via env override (PYUSD_ISSUER_TESTNET) until SDF/PayPal publish a stable testnet pubkey.
    pyusd_issuer: null as string | null,
  },
  mainnet: {
    horizon: "https://horizon.stellar.org",
    passphrase: "Public Global Stellar Network ; September 2015",
    // Circle USDC issuer on Stellar mainnet — verified 2026-05-07
    // https://developers.circle.com/stablecoins/stellar
    usdc_issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    // PayPal PYUSD on Stellar mainnet — VERIFY ON CHAIN BEFORE PRODUCTION.
    // Live since 2025 per https://stellar.org/press/paypal-pyusd
    // Set via env override (PYUSD_ISSUER_MAINNET) until issuer pubkey is verified
    // against stellar.expert and PayPal/SDF documentation.
    pyusd_issuer: null as string | null,
  },
} as const;

export const ASSET_CODES = {
  USDC: "USDC",
  PYUSD: "PYUSD",
} as const;
export type AssetCode = keyof typeof ASSET_CODES;
// Back-compat: keep USDC_ASSET_CODE export until callers migrate.
export const USDC_ASSET_CODE = ASSET_CODES.USDC;
export const STELLAR_ADDRESS_LENGTH = 56;
export const MEMO_HASH_HEX_LENGTH = 64; // 32 bytes
export const DEFAULT_PLATFORM_FEE_BP = 297; // 2.97%
export const DEFAULT_FX_SPREAD_BPS = 190;   // 1.90%
export const MIN_FX_SPREAD_BPS = 0;         // 0% (cannot pay users to convert)
export const MAX_FX_SPREAD_BPS = 1000;      // 10.00% (aligned with platform MAX_FEE_BPS upper bound)
export const ORDER_DEFAULT_EXPIRY_MINUTES = 30;
export const API_KEY_PREFIX = "sk_live_";
export const API_KEY_BYTES = 32;

/**
 * Validates and resolves the FX spread BPS from environment configuration.
 * Fails loudly on non-numeric or out-of-range values.
 */
export function resolveFxSpreadBps(rawEnvValue?: unknown): number {
  if (rawEnvValue === undefined || rawEnvValue === null || rawEnvValue === "") {
    return DEFAULT_FX_SPREAD_BPS;
  }

  const num = typeof rawEnvValue === "number" ? rawEnvValue : Number(String(rawEnvValue).trim());
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    throw new Error(
      `[FX Config] Invalid VITE_FX_SPREAD_BPS="${rawEnvValue}": must be a valid integer between ${MIN_FX_SPREAD_BPS} and ${MAX_FX_SPREAD_BPS}`
    );
  }

  if (num < MIN_FX_SPREAD_BPS || num > MAX_FX_SPREAD_BPS) {
    throw new Error(
      `[FX Config] VITE_FX_SPREAD_BPS=${num} is out of range: must be between ${MIN_FX_SPREAD_BPS} (0%) and ${MAX_FX_SPREAD_BPS} (10%) bps.`
    );
  }

  return num;
}

