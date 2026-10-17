import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertRlsAndGrants,
  REQUIRED_RLS_TABLES,
  INTERNAL_TABLES,
  MERCHANT_SECRET_COLUMNS,
} from "../../../scripts/verify-rls-lockdown.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

describe("RLS Lockdown Verification & Assertions (Issue #184)", () => {
  const validMockTables = [
    { tablename: "x402_resources", rowsecurity: true },
    { tablename: "listener_leases", rowsecurity: true },
    { tablename: "listener_state", rowsecurity: true },
    { tablename: "merchants", rowsecurity: true },
  ];

  const validTableGrants = [
    { table_name: "orders", grantee: "authenticated", privilege_type: "SELECT" },
    { table_name: "merchants", grantee: "authenticated", privilege_type: "UPDATE" },
  ];

  const validColumnGrants = [
    { table_name: "merchants", column_name: "display_name", grantee: "authenticated", privilege_type: "SELECT" },
    { table_name: "merchants", column_name: "email", grantee: "authenticated", privilege_type: "SELECT" },
    { table_name: "merchants", column_name: "stellar_address", grantee: "authenticated", privilege_type: "SELECT" },
  ];

  it("passes when all four tables have RLS enabled and secret grants are revoked", () => {
    const res = assertRlsAndGrants({
      tables: validMockTables,
      tableGrants: validTableGrants,
      columnGrants: validColumnGrants,
    });

    expect(res.verified).toBe(true);
    expect(res.tablesChecked).toBe(4);
  });

  it("fails loudly if RLS is disabled on any of the target tables", () => {
    const corruptedTables = [
      { tablename: "x402_resources", rowsecurity: false }, // RLS disabled!
      { tablename: "listener_leases", rowsecurity: true },
      { tablename: "listener_state", rowsecurity: true },
      { tablename: "merchants", rowsecurity: true },
    ];

    expect(() =>
      assertRlsAndGrants({
        tables: corruptedTables,
        tableGrants: validTableGrants,
        columnGrants: validColumnGrants,
      })
    ).toThrowError(/Table 'x402_resources' has RLS disabled/);
  });

  it("fails loudly if a table revoke is commented out or missing (Acceptance Criteria 2)", () => {
    // Simulate someone commenting out "revoke all on table listener_leases from anon, authenticated;"
    const leakedTableGrants = [
      ...validTableGrants,
      { table_name: "listener_leases", grantee: "anon", privilege_type: "SELECT" },
    ];

    expect(() =>
      assertRlsAndGrants({
        tables: validMockTables,
        tableGrants: leakedTableGrants,
        columnGrants: validColumnGrants,
      })
    ).toThrowError(/Unauthorized table privilege 'SELECT' granted to 'anon' on 'listener_leases'/);
  });

  it("fails loudly if merchants secret column revoke is commented out (Acceptance Criteria 2)", () => {
    // Simulate someone commenting out column revoke, exposing api_key_hash to authenticated
    const leakedColGrants = [
      ...validColumnGrants,
      {
        table_name: "merchants",
        column_name: "api_key_hash",
        grantee: "authenticated",
        privilege_type: "SELECT",
      },
    ];

    expect(() =>
      assertRlsAndGrants({
        tables: validMockTables,
        tableGrants: validTableGrants,
        columnGrants: leakedColGrants,
      })
    ).toThrowError(/Secret column 'api_key_hash' on 'merchants' is readable by authenticated role/);
  });

  it("asserts that security_rls_lockdown.sql no longer carries a 'not applied' note (Acceptance Criteria 3)", () => {
    const migrationPath = resolve(
      repoRoot,
      "supabase/migrations/20260601230000_security_rls_lockdown.sql"
    );
    expect(existsSync(migrationPath)).toBe(true);

    const content = readFileSync(migrationPath, "utf-8");

    // The file must NOT advertise itself as unapplied or pending
    expect(content.toLowerCase()).not.toContain("not auto-applied");
    expect(content.toLowerCase()).not.toContain("not applied");
    expect(content).toContain("scripts/verify-rls-lockdown.mjs");
  });

  it("asserts that deploy workflows enforce RLS lockdown verification (Acceptance Criteria 1)", () => {
    const stagingWf = readFileSync(resolve(repoRoot, ".github/workflows/deploy-staging.yml"), "utf-8");
    const prodWf = readFileSync(resolve(repoRoot, ".github/workflows/deploy-production.yml"), "utf-8");

    expect(stagingWf).toContain("scripts/verify-rls-lockdown.mjs");
    expect(prodWf).toContain("scripts/verify-rls-lockdown.mjs");
  });
});
