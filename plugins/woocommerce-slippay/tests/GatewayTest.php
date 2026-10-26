<?php
/**
 * Tests for WC_Slippay_Gateway methods, availability gates, payment initiation, and refund guards.
 */

require_once __DIR__ . '/TestCase.php';

class GatewayTest extends SlipPayTestCase {
    private function createGateway( array $settings = [] ) {
        $gateway = new WC_Slippay_Gateway();
        $defaultSettings = [
            'enabled'        => 'yes',
            'environment'    => 'testnet',
            'api_key'        => 'sk_test_mock_valid_key_12345',
            'api_base'       => 'https://api.slippay.cc',
            'webhook_secret' => 'super_secret_key_at_least_32_characters!',
            'asset_code'     => 'USDC',
        ];
        $merged = array_merge( $defaultSettings, $settings );
        $gateway->settings = $merged;

        $gateway->enabled      = $merged['enabled'];
        $gateway->environment  = $merged['environment'];
        $gateway->api_key      = $merged['api_key'];
        $gateway->api_base     = $merged['api_base'];
        $gateway->webhook_secret = $merged['webhook_secret'];
        $gateway->asset_code   = $merged['asset_code'];

        return $gateway;
    }

    public function test_is_available_when_enabled_and_brl_currency() {
        $gateway = $this->createGateway( [ 'enabled' => 'yes' ] );
        SlipPayTestRegistry::$currency = 'BRL';
        SlipPayTestRegistry::$cartTotal = 50.00;

        $this->assertTrue( $gateway->is_available() );
    }

    public function test_is_available_returns_false_when_disabled() {
        $gateway = $this->createGateway( [ 'enabled' => 'no' ] );
        SlipPayTestRegistry::$currency = 'BRL';
        SlipPayTestRegistry::$cartTotal = 50.00;

        $this->assertFalse( $gateway->is_available() );
    }

    public function test_is_available_returns_false_when_api_key_missing() {
        $gateway = $this->createGateway( [ 'enabled' => 'yes', 'api_key' => '' ] );
        SlipPayTestRegistry::$currency = 'BRL';
        SlipPayTestRegistry::$cartTotal = 50.00;

        $this->assertFalse( $gateway->is_available() );
    }

    public function test_is_available_returns_false_when_currency_is_not_brl() {
        $gateway = $this->createGateway( [ 'enabled' => 'yes' ] );
        SlipPayTestRegistry::$currency = 'USD';
        SlipPayTestRegistry::$cartTotal = 50.00;

        $this->assertFalse( $gateway->is_available() );

        SlipPayTestRegistry::$currency = 'EUR';
        $this->assertFalse( $gateway->is_available() );
    }

    public function test_is_available_returns_false_when_cart_total_is_zero_or_negative() {
        $gateway = $this->createGateway( [ 'enabled' => 'yes' ] );
        SlipPayTestRegistry::$currency = 'BRL';

        SlipPayTestRegistry::$cartTotal = 0.00;
        $this->assertFalse( $gateway->is_available() );

        SlipPayTestRegistry::$cartTotal = -10.00;
        $this->assertFalse( $gateway->is_available() );
    }

    public function test_process_payment_fails_when_order_not_found() {
        $gateway = $this->createGateway();
        $res = $gateway->process_payment( 999 );

        $this->assertEquals( [ 'result' => 'fail' ], $res );
        $this->assertEquals( 'Could not load order.', SlipPayTestRegistry::$notices[0]['message'] );
    }

    public function test_process_payment_fails_when_api_key_empty() {
        $gateway = $this->createGateway( [ 'api_key' => '' ] );
        $order = new WC_Order( 1, 100.0 );
        SlipPayTestRegistry::$orders[1] = $order;

        $res = $gateway->process_payment( 1 );

        $this->assertEquals( [ 'result' => 'fail' ], $res );
        $this->assertEquals( 'SlipPay API key not configured.', SlipPayTestRegistry::$notices[0]['message'] );
    }

    public function test_process_payment_fails_when_api_key_environment_mismatched() {
        // Testnet environment with live key
        $gateway1 = $this->createGateway( [
            'environment' => 'testnet',
            'api_key'     => 'sk_live_1234567890abcdef',
        ] );
        $order = new WC_Order( 1, 100.0 );
        SlipPayTestRegistry::$orders[1] = $order;

        $res1 = $gateway1->process_payment( 1 );
        $this->assertEquals( [ 'result' => 'fail' ], $res1 );
        $this->assertStringContainsString( 'API key environment does not match the selected environment', SlipPayTestRegistry::$notices[0]['message'] );

        // Mainnet environment with test key
        SlipPayTestRegistry::$notices = [];
        $gateway2 = $this->createGateway( [
            'environment' => 'mainnet',
            'api_key'     => 'sk_test_1234567890abcdef',
        ] );

        $res2 = $gateway2->process_payment( 1 );
        $this->assertEquals( [ 'result' => 'fail' ], $res2 );
        $this->assertStringContainsString( 'API key environment does not match the selected environment', SlipPayTestRegistry::$notices[0]['message'] );
    }

    public function test_process_payment_fails_when_api_base_disallowed() {
        $gateway = $this->createGateway( [
            'api_base' => 'https://unauthorized-domain.com',
        ] );
        $order = new WC_Order( 1, 100.0 );
        SlipPayTestRegistry::$orders[1] = $order;

        $res = $gateway->process_payment( 1 );

        $this->assertEquals( [ 'result' => 'fail' ], $res );
        $this->assertEquals( 'SlipPay configuration error: API base host is not allowed.', SlipPayTestRegistry::$notices[0]['message'] );
    }

    public function test_process_payment_fails_when_remote_post_returns_wp_error() {
        $gateway = $this->createGateway();
        $order = new WC_Order( 2, 50.0 );
        SlipPayTestRegistry::$orders[2] = $order;

        SlipPayTestRegistry::$remotePostHandler = function ( $url, $args ) {
            return new WP_Error( 'http_timeout', 'Connection timed out after 15000ms' );
        };

        $res = $gateway->process_payment( 2 );

        $this->assertEquals( [ 'result' => 'fail' ], $res );
        $this->assertEquals( 'Payment service unreachable. Try again.', SlipPayTestRegistry::$notices[0]['message'] );
        $this->assertStringContainsString( 'SlipPay request error: Connection timed out after 15000ms', $order->notes[0] );
    }

    public function test_process_payment_fails_when_api_returns_error_status() {
        $gateway = $this->createGateway();
        $order = new WC_Order( 3, 75.0 );
        SlipPayTestRegistry::$orders[3] = $order;

        SlipPayTestRegistry::$remotePostHandler = function ( $url, $args ) {
            return [
                'response' => [ 'code' => 400 ],
                'body'     => json_encode( [ 'error' => 'amount_below_minimum' ] ),
            ];
        };

        $res = $gateway->process_payment( 3 );

        $this->assertEquals( [ 'result' => 'fail' ], $res );
        $this->assertEquals( 'Payment failed to initiate. Please try again.', SlipPayTestRegistry::$notices[0]['message'] );
        $this->assertStringContainsString( 'SlipPay order create failed (400): amount_below_minimum', $order->notes[0] );
    }

    public function test_process_payment_fails_when_api_returns_incomplete_order_data() {
        $gateway = $this->createGateway();
        $order = new WC_Order( 4, 80.0 );
        SlipPayTestRegistry::$orders[4] = $order;

        SlipPayTestRegistry::$remotePostHandler = function ( $url, $args ) {
            return [
                'response' => [ 'code' => 201 ],
                'body'     => json_encode( [
                    'order' => [ 'id' => '' ], // missing ID
                    'checkout_url' => 'https://api.slippay.cc/pay/1',
                ] ),
            ];
        };

        $res = $gateway->process_payment( 4 );
        $this->assertEquals( [ 'result' => 'fail' ], $res );
    }

    public function test_process_payment_fails_when_checkout_redirect_host_is_unsafe() {
        $gateway = $this->createGateway();
        $order = new WC_Order( 5, 90.0 );
        SlipPayTestRegistry::$orders[5] = $order;

        SlipPayTestRegistry::$remotePostHandler = function ( $url, $args ) {
            return [
                'response' => [ 'code' => 201 ],
                'body'     => json_encode( [
                    'order'        => [ 'id' => 'ord_safe_1', 'memo' => 'm1', 'usdc_amount' => '15.00' ],
                    'checkout_url' => 'https://phishing-slippay.com/checkout/ord_safe_1',
                ] ),
            ];
        };

        $res = $gateway->process_payment( 5 );

        $this->assertEquals( [ 'result' => 'fail' ], $res );
        $this->assertEquals( 'Payment failed: untrusted checkout host.', SlipPayTestRegistry::$notices[0]['message'] );
        $this->assertStringContainsString( 'SlipPay rejected redirect to untrusted host: https://phishing-slippay.com/checkout/ord_safe_1', $order->notes[0] );
    }

    public function test_process_payment_succeeds_and_saves_order_meta() {
        $gateway = $this->createGateway();
        $order = new WC_Order( 6, 120.50 );
        SlipPayTestRegistry::$orders[6] = $order;

        $expectedUrl = 'https://pay.slippay.cc/checkout/ord_test_success_123';
        SlipPayTestRegistry::$remotePostHandler = function ( $url, $args ) use ( $expectedUrl ) {
            // Verify request body
            $sentBody = json_decode( $args['body'], true );
            if ( $sentBody['brl_amount'] !== '120.50' || $sentBody['external_ref'] !== 'wc_6' ) {
                return new WP_Error( 'bad_body', 'Request body invalid' );
            }

            return [
                'response' => [ 'code' => 201 ],
                'body'     => json_encode( [
                    'order'        => [
                        'id'          => 'ord_test_success_123',
                        'memo'        => 'MEMO_98765',
                        'usdc_amount' => '20.78',
                    ],
                    'checkout_url' => $expectedUrl,
                ] ),
            ];
        };

        $res = $gateway->process_payment( 6 );

        $this->assertEquals( 'success', $res['result'] );
        $this->assertEquals( $expectedUrl, $res['redirect'] );
        $this->assertEquals( 'pending', $order->status );
        $this->assertEquals( 'ord_test_success_123', $order->meta['_slippay_order_id'] );
        $this->assertEquals( 'MEMO_98765', $order->meta['_slippay_memo'] );
        $this->assertEquals( '20.78', $order->meta['_slippay_usdc_amount'] );
    }

    public function test_process_refund_returns_wp_error() {
        $gateway = $this->createGateway();
        $result = $gateway->process_refund( 10, 50.00, 'Customer requested return' );

        $this->assertTrue( is_wp_error( $result ) );
        $this->assertEquals( 'slippay_no_onchain_refund', $result->get_error_code() );
        $this->assertStringContainsString( 'SlipPay v0.1 does not support automated refunds', $result->get_error_message() );
    }
}
