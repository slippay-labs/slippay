import { describe, it, expect } from "vitest";
import { derToRaw64 } from "./passkey.ts";

const subtle = globalThis.crypto.subtle;

// DER INTEGER TLV: strip superfluous leading zeros, prepend 0x00 if the high
// bit would otherwise read as a sign bit.
function derInt(bytes: Uint8Array): Uint8Array {
  let b = bytes;
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  b = b.slice(i);
  const body = b[0]! & 0x80 ? Uint8Array.from([0, ...b]) : b;
  return Uint8Array.from([0x02, body.length, ...body]);
}

function derSignature(r: Uint8Array, s: Uint8Array): Uint8Array {
  const body = [...derInt(r), ...derInt(s)];
  return Uint8Array.from([0x30, body.length, ...body]);
}

// WebCrypto ECDSA returns raw r||s (P1363); wrap it in DER to mimic what a
// platform authenticator hands back to a WebAuthn relying party.
function rawToDer(raw: Uint8Array): Uint8Array {
  return derSignature(raw.slice(0, 32), raw.slice(32, 64));
}

const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

async function p256Pair() {
  return subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
}

async function signDer(privateKey: CryptoKey, msg: Uint8Array): Promise<Uint8Array> {
  return rawToDer(new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, msg)));
}

function verifyP256(pub: CryptoKey, raw64: Uint8Array, msg: Uint8Array): Promise<boolean> {
  return subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, raw64, msg);
}

describe("derToRaw64 — DER (WebAuthn) → raw 64-byte secp256r1 r||s", () => {
  it("accepts a real P-256 assertion built from a known key pair", async () => {
    const { publicKey, privateKey } = await p256Pair();
    const msg = new Uint8Array([1, 2, 3, 4, 5]);

    const raw = derToRaw64(await signDer(privateKey, msg));

    expect(raw.length).toBe(64);
    // The converted r||s must still verify against the known public key.
    await expect(verifyP256(publicKey, raw, msg)).resolves.toBe(true);
  });

  it("rejects a tampered signature (verification fails for the same key/message)", async () => {
    const { publicKey, privateKey } = await p256Pair();
    const msg = new Uint8Array([9, 8, 7]);

    const raw = derToRaw64(await signDer(privateKey, msg));
    const tampered = Uint8Array.from(raw);
    tampered[0] = tampered[0]! ^ 0xff;

    await expect(verifyP256(publicKey, tampered, msg)).resolves.toBe(false);
  });

  it("rejects an assertion whose challenge does not match the pending payload", async () => {
    const { publicKey, privateKey } = await p256Pair();
    const challengeA = new Uint8Array([10, 20, 30]);
    const challengeB = new Uint8Array([10, 20, 31]);

    const raw = derToRaw64(await signDer(privateKey, challengeA));

    await expect(verifyP256(publicKey, raw, challengeA)).resolves.toBe(true);
    await expect(verifyP256(publicKey, raw, challengeB)).resolves.toBe(false);
  });

  it("low-S normalizes an otherwise-valid high-S signature", () => {
    const r = Uint8Array.from([...new Uint8Array(31), 0x01]);
    // s = P256_N - 1 is above N/2 → malleable, must fold to N - s = 1.
    const sHigh = Uint8Array.from(Buffer.from((P256_N - 1n).toString(16).padStart(64, "0"), "hex"));

    const raw = derToRaw64(derSignature(r, sHigh));

    expect(toHex(raw.slice(0, 32))).toBe(toHex(r));
    expect(toHex(raw.slice(32, 64))).toBe("0".repeat(63) + "1");
  });

  it("left-pads short r/s integers to 32 bytes each", () => {
    const raw = derToRaw64(derSignature(Uint8Array.from([0x01]), Uint8Array.from([0x02])));

    expect(raw.length).toBe(64);
    expect(toHex(raw.slice(0, 32))).toBe("0".repeat(63) + "1");
    expect(toHex(raw.slice(32, 64))).toBe("0".repeat(63) + "2");
  });

  it("throws on a malformed/mutilated DER payload (no silent fallback)", () => {
    // SEQUENCE with no INTEGER anywhere.
    expect(() => derToRaw64(Uint8Array.from([0x30, 0x00]))).toThrow(/bad DER signature \(r\)/);
    // r present, s tag replaced by a bogus 0x03.
    expect(() =>
      derToRaw64(Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x03, 0x01, 0x01])),
    ).toThrow(/bad DER signature \(s\)/);
    // Empty payload.
    expect(() => derToRaw64(new Uint8Array(0))).toThrow(/bad DER signature \(r\)/);
  });
});
