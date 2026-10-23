#!/usr/bin/env node
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

// Create a mock .env file to verify wholesale forwarding
const testEnvPath = path.join(ROOT, ".env.test-ecosystem");
fs.writeFileSync(
  testEnvPath,
  [
    'RELAYER_SECRET="SAAAAATESTSECRET"',
    'DUNE_API_KEY="test-dune-key"',
    'ETHERFUSE_ENABLED="1"',
    'FOURP_API_KEY="test-fourp-key"',
    'SLIPPAY_SUBSCRIPTION_CONTRACT_MAINNET="CDEMOCONTRACTMAINNET"',
    'TRUSTED_PROXY_HOPS="2"',
  ].join("\n"),
);

try {
  // Read ecosystem and evaluate with mock env
  const configContent = fs.readFileSync(path.join(ROOT, "ecosystem.config.cjs"), "utf8");
  const modFunc = new Function("require", "module", "__dirname", "process", configContent);
  const mockModule = { exports: {} };

  // Run with swapped env file path
  const adjustedContent = configContent.replace(
    'path.join(ROOT, ".env")',
    'path.join(ROOT, ".env.test-ecosystem")',
  );
  const evalFunc = new Function("require", "module", "__dirname", "process", adjustedContent);
  evalFunc(require, mockModule, ROOT, process);

  const apiApp = mockModule.exports.apps.find((a) => a.name === "slippay-api");
  if (!apiApp) throw new Error("slippay-api app not found in ecosystem");

  const expectedVars = [
    "RELAYER_SECRET",
    "DUNE_API_KEY",
    "ETHERFUSE_ENABLED",
    "FOURP_API_KEY",
    "SLIPPAY_SUBSCRIPTION_CONTRACT_MAINNET",
    "TRUSTED_PROXY_HOPS",
  ];

  for (const v of expectedVars) {
    if (!apiApp.env[v]) {
      throw new Error(`Expected environment variable ${v} was not forwarded to slippay-api env!`);
    }
  }

  console.log("test-ecosystem-env: OK. All feature environment variables are forwarded to apiEnv.");
} finally {
  if (fs.existsSync(testEnvPath)) fs.unlinkSync(testEnvPath);
}
