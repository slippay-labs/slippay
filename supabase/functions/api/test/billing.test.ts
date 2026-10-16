import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { req } from "./_helpers.ts";
import { aggregatePeriodTotals, decimalToStroops, stroopsToDecimal } from "@slippay/shared";

Deno.test("GET /v1/billing/fees without auth returns 401", async () => {
  const res = await req("/v1/billing/fees");
  assertEquals(res.status, 401);
});

Deno.test("aggregatePeriodTotals handles 10,000 awkward fraction rows with zero difference", () => {
  const N = 10_000;
  const fixture: Array<{ usdc_amount: string; fee_usdc: string }> = [];

  let expectedGrossStroops = 0n;
  let expectedFeeStroops = 0n;

  for (let i = 0; i < N; i++) {
    // Awkward fractions that trigger IEEE-754 precision issues when summed with parseFloat
    const usdc = i % 2 === 0 ? "1.0000001" : "0.0000001";
    const fee = i % 2 === 0 ? "0.0002970" : "0.0000001";

    fixture.push({ usdc_amount: usdc, fee_usdc: fee });
    expectedGrossStroops += decimalToStroops(usdc);
    expectedFeeStroops += decimalToStroops(fee);
  }

  const totals = aggregatePeriodTotals(fixture);

  // Assert exact integer sum
  assertEquals(totals.gross_stroops, expectedGrossStroops);
  assertEquals(totals.fee_stroops, expectedFeeStroops);
  assertEquals(totals.net_stroops, expectedGrossStroops - expectedFeeStroops);

  // Difference for a 10,000-row fixture is asserted to be exactly zero
  const difference = totals.gross_stroops - expectedGrossStroops;
  assertEquals(difference, 0n);

  // Decimal formatting checks
  assertEquals(totals.gross_usdc, stroopsToDecimal(expectedGrossStroops));
  assertEquals(totals.fee_usdc_total, stroopsToDecimal(expectedFeeStroops));
  assertEquals(totals.net_usdc_total, stroopsToDecimal(expectedGrossStroops - expectedFeeStroops));
});
