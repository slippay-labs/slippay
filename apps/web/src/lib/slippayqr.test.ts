import { describe, it, expect } from "vitest";
import { encodeRequest, decodeRequest, type PayRequest } from "./slippayqr.ts";

// A known-valid Stellar ed25519 public key (56 chars, base32). The decoder only
// shape-checks against /^[GC][A-Z2-7]{55}$/, so these round-trips are
// independent of parsePaymentQr and of any real network/account lookup.
const TO = "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37";
const TO_2 = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

describe("encodeRequest → decodeRequest round-trip", () => {
  it("round-trips a minimal payload and compares the whole object", () => {
    const request: PayRequest = { to: TO, amount: "3000000" };

    const encoded = encodeRequest(request);
    const decoded = decodeRequest(encoded);

    // Whole-object equality, not per-field: encode/decode asymmetry fails here.
    expect(decoded).toEqual(request);
  });

  it("round-trips a fully-populated payload (asset + label)", () => {
    const request: PayRequest = { to: TO, amount: "15000000", asset: "USDC", label: "Café com leite ☕" };

    expect(decodeRequest(encodeRequest(request))).toEqual(request);
  });

  it("round-trips the XLM asset variant", () => {
    const request: PayRequest = { to: TO_2, amount: "1", asset: "XLM", label: "nota" };

    expect(decodeRequest(encodeRequest(request))).toEqual(request);
  });

  it("emits the documented slippay:pay URI shape", () => {
    expect(encodeRequest({ to: TO, amount: "3000000" })).toBe(`slippay:pay?to=${TO}&amount=3000000`);
    expect(encodeRequest({ to: TO, amount: "3000000", asset: "USDC" })).toBe(
      `slippay:pay?to=${TO}&amount=3000000&asset=USDC`,
    );
  });

  it("treats a missing asset as the legacy (XLM) default", () => {
    expect(decodeRequest(`slippay:pay?to=${TO}&amount=10`).asset).toBeUndefined();
  });
});
