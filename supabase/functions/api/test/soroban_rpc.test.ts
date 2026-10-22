import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  resolveSorobanRpcUrl,
  getSorobanConfig,
  DEFAULT_SOROBAN_RPC,
  SOROBAN_NET,
  SorobanRpcTransportError,
} from "../lib/soroban.ts";

function restoreEnv(saved: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) {
      Deno.env.delete(k);
    } else {
      Deno.env.set(k, v);
    }
  }
}

Deno.test("resolveSorobanRpcUrl - returns default endpoints when no env overrides exist", () => {
  const saved = {
    SOROBAN_RPC: Deno.env.get("SOROBAN_RPC"),
    SOROBAN_RPC_TESTNET: Deno.env.get("SOROBAN_RPC_TESTNET"),
    SOROBAN_RPC_MAINNET: Deno.env.get("SOROBAN_RPC_MAINNET"),
  };

  try {
    Deno.env.delete("SOROBAN_RPC");
    Deno.env.delete("SOROBAN_RPC_TESTNET");
    Deno.env.delete("SOROBAN_RPC_MAINNET");

    assertEquals(resolveSorobanRpcUrl("testnet"), DEFAULT_SOROBAN_RPC.testnet);
    assertEquals(resolveSorobanRpcUrl("mainnet"), DEFAULT_SOROBAN_RPC.mainnet);

    const testnetCfg = getSorobanConfig("testnet");
    assertEquals(testnetCfg.rpcUrl, "https://soroban-testnet.stellar.org");

    const mainnetCfg = getSorobanConfig("mainnet");
    assertEquals(mainnetCfg.rpcUrl, "https://soroban-mainnet.stellar.org");

    assertEquals(SOROBAN_NET.testnet.rpcUrl, "https://soroban-testnet.stellar.org");
    assertEquals(SOROBAN_NET.mainnet.rpcUrl, "https://soroban-mainnet.stellar.org");
  } finally {
    restoreEnv(saved);
  }
});

Deno.test("resolveSorobanRpcUrl - respects network-specific SOROBAN_RPC_TESTNET and SOROBAN_RPC_MAINNET", () => {
  const saved = {
    SOROBAN_RPC: Deno.env.get("SOROBAN_RPC"),
    SOROBAN_RPC_TESTNET: Deno.env.get("SOROBAN_RPC_TESTNET"),
    SOROBAN_RPC_MAINNET: Deno.env.get("SOROBAN_RPC_MAINNET"),
  };

  try {
    Deno.env.delete("SOROBAN_RPC");
    Deno.env.set("SOROBAN_RPC_TESTNET", "https://soroban-testnet.custom.io:8000");
    Deno.env.set("SOROBAN_RPC_MAINNET", "https://soroban-mainnet.custom.io:8000");

    assertEquals(resolveSorobanRpcUrl("testnet"), "https://soroban-testnet.custom.io:8000");
    assertEquals(resolveSorobanRpcUrl("mainnet"), "https://soroban-mainnet.custom.io:8000");

    assertEquals(getSorobanConfig("testnet").rpcUrl, "https://soroban-testnet.custom.io:8000");
    assertEquals(getSorobanConfig("mainnet").rpcUrl, "https://soroban-mainnet.custom.io:8000");

    assertEquals(SOROBAN_NET.testnet.rpcUrl, "https://soroban-testnet.custom.io:8000");
    assertEquals(SOROBAN_NET.mainnet.rpcUrl, "https://soroban-mainnet.custom.io:8000");
  } finally {
    restoreEnv(saved);
  }
});

Deno.test("resolveSorobanRpcUrl - global SOROBAN_RPC takes highest precedence", () => {
  const saved = {
    SOROBAN_RPC: Deno.env.get("SOROBAN_RPC"),
    SOROBAN_RPC_TESTNET: Deno.env.get("SOROBAN_RPC_TESTNET"),
    SOROBAN_RPC_MAINNET: Deno.env.get("SOROBAN_RPC_MAINNET"),
  };

  try {
    Deno.env.set("SOROBAN_RPC_TESTNET", "https://testnet.ignored.com");
    Deno.env.set("SOROBAN_RPC_MAINNET", "https://mainnet.ignored.com");
    Deno.env.set("SOROBAN_RPC", "https://global-override-rpc.slippay.cc");

    assertEquals(resolveSorobanRpcUrl("testnet"), "https://global-override-rpc.slippay.cc");
    assertEquals(resolveSorobanRpcUrl("mainnet"), "https://global-override-rpc.slippay.cc");
    assertEquals(getSorobanConfig("testnet").rpcUrl, "https://global-override-rpc.slippay.cc");
    assertEquals(getSorobanConfig("mainnet").rpcUrl, "https://global-override-rpc.slippay.cc");
  } finally {
    restoreEnv(saved);
  }
});

Deno.test("SorobanRpcTransportError - captures custom error name and target rpcUrl", () => {
  const targetUrl = "https://soroban-gateway.fails.io";
  const err = new SorobanRpcTransportError("fetch failed: ECONNREFUSED", targetUrl);

  assertEquals(err.name, "SorobanRpcTransportError");
  assertEquals(err.rpcUrl, targetUrl);
  assertEquals(err.message, "fetch failed: ECONNREFUSED");
});
