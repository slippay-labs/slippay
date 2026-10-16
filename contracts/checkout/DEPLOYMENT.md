# SlipPay Checkout — Deployment & On-Chain Fee Semantics

The "Stripe of stablecoin" revenue primitive. One customer payment → the contract executes an inescapable atomic split (net to merchant, platform fee to SlipPay).

The fee recipient (`fee_to`) and fee rate (`fee_bps`) are fixed at deploy time via the contract constructor (`__constructor`) and stored immutably in instance storage. Neither the merchant nor the payer can route around the fee.

---

## 1. Mathematical Specifications & Fee Semantics

- **Basis Points Unit**: 1 bp = 0.01% (e.g., `297` = 2.97%, `1000` = 10.00%).
- **Permissible Range**: `0 <= fee_bps <= 1000` (`MAX_FEE_BPS = 1000`, i.e., 10.00%).
  - Aligns strictly with the database constraint on `orders.platform_fee_bp` and the canonical fee narrative defined in [`docs/fees.md`](../docs/fees.md).
  - Deployments specifying `fee_bps > 1000` are rejected immediately with `Error::BadConfig` (contract error code 1).
- **Formula**:
  $$\text{fee} = \lfloor \frac{\text{amount} \times \text{fee\_bps}}{10\,000} \rfloor$$
  $$\text{net} = \text{amount} - \text{fee}$$
- **Rounding Direction & Conservation**:
  - Integer division **truncates down** (floor).
  - Truncation favors the merchant by at most 1 stroop (0.0000001 USDC).
  - $\text{net} + \text{fee} = \text{amount}$ holds strictly across all values.
- **Zero-Net & Positive Net Guarantee**:
  - Because `fee_bps <= 1000` (at most 10%), for any strictly positive `amount > 0`, the net settlement is guaranteed strictly positive ($\text{net} \ge 0.90 \times \text{amount} > 0$).
  - `net <= 0` is guarded against with `Error::BadAmount` before executing transfers, preventing SEP-41 zero-transfer reverts.
- **Checked Arithmetic**:
  - The multiplication `amount * fee_bps` uses checked integer arithmetic (`checked_mul`).
  - Overflow attempts revert with `Error::Overflow` (contract error code 3).
- **Atomic Revert**:
  - The payer authorizes the transaction once via `from.require_auth()`.
  - Both SEP-41 token transfers (`from -> merchant` for net, and `from -> fee_to` for fee) execute within the same invocation.
  - If either transfer fails (e.g., insufficient payer balance, token contract frozen), the entire invocation reverts atomically. Neither party receives funds.
- **Relationship to Off-Chain `fee_usdc`**:
  - For checkout orders processed on Stellar, the on-chain fee calculation matches the off-chain `orders.fee_usdc` calculation stroop-for-stroop.

---

## 2. Deploy-Time Security & Invariants

1. **Self-Address Locking Guard**: The constructor explicitly forbids setting `fee_to == env.current_contract_address()`, preventing fee revenues from being permanently trapped in a contract with no withdrawal method.
2. **Merchant Collusion / Collision Guard**: The `pay` function asserts `merchant != fee_to`, rejecting configurations where the platform fee would collapse into the merchant account.
3. **Typed Error Views**: `fee_bps()` and `fee_to()` return typed `Error::BadConfig` when called on an unconfigured or storage-cleared contract instance, avoiding silent zeros or opaque traps.

---

## 3. Deployment Artifacts & Addresses

- **Contract Source**: [`contracts/checkout/src/lib.rs`](src/lib.rs)
- **Unit Test Suite**: [`contracts/checkout/src/test.rs`](src/test.rs) (16 tests covering boundaries, vector tables, and atomic reverts)
- **Automated Deploy Script**: [`contracts/checkout/deploy-testnet.sh`](deploy-testnet.sh)
- **Address Registry**: [`docs/deployments.md`](../../docs/deployments.md)

### Testnet Deployment
- **Contract ID**: `CBO2COBZUTHH4II4JCQRZVO4RKDUIUH4MXZTAWOYVUZIVYI47UIDQCWQ`
- **Fee Recipient**: `GBVMU64N5JK3NICY3ZRPXVW4RQIQFHLBPW5UI4F55KVJPZJS3SIOWJF4` (`slippay-fee`)
- **Default Fee Rate**: `297` (2.97%)
- **Testnet Explorer**: [View on Stellar Expert](https://stellar.expert/explorer/testnet/contract/CBO2COBZUTHH4II4JCQRZVO4RKDUIUH4MXZTAWOYVUZIVYI47UIDQCWQ)
