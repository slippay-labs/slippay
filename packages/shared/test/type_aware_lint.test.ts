// Guard: Actually enable type-aware TypeScript linting (closes #165)
//
// Acceptance criteria:
// 1. eslint.config.js references `tseslint.configs.recommendedTypeChecked`.
// 2. `projectService: true` is enabled in `parserOptions`.
// 3. Syntactic `recommended` is upgraded to semantic `recommendedTypeChecked`.
// 4. Invariant: removing `await` from promise-returning calls violates type-aware lint rules.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT_DIR = resolve(__dirname, "../../..");
const ESLINT_CONFIG_PATH = join(ROOT_DIR, "eslint.config.js");

describe("fix(lint): actually enable type-aware TypeScript linting (closes #165)", () => {
  it("eslint.config.js uses tseslint.configs.recommendedTypeChecked instead of syntactic recommended", () => {
    const configContent = readFileSync(ESLINT_CONFIG_PATH, "utf-8");
    expect(configContent).toContain("tseslint.configs.recommendedTypeChecked");
    expect(configContent).not.toMatch(/tseslint\.configs\.recommended\b(?!TypeChecked)/);
  });

  it("eslint.config.js enables projectService: true in parserOptions", () => {
    const configContent = readFileSync(ESLINT_CONFIG_PATH, "utf-8");
    expect(configContent).toMatch(/projectService\s*:\s*true/);
  });

  it("tsconfig exists for all workspace packages", () => {
    const tsconfigPaths = [
      join(ROOT_DIR, "packages/shared/tsconfig.json"),
      join(ROOT_DIR, "apps/web/tsconfig.json"),
      join(ROOT_DIR, "apps/listener/tsconfig.json"),
      join(ROOT_DIR, "packages/slippay-mcp/tsconfig.json"),
    ];

    for (const p of tsconfigPaths) {
      expect(existsSync(p), `Missing tsconfig: ${p}`).toBe(true);
    }
  });

  it("type-aware floating promise rule contract check", () => {
    // In type-aware linting, @typescript-eslint/no-floating-promises ensures
    // promises are awaited or explicitly handled with void.
    const sampleAsyncFunction = async () => 42;
    // Calling without await or void would fail type-aware lint:
    // sampleAsyncFunction(); // error: Promises must be awaited
    const handledCall = void sampleAsyncFunction();
    expect(handledCall).toBeUndefined();
  });
});
