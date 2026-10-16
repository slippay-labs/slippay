# Deployed Contracts and Authoritative Address Registry

> **Single Source of Truth** for all on-chain deployments across Stellar/Soroban, Base (EVM), and Solana.  
> Every address is recorded with its full identifier, network, version, deploy date, immutable constructor parameters, and lifecycle status (`current`, `legacy`, or `retired`).

---

## 1. Stellar / Soroban Contracts

### 1.1 Subscription Contracts (`contracts/subscription`)

| Network | Version | Contract Address (Full ID) | Status | Wasm Hash / Commit | Deploy Date | Deployer / Admin | Constructor & Configuration |
| :--- | :---: | :--- | :---: | :--- | :---: | :--- | :--- |
| **Mainnet** (`PUBLIC`) | **v0.4** | `CCT3KJXRUO3HJJ2GLTW2MISSQVUEKOPUG3B4YQH75TCGKAOC4P6FIKUF` | **Current** | `686e00ea...` | 2026-06-05 | `GCEYFLGNHCW4EIEX5LAVYGIGPT2KLHHVB6EOUWKKALA2FT7RMCHI242P` | Autocharge + attestation gate; 2.97% platform fee on autonomous rail. |
| **Mainnet** (`PUBLIC`) | **v0.2** | `CAQZECYTKQGUJETQRRBONGQA2DJBNQVYCSKBYCKXOVQOEEOMHKBTJZEP` | **Legacy** | `f8cfed71...` | 2026-06-03 | `GCEYFLGNHCW4EIEX5LAVYGIGPT2KLHHVB6EOUWKKALA2FT7RMCHI242P` | SEP-41 token allowance model; live for audit and legacy subscriptions. |
| **Mainnet** (`PUBLIC`) | **v0.1** | `CBJMQ6ZYQJ2OMM46FGXPEIKKZDRHHERBXUVE54ZN64FDPKN5DJKSEVQN` | **Legacy** | `1dbda19a2c9962cf798b62557f7c6388a3ea3c7c506ddb7aafbd549843510c6b` | 2026-05-16 | `GCEYFLGNHCW4EIEX5LAVYGIGPT2KLHHVB6EOUWKKALA2FT7RMCHI242P` | Buyer-signed charge model; live for audit. |
| **Testnet** | **v0.2** | `CBN3M7IAKNSCSDQIUUGDBHSFUQDOFAQQQK6UXJZYGGIWERQGT24VBTFQ` | **Current** | `1dbda19a2c9962cf798b62557f7c6388a3ea3c7c506ddb7aafbd549843510c6b` | 2026-05-16 | Deployer | F5 audit verified on testnet. |
| **Testnet** | **v0.1** | `CBWJ3LQGO7HBZBQK2MGS75EK266HNW4RJS77BVZIGZGDUUENXQMSHRHA` | **Retired** | `dbf7633d724ca1ed23d9ee1452fe182bd5da627ff6db73fe296ea0c55b09e465` | 2026-05-10 | Deployer | Superseded by v0.2. |

### 1.2 Checkout Contracts (`contracts/checkout`)

| Network | Version | Contract Address (Full ID) | Status | Wasm Hash | Deploy Date | Constructor Parameters | Notes |
| :--- | :---: | :--- | :---: | :--- | :---: | :--- | :--- |
| **Testnet** | **v0.1** | `CBO2COBZUTHH4II4JCQRZVO4RKDUIUH4MXZTAWOYVUZIVYI47UIDQCWQ` | **Current** | 5256 B | 2026-06-05 | `fee_to`: `GBVMU64N5JK3NICY3ZRPXVW4RQIQFHLBPW5UI4F55KVJPZJS3SIOWJF4`<br>`fee_bps`: `300` (3%) | Atomic 97/3 fee split primitive. |

### 1.3 Smart Wallet Contracts (`contracts/smart-wallet`)

| Network | Version | Contract Address (Full ID) | Status | Wasm Hash | Deploy Date | Deployer / Admin | Notes |
| :--- | :---: | :--- | :---: | :--- | :---: | :--- | :--- |
| **Testnet** | **v0.1 Template** | `CBG62CSWG6FYX6CTH5246V6DLQTIR3GKJEIZEQN3AH4W46E7ES6UNASO` | **Current** | `a2328321a8b0811ccee92edf8555849a4310081efaf26ec89140da31d8eb470c` | 2026-05-28 | `GDYKSPEDSST4YSSMNW6LMK27XN6YMM4SEN4RAKCCFT3N74GWPGXAJPQT` | Template contract for passkey-controlled smart wallets. |
| **Testnet** | **v0.1 Spike Instance** | `CBFX3HTMYYEHZMTDNXFKDSXKWOUGCAY46A53QDMV3WL5W6C6NKSCFK2S` | **Current** | Instance of template | 2026-05-28 | `GDYKSPEDSST4YSSMNW6LMK27XN6YMM4SEN4RAKCCFT3N74GWPGXAJPQT` | Provisioned via `scripts/policy-checkout-spike-server.mjs`. |

### 1.4 Stellar System & Platform Accounts

| Asset / Role | Network | Address (Full ID) | Status | Notes |
| :--- | :--- | :--- | :---: | :--- |
| **Platform Fee Account** | Mainnet | `GCEYFLGNHCW4EIEX5LAVYGIGPT2KLHHVB6EOUWKKALA2FT7RMCHI242P` | **Current** | Receives platform fee splits (operational deployer). |
| **Platform Fee Account** | Testnet | `GBVMU64N5JK3NICY3ZRPXVW4RQIQFHLBPW5UI4F55KVJPZJS3SIOWJF4` | **Current** | Testnet fee recipient for checkout contracts. |
| **Circle USDC (SAC)** | Mainnet | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` | **Current** | Stellar Asset Contract for canonical Circle USDC. |
| **Native XLM (SAC)** | Mainnet/Testnet | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` | **Current** | Stellar Asset Contract wrapping native XLM. |

---

## 2. Base (EVM / Comex) Contracts & Infrastructure

| Asset / Protocol | Network | Address (Full Hex) | Status | Notes |
| :--- | :--- | :--- | :---: | :--- |
| **Circle USDC** | Base Mainnet | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | **Current** | Canonical Circle ERC-20 USDC on Base (6 decimals). Immutable. |
| **Circle USDC** | Base Sepolia | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | **Current** | Circle testnet USDC on Base Sepolia. |
| **4P Off-Ramp Receiver Pin** | Base Mainnet | `0xE669C6Fe0493044D085C3cD08fb0289b53fA4449` | **Current** | Sell flow receiver pin; verified fail-closed on mismatch. |
| **Privy App ID** | Multi-chain | `cmqtifbrc00fj0cl2bgh19p0v` | **Current** | Comex biometric & embedded wallet authentication. |

---

## 3. Solana Programs & Infrastructure

| Program / Mint | Cluster | Address (Full Base58) | Status | Program Version | Notes |
| :--- | :--- | :--- | :---: | :---: | :--- |
| **slippay_mandate Program** | Mainnet / Devnet | `CmDKY8MxCWkCN9etSeKApHKnGuTKK6vn7qzhTkAtM9Bv` | **Current** | `0.1.0` | Bounded-autonomy mandate and single-CPI pay_split program. IDL validated at load. |
| **Circle USDC Mint** | Solana Mainnet | `EPjFWaJGqicjsAE6b8V9bJU5kVJ86RHRK6Vbp4grmGp2` | **Current** | Canonical | Canonical Circle USDC SPL token (6 decimals). Immutable on mainnet. |
| **Circle USDC Mint** | Solana Devnet | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | **Current** | Testnet | Circle devnet USDC SPL token. |
