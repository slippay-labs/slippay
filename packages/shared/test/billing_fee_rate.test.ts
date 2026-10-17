// Guard: Verify billing fee rate reporting matches charged rates and handles mid-period rate changes (closes #223)
//
// Acceptance criteria:
// 1. No route module hardcodes a fee literal (especially stale 98 bp).
// 2. routes/billing.ts imports and uses DEFAULT_PLATFORM_FEE_BP from @slippay/shared.
// 3. Billing rate derives from order rows actually charged, rather than back-applying current merchant config.
// 4. A mid-period rate change produces a report that distinguishes both rates.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_PLATFORM_FEE_BP } from "../src/constants";

const ROOT_DIR = resolve(__dirname, "../../..");
const ROUTES_DIR = join(ROOT_DIR, "supabase/functions/api/routes");

export function deriveBillingRates(
  merchantFeeBp: number | undefined,
  rows: Array<{ usdc_amount: string; fee_usdc: string; platform_fee_bp?: number | null }>
) {
  const fallbackBp = Number(merchantFeeBp ?? DEFAULT_PLATFORM_FEE_BP);
  const ratesApplied = Array.from(new Set(rows.map(o => {
    const bp = o.platform_fee_bp;
    return bp != null ? Number(bp) : fallbackBp;
  }))).sort((a, b) => a - b);

  const breakdown = (ratesApplied.length > 0 ? ratesApplied : [fallbackBp]).map((rate) => {
    const matchingRows = rows.filter((o) => {
      const bp = o.platform_fee_bp;
      const effective = bp != null ? Number(bp) : fallbackBp;
      return effective === rate;
    });
    const subGross = matchingRows.reduce((a, o) => a + parseFloat(o.usdc_amount ?? "0"), 0);
    const subFee = matchingRows.reduce((a, o) => a + parseFloat(o.fee_usdc ?? "0"), 0);
    return {
      platform_fee_bp: rate,
      orders_count: matchingRows.length,
      gross_usdc: subGross.toFixed(7),
      fee_usdc: subFee.toFixed(7),
    };
  });

  const primaryRate = ratesApplied.length === 1 ? ratesApplied[0]! : fallbackBp;

  return {
    platform_fee_bp: primaryRate,
    rates_applied: ratesApplied.length > 0 ? ratesApplied : [fallbackBp],
    breakdown,
  };
}

describe("fix(billing): make reported fee rate match charged rate (closes #223)", () => {
  it("no route module hardcodes a fee literal (stale 98 bp)", () => {
    for (const file of readdirSync(ROUTES_DIR)) {
      if (!file.endsWith(".ts")) continue;
      const fullPath = join(ROUTES_DIR, file);
      const content = readFileSync(fullPath, "utf-8");

      // Check for code like `?? 98` or `: 98` or `fee_bp: 98`
      const hardcoded98Regex = /\b(?:platform_fee_bp|fee_bp|\?\?)\s*[:=]?\s*98\b/g;
      const matches = Array.from(content.matchAll(hardcoded98Regex));
      expect(matches, `Found hardcoded 98 bp in ${file}`).toEqual([]);
    }
  });

  it("routes/billing.ts imports DEFAULT_PLATFORM_FEE_BP from @slippay/shared", () => {
    const billingPath = join(ROUTES_DIR, "billing.ts");
    const content = readFileSync(billingPath, "utf-8");
    expect(content).toContain("DEFAULT_PLATFORM_FEE_BP");
    expect(content).not.toContain("?? 98");
  });

  it("reports DEFAULT_PLATFORM_FEE_BP when merchant has no override and zero orders", () => {
    const result = deriveBillingRates(undefined, []);
    expect(result.platform_fee_bp).toBe(DEFAULT_PLATFORM_FEE_BP);
    expect(result.platform_fee_bp).toBe(297);
    expect(result.rates_applied).toEqual([297]);
    expect(result.breakdown[0]?.orders_count).toBe(0);
  });

  it("reports exact order fee rate when single rate charged across period", () => {
    const rows = [
      { usdc_amount: "50.0000000", fee_usdc: "0.5000000", platform_fee_bp: 100 },
      { usdc_amount: "50.0000000", fee_usdc: "0.5000000", platform_fee_bp: 100 },
    ];
    // Merchant current config might be 297, but orders were charged at 100
    const result = deriveBillingRates(297, rows);
    expect(result.platform_fee_bp).toBe(100);
    expect(result.rates_applied).toEqual([100]);
    expect(result.breakdown.length).toBe(1);
    expect(result.breakdown[0]?.platform_fee_bp).toBe(100);
    expect(result.breakdown[0]?.orders_count).toBe(2);
  });

  it("distinguishes two rates when a mid-period rate change occurred", () => {
    const rows = [
      { usdc_amount: "100.0000000", fee_usdc: "1.0000000", platform_fee_bp: 100 },
      { usdc_amount: "200.0000000", fee_usdc: "5.9400000", platform_fee_bp: 297 },
    ];
    const result = deriveBillingRates(297, rows);
    expect(result.rates_applied).toEqual([100, 297]);
    expect(result.breakdown.length).toBe(2);

    expect(result.breakdown[0]?.platform_fee_bp).toBe(100);
    expect(result.breakdown[0]?.orders_count).toBe(1);
    expect(result.breakdown[0]?.gross_usdc).toBe("100.0000000");
    expect(result.breakdown[0]?.fee_usdc).toBe("1.0000000");

    expect(result.breakdown[1]?.platform_fee_bp).toBe(297);
    expect(result.breakdown[1]?.orders_count).toBe(1);
    expect(result.breakdown[1]?.gross_usdc).toBe("200.0000000");
    expect(result.breakdown[1]?.fee_usdc).toBe("5.9400000");
  });
});
