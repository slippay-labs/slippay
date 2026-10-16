import {
  validateChainEnvironment,
  type EnvironmentDescriptor,
  type ChainConfigInput,
} from "@slippay/shared";

export { validateChainEnvironment, type EnvironmentDescriptor, type ChainConfigInput };

export function readChainEnvironmentConfig(): ChainConfigInput {
  return {
    stellarNetwork: (import.meta.env.VITE_STELLAR_NETWORK as string | undefined) ?? "TESTNET",
    solanaNetwork: import.meta.env.VITE_SOLANA_NETWORK as string | undefined,
    solanaUsdcMint: import.meta.env.VITE_SOLANA_USDC_MINT as string | undefined,
    baseNetwork: import.meta.env.VITE_BASE_NETWORK as string | undefined,
    baseUsdcAddress: import.meta.env.VITE_BASE_USDC as string | undefined,
  };
}

let envDescriptor: EnvironmentDescriptor | null = null;

/**
 * Returns the validated cross-chain environment descriptor.
 * Validates the full chain configuration as a consistent unit at startup.
 */
export function getChainEnvironmentDescriptor(): EnvironmentDescriptor {
  if (!envDescriptor) {
    envDescriptor = validateChainEnvironment(readChainEnvironmentConfig());
  }
  return envDescriptor;
}

export function resetChainEnvironmentDescriptorForTesting(): void {
  envDescriptor = null;
}
