#![no_std]
//! SlipPay Checkout — the "Stripe of stablecoin" revenue primitive.
//!
//! A single, atomic payment that splits on-chain: the merchant receives the net,
//! SlipPay receives its fee — and the fee is INESCAPABLE. The fee recipient and
//! basis points are fixed at deploy (constructor) and read from storage on every
//! pay; the caller cannot route around them. Either both legs settle or none does.
//!
//! pay(from, merchant, token, amount):
//!   fee = amount * fee_bps / 10_000
//!   transfer(from -> merchant, amount - fee)
//!   transfer(from -> fee_to,   fee)
//!
//! `from.require_auth()` — the payer authorizes the whole charge once; the two
//! nested SEP-41 transfers settle atomically (Soroban reverts on any failure).

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, token, Address, Env, Symbol};

/// Maximum permissible platform fee in basis points (1000 bp = 10.00%).
/// Aligns with the database orders platform_fee_bp constraint.
pub const MAX_FEE_BPS: u32 = 1_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    BadConfig = 1,
    BadAmount = 2,
    Overflow = 3,
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
    /// Rejects fees above MAX_FEE_BPS (1000 bp = 10.00%) or fee_to being the contract's own address.
    pub fn __constructor(env: Env, fee_to: Address, fee_bps: u32) {
        if fee_bps > MAX_FEE_BPS {
            panic_with(&env, Error::BadConfig);
        }
        if fee_to == env.current_contract_address() {
            panic_with(&env, Error::BadConfig);
        }
        env.storage().instance().set(&DataKey::FeeTo, &fee_to);
        env.storage().instance().set(&DataKey::FeeBps, &fee_bps);

        env.events().publish(
            (Symbol::new(&env, "checkout_init"), fee_to),
            fee_bps,
        );
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

        if fee_to == merchant {
            panic_with(&env, Error::BadConfig);
        }

        // Checked arithmetic prevents overflow vulnerabilities on large payments.
        let fee: i128 = amount
            .checked_mul(fee_bps as i128)
            .and_then(|v| v.checked_div(10_000))
            .unwrap_or_else(|| panic_with(&env, Error::Overflow));
        let net: i128 = amount
            .checked_sub(fee)
            .unwrap_or_else(|| panic_with(&env, Error::Overflow));

        if net <= 0 || fee < 0 {
            panic_with(&env, Error::BadAmount);
        }

        let client = token::Client::new(&env, &token);
        // Transfer net settlement to merchant (strictly positive, non-zero).
        client.transfer(&from, &merchant, &net);
        // Transfer platform fee to SlipPay fee receiver if non-zero.
        // Zero fee occurs when fee_bps == 0 or integer truncation yields 0 stroops.
        if fee > 0 {
            client.transfer(&from, &fee_to, &fee);
        }

        env.events().publish(
            (Symbol::new(&env, "checkout_paid"), from),
            (merchant, amount, net, fee),
        );
        fee
    }

    /// Returns configured fee basis points, or reverts with BadConfig if unconfigured.
    pub fn fee_bps(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::FeeBps)
            .unwrap_or_else(|| panic_with(&env, Error::BadConfig))
    }

    /// Returns configured fee recipient address, or reverts with BadConfig if unconfigured.
    pub fn fee_to(env: Env) -> Address {
        env.storage().instance().get(&DataKey::FeeTo)
            .unwrap_or_else(|| panic_with(&env, Error::BadConfig))
    }
}

fn panic_with(env: &Env, e: Error) -> ! {
    soroban_sdk::panic_with_error!(env, e)
}

#[cfg(test)]
mod test;
