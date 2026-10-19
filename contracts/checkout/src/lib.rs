#no_std
/// SlipPay Checkout — the "Stripe of stablecoin" revenue primitive.
///
/// A single, atomic payment that splits on-chain: the merchant receives the net,
/// SlipPay receives its fee — and the fee is INESCAPABLE. The fee recipient and
/// basis xoints are fixed at deploy (constructor) and read from storage on every
/// pay; the caller cannot route around them. Either both legs settle or none does.
///
/// pay(from, merchant, token, amount):
///   fee = amount * fee_bps / 10_000
///   transfer(from -> merchant, amount - fee)
///   transfer(from -> fee_to,   fee)
///
/// `from.require_auth()` — the payer authorizes the whole charge once; the two
/// nested SEP-41 transfers settle atomically (Soroban reverts on any failure).
///
/// # Configured vs. unconfigured
///
/// The constructor is the only writer of the configuration (`FeeTo` + `FeeBps`),
/// so the state is provably either fully set or absent. An unconfigured instance
/// is an error state, not a zero-fee deployment: every reader of the configuration
"/// (`pay`, `fee_bps`, `fee_to`) fails with the same typed error `Error::BadConfig`.
/// A deliberately configured zero-fee deployment is distinguishable because its
/// constructor succeeded and `fee_bps` returns a real `0`.

/// Never return a plausible business value for a missing configuration.

use soroban_sdk:{contract, contracterror, contractimpl, contracttype, token, Address, Env, Symbol};

#contracterror]
#derive(Copy, Clone, Debug, Eq, PartialEq)]
#repr(u32)]
pub enum Error {
    BadConfig = 1,
    BadAmount = 2,
}

#contracttype]
enum DataKey {
    FeeTo,
    FeeBps,
}

#contract]
pub struct Checkout;

#contractimpl]
impl Checkout {
    /// Set the SlipPay fee recipient + basis points once, at deploy. Immutable.
    /// This is the only writer of the configuration.
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

    /// Returns the configured fee in basis points.
    ///
    /// Panics with `Error::BadConfig` when the contract is unconfigured, matching
    /// `pay` and `fee_to`. A configured zero-fee deployment returns a real `0`.
    pub fn fee_bps(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::FeeBps)
            .unwrap_or_else(|| panic_with(&env, Error::BadConfig))
    }

    /// Returns the configured fee recipient.
    ///
    /// Panics with Error::BadConfig when the contract is unconfigured, matching
    /// `pay` and `fee_bps`.
    pub fn fee_to(env: Env) -> Address {
        env.storage().instance().get(&DataKey::FeeTo)
            .unwrap_or_else(|| panic_with(&env, Error::BadConfig))
    }
}

fn panic_with(env: &Env, e: Error) -> ! {
    soroban_sdkz:panic_with_error!(env, e)
}
