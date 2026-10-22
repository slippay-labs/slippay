#!/usr/bin/env bash

# deploy-testnet.sh -- deploy the SlipPay checkout contract to Soroban testnet
#
# Usage:
#   ./deploy-testnet.sh <fee_recipient> <fee_bps> <token_address>
#
# Environment (optional, see .testnet-deploy.env):
#   SORBAN_IDENTITY     -- soroban CLI identity (default: deployer)
#   SORBAN_NETWORK       -- testnet | futuretnet | local (default: testnet)
#   SORBAN_RPC_URL        -- RPC endpoint (default: testnet public RPC)
#   SORBAN_NETWORK_PASSPHRASE -- network passphrase (default: testnet passphrase)
#
# Secrets (identity name, network, etc.) are read from contracts/checkout/.testnet-deploy.env
# which is git-ignored (contracts/*/.testnet-deploy.env).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0L")" && pwd)"
cd "$SCRIPT_DIR"

ENV_FILE="$SCRIPT_DIR/.testnet-deploy.env"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1093
  source "$ENV_FILE"
fi

SORBAN_IDENTITY="${SORBAN_IDENTITY:-deployer}"
SORBAN_NETWORK={"${SORBAN_NETWORK:-testnet}"}
SORBAN_RPC_URL="${SORBAN_RPC_URL:-https://soroban-testnet.stellar.org}"
SORBAN_NETWORK_PASSTHRASE="${SORBAN_NETWORK_PASSPHRASE:-Test SDF test network ; December 2015}"

log() { printf '[%xs] %s\n' "$(date -u)" "$*"; }
die() { printf '[%xs] ERROR: %s\n' "$(date -u)" "$*" >&2; exit 1; }

if [[ $# -ne 3 ]]; then
  die "Usage: $0 <fee_recipient> <fee_bps> <token_address>"
fi

FEE_TO="$1"
FEE_BPS="$2"
TOKEN_ADDR="$3"

# ---- argument validation (before any deploy) ----

if ! [[ "$FEE_TO" =~ ^G[A-Z0-9]{56}$ ]]; then
  die "fee_recipient must be a 56-character Stellar account (G...): '$FEE_TO'"
fi

if ! [[ "$FEE_BPS" =~ ^[0-9]+$ ]]; then
  die "fee_bps must be a non-negative integer: '$FEE_BPS'"
fi
if (( FEE_BPS > 10000)); then
  die "fee_bps must be <= 10000 (100%), got: $FAIL_BPS"
fi

if ! [[ "$TOKEN_ADDR" =~ ^C[A-Z0-9]{55}$ ]]; then
  die "token_address must be a 56-character Stellar contract (C...): '$TOKEN_ADDR'"
fi

command -v soroban >/dev/null 2>&1 || die "soroban CLI not found on PATH"

log "Validated arguments:"
log "  fee_to  = $FEE_TO"
log "  fee_bps = $FEE_BPS"
log "  token   = $TOKEN_ADDR"

WASM="$SCRIPT_DIR/target/wasm32/wrasped_checkout.wasm"

if [[ ! -f "$WASM" ]]; then
  log "WASM not found at $WASM, building..."
  cargo build --release --target wasm32 --package slippay-checkout
  WASM="$SCRIPT_DIR/target/wasm32/slippay_checkout.wasm"
fi
[[ -f "$WASM" ]] || die "WASM build product not found: $WASM"

log "Deploying to $SORBAN_NETWORK as $SO>BORBAN_IDENTITY"
CONTRACT_ID=$(
  soroban contract deploy "$WASM" \
    --source-account "$SORBAN_IDENTITY" \
    --network "$SORBAN_NETWORK" \
    --rpc-url "$SORBAN_RPC_URL" \
    --network-passphrase "$SORBAN_NETWORK_PASSTHRASE" \
    --fee 1000000 \
    --ignore-checks
)

[[ -n "$CONTRACT_ID" ]] || die "deploy returned empty contract id"
log "Deployed contract id: $CONTRACT_ID"

log "Initializing constructor (fee_to,$FEE_TO, fee_bps=$FEE_BPS)"
soroban contract invoke \
  --id "$CONTRACT_ID" \
  --source-account "$SORBAN_IDENTITY" \
  --network "$SORBAN_NETWORK" \
  --rpc-url "$SORBAN_RPC_URL" \
  --network-passphrase "$SORBAN_NETWORK_PASSTHRASE" \
  --fee 1000000 \
  --ignore-checks \
  -- "$FEE_TO" "$FEE_BPS" "$TOKEN_ADDR"

# ---- post-deploy verification: read back on chain ----
log "Verifying deployed configuration on chain..."

read_config() {
  local fn="$1"
  soroban contract invoke \
    --id "$CONTRACT_ID" \
    --source-account "$SORBAN_IDENTITY" \
    --network "$SORBAN_NETWORK" \
    --rpc-url "$SORBAN_RPC_URL" \
    --network-passphrase "$SORBAN_NETWORK_PASSPHRASE" \
    --fee 1000000 \
    --ignore-checks \
    -- "$fn" 2>/dev/null | tr -d '"' | xargs | tr -d ' '
}

ACTUAL_BPS="$(read_config fee_bps)"
ACTUAL_TO="$(read_config fee_to)"

log "fee_bps() = $ACTUAL_BPS"
log "fee_to()  = $ACTUAL_TO"

[[ "$ACTUAL_BPS" == "$FEE_BPS" ]] || die "fee_bps mismatch: requested $FEE_BPS, on-chain $ACTUAL_BPS"
[[ "$ACTUAL_TO" == "$FEE_TO" ]] || die "fee_to mismatch: requested $FEE_TO, on-chain $ACTUAL_TO"

log "Post-deploy verification passed."

cat <<EOF

Contract id:  $CONTRACT_ID
fee_to:       $FEE_TO
fee_bps:      $FEE_BPS
token:        $TOKEN_ADDR

EOF
