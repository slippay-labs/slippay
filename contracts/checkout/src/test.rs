#![cfg(test)]
use super::*;
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Env,
};

#[test]
#[should_panic]
fn test_constructor_rejects_fee_to_as_contract_address() {
    let env = Env::default();
    let contract_addr = Address::generate(&env);

    // Register contract at explicit address, but pass that exact address as fee_to.
    // fee_to == env.current_contract_address() must panic with BadConfig to prevent fund trapping.
    env.register_at(&contract_addr, Checkout, (contract_addr.clone(), 297u32));
}

#[test]
fn test_pay_rejects_merchant_equal_to_fee_recipient() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let fee_to = Address::generate(&env);
    let contract_id = env.register(Checkout, (fee_to.clone(), 297u32));
    let client = CheckoutClient::new(&env, &contract_id);

    let token_admin = Address::generate(&env);
    let issuer = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_addr = issuer.address();
    let sac_admin = StellarAssetClient::new(&env, &token_addr);

    let payer = Address::generate(&env);
    sac_admin.mint(&payer, &1_000_000);

    // Attempting to pay where merchant == fee_to must fail-closed with BadConfig
    let result = client.try_pay(&payer, &fee_to, &token_addr, &1_000_000);
    assert_eq!(
        result.err().unwrap().unwrap(),
        soroban_sdk::Error::from(Error::BadConfig)
    );
}

#[test]
fn test_normal_distinct_recipients_succeed() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let fee_to = Address::generate(&env);
    let contract_id = env.register(Checkout, (fee_to.clone(), 297u32));
    let client = CheckoutClient::new(&env, &contract_id);

    let token_admin = Address::generate(&env);
    let issuer = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_addr = issuer.address();
    let sac_admin = StellarAssetClient::new(&env, &token_addr);
    let sac_token = TokenClient::new(&env, &token_addr);

    let payer = Address::generate(&env);
    let merchant = Address::generate(&env);

    sac_admin.mint(&payer, &10_000_000);

    let fee = client.pay(&payer, &merchant, &token_addr, &10_000_000);
    assert_eq!(fee, 297_000);
    assert_eq!(sac_token.balance(&merchant), 9_703_000);
    assert_eq!(sac_token.balance(&fee_to), 297_000);
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
}
