<?php
/**
 * Base TestCase class providing assertion utilities and isolated runner execution.
 */

class SlipPayTestCase {
    public $name = '';

    public function setUp() {
        SlipPayTestRegistry::reset();
    }

    public function tearDown() {
        SlipPayTestRegistry::reset();
    }

    public function assertEquals( $expected, $actual, $message = '' ) {
        if ( $expected !== $actual ) {
            $msg = $message ?: sprintf( "Failed asserting that %s matches expected %s.", var_export( $actual, true ), var_export( $expected, true ) );
            throw new Exception( $msg );
        }
    }

    public function assertTrue( $condition, $message = '' ) {
        if ( $condition !== true ) {
            $msg = $message ?: sprintf( "Failed asserting that %s is true.", var_export( $condition, true ) );
            throw new Exception( $msg );
        }
    }

    public function assertFalse( $condition, $message = '' ) {
        if ( $condition !== false ) {
            $msg = $message ?: sprintf( "Failed asserting that %s is false.", var_export( $condition, true ) );
            throw new Exception( $msg );
        }
    }

    public function assertNull( $val, $message = '' ) {
        if ( $val !== null ) {
            $msg = $message ?: sprintf( "Failed asserting that %s is null.", var_export( $val, true ) );
            throw new Exception( $msg );
        }
    }

    public function assertNotNull( $val, $message = '' ) {
        if ( $val === null ) {
            $msg = $message ?: "Failed asserting that value is not null.";
            throw new Exception( $msg );
        }
    }

    public function assertStringContainsString( $needle, $haystack, $message = '' ) {
        if ( strpos( (string) $haystack, (string) $needle ) === false ) {
            $msg = $message ?: sprintf( "Failed asserting that '%s' contains '%s'.", $haystack, $needle );
            throw new Exception( $msg );
        }
    }

    public function assertMatchesRegularExpression( $pattern, $string, $message = '' ) {
        if ( ! preg_match( $pattern, (string) $string ) ) {
            $msg = $message ?: sprintf( "Failed asserting that '%s' matches pattern '%s'.", $string, $pattern );
            throw new Exception( $msg );
        }
    }

    public function assertArrayHasKey( $key, $array, $message = '' ) {
        if ( ! is_array( $array ) || ! array_key_exists( $key, $array ) ) {
            $msg = $message ?: sprintf( "Failed asserting that array contains key '%s'.", $key );
            throw new Exception( $msg );
        }
    }

    /**
     * Executes the webhook in an isolated subprocess to safely test paths with exit;.
     *
     * @param array $config Configuration dictionary for worker.php
     * @return array Decoded execution result
     */
    protected function executeWebhook( array $config ) {
        $tmpFile = tempnam( sys_get_temp_dir(), 'slippay_cfg_' );
        file_put_contents( $tmpFile, json_encode( $config ) );

        $workerPath = __DIR__ . '/worker.php';
        $cmd = 'php ' . escapeshellarg( $workerPath ) . ' ' . escapeshellarg( $tmpFile );

        $output = shell_exec( $cmd );
        @unlink( $tmpFile );

        if ( ! $output || strpos( $output, '===SLIPPAY_RESULT_START===' ) === false ) {
            throw new Exception( "Worker process failed or produced invalid output: " . $output );
        }

        $startTag = "===SLIPPAY_RESULT_START===\n";
        $endTag = "\n===SLIPPAY_RESULT_END===";
        $startPos = strpos( $output, $startTag ) + strlen( $startTag );
        $endPos = strpos( $output, $endTag, $startPos );
        $jsonStr = substr( $output, $startPos, $endPos - $startPos );

        $res = json_decode( $jsonStr, true );
        if ( ! is_array( $res ) ) {
            throw new Exception( "Failed to parse worker JSON result: " . $jsonStr );
        }

        return $res;
    }
}
