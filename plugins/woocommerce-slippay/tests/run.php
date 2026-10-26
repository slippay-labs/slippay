<?php
/**
 * Standalone test runner for SlipPay WooCommerce plugin.
 * Usage: php tests/run.php
 */

require_once __DIR__ . '/bootstrap.php';
require_once __DIR__ . '/TestCase.php';
require_once __DIR__ . '/WebhookTest.php';
require_once __DIR__ . '/GatewayTest.php';

$testClasses = [
    'WebhookTest',
    'GatewayTest',
];

$totalTests  = 0;
$passedTests = 0;
$failedTests = [];
$startTime   = microtime( true );

echo "========================================================\n";
echo " Running SlipPay WooCommerce Plugin PHP Test Harness\n";
echo " PHP Version: " . PHP_VERSION . "\n";
echo "========================================================\n\n";

foreach ( $testClasses as $className ) {
    echo "• Suite: {$className}\n";
    $reflection = new ReflectionClass( $className );
    $methods = $reflection->getMethods( ReflectionMethod::IS_PUBLIC );

    foreach ( $methods as $method ) {
        $methodName = $method->getName();
        if ( strpos( $methodName, 'test_' ) !== 0 ) {
            continue;
        }

        $totalTests++;
        $instance = new $className();
        $instance->name = $methodName;

        try {
            $instance->setUp();
            $method->invoke( $instance );
            $instance->tearDown();
            $passedTests++;
            echo "  [PASS] {$methodName}\n";
        } catch ( Throwable $e ) {
            $failedTests[] = [
                'suite'   => $className,
                'test'    => $methodName,
                'message' => $e->getMessage(),
                'trace'   => $e->getTraceAsString(),
            ];
            echo "  [FAIL] {$methodName} -> " . $e->getMessage() . "\n";
        }
    }
    echo "\n";
}

$elapsed = round( microtime( true ) - $startTime, 3 );

echo "========================================================\n";
echo " Test Summary\n";
echo " Total:   {$totalTests}\n";
echo " Passed:  {$passedTests}\n";
echo " Failed:  " . count( $failedTests ) . "\n";
echo " Elapsed: {$elapsed}s\n";
echo "========================================================\n";

if ( ! empty( $failedTests ) ) {
    echo "\nFailures details:\n";
    foreach ( $failedTests as $idx => $fail ) {
        echo ( $idx + 1 ) . ") {$fail['suite']}::{$fail['test']}\n";
        echo "   {$fail['message']}\n";
        echo "   Trace:\n   " . str_replace( "\n", "\n   ", $fail['trace'] ) . "\n\n";
    }
    exit( 1 );
}

echo "\nALL TESTS PASSED SUCCESSFULLY! (100% GREEN)\n";
exit( 0 );
