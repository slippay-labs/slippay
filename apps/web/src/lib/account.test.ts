import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadAccount, saveAccount, clearAccount, type Account } from "./account.ts";

const sampleAccount: Account = {
  walletId: "wid_test_123",
  credIdHex: "cred_aabbcc",
  pubKeyHex: "pub_112233",
  network: "TESTNET",
  funded: "10.0",
  createdAt: "2026-10-16T12:00:00Z",
};

class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number { return this.store.size; }
  clear(): void { this.store.clear(); }
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  key(index: number): string | null { return Array.from(this.store.keys())[index] ?? null; }
  removeItem(key: string): void { this.store.delete(key); }
  setItem(key: string, value: string): void { this.store.set(key, String(value)); }
}

describe("account storage helper", () => {
  let mockStorage: MemoryStorage;

  beforeEach(() => {
    mockStorage = new MemoryStorage();
    vi.stubGlobal("localStorage", mockStorage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns null when no account is stored", () => {
    expect(loadAccount()).toBeNull();
  });

  it("saves and loads an account correctly", () => {
    saveAccount(sampleAccount);
    const loaded = loadAccount();
    expect(loaded).toEqual(sampleAccount);
  });

  it("clears an account from storage", () => {
    saveAccount(sampleAccount);
    expect(loadAccount()).not.toBeNull();
    clearAccount();
    expect(loadAccount()).toBeNull();
  });

  it("gracefully returns null if stored JSON is corrupted", () => {
    mockStorage.setItem("slippay.account.v1", "not_valid_json{{");
    expect(loadAccount()).toBeNull();
  });

  it("does not throw if setItem fails (private browsing quota)", () => {
    vi.spyOn(mockStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => saveAccount(sampleAccount)).not.toThrow();
  });

  it("does not throw if removeItem fails", () => {
    vi.spyOn(mockStorage, "removeItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(() => clearAccount()).not.toThrow();
  });

  it("returns null when storage is unavailable (Node / SSR without localStorage)", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(loadAccount()).toBeNull();
    expect(() => saveAccount(sampleAccount)).not.toThrow();
    expect(() => clearAccount()).not.toThrow();
  });
});
