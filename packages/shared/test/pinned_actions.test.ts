import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../..");
const WORKFLOWS_DIR = resolve(REPO_ROOT, ".github/workflows");

describe("Workflow Third-Party Action SHA Pinning (Issue #162)", () => {
  it("proves every third-party action in all workflows is pinned to a 40-character commit SHA", () => {
    const yamlFiles = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
    expect(yamlFiles.length).toBeGreaterThan(0);

    const sha40Pattern = /^[0-9a-f]{40}$/;
    let totalUsesChecked = 0;
    const violations: { file: string; line: number; uses: string }[] = [];

    for (const file of yamlFiles) {
      const fullPath = join(WORKFLOWS_DIR, file);
      const lines = readFileSync(fullPath, "utf-8").split("\n");

      for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx];
        if (line.includes("uses:")) {
          // Extract value after uses:
          const raw = line.split("uses:")[1].trim();
          // Remove comments
          const withoutComment = raw.split("#")[0].trim();

          if (withoutComment.includes("@")) {
            totalUsesChecked++;
            const [, ref] = withoutComment.split("@");
            if (!sha40Pattern.test(ref.trim())) {
              violations.push({
                file,
                line: idx + 1,
                uses: withoutComment,
              });
            }
          }
        }
      }
    }

    expect(totalUsesChecked).toBe(24);
    expect(violations).toEqual([]);
  });
});
