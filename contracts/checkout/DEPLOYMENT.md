# SlipPay Checkout — deployment & proof

The "Stripe of stablecoin" revenue primitive. One customer payment → contract
forces an atomic 97/3 split (net to merchant, fee to SlipPay). Fee recipient +
bps fixed at deploy (constructor) — INESCAPABLE; the merchant cannot route around it.

## Contract
- src: `contracts/checkout/src/lib.rs` — `pay(from, merchant, token, amount)`, `__constructor(fee_to, fee_bps)`, `fee_bps()`, `fee_to()`.
- wasm: 5256 bytes, 4 exported fns.

## Testnet deploy (2026-06-05)
- contract id: `CBO2COBZUTHH4II4JCQRZVO4RKDUIUH4MXZTAWOYVUZIVYI47UIDQCWQ`
- fee_to: `GBVMU64N5JK3NICY3ZRPXVW4RQIQFHLBPW5UI4F55KVJPZJS3SIOWJF4` (slippay-fee)
- fee_bps: 300 (3%)
- token used in proof: native SAC `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`

## Proof
- tx `e142cd0bbaa19adfe1b74d3629ea7788f06abca8a0ba6ba121e6f41c67390941`
- buyer paid 10 → merchant +9.7 (97%), slippay-fee +0.3 (3%), one atomic call.

## Fee Semantics & Invariants

The checkout contract executes immutable revenue splits on-chain.

| Attribute | Specification |
| :--- | :--- |
| **Rate Unit & Bounds** | Basis points (`fee_bps`: 1 bp = 0.01% = 0.0001). Valid range is `0..=10_000` bps (0% to 100%), enforced by constructor. |
| **Formula** | `fee = trunc(amount * fee_bps / 10_000)`, `net = amount - fee` |
| **Rounding Direction** | Truncating integer division (floor toward zero). Fractional dust remainders ($r = (\text{amount} \times \text{fee\_bps}) \pmod{10000}$) stay with the merchant, ensuring SlipPay never overcharges. |
| **Conservation Identity** | `net + fee ≡ amount` invariant across all payments. |
| **Off-Chain Ledger Mapping** | On-chain stroops map directly to `orders.fee_usdc` (`numeric(20,7)`) via `fee_usdc = fee_stroops / 10^7`. |
| **Zero-Net Behaviour** | At `fee_bps = 10_000` (100% fee rate), `net == 0`. The merchant transfer leg is omitted to prevent SEP-41 token reverts on 0-value transfers. |
| **Zero-Fee Behaviour** | At `fee_bps = 0` (0% fee rate), `fee == 0`. The platform fee transfer leg is omitted. |
| **Atomicity & Revert Safety** | Payer authorizes full amount with `from.require_auth()`. If either transfer fails or reverts, the entire payment reverts atomically. |
| **Specification Link** | Canonical off-chain specification documented in [`docs/fees.md`](../../docs/fees.md).

## Mainnet path
- same contract, deploy with mainnet slippay-fee + USDC SAC as token. Needs deployer XLM.
- frontend wrapper: merchant creates charge (amount) → QR encodes {checkout contract, merchant, amount} → customer pays via /pay (passkey → invoke checkout.pay) → split auto.
