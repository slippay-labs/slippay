import { NETWORK } from "./constants.ts";

export type EnvironmentTier = "mainnet" | "testnet";

export interface EnvironmentDescriptor {
  tier: EnvironmentTier;
  stellar: {
    network: "PUBLIC" | "TESTNET";
    passphrase: string;
    usdc_issuer: string;
    horizon: string;
  };
  solana: {
    network: "mainnet" | "devnet";
    usdc_mint: string;
    rpc: string;
  };
  base: {
    network: "mainnet" | "sepolia";
    chainId: number;
    usdc_address: string;
    rpc: string;
  };
}

export const ENVIRONMENTS: Record<EnvironmentTier, EnvironmentDescriptor> = {
  mainnet: {
    tier: "mainnet",
    stellar: {
      network: "PUBLIC",
      passphrase: NETWORK.mainnet.passphrase,
      usdc_issuer: NETWORK.mainnet.usdc_issuer,
      horizon: NETWORK.mainnet.horizon,
    },
    solana: {
      network: "mainnet",
      usdc_mint: "EPjFWaJGqicjsAE6b8V9bJU5kVJ86RHRK6Vbp4grmGp2",
      rpc: "https://api.mainnet-beta.solana.com",
    },
    base: {
      network: "mainnet",
      chainId: 8453,
      usdc_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      rpc: "https://mainnet.base.org",
    },
  },
  testnet: {
    tier: "testnet",
    stellar: {
      network: "TESTNET",
      passphrase: NETWORK.testnet.passphrase,
      usdc_issuer: NETWORK.testnet.usdc_issuer,
      horizon: NETWORK.testnet.horizon,
    },
    solana: {
      network: "devnet",
      usdc_mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      rpc: "https://api.devnet.solana.com",
    },
    base: {
      network: "sepolia",
      chainId: 84532,
      usdc_address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      rpc: "https://sepolia.base.org",
    },
  },
};

export interface ChainConfigInput {
  stellarNetwork?: string | null;
  stellarPassphrase?: string | null;
  stellarUsdcIssuer?: string | null;
  solanaNetwork?: string | null;
  solanaUsdcMint?: string | null;
  baseNetwork?: string | null;
  baseChainId?: number | string | null;
  baseUsdcAddress?: string | null;
}

interface ClassifiedParam {
  name: string;
  value: string;
  tier: EnvironmentTier;
}

/**
 * Validates the cross-chain environment configuration as a cohesive unit.
 * Ensures Stellar, Solana, and Base settings belong to the same tier (mainnet vs testnet).
 * Fails fast with a message explicitly naming the conflicting pair if inconsistent.
 */
export function validateChainEnvironment(config: ChainConfigInput): EnvironmentDescriptor {
  const classified: ClassifiedParam[] = [];

  // Stellar Network check
  if (config.stellarNetwork) {
    const norm = config.stellarNetwork.trim().toUpperCase();
    if (norm === "PUBLIC") {
      classified.push({ name: "Stellar network", value: norm, tier: "mainnet" });
    } else if (norm === "TESTNET") {
      classified.push({ name: "Stellar network", value: norm, tier: "testnet" });
    } else {
      throw new Error(`Invalid Stellar network value: "${config.stellarNetwork}". Expected "PUBLIC" or "TESTNET"`);
    }
  }

  // Stellar Passphrase check
  if (config.stellarPassphrase) {
    const trimmed = config.stellarPassphrase.trim();
    if (trimmed === NETWORK.mainnet.passphrase) {
      classified.push({ name: "Stellar passphrase", value: trimmed, tier: "mainnet" });
    } else if (trimmed === NETWORK.testnet.passphrase) {
      classified.push({ name: "Stellar passphrase", value: trimmed, tier: "testnet" });
    }
  }

  // Stellar USDC Issuer check
  if (config.stellarUsdcIssuer) {
    const issuer = config.stellarUsdcIssuer.trim();
    if (issuer === NETWORK.mainnet.usdc_issuer) {
      classified.push({ name: "Stellar USDC issuer", value: issuer, tier: "mainnet" });
    } else if (issuer === NETWORK.testnet.usdc_issuer) {
      classified.push({ name: "Stellar USDC issuer", value: issuer, tier: "testnet" });
    }
  }

  // Solana Network check
  if (config.solanaNetwork) {
    const norm = config.solanaNetwork.trim().toLowerCase();
    if (norm === "mainnet" || norm === "mainnet-beta") {
      classified.push({ name: "Solana network", value: norm, tier: "mainnet" });
    } else if (norm === "devnet" || norm === "testnet") {
      classified.push({ name: "Solana network", value: norm, tier: "testnet" });
    }
  }

  // Solana USDC Mint check
  if (config.solanaUsdcMint) {
    const mint = config.solanaUsdcMint.trim();
    if (mint === ENVIRONMENTS.mainnet.solana.usdc_mint) {
      classified.push({ name: "Solana USDC mint", value: mint, tier: "mainnet" });
    } else if (mint === ENVIRONMENTS.testnet.solana.usdc_mint) {
      classified.push({ name: "Solana USDC mint", value: mint, tier: "testnet" });
    }
  }

  // Base Network check
  if (config.baseNetwork) {
    const norm = config.baseNetwork.trim().toLowerCase();
    if (norm === "mainnet") {
      classified.push({ name: "Base network", value: norm, tier: "mainnet" });
    } else if (norm === "sepolia") {
      classified.push({ name: "Base network", value: norm, tier: "testnet" });
    }
  }

  // Base Chain ID check
  if (config.baseChainId !== undefined && config.baseChainId !== null) {
    const id = Number(config.baseChainId);
    if (id === 8453) {
      classified.push({ name: "Base chain ID", value: String(id), tier: "mainnet" });
    } else if (id === 84532) {
      classified.push({ name: "Base chain ID", value: String(id), tier: "testnet" });
    }
  }

  // Base USDC Address check
  if (config.baseUsdcAddress) {
    const addr = config.baseUsdcAddress.trim().toLowerCase();
    if (addr === ENVIRONMENTS.mainnet.base.usdc_address.toLowerCase()) {
      classified.push({ name: "Base USDC address", value: config.baseUsdcAddress, tier: "mainnet" });
    } else if (addr === ENVIRONMENTS.testnet.base.usdc_address.toLowerCase()) {
      classified.push({ name: "Base USDC address", value: config.baseUsdcAddress, tier: "testnet" });
    }
  }

  // Check pairwise consistency
  if (classified.length > 1) {
    const baseParam = classified[0]!;
    for (let i = 1; i < classified.length; i++) {
      const cur = classified[i]!;
      if (cur.tier !== baseParam.tier) {
        throw new Error(
          `Inconsistent chain environment configuration: ${baseParam.name} "${baseParam.value}" (${baseParam.tier}) conflicts with ${cur.name} "${cur.value}" (${cur.tier})`
        );
      }
    }
  }

  const detectedTier: EnvironmentTier = classified[0]?.tier ?? "testnet";
  return ENVIRONMENTS[detectedTier];
}

/**
 * Validates the listener's STELLAR_USDC_ISSUER_OVERRIDE parameter against the network.
 * Fail-closed if an override is provided that blatantly belongs to the opposite network tier.
 */
export function validateIssuerOverride(
  network: "PUBLIC" | "TESTNET",
  override?: string | null
): string {
  if (!override || !override.trim()) {
    return network === "PUBLIC" ? NETWORK.mainnet.usdc_issuer : NETWORK.testnet.usdc_issuer;
  }
  const cleanOverride = override.trim();

  if (network === "PUBLIC" && cleanOverride === NETWORK.testnet.usdc_issuer) {
    throw new Error(
      `Inconsistent listener configuration: STELLAR_USDC_ISSUER_OVERRIDE "${cleanOverride}" is the testnet issuer, but network is PUBLIC (mainnet)`
    );
  }

  if (network === "TESTNET" && cleanOverride === NETWORK.mainnet.usdc_issuer) {
    throw new Error(
      `Inconsistent listener configuration: STELLAR_USDC_ISSUER_OVERRIDE "${cleanOverride}" is the mainnet issuer, but network is TESTNET`
    );
  }

  return cleanOverride;
}
