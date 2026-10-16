import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Dependabot & Pinned Action Governance (Issue #176)", () => {
  const repoRoot = path.resolve(__dirname, "../../..");
  const dependabotPath = path.join(repoRoot, ".github", "dependabot.yml");
  const workflowsDir = path.join(repoRoot, ".github", "workflows");

  it("verifies .github/dependabot.yml exists and has valid configuration", () => {
    expect(fs.existsSync(dependabotPath)).toBe(true);
    const content = fs.readFileSync(dependabotPath, "utf8");

    // Version assertion
    expect(content).toContain("version: 2");

    // Ecosystem assertions
    expect(content).toContain('package-ecosystem: "github-actions"');
    expect(content).toContain('package-ecosystem: "npm"');

    // Grouping assertion (Issue requirement: grouped so updates arrive as one PR rather than five)
    expect(content).toContain("groups:");
    expect(content).toContain("actions:");
  });

  it("asserts no workflow uses unpinned 'latest' for supabase/setup-cli", () => {
    expect(fs.existsSync(workflowsDir)).toBe(true);
    const workflowFiles = fs.readdirSync(workflowsDir).filter(f => f.endsWith(".yml") || f.endsWith(".yaml"));
    expect(workflowFiles.length).toBeGreaterThan(0);

    for (const file of workflowFiles) {
      const fullPath = path.join(workflowsDir, file);
      const content = fs.readFileSync(fullPath, "utf8");

      if (content.includes("supabase/setup-cli")) {
        // Assert no unpinned "version: latest" is declared
        const lines = content.split("\n");
        let foundSetupCli = false;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.includes("supabase/setup-cli")) {
            foundSetupCli = true;
          }
          if (foundSetupCli && line.trim().startsWith("version:")) {
            const versionVal = line.split("version:")[1].trim().replace(/^['"]|['"]$/g, "");
            expect(versionVal, `Workflow ${file} has unpinned supabase/setup-cli version: latest`).not.toBe("latest");
            expect(versionVal).toMatch(/^\d+\.\d+\.\d+/);
            foundSetupCli = false;
          }
        }
      }
    }
  });
});
