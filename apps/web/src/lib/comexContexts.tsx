/**
 * Shared wallet context definitions for the three SlipPay testnet rails
 * (Base/EVM, Stellar custody, Solana). Kept in a dedicated module so the
 * provider components can live under a single React Refresh boundary and
 * only export components.
 */
import { createContext, useContext } from "react";
import type { Transaction } from "@solana/web3.js";

export interface SendTxArgs {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
}

export interface ComexBaseCtx {
  ready: boolean;
  authenticated: boolean;
  email: string | null;
  /** 0x-prefixed EVM address of the Privy embedded wallet. Null before wallet is created. */
  address: `0x${string}` | null;
  login: () => void;
  logout: () => Promise<void>;
  /**
   * Send an EVM transaction via the Privy embedded wallet.
   * Uses useSendTransaction from @privy-io/react-auth/tempo (tempo.d.ts line 14).
   * Returns { hash } — the on-chain tx hash.
   *
   * Gate contract: caller (baseAuthorize.ts) MUST invoke this only AFTER:
   *   build → decode → assert → human-confirm have all passed.
   */
  sendTransaction: (args: SendTxArgs) => Promise<{ hash: `0x${string}` }>;
}

export const ComexBaseContext = createContext<ComexBaseCtx>({
  ready: false,
  authenticated: false,
  email: null,
  address: null,
  login: () => {},
  logout: async () => {},
  sendTransaction: async () => {
    throw new Error("comexBase: wallet not ready");
  },
});

export interface ComexWalletCtx {
  ready: boolean;
  authenticated: boolean;
  email: string | null;
  /** Stellar account ID (G... address) of the user's Privy-managed Ed25519 wallet. */
  address: string | null;
  walletId: string | null;
  login: () => void;
  logout: () => Promise<void>;
  /**
   * Signs a raw 32-byte hash using the Stellar Ed25519 embedded wallet via
   * useSignRawHash from @privy-io/react-auth/extended-chains.
   * Returns a 64-byte Buffer (Ed25519 r+s signature, no EIP-191 prefix).
   */
  signHash: (hash: Buffer) => Promise<Buffer>;
}

export const ComexWalletContext = createContext<ComexWalletCtx>({
  ready: false,
  authenticated: false,
  email: null,
  address: null,
  walletId: null,
  login: () => {},
  logout: async () => {},
  signHash: async () => Buffer.alloc(0),
});

export interface ComexSolanaCtx {
  ready: boolean;
  authenticated: boolean;
  email: string | null;
  /** Base58 Solana pubkey of the Privy embedded wallet. Null before wallet is created. */
  address: string | null;
  login: () => void;
  logout: () => Promise<void>;
  /**
   * Sign a @solana/web3.js Transaction (legacy) using the Privy Solana embedded wallet.
   * Does NOT submit to the network — the security gate (authorizeSolanaPayment) calls
   * this only after build→decode→assert→human-confirm have all passed.
   *
   * VERIFY-WITH-KEYS: signTransaction from @privy-io/react-auth/solana (solana.d.ts line 260-261).
   * Accepts: { transaction: Uint8Array, wallet: ConnectedStandardSolanaWallet }
   * Returns: { signedTransaction: Uint8Array } — caller deserializes with Transaction.from().
   */
  signTransaction: (tx: Transaction) => Promise<Transaction>;
}

export const ComexSolanaContext = createContext<ComexSolanaCtx>({
  ready: false,
  authenticated: false,
  email: null,
  address: null,
  login: () => {},
  logout: async () => {},
  signTransaction: async () => {
    throw new Error("comexSolana: wallet not ready");
  },
});

// Hooks live here (not in the provider modules) so the provider files only
// export components — required by react-refresh/only-export-components.
export function useComexBaseWallet(): ComexBaseCtx {
  return useContext(ComexBaseContext);
}

export function useComexWallet(): ComexWalletCtx {
  return useContext(ComexWalletContext);
}

export function useComexSolanaWallet(): ComexSolanaCtx {
  return useContext(ComexSolanaContext);
}
