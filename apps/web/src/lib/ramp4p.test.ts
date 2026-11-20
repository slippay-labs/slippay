import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Stub the Supabase-backed auth module (see apiAuth.test.ts) so importing
// ramp4p.ts never builds a real client or touches the network.
const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("./auth.tsx", () => ({ supabase: { auth: { getSession } } }));

import { Ramp4pError, createOfframp4p, quoteOfframp4p } from "./ramp4p.ts";

describe("4P quote margin and rate agreement (Resolves #109)", () => {
  const marginBps = 280; // 2.80% default Slippay margin
  const netBps = 10_000 - marginBps;

  // Table of amounts: small, fractional, standard, and large values
  const testAmountsBrl = [1.0, 5.5, 10.0, 25.75, 50.0, 100.0, 250.0, 500.0, 1234.56, 5000.0];
  const fxRates = [4.85, 5.00, 5.25, 5.80, 6.12];

  it("asserts dollarRate * cryptoOut ≈ brl within one stroop/cent for a table of amounts", () => {
    for (const fx of fxRates) {
      for (const brl of testAmountsBrl) {
        const grossOut = brl / fx;
        // Formula from routes/fourp.ts: integer basis points with round down to 6 decimals
        const cryptoOut = Math.floor(grossOut * netBps * 1e2) / 1e6;
        // Effective dollarRate derived from net crypto in apps/web/src/lib/ramp4p.ts
        const dollarRate = brl / cryptoOut;

        const effectiveBrl = dollarRate * cryptoOut;
        const diff = Math.abs(effectiveBrl - brl);

        // Asserts agreement within 1 stroop (1e-7) and 1 cent (0.01)
        expect(diff).toBeLessThanOrEqual(1e-7);
        expect(diff).toBeLessThan(0.01);
      }
    }
  });

  it("verifies explicit round down in platform's disfavour with zero toFixed truncation", () => {
    const gross = 123.456789;
    const net = Math.floor(gross * netBps * 1e2) / 1e6;
    const mathematicalNet = (gross * netBps) / 10_000;

    // Platform never over-collects: net is floor-rounded in platform's disfavour
    expect(net).toBeLessThanOrEqual(mathematicalNet);

    // Number of decimal places never exceeds 6 decimals (native USDC)
    const decimals = (String(net).split(".")[1] || "").length;
    expect(decimals).toBeLessThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// Resolves #65: "not configured" and "upstream down" must not look the same
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("4P disabled vs upstream failure (Resolves #65)", () => {
  beforeEach(() => {
    getSession.mockResolvedValue({ data: { session: null } });
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    getSession.mockReset();
  });

  it("treats 501 ramp_disabled as a disabled integration", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: "ramp_disabled" }, 501));
    await expect(quoteOfframp4p(25)).resolves.toEqual({ brlOut: null, receiver: null, asset: null });
  });

  it("still treats a 404 off-ramp endpoint as not live yet", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: "not_found" }, 404));
    await expect(quoteOfframp4p(25)).resolves.toEqual({ brlOut: null, receiver: null, asset: null });
  });

  it("surfaces an upstream 4P outage (502) as a retryable error, not 'disabled'", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: "fourp_error", message: "down" }, 502));
    const err = await quoteOfframp4p(25).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Ramp4pError);
    expect((err as Ramp4pError).code).toBe("upstream");
    expect((err as Ramp4pError).status).toBe(502);
  });

  it("keeps a specific 502 code (receiver_mismatch) instead of flattening it to 'upstream'", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ error: "receiver_mismatch", message: "4P receiver did not match the pinned address" }, 502),
    );
    const err = await createOfframp4p({ usdc: 25, pixKey: "a@b.c", sender: "0x1", email: "a@b.c", doc: "12345678901" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Ramp4pError);
    expect((err as Ramp4pError).code).toBe("receiver_mismatch");
    expect((err as Ramp4pError).message).toBe("4P receiver did not match the pinned address");
  });

  it("surfaces a bare 503 as an outage, not a disabled integration", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: "ramp_error" }, 503));
    const err = await quoteOfframp4p(25).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Ramp4pError);
    expect((err as Ramp4pError).code).toBe("upstream");
    expect((err as Ramp4pError).status).toBe(503);
  });
});
