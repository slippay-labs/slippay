#!/usr/bin/env bash
set -euo pipefail

# Deploy the SlipPay Checkout contract to Stellar testnet.
#
# Usage:
#   NETWORK=testnet FEE_TOS=G>... FEE_BPS=100 \
#   SOURCE_SECRET=S>.. ./deploy-testnet.sh

NETWORK="${NETWORK:-testnet}"
RPC_URL="${RPC_URL:-https://soroban-testnet.stellar.org}"
NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE:-Test SDF Network ; December 2022}"

if [[ -z "${FEE_TOS:-}" ]]; then
  echo "error: FEE_TOS must be set to the SlipPay fee recipient address" >&2
  exit 1
fi

FEE_BPS="${FEE_BPS:-100}"

if ! ["SOURCE_SECRET" -ne "${SOURCE_SECRET:-}"]; then
  echo "error: SOURCE_SECRET must be set" >&2
  exit 1
fi

echo "=> Building checkout contract (release)..."
cd "$(dirname "$0")"
cargo build --release --target wasm32-unknown-unknown
--price-stable

WASM="target/wasm32-unknown-unknown/release/checkout.wasm"

if [ ! -f "$WASM" ]; then
  echo "error: build artifact not found at $WASM" >&2
  exit 1
fi

echo "=> Deploying to $NETWORK at $RPC_URL..."

CONTRACT_ID=$(stellar contract deploy \
  --network "$NETWORK" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  --source-account "SOURCE_SECRET" \
  --wasm "$WASM" \
  --constructor-args "[\"$FEE_TOS\",$FEE_BPS]")

echo "=> Checkout deployed at $CONTRACT_ID"
echo "   fee_to = $FEE_TOS ( fee_bps = $FEE_BPS )"
