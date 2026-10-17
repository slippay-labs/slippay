#!/usr/bin/env bash
# Deploy slippay-checkout contract to Stellar testnet with post-deploy verification.
#
# Prereq:
#   stellar-cli installed (cargo install --locked stellar-cli)
#   rustup target add wasm32v1-none (or wasm32-unknown-unknown)
#   cd contracts/checkout/
#
# Usage:
#   ./deploy-testnet.sh [FEE_TO] [FEE_BPS]
# Or configure via environment variables:
#   FEE_TO="GBVMU64N5JK3NICY3ZRPXVW4RQIQFHLBPW5UI4F55KVJPZJS3SIOWJF4" FEE_BPS=297 ./deploy-testnet.sh
#
# Output:
#   .testnet-deploy.env (CONTRACT_ID, WASM_HASH, FEE_TO, FEE_BPS for backend integration)

set -euo pipefail

CONTRACT_DIR="$(cd "$(dirname "$0")" && pwd)"
NETWORK="${NETWORK:-testnet}"
DEPLOYER_NAME="${DEPLOYER_NAME:-slippay-deployer}"

cd "$CONTRACT_DIR"

# 1. Parse and validate arguments
FEE_TO="${1:-${FEE_TO:-}}"
FEE_BPS="${2:-${FEE_BPS:-297}}"

if [[ -z "$FEE_TO" ]]; then
  echo "ERROR: FEE_TO is required. Pass as \$1 or set FEE_TO environment variable." >&2
  echo "Usage: $0 <fee_to_address> [fee_bps]" >&2
  exit 1
fi

if ! [[ "$FEE_TO" =~ ^[GC][A-Z2-7]{55}$ ]]; then
  echo "ERROR: FEE_TO must be a valid Stellar public key (56-character Base32 starting with G or C). Got: '$FEE_TO'" >&2
  exit 1
fi

if ! [[ "$FEE_BPS" =~ ^[0-9]+$ ]]; then
  echo "ERROR: FEE_BPS must be an integer. Got: '$FEE_BPS'" >&2
  exit 1
fi

if (( FEE_BPS < 0 || FEE_BPS > 10000 )); then
  echo "ERROR: FEE_BPS must be between 0 and 10000 (0% to 100%). Got: '$FEE_BPS'" >&2
  exit 1
fi

echo "=== deployment parameters ==="
echo "NETWORK:      $NETWORK"
echo "DEPLOYER:     $DEPLOYER_NAME"
echo "FEE_TO:       $FEE_TO"
echo "FEE_BPS:      $FEE_BPS (${FEE_BPS} bps = $(awk "BEGIN {print $FEE_BPS/100}")%)"

# 2. Build WASM
echo "=== build (wasm32v1-none / wasm32-unknown-unknown, release) ==="
TARGET="wasm32v1-none"
if ! rustup target list --installed 2>/dev/null | grep -q "^wasm32v1-none$"; then
  TARGET="wasm32-unknown-unknown"
fi

cargo build --target "$TARGET" --release
WASM_PATH="$CONTRACT_DIR/target/$TARGET/release/slippay_checkout.wasm"
if [[ ! -f "$WASM_PATH" ]]; then
  echo "ERROR: Built WASM file not found at $WASM_PATH" >&2
  exit 1
fi
ls -la "$WASM_PATH"

# 3. Ensure deployer keypair
echo "=== ensure deployer keypair (testnet, friendbot funded) ==="
if ! stellar keys ls 2>/dev/null | grep -q "^${DEPLOYER_NAME}$"; then
  stellar keys generate --global "$DEPLOYER_NAME" --network "$NETWORK" --fund
fi
DEPLOYER_PUB=$(stellar keys address "$DEPLOYER_NAME")
echo "deployer: $DEPLOYER_PUB"

# 4. Upload WASM
echo "=== upload wasm ==="
WASM_HASH=$(stellar contract upload \
  --network "$NETWORK" \
  --source "$DEPLOYER_NAME" \
  --wasm "$WASM_PATH" 2>&1 | tail -1)
echo "WASM_HASH=$WASM_HASH"

# 5. Deploy with constructor arguments
echo "=== deploy instance with constructor args ==="
CONTRACT_ID=$(stellar contract deploy \
  --network "$NETWORK" \
  --source "$DEPLOYER_NAME" \
  --wasm "$WASM_PATH" \
  -- \
  --fee_to "$FEE_TO" \
  --fee_bps "$FEE_BPS" 2>&1 | tail -1)
echo "CONTRACT_ID=$CONTRACT_ID"

# 6. Post-deploy on-chain smoke verification
echo "=== post-deploy verification ==="
ONCHAIN_FEE_BPS=$(stellar contract invoke \
  --id "$CONTRACT_ID" \
  --network "$NETWORK" \
  --source "$DEPLOYER_NAME" \
  -- fee_bps 2>&1 | tr -d '"\r\n')
echo "on-chain fee_bps: $ONCHAIN_FEE_BPS (expected: $FEE_BPS)"

if [[ "$ONCHAIN_FEE_BPS" != "$FEE_BPS" ]]; then
  echo "VERIFICATION FAILED: on-chain fee_bps '$ONCHAIN_FEE_BPS' does not match deployed rate '$FEE_BPS'!" >&2
  exit 1
fi

ONCHAIN_FEE_TO=$(stellar contract invoke \
  --id "$CONTRACT_ID" \
  --network "$NETWORK" \
  --source "$DEPLOYER_NAME" \
  -- fee_to 2>&1 | tr -d '"\r\n')
echo "on-chain fee_to:  $ONCHAIN_FEE_TO (expected: $FEE_TO)"

if [[ "$ONCHAIN_FEE_TO" != "$FEE_TO" ]]; then
  echo "VERIFICATION FAILED: on-chain fee_to '$ONCHAIN_FEE_TO' does not match deployed recipient '$FEE_TO'!" >&2
  exit 1
fi

echo "VERIFICATION SUCCESS: on-chain state accurately matches deployment parameters."

# 7. Persist deploy environment
echo "=== persist for backend / frontend integration ==="
cat > "$CONTRACT_DIR/.testnet-deploy.env" <<EOF
SLIPPAY_CHECKOUT_CONTRACT_TESTNET=$CONTRACT_ID
SLIPPAY_CHECKOUT_WASM_HASH_TESTNET=$WASM_HASH
SLIPPAY_CHECKOUT_FEE_TO=$FEE_TO
SLIPPAY_CHECKOUT_FEE_BPS=$FEE_BPS
SLIPPAY_CHECKOUT_DEPLOYER_PUB=$DEPLOYER_PUB
SLIPPAY_CHECKOUT_DEPLOYED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
echo "wrote $CONTRACT_DIR/.testnet-deploy.env"

echo
echo "=== DONE ==="
echo "checkout contract: $CONTRACT_ID"
echo "stellar.expert:    https://stellar.expert/explorer/testnet/contract/$CONTRACT_ID"
