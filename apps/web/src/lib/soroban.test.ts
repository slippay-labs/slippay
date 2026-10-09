import { describe, it, expect, vi } from "vitest";

// wallet.ts initializes the browser wallet-kit at import time — stub it out so
// the module can be loaded in the node test environment.
vi.mock("./wallet.ts", () => ({ signTx: vi.fn(async (xdr: string) => xdr) }));

import { requestOnchainCharge } from "./soroban.ts";
import { Asset, Networks } from "@stellar/stellar-sdk";

const SAC = Asset.native().contractId(Networks.TESTNET);

describe("requestOnchainCharge — API → unsigned XDR", () => {
  it("POSTs buyer_address and returns the assembled charge", async () => {
    const oc = {
      unsigned_xdr: "AAAA",
      rpc_url: "https://rpc.example",
      passphrase: "Test SDF Network ; September 2015",
      contract_id: SAC,
      simulation_ok: true,
      next_due_at: 42,
    };
    const post = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ onchain_charge: oc }) });
    vi.stubGlobal("fetch", post);

    await expect(requestOnchainCharge("https://api.example", "sub1", "GBUYER", "sk_live_key")).resolves.toEqual(oc);

    const [url, opts] = post.mock.calls[0]! as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe("https://api.example/v1/subscriptions/sub1/onchain-charge");
    expect(opts.method).toBe("POST");
    expect(opts.headers.authorization).toBe("Bearer sk_live_key");
    expect(JSON.parse(opts.body)).toEqual({ buyer_address: "GBUYER" });
  });

  it("throws the API detail on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ detail: "subscription_not_found" }) }));

    await expect(requestOnchainCharge("https://api.example", "nope", "GBUYER", "k")).rejects.toThrow("subscription_not_found");
  });

  it("rejects an un-simulated charge rather than signing garbage", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ onchain_charge: { simulation_ok: false, simulation_error: "host trap" } }),
    }));

    await expect(requestOnchainCharge("https://api.example", "sub1", "GBUYER", "k")).rejects.toThrow(/simulation_failed: host trap/);
  });
});
