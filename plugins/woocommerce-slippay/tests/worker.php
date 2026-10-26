<?php
/**
 * Worker script for isolated webhook executions.
 */

if ( empty( $argv[1] ) || ! file_exists( $argv[1] ) ) {
    fwrite( STDERR, "Worker error: Missing configuration file argument\n" );
    exit( 1 );
}

$rawConfig = file_get_contents( $argv[1] );
$config = json_decode( $rawConfig, true );

if ( ! is_array( $config ) ) {
    fwrite( STDERR, "Worker error: Invalid JSON in configuration file\n" );
    exit( 1 );
}

require_once __DIR__ . '/bootstrap.php';

// 1. Setup Server variables
if ( ! empty( $config['server'] ) && is_array( $config['server'] ) ) {
    foreach ( $config['server'] as $k => $v ) {
        $_SERVER[ $k ] = $v;
    }
}

// 2. Setup mock php://input
$GLOBALS['_MOCK_PHP_INPUT'] = $config['input'] ?? '';

// 3. Setup Gateway
$gateway = new WC_Payment_Gateway();
$gateway->id = 'slippay';
if ( ! empty( $config['gateway_options'] ) && is_array( $config['gateway_options'] ) ) {
    foreach ( $config['gateway_options'] as $k => $v ) {
        $gateway->set_option( $k, $v );
    }
}
SlipPayTestRegistry::$activeGateway = $gateway;

// 4. Setup Transients
if ( ! empty( $config['transients'] ) && is_array( $config['transients'] ) ) {
    foreach ( $config['transients'] as $k => $v ) {
        SlipPayTestRegistry::$transients[ $k ] = $v;
    }
}

// 5. Setup Orders
if ( ! empty( $config['orders'] ) && is_array( $config['orders'] ) ) {
    foreach ( $config['orders'] as $ordData ) {
        $order = new WC_Order( $ordData['id'], $ordData['total'] ?? 100.0 );
        if ( ! empty( $ordData['meta'] ) && is_array( $ordData['meta'] ) ) {
            foreach ( $ordData['meta'] as $mk => $mv ) {
                $order->update_meta_data( $mk, $mv );
            }
        }
        if ( ! empty( $ordData['status'] ) ) {
            $order->status = $ordData['status'];
        }
        SlipPayTestRegistry::$orders[ $order->id ] = $order;
    }
}

// Register shutdown function to capture result after exit
register_shutdown_function( function () {
    $stdout = ob_get_clean();
    $result = [
        'status_code' => SlipPayTestRegistry::$statusCode,
        'stdout'      => $stdout,
        'parsed_json' => json_decode( $stdout, true ),
        'orders'      => [],
        'transients'  => SlipPayTestRegistry::$transients,
    ];

    foreach ( SlipPayTestRegistry::$orders as $id => $order ) {
        $result['orders'][ $id ] = [
            'id'                  => $order->id,
            'status'              => $order->status,
            'meta'                => $order->meta,
            'notes'               => $order->notes,
            'paymentCompletedTx'  => $order->paymentCompletedTx,
        ];
    }

    echo "\n===SLIPPAY_RESULT_START===\n";
    echo json_encode( $result, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
    echo "\n===SLIPPAY_RESULT_END===\n";
} );

ob_start();

$webhook = new WC_Slippay_Webhook();
$webhook->handle();
