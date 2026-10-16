#!/usr/bin/env node

/**
 * check-coverage-ratchet.mjs
 *
 * Enforces a coverage ratchet across slippay monorepo packages.
 *
 * "Ratchet coverage, do not mandate it."
 * CI fails only if coverage goes DOWN from the established baseline,
 * not if coverage is below an arbitrary mandate like 90%.
 *
 * Usage:
 *   node scripts/check-coverage-ratchet.mjs            # Check against baseline
 *   node scripts/check-coverage-ratchet.mjs --update   # Upward-only ratchet update
 *   node scripts/check-coverage-ratchet.mjs --force-update # Overwrite baseline
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");
const RATCHET_FILE = join(ROOT_DIR, ".coverage-ratchet.json");

const PACKAGES = [
  { name: "@slippay/shared", path: "packages/shared" },
  { name: "@slippay/listener", path: "apps/listener" },
  { name: "@slippay/web", path: "apps/web" },
];

const METRICS = ["lines", "statements", "functions", "branches"];
const TOLERANCE = 0.01; // Allow 0.01% float rounding tolerance

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    return null;
  }
}

function getPackageCoverage(pkgRelPath) {
  const summaryPath = join(ROOT_DIR, pkgRelPath, "coverage", "coverage-summary.json");
  if (!existsSync(summaryPath)) {
    return null;
  }
  const summary = loadJson(summaryPath);
  if (!summary || !summary.total) {
    return null;
  }
  const result = {};
  for (const metric of METRICS) {
    result[metric] = {
      pct: summary.total[metric] ? summary.total[metric].pct : 0,
      covered: summary.total[metric] ? summary.total[metric].covered : 0,
      total: summary.total[metric] ? summary.total[metric].total : 0,
    };
  }
  return result;
}


export function compareCoverage(currentCoverage, baseline, options = {}) {
  const { tolerance = TOLERANCE, update = false } = options;
  const regressions = [];
  const improvements = [];
  const updatedBaseline = { ...baseline };
  const rows = [];

  for (const pkg of PACKAGES) {
    const pkgName = pkg.name;
    const current = currentCoverage[pkgName];
    if (!current) continue;
    const base = baseline[pkgName] || {};

    if (!updatedBaseline[pkgName]) {
      updatedBaseline[pkgName] = {};
    }

    for (const metric of METRICS) {
      const curPct = current[metric]?.pct ?? 0;
      const basePct = base[metric]?.pct ?? 0;
      const diff = curPct - basePct;

      let status = "OK";
      if (curPct < basePct - tolerance) {
        status = "REGRESSION";
        regressions.push({
          pkg: pkgName,
          metric,
          current: curPct,
          baseline: basePct,
          drop: Number((basePct - curPct).toFixed(2)),
        });
      } else if (curPct > basePct + tolerance) {
        status = "IMPROVED";
        improvements.push({
          pkg: pkgName,
          metric,
          current: curPct,
          baseline: basePct,
          gain: Number((curPct - basePct).toFixed(2)),
        });
        if (update) {
          updatedBaseline[pkgName][metric] = current[metric];
        }
      } else {
        if (update && !base[metric]) {
          updatedBaseline[pkgName][metric] = current[metric];
        }
      }

      rows.push({
        pkg: pkgName,
        metric,
        current: curPct,
        baseline: basePct,
        diff,
        status,
      });
    }
  }

  return { regressions, improvements, updatedBaseline, rows };
}

export function main() {
  const args = process.argv.slice(2);
  const isUpdate = args.includes("--update");
  const isForceUpdate = args.includes("--force-update");

  console.log("=================================================");
  console.log("       Slippay Test Coverage Ratchet Check       ");
  console.log("=================================================");

  let baseline = existsSync(RATCHET_FILE) ? loadJson(RATCHET_FILE) : null;
  if (!baseline) {
    baseline = {};
  }

  const currentCoverage = {};
  let missingSummary = false;

  for (const pkg of PACKAGES) {
    const cov = getPackageCoverage(pkg.path);
    if (!cov) {
      console.warn(`[WARN] Missing coverage summary for ${pkg.name} (${pkg.path}/coverage/coverage-summary.json). Run 'pnpm test:coverage' first.`);
      missingSummary = true;
    } else {
      currentCoverage[pkg.name] = cov;
    }
  }

  if (missingSummary) {
    console.error("\n[ERROR] Cannot check or ratchet coverage because some coverage-summary.json files are missing.");
    console.error("Please run: pnpm test:coverage");
    process.exit(1);
  }

  if (isForceUpdate) {
    writeFileSync(RATCHET_FILE, JSON.stringify(currentCoverage, null, 2) + "\n", "utf-8");
    console.log(`\n[SUCCESS] Baseline forcefully updated in ${RATCHET_FILE}`);
    return;
  }

  const { regressions, improvements, updatedBaseline, rows } = compareCoverage(
    currentCoverage,
    baseline,
    { update: isUpdate }
  );

  console.log("\nCoverage Comparison against Baseline:\n");
  console.log("Package                 Metric       Current     Baseline    Status");
  console.log("----------------------------------------------------------------------");

  for (const r of rows) {
    const diffStr = r.diff >= 0 ? `+${r.diff.toFixed(2)}%` : `${r.diff.toFixed(2)}%`;
    console.log(
      `${r.pkg.padEnd(23)} ${r.metric.padEnd(12)} ${String(r.current.toFixed(2) + "%").padEnd(11)} ${String(r.baseline.toFixed(2) + "%").padEnd(11)} ${r.status} (${diffStr})`
    );
  }

  console.log("----------------------------------------------------------------------");

  if (isUpdate) {
    writeFileSync(RATCHET_FILE, JSON.stringify(updatedBaseline, null, 2) + "\n", "utf-8");
    console.log(`\n[UPDATE] Ratchet updated in ${RATCHET_FILE}.`);
    if (improvements.length > 0) {
      console.log(`Advanced ratchet on ${improvements.length} metric(s)!`);
    } else {
      console.log("No improvements to advance, baseline maintained.");
    }
  }

  if (regressions.length > 0) {
    console.error(`\n[RATELIMIT FAIL] Coverage regressions detected (${regressions.length}):`);
    for (const reg of regressions) {
      console.error(
        `  ✕ ${reg.pkg} [${reg.metric}]: dropped by ${reg.drop}% (was ${reg.baseline.toFixed(2)}%, now ${reg.current.toFixed(2)}%)`
      );
    }
    console.error("\nA coverage ratchet forbids reducing coverage below the established baseline.");
    console.error("Please add test coverage for new/modified code before submitting.");
    process.exit(1);
  }

  console.log("\n[PASS] All coverage metrics met or exceeded baseline! Ratchet intact.");
}

// Run directly if invoked via node
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
