#![cfg(test)]
use super::*;
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Env,
};

#[test]
fn test_configured_maximum_fee_bps_zero_net_skips_merchant_transfer() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let fee_to = Address::generate(&env);
    // 100% fee rate (10,000 bps) results in fee == amount and net == 0
    let contract_id = env.register(Checkout, (fee_to.clone(), 10_000u32));
    let client = CheckoutClient::new(&env, &contract_id);

    let token_admin = Address::generate(&env);
    let issuer = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_addr = issuer.address();
    let sac_admin = StellarAssetClient::new(&env, &token_addr);
    let sac_token = TokenClient::new(&env, &token_addr);

    let payer = Address::generate(&env);
    let merchant = Address::generate(&env);

    let charge_amount = 1_000_000_i128;
    sac_admin.mint(&payer, &charge_amount);

    // Pay with 100% fee: net is 0, so merchant transfer leg is bypassed
    let computed_fee = client.pay(&payer, &merchant, &token_addr, &charge_amount);

    assert_eq!(computed_fee, charge_amount);
    assert_eq!(sac_token.balance(&payer), 0);
    assert_eq!(sac_token.balance(&merchant), 0);
    assert_eq!(sac_token.balance(&fee_to), charge_amount);
}

#[test]
fn test_configured_zero_fee_bps_does_not_transfer_fee() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let fee_to = Address::generate(&env);
    let contract_id = env.register(Checkout, (fee_to.clone(), 0u32));
    let client = CheckoutClient::new(&env, &contract_id);

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
fn test_normal_split_transfers_both_legs() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let fee_to = Address::generate(&env);
    let fee_bps = 297u32;

    let contract_id = env.register(Checkout, (fee_to.clone(), fee_bps));
    let client = CheckoutClient::new(&env, &contract_id);

    let token_admin = Address::generate(&env);
    let issuer = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_addr = issuer.address();
    let sac_admin = StellarAssetClient::new(&env, &token_addr);
    let sac_token = TokenClient::new(&env, &token_addr);

    let payer = Address::generate(&env);
    let merchant = Address::generate(&env);

    let charge_amount = 1_000_000_000_i128;
    sac_admin.mint(&payer, &charge_amount);

    let computed_fee = client.pay(&payer, &merchant, &token_addr, &charge_amount);
    let expected_fee = charge_amount * (fee_bps as i128) / 10_000;
    let expected_net = charge_amount - expected_fee;

    assert_eq!(computed_fee, expected_fee);
    assert_eq!(sac_token.balance(&merchant), expected_net);
    assert_eq!(sac_token.balance(&fee_to), expected_fee);
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
