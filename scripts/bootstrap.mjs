#!/usr/bin/env node
/**
 * Slippay Local Bootstrap Script (Cross-Platform)
 * Automates toolchain checks, dependency installation, and build ordering.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function run(command, cwd = ROOT) {
  console.log(`\n> [bootstrap] ${command}`);
  execSync(command, { cwd, stdio: "inherit" });
}

function checkVersion(command, minMajor, name) {
  try {
    const out = execSync(command, { encoding: "utf-8" }).trim();
    const match = out.match(/v?(\d+)\.(\d+)/);
    if (!match) {
      console.warn(`⚠️ [bootstrap] Could not parse version for ${name}: ${out}`);
      return false;
    }
    const major = parseInt(match[1], 10);
    if (major < minMajor) {
      console.error(`❌ [bootstrap] ${name} version >= ${minMajor} required. Found: ${out}`);
      return false;
    }
    console.log(`✓ [bootstrap] ${name} version: ${out}`);
    return true;
  } catch (err) {
    console.warn(`⚠️ [bootstrap] ${name} check failed: ${err.message}`);
    return false;
  }
}

console.log("=== Slippay Monorepo Local Bootstrap ===\n");

// 1. Toolchain checks
console.log("1. Checking required prerequisites...");
const nodeOk = checkVersion("node -v", 22, "Node.js");
const pnpmOk = checkVersion("pnpm -v", 9, "pnpm");

if (!nodeOk || !pnpmOk) {
  console.error("❌ Prerequisites verification failed. Please install Node >= 22 and pnpm >= 9.12.0.");
  process.exit(1);
}

// 2. Install workspace dependencies
console.log("\n2. Installing workspace dependencies...");
try {
  run("pnpm install --frozen-lockfile");
} catch {
  console.log("ℹ️ [bootstrap] --frozen-lockfile failed due to lockfile specifier delta. Retrying with pnpm install...");
  run("pnpm install");
}

// 3. Build shared package (MANDATORY DEPENDENCY ORDER)
console.log("\n3. Compiling @slippay/shared (critical workspace dependency)...");
run("pnpm --filter @slippay/shared build");

// 4. Ensure .env.local exists for local tests if missing
const envLocalPath = path.join(ROOT, ".env.local");
const envCiPath = path.join(ROOT, ".env.local.ci");
if (!fs.existsSync(envLocalPath) && fs.existsSync(envCiPath)) {
  console.log("\n4. Seeding .env.local from .env.local.ci for local testing defaults...");
  fs.copyFileSync(envCiPath, envLocalPath);
  console.log("✓ Created .env.local");
} else {
  console.log("\n4. Verified .env configuration.");
}

// 5. Run Tier 1 unit tests
console.log("\n5. Running Tier 1 workspace unit tests (packages/shared, apps/listener)...");
run("pnpm --filter @slippay/shared test");
run("pnpm --filter @slippay/listener test");

console.log("\n========================================================");
console.log("🎉 Local bootstrap complete! Monorepo is built and ready.");
console.log("To start local Supabase: supabase start");
console.log("To run edge API tests:  pnpm api:test");
console.log("To launch web dev:      pnpm --filter @slippay/web dev");
console.log("========================================================\n");
