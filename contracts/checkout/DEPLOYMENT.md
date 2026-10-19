# SlipPay Checkout — deployment & proof

The "Stripe of stablecoin" revenue primitive. One customer payment → contract
forces an atomic split (net to merchant, fee to SlipPay). Fee recipient +
basis points fixed at deploy (constructor) — INESCAPABLE; the merchant cannot
route around the fee. Either both legs settle or none does.

## Contract
- src: `contracts/checkout/src/lib.rs` — `pay(from, merchant, token, amount)`, `__constructor(fee_to, fee_bps)`, `fee_bps()`, `fee_to()`.
- wasm: 5256 bytes, 4 exported fns.

## Fee rate and range
- `fee_bps` is basis points with denominator 10_000 (1 bp = 0.01%). Valid range:
  `0 <= fee_bps <= 10_000` (0% to 100%). The constructor panics with `BadConfig`
  if `fee_bps > 10_000`.
- The orders table enforces a stricter range: `0 <= platform_fee_bp <= 1000`
  (0% to 10%), per migration `20261008130000`. The default is 297 (2.97%).
- Both minima (0) and maxima are inclusive.
- Out-of-range `fee_bps > 10_000` at construction causes deployment failure.
- Out-of-range `platform_fee_bp` outside `[0, 1000]` is rejected by the database CHECK constraint.

## Testnet deploy (2026-06-05)
- contract id: `CBO2COBZUTHH4II4JCQRZVO4RKDUIUH4MXZTAWOYVUZIVYI47UIDQCWQ`
- fee_to: `GBVMU64N5JK3NICY3ZRPXVW4RQIQFHLBPW5UI4F55KVJPZJS3SIOWJF4` (slippay-fee)
- fee_bps: 300 (3%)
- token used in proof: native SAC `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`

## Proof
- tx `e142cd0bbaa19adfe1b74d3629ea7788f06abca8a0ba6ba121e6f41c67390941`
- buyer paid 10 → merchant +9.7 (97%), slippay-fee +0.3 (3%), one atomic call.

## Fee formula and rounding
- On-chain: `fee = amount * fee_bps / 10_000` (Rust integer division, truncates
  toward zero). `net = amount - fee`.
- Integer truncation means the merchant receives at most the floored proportion;
  for positive values, the fractional part (at most 1 unit) is lost to the fee,
  favoring the merchant by at most one stroop/micro-unit when the division is
  inexact.
- Off-chain invoice: `fee_usdc = round(usdc_amount * platform_fee_bp / 10000.0, 7)`
  (floating-point division, rounded to 7 decimal places). The different rounding
  direction may cause the on-chain fee to differ from the invoiced `fee_usdc` by
  up to 1 unit in the last decimal place.

## Maximum-rate behavior
- `fee_bps = 10_000` produces `fee = amount` and `net = 0`. The entire payment
  goes to the fee recipient; the merchant receives nothing. The contract does not
  prevent the fee from consuming the full amount.
- `fee_bps = 0` produces `fee = 0` and `net = amount`. The merchant receives the
  full amount; no fee is transferred.

## Zero-net payment
- When `fee_bps = 10_000`, `net = 0` is permitted. The contract requires `amount > 0`
  (rejects `BadAmount` if `amount <= 0`), but does not reject a zero-net result.
- Callers should verify the intended `fee_bps` before expecting a non-zero net.

## Atomicity and token reverts
- Both transfers (merchant net and fee to SlipPay) are atomic: two nested SEP-41
  transfers within a single Soroban contract call.
- If either transfer fails (insufficient balance, frozen account, token contract
  revert), the entire transaction reverts. No partial state changes persist.
- The contract takes `from.require_auth()` once; the payer authorizes the whole
  charge in a single operation.
- The `checkout_paid` event is emitted only if both transfers succeed. If either
  fails, the event is not emitted and all state changes are reverted.

## Mainnet path
- Same contract logic; deploy with mainnet `slippay-fee` address and USDC SAC as
  token. Needs deployer XLM.
- Frontend wrapper (TODO): merchant creates charge (amount) → QR encodes
  `{checkout contract, merchant, amount}` → customer pays via `/pay`
  (passkey → invoke `checkout.pay`) → split auto.

## Storage model
- Instance storage:
  - `DataKey::FeeTo` → `Address` (fee recipient, immutable).
  - `DataKey::FeeBps` → `u32` (basis points, immutable, `<= 10_000`).
- No per-payment state is stored; each `pay` is stateless beyond reading the fee config.

## Caps / invariants
- `fee_bps` is fixed at construction and validated `<= 10_000`. No setter exists.
- `fee_to` is fixed at construction. No setter exists. The merchant cannot
  redirect the fee.
- `amount > 0` required.
- Atomicity: net-to-merchant and fee-to-platform settle together or not at all.
- A note on fee figures: the fee is a configured parameter of the deployed
  instance. The API default is 297 bp (2.97%); this testnet checkout contract
  was deployed with `fee_bps = 300` (3%). A mainnet checkout deployment should
  be constructed with the canonical 297 bp to match the API.

## Status & honest limitations
- Testnet only. Mainnet deployment is pending (deployer XLM + `/pay` wrapper).
- **No tests yet** for this contract. The behavior above is from source and a
  single proof transaction, not a test suite.
- No third-party audit of this contract.
