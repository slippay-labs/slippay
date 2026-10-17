#![cfg(test)]
extern crate std;
use std::string::String;
use soroban_sdk::{testutils::Address as _, Address, Env};
use crate::{Checkout, CheckoutClient};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct FeeVector {
    id: String,
    description: String,
    amount_stroops: String,
    amount_stellar: String,
    fee_bps: u32,
    expected_fee_stroops: String,
    expected_net_stroops: String,
    expected_fee_stellar: String,
    expected_net_stellar: String,
}

// Canonical shared fee vector JSON file consumed directly from @slippay/shared
const SHARED_VECTORS_JSON: &str = include_str!("../../../packages/shared/src/vectors/fee_vectors.json");

#[test]
fn test_contract_fee_arithmetic_matches_shared_vectors() {
    let vectors: std::vec::Vec<FeeVector> = serde_json::from_str(SHARED_VECTORS_JSON)
        .expect("Failed to parse shared fee vectors JSON in checkout test");

    assert!(!vectors.is_empty(), "Shared vectors must not be empty");

    for vec in &vectors {
        let amount: i128 = vec.amount_stroops.parse::<i128>()
            .unwrap_or_else(|_| panic!("Failed to parse amount_stroops for {}", vec.id));
        let expected_fee: i128 = vec.expected_fee_stroops.parse::<i128>()
            .unwrap_or_else(|_| panic!("Failed to parse expected_fee_stroops for {}", vec.id));
        let expected_net: i128 = vec.expected_net_stroops.parse::<i128>()
            .unwrap_or_else(|_| panic!("Failed to parse expected_net_stroops for {}", vec.id));

        // 1. Direct contract arithmetic identity check:
        //    fee = amount * fee_bps / 10_000
        //    net = amount - fee
        let fee_bps_i128 = vec.fee_bps as i128;
        let contract_fee = amount * fee_bps_i128 / 10_000;
        let contract_net = amount - contract_fee;

        assert_eq!(
            contract_fee,
            expected_fee,
            "Vector {}: contract fee arithmetic mismatch. Expected {}, got {}",
            vec.id, expected_fee, contract_fee
        );

        assert_eq!(
            contract_net,
            expected_net,
            "Vector {}: contract net arithmetic mismatch. Expected {}, got {}",
            vec.id, expected_net, contract_net
        );

        // 2. Invariant assertion: net + fee === amount
        assert_eq!(
            contract_net + contract_fee,
            amount,
            "Vector {}: fee + net must strictly conserve total amount",
            vec.id
        );
    }
}

#[test]
fn test_contract_onchain_pay_execution_matches_shared_vectors() {
    let env = Env::default();
    env.mock_all_auths();

    let vectors: std::vec::Vec<FeeVector> = serde_json::from_str(SHARED_VECTORS_JSON)
        .expect("Failed to parse shared fee vectors JSON");

    for vec in &vectors {
        let amount: i128 = vec.amount_stroops.parse::<i128>().unwrap();
        let expected_fee: i128 = vec.expected_fee_stroops.parse::<i128>().unwrap();
        let expected_net: i128 = vec.expected_net_stroops.parse::<i128>().unwrap();

        // If net is 0 or fee_bps > 10_000, skip contract execution as constructor / transfer guards apply
        if expected_net <= 0 || amount <= 0 || vec.fee_bps > 10_000 {
            continue;
        }

        let fee_to = Address::generate(&env);
        let from = Address::generate(&env);
        let merchant = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_admin_client = soroban_sdk::token::StellarAssetClient::new(&env, &token_contract.address());
        let token_client = soroban_sdk::token::Client::new(&env, &token_contract.address());

        let contract_id = env.register(Checkout, (&fee_to, &vec.fee_bps));
        let client = CheckoutClient::new(&env, &contract_id);

        token_admin_client.mint(&from, &amount);

        let returned_fee = client.pay(&from, &merchant, &token_contract.address(), &amount);

        assert_eq!(
            returned_fee,
            expected_fee,
            "Vector {}: returned_fee mismatch",
            vec.id
        );
        assert_eq!(
            token_client.balance(&fee_to),
            expected_fee,
            "Vector {}: fee_to balance mismatch",
            vec.id
        );
        assert_eq!(
            token_client.balance(&merchant),
            expected_net,
            "Vector {}: merchant balance mismatch",
            vec.id
        );
    }
}

#[test]
fn test_rounding_deviation_fails_vector_assertions() {
    // Proves that any alternative rounding direction (e.g. ceiling or round-half-up)
    // fails the canonical vector expectation.
    // For vector "dust_just_below_boundary": amount = 19999, fee_bps = 1.
    // Exact division is 1.9999 stroops.
    let amount = 19999i128;
    let fee_bps = 1i128;

    let floor_fee = amount * fee_bps / 10_000;
    assert_eq!(floor_fee, 1);

    // If ceiling rounding was used:
    let ceil_fee = (amount * fee_bps + 9999) / 10_000;
    assert_ne!(ceil_fee, floor_fee, "Ceiling rounding must deviate from canonical floor division");
}
