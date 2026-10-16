import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe(".gitignore local planning patterns", () => {
  const root = path.resolve(__dirname, "../../..");
  const gitignorePath = path.join(root, ".gitignore");

  it("includes rules for local planning documents and scratch files (issue #180)", () => {
    const content = fs.readFileSync(gitignorePath, "utf-8");
    expect(content).toContain("*.local.md");
    expect(content).toContain("PLAN_*.md");
    expect(content).toContain("drafts/");
    expect(content).toContain("scratch/");
  });
});
