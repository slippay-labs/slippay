#![no_std]
//! SlipPay Checkout — the "Stripe of stablecoin" revenue primitive.
//!
//! # Fee Semantics, Rounding & Rate Bounds
//!
//! - **Rate Unit & Bounds**: Fee rate is configured in basis points (`fee_bps`: 1 bp = 0.01% = 0.0001).
//!   Permitted deploy range is `0..=10_000` bps (0% to 100%), enforced immutably by `__constructor`.
//! - **Arithmetic & Rounding Direction**:
//!   `fee = amount * fee_bps / 10_000`
//!   `net = amount - fee`
//!   Integer division strictly **truncates toward zero** (floor division). Fractional dust remainders
//!   (`(amount * fee_bps) % 10_000`) are discarded from the platform fee and retained by the merchant,
//!   benefiting the merchant by up to 1 stroop ($10^{-7}$ token units) and ensuring SlipPay never overcharges.
//! - **Conservation Identity**: `net + fee == amount` holds invariant across all valid amounts.
//! - **Off-Chain Ledger Mapping**: On-chain stroops map directly to the off-chain invoice column
//!   `orders.fee_usdc` (`numeric(20,7)`) via `fee_usdc = fee_stroops / 10^7`.
//! - **Zero-Net & Zero-Fee Transfer Handling**:
//!   - If `fee == 0` (0 bps rate or sub-basis-point micro-payment), the platform fee transfer leg is skipped.
//!   - If `net == 0` (10,000 bps maximum fee), the merchant transfer leg is skipped.
//!   Skipping zero-value transfers eliminates configuration-dependent atomic reverts on SEP-41 tokens
//!   that reject zero-amount transfers.
//! - **Atomicity & Revert Safety**: Both legs settle atomically within the invocation transaction.
//!   If any SEP-41 token transfer fails or reverts (e.g. insufficient payer balance, frozen asset, or invalid auth),
//!   the entire transaction rolls back atomically, guaranteeing neither party is credited partially.
//! - **Canonical Specification**: For the platform-wide fee specification, see [`docs/fees.md`](../../docs/fees.md).
//!
//! pay(from, merchant, token, amount):
//!   fee = amount * fee_bps / 10_000
//!   transfer(from -> merchant, amount - fee)
//!   transfer(from -> fee_to,   fee)
//!
//! `from.require_auth()` — the payer authorizes the whole charge once; the two
//! nested SEP-41 transfers settle atomically (Soroban reverts on any failure).

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, token, Address, Env, Symbol};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    BadConfig = 1,
    BadAmount = 2,
}

#[contracttype]
enum DataKey {
    FeeTo,
    FeeBps,
}

#[contract]
pub struct Checkout;

#[contractimpl]
impl Checkout {
    /// Set the SlipPay fee recipient + basis points once, at deploy. Immutable.
    pub fn __constructor(env: Env, fee_to: Address, fee_bps: u32) {
        if fee_bps > 10_000 {
            panic_with(&env, Error::BadConfig);
        }
        env.storage().instance().set(&DataKey::FeeTo, &fee_to);
        env.storage().instance().set(&DataKey::FeeBps, &fee_bps);
    }

    /// One charge → two atomic transfers: net to merchant, fee to SlipPay.
    pub fn pay(env: Env, from: Address, merchant: Address, token: Address, amount: i128) -> i128 {
        from.require_auth();
        if amount <= 0 {
            panic_with(&env, Error::BadAmount);
        }

        let fee_to: Address = env.storage().instance().get(&DataKey::FeeTo)
            .unwrap_or_else(|| panic_with(&env, Error::BadConfig));
        let fee_bps: u32 = env.storage().instance().get(&DataKey::FeeBps)
            .unwrap_or_else(|| panic_with(&env, Error::BadConfig));

        let fee: i128 = amount * (fee_bps as i128) / 10_000;
        let net: i128 = amount - fee;

        let client = token::Client::new(&env, &token);
        client.transfer(&from, &merchant, &net);
        if fee > 0 {
            client.transfer(&from, &fee_to, &fee);
        }

        env.events().publish(
            (Symbol::new(&env, "checkout_paid"), from),
            (merchant, amount, net, fee),
        );
        fee
    }

    pub fn fee_bps(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0)
    }
    pub fn fee_to(env: Env) -> Address {
        env.storage().instance().get(&DataKey::FeeTo).unwrap()
    }
}

fn panic_with(env: &Env, e: Error) -> ! {
    soroban_sdk::panic_with_error!(env, e)
}
