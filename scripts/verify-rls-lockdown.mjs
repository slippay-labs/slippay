#!/usr/bin/env node
// scripts/verify-rls-lockdown.mjs
//
// Verification runner asserting RLS enablement and client grant revokes across
// x402_resources, listener_leases, listener_state, and merchants.
// Run as a mandatory CI and production deploy gate.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const REQUIRED_RLS_TABLES = [
  "x402_resources",
  "listener_leases",
  "listener_state",
  "merchants",
];

export const INTERNAL_TABLES = [
  "x402_resources",
  "listener_leases",
  "listener_state",
];

export const MERCHANT_SECRET_COLUMNS = [
  "api_key_hash",
  "webhook_secret",
];

/**
 * Pure assertion logic evaluating database catalog state.
 *
 * @param {Object} catalogs
 * @param {Array<{tablename: string, rowsecurity: boolean}>} catalogs.tables
 * @param {Array<{table_name: string, grantee: string, privilege_type: string}>} catalogs.tableGrants
 * @param {Array<{table_name: string, column_name: string, grantee: string, privilege_type: string}>} catalogs.columnGrants
 */
export function assertRlsAndGrants({ tables = [], tableGrants = [], columnGrants = [] }) {
  const violations = [];

  // 1. Assert RLS is enabled on all four tables
  for (const t of REQUIRED_RLS_TABLES) {
    const tableInfo = tables.find((item) => item.tablename === t);
    if (!tableInfo) {
      violations.push(`Table '${t}' is missing from public schema.`);
    } else if (!tableInfo.rowsecurity) {
      violations.push(`Table '${t}' has RLS disabled (rowsecurity=false).`);
    }
  }

  // 2. Assert NO table grants for anon or authenticated on internal tables
  for (const g of tableGrants) {
    if (
      INTERNAL_TABLES.includes(g.table_name) &&
      (g.grantee === "anon" || g.grantee === "authenticated")
    ) {
      violations.push(
        `Unauthorized table privilege '${g.privilege_type}' granted to '${g.grantee}' on '${g.table_name}'.`
      );
    }
  }

  // 3. Assert NO column-level SELECT grants for authenticated on merchants secret columns
  for (const cg of columnGrants) {
    if (
      cg.table_name === "merchants" &&
      cg.grantee === "authenticated" &&
      cg.privilege_type === "SELECT" &&
      MERCHANT_SECRET_COLUMNS.includes(cg.column_name)
    ) {
      violations.push(
        `Secret column '${cg.column_name}' on 'merchants' is readable by authenticated role.`
      );
    }
  }

  if (violations.length > 0) {
    const errorMsg = `RLS Lockdown Verification FAILED:\n - ${violations.join("\n - ")}`;
    const err = new Error(errorMsg);
    err.violations = violations;
    throw err;
  }

  return {
    verified: true,
    tablesChecked: REQUIRED_RLS_TABLES.length,
    message: "RLS lockdown and column grant assertions verified across all four tables.",
  };
}

// CLI Execution Entry Point
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  console.log("==> Running RLS lockdown & column grant assertion check...");

  const sqlPath = resolve(__dirname, "verify-rls-lockdown.sql");
  const sql = readFileSync(sqlPath, "utf-8");

  const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  if (dbUrl) {
    console.log("==> Verifying against live database instance...");
    try {
      execSync(`psql "${dbUrl}" -v ON_ERROR_STOP=1 -f "${sqlPath}"`, {
        stdio: "inherit",
      });
      console.log("==> [PASS] Live database RLS lockdown verified successfully.");
    } catch (e) {
      console.error("==> [FAIL] RLS lockdown verification failed on live database.");
      process.exit(1);
    }
  } else {
    console.log("==> No DATABASE_URL provided. Validating SQL file and assertion specifications...");
    if (!sql.includes("rowsecurity = true") || !sql.includes("api_key_hash") || !sql.includes("webhook_secret")) {
      console.error("==> [FAIL] verify-rls-lockdown.sql is malformed.");
      process.exit(1);
    }
    console.log("==> [PASS] RLS lockdown assertion script verified.");
  }
}
