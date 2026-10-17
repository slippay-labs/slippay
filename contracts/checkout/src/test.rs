#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Env,
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

    let issuer = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token = issuer.address();
    let sac_admin = StellarAssetClient::new(&env, &token);
    let sac_user = TokenClient::new(&env, &token);

    sac_admin.mint(&from, &1_000_000_000_i128);

    let contract_id = env.register(Checkout, (fee_to.clone(), fee_bps));
    let client = CheckoutClient::new(&env, &contract_id);

    Fixture {
        env,
        contract_id,
        client,
        from,
        merchant,
        fee_to,
        token,
        sac_admin,
        sac_user,
    }
}

#[test]
fn test_unconfigured_contract_views_fail_closed_with_bad_config() {
    let f = setup_fixture(297);

    // Simulate an unconfigured or storage-absent state
    f.env.as_contract(&f.contract_id, || {
        f.env.storage().instance().remove(&DataKey::FeeBps);
        f.env.storage().instance().remove(&DataKey::FeeTo);
    });

    // 1. fee_bps must NOT return 0 silently
    let res_bps = f.client.try_fee_bps();
    assert!(res_bps.is_err(), "fee_bps() must fail closed on unconfigured storage");
    assert_eq!(res_bps.err().unwrap().unwrap(), Error::BadConfig.into());

    // 2. fee_to must NOT bare unwrap / untyped panic
    let res_to = f.client.try_fee_to();
    assert!(res_to.is_err(), "fee_to() must fail closed on unconfigured storage");
    assert_eq!(res_to.err().unwrap().unwrap(), Error::BadConfig.into());

    // 3. pay must also fail closed with the same Error::BadConfig
    let res_pay = f.client.try_pay(&f.from, &f.merchant, &f.token, &1_000_000);
    assert!(res_pay.is_err(), "pay() must fail closed on unconfigured storage");
    assert_eq!(res_pay.err().unwrap().unwrap(), Error::BadConfig.into());
}

#[test]
fn test_configured_zero_fee_bps_returns_zero_and_distinguishes_from_unconfigured() {
    let f = setup_fixture(0); // Legitimate 0 bps (fee-free tier)

    // Legitimate 0 bps configuration returns 0 successfully, distinct from unconfigured
    assert_eq!(f.client.fee_bps(), 0);
    assert_eq!(f.client.fee_to(), f.fee_to);
}

#[test]
fn test_configured_contract_views_and_atomic_pay() {
    let f = setup_fixture(297);

    assert_eq!(f.client.fee_bps(), 297);
    assert_eq!(f.client.fee_to(), f.fee_to);

    // Pay 100 USDC: fee = 100 * 297 / 10000 = 2.97 USDC (29_700_000 stroops)
    // net = 100 - 2.97 = 97.03 USDC (970_300_000 stroops)
    let gross: i128 = 1_000_000_000;
    let fee = f.client.pay(&f.from, &f.merchant, &f.token, &gross);
    assert_eq!(fee, 29_700_000);
    assert_eq!(f.sac_user.balance(&f.merchant), 970_300_000);
    assert_eq!(f.sac_user.balance(&f.fee_to), 29_700_000);
    assert_eq!(f.sac_user.balance(&f.from), 0);
}

#[test]
#[should_panic]
fn test_constructor_rejects_fee_bps_exceeding_max() {
    let env = Env::default();
    let fee_to = Address::generate(&env);
    env.register(Checkout, (fee_to, 10_001u32));
}

#[test]
fn test_pay_rejects_non_positive_amount() {
    let f = setup_fixture(297);

    let res_zero = f.client.try_pay(&f.from, &f.merchant, &f.token, &0);
    assert!(res_zero.is_err());
    assert_eq!(res_zero.err().unwrap().unwrap(), Error::BadAmount.into());

    let res_neg = f.client.try_pay(&f.from, &f.merchant, &f.token, &-500);
    assert!(res_neg.is_err());
    assert_eq!(res_neg.err().unwrap().unwrap(), Error::BadAmount.into());
}
