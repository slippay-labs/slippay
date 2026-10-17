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

## Automated Testnet Deploy & Verification Script

Run `deploy-testnet.sh` with explicit fee parameters:

```bash
cd contracts/checkout
./deploy-testnet.sh <fee_to_address> [fee_bps]
```

Or via environment variables:

```bash
FEE_TO="GBVMU64N5JK3NICY3ZRPXVW4RQIQFHLBPW5UI4F55KVJPZJS3SIOWJF4" FEE_BPS=297 ./deploy-testnet.sh
```

The script automatically performs:
1. Argument validation: checks `$FEE_TO` against Stellar Base32 public key format and bounds `$FEE_BPS` between 0 and 10,000.
2. Release compilation and bytecode hash extraction.
3. Testnet deployment with constructor arguments.
4. **Post-deploy on-chain smoke verification**: calls `fee_bps()` and `fee_to()` on the live deployed contract to ensure on-chain state accurately matches parameters.
5. Persists output to `.testnet-deploy.env` (ignored by git).

## Mainnet path
- same contract, deploy with mainnet slippay-fee + USDC SAC as token. Needs deployer XLM.
- frontend wrapper: merchant creates charge (amount) → QR encodes {checkout contract, merchant, amount} → customer pays via /pay (passkey → invoke checkout.pay) → split auto.

