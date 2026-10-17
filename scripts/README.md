# Scripts & Operations Tooling

This directory contains standalone operational, end-to-end testing, and demonstration scripts for the SlipPay repository:

## Demonstration & UI Tooling
- `demo-runner.mjs`: Automated walkthrough runner for video recording and local smoke testing across the payment flow.

## Schedulers & Background Workers
- `attested-scheduler.mjs`: Attested recurring charge scheduler for policy verification.
- `autocharge-scheduler.mjs`: Automated subscription recurring charge execution harness.

## End-to-End Testing & Verification
- `e2e-agent-wallet-mainnet.mjs` / `e2e-agent-wallet-testnet.mjs`: Agent smart wallet lifecycle and authorization suites.
- `e2e-attested-charge-mainnet.sh`: Mainnet attested charge execution runner.
- `e2e-autocharge-attested-testnet.sh`: Testnet subscription autocharge under policy attestation.
- `e2e-autocharge-fee-testnet.sh`: Subscription autocharge fee split validation.
- `e2e-autocharge-testnet.sh`: End-to-end recurring subscription charge test harness.
- `e2e-oracle-to-stellar-testnet.sh`: Oracle price and exchange rate propagation to Stellar testnet.
- `e2e-passkey-pay-testnet.mjs`: WebAuthn / Passkey payment validation on Stellar testnet.
- `e2e-payment-testnet.mjs`: Standard payment lifecycle matching validation.
- `e2e-subscription-charge-mainnet.mjs` / `e2e-subscriptions.mjs`: Merchant subscription lifecycle testing.

## Deployment & Setup Utilities
- `deploy-web.sh`: Web application build and static bundle deployment helper.
- `platform-setup.mjs`: Initial platform environment and credential configuration.
- `policy-checkout-spike-server.mjs`: Policy checkout testing server harness.
- `upload-deploy-mainnet.mjs`: Mainnet contract artifact deployment helper.
- `usdc-setup-mainnet.mjs`: Mainnet USDC trustline and issuer initialization script.
