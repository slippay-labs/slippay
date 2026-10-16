#!/usr/bin/env bash
# Deploy slippay-checkout contract to Stellar testnet.
# Enforces deploy-time parameter validation and post-deploy on-chain verification.
#
# Prereq:
#   stellar-cli installed (cargo install --locked stellar-cli)
#   cd contracts/checkout/
#
# Environment / Options:
#   FEE_TO        - SlipPay platform fee recipient address (required or defaults to deployer pubkey)
#   FEE_BPS       - SlipPay platform fee in basis points (default: 297 = 2.97%; max: 1000 = 10%)
#   NETWORK       - Target network (default: testnet)
#   DEPLOYER_NAME - Key identity in stellar keys (default: slippay-deployer)
#
# Output:
#   .testnet-deploy.env  (CONTRACT_ID, WASM_HASH, FEE_TO, FEE_BPS for backend integration)

set -euo pipefail

CONTRACT_DIR="$(cd "$(dirname "$0")" && pwd)"
NETWORK="${NETWORK:-testnet}"
DEPLOYER_NAME="${DEPLOYER_NAME:-slippay-deployer}"
FEE_BPS="${FEE_BPS:-297}"

# ── Argument Validation (Issue #302 & Issue #308) ─────────────────────────────
if ! [[ "$FEE_BPS" =~ ^[0-9]+$ ]]; then
  echo "ERROR: FEE_BPS must be an integer, got: '$FEE_BPS'" >&2
  exit 1
fi

if [ "$FEE_BPS" -gt 1000 ]; then
  echo "ERROR: FEE_BPS ($FEE_BPS) exceeds MAX_FEE_BPS (1000 = 10.00%)" >&2
  exit 1
fi

cd "$CONTRACT_DIR"

echo "=== build (wasm32, release) ==="
cargo build --target wasm32-unknown-unknown --release
WASM_PATH="$CONTRACT_DIR/target/wasm32-unknown-unknown/release/slippay_checkout.wasm"
ls -la "$WASM_PATH"

echo "=== ensure deployer keypair (testnet, friendbot funded) ==="
if ! stellar keys ls 2>/dev/null | grep -q "^${DEPLOYER_NAME}$"; then
  stellar keys generate --global "$DEPLOYER_NAME" --network "$NETWORK" --fund
fi
DEPLOYER_PUB=$(stellar keys address "$DEPLOYER_NAME")
echo "deployer: $DEPLOYER_PUB"

FEE_TO="${FEE_TO:-$DEPLOYER_PUB}"
echo "fee_to: $FEE_TO (fee_bps: $FEE_BPS)"

echo "=== upload wasm ==="
WASM_HASH=$(stellar contract upload \
  --network "$NETWORK" \
  --source "$DEPLOYER_NAME" \
  --wasm "$WASM_PATH" 2>&1 | tail -1)
echo "WASM_HASH=$WASM_HASH"

echo "=== deploy contract with constructor args ==="
CONTRACT_ID=$(stellar contract deploy \
  --network "$NETWORK" \
  --source "$DEPLOYER_NAME" \
  --wasm "$WASM_PATH" \
  -- \
  --fee_to "$FEE_TO" \
  --fee_bps "$FEE_BPS" 2>&1 | tail -1)
echo "CONTRACT_ID=$CONTRACT_ID"

echo "=== post-deploy verification on chain ==="
READ_FEE_BPS=$(stellar contract read \
  --network "$NETWORK" \
  --id "$CONTRACT_ID" \
  -- fee_bps 2>&1 | tail -1)
echo "on-chain fee_bps: $READ_FEE_BPS"

if [ "$READ_FEE_BPS" != "$FEE_BPS" ]; then
  echo "FATAL: On-chain fee_bps mismatch! Expected: $FEE_BPS, Got: $READ_FEE_BPS" >&2
  exit 1
fi

READ_FEE_TO=$(stellar contract read \
  --network "$NETWORK" \
  --id "$CONTRACT_ID" \
  -- fee_to 2>&1 | tail -1)
echo "on-chain fee_to: $READ_FEE_TO"

if [ "$READ_FEE_TO" != "$FEE_TO" ]; then
  echo "FATAL: On-chain fee_to mismatch! Expected: $FEE_TO, Got: $READ_FEE_TO" >&2
  exit 1
fi

echo "=== persist for backend integration ==="
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
echo "contract: $CONTRACT_ID"
echo "stellar.expert: https://stellar.expert/explorer/testnet/contract/$CONTRACT_ID"
echo
