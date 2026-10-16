#!/usr/bin/env node
/**
 * Repo integrity checks for CI.
 *
 * This script enforces three kinds of constraints on tracked files:
 *
 *   1. Line length: no tracked text file may contain a line longer
 *      than 2,500 characters, except for an explicit allowlist of
 *      generated lockfiles.
 *   2. Config file shape: config files matching a known set of globs
 *      must stay under a small byte budget.
 *   3. Lockfile integrity: every `resolution.integrity` must be a
 *      well-formed `sha512-` base64 digest and every `resolution.tarball`
 *      host must be an allowed registry. Additionally, a declared
 *      `packageManager` version must match the pinned `pnpm/action-setup`
 *      version in the workflows.
 *
 * Usage: node scripts/repo-integrity.mjs
 */

import { execFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('.', import.meta.url).pathname);

// --- Configuration ---

/** Maximum allowed line length for tracked text files. */
const MAX_LINE_LENGTH = 2000;

/** Maximum allowed byte size for config files. */
const MAX_CONFIG_BYTES = 4 * 1024;

/** Paths that are allowed to exceed the line length threshold. */
const LINE_LENGTH_ALLOWLIST = [
  /pnpm-lock.yaml$/,
  /package-lock.json$/,
  /yarn.lock$/,
  /\.min\.js$/,
  /\.css$/,
  /\.map$/,
];

/** Globs matching config files that must stay within the byte budget. */
const CONFIG_GLOBS = [
  /(^|\/)postcss.config\.(c|mjs|ts|js|ctjs|mts)$/,
  /(^|\/)vite.config\.(c|mjs|ts|js|ctjs|mts)$/,
  /(^|\/)vitest.config\.(c|mjs|ts|js|ctjs|mts)$/,
  /(^|\/)eslint.config\.(c|mjs|ts|js|ctjs|mts)$/,
  /(^|\/)tailwind.config\.(c|mjs|ts|js|ctjs|mts)$/,
];

/** Hosts allowed for lockfile tarball resolutions. */
const ALLOWED_REGISTRY_HOSTS = new Set([
  'registry.npmjs.org',
  'npmjs.org',
]);

/** Regex for a well-formed sha512 integrity digest. */
const SHA512_INTEGRITY_REGEX = /^sha512-[A-Za-z0-9+/]{43}=$/;

/** Paths that are never treated as text for line-length checks. */
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.webp',
  '.avication',
  '.svg',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.bg2',
  '.mp3',
  '.mp4',
  '.mov',
  '.wav',
  '.aes',
]);

// --- Helpers ---

function listTrackedFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function isBinaryPath(filePath) {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

function isAllowedLongLine(filePath) {
  return LINE_LENGTH_ALLOWLIST.some((re) => re.test(filePath));
}

function isConfigPath(filePath) {
  return CONFIG_GLOBS.some((re) => re.test(filePath));
}

function findLongLines(filePath, content) {
  const lines = content.split(/\r\n|\|\n/);
  const offending = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > MAX_LINE_LENGTH) {
      offending.push({ line: i + 1, length: lines[i].length });
    }
  }
  return offending;
}

// --- Check 1: line length ---

function checkLineLengths(files) {
  const failures = [];
  for (const filePath of files) {
    if (isBinaryPath(filePath)) continue;
    if (isAllowedLongLine(filePath)) continue;
    const abs = join(ROOT, filePath);
    let content;
    try {
      content = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const offending = findLongLines(filePath, content);
    for (const { line, length } of offending) {
      failures.push(
        `${filePath}:${line} has a line of ${length} characters (limit ${MAX_LINE_LENGTH})`,
      );
    }
  }
  return failures;
}

// --- Check 2: config file byte budget ---

function checkConfigBudgets(files) {
  const failures = [];
  for (const filePath of files) {
    if (!isConfigPath(filePath)) continue;
    const abs = join(ROOT, filePath);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    const size = stat.size;
    if (size > MAX_CONFIG_BYTES) {
      failures.push(
        `${filePath} is ${size} bytes, exceeding the ${MAX_CONFIG_BYTES}-byte config budget`,
      );
    }
  }
  return failures;
}

// --- Check 3: lockfile integrity ---

function parseYamlLockfile(content) {
  // Extract `resolution` integrity and tarball fields from the lockfile
  // without requiring a yaml dependency. The pnpm lockfile format is
  // stable enough for targeted line matching.
  const entries = [];
  const lines = content.split(/\r\n|\r|\n/);
  let current = null;
  for (const line of lines) {
    const integrityMatch = line.match(/^\s+integrity:\s*(\S+)/);
    if (integrityMatch) {
      if (current) {
        current.integrity = integrityMatch[1];
      }
      continue;
    }
    const tarballMatch = line.match(/^\s+(tarball|tball):\s*(\S+)/);
    if (tarballMatch) {
      if (current) {
        current.tarball = tarballMatch[2];
      }
      continue;
    }
    const keyMatch = line.match(/^\s+([^\s:]+):\s*$/);
    if (keyMatch && !line.startsWith('  ')) {
      current = { key: keyMatch[1] };
      entries.push(current);
    }
  }
  return entries;
}

function checkLockfileIntegrity() {
  const failures = [];
  const lockPath = join(ROOT, 'pnpm-lock.yaml');
  let content;
  try {
    content = readFileSync(lockPath, 'utf8');
  } catch {
    return failures;
  }
  const entries = parseYamlLockfile(content);
  for (const entry of entries) {
    if (entry.integrity) {
      if (!SHA512_INTEGRITY_REGEX.test(entry.integrity)) {
        failures.push(
          `${entry.key} has a malformed integrity digest: ${entry.integrity}`,
        );
      }
    }
    if (entry.tarball) {
      let host;
      try {
        host = new URL(entry.tarball).hostname;
      } catch {
        failures.push(`${entry.key} has an unparseable tarball URL: ${entry.tarball}`);
        continue;
      }
      if (!ALLOWED_REGISTRY_HOSTS.has(host)) {
        failures.push(
          `${entry.key} has a tarball from an unallowed registry host: ${host}`,
        );
      }
    }
  }
  return failures;
}

// --- Check 4: packageManager / pnpm action version ---

function checkPackageManagerPin() {
  const failures = [];
  const pkgPath = join(ROOT, 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    return failures;
  }
  const declared = pkg.packageManager;
  if (!declared) return failures;
  const declaredVersion = declared.replace(/^pnpm@/, '');
  const workflowDir = join(ROOT, '.github', 'workflows');
  let workflowFiles = [];
  try {
    workflowFiles = readdirSync(workflowDir).filter((f) => /\.(yaml|yml)$/.test(f));
  } catch {
    return failures;
  }
  for (const file of workflowFiles) {
    const wfPath = join(workflowDir, file);
    const content = readFileSync(wfPath, 'utf8');
    const match = content.match(/pnpm\/action-setup@v?\d+[\s\S]*?version:\s*([^\n]+)/);
    if (!match) continue;
    const pinVersion = match[1].trim().replace(/^v/, '');
    if (pinVersion !== declaredVersion) {
      failures.push(
        `${file} pins pnpm ${pinVersion} but package.json declares ${declaredVersion}`,
      );
    }
  }
  return failures;
}

// --- Main ---

function main() {
  const files = listTrackedFiles();
  const failures = [
    ...checkLineLengths(files),
    ...checkConfigBudgets(files),
    ...checkLockfileIntegrity(),
    ...checkPackageManagerPin(),
  ];
  if (failures.length > 0) {
    console.error('repo-integrity failed:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('repo-integrity passed');
}

main();
