# 4P ramp on Solana — funding the LazorKit smart wallet

Goal: in production, the buyer funds their Solana biometric (LazorKit) smart
wallet via Pix → USDC on Solana, delivered by 4P directly to the wallet address.
This replaces the devnet test-mint (`scripts/devnet-testmint.cjs`), which is e2e
only.

## Verified (2026-06-18)
- 4P API key is **active**: `GET /v1/4p/status` → `{"enabled":true,"provider":"4p","chain":"Base","asset":"USDC","rails":["pix"]}` (was 401 on 16/06).
- 4P (Gabriel Broetto, comercial) confirmed networks: **Polygon, Ethereum, Base, Solana, Avalanche, Arbitrum**.
- Backend **already supports Solana with no code change**: `POST /v1/4p/onramp`
  takes optional `chain` + required `receiverWallet`, forwarded to the 4P
  `PUT /v1/pix/transaction` as `chain` + `custom_data.receiver_wallet`
  (routes/fourp.ts:129/135/162, lib/fourp/client.ts:160/162). Default chain is
  env `FOURP_CHAIN` ("Base"); per-request `chain` overrides it.

## The Solana onramp request (no backend change)
The Solana `/cash` posts the smart-wallet address as the receiver and overrides
the chain — Base stays the default for everything else:

```
POST https://api.slippay.cc/api/v1/4p/onramp
{
  "amountBrl": 50.00,
  "receiverWallet": "<LazorKit vault PDA, base58>",
  "chain": "Solana",
  "asset": "USDC",
  "email": "buyer@example.com",
  "cpf": "<cpf>"
}
```

## Gated on (before a real Solana onramp)
1. **Confirm with 4P (Gabriel):** does 4P deliver *native USDC on Solana* (Circle
   mint) via API? Exact `chain` identifier string ("Solana"?) and the
   `receiver_wallet` format for Solana. Network listed ≠ asset guaranteed.
2. **Frontend:** Cash.tsx (Solana mode) passes `chain:"Solana"` + the connected
   LazorKit `smartWalletPubkey` as `receiverWallet`. Small wiring; do once (1) is
   confirmed.
3. **Empirical probe (side-effecting — needs operator ok):** one onramp with a
   tiny amount creates an *unpaid* Pix charge on the 4P account; it confirms 4P
   accepts `chain:"Solana"` without moving money. Not run unilaterally.

## NOT done (deliberately)
- Did NOT flip `FOURP_CHAIN` global to Solana (per-request override is enough and
  keeps Base intact).
- Did NOT create a 4P onramp (outward-facing side effect).

## Margin rounding (single rule, both directions)

Slippay applies its spread as integer basis points through
supabase/functions/api/lib/fourp/margin.ts:

- marginBps is an integer in [0, 1000] (0-10%). Anything else falls back to 280.
- The amount is scaled to integer minor units first (2 decimals for BRL, 6 for USDC),
  the margin is applied as units * (10000 - marginBps) / 10000, and the result is
  floored, so a sub-unit remainder always stays with the platform.
- The net figure drives the displayed rate. On the off-ramp brlOut is the floored net,
  so brlOut / cryptoOut is the rate the user actually receives; on the on-ramp the net
  price per asset is floored to 6 decimals.
- Money values are never produced with toFixed, which truncates a string
  representation and can disagree with what 4P settles.
