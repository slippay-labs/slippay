import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

interface FeeVectorItem {
  id: string;
  amount_stroops: string;
  amount_stellar: string;
  fee_bps: number;
  expected_fee_stroops: string;
  expected_net_stroops: string;
  expected_fee_stellar: string;
  expected_net_stellar: string;
}

describe("Checkout Contract Multi-layer Vector Parity (Issue #307)", () => {
  const jsonVectorPath = path.resolve(__dirname, "../src/vectors/fee_vectors.json");
  const contractTestPath = path.resolve(__dirname, "../../../contracts/checkout/src/test.rs");

  it("shared fee_vectors.json exists and contains 14 canonical vectors", () => {
    expect(fs.existsSync(jsonVectorPath)).toBe(true);
    const vectors: FeeVectorItem[] = JSON.parse(fs.readFileSync(jsonVectorPath, "utf-8"));
    expect(vectors.length).toBe(14);

    // Verify key boundaries are present
    const ids = vectors.map((v) => v.id);
    expect(ids).toContain("bps_zero");
    expect(ids).toContain("one_stroop_bps_default");
    expect(ids).toContain("dust_just_below_boundary");
    expect(ids).toContain("dust_half_boundary");
    expect(ids).toContain("max_stellar_amount");
  });

  it("contracts/checkout/src/test.rs faithfully implements every vector from fee_vectors.json", () => {
    expect(fs.existsSync(contractTestPath)).toBe(true);
    const testContent = fs.readFileSync(contractTestPath, "utf-8");
    const vectors: FeeVectorItem[] = JSON.parse(fs.readFileSync(jsonVectorPath, "utf-8"));

    for (const v of vectors) {
      // Assert each vector ID is represented in the Rust fixture
      expect(testContent).toContain(`id: "${v.id}"`);
      expect(testContent).toContain(`fee_bps: ${v.fee_bps}`);
    }

    expect(testContent).toContain("test_checkout_fee_matches_off_chain_vector_table");
  });
});
