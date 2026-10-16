//! Comprehensive unit and security integration test suite for slippay-checkout contract.
//!
//! Covers:
//! - Deploy-time bounds & self-address trapping guards (Issues #302, #310)
//! - Constructor initialization events & view functions (Issues #302, #304, #305)
//! - Checked arithmetic and overflow resistance (Issue #303)
//! - Symmetric transfer guards and zero-net handling (Issue #306)
//! - Strict single-authorization semantics and atomic double-transfer (Issue #301)
//! - Rounding direction and exact conservation (Issue #301)
//! - Mock token revert atomicity (Issue #301)

#![cfg(test)]
use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env, IntoVal, Symbol,
};

#[allow(dead_code)]
struct Fixture<'a> {
    env: Env,
    contract_id: Address,
    client: CheckoutClient<'a>,
    from: Address,
    merchant: Address,
    fee_to: Address,
    token: Address,
    token_admin: Address,
    sac_admin: StellarAssetClient<'a>,
    sac_user: TokenClient<'a>,
}

fn setup_fixture<'a>(fee_bps: u32) -> Fixture<'a> {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let from = Address::generate(&env);
    let merchant = Address::generate(&env);
    let fee_to = Address::generate(&env);
    let token_admin = Address::generate(&env);

    // Register SAC token and mint 1,000,000 units with 7 decimals
    let issuer = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_addr = issuer.address();
    let sac_admin = StellarAssetClient::new(&env, &token_addr);
    let sac_user = TokenClient::new(&env, &token_addr);

    sac_admin.mint(&from, &10_000_000_000_000_i128);

    let contract_id = env.register(Checkout, (fee_to.clone(), fee_bps));
    let client = CheckoutClient::new(&env, &contract_id);

    Fixture {
        env,
        contract_id,
        client,
        from,
        merchant,
        fee_to,
        token: token_addr,
        token_admin,
        sac_admin,
        sac_user,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Constructor Bounds & Immutable Configuration (Issues #302, #310)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_constructor_accepts_valid_bounds() {
    let env = Env::default();
    let fee_to = Address::generate(&env);

    // Boundary 1: fee_bps = 0 (valid zero-fee gateway)
    let c0 = env.register(Checkout, (fee_to.clone(), 0_u32));
    let client0 = CheckoutClient::new(&env, &c0);
    assert_eq!(client0.fee_bps(), 0);
    assert_eq!(client0.fee_to(), fee_to);

    // Boundary 2: fee_bps = MAX_FEE_BPS (1000 bp = 10%)
    let c1000 = env.register(Checkout, (fee_to.clone(), MAX_FEE_BPS));
    let client1000 = CheckoutClient::new(&env, &c1000);
    assert_eq!(client1000.fee_bps(), MAX_FEE_BPS);
    assert_eq!(client1000.fee_to(), fee_to);

    // Default commercial rate: 297 bps (2.97%)
    let c297 = env.register(Checkout, (fee_to.clone(), 297_u32));
    let client297 = CheckoutClient::new(&env, &c297);
    assert_eq!(client297.fee_bps(), 297);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn test_constructor_rejects_fee_above_max_boundary() {
    let env = Env::default();
    let fee_to = Address::generate(&env);
    // 1 unit above maximum: 1001 bp must fail-closed with BadConfig (1)
    env.register(Checkout, (fee_to, MAX_FEE_BPS + 1));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn test_constructor_rejects_fee_at_old_excessive_limit() {
    let env = Env::default();
    let fee_to = Address::generate(&env);
    // 10,000 bp (100%) must be rejected
    env.register(Checkout, (fee_to, 10_000_u32));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn test_constructor_rejects_fee_to_self() {
    let env = Env::default();
    let contract_id = Address::generate(&env);
    // Setting fee_to to contract's own address locks funds irreversibly
    env.register_at(&contract_id, Checkout, (contract_id.clone(), 297_u32));
}

#[test]
fn test_constructor_emits_checkout_init_event() {
    let env = Env::default();
    let fee_to = Address::generate(&env);
    let contract_id = env.register(Checkout, (fee_to.clone(), 297_u32));

    let expected = vec![
        &env,
        (
            contract_id.clone(),
            (Symbol::new(&env, "checkout_init"), fee_to.clone()).into_val(&env),
            297_u32.into_val(&env),
        ),
    ];
    assert_eq!(env.events().all(), expected);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. View Functions Fail-Closed Behaviour (Issues #304, #305)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_unconfigured_contract_views_fail_closed_with_bad_config() {
    let f = setup_fixture(297);

    // Simulate an unconfigured or storage-cleared state
    f.env.as_contract(&f.contract_id, || {
        f.env.storage().instance().remove(&DataKey::FeeBps);
        f.env.storage().instance().remove(&DataKey::FeeTo);
    });

    // fee_bps must NOT return 0 silently
    let res_bps = f.client.try_fee_bps();
    assert!(res_bps.is_err());
    assert_eq!(res_bps.err().unwrap().unwrap(), Error::BadConfig.into());

    // fee_to must NOT untyped panic
    let res_to = f.client.try_fee_to();
    assert!(res_to.is_err());
    assert_eq!(res_to.err().unwrap().unwrap(), Error::BadConfig.into());

    // pay must also fail-closed on missing config
    let res_pay = f.client.try_pay(&f.from, &f.merchant, &f.token, &1_000_000);
    assert!(res_pay.is_err());
    assert_eq!(res_pay.err().unwrap().unwrap(), Error::BadConfig.into());
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Payment Split, Rounding Direction & Conservation (Issues #301, #306)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_pay_splits_cleanly_and_conserves_funds() {
    let f = setup_fixture(297); // 2.97% platform fee

    let amount = 1_000_000_000_i128; // 100 USDC (7 decimals)
    let expected_fee = 29_700_000_i128; // 1_000_000_000 * 297 / 10_000
    let expected_net = 970_300_000_i128;

    let initial_from = f.sac_user.balance(&f.from);
    let fee_returned = f.client.pay(&f.from, &f.merchant, &f.token, &amount);

    assert_eq!(fee_returned, expected_fee);
    assert_eq!(f.sac_user.balance(&f.from), initial_from - amount);
    assert_eq!(f.sac_user.balance(&f.merchant), expected_net);
    assert_eq!(f.sac_user.balance(&f.fee_to), expected_fee);
    assert_eq!(expected_net + expected_fee, amount, "Conservation must hold strictly");
}

#[test]
fn test_pay_rounding_direction_truncates_down() {
    let f = setup_fixture(297);

    // 100 stroops: 100 * 297 / 10_000 = 29_700 / 10_000 = 2 stroops fee, 98 stroops net
    let amount = 100_i128;
    let expected_fee = 2_i128;
    let expected_net = 98_i128;

    let fee = f.client.pay(&f.from, &f.merchant, &f.token, &amount);
    assert_eq!(fee, expected_fee);
    assert_eq!(f.sac_user.balance(&f.merchant), expected_net);
    assert_eq!(f.sac_user.balance(&f.fee_to), expected_fee);
    assert_eq!(expected_net + expected_fee, amount);
}

#[test]
fn test_pay_zero_fee_leg_skipped_when_zero_rate() {
    let f = setup_fixture(0); // 0% fee

    let amount = 500_000_000_i128;
    let fee = f.client.pay(&f.from, &f.merchant, &f.token, &amount);

    assert_eq!(fee, 0);
    assert_eq!(f.sac_user.balance(&f.merchant), amount);
    assert_eq!(f.sac_user.balance(&f.fee_to), 0);
}

#[test]
fn test_pay_emits_checkout_paid_event() {
    let f = setup_fixture(297);

    let amount = 1_000_000_i128;
    let fee = 29_700_i128;
    let net = 970_300_i128;

    f.client.pay(&f.from, &f.merchant, &f.token, &amount);

    let contract_events = f.env.events().all().filter_by_contract(&f.contract_id);
    let expected = vec![
        &f.env,
        (
            f.contract_id.clone(),
            (Symbol::new(&f.env, "checkout_paid"), f.from.clone()).into_val(&f.env),
            (f.merchant.clone(), amount, net, fee).into_val(&f.env),
        ),
    ];
    assert_eq!(contract_events, expected);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3.5. Off-chain Shared Vector Table Agreement (Issue #307)
// ─────────────────────────────────────────────────────────────────────────────

struct FeeVector {
    amount: i128,
    fee_bps: u32,
    expected_fee: i128,
    expected_net: i128,
}

#[test]
fn test_checkout_fee_matches_off_chain_vector_table() {
    let vectors = [
        // Boundary: 1 stroop, fee truncates to 0
        FeeVector { amount: 1, fee_bps: 297, expected_fee: 0, expected_net: 1 },
        // Exact threshold where fee reaches 1 stroop: 34 * 297 / 10000 = 10098 / 10000 = 1
        FeeVector { amount: 33, fee_bps: 297, expected_fee: 0, expected_net: 33 },
        FeeVector { amount: 34, fee_bps: 297, expected_fee: 1, expected_net: 33 },
        // 100 stroops
        FeeVector { amount: 100, fee_bps: 297, expected_fee: 2, expected_net: 98 },
        // 10,000 stroops (0.001 USDC)
        FeeVector { amount: 10_000, fee_bps: 297, expected_fee: 297, expected_net: 9_703 },
        // 1 USDC (10,000,000 stroops)
        FeeVector { amount: 10_000_000, fee_bps: 297, expected_fee: 297_000, expected_net: 9_703_000 },
        // 100 USDC (1,000,000,000 stroops)
        FeeVector { amount: 1_000_000_000, fee_bps: 297, expected_fee: 29_700_000, expected_net: 970_300_000 },
        // Boundary: Maximum permissible rate (1,000 bps = 10.00%)
        FeeVector { amount: 10_000_000, fee_bps: 1_000, expected_fee: 1_000_000, expected_net: 9_000_000 },
        // Boundary: Zero fee rate (0 bps)
        FeeVector { amount: 10_000_000, fee_bps: 0, expected_fee: 0, expected_net: 10_000_000 },
    ];

    for v in vectors {
        let f = setup_fixture(v.fee_bps);
        let actual_fee = f.client.pay(&f.from, &f.merchant, &f.token, &v.amount);
        assert_eq!(actual_fee, v.expected_fee, "Fee mismatch for amount {} at rate {}", v.amount, v.fee_bps);
        assert_eq!(f.sac_user.balance(&f.merchant), v.expected_net);
        assert_eq!(f.sac_user.balance(&f.fee_to), v.expected_fee);
        assert_eq!(v.expected_net + v.expected_fee, v.amount);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Input Validation & Fail-Closed Guards (Issues #301, #303, #310)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_pay_rejects_zero_and_negative_amounts() {
    let f = setup_fixture(297);

    let res_zero = f.client.try_pay(&f.from, &f.merchant, &f.token, &0);
    assert!(res_zero.is_err());
    assert_eq!(res_zero.err().unwrap().unwrap(), Error::BadAmount.into());

    let res_neg = f.client.try_pay(&f.from, &f.merchant, &f.token, &-500);
    assert!(res_neg.is_err());
    assert_eq!(res_neg.err().unwrap().unwrap(), Error::BadAmount.into());
}

#[test]
fn test_pay_rejects_overflowing_amounts_safely() {
    let f = setup_fixture(500); // 5%

    // i128::MAX would overflow `amount * fee_bps` without checked_mul
    let res_overflow = f.client.try_pay(&f.from, &f.merchant, &f.token, &i128::MAX);
    assert!(res_overflow.is_err());
    assert_eq!(res_overflow.err().unwrap().unwrap(), Error::Overflow.into());
}

#[test]
fn test_pay_rejects_merchant_equal_to_fee_recipient() {
    let f = setup_fixture(297);

    // If merchant == fee_to, payment must fail-closed rather than silently collapsing
    let res = f.client.try_pay(&f.from, &f.fee_to, &f.token, &1_000_000);
    assert!(res.is_err());
    assert_eq!(res.err().unwrap().unwrap(), Error::BadConfig.into());
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Authorization & Atomic Revert Guarantees (Issue #301)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_pay_requires_payer_authorization() {
    let f = setup_fixture(297);
    // Clear all mocked auths: no authorization provided for from
    f.env.set_auths(&[]);

    let res = f.client.try_pay(&f.from, &f.merchant, &f.token, &100_000_000);
    assert!(res.is_err(), "Must revert when from has not authorized the charge");
}

#[test]
fn test_pay_atomic_revert_when_payer_lacks_balance() {
    let f = setup_fixture(297);
    let broke_user = Address::generate(&f.env); // has 0 tokens

    let initial_merchant = f.sac_user.balance(&f.merchant);
    let initial_fee_to = f.sac_user.balance(&f.fee_to);

    let res = f.client.try_pay(&broke_user, &f.merchant, &f.token, &500_000);
    assert!(res.is_err(), "Must revert on insufficient balance");

    // Both legs must atomically remain uncredited
    assert_eq!(f.sac_user.balance(&f.merchant), initial_merchant);
    assert_eq!(f.sac_user.balance(&f.fee_to), initial_fee_to);
}
