# Deployed Contracts & Versions

>Single authoritative record of every deployed SlipPay contract address, by network.
>
>This is the source of truth for "what is deployed". Each crate's `DEPLOYED.md` links here instead of duplicating addresses.
>Update this file on every deploy.

## Solana Mainnet

| Contract | Address (full) | Version / Commit | Deploy date | Status | Notes |
|---|---|---|---|---|---|
| Platform fee account | `GCEYFLGNHCW4EIEX5LAVYGIGPT2KLHHVB6DOUWKKALA2FT7RMCHI242P` | — | — | current | Mainnet platform fee recipient (`VITE_PLATFORM_ADDRESS`) |
| Subscription contract | `CCT3KJXRUO3HJJ2GLTW2MISSQVUEKOPUG3B4YQH75TCGKAOC4PFFIKUF` | current | — | current | Active subscription program (`VITE_SUB_CONTRACT`) |
| Subscription contract | `CAQZECYT…` | v.0.2 | — | legacy | Kept live for legacy/audit; full id must be recovered from the v0.2 deploy record / on-chain history |
| Subscription contract | `CBJMQ6ZY…` | v.0.1 | — | legacy | Kept live for legacy/audit; full id must be recovered from the v0.1 deploy record / on-chain history |
| 4P off-ramp receiver | — | — | — | current | Recorded in `apps/web/.env.production` |

## Base (EVM)

| Contract | Address (full) | Version / Commit | Deploy date | Status | Notes |
|---|---|---|---|---|---|
| Checkout | — | — | — | current | Fee recipient and rate are immutable constructor params (see below) |

## Constructor parameters (immutable)

### Checkout (Base)
- Fee recipient: —
- Rate: —

## References

- `contracts/smart-wallet/DEPLOYED.md` — links here

- `contracts/subscription/DEPLOYED.md` — links here
- `contracts/checkout/DEPLOYMENT.md` — links here
- `apps/web/.env.production` — comments point here
