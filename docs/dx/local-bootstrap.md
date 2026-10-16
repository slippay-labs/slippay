# Local Developer Bootstrap (DX Guide)

> **Goal**: Take a new contributor from `git clone` to a clean, reproducible, all-green test run across all workspace tiers.
>
> **Reference Environment**: GitHub CI (`.github/workflows/test.yml`). If this guide and CI ever diverge, file an issue — CI is the canonical test environment.

---

## 1. Prerequisites Matrix

Before starting, install the prerequisite toolchains. The versions below match what is pinned and tested in CI:

| Tool | Required Version | CI Pinned Version | Purpose & Scope |
|---|---|---|---|
| **Node.js** | `>= 22.0.0` | `22.x` | Runtime for workspace packages, web frontend, and developer scripts |
| **pnpm** | `9.12.0` | `9.12.0` | Monorepo package manager (configured via `packageManager` in `package.json`) |
| **Deno** | `^2.0.0` | `v2.x` | Runtime for Supabase Edge Functions (`supabase/functions/api/*`) |
| **Docker** | Docker Engine / Desktop | `latest` | Required to run the local Supabase emulator stack |
| **Supabase CLI** | `>= 1.200.0` | `latest` (CI) | Manages local Postgres DB, Auth, Storage, and Edge Functions |
| **Rust / Cargo** | `>= 1.80` | Optional for TS work | Required only for building Soroban contracts (`contracts/*`) |
| **z3 Prover** | `>= 4.12` | Optional for TS work | Required only for AXL formal verification engine (`axl/*`) |

### Verification Command

Verify that your local toolchains satisfy the requirements:

```bash
node -v      # should output v22.x.x
pnpm -v      # should output 9.12.0
deno --version  # should output deno 2.x.x
docker --version # should output Docker version 20+
supabase -v  # should output 1.200.0 or higher
```

---

## 2. Quickstart: Non-Interactive Bootstrap Script

For a fully automated setup, run the provided bootstrap script from the repository root:

```bash
# Cross-platform (Windows, macOS, Linux):
pnpm run bootstrap

# Or run the POSIX shell script directly (Linux, macOS, WSL):
bash scripts/bootstrap.sh
```

The script will:
1. Verify toolchain prerequisites.
2. Run `pnpm install --frozen-lockfile`.
3. Compile `@slippay/shared` (mandatory build dependency).
4. Verify environment configuration files.
5. Run workspace unit tests.

---

## 3. Step-by-Step Manual Walkthrough

If you prefer running each step manually, follow the exact sequence below.

### Step 1: Clone and Install Workspace Dependencies

```bash
git clone https://github.com/slippay-labs/slippay.git
cd slippay
pnpm install --frozen-lockfile
```

### Step 2: Critical Build Order (Build Shared Package)

> **CRITICAL DEPENDENCY RULE**:
> `@slippay/shared` is a workspace package consumed by `@slippay/web`, `@slippay/listener`, and the Deno API.
> You **MUST** build `@slippay/shared` before attempting to run typechecks, builds, or tests in dependent apps.

```bash
pnpm --filter @slippay/shared build
```

This compiles TypeScript declaration files and artifacts into `packages/shared/dist`.

### Step 3: Environment Setup

The repository contains three tiers of environment configurations:

1. **Repository root `.env.example`**:
   The master reference of all operational environment variables (Stellar network, Horizon RPC, Supabase credentials, listener polling intervals, and HMAC pepper secrets).
2. **Local CI environment `.env.local.ci`**:
   Pre-configured with public, non-secret default keys corresponding to the standard local Supabase developer stack (`http://127.0.0.1:54321`). This allows local and CI testing without needing cloud credentials.
3. **App-level configurations**:
   - `apps/web/.env.example` -> copy to `apps/web/.env.local` for local frontend development.
   - `apps/listener/.env.example` -> copy to `apps/listener/.env` if running the standalone payment listener.

For local test execution against local Supabase, copy `.env.local.ci`:

```bash
# On Linux/macOS:
cp .env.local.ci .env.local

# On Windows (PowerShell):
Copy-Item .env.local.ci .env.local
```

### Step 4: Start the Local Supabase Stack

For testing API endpoints, database migrations, and auth tokens, start the local Supabase container stack:

```bash
supabase start
```

This starts:
- Local Postgres database on `postgresql://postgres:postgres@127.0.0.1:54322/postgres`
- Supabase Studio Web UI on `http://127.0.0.1:54323`
- API Gateway on `http://127.0.0.1:54321`

---

## 4. Test Tiers & Network Requirements

Slippay organizes tests into five distinct tiers. Each tier has clear expectations regarding network access and credentials:

| Tier | Command | Scope | Network & Credential Requirements |
|---|---|---|---|
| **Tier 1: Workspace Units** | `pnpm -r test` | `packages/shared`, `apps/web`, `apps/listener`, connectors | **100% Offline**. Requires **no** external network access and **no** secrets. Mocks Horizon and external endpoints. |
| **Tier 2: Edge API Functions** | `pnpm api:test` | `supabase/functions/api/test/` | **Local Stack Only**. Requires local `supabase start` running on `127.0.0.1:54321`. **Zero** external internet calls. |
| **Tier 3: Fee Narrative & CI Gates** | `pnpm check:fees` | Tracked docs & codebase | **100% Offline**. Verifies single source of truth for platform fee (297 bp) and FX spread (190 bp). |
| **Tier 4: Smart Contracts** | `cargo test` | `contracts/subscription`, `contracts/smart-wallet`, `contracts/checkout` | **100% Offline**. Uses Soroban local test environment. |
| **Tier 5: AXL Formal Prover** | `cargo test` | `axl/` | **100% Offline**. Requires local `z3` prover installed. |
| **Tier 6: Live Testnet E2E** | `scripts/e2e-autocharge-fee-testnet.sh` | Mainnet/Testnet integration | **Online Network Required**. Connects to SDF Horizon Testnet and requires funded testnet accounts. |

### Running Tier 1 (Workspace Unit Tests)

```bash
# Run all workspace unit tests in parallel
pnpm -r test

# Or run tests for a specific workspace:
pnpm --filter @slippay/shared test
pnpm --filter @slippay/listener test
pnpm --filter @slippay/web test
```

### Running Tier 2 (Deno API Tests)

Ensure `supabase start` has completed, then run:

```bash
cd supabase/functions/api
deno test --allow-all --no-check --env-file=../../../.env.local.ci test/
```

### Running Tier 3 (CI Fee Narrative Check)

```bash
pnpm run check:fees
```

---

## 5. Building for Production

To produce production builds across the monorepo:

```bash
# Build all workspaces
pnpm -r build

# Or build individual targets:
pnpm --filter @slippay/shared build
pnpm --filter @slippay/web build
pnpm --filter @slippay/listener build
```

---

## 6. Troubleshooting Common Pitfalls

### 1. `Cannot find module '@slippay/shared'` or type errors in `apps/web`
- **Cause**: `@slippay/shared` has not been compiled yet.
- **Fix**: Run `pnpm --filter @slippay/shared build` first.

### 2. Deno API tests fail with connection refused to `54321`
- **Cause**: Local Supabase stack is not running or crashed.
- **Fix**: Run `supabase status` to check container health, or `supabase restart` to cleanly reboot.

### 3. Port conflict on `54321` or `54322`
- **Cause**: Another Postgres instance or Docker container is bound to the default Supabase ports.
- **Fix**: Stop existing Postgres services (`sudo service postgresql stop` on Linux) or check `docker ps`.

### 4. Windows PowerShell execution policy
- **Cause**: Script execution blocked by default client policy.
- **Fix**: Use `pnpm run bootstrap` or invoke Node directly (`node scripts/bootstrap.mjs`).

---

## 7. Useful References

- [Architecture Overview](../concepts/architecture.md)
- [Revenue Model & Fee Structure](../business/revenue-model.md)
- [API Reference](../api-reference/orders.md)
- [Deployment Directory](../deployments.md)
- [CI Pipeline Definition](../../.github/workflows/test.yml)
