import { describe, it, expect, vi } from "vitest";
import {
  isContractId,
  subIdToBytes,
  stroopsToUnits,
  unitsToStroops,
  sacFor,
  judgeObligation,
  readObligation,
  readTransfer,
  type Obligation,
  type Transfer,
} from "./chainVerify.ts";
import { StrKey, xdr, rpc } from "@stellar/stellar-sdk";

describe("chainVerify helpers", () => {
  describe("isContractId", () => {
    it("recognizes valid Stellar contract IDs", () => {
      // Valid contract ID (C... 56 chars)
      const validC = "CBJMQ6ZYQJ2OMM46FGXPEIKKZDRHHERBXUVE54ZN64FDPKN5DJKSEVQN";
      expect(isContractId(validC)).toBe(true);
    });

    it("rejects invalid contract IDs or regular account addresses", () => {
      expect(isContractId("GBBKIN4ZQWJUND63GSFEXLKZFLXZ3J265FPGYKPLGXA34QYSAFFC3C5X")).toBe(false);
      expect(isContractId("invalid_c_id")).toBe(false);
      expect(isContractId("")).toBe(false);
    });
  });

  describe("subIdToBytes", () => {
    it("decodes 64-char hex strings with or without 0x prefix", () => {
      const hex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      const bytes1 = subIdToBytes(hex);
      expect(bytes1.length).toBe(32);
      expect(bytes1[0]).toBe(0x01);
      expect(bytes1[31]).toBe(0xef);

      const bytes2 = subIdToBytes("0x" + hex);
      expect(bytes2.length).toBe(32);
      expect(bytes2).toEqual(bytes1);
    });

    it("decodes base64 and base64url strings", () => {
      const bytes = new Uint8Array(32);
      for (let i = 0; i < 32; i++) bytes[i] = i;
      const b64 = Buffer.from(bytes).toString("base64");
      const decoded = subIdToBytes(b64);
      expect(decoded.length).toBe(32);
      expect(decoded[0]).toBe(0);
      expect(decoded[31]).toBe(31);

      // base64url variant
      const b64url = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const decodedUrl = subIdToBytes(b64url);
      expect(decodedUrl).toEqual(decoded);
    });

    it("throws when decoded length is not 32 bytes", () => {
      expect(() => subIdToBytes("010203")).toThrow(/32 bytes/);
    });
  });

  describe("stroopsToUnits and unitsToStroops", () => {
    it("round-trips positive and negative amounts with 7 decimals", () => {
      expect(stroopsToUnits(3_000_000n)).toBe("0.3000000");
      expect(unitsToStroops("0.3000000")).toBe(3_000_000n);

      expect(stroopsToUnits(100_000_000n)).toBe("10.0000000");
      expect(unitsToStroops("10.0000000")).toBe(100_000_000n);

      expect(stroopsToUnits(-15_000_000n)).toBe("-1.5000000");
      expect(unitsToStroops("-1.5000000")).toBe(-15_000_000n);

      expect(stroopsToUnits(1n)).toBe("0.0000001");
      expect(unitsToStroops("0.0000001")).toBe(1n);
    });

    it("throws on malformed unit amount strings", () => {
      expect(() => unitsToStroops("invalid")).toThrow(/bad amount/);
      expect(() => unitsToStroops("10.12345678")).toThrow(/bad amount/);
    });
  });

  describe("sacFor", () => {
    it("derives SAC contract ID for native XLM and issued tokens", () => {
      const nativeSac = sacFor("public", "native", "XLM");
      expect(isContractId(nativeSac)).toBe(true);

      const issuer = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
      const usdcSac = sacFor("public", "credit_alphanum4", "USDC", issuer);
      expect(isContractId(usdcSac)).toBe(true);
      expect(usdcSac).not.toBe(nativeSac);
    });
  });
});

describe("judgeObligation", () => {
  const merchant = "GC4HWUN3LGTPZTU3ET2COOBPSWEV6IZHPCWOJURPG6FD7KAX6OAGM6UZ";
  const token = "CBJMQ6ZYQJ2OMM46FGXPEIKKZDRHHERBXUVE54ZN64FDPKN5DJKSEVQN";

  const validObligation: Obligation = {
    merchant,
    token,
    amountStroops: 50_000_000n,
    status: "Active",
  };

  const validTransfer: Transfer = {
    to: merchant,
    amount: "5.0000000",
    amountStroops: 50_000_000n,
    assetType: "credit_alphanum4",
    assetCode: "USDC",
    sac: token,
  };

  it("returns green verdict when transfer satisfies obligation completely", () => {
    const verdict = judgeObligation(validObligation, validTransfer);
    expect(verdict.ok).toBe(true);
    expect(verdict.mismatches).toEqual([]);
    expect(verdict.recipientOk).toBe(true);
    expect(verdict.amountOk).toBe(true);
    expect(verdict.assetOk).toBe(true);
    expect(verdict.statusOk).toBe(true);
  });

  it("detects and flags recipient mismatch", () => {
    const tamperedTransfer: Transfer = {
      ...validTransfer,
      to: "GBBKIN4ZQWJUND63GSFEXLKZFLXZ3J265FPGYKPLGXA34QYSAFFC3C5X",
    };
    const verdict = judgeObligation(validObligation, tamperedTransfer);
    expect(verdict.ok).toBe(false);
    expect(verdict.recipientOk).toBe(false);
    expect(verdict.mismatches).toContain("recipient");
  });

  it("detects and flags amount mismatch", () => {
    const tamperedTransfer: Transfer = {
      ...validTransfer,
      amountStroops: 49_999_999n,
    };
    const verdict = judgeObligation(validObligation, tamperedTransfer);
    expect(verdict.ok).toBe(false);
    expect(verdict.amountOk).toBe(false);
    expect(verdict.mismatches).toContain("amount");
  });

  it("detects and flags asset mismatch", () => {
    const tamperedTransfer: Transfer = {
      ...validTransfer,
      sac: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    };
    const verdict = judgeObligation(validObligation, tamperedTransfer);
    expect(verdict.ok).toBe(false);
    expect(verdict.assetOk).toBe(false);
    expect(verdict.mismatches).toContain("asset");
  });

  it("flags inactive or cancelled status", () => {
    const cancelledObligation: Obligation = {
      ...validObligation,
      status: "Cancelled",
    };
    const verdict = judgeObligation(cancelledObligation, validTransfer);
    expect(verdict.ok).toBe(false);
    expect(verdict.statusOk).toBe(false);
    expect(verdict.mismatches).toContain("status");
  });
});

describe("readObligation and readTransfer network paths", () => {
  it("readObligation validates contract ID before RPC invocation", async () => {
    await expect(readObligation("public", "bad_contract", "010203")).rejects.toThrow(/invalid contract id/);
  });

  it("readTransfer returns undefined on 404 from Horizon", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const t = await readTransfer("public", "tx_hash_123");
    expect(t).toBeUndefined();
  });

  it("readTransfer parses account_credited and debited effects correctly", async () => {
    const mockJson = {
      _embedded: {
        records: [
          {
            type: "account_credited",
            account: "GC4HWUN3LGTPZTU3ET2COOBPSWEV6IZHPCWOJURPG6FD7KAX6OAGM6UZ",
            amount: "10.0000000",
            asset_type: "native",
          },
          {
            type: "account_debited",
            account: "GBBKIN4ZQWJUND63GSFEXLKZFLXZ3J265FPGYKPLGXA34QYSAFFC3C5X",
            amount: "10.0000000",
            asset_type: "native",
          },
        ],
      },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockJson),
    }));

    const t = await readTransfer("public", "valid_tx_hash");
    expect(t).toBeDefined();
    expect(t?.to).toBe("GC4HWUN3LGTPZTU3ET2COOBPSWEV6IZHPCWOJURPG6FD7KAX6OAGM6UZ");
    expect(t?.from).toBe("GBBKIN4ZQWJUND63GSFEXLKZFLXZ3J265FPGYKPLGXA34QYSAFFC3C5X");
    expect(t?.amount).toBe("10.0000000");
    expect(t?.amountStroops).toBe(100_000_000n);
    expect(t?.assetCode).toBe("XLM");
  });
});
