// Build unsigned Soroban transactions for slippay-subscription contract
// invocations. The api never holds the buyer's secret — it returns the
// unsigned XDR; the buyer signs externally (Freighter, Lab, or our SDK)
// and submits via stellar-sdk SorobanRpc.

import {
  Address, BASE_FEE, Contract, Networks, Operation,
  rpc as SorobanRpc, TransactionBuilder, nativeToScVal, xdr,
} from "npm:@stellar/stellar-sdk@13";
import { hexToBuf } from "@slippay/shared";

export interface SorobanConfig {
  network: "testnet" | "mainnet";
  rpcUrl: string;
  passphrase: string;
}

export const DEFAULT_SOROBAN_RPC: Record<"testnet" | "mainnet", string> = {
  testnet: "https://soroban-testnet.stellar.org",
  mainnet: "https://soroban-mainnet.stellar.org",
};

export function resolveSorobanRpcUrl(network: "testnet" | "mainnet"): string {
  const globalRpc = Deno.env.get("SOROBAN_RPC");
  if (globalRpc && globalRpc.trim().length > 0) return globalRpc.trim();

  const envKey = network === "mainnet" ? "SOROBAN_RPC_MAINNET" : "SOROBAN_RPC_TESTNET";
  const netRpc = Deno.env.get(envKey);
  if (netRpc && netRpc.trim().length > 0) return netRpc.trim();

  return DEFAULT_SOROBAN_RPC[network];
}

export function getSorobanConfig(network: "testnet" | "mainnet"): SorobanConfig {
  return {
    network,
    rpcUrl: resolveSorobanRpcUrl(network),
    passphrase: network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET,
  };
}

export const SOROBAN_NET: Record<"testnet" | "mainnet", SorobanConfig> = {
  get testnet() {
    return getSorobanConfig("testnet");
  },
  get mainnet() {
    return getSorobanConfig("mainnet");
  },
};

export class SorobanRpcTransportError extends Error {
  public readonly rpcUrl: string;
  constructor(message: string, rpcUrl: string) {
    super(message);
    this.name = "SorobanRpcTransportError";
    this.rpcUrl = rpcUrl;
  }
}

export interface BuildChargeTxArgs {
  contractId: string;
  subscriptionNonce: string;  // 32-byte hex
  buyerAddress: string;
  network: "testnet" | "mainnet";
  fee?: string;
  timeoutSeconds?: number;
}

export interface BuildChargeTxResult {
  unsigned_xdr: string;
  contract_id: string;
  subscription_nonce: string;
  buyer_address: string;
  network: "testnet" | "mainnet";
  passphrase: string;
  rpc_url: string;
  next_due_at?: number;        // from simulation, if available
  simulation_ok: boolean;
  simulation_error?: string;
}

/**
 * Build an unsigned transaction that invokes contract.charge(id).
 * Returns the XDR for the buyer to sign externally and submit.
 *
 * The buyer's account must:
 *   - exist on Stellar with at least 1 XLM reserve (free via friendbot on testnet)
 *   - hold sufficient amount of the SAC token to cover the charge
 *   - sign the returned XDR (their Stellar wallet adds the auth signature)
 */
export async function buildChargeTransaction(
  args: BuildChargeTxArgs,
): Promise<BuildChargeTxResult> {
  const cfg = getSorobanConfig(args.network);
  const rpc = new SorobanRpc.Server(cfg.rpcUrl);

  // 1. Load buyer account (need its sequence number)
  let account;
  try {
    account = await rpc.getAccount(args.buyerAddress);
  } catch (e: unknown) {
    const msg = String((e as Error)?.message ?? e);
    // Audit-004 · M7: Distinguish transport / network / connection errors from account missing.
    // If Soroban RPC is unreachable, degraded, or returns gateway/timeout errors, report as transport error.
    if (
      msg.includes("fetch failed") ||
      msg.includes("ECONNREFUSED") ||
      msg.includes("ENOTFOUND") ||
      msg.includes("ETIMEDOUT") ||
      msg.includes("network") ||
      msg.includes("502") ||
      msg.includes("503") ||
      msg.includes("504") ||
      msg.includes("Failed to fetch")
    ) {
      throw new SorobanRpcTransportError(`soroban RPC unreachable at ${cfg.rpcUrl}: ${msg}`, cfg.rpcUrl);
    }
    throw new Error(`buyer account not found on ${args.network}: ${args.buyerAddress}`);
  }

  // 2. Build the contract.charge(id) operation
  const contract = new Contract(args.contractId);
  const nonceBytes = hexToBuf(args.subscriptionNonce);
  if (nonceBytes.length !== 32) {
    throw new Error(`subscription_nonce must be 32 bytes (64 hex chars); got ${nonceBytes.length}`);
  }
  const op = contract.call("charge", nativeToScVal(nonceBytes, { type: "bytes" }));

  // 3. Assemble transaction
  const tx = new TransactionBuilder(account, {
    fee: args.fee ?? BASE_FEE,
    networkPassphrase: cfg.passphrase,
  })
    .addOperation(op)
    .setTimeout(args.timeoutSeconds ?? 60)
    .build();

  // 4. Simulate to discover auth requirements + resource fees + return value
  let sim;
  try {
    sim = await rpc.simulateTransaction(tx);
  } catch (e: unknown) {
    const msg = String((e as Error)?.message ?? e);
    throw new SorobanRpcTransportError(`soroban RPC simulate failed at ${cfg.rpcUrl}: ${msg}`, cfg.rpcUrl);
  }
  if (SorobanRpc.Api.isSimulationError(sim)) {
    return {
      unsigned_xdr: tx.toXDR(),
      contract_id: args.contractId,
      subscription_nonce: args.subscriptionNonce,
      buyer_address: args.buyerAddress,
      network: args.network,
      passphrase: cfg.passphrase,
      rpc_url: cfg.rpcUrl,
      simulation_ok: false,
      simulation_error: sim.error,
    };
  }

  // 5. Assemble (adds resource footprint + Soroban fees)
  const assembled = SorobanRpc.assembleTransaction(tx, sim).build();

  // Pull the simulated return value (next_due_at) if present
  let nextDueAt: number | undefined;
  if (sim.result?.retval) {
    try {
      const ret = sim.result.retval;
      // charge() returns u64 = next_due_at
      const u64 = ret.u64();
      nextDueAt = Number(u64.toString());
    } catch {
      // ignore — return value extraction is best-effort
    }
  }

  return {
    unsigned_xdr: assembled.toXDR(),
    contract_id: args.contractId,
    subscription_nonce: args.subscriptionNonce,
    buyer_address: args.buyerAddress,
    network: args.network,
    passphrase: cfg.passphrase,
    rpc_url: cfg.rpcUrl,
    next_due_at: nextDueAt,
    simulation_ok: true,
  };
}
