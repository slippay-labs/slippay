import { describe, it, expect, vi, beforeEach } from "vitest";

const { authModal, signTransaction } = vi.hoisted(() => ({
  authModal: vi.fn(),
  signTransaction: vi.fn(),
}));

vi.mock("@creit.tech/stellar-wallets-kit", () => ({
  StellarWalletsKit: {
    init: vi.fn(),
    authModal,
    signTransaction,
  },
  Networks: {
    PUBLIC: "Public Global Stellar Network ; September 2015",
    TESTNET: "Test SDF Network ; September 2015",
  },
}));

vi.mock("@creit.tech/stellar-wallets-kit/modules/freighter", () => ({
  FREIGHTER_ID: "freighter",
  FreighterModule: vi.fn(),
}));
vi.mock("@creit.tech/stellar-wallets-kit/modules/lobstr", () => ({ LobstrModule: vi.fn() }));
vi.mock("@creit.tech/stellar-wallets-kit/modules/xbull", () => ({ xBullModule: vi.fn() }));
vi.mock("@creit.tech/stellar-wallets-kit/modules/albedo", () => ({ AlbedoModule: vi.fn() }));
vi.mock("@creit.tech/stellar-wallets-kit/modules/hana", () => ({ HanaModule: vi.fn() }));

import { connectWallet, signTx, NETWORK } from "./wallet.ts";

describe("wallet helper (StellarWalletsKit wrapper)", () => {
  beforeEach(() => {
    authModal.mockReset();
    signTransaction.mockReset();
  });

  it("exports correct Stellar network configuration", () => {
    expect(NETWORK).toBeDefined();
  });

  describe("connectWallet", () => {
    it("returns connected address on successful modal authentication", async () => {
      authModal.mockResolvedValue({ address: "GC4HWUN3LGTPZTU3ET2COOBPSWEV6IZHPCWOJURPG6FD7KAX6OAGM6UZ" });
      const address = await connectWallet();
      expect(address).toBe("GC4HWUN3LGTPZTU3ET2COOBPSWEV6IZHPCWOJURPG6FD7KAX6OAGM6UZ");
      expect(authModal).toHaveBeenCalledTimes(1);
    });

    it("propagates error when user closes or rejects auth modal", async () => {
      authModal.mockRejectedValue(new Error("User closed modal"));
      await expect(connectWallet()).rejects.toThrow("User closed modal");
    });
  });

  describe("signTx", () => {
    it("signs transaction with networkPassphrase and returns signed XDR", async () => {
      signTransaction.mockResolvedValue({ signedTxXdr: "AAAA_MOCK_SIGNED_XDR" });
      const result = await signTx("AAAA_UNSIGNED_XDR");
      expect(result).toBe("AAAA_MOCK_SIGNED_XDR");
      expect(signTransaction).toHaveBeenCalledWith("AAAA_UNSIGNED_XDR", {
        networkPassphrase: NETWORK,
      });
    });

    it("propagates error when signing is rejected by wallet", async () => {
      signTransaction.mockRejectedValue(new Error("Transaction rejected by user"));
      await expect(signTx("AAAA_XDR")).rejects.toThrow("Transaction rejected by user");
    });
  });
});
