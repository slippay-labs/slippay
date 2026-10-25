#!/usr/bin/env node
import { readdirSync, statSync } from "node:fs";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));

const allowedRootFiles = new Set([
  ".editorconfig",
  ".env.docker.example",
  ".env.example",
  ".env.local",
  ".env.local.ci",
  ".gitbook.yaml",
  ".gitignore",
  "AGENT_CONNECT_SPEC.md",
  "CONTRIBUTING.md",
  "deno.lock",
  "docker-compose.yml",
  "ecosystem.config.cjs",
  "eslint.config.js",
  "HANDOFF_MAINNET.md",
  "IP_OWNERSHIP.md",
  "LICENSE",
  "OFFER_AGENT_PAYMENT_PILOT_5K.md",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "POSITIONING_PLAN.md",
  "README.md",
  "SECURITY.md",
  "tsconfig.base.json",
]);

const disallowedExtensions = new Set([".html", ".sh", ".py"]);

const entries = readdirSync(rootDir);
const violations = [];

for (const entry of entries) {
  if (entry.startsWith(".git") && entry !== ".gitignore" && entry !== ".gitbook.yaml") continue;
  const fullPath = resolve(rootDir, entry);
  const stat = statSync(fullPath);
  if (!stat.isFile()) continue;

  if (allowedRootFiles.has(entry)) continue;

  const ext = extname(entry).toLowerCase();
  if (disallowedExtensions.has(ext) || entry.startsWith("test_") || entry.startsWith("demo-")) {
    violations.push(entry);
  }
}

if (violations.length > 0) {
  console.error("Root hygiene check failed! Found stray root-level files:");
  for (const v of violations) {
    console.error(`  - ${v}`);
  }
  process.exit(1);
}

console.log("Root hygiene check passed: no stray scripts or unreferenced assets at repository root.");
