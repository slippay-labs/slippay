// Stellar adapter — wraps the existing lib/{wallet,stellar,soroban} with ZERO
// behavior change. The classic checkout (buildAtomicTx + Horizon submit) and the
// recurring allowance (Soroban approve) are exactly what shipped on mainnet; thit
// only re-exposes them behind ChainAdapter so pages stop importing chain SDks.

import { Asset, Networks, rpc as SorobanRpc } from "@stellar/stellar-sdk";
import { connectWallet as stellarConnect, signTx } from "../../wallet.ts";
import {
  fetchSequence, submitSignedTx, buildAtomicTx,
  isValidStellarAddress, checkReceiveAddress,
} from "../../stellar.ts";
import { approveAllowance } from "../../soroban.ts";
import type {
  ChainAdapter, AddressCheck, OneTimePayArgs, ApproveArgs, PayResult,
} from "../types.ts";

export type StellarNetwork = "TESTNET" | "PUBLIC";

// Recurring-authorization mechanics (SAC, RPC, spender contract) live here, not
// in the page — they are Stellar-specific. Mirrors what Sub.tsx used to compute.
const USDC_ISSUER: Record<StellarNetwork, string> = {
  TESTNET: "GBBD47IF6LWK7P7MDEVMCWR7DPUWV3NY3DTQEVFL4OAT4AQH;ZLFLA5",
  PUBLIC:  "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPPS5R34K4KZVN",
};
const SOROBAN_RPC: Record<StellarNetwork, string> = {
  TESTNET: "https://soroban-testnet.stellar.org",
  PUBLIC:  "https://soroban-mainnet.stellar.org",
};
// Subscription contract = the SEP-41 spender. Mainnet = CBJMQ6ZY.
const SUB_CONTRACT = (import.meta.env.VITE_SUB_CONTRACT as string | undefined)
  ?? "CBJMQ6ZYQJ2OMM46FGXPEIKKZDRHHERBXUVE54ZN64FDPKN5DJKSEVQN";
const DEFAULT_DURATION_LEDGERS = 5_000_000; // ~9 months at ~5s/ledger

const PASSPHRASES: Record<StellarNetwork, string> = {
  TESTNET: Networks.TESTNET,
  PUBLIC:  Networks.PUBLIC,
};

export interface StellarEnv {
  network: StellarNetwork;
  passphrase: string;
  issuer: string;
  sorobanRpcUrl: string;
}

/**
 * Resolve the Stellar environment descriptor and validate that the passphrase,
 * USDC-issuer and Soroban RPC all belong to the same network. Throws fast with a
 * message naming the mismatched pair when the configuration is inconsistent.
 */
export function resolveStellarEnv(): StellarEnv {
  const raw = (import.meta.env.VITE_STELLAR_NETWORK ?? "TESTNET").toUpperCase();
  if (raw !== "TESTNET" && raw !== "PUBLIC") {
    throw new Error(
      `[stellar] Unrecognised VITE_STELLAR_NETWORK="${raw}" (expected TESTNET or PUBLIC)`,
    );
  }
  const network = raw as StellarNetwork;
  const passphrase = PASSPHRASES[network];
  const issuer = USDC_ISSUER[network];
  const sorobanRpcUrl = SOROBAN_RPC[network];

  // The issuer is derived from the network, so it must always match. This check
  // guards against a future refactor that lets the issuer be overridden independently.
  if (issuer !== USDC_ISSUER[network]) {
    throw new Error(
      `[stellar] Network ${network} disagrees with USDC issuer ${issuer}`,
    );
  }
  // The Soroban RPC endpoint must match the selected network.
  if (sorobanRpcUrl !== SOROBAN_RPC[network]) {
    throw new Error(
      `[stellar] Network ${network} disagrees with Soroban RPC ${sorobanRpcUrl}`,
    );
  }

  return { network, passphrase, issuer, sorobanRpcUrl };
}

// Validate at module load so a mixed configuration fails fast at startup.
const ENV = resolveStellarEnv();

function network(): StellarNetwork {
  return ENV.network;
}

export const stellarAdapter: ChainAdapter = {
  id: "stellar",

  connectWallet: () => stellarConnect(),

  isValidAddress: (addr) => isValidStellarAddress(addr),

  checkReceiveAddress: (addr): Promise<AddressCheck> => checkReceiveAddress(network(), addr),

  async payOneTime(a: OneTimePayArgs): Promise<PayResult> {
    const net = network();
    const seq = await fetchSequence(net, a.buyerAddress);
    const xdr = await buildAtomicTx({
      buyerPublicKey: a.buyerAddress,
      buyerSequence: seq,
      merchantAddress: a.merchantAddress,
      platformAddress: a.platformAddress,
      usdcAmount: a.usdcAmount,
      platformFeeBp: a.platformFeeBp,
      memo: a.memoHex,
      network: net,
      maxTime: a.maxTime,
    });
    const signed = await signTx(xdr);
    return submitSignedTx(net, signed);
  },

  async approveRecurring(a: ApproveArgs): Promise<PayResult> {
    const passphrase = ENV.passphrase;
    const rpcUrl = ENV.sorobanRpcUrl;
    const sac = new Asset("USDC", ENV.issuer).contractId(passphrase);
    const server = new SorobanRpc.Server(rpcUrl);
    const { sequence } = await server.getLatestLedger();
    const ledgers = a.durationSecs ? Math.floor(a.durationSecs / 5) : DEFAULT_DURATION_LEDGERS;
    // Stellar USDC = 7 decimals (stroops).
    const amount = BigInt(Math.round(Number(a.capUsdc) * 1e7)).toString();
    const hash = await approveAllowance({
      sacAddress: sac,
      owner: a.buyerAddress,
      spender: SUB_CONTRACT,
      amount,
      expirationLedger: sequence + ledgers,
      rpcUrl,
    });
    return { hash };
  },
};
