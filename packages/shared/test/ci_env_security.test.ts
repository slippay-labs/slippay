import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../..");
const WORKFLOW_TEST = resolve(REPO_ROOT, ".github/workflows/test.yml");
const GITIGNORE_PATH = resolve(REPO_ROOT, ".gitignore");
const CI_ENV_PATH = resolve(REPO_ROOT, ".env.local.ci");
const CI_ENV_EXAMPLE_PATH = resolve(REPO_ROOT, ".env.local.ci.example");

describe("CI Environment Security (Issue #182)", () => {
  it("proves .env.local.ci is not tracked and only .env.local.ci.example exists", () => {
    // The active config file must not exist as a tracked live file
    expect(existsSync(CI_ENV_PATH)).toBe(false);
    // The template file must exist to guide local/CI setups
    expect(existsSync(CI_ENV_EXAMPLE_PATH)).toBe(true);

    const exampleContent = readFileSync(CI_ENV_EXAMPLE_PATH, "utf-8");
    expect(exampleContent).toContain("SUPABASE_URL=");
    expect(exampleContent).toContain("SUPABASE_ANON_KEY=");
    expect(exampleContent).toContain("SUPABASE_SERVICE_ROLE_KEY=");
    expect(exampleContent).toContain("DB_URL=");
    expect(exampleContent).toContain("JWT_SECRET=");
  });

  it("proves test.yml does not consume any .env file via --env-file", () => {
    const yaml = readFileSync(WORKFLOW_TEST, "utf-8");
    expect(yaml).not.toContain("--env-file");
    expect(yaml).not.toContain(".env.local.ci");
  });

  it("verifies test.yml defines all required CI environment variables in the workflow env block", () => {
    const yaml = readFileSync(WORKFLOW_TEST, "utf-8");

    // All variables must have exactly one source of truth directly declared in the workflow env
    const requiredVars = [
      "SUPABASE_URL",
      "SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "DB_URL",
      "JWT_SECRET",
      "RATE_BRL_USDC",
      "API_KEY_PEPPER",
      "CHECKOUT_TOKEN_SECRET",
    ];

    for (const v of requiredVars) {
      expect(yaml).toContain(`${v}:`);
    }
  });

  it("verifies gitignore protects .env* files while permitting *.example templates", () => {
    const gitignore = readFileSync(GITIGNORE_PATH, "utf-8");
    expect(gitignore).toContain(".env");
    expect(gitignore).toContain(".env.*");
    expect(gitignore).toContain("!.env.*.example");
  });
});
