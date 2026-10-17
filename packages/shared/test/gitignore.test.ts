import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

describe(".gitignore Python bytecode & cache rules (Issue #172)", () => {
  const rootDir = resolve(__dirname, "../../..");
  const gitignorePath = resolve(rootDir, ".gitignore");
  const gitignoreContent = readFileSync(gitignorePath, "utf-8");

  it("explicitly includes __pycache__/ and *.py[cod] patterns", () => {
    expect(gitignoreContent).toContain("__pycache__/");
    expect(gitignoreContent).toContain("*.py[cod]");
  });

  it("ensures no __pycache__ or *.pyc files are currently tracked in git", () => {
    const trackedPycache = execSync("git ls-files '*__pycache__*'", {
      cwd: rootDir,
      encoding: "utf-8",
    }).trim();
    expect(trackedPycache).toBe("");

    const trackedPyc = execSync("git ls-files '*.pyc'", {
      cwd: rootDir,
      encoding: "utf-8",
    }).trim();
    expect(trackedPyc).toBe("");
  });

  it("verifies git check-ignore ignores simulated Python bytecode paths", () => {
    const testPaths = [
      "agents/axl/grammar/__pycache__/grammar.cpython-310.pyc",
      "agents/ifc/__pycache__/ifc.cpython-310.pyc",
      "agents/tee/some_module.pyo",
      "test_dir/.pytest_cache/cache.json",
    ];

    for (const testPath of testPaths) {
      const output = execSync(`git check-ignore "${testPath}"`, {
        cwd: rootDir,
        encoding: "utf-8",
      }).trim();
      expect(output).toBe(testPath);
    }
  });
});
