<?php
/**
 * Tests for WC_Slippay_Webhook verification chain and payload dispatching.
 */

require_once __DIR__ . '/TestCase.php';

class WebhookTest extends SlipPayTestCase {
    private $secret;

    public function setUp() {
        parent::setUp();
        $this->secret = 'super_secret_webhook_key_at_least_32_characters!';
    }

    private function generateSignature( $t, $body, $secret = null ) {
        $sec = $secret !== null ? $secret : $this->secret;
        $v1 = hash_hmac( 'sha256', $t . '.' . $body, $sec );
        return "t={$t},v1={$v1}";
    }

    public function test_empty_body() {
        $res = $this->executeWebhook( [
            'input' => '',
            'server' => [ 'HTTP_X_SLIPPAY_SIGNATURE' => 't=123,v1=abc' ],
            'gateway_options' => [ 'webhook_secret' => $this->secret ],
        ] );

        $this->assertEquals( 400, $res['status_code'] );
        $this->assertEquals( [ 'error' => 'empty body' ], $res['parsed_json'] );
    }

    public function test_unconfigured_secret_missing() {
        $body = '{"type":"test"}';
        $res = $this->executeWebhook( [
            'input' => $body,
            'server' => [ 'HTTP_X_SLIPPAY_SIGNATURE' => 't=123,v1=abc' ],
            'gateway_options' => [ 'webhook_secret' => '' ],
        ] );

        $this->assertEquals( 503, $res['status_code'] );
        $this->assertEquals( [ 'error' => 'webhook_not_configured' ], $res['parsed_json'] );
    }

    public function test_unconfigured_secret_too_short() {
        $body = '{"type":"test"}';
        $res = $this->executeWebhook( [
            'input' => $body,
            'server' => [ 'HTTP_X_SLIPPAY_SIGNATURE' => 't=123,v1=abc' ],
            'gateway_options' => [ 'webhook_secret' => 'short_key_20_chars!' ],
        ] );

        $this->assertEquals( 503, $res['status_code'] );
        $this->assertEquals( [ 'error' => 'webhook_not_configured' ], $res['parsed_json'] );
    }

    public function test_missing_signature_header() {
        $body = '{"type":"test"}';
        $res = $this->executeWebhook( [
            'input' => $body,
            'server' => [],
            'gateway_options' => [ 'webhook_secret' => $this->secret ],
        ] );

        $this->assertEquals( 401, $res['status_code'] );
        $this->assertEquals( [ 'error' => 'missing signature header' ], $res['parsed_json'] );
    }

    public function test_malformed_signature_format() {
        $body = '{"type":"test"}';
        $res = $this->executeWebhook( [
            'input' => $body,
            'server' => [ 'HTTP_X_SLIPPAY_SIGNATURE' => 'invalid_signature_format' ],
            'gateway_options' => [ 'webhook_secret' => $this->secret ],
        ] );

        $this->assertEquals( 401, $res['status_code'] );
        $this->assertEquals( [ 'error' => 'malformed signature' ], $res['parsed_json'] );
    }

    public function test_stale_signature_too_old() {
        $body = '{"type":"test"}';
        $t = time() - 305;
        $sig = $this->generateSignature( $t, $body );

        $res = $this->executeWebhook( [
            'input' => $body,
            'server' => [ 'HTTP_X_SLIPPAY_SIGNATURE' => $sig ],
            'gateway_options' => [ 'webhook_secret' => $this->secret ],
        ] );

        $this->assertEquals( 401, $res['status_code'] );
        $this->assertEquals( [ 'error' => 'stale signature' ], $res['parsed_json'] );
    }

    public function test_stale_signature_too_far_future() {
        $body = '{"type":"test"}';
        $t = time() + 305;
        $sig = $this->generateSignature( $t, $body );

        $res = $this->executeWebhook( [
            'input' => $body,
            'server' => [ 'HTTP_X_SLIPPAY_SIGNATURE' => $sig ],
            'gateway_options' => [ 'webhook_secret' => $this->secret ],
        ] );

        $this->assertEquals( 401, $res['status_code'] );
        $this->assertEquals( [ 'error' => 'stale signature' ], $res['parsed_json'] );
    }

    public function test_invalid_signature_hmac_mismatch() {
        $body = '{"type":"test"}';
        $t = time();
        $sig = $this->generateSignature( $t, $body, 'another_secret_key_at_least_32_characters_12345' );

        $res = $this->executeWebhook( [
            'input' => $body,
            'server' => [ 'HTTP_X_SLIPPAY_SIGNATURE' => $sig ],
            'gateway_options' => [ 'webhook_secret' => $this->secret ],
        ] );

        $this->assertEquals( 401, $res['status_code'] );
        $this->assertEquals( [ 'error' => 'invalid signature' ], $res['parsed_json'] );
    }

    public function test_replay_protection_duplicate_delivery() {
        $deliveryId = 'delivery-uuid-999';
        $body = '{"type":"test"}';
        $t = time();
        $sig = $this->generateSignature( $t, $body );
        $seenKey = 'slippay_seen_' . md5( $deliveryId );

        $res = $this->executeWebhook( [
            'input' => $body,
            'server' => [
                'HTTP_X_SLIPPAY_SIGNATURE'   => $sig,
                'HTTP_X_SLIPPAY_DELIVERY_ID' => $deliveryId,
            ],
            'gateway_options' => [ 'webhook_secret' => $this->secret ],
            'transients' => [ $seenKey => 1 ],
        ] );

        $this->assertEquals( 409, $res['status_code'] );
        $this->assertEquals( [ 'error' => 'duplicate delivery' ], $res['parsed_json'] );
    }

    public function test_replay_protection_records_transient() {
        $deliveryId = 'fresh-delivery-uuid-111';
        $body = json_encode( [
            'type' => 'order.paid',
            'data' => [ 'id' => 'ord_replay_test' ],
        ] );
        $t = time();
        $sig = $this->generateSignature( $t, $body );
        $seenKey = 'slippay_seen_' . md5( $deliveryId );

        $res = $this->executeWebhook( [
            'input' => $body,
            'server' => [
                'HTTP_X_SLIPPAY_SIGNATURE'   => $sig,
                'HTTP_X_SLIPPAY_DELIVERY_ID' => $deliveryId,
            ],
            'gateway_options' => [ 'webhook_secret' => $this->secret ],
            'orders' => [
                [
                    'id'    => 10,
                    'total' => 150.0,
                    'meta'  => [ '_slippay_order_id' => 'ord_replay_test' ],
                ],
            ],
        ] );

        $this->assertEquals( 200, $res['status_code'] );
        $this->assertArrayHasKey( $seenKey, $res['transients'] );
        $this->assertEquals( 1, $res['transients'][ $seenKey ] );
    }

    public function test_malformed_payload_not_json() {
        $body = 'not-a-valid-json-string';
        $t = time();
        $sig = $this->generateSignature( $t, $body );

        $res = $this->executeWebhook( [
            'input' => $body,
            'server' => [ 'HTTP_X_SLIPPAY_SIGNATURE' => $sig ],
            'gateway_options' => [ 'webhook_secret' => $this->secret ],
        ] );

        $this->assertEquals( 400, $res['status_code'] );
        $this->assertEquals( [ 'error' => 'malformed payload' ], $res['parsed_json'] );
    }

    public function test_malformed_payload_missing_required_fields() {
        $t = time();

        // Missing type
        $body1 = json_encode( [ 'data' => [ 'id' => 'ord_123' ] ] );
        $res1 = $this->executeWebhook( [
            'input' => $body1,
            'server' => [ 'HTTP_X_SLIPPAY_SIGNATURE' => $this->generateSignature( $t, $body1 ) ],
            'gateway_options' => [ 'webhook_secret' => $this->secret ],
        ] );
        $this->assertEquals( 400, $res1['status_code'] );
        $this->assertEquals( [ 'error' => 'malformed payload' ], $res1['parsed_json'] );

        // Missing data.id
        $body2 = json_encode( [ 'type' => 'order.paid', 'data' => [] ] );
        $res2 = $this->executeWebhook( [
            'input' => $body2,
            'server' => [ 'HTTP_X_SLIPPAY_SIGNATURE' => $this->generateSignature( $t, $body2 ) ],
            'gateway_options' => [ 'webhook_secret' => $this->secret ],
        ] );
        $this->assertEquals( 400, $res2['status_code'] );
        $this->assertEquals( [ 'error' => 'malformed payload' ], $res2['parsed_json'] );
    }

    public function test_wc_order_not_found() {
        $body = json_encode( [
            'type' => 'order.paid',
            'data' => [ 'id' => 'unknown_slippay_ord_999' ],
        ] );
        $t = time();
        $sig = $this->generateSignature( $t, $body );

        $res = $this->executeWebhook( [
            'input' => $body,
            'server' => [ 'HTTP_X_SLIPPAY_SIGNATURE' => $sig ],
            'gateway_options' => [ 'webhook_secret' => $this->secret ],
            'orders' => [],
        ] );

        $this->assertEquals( 404, $res['status_code'] );
        $this->assertEquals( 'wc order not found', $res['parsed_json']['error'] );
        $this->assertEquals( 'unknown_slippay_ord_999', $res['parsed_json']['slippay_id'] );
    }

    public function test_order_paid_event() {
        $body = json_encode( [
            'type' => 'order.paid',
            'data' => [
                'id'      => 'slip_ord_1',
                'tx_hash' => '0xdeadbeef12345678',
            ],
        ] );
        $t = time();
        $sig = $this->generateSignature( $t, $body );

        $res = $this->executeWebhook( [
            'input' => $body,
            'server' => [ 'HTTP_X_SLIPPAY_SIGNATURE' => $sig ],
            'gateway_options' => [ 'webhook_secret' => $this->secret ],
            'orders' => [
                [
                    'id'    => 42,
                    'total' => 200.0,
                    'meta'  => [ '_slippay_order_id' => 'slip_ord_1' ],
                ],
            ],
        ] );

        $this->assertEquals( 200, $res['status_code'] );
        $this->assertEquals( [ 'ok' => true ], $res['parsed_json'] );

        $order = $res['orders'][42];
        $this->assertEquals( 'processing', $order['status'] );
        $this->assertEquals( '0xdeadbeef12345678', $order['meta']['_slippay_tx_hash'] );
        $this->assertStringContainsString( 'SlipPay order.paid confirmed. tx: 0xdeadbeef12345678', $order['notes'][0] );
    }

    public function test_subscription_charged_event() {
        $body = json_encode( [
            'type' => 'subscription.charged',
            'data' => [
                'id'      => 'slip_sub_2',
                'tx_hash' => '0xsubtx999',
            ],
        ] );
        $t = time();
        $sig = $this->generateSignature( $t, $body );

        $res = $this->executeWebhook( [
            'input' => $body,
            'server' => [ 'HTTP_X_SLIPPAY_SIGNATURE' => $sig ],
            'gateway_options' => [ 'webhook_secret' => $this->secret ],
            'orders' => [
                [
                    'id'    => 43,
                    'total' => 50.0,
                    'meta'  => [ '_slippay_order_id' => 'slip_sub_2' ],
                ],
            ],
        ] );

        $this->assertEquals( 200, $res['status_code'] );
        $this->assertEquals( [ 'ok' => true ], $res['parsed_json'] );

        $order = $res['orders'][43];
        $this->assertEquals( 'processing', $order['status'] );
        $this->assertEquals( '0xsubtx999', $order['meta']['_slippay_tx_hash'] );
    }

    public function test_order_underpaid_event() {
        $body = json_encode( [
            'type' => 'order.underpaid',
            'data' => [
                'id'       => 'slip_under_3',
                'expected' => '100.00',
                'received' => '60.00',
            ],
        ] );
        $t = time();
        $sig = $this->generateSignature( $t, $body );

        $res = $this->executeWebhook( [
            'input' => $body,
            'server' => [ 'HTTP_X_SLIPPAY_SIGNATURE' => $sig ],
            'gateway_options' => [ 'webhook_secret' => $this->secret ],
            'orders' => [
                [
                    'id'    => 44,
                    'total' => 100.0,
                    'meta'  => [ '_slippay_order_id' => 'slip_under_3' ],
                ],
            ],
        ] );

        $this->assertEquals( 200, $res['status_code'] );
        $order = $res['orders'][44];
        $this->assertEquals( 'on-hold', $order['status'] );
        $this->assertStringContainsString( 'expected 100.00, received 60.00', $order['notes'][0] );
    }

    public function test_order_expired_event() {
        $body = json_encode( [
            'type' => 'order.expired',
            'data' => [ 'id' => 'slip_exp_4' ],
        ] );
        $t = time();
        $sig = $this->generateSignature( $t, $body );

        $res = $this->executeWebhook( [
            'input' => $body,
            'server' => [ 'HTTP_X_SLIPPAY_SIGNATURE' => $sig ],
            'gateway_options' => [ 'webhook_secret' => $this->secret ],
            'orders' => [
                [
                    'id'    => 45,
                    'total' => 80.0,
                    'meta'  => [ '_slippay_order_id' => 'slip_exp_4' ],
                ],
            ],
        ] );

        $this->assertEquals( 200, $res['status_code'] );
        $order = $res['orders'][45];
        $this->assertEquals( 'cancelled', $order['status'] );
        $this->assertStringContainsString( 'SlipPay order expired before payment.', $order['notes'][0] );
    }

    public function test_order_cancelled_event() {
        $body = json_encode( [
            'type' => 'order.cancelled',
            'data' => [ 'id' => 'slip_canc_5' ],
        ] );
        $t = time();
        $sig = $this->generateSignature( $t, $body );

        $res = $this->executeWebhook( [
            'input' => $body,
            'server' => [ 'HTTP_X_SLIPPAY_SIGNATURE' => $sig ],
            'gateway_options' => [ 'webhook_secret' => $this->secret ],
            'orders' => [
                [
                    'id'    => 46,
                    'total' => 80.0,
                    'meta'  => [ '_slippay_order_id' => 'slip_canc_5' ],
                ],
            ],
        ] );

        $this->assertEquals( 200, $res['status_code'] );
        $order = $res['orders'][46];
        $this->assertEquals( 'cancelled', $order['status'] );
        $this->assertStringContainsString( 'SlipPay order cancelled.', $order['notes'][0] );
    }

    public function test_unknown_event_type_handled_as_noop() {
        $body = json_encode( [
            'type' => 'custom.ping',
            'data' => [ 'id' => 'slip_noop_6' ],
        ] );
        $t = time();
        $sig = $this->generateSignature( $t, $body );

        $res = $this->executeWebhook( [
            'input' => $body,
            'server' => [ 'HTTP_X_SLIPPAY_SIGNATURE' => $sig ],
            'gateway_options' => [ 'webhook_secret' => $this->secret ],
            'orders' => [
                [
                    'id'     => 47,
                    'total'  => 50.0,
                    'status' => 'pending',
                    'meta'   => [ '_slippay_order_id' => 'slip_noop_6' ],
                ],
            ],
        ] );

        $this->assertEquals( 200, $res['status_code'] );
        $order = $res['orders'][47];
        $this->assertEquals( 'pending', $order['status'] );
        $this->assertStringContainsString( 'SlipPay event received (no-op for this type): custom.ping', $order['notes'][0] );
    }

    public function test_signature_via_http_x_signature_fallback() {
        $body = json_encode( [
            'type' => 'order.paid',
            'data' => [ 'id' => 'slip_fallback_7' ],
        ] );
        $t = time();
        $sig = $this->generateSignature( $t, $body );

        $res = $this->executeWebhook( [
            'input' => $body,
            'server' => [ 'HTTP_X_SIGNATURE' => $sig ],
            'gateway_options' => [ 'webhook_secret' => $this->secret ],
            'orders' => [
                [
                    'id'    => 48,
                    'total' => 30.0,
                    'meta'  => [ '_slippay_order_id' => 'slip_fallback_7' ],
                ],
            ],
        ] );

        $this->assertEquals( 200, $res['status_code'] );
        $this->assertEquals( [ 'ok' => true ], $res['parsed_json'] );
    }
}
