#!/usr/bin/env bash
set -euo pipefail

# Slippay Local Bootstrap Script (POSIX / Linux / macOS)
# Mirrors the exact flow executed by GitHub CI (.github/workflows/test.yml)

echo "=== Slippay Monorepo Local Bootstrap ==="
echo ""

# 1. Toolchain prerequisite checks
echo "1. Checking required prerequisites..."
command -v node >/dev/null 2>&1 || { echo "❌ Node.js is required (>= 22). Aborting."; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "❌ pnpm is required (9.12.0). Aborting."; exit 1; }

echo "✓ Node.js $(node -v)"
echo "✓ pnpm $(pnpm -v)"

# 2. Dependency installation
echo ""
echo "2. Installing workspace dependencies..."
pnpm install --frozen-lockfile || {
  echo "ℹ️ --frozen-lockfile failed due to lockfile specifier delta. Retrying with pnpm install..."
  pnpm install
}

# 3. Critical build ordering
echo ""
echo "3. Compiling @slippay/shared (critical workspace dependency)..."
pnpm --filter @slippay/shared build

# 4. Environment seed
if [ ! -f .env.local ] && [ -f .env.local.ci ]; then
  echo ""
  echo "4. Seeding .env.local from .env.local.ci..."
  cp .env.local.ci .env.local
  echo "✓ Created .env.local"
fi

# 5. Run Tier 1 offline unit tests
echo ""
echo "5. Running Tier 1 workspace unit tests..."
pnpm --filter @slippay/shared test
pnpm --filter @slippay/listener test

echo ""
echo "========================================================"
echo "🎉 Bootstrap complete! All prerequisite workspace tests pass."
echo "For Deno API tests: supabase start && pnpm api:test"
echo "========================================================"
