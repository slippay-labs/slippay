import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, Address, rpc as SorobanRpc, Horizon, xdr } from "@stellar/stellar-sdk";
import { createSlipPayServer } from "./index.ts";
import * as chain from "./chain.ts";

// Valid Stellar Ed25519 test keypair (randomly generated for unit testing)
const TEST_KP = Keypair.random();
const TEST_SECRET = TEST_KP.secret();
const TEST_PUBKEY = TEST_KP.publicKey();
const TEST_CONTRACT = "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE";
const TEST_MERCHANT = Keypair.random().publicKey();

describe("SlipPay MCP Server Role Gate & Membrane Boundary", () => {
  it("default role (agent) registers only membrane tools and strictly excludes privileged verbs", () => {
    const server = createSlipPayServer("agent");
    const tools = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);

    // Agent must get only safe / verified / read tools
    expect(tools).toContain("slippay_verify");
    expect(tools).toContain("slippay_whoami");
    expect(tools).toContain("slippay_charge_attested");
    expect(tools).toContain("slippay_status");
    expect(tools.length).toBe(4);

    // Privileged verbs MUST NOT be exposed to an agent (membrane principle)
    expect(tools).not.toContain("slippay_pay");
    expect(tools).not.toContain("slippay_subscribe");
    expect(tools).not.toContain("slippay_approve");
    expect(tools).not.toContain("slippay_autocharge");
    expect(tools).not.toContain("slippay_arm_gate");
  });

  it("principal role registers the full suite including all privileged payment verbs", () => {
    const server = createSlipPayServer("principal");
    const tools = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);

    expect(tools).toEqual(
      expect.arrayContaining([
        "slippay_verify",
        "slippay_whoami",
        "slippay_pay",
        "slippay_subscribe",
        "slippay_approve",
        "slippay_autocharge",
        "slippay_charge_attested",
        "slippay_arm_gate",
        "slippay_status",
      ])
    );
    expect(tools.length).toBe(9);
  });
});

describe("SlipPay MCP Tool Input Schemas", () => {
  const server = createSlipPayServer("principal");
  const registered = (server as unknown as { _registeredTools: Record<string, { inputSchema: any }> })._registeredTools;

  describe("slippay_subscribe schema bounds", () => {
    const schema = registered["slippay_subscribe"].inputSchema;

    it("accepts valid subscription inputs with period >= 86400", () => {
      const res = schema.safeParse({
        merchant: TEST_MERCHANT,
        amount: "9.00",
        period_seconds: 86400,
      });
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.max_periods).toBe(0);
        expect(res.data.expires_at).toBe(0);
      }
    });

    it("rejects period_seconds less than contract minimum 86400 (1 day)", () => {
      const res = schema.safeParse({
        merchant: TEST_MERCHANT,
        amount: "9.00",
        period_seconds: 86399, // 1 second below 86400 bound
      });
      expect(res.success).toBe(false);
    });

    it("rejects negative max_periods and negative expires_at", () => {
      expect(schema.safeParse({ merchant: TEST_MERCHANT, amount: "9.00", period_seconds: 86400, max_periods: -1 }).success).toBe(false);
      expect(schema.safeParse({ merchant: TEST_MERCHANT, amount: "9.00", period_seconds: 86400, expires_at: -1 }).success).toBe(false);
    });
  });

  describe("slippay_pay schema bounds", () => {
    const schema = registered["slippay_pay"].inputSchema;

    it("accepts valid recipient and amount, defaulting asset to USDC", () => {
      const res = schema.safeParse({
        recipient: TEST_MERCHANT,
        amount: "15.50",
      });
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.asset).toBe("USDC");
      }
    });

    it("rejects missing recipient or amount", () => {
      expect(schema.safeParse({ recipient: TEST_MERCHANT }).success).toBe(false);
      expect(schema.safeParse({ amount: "15.50" }).success).toBe(false);
    });
  });

  describe("slippay_charge_attested schema bounds", () => {
    const schema = registered["slippay_charge_attested"].inputSchema;

    it("accepts valid attested charge parameters", () => {
      const res = schema.safeParse({
        subscription_id: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        not_after: 1800000000,
        signature: "a".repeat(128),
      });
      expect(res.success).toBe(true);
    });

    it("rejects non-integer not_after", () => {
      const res = schema.safeParse({
        subscription_id: "abc",
        not_after: 123.45,
        signature: "sig",
      });
      expect(res.success).toBe(false);
    });
  });

  describe("slippay_arm_gate schema bounds", () => {
    const schema = registered["slippay_arm_gate"].inputSchema;

    it("requires subscription_id and attester_pubkey strings", () => {
      const res = schema.safeParse({
        subscription_id: "sub-123",
        attester_pubkey: "pub-456",
      });
      expect(res.success).toBe(true);
    });

    it("fails when required fields are missing", () => {
      expect(schema.safeParse({ subscription_id: "sub-123" }).success).toBe(false);
      expect(schema.safeParse({ attester_pubkey: "pub-456" }).success).toBe(false);
    });
  });
});

describe("SlipPay Chain Builders & Security Guards", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.SLIPPAY_SIGNER_SECRET;
    delete process.env.SLIPPAY_CONTRACT;
    chain.resetSubmitter();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    chain.resetSubmitter();
    vi.restoreAllMocks();
  });

  it("throws a descriptive error when SLIPPAY_SIGNER_SECRET is missing rather than signing with a default", async () => {
    expect(() => chain.whoami()).toThrowError(/SLIPPAY_SIGNER_SECRET not set/);
    await expect(chain.pay(TEST_MERCHANT, "1.00")).rejects.toThrowError(/SLIPPAY_SIGNER_SECRET not set/);
  });

  it("throws a descriptive error when SLIPPAY_CONTRACT is missing for subscription ops", async () => {
    process.env.SLIPPAY_SIGNER_SECRET = TEST_SECRET;
    await expect(chain.subscribe(TEST_MERCHANT, "9.00", 86400)).rejects.toThrowError(/SLIPPAY_CONTRACT not set/);
    await expect(chain.autocharge("0123456789abcdef")).rejects.toThrowError(/SLIPPAY_CONTRACT not set/);
    await expect(chain.armGate("0123456789abcdef", "pubkey")).rejects.toThrowError(/SLIPPAY_CONTRACT not set/);
  });

  it("whoami derives the correct Stellar public address when secret is provided", () => {
    process.env.SLIPPAY_SIGNER_SECRET = TEST_SECRET;
    expect(chain.whoami()).toBe(TEST_PUBKEY);
  });

  it("encodes ScVal primitives accurately (scAddr, scI128, scU64, scU32, scBytes)", () => {
    const addrVal = chain.scAddr(TEST_MERCHANT);
    expect(addrVal.switch()).toBe(xdr.ScValType.scvAddress());

    const i128Val = chain.scI128("105000000");
    expect(i128Val.switch()).toBe(xdr.ScValType.scvI128());

    const u64Val = chain.scU64(86400);
    expect(u64Val.switch()).toBe(xdr.ScValType.scvU64());

    const u32Val = chain.scU32(12);
    expect(u32Val.switch()).toBe(xdr.ScValType.scvU32());

    const hex = "deadbeef";
    const bytesVal = chain.scBytes(hex);
    expect(bytesVal.switch()).toBe(xdr.ScValType.scvBytes());
    expect(bytesVal.bytes().toString("hex")).toBe(hex);
  });

  it("generates 32-byte (64 hex characters) random nonce", () => {
    const nonce1 = chain.randomNonceHex();
    const nonce2 = chain.randomNonceHex();
    expect(nonce1).toHaveLength(64);
    expect(nonce2).toHaveLength(64);
    expect(nonce1).not.toBe(nonce2);
  });

  it("constructs correct transaction arguments across all chain ops", async () => {
    process.env.SLIPPAY_SIGNER_SECRET = TEST_SECRET;
    process.env.SLIPPAY_CONTRACT = TEST_CONTRACT;

    let recordedTarget = "";
    let recordedFn = "";
    let recordedArgs: xdr.ScVal[] = [];

    chain.setSubmitter(async (contractId, fn, args) => {
      recordedTarget = contractId;
      recordedFn = fn;
      recordedArgs = args;
      return {
        hash: "mock-tx-hash-001",
        status: "SUCCESS",
        explorer: chain.explorerTx("mock-tx-hash-001"),
      };
    });

    // 1. pay: 2.50 USDC -> 25,000,000 stroops
    const payRes = await chain.pay(TEST_MERCHANT, "2.50", "USDC");
    expect(payRes.hash).toBe("mock-tx-hash-001");
    expect(recordedTarget).toBe(chain.usdcSacId());
    expect(recordedFn).toBe("transfer");
    expect(recordedArgs.length).toBe(3);
    expect(recordedArgs[0].switch()).toBe(xdr.ScValType.scvAddress()); // sender
    expect(recordedArgs[1].switch()).toBe(xdr.ScValType.scvAddress()); // recipient
    expect(recordedArgs[2].switch()).toBe(xdr.ScValType.scvI128()); // stroops
    // Check decoded stroops
    const i128 = recordedArgs[2].i128();
    const stroops = (BigInt(i128.hi().toString()) << 64n) + BigInt(i128.lo().toString());
    expect(stroops).toBe(25000000n);

    // 2. subscribe: 9.00 USDC, 86400 period, 12 max_periods, 1800000000 expiresAt
    const subRes = await chain.subscribe(TEST_MERCHANT, "9.00", 86400, 12, 1800000000);
    expect(subRes.subscription_id).toBeDefined();
    expect(subRes.subscription_id).toHaveLength(64);
    expect(recordedTarget).toBe(TEST_CONTRACT);
    expect(recordedFn).toBe("create");
    expect(recordedArgs.length).toBe(8);
    expect(recordedArgs[0].switch()).toBe(xdr.ScValType.scvAddress()); // payer (whoami)
    expect(recordedArgs[1].switch()).toBe(xdr.ScValType.scvAddress()); // merchant
    expect(recordedArgs[2].switch()).toBe(xdr.ScValType.scvAddress()); // usdc sac id
    expect(recordedArgs[3].switch()).toBe(xdr.ScValType.scvI128());    // amount stroops (90000000)
    expect(recordedArgs[4].switch()).toBe(xdr.ScValType.scvU64());     // period_seconds (86400)
    expect(recordedArgs[5].switch()).toBe(xdr.ScValType.scvU32());     // max_periods (12)
    expect(recordedArgs[6].switch()).toBe(xdr.ScValType.scvU64());     // expires_at (1800000000)
    expect(recordedArgs[7].switch()).toBe(xdr.ScValType.scvBytes());   // nonce (subscription_id)

    // 3. approve: 108.00 allowance cap, ledger 500000
    const appRes = await chain.approve("108.00", 500000);
    expect(appRes.status).toBe("SUCCESS");
    expect(recordedTarget).toBe(chain.usdcSacId());
    expect(recordedFn).toBe("approve");
    expect(recordedArgs.length).toBe(4);
    expect(recordedArgs[0].switch()).toBe(xdr.ScValType.scvAddress()); // from (whoami)
    expect(recordedArgs[1].switch()).toBe(xdr.ScValType.scvAddress()); // spender (subContract)
    expect(recordedArgs[2].switch()).toBe(xdr.ScValType.scvI128());    // amount (1080000000 stroops)
    expect(recordedArgs[3].switch()).toBe(xdr.ScValType.scvU32());     // expiration_ledger (500000)

    // 4. autocharge: subscription_id
    const autoRes = await chain.autocharge("0123456789abcdef");
    expect(autoRes.status).toBe("SUCCESS");
    expect(recordedTarget).toBe(TEST_CONTRACT);
    expect(recordedFn).toBe("autocharge");
    expect(recordedArgs.length).toBe(1);
    expect(recordedArgs[0].switch()).toBe(xdr.ScValType.scvBytes());

    // 5. autochargeAttested: subscription_id, notAfter, signatureHex
    const attestRes = await chain.autochargeAttested("0123456789abcdef", 1800000000, "11223344");
    expect(attestRes.status).toBe("SUCCESS");
    expect(recordedTarget).toBe(TEST_CONTRACT);
    expect(recordedFn).toBe("autocharge_attested");
    expect(recordedArgs.length).toBe(3);
    expect(recordedArgs[0].switch()).toBe(xdr.ScValType.scvBytes());
    expect(recordedArgs[1].switch()).toBe(xdr.ScValType.scvU64());
    expect(recordedArgs[2].switch()).toBe(xdr.ScValType.scvBytes());

    // 6. armGate: subscription_id, attesterPubkeyHex
    const armRes = await chain.armGate("0123456789abcdef", "55667788");
    expect(armRes.status).toBe("SUCCESS");
    expect(recordedTarget).toBe(TEST_CONTRACT);
    expect(recordedFn).toBe("set_attester");
    expect(recordedArgs.length).toBe(2);
    expect(recordedArgs[0].switch()).toBe(xdr.ScValType.scvBytes());
    expect(recordedArgs[1].switch()).toBe(xdr.ScValType.scvBytes());
  });

  it("defaultSubmit handles simulation error from Soroban RPC gracefully", async () => {
    process.env.SLIPPAY_SIGNER_SECRET = TEST_SECRET;

    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockResolvedValue({
      accountId: () => TEST_PUBKEY,
      sequenceNumber: () => "100",
      incrementSequenceNumber: () => {},
    } as any);

    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue({
      error: "HostError: Error(Contract, #123)",
    } as any);

    await expect(
      chain.defaultSubmit(TEST_CONTRACT, "test_call", [chain.scU32(1)])
    ).rejects.toThrowError(/simulation failed \(test_call\): HostError/);
  });

  it("queries transaction status via Horizon Server", async () => {
    vi.spyOn(Horizon.Server.prototype, "transactions").mockReturnValue({
      transaction: (hash: string) => ({
        call: async () => ({
          successful: true,
          ledger_attr: 1234567,
          created_at: "2026-10-25T12:00:00Z",
        }),
      }),
    } as any);

    const st: any = await chain.txStatus("some-tx-hash");
    expect(st.found).toBe(true);
    expect(st.successful).toBe(true);
    expect(st.ledger).toBe(1234567);
  });

  it("gracefully reports not found on Horizon error", async () => {
    vi.spyOn(Horizon.Server.prototype, "transactions").mockReturnValue({
      transaction: (hash: string) => ({
        call: async () => {
          throw new Error("Transaction not found");
        },
      }),
    } as any);

    const st: any = await chain.txStatus("missing-tx-hash");
    expect(st.found).toBe(false);
    expect(st.detail).toContain("Transaction not found");
  });
});
