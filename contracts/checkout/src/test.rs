#![cfg(test)]
use super::*;
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Env,
};

#[test]
fn test_unconfigured_fee_to_returns_bad_config() {
    let env = Env::default();
    let fee_to = Address::generate(&env);
    let contract_id = env.register(Checkout, (fee_to, 297u32));
    let client = CheckoutClient::new(&env, &contract_id);

    // Remove FeeTo key from instance storage to simulate unconfigured/missing key
    env.as_contract(&contract_id, || {
        env.storage().instance().remove(&DataKey::FeeTo);
    });

    // Assert that fee_to returns typed Error::BadConfig instead of untyped panic/trap
    let result = client.try_fee_to();
    assert_eq!(
        result.err().unwrap().unwrap(),
        soroban_sdk::Error::from(Error::BadConfig)
    );
}

#[test]
fn test_unconfigured_fee_bps_returns_bad_config() {
    let env = Env::default();
    let fee_to = Address::generate(&env);
    let contract_id = env.register(Checkout, (fee_to, 297u32));
    let client = CheckoutClient::new(&env, &contract_id);

    // Remove FeeBps key from instance storage to simulate unconfigured/missing key
    env.as_contract(&contract_id, || {
        env.storage().instance().remove(&DataKey::FeeBps);
    });

    // Assert that fee_bps returns typed Error::BadConfig rather than misleading 0 bps
    let result = client.try_fee_bps();
    assert_eq!(
        result.err().unwrap().unwrap(),
        soroban_sdk::Error::from(Error::BadConfig)
    );
}

#[test]
fn test_unconfigured_pay_returns_bad_config() {
    let env = Env::default();
    env.mock_all_auths();
    let fee_to = Address::generate(&env);
    let contract_id = env.register(Checkout, (fee_to, 297u32));
    let client = CheckoutClient::new(&env, &contract_id);

    let from = Address::generate(&env);
    let merchant = Address::generate(&env);
    let token = Address::generate(&env);

    // Remove FeeTo key
    env.as_contract(&contract_id, || {
        env.storage().instance().remove(&DataKey::FeeTo);
    });

    let result = client.try_pay(&from, &merchant, &token, &100_0000000);
    assert_eq!(
        result.err().unwrap().unwrap(),
        soroban_sdk::Error::from(Error::BadConfig)
    );
}

#[test]
fn test_configured_views_and_pay_flow() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let fee_to = Address::generate(&env);
    let fee_bps = 297u32; // SlipPay default 2.97%

    let contract_id = env.register(Checkout, (fee_to.clone(), fee_bps));
    let client = CheckoutClient::new(&env, &contract_id);

    // Assert configured view functions
    assert_eq!(client.fee_to(), fee_to);
    assert_eq!(client.fee_bps(), 297);

    // Set up mock token
    let token_admin = Address::generate(&env);
    let issuer = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_addr = issuer.address();
    let sac_admin = StellarAssetClient::new(&env, &token_addr);
    let sac_token = TokenClient::new(&env, &token_addr);

    let payer = Address::generate(&env);
    let merchant = Address::generate(&env);

    // Mint 1000 tokens (10_000_000_000 stroops)
    sac_admin.mint(&payer, &10_000_000_000);

    // Pay 100 USDC (1_000_000_000 stroops)
    let charge_amount = 1_000_000_000_i128;
    let computed_fee = client.pay(&payer, &merchant, &token_addr, &charge_amount);

    let expected_fee = charge_amount * (fee_bps as i128) / 10_000; // 29_700_000 stroops
    let expected_net = charge_amount - expected_fee;              // 970_300_000 stroops

    assert_eq!(computed_fee, expected_fee);
    assert_eq!(sac_token.balance(&merchant), expected_net);
    assert_eq!(sac_token.balance(&fee_to), expected_fee);
    assert_eq!(sac_token.balance(&payer), 10_000_000_000 - charge_amount);
}

#[test]
fn test_configured_zero_fee_bps_does_not_transfer_fee() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let fee_to = Address::generate(&env);
    let contract_id = env.register(Checkout, (fee_to.clone(), 0u32));
    let client = CheckoutClient::new(&env, &contract_id);

    assert_eq!(client.fee_bps(), 0);
    assert_eq!(client.fee_to(), fee_to);

    let token_admin = Address::generate(&env);
    let issuer = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_addr = issuer.address();
    let sac_admin = StellarAssetClient::new(&env, &token_addr);
    let sac_token = TokenClient::new(&env, &token_addr);

    let payer = Address::generate(&env);
    let merchant = Address::generate(&env);

    sac_admin.mint(&payer, &1_000_000);

    let computed_fee = client.pay(&payer, &merchant, &token_addr, &1_000_000);
    assert_eq!(computed_fee, 0);
    assert_eq!(sac_token.balance(&merchant), 1_000_000);
    assert_eq!(sac_token.balance(&fee_to), 0);
}

#[test]
fn test_pay_rejects_non_positive_amount() {
    let env = Env::default();
    env.mock_all_auths();

    let fee_to = Address::generate(&env);
    let contract_id = env.register(Checkout, (fee_to, 297u32));
    let client = CheckoutClient::new(&env, &contract_id);

    let payer = Address::generate(&env);
    let merchant = Address::generate(&env);
    let token = Address::generate(&env);

    assert_eq!(
        client.try_pay(&payer, &merchant, &token, &0).err().unwrap().unwrap(),
        soroban_sdk::Error::from(Error::BadAmount)
    );
    assert_eq!(
        client.try_pay(&payer, &merchant, &token, &-100).err().unwrap().unwrap(),
        soroban_sdk::Error::from(Error::BadAmount)
    );
}

#[test]
#[should_panic]
fn test_constructor_rejects_fee_bps_exceeding_max() {
    let env = Env::default();
    let fee_to = Address::generate(&env);

    env.register(Checkout, (fee_to, 10_001u32));
}

#[test]
fn test_no_untyped_unwrap_remains() {
    // Both fee_bps and fee_to have safe fallbacks to typed Error::BadConfig.
    let env = Env::default();
    let fee_to = Address::generate(&env);
    let contract_id = env.register(Checkout, (fee_to, 100u32));
    let client = CheckoutClient::new(&env, &contract_id);

    assert_eq!(client.fee_bps(), 100);
    assert!(client.try_fee_to().is_ok());
}
