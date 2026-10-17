// Guard: Ratchet ESLint configuration and CI enforcement to fail on warnings (closes #166)
//
// Acceptance criteria:
// 1. All advisory rules ("warn") are eliminated from eslint.config.js in favor of strict "error"s.
// 2. Both `react-refresh/only-export-components` and `jsx-a11y/no-redundant-roles` are strict "error".
// 3. Any attempt to introduce a "warn"-level rule fails the ratchet guard.
// 4. apps/web/src source files adhere to jsx-a11y/no-redundant-roles with zero violations.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, resolve } from "node:path";

const ROOT_DIR = resolve(__dirname, "../../..");
const ESLINT_CONFIG_PATH = join(ROOT_DIR, "eslint.config.js");
const WEB_SRC_DIR = join(ROOT_DIR, "apps/web/src");

/** Recursively collect files under a directory */
function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walk(full);
    } else if (st.isFile()) {
      const ext = extname(full);
      if (ext === ".tsx" || ext === ".jsx" || ext === ".ts") {
        yield full;
      }
    }
  }
}

/** Check if any rule in eslint.config.js content is configured with 'warn' */
export function findWarnLevelRules(configText: string): string[] {
  const warnRuleRegex = /"([^"]+)"\s*:\s*(?:\[\s*)?["']warn["']/g;
  const matches: string[] = [];
  for (const match of configText.matchAll(warnRuleRegex)) {
    matches.push(match[1] ?? match[0]);
  }
  return matches;
}

describe("fix(ci): fail the lint job on warnings ratchet (closes #166)", () => {
  it("eslint.config.js contains zero 'warn' level rules", () => {
    const configContent = readFileSync(ESLINT_CONFIG_PATH, "utf-8");
    const warnRules = findWarnLevelRules(configContent);
    expect(warnRules).toEqual([]);
  });

  it("ratchet guard fails if any advisory 'warn' is introduced into the config", () => {
    const syntheticConfigWithWarn = `
      export default [
        {
          rules: {
            "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
            "jsx-a11y/no-redundant-roles": "warn",
          }
        }
      ];
    `;
    const warnRules = findWarnLevelRules(syntheticConfigWithWarn);
    expect(warnRules).toContain("react-refresh/only-export-components");
    expect(warnRules).toContain("jsx-a11y/no-redundant-roles");
    expect(warnRules.length).toBe(2);
  });

  it("eslint.config.js strictly enforces 'react-refresh/only-export-components' as 'error'", () => {
    const configContent = readFileSync(ESLINT_CONFIG_PATH, "utf-8");
    expect(configContent).toMatch(/"react-refresh\/only-export-components"\s*:\s*\[\s*"error"/);
  });

  it("eslint.config.js strictly enforces 'jsx-a11y/no-redundant-roles' as 'error'", () => {
    const configContent = readFileSync(ESLINT_CONFIG_PATH, "utf-8");
    expect(configContent).toMatch(/"jsx-a11y\/no-redundant-roles"\s*:\s*"error"/);
  });

  it("apps/web/src has zero violations of jsx-a11y/no-redundant-roles", () => {
    const redundantRoles = [
      { tag: "button", role: "button" },
      { tag: "nav", role: "navigation" },
      { tag: "header", role: "banner" },
      { tag: "footer", role: "contentinfo" },
      { tag: "aside", role: "complementary" },
      { tag: "main", role: "main" },
      { tag: "a", role: "link" },
      { tag: "ul", role: "list" },
      { tag: "ol", role: "list" },
    ];

    const violations: { file: string; match: string }[] = [];

    for (const file of walk(WEB_SRC_DIR)) {
      const content = readFileSync(file, "utf-8");
      for (const { tag, role } of redundantRoles) {
        const regex = new RegExp(`<${tag}\\b[^>]*\\brole=["']${role}["'][^>]*>`, "gi");
        for (const match of content.matchAll(regex)) {
          violations.push({ file: file.replace(WEB_SRC_DIR, "apps/web/src"), match: match[0] });
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
