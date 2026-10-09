import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DEFAULT_PLATFORM_FEE_BP } from "@slippay/shared";

type QuoteModule = typeof import("./quote.ts");

let quote: QuoteModule;

const okFetch = (brlPerUsd: number) =>
  vi.fn().mockResolvedValue({ json: async () => ({ rates: { BRL: brlPerUsd } }) });

beforeEach(async () => {
  vi.resetModules();
  vi.restoreAllMocks();
  // Re-import per test so the module-level mid-rate cache never bleeds across cases.
  quote = await import("./quote.ts");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("quoteBRLtoUSDC — fee and rate math", () => {
  it("charges no margin when the spread is zero", async () => {
    vi.stubGlobal("fetch", okFetch(5));

    const q = await quote.quoteBRLtoUSDC(100, 0);

    expect(q.midRate).toBe(5);
    expect(q.quotedRate).toBe(5);
    expect(q.usdcOut).toBe(20);
    expect(q.usdcAtMid).toBe(20);
    expect(q.marginUsd).toBe(0);
    expect(q.marginBrl).toBe(0);
    expect(q.stale).toBe(false);
  });

  it("applies the canonical platform fee (DEFAULT_PLATFORM_FEE_BP = 297)", async () => {
    vi.stubGlobal("fetch", okFetch(4));

    const q = await quote.quoteBRLtoUSDC(100, DEFAULT_PLATFORM_FEE_BP);

    expect(DEFAULT_PLATFORM_FEE_BP).toBe(297);
    expect(q.spreadBps).toBe(297);
    // 4 BRL/USD × (1 + 0.0297) = 4.1188 BRL/USD the buyer effectively pays.
    expect(q.quotedRate.toFixed(4)).toBe("4.1188");
    // Explicit expected strings — never floating-point equality.
    expect(q.usdcOut.toFixed(7)).toBe("24.2789162");
    expect(q.marginUsd).toBeGreaterThan(0);
  });

  it("uses the module's default spread and pins it (changing it breaks this test)", async () => {
    vi.stubGlobal("fetch", okFetch(5));

    // VITE_FX_SPREAD_BPS default is 190 bps.
    expect(quote.SPREAD_PCT).toBe(1.9);

    const q = await quote.quoteBRLtoUSDC(100);

    expect(q.spreadBps).toBe(190);
    expect(q.usdcOut.toFixed(7)).toBe("19.6270854");
  });

  it("resolves USDC out to the 7-fraction limit without trailing drift", async () => {
    vi.stubGlobal("fetch", okFetch(5));

    const q = await quote.quoteBRLtoUSDC(190);

    expect(q.usdcOut.toFixed(7)).toBe("37.2914622");
    // marginBrl is the captured margin expressed at the quoted rate.
    expect(q.marginBrl).toBeCloseTo(q.marginUsd * q.quotedRate, 10);
  });

  it("holds for the smallest and largest accepted amounts", async () => {
    vi.stubGlobal("fetch", okFetch(5));

    const small = await quote.quoteBRLtoUSDC(0.01);
    expect(small.usdcOut).toBeGreaterThan(0);
    expect(Number.isFinite(small.usdcOut)).toBe(true);

    const large = await quote.quoteBRLtoUSDC(1_000_000_000);
    expect(Number.isFinite(large.usdcOut)).toBe(true);
    expect(large.usdcOut).toBeGreaterThan(small.usdcOut);
  });
});
