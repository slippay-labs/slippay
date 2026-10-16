#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const libDir = path.join(root, "apps", "web", "src", "lib");
const testDir = path.join(root, "apps", "web", "test");

if (!fs.existsSync(libDir)) {
  console.log("No apps/web/src/lib directory found.");
  process.exit(0);
}

const libFiles = fs.readdirSync(libDir).filter((f) => {
  return f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts");
});

const uncovered = [];

for (const file of libFiles) {
  const baseName = file.replace(/\.ts$/, "");
  const coLocatedTest = path.join(libDir, `${baseName}.test.ts`);
  const separateTest = path.join(testDir, `${baseName}.test.ts`);
  if (!fs.existsSync(coLocatedTest) && !fs.existsSync(separateTest)) {
    uncovered.push(file);
  }
}

console.log("=== Library Module Test Coverage Report ===");
console.log(`Scanned ${libFiles.length} core library modules in apps/web/src/lib:`);
if (uncovered.length === 0) {
  console.log("✓ All library modules have corresponding test suites!");
} else {
  console.log(`Notice: ${uncovered.length} uncovered module(s):`);
  uncovered.forEach((m) => console.log(`  - apps/web/src/lib/${m}`));
}
