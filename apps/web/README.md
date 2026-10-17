# @slippay/web

The frontend web application for SlipPay, supporting merchant dashboards, checkout flows, WebAuthn passkey payments, and multi-rail settlements.

## Environment Variables Configuration

In accordance with security best practices (Issue #181), production credentials and environment configurations are **never tracked in git**.

### Template Files
- `.env.example`: Default environment variables for local development (points to local Supabase, Stellar testnet).
- `.env.production.example`: Template for production deployments.

### Required Production Variables
When building for production (`pnpm build` or `vite build --mode production`), the following environment variables must be provided via the CI/CD deployment environment or an untracked `.env.production` file:

| Variable | Description | Example / Format |
| :--- | :--- | :--- |
| `VITE_API_BASE` | Same-origin API endpoint | `https://app.slippay.cc/api` |
| `VITE_STELLAR_NETWORK` | Stellar network selection | `PUBLIC` (or `TESTNET`) |
| `VITE_PLATFORM_ADDRESS` | Mainnet platform fee-collection account | 56-character Stellar public key (`G...`) |
| `VITE_SUB_CONTRACT` | Deployed Soroban subscription contract | 56-character Soroban contract address (`C...`) |
| `VITE_SUPABASE_URL` | Production Supabase project URL | `https://<project-ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Supabase publishable anonymous key | JWT string (`eyJ...`) |
| `VITE_PRIVY_APP_ID` | Privy application ID for embedded auth | String identifier |
| `VITE_TRANSAK_API_KEY` | Transak fiat on-ramp widget key | UUID key |
| `VITE_TRANSAK_ENV` | Transak environment target | `production` (or `staging`) |
| `VITE_4P_OFFRAMP_RECEIVER`| Pinned 4P off-ramp receiver address | Base EVM address (`0x...`) |

### Local Development
```bash
cp .env.example .env.local
pnpm dev
```
