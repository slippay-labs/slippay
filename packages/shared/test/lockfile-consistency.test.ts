import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  parseWorkspaceYaml,
  parseLockfileImporters,
  findWorkspaceDirectories,
  verifyLockfileConsistency,
} from "../../../scripts/check-lockfile-consistency.mjs";

describe("Lockfile & Workspace Consistency (Issue #177)", () => {
  const repoRoot = path.resolve(__dirname, "../../..");

  it("passes consistency check against the actual repository", () => {
    const result = verifyLockfileConsistency(repoRoot);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.workspaceDirs).toContain("packages/shared");
    expect(result.workspaceDirs).toContain("apps/listener");
    expect(result.workspaceDirs).toContain("apps/web");
  });

  describe("parseWorkspaceYaml", () => {
    it("extracts workspace patterns correctly", () => {
      const sample = `
# Workspace config
packages:
  - 'packages/*'
  - 'apps/*'
  - "tools/cli"
`;
      const patterns = parseWorkspaceYaml(sample);
      expect(patterns).toEqual(["packages/*", "apps/*", "tools/cli"]);
    });
  });

  describe("parseLockfileImporters", () => {
    it("parses importers and specifiers accurately", () => {
      const sample = `lockfileVersion: '9.0'
importers:
  .:
    devDependencies:
      typescript:
        specifier: ^5.6.0
        version: 5.9.3
  apps/mock:
    dependencies:
      zod:
        specifier: ^3.23.0
        version: 3.23.8
`;
      const importers = parseLockfileImporters(sample);
      expect(importers["."]).toBeDefined();
      expect(importers["."].devDependencies["typescript"]).toBe("^5.6.0");
      expect(importers["apps/mock"]).toBeDefined();
      expect(importers["apps/mock"].dependencies["zod"]).toBe("^3.23.0");
    });
  });

  describe("Mock workspace failure scenarios", () => {
    it("fails when a workspace directory lacks a package.json", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lockfile-test-"));
      try {
        fs.writeFileSync(
          path.join(tmpDir, "pnpm-workspace.yaml"),
          "packages:\n  - 'packages/*'\n"
        );
        fs.writeFileSync(
          path.join(tmpDir, "pnpm-lock.yaml"),
          "lockfileVersion: '9.0'\nimporters:\n  .: {}\n"
        );
        const pkgDir = path.join(tmpDir, "packages", "orphan");
        fs.mkdirSync(pkgDir, { recursive: true });

        const result = verifyLockfileConsistency(tmpDir);
        expect(result.ok).toBe(false);
        expect(result.errors.some((e: string) => e.includes("does not contain a package.json"))).toBe(true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("fails when package.json lacks a valid 'name' field", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lockfile-test-"));
      try {
        fs.writeFileSync(
          path.join(tmpDir, "pnpm-workspace.yaml"),
          "packages:\n  - 'packages/*'\n"
        );
        fs.writeFileSync(
          path.join(tmpDir, "pnpm-lock.yaml"),
          "lockfileVersion: '9.0'\nimporters:\n  .: {}\n"
        );
        const pkgDir = path.join(tmpDir, "packages", "unnamed");
        fs.mkdirSync(pkgDir, { recursive: true });
        fs.writeFileSync(
          path.join(pkgDir, "package.json"),
          JSON.stringify({ version: "1.0.0" })
        );

        const result = verifyLockfileConsistency(tmpDir);
        expect(result.ok).toBe(false);
        expect(result.errors.some((e: string) => e.includes('must declare a non-empty "name" field'))).toBe(true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("fails when workspace package is missing from pnpm-lock.yaml importers", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lockfile-test-"));
      try {
        fs.writeFileSync(
          path.join(tmpDir, "pnpm-workspace.yaml"),
          "packages:\n  - 'packages/*'\n"
        );
        fs.writeFileSync(
          path.join(tmpDir, "pnpm-lock.yaml"),
          "lockfileVersion: '9.0'\nimporters:\n  .: {}\n"
        );
        const pkgDir = path.join(tmpDir, "packages", "missing-importer");
        fs.mkdirSync(pkgDir, { recursive: true });
        fs.writeFileSync(
          path.join(pkgDir, "package.json"),
          JSON.stringify({ name: "@test/missing", version: "1.0.0" })
        );

        const result = verifyLockfileConsistency(tmpDir);
        expect(result.ok).toBe(false);
        expect(result.errors.some((e: string) => e.includes("missing from pnpm-lock.yaml importers"))).toBe(true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("fails and names the file when a dependency in package.json is missing in lockfile", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lockfile-test-"));
      try {
        fs.writeFileSync(
          path.join(tmpDir, "pnpm-workspace.yaml"),
          "packages:\n  - 'packages/*'\n"
        );
        fs.writeFileSync(
          path.join(tmpDir, "pnpm-lock.yaml"),
          `lockfileVersion: '9.0'
importers:
  .: {}
  packages/my-lib:
    dependencies: {}
`
        );
        const pkgDir = path.join(tmpDir, "packages", "my-lib");
        fs.mkdirSync(pkgDir, { recursive: true });
        const pkgJsonPath = path.join(pkgDir, "package.json");
        fs.writeFileSync(
          pkgJsonPath,
          JSON.stringify({
            name: "my-lib",
            dependencies: {
              lodash: "^4.17.21",
            },
          })
        );

        const result = verifyLockfileConsistency(tmpDir);
        expect(result.ok).toBe(false);
        expect(
          result.errors.some(
            (e: string) =>
              e.includes(pkgJsonPath) &&
              e.includes("lodash") &&
              e.includes("missing from pnpm-lock.yaml importer")
          )
        ).toBe(true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
