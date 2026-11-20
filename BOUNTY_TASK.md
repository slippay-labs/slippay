# Bounty Fix

**Reward:** $60.00
**Issue:** https://github.com/slippay-labs/slippay/issues/65
**Repo:** https://github.com/slippay-labs/slippay

---

## Issue

[Bounty: $60] Return the right status for `ramp_disabled` vs upstream 4P errors

**Context**
In `routes/fourp.ts`, `client()` returning `null` yields `{ "error": "ramp_disabled" }` with status **503** on the payer-facing routes, and the same route returns 502 for a `FourPError`. The client `apps/web/src/lib/ramp4p.ts` explicitly maps 503 to `Ramp4pError("disabled", "Pagamento em Pix ainda não está ligado.")` and 404/503 to a null off-ramp quote, so a temporary upstream outage on `/offramp/quote` is presented to the user as "off-ramp not available" forever, and a disabled integration is indistinguishable from a provider outage. The two conditions need different codes.

**Proposed Change**
Use a distinct, documented status for "not configured" (e.g. 501 or a typed 404 with `error: "ramp_disabled"`) and reserve 502/503 for genuine upstream failures; update `apps/web/src/lib/ramp4p.ts` to branch on `error` as well as status.

**Acceptance Criteria**

- A disabled integration and an upstream 4P failure produce different status codes (test).
- The client no longer treats a provider outage as permanently disabled.
- The chosen codes are documented in `docs/api-reference/errors.md`.
- Verified by the `test` job in `.github/workflows/test.yml`.

**Suggested Label**: bug
**ETA:** 24 hours

---

## Process

### 1. Orient yourself first
Before touching any code:
- Read the README and any relevant docs
- Run: find . -type f | grep -v node_modules | grep -v .git | grep -v dist | head -60
- Grep for the key terms from the issue title to find the relevant files
- Read the files around the bug — understand what's currently happening

### 2. Find and read the tests
- Look for test files near the relevant code (*.test.ts, *.spec.js, __tests__, etc.)
- Read them — they tell you what behavior is expected
- Understand what a passing fix looks like before writing a line

### 3. Implement the fix
- Make the MINIMAL change that fixes the issue — nothing more
- Do not refactor, rename, reorganize, or clean up unrelated code
- Do not add dependencies unless the issue explicitly requires it
- Do not modify config files (package.json, tsconfig.json, etc.) unless that IS the fix
- One logical change, one commit

### 4. Verify
- Run the test suite: check package.json scripts for "test", "lint", "typecheck"
  Common commands: npm test, yarn test, pnpm test, pytest, go test ./..., cargo test
- If TypeScript is present: npx tsc --noEmit
- Fix any test failures your change caused — if a test was wrong before, update it

### 5. Commit and document
- git add -A
- git commit -m "fix: [Bounty: $60] Return the right status for 'ramp_disabled' vs upstream 4P"
- Write AGENT_SUMMARY.md with:
  - Root cause: what was wrong and why
  - Fix: what you changed and the reasoning
  - Verification: how to confirm it works
  - Concerns: anything a reviewer should know

---

## Stop conditions

If ANY of these are true, write "UNCERTAIN: [reason]" at the top of AGENT_SUMMARY.md, make NO code changes, and stop:
- The fix requires changing more than ~5 files
- You cannot determine what the correct behavior should be
- The issue requires a database migration, API key, or external service
- You find 3+ open PRs already attempting this fix (high competition)
- The repo is not in a language/framework you can reason about confidently

A clean UNCERTAIN is better than a bad PR.
