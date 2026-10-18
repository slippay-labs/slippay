#![cfg(test)]
use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env, IntoVal, Symbol,
};

struct Fixture<'a> {
    #[allow(dead_code)]
    env: Env,
    contract: CheckoutClient<'a>,
    #[allow(dead_code)]
    contract_id: Address,
    from: Address,
    merchant: Address,
    fee_to: Address,
    token: Address,
    #[allow(dead_code)]
    token_admin: Address,
    #[allow(dead_code)]
    sac_admin: StellarAssetClient<'a>,
    sac_user: TokenClient<'a>,
}

fn setup_with_fee<'a>(fee_bps: u32) -> Fixture<'a> {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let from = Address::generate(&env);
    let merchant = Address::generate(&env);
    let fee_to = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let issuer = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_addr = issuer.address();
    let sac_admin = StellarAssetClient::new(&env, &token_addr);
    let sac_user = TokenClient::new(&env, &token_addr);

    // Mint 100 USDC (100_000_000 stroops at 7 decimals) to payer.
    sac_admin.mint(&from, &100_000_000_i128);

    let contract_id = env.register(Checkout, (fee_to.clone(), fee_bps));
    let contract = CheckoutClient::new(&env, &contract_id);

    Fixture {
        env,
        contract,
        contract_id,
        from,
        merchant,
        fee_to,
        token: token_addr,
        token_admin,
        sac_admin,
        sac_user,
    }
}

#[test]
fn max_fee_bps_constant_matches_offchain_bound() {
    // MAX_FEE_BPS is 1000 bp (10.00%), strictly aligning with database
    // orders.platform_fee_bp check constraint: check (platform_fee_bp between 0 and 1000).
    assert_eq!(MAX_FEE_BPS, 1_000);
}

#[test]
fn constructor_at_max_fee_boundary_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    let fee_to = Address::generate(&env);

    let contract_id = env.register(Checkout, (fee_to.clone(), MAX_FEE_BPS));
    let expected_events = vec![
        &env,
        (
            contract_id.clone(),
            (Symbol::new(&env, "checkout_init"), fee_to.clone()).into_val(&env),
            MAX_FEE_BPS.into_val(&env),
        ),
    ];
    assert_eq!(env.events().all(), expected_events);

    let client = CheckoutClient::new(&env, &contract_id);
    assert_eq!(client.fee_bps(), 1_000);
    assert_eq!(client.fee_to(), fee_to);
}

#[test]
#[should_panic]
fn constructor_rejects_fee_exceeding_max_boundary() {
    let env = Env::default();
    env.mock_all_auths();
    let fee_to = Address::generate(&env);

    // 1001 bp exceeds MAX_FEE_BPS (1000 bp); must panic closed with BadConfig.
    let _ = env.register(Checkout, (fee_to, MAX_FEE_BPS + 1));
}

#[test]
#[should_panic]
fn constructor_rejects_legacy_100_percent_fee() {
    let env = Env::default();
    env.mock_all_auths();
    let fee_to = Address::generate(&env);

    // 10,000 bp (100%) was previously accepted; must now be rejected.
    let _ = env.register(Checkout, (fee_to, 10_000u32));
}

#[test]
fn constructor_allows_zero_fee_deliberately() {
    let env = Env::default();
    env.mock_all_auths();
    let fee_to = Address::generate(&env);

    let contract_id = env.register(Checkout, (fee_to.clone(), 0u32));
    let expected_events = vec![
        &env,
        (
            contract_id.clone(),
            (Symbol::new(&env, "checkout_init"), fee_to.clone()).into_val(&env),
            0u32.into_val(&env),
        ),
    ];
    assert_eq!(env.events().all(), expected_events);

    let client = CheckoutClient::new(&env, &contract_id);
    assert_eq!(client.fee_bps(), 0);
    assert_eq!(client.fee_to(), fee_to);
}

#[test]
fn constructor_emits_event_for_parameter_recovery() {
    let env = Env::default();
    env.mock_all_auths();
    let fee_to = Address::generate(&env);
    let fee_bps = 297u32; // canonical default 2.97%

    let contract_id = env.register(Checkout, (fee_to.clone(), fee_bps));
    let expected_events = vec![
        &env,
        (
            contract_id.clone(),
            (Symbol::new(&env, "checkout_init"), fee_to.clone()).into_val(&env),
            fee_bps.into_val(&env),
        ),
    ];
    assert_eq!(env.events().all(), expected_events);

    let client = CheckoutClient::new(&env, &contract_id);
    assert_eq!(client.fee_bps(), 297);
    assert_eq!(client.fee_to(), fee_to);
}

#[test]
fn pay_splits_correctly_at_max_fee() {
    // Setup contract with 10% fee (MAX_FEE_BPS = 1000)
    let f = setup_with_fee(MAX_FEE_BPS);
    let amount = 10_000_000_i128; // 1.0 USDC

    let fee = f.contract.pay(&f.from, &f.merchant, &f.token, &amount);
    let expected_fee = amount * 1000 / 10_000; // 1_000_000 (0.1 USDC)
    let expected_net = amount - expected_fee; // 9_000_000 (0.9 USDC)

    assert_eq!(fee, expected_fee);
    assert_eq!(f.sac_user.balance(&f.merchant), expected_net);
    assert_eq!(f.sac_user.balance(&f.fee_to), expected_fee);
    assert_eq!(f.sac_user.balance(&f.from), 100_000_000_i128 - amount);
}

#[test]
fn pay_with_zero_fee_routes_entire_amount_to_merchant() {
    // Setup contract with 0% fee
    let f = setup_with_fee(0);
    let amount = 10_000_000_i128; // 1.0 USDC

    let fee = f.contract.pay(&f.from, &f.merchant, &f.token, &amount);

    assert_eq!(fee, 0);
    assert_eq!(f.sac_user.balance(&f.merchant), amount);
    assert_eq!(f.sac_user.balance(&f.fee_to), 0);
    assert_eq!(f.sac_user.balance(&f.from), 100_000_000_i128 - amount);
}

#[test]
fn pay_with_canonical_default_fee() {
    // Setup contract with 297 bp (canonical default 2.97%)
    let f = setup_with_fee(297);
    let amount = 10_000_000_i128;

    let fee = f.contract.pay(&f.from, &f.merchant, &f.token, &amount);
    let expected_fee = amount * 297 / 10_000; // 297_000
    let expected_net = amount - expected_fee; // 9_703_000

    assert_eq!(fee, expected_fee);
    assert_eq!(f.sac_user.balance(&f.merchant), expected_net);
    assert_eq!(f.sac_user.balance(&f.fee_to), expected_fee);
}
