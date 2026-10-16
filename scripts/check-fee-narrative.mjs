#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Read constants directly from packages/shared/src/constants.ts
const constantsContent = fs.readFileSync(path.join(ROOT, "packages/shared/src/constants.ts"), "utf-8");
const feeMatch = constantsContent.match(/export const DEFAULT_PLATFORM_FEE_BP = (\d+);/);
const spreadMatch = constantsContent.match(/export const DEFAULT_FX_SPREAD_BPS = (\d+);/);

if (!feeMatch || !spreadMatch) {
  console.error("❌ Failed to parse constants from packages/shared/src/constants.ts");
  process.exit(1);
}

const CANONICAL_FEE_BP = Number(feeMatch[1]);
const CANONICAL_SPREAD_BPS = Number(spreadMatch[1]);
const CANONICAL_FEE_PCT = (CANONICAL_FEE_BP / 100).toFixed(2) + "%";
const CANONICAL_SPREAD_PCT = (CANONICAL_SPREAD_BPS / 100).toFixed(2) + "%";

console.log(`[Fee Narrative Check] Canonical Platform Fee: ${CANONICAL_FEE_BP} bp (${CANONICAL_FEE_PCT})`);
console.log(`[Fee Narrative Check] Canonical FX Spread:    ${CANONICAL_SPREAD_BPS} bp (${CANONICAL_SPREAD_PCT})\n`);

const FORBIDDEN_PATTERNS = [
  { regex: /0\.98%/g, reason: "Stale 0.98% platform fee (superseded by 2.97%)" },
  { regex: /\b98\s*bp\b/gi, reason: "Stale 98 bp platform fee (superseded by 297 bp)" },
  { regex: /Slippay\s+2\.8%/gi, reason: "Stale 2.8% rate typo (canonical is 2.97%)" },
  { regex: /Rail fee \(~0\.3%/g, reason: "Stale ~0.3% rate assertion (canonical is 2.97%)" },
  { regex: /merchant\.platform_fee_bp \?\? 98\b/g, reason: "Stale 98 fallback in code" },
];

const TRACKED_FILES = [
  "README.md",
  "docs/README.md",
  "docs/business/revenue-model.md",
  "docs/api-reference/orders.md",
  "docs/api-reference/merchants.md",
  "docs/concepts/architecture.md",
  "HANDOFF_MAINNET.md",
  "POSITIONING_PLAN.md",
  "apps/web/public/llms.txt",
  "apps/web/src/lib/quote.ts",
  "apps/web/.env.production",
  "supabase/functions/api/routes/orders.ts",
  "supabase/functions/api/routes/billing.ts",
];

let failed = false;

for (const file of TRACKED_FILES) {
  const fullPath = path.join(ROOT, file);
  if (!fs.existsSync(fullPath)) {
    console.warn(`⚠️ File not found: ${file}`);
    continue;
  }

  const content = fs.readFileSync(fullPath, "utf-8");

  for (const { regex, reason } of FORBIDDEN_PATTERNS) {
    if (regex.test(content)) {
      console.error(`❌ ${file}: matches forbidden pattern: ${reason}`);
      failed = true;
    }
  }
}

if (failed) {
  console.error("\n❌ CI Check Failed: Detected divergent fee narratives across tracked files.");
  process.exit(1);
}

console.log("✅ All tracked files adhere to the canonical fee narrative and constants.");
