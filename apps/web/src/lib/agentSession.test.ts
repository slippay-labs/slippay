import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  generateSessionKey,
  normalizeSessionPubkey,
  buildConnectRequest,
  parseConnectRequest,
  type ConnectRequest,
} from "./agentSession.ts";

const sampleRequest = (): ConnectRequest => ({
  v: 1,
  session_pubkey: "ab".repeat(32),
  requested: {
    token: "USDC",
    per_tx_cap: "5",
    window_seconds: 86400,
    window_cap: "50",
    expires_at: 2_000_000_000,
    allow_recipients: [],
    policy_uri: "https://agent.example/policy.json",
  },
  agent: { name: "Budget Bot", domain: "agent.example" },
  callback: "https://agent.example/connect/cb",
});

describe("generateSessionKey", () => {
  it("mints an ed25519 key with hex pubkey, G-address and S-secret", () => {
    const k = generateSessionKey();

    expect(k.pubkeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(k.address).toMatch(/^G[A-Z0-9]{55}$/);
    expect(k.secret).toMatch(/^S[A-Z0-9]{55}$/);
    // The displayed G-address must normalize back to the same on-chain hex.
    expect(normalizeSessionPubkey(k.address)).toBe(k.pubkeyHex);
  });

  it("produces a unique key each call", () => {
    expect(generateSessionKey().pubkeyHex).not.toBe(generateSessionKey().pubkeyHex);
  });
});

describe("normalizeSessionPubkey", () => {
  it("lowercases a 64-hex public key and trims surrounding whitespace", () => {
    const hex = "AB".repeat(32);
    expect(normalizeSessionPubkey(`  ${hex}  `)).toBe(hex.toLowerCase());
  });

  it("accepts a G-address and returns its canonical hex", () => {
    const kp = Keypair.random();
    const expected = Buffer.from(kp.rawPublicKey()).toString("hex");

    expect(normalizeSessionPubkey(kp.publicKey())).toBe(expected);
  });

  it("rejects anything that is neither a G-address nor 64-hex, with a specific reason", () => {
    expect(() => normalizeSessionPubkey("not-a-key")).toThrow(/invalid session key/);
    expect(() => normalizeSessionPubkey("ab".repeat(31))).toThrow(/invalid session key/);
    expect(() => normalizeSessionPubkey("")).toThrow(/invalid session key/);
  });
});

describe("connect request handshake (§3)", () => {
  it("round-trips a request through build → parse", () => {
    const req = sampleRequest();

    const parsed = parseConnectRequest(buildConnectRequest(req));

    expect(parsed).toEqual(req);
  });

  it("rejects a request with an unsupported version or missing surface", () => {
    const wrongVersion = btoa(unescape(encodeURIComponent(JSON.stringify({ v: 2, session_pubkey: "x", requested: {} }))));
    expect(() => parseConnectRequest(wrongVersion)).toThrow(/malformed connect request/);

    const missingRequested = btoa(unescape(encodeURIComponent(JSON.stringify({ v: 1, session_pubkey: "x" }))));
    expect(() => parseConnectRequest(missingRequested)).toThrow(/malformed connect request/);

    const missingPubkey = btoa(unescape(encodeURIComponent(JSON.stringify({ v: 1, requested: {} }))));
    expect(() => parseConnectRequest(missingPubkey)).toThrow(/malformed connect request/);
  });
});
