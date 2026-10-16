#!/usr/bin/env node

/**
 * check-lockfile-consistency.mjs
 *
 * Verifies that:
 * 1. Every directory matched by pnpm-workspace.yaml globs contains a valid package.json with a "name".
 * 2. Every workspace directory has a matching importer entry in pnpm-lock.yaml.
 * 3. Every importer in pnpm-lock.yaml (except root '.') corresponds to a real workspace directory.
 * 4. Dependencies and devDependencies declared in each package.json are strictly aligned
 *    with the specifiers recorded under the corresponding importer in pnpm-lock.yaml.
 *
 * Exits with 0 on success, or 1 with descriptive error messages naming problematic files.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

export function parseWorkspaceYaml(content) {
  const lines = content.split('\n');
  const patterns = [];
  let inPackages = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('packages:')) {
      inPackages = true;
      continue;
    }

    if (inPackages) {
      if (line.startsWith('-')) {
        let pattern = line.slice(1).trim();
        pattern = pattern.replace(/^['"]|['"]$/g, '');
        if (pattern) patterns.push(pattern);
      } else if (!rawLine.startsWith(' ') && !rawLine.startsWith('\t')) {
        break;
      }
    }
  }

  return patterns;
}

export function parseLockfileImporters(lockfileContent) {
  const lines = lockfileContent.split('\n').map(l => l.replace(/\r$/, ''));
  let inImporters = false;
  let currentImporter = null;
  let currentSection = null;
  const importers = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('importers:')) {
      inImporters = true;
      continue;
    }

    if (inImporters) {
      // Exiting importers section when a top-level key without indentation appears
      if (/^[a-zA-Z0-9_-]+:/.test(line)) {
        break;
      }

      // Match importer entry like "  .:" or "  apps/web:" or "  apps/shopify-connector: {}"
      const importerMatch = line.match(/^  ([^:\s][^:]*):(?:\s*\{\})?$/);
      if (importerMatch) {
        currentImporter = importerMatch[1].trim().replace(/^['"]|['"]$/g, '');
        importers[currentImporter] = {
          dependencies: {},
          devDependencies: {},
          optionalDependencies: {},
        };
        currentSection = null;
        continue;
      }

      if (currentImporter) {
        const sectionMatch = line.match(/^    (dependencies|devDependencies|optionalDependencies):$/);
        if (sectionMatch) {
          currentSection = sectionMatch[1];
          continue;
        }

        if (currentSection) {
          // Dep entry under a section, e.g. "      '@slippay/shared':" or "      tsx:"
          const depMatch = line.match(/^      (?:'([^']+)'|"([^"]+)"|([^:\s]+)):/);
          if (depMatch) {
            const depName = depMatch[1] || depMatch[2] || depMatch[3];
            let specifier = null;

            // Peek following indented lines to find specifier
            for (let j = i + 1; j < Math.min(i + 15, lines.length); j++) {
              const peekLine = lines[j];
              // If reached next dep (6 spaces) or next section (4 spaces) or next importer (2 spaces)
              if (
                /^      (?:'|"|[^:\s]+:)/.test(peekLine) ||
                /^    [a-zA-Z]/.test(peekLine) ||
                /^  [a-zA-Z0-9_.-]+:/.test(peekLine) ||
                /^[a-zA-Z0-9_-]+:/.test(peekLine)
              ) {
                break;
              }
              const specMatch = peekLine.match(/^\s+specifier:\s*(.+)$/);
              if (specMatch) {
                specifier = specMatch[1].trim().replace(/^['"]|['"]$/g, '');
                break;
              }
            }

            if (specifier !== null) {
              importers[currentImporter][currentSection][depName] = specifier;
            }
          }
        }
      }
    }
  }

  return importers;
}

export function findWorkspaceDirectories(rootDir, patterns) {
  const dirs = [];

  for (const pattern of patterns) {
    if (pattern.endsWith('/*')) {
      const baseDir = path.resolve(rootDir, pattern.slice(0, -2));
      if (!fs.existsSync(baseDir)) continue;

      const entries = fs.readdirSync(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const fullPath = path.join(baseDir, entry.name);
          const relPath = path.relative(rootDir, fullPath).split(path.sep).join('/');
          dirs.push({ relPath, fullPath, pattern });
        }
      }
    } else {
      const fullPath = path.resolve(rootDir, pattern);
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
        const relPath = path.relative(rootDir, fullPath).split(path.sep).join('/');
        dirs.push({ relPath, fullPath, pattern });
      }
    }
  }

  return dirs;
}

export function verifyLockfileConsistency(rootDir = ROOT_DIR) {
  const errors = [];

  const workspaceFile = path.join(rootDir, 'pnpm-workspace.yaml');
  if (!fs.existsSync(workspaceFile)) {
    throw new Error(`pnpm-workspace.yaml not found at ${workspaceFile}`);
  }

  const lockfilePath = path.join(rootDir, 'pnpm-lock.yaml');
  if (!fs.existsSync(lockfilePath)) {
    throw new Error(`pnpm-lock.yaml not found at ${lockfilePath}`);
  }

  const workspacePatterns = parseWorkspaceYaml(fs.readFileSync(workspaceFile, 'utf8'));
  const lockfileImporters = parseLockfileImporters(fs.readFileSync(lockfilePath, 'utf8'));
  const workspaceDirs = findWorkspaceDirectories(rootDir, workspacePatterns);

  const matchedRelPaths = new Set();

  for (const { relPath, fullPath, pattern } of workspaceDirs) {
    matchedRelPaths.add(relPath);
    const pkgJsonPath = path.join(fullPath, 'package.json');

    // 1. Assert package.json existence
    if (!fs.existsSync(pkgJsonPath)) {
      errors.push(`Directory "${relPath}" matched by workspace glob "${pattern}" does not contain a package.json (expected at ${pkgJsonPath})`);
      continue;
    }

    // 2. Assert package.json has a non-empty name
    let pkgData;
    try {
      pkgData = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    } catch (err) {
      errors.push(`Failed to parse ${pkgJsonPath}: ${err.message}`);
      continue;
    }

    if (!pkgData.name || typeof pkgData.name !== 'string' || !pkgData.name.trim()) {
      errors.push(`package.json at ${pkgJsonPath} must declare a non-empty "name" field`);
    }

    // 3. Assert lockfile contains an importer key for this workspace dir
    if (!lockfileImporters[relPath]) {
      errors.push(`Directory "${relPath}" (${pkgData.name || 'unnamed'}) is missing from pnpm-lock.yaml importers. Run "pnpm install" to update the lockfile.`);
      continue;
    }

    // 4. Check dependencies consistency
    const importer = lockfileImporters[relPath];
    checkDeps(pkgJsonPath, relPath, 'dependencies', pkgData.dependencies || {}, importer.dependencies || {}, errors);
    checkDeps(pkgJsonPath, relPath, 'devDependencies', pkgData.devDependencies || {}, importer.devDependencies || {}, errors);
  }

  // Check root package.json vs importer "."
  const rootPkgPath = path.join(rootDir, 'package.json');
  if (fs.existsSync(rootPkgPath) && lockfileImporters['.']) {
    try {
      const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
      checkDeps(rootPkgPath, '.', 'dependencies', rootPkg.dependencies || {}, lockfileImporters['.'].dependencies || {}, errors);
      checkDeps(rootPkgPath, '.', 'devDependencies', rootPkg.devDependencies || {}, lockfileImporters['.'].devDependencies || {}, errors);
    } catch (err) {
      errors.push(`Failed to parse root ${rootPkgPath}: ${err.message}`);
    }
  }

  // Reverse check: ensure no ghost importers in pnpm-lock.yaml
  for (const importerKey of Object.keys(lockfileImporters)) {
    if (importerKey === '.') continue;
    if (!matchedRelPaths.has(importerKey)) {
      errors.push(`pnpm-lock.yaml contains importer "${importerKey}", but no matching workspace directory exists at that location.`);
    }
  }

  return { ok: errors.length === 0, errors, workspaceDirs: workspaceDirs.map(d => d.relPath) };
}

function checkDeps(pkgPath, importerKey, sectionName, pkgDeps, lockDeps, errors) {
  for (const [depName, declaredSpec] of Object.entries(pkgDeps)) {
    const lockSpec = lockDeps[depName];
    if (lockSpec === undefined) {
      errors.push(`Dependency mismatch in ${pkgPath}: declares ${sectionName} "${depName}": "${declaredSpec}", but it is missing from pnpm-lock.yaml importer "${importerKey}". Run "pnpm install" to update pnpm-lock.yaml.`);
    } else if (normalizeSpec(declaredSpec) !== normalizeSpec(lockSpec)) {
      errors.push(`Dependency specifier mismatch in ${pkgPath}: declares "${depName}": "${declaredSpec}", but pnpm-lock.yaml importer "${importerKey}" records "${lockSpec}". Run "pnpm install" to update pnpm-lock.yaml.`);
    }
  }

  for (const lockDep of Object.keys(lockDeps)) {
    if (pkgDeps[lockDep] === undefined) {
      errors.push(`Stale dependency in pnpm-lock.yaml: importer "${importerKey}" records "${lockDep}", but it is not declared in ${pkgPath}. Run "pnpm install" to update pnpm-lock.yaml.`);
    }
  }
}

function normalizeSpec(spec) {
  return String(spec || '').trim();
}

// CLI runner
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try {
    const result = verifyLockfileConsistency();
    if (!result.ok) {
      console.error('\n❌ Lockfile consistency check failed with the following errors:\n');
      for (const err of result.errors) {
        console.error(`  - ${err}`);
      }
      console.error('\nPlease ensure all workspace package.json files are valid and run "pnpm install" to regenerate pnpm-lock.yaml.\n');
      process.exit(1);
    } else {
      console.log(`\n✔ Lockfile consistency check passed! Verified ${result.workspaceDirs.length} workspace packages (${result.workspaceDirs.join(', ')}).`);
      process.exit(0);
    }
  } catch (err) {
    console.error(`\n❌ Error running lockfile consistency check: ${err.message}\n`);
    process.exit(1);
  }
}
