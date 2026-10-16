import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_PLATFORM_FEE_BP, DEFAULT_FX_SPREAD_BPS } from "../src/index.ts";

// Root of repository relative to packages/shared/test
const REPO_ROOT = path.resolve(__dirname, "../../..");

function readFile(relativePath: string): string {
  const fullPath = path.join(REPO_ROOT, relativePath);
  return fs.readFileSync(fullPath, "utf-8");
}

describe("Fee narrative reconciliation across docs and codebase (Issue #351)", () => {
  it("enforces canonical constants in packages/shared", () => {
    expect(DEFAULT_PLATFORM_FEE_BP).toBe(297);
    expect(DEFAULT_FX_SPREAD_BPS).toBe(190);
  });

  describe("Reconciled docs assertions", () => {
    it("README.md states 2.97% platform fee and cites DEFAULT_PLATFORM_FEE_BP", () => {
      const content = readFile("README.md");
      expect(content).toContain("2.97% platform fee");
      expect(content).toContain("DEFAULT_PLATFORM_FEE_BP = 297");
      // Must not contain legacy 2.8% or 0.98%
      expect(content).not.toMatch(/Slippay\s+2\.8%/i);
      expect(content).not.toMatch(/0\.98%/);
    });

    it("docs/business/revenue-model.md cites DEFAULT_PLATFORM_FEE_BP and 297 bp", () => {
      const content = readFile("docs/business/revenue-model.md");
      expect(content).toContain("297 basis points (2.97%)");
      expect(content).toContain("DEFAULT_PLATFORM_FEE_BP");
      expect(content).not.toMatch(/0\.98%/);
    });

    it("docs/api-reference/orders.md distinguishes platform fee (297 bp) from FX spread (190 bp)", () => {
      const content = readFile("docs/api-reference/orders.md");
      expect(content).toContain("DEFAULT_PLATFORM_FEE_BP = 297");
      expect(content).toContain("DEFAULT_FX_SPREAD_BPS = 190");
      expect(content).toMatch(/distinct from the FX conversion spread/i);
    });

    it("docs/concepts/architecture.md cites DEFAULT_PLATFORM_FEE_BP and DEFAULT_FX_SPREAD_BPS", () => {
      const content = readFile("docs/concepts/architecture.md");
      expect(content).toContain("DEFAULT_PLATFORM_FEE_BP");
      expect(content).toContain("DEFAULT_FX_SPREAD_BPS");
    });

    it("HANDOFF_MAINNET.md cites DEFAULT_PLATFORM_FEE_BP (2.97%) and DEFAULT_FX_SPREAD_BPS (190 bp)", () => {
      const content = readFile("HANDOFF_MAINNET.md");
      expect(content).toContain("DEFAULT_PLATFORM_FEE_BP = 297");
      expect(content).toContain("DEFAULT_FX_SPREAD_BPS = 190");
      expect(content).not.toMatch(/Rail fee \(~0\.3%/);
    });

    it("POSITIONING_PLAN.md clarifies production 297 bp platform fee vs long-term thesis", () => {
      const content = readFile("POSITIONING_PLAN.md");
      expect(content).toContain("DEFAULT_PLATFORM_FEE_BP = 297");
      expect(content).toContain("DEFAULT_FX_SPREAD_BPS = 190");
    });

    it("apps/web/public/llms.txt documents 2.97% platform fee and cites DEFAULT_PLATFORM_FEE_BP", () => {
      const content = readFile("apps/web/public/llms.txt");
      expect(content).toContain("DEFAULT_PLATFORM_FEE_BP = 297");
      expect(content).toContain("DEFAULT_FX_SPREAD_BPS = 190");
      expect(content).not.toContain("0.98% fee");
    });
  });

  describe("Code and configuration alignment", () => {
    it("supabase/functions/api/routes/orders.ts comment cites DEFAULT_PLATFORM_FEE_BP", () => {
      const content = readFile("supabase/functions/api/routes/orders.ts");
      expect(content).toContain("DEFAULT_PLATFORM_FEE_BP");
      expect(content).not.toContain("0.98% cut");
    });

    it("supabase/functions/api/routes/billing.ts defaults to DEFAULT_PLATFORM_FEE_BP", () => {
      const content = readFile("supabase/functions/api/routes/billing.ts");
      expect(content).toContain("merchant.platform_fee_bp ?? DEFAULT_PLATFORM_FEE_BP");
      expect(content).not.toContain("merchant.platform_fee_bp ?? 98");
    });

    it("apps/web/.env.production cites DEFAULT_PLATFORM_FEE_BP = 297", () => {
      const content = readFile("apps/web/.env.production");
      expect(content).toContain("DEFAULT_PLATFORM_FEE_BP = 297");
      expect(content).not.toContain("1% leg");
    });

    it("apps/web/src/lib/quote.ts clearly separates platform fee and FX spread", () => {
      const content = readFile("apps/web/src/lib/quote.ts");
      expect(content).toContain("DEFAULT_PLATFORM_FEE_BP");
      expect(content).toContain("DEFAULT_FX_SPREAD_BPS");
      expect(content).toContain("import.meta.env.VITE_FX_SPREAD_BPS ?? DEFAULT_FX_SPREAD_BPS");
    });
  });

  describe("No stale legacy rate assertions across tracked documents", () => {
    const TRACKED_DOCS = [
      "README.md",
      "docs/README.md",
      "docs/business/revenue-model.md",
      "docs/api-reference/orders.md",
      "docs/api-reference/merchants.md",
      "docs/concepts/architecture.md",
      "HANDOFF_MAINNET.md",
      "apps/web/public/llms.txt",
    ];

    for (const doc of TRACKED_DOCS) {
      it(`${doc} does not assert legacy 0.98% or stale 2.8%`, () => {
        const content = readFile(doc);
        expect(content).not.toMatch(/0\.98%/);
        expect(content).not.toMatch(/98\s*bp/i);
        expect(content).not.toMatch(/2\.8%/);
      });
    }
  });
});
