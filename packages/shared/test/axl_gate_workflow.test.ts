import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../..");
const AXL_WORKFLOW = resolve(REPO_ROOT, ".github/workflows/axl-gate.yml");

describe("axl-gate Workflow Invariants (Issue #175)", () => {
  it("proves Cargo cache key hashes Cargo.lock alongside Cargo.toml", () => {
    const yaml = readFileSync(AXL_WORKFLOW, "utf-8");

    // Key must include Cargo.lock so changing only lockfile invalidates the cache
    expect(yaml).toMatch(/hashFiles\([^)]*Cargo\.lock[^)]*Cargo\.toml[^)]*\)/);
    // Must feature deliberate cache version prefix
    expect(yaml).toContain("axl-cargo-v1-");
  });

  it("proves restore-keys prefix is configured for cache miss recovery", () => {
    const yaml = readFileSync(AXL_WORKFLOW, "utf-8");

    expect(yaml).toContain("restore-keys:");
    expect(yaml).toContain("axl-cargo-v1-${{ runner.os }}-");
  });

  it("proves the workflow explicitly sets up and pins the Rust toolchain", () => {
    const yaml = readFileSync(AXL_WORKFLOW, "utf-8");

    expect(yaml).toContain("actions-rust-lang/setup-rust-toolchain");
    expect(yaml).toContain("toolchain: stable");
  });

  it("proves z3 solver installation is version-constrained for deterministic SMT proof verification", () => {
    const yaml = readFileSync(AXL_WORKFLOW, "utf-8");

    expect(yaml).toContain("z3=");
    expect(yaml).toContain("z3 --version");
  });
});
