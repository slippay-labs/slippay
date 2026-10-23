#!/usr/bin/env node
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

const ecosystemPath = path.join(ROOT, "ecosystem.config.cjs");
let config;
try {
  config = require(ecosystemPath);
} catch (err) {
  console.error("check-ecosystem: Failed to require ecosystem.config.cjs:", err);
  process.exit(1);
}

if (!config || !Array.isArray(config.apps)) {
  console.error("check-ecosystem: ecosystem.config.cjs did not export an apps array");
  process.exit(1);
}

const names = config.apps.map((a) => a.name);
const requiredApps = ["slippay-api", "slippay-listener"];
for (const required of requiredApps) {
  if (!names.includes(required)) {
    console.error(`check-ecosystem: missing required app "${required}" in apps [${names.join(", ")}]`);
    process.exit(1);
  }
}

const apiApp = config.apps.find((a) => a.name === "slippay-api");
const listenerApp = config.apps.find((a) => a.name === "slippay-listener");

if (!apiApp.env || !listenerApp.env) {
  console.error("check-ecosystem: missing env object in app definition");
  process.exit(1);
}

if (apiApp.env.SLIPPAY_DB_SCHEMA !== listenerApp.env.SLIPPAY_DB_SCHEMA) {
  console.error(
    `check-ecosystem: schema mismatch: api (${apiApp.env.SLIPPAY_DB_SCHEMA}) vs listener (${listenerApp.env.SLIPPAY_DB_SCHEMA})`,
  );
  process.exit(1);
}

if (apiApp.env.STELLAR_NETWORK !== listenerApp.env.STELLAR_NETWORK) {
  console.error(
    `check-ecosystem: network mismatch: api (${apiApp.env.STELLAR_NETWORK}) vs listener (${listenerApp.env.STELLAR_NETWORK})`,
  );
  process.exit(1);
}

console.log(`check-ecosystem: OK. apps verified: [${names.join(", ")}] with consistent schema and network env.`);
