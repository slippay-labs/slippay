import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

describe("Historical fee integrity and backfill chronological isolation (Issue #227)", () => {
  const repoRoot = resolve(__dirname, "../../..");
  const migrationsDir = resolve(repoRoot, "supabase/migrations");
  const bpMigrationPath = resolve(migrationsDir, "20261008120000_orders_platform_fee_bp_constraints.sql");
  const feeUsdcMigrationPath = resolve(migrationsDir, "20261008130000_orders_fee_usdc_constraints.sql");
  const billingRoutePath = resolve(repoRoot, "supabase/functions/api/routes/billing.ts");

  it("verifies migration sequence order: platform_fee_bp (120000) precedes fee_usdc (130000)", () => {
    expect(existsSync(bpMigrationPath)).toBe(true);
    expect(existsSync(feeUsdcMigrationPath)).toBe(true);
  });

  describe("Platform fee bp migration (20261008120000)", () => {
    const content = readFileSync(bpMigrationPath, "utf-8");

    it("adds fee_inferred boolean column", () => {
      expect(content).toContain("add column if not exists fee_inferred boolean not null default false");
    });

    it("isolates pre-fee snapshot era (< 2026-05-26) with 0 bp and fee_inferred = true", () => {
      expect(content).toContain("created_at < '2026-05-26 11:46:00+00'");
      expect(content).toContain("platform_fee_bp = 0");
      expect(content).toContain("fee_inferred = true");
    });

    it("respects 98 bp era (2026-05-26 to 2026-06-05) and does not rewrite to 297 bp", () => {
      expect(content).toContain("created_at < '2026-06-05 21:00:00+00'");
      expect(content).toContain("platform_fee_bp = 98");
    });

    it("does NOT backfill historical orders from merchant's current configuration", () => {
      expect(content.includes("from merchants m")).toBe(false);
      expect(content.includes("m.platform_fee_bp")).toBe(false);
    });

    it("enforces NOT NULL, default 297, and [0, 1000] CHECK", () => {
      expect(content).toContain("default 297");
      expect(content).toContain("set not null");
      expect(content).toContain("check (platform_fee_bp between 0 and 1000)");
    });
  });

  describe("Fee USDC migration (20261008130000)", () => {
    const content = readFileSync(feeUsdcMigrationPath, "utf-8");

    it("calculates fee_usdc using trunc and order's own platform_fee_bp", () => {
      expect(content).toContain("trunc(usdc_amount * platform_fee_bp / 10000.0, 7)");
    });

    it("does NOT query merchant table for fee_usdc backfill", () => {
      expect(content.includes("from merchants m")).toBe(false);
      expect(content.includes("m.platform_fee_bp")).toBe(false);
    });

    it("enforces numeric(20,7), NOT NULL, and non-negative check", () => {
      expect(content).toContain("type numeric(20,7)");
      expect(content).toContain("set not null");
      expect(content).toContain("check (fee_usdc >= 0 and fee_usdc <= usdc_amount and scale(fee_usdc) <= 7)");
    });
  });

  describe("Billing route exclusion of inferred fees", () => {
    it("excludes fee_inferred orders from commercial billing calculation", () => {
      const src = readFileSync(billingRoutePath, "utf-8");
      expect(src).toContain('.eq("fee_inferred", false)');
    });
  });
});
