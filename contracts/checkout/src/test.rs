#![cfg(test)]
use super::*;
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Env,
};

/// Canonical test vector structure mirroring `packages/shared/src/vectors/fee_vectors.json`.
#[derive(Copy, Clone, Debug)]
struct FeeVector {
    id: &'static str,
    amount_stroops: i128,
    fee_bps: u32,
    expected_fee_stroops: i128,
    expected_net_stroops: i128,
}

/// The 14 canonical vectors from `packages/shared/src/vectors/fee_vectors.json`.
/// Asserting these exact values guarantees multi-layer parity across contract, listener and API.
const FEE_VECTORS: &[FeeVector] = &[
    FeeVector {
        id: "bps_zero",
        amount_stroops: 10_000_000,
        fee_bps: 0,
        expected_fee_stroops: 0,
        expected_net_stroops: 10_000_000,
    },
    FeeVector {
        id: "bps_one_standard",
        amount_stroops: 10_000_000,
        fee_bps: 1,
        expected_fee_stroops: 1_000,
        expected_net_stroops: 9_999_000,
    },
    FeeVector {
        id: "one_stroop_bps_default",
        amount_stroops: 1,
        fee_bps: 297,
        expected_fee_stroops: 0,
        expected_net_stroops: 1,
    },
    FeeVector {
        id: "one_stroop_bps_cap_1000",
        amount_stroops: 1,
        fee_bps: 1000,
        expected_fee_stroops: 0,
        expected_net_stroops: 1,
    },
    FeeVector {
        id: "exact_division",
        amount_stroops: 10_000,
        fee_bps: 297,
        expected_fee_stroops: 297,
        expected_net_stroops: 9_703,
    },
    FeeVector {
        id: "dust_just_below_boundary",
        amount_stroops: 19_999,
        fee_bps: 1,
        expected_fee_stroops: 1,
        expected_net_stroops: 19_998,
    },
    FeeVector {
        id: "dust_half_boundary",
        amount_stroops: 5_000,
        fee_bps: 1,
        expected_fee_stroops: 0,
        expected_net_stroops: 5_000,
    },
    FeeVector {
        id: "dust_just_above_zero",
        amount_stroops: 10_001,
        fee_bps: 1,
        expected_fee_stroops: 1,
        expected_net_stroops: 10_000,
    },
    FeeVector {
        id: "dust_boundary_testcase",
        amount_stroops: 10_000_001,
        fee_bps: 25,
        expected_fee_stroops: 25_000,
        expected_net_stroops: 9_975_001,
    },
    FeeVector {
        id: "default_bps_standard_10_usdc",
        amount_stroops: 100_000_000,
        fee_bps: 297,
        expected_fee_stroops: 2_970_000,
        expected_net_stroops: 97_030_000,
    },
    FeeVector {
        id: "default_bps_odd_fraction",
        amount_stroops: 12_345_678,
        fee_bps: 297,
        expected_fee_stroops: 366_666,
        expected_net_stroops: 11_979_012,
    },
    FeeVector {
        id: "bps_contract_cap_1000",
        amount_stroops: 50_000_000,
        fee_bps: 1000,
        expected_fee_stroops: 5_000_000,
        expected_net_stroops: 45_000_000,
    },
    FeeVector {
        id: "sub_cent_micropayment",
        amount_stroops: 50_000,
        fee_bps: 297,
        expected_fee_stroops: 1_485,
        expected_net_stroops: 48_515,
    },
    FeeVector {
        id: "max_stellar_amount",
        amount_stroops: 9_223_372_036_854_775_807,
        fee_bps: 297,
        expected_fee_stroops: 273_934_149_494_586_841,
        expected_net_stroops: 8_949_437_887_360_188_966,
    },
];

#[test]
fn test_checkout_fee_matches_off_chain_vector_table() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let fee_to = Address::generate(&env);
    let merchant = Address::generate(&env);
    let payer = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let issuer = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_addr = issuer.address();
    let sac_admin = StellarAssetClient::new(&env, &token_addr);
    let sac_token = TokenClient::new(&env, &token_addr);

    for v in FEE_VECTORS {
        // Deploy fresh instance configured with the vector's fee_bps
        let contract_id = env.register(Checkout, (fee_to.clone(), v.fee_bps));
        let client = CheckoutClient::new(&env, &contract_id);

        // Mint required amount
        sac_admin.mint(&payer, &v.amount_stroops);

        let merchant_bal_before = sac_token.balance(&merchant);
        let fee_to_bal_before = sac_token.balance(&fee_to);

        // Execute payment on-chain
        let fee = client.pay(&payer, &merchant, &token_addr, &v.amount_stroops);

        // Verify fee matches expected
        assert_eq!(
            fee, v.expected_fee_stroops,
            "vector '{}' fee mismatch (fee_bps={}, amount={})",
            v.id, v.fee_bps, v.amount_stroops
        );

        let merchant_delta = sac_token.balance(&merchant) - merchant_bal_before;
        let fee_to_delta = sac_token.balance(&fee_to) - fee_to_bal_before;

        assert_eq!(
            merchant_delta, v.expected_net_stroops,
            "vector '{}' net mismatch (fee_bps={}, amount={})",
            v.id, v.fee_bps, v.amount_stroops
        );
        assert_eq!(
            fee_to_delta, v.expected_fee_stroops,
            "vector '{}' fee_to balance delta mismatch",
            v.id
        );

        // Assert conservation identity: net + fee == gross
        assert_eq!(
            merchant_delta + fee_to_delta,
            v.amount_stroops,
            "vector '{}' violated conservation identity",
            v.id
        );
    }
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
