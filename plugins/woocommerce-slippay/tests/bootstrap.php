<?php
/**
 * Test bootstrap & WordPress/WooCommerce stubs for SlipPay plugin test suite.
 */

if ( ! defined( 'ABSPATH' ) ) {
    define( 'ABSPATH', dirname( __DIR__ ) . '/' );
}
if ( ! defined( 'DAY_IN_SECONDS' ) ) {
    define( 'DAY_IN_SECONDS', 86400 );
}
if ( ! defined( 'WC_SLIPPAY_PLUGIN_FILE' ) ) {
    define( 'WC_SLIPPAY_PLUGIN_FILE', dirname( __DIR__ ) . '/woocommerce-slippay.php' );
}
if ( ! defined( 'WC_SLIPPAY_PLUGIN_DIR' ) ) {
    define( 'WC_SLIPPAY_PLUGIN_DIR', dirname( __DIR__ ) . '/' );
}

// Global test harness registry
class SlipPayTestRegistry {
    public static $statusCode = 200;
    public static $outputBody = '';
    public static $orders = [];
    public static $transients = [];
    public static $notices = [];
    public static $remotePostHandler = null;
    public static $currency = 'BRL';
    public static $activeGateway = null;
    public static $cartTotal = 100.00;

    public static function reset() {
        self::$statusCode = 200;
        self::$outputBody = '';
        self::$orders = [];
        self::$transients = [];
        self::$notices = [];
        self::$remotePostHandler = null;
        self::$currency = 'BRL';
        self::$activeGateway = null;
        self::$cartTotal = 100.00;
        $GLOBALS['_MOCK_PHP_INPUT'] = '';
        $_SERVER = [];
    }
}

// Intercept php://input via stream wrapper
if ( in_array( 'php', stream_get_wrappers() ) ) {
    stream_wrapper_unregister( 'php' );
}

class SlipPayMockPhpStream {
    public $context;
    private $data = '';
    private $pos = 0;

    public function stream_open( $path, $mode, $options, &$opened_path ) {
        if ( $path === 'php://input' ) {
            $this->data = $GLOBALS['_MOCK_PHP_INPUT'] ?? '';
            $this->pos = 0;
            return true;
        }
        return false;
    }

    public function stream_read( $count ) {
        $ret = substr( $this->data, $this->pos, $count );
        $this->pos += strlen( $ret );
        return $ret;
    }

    public function stream_eof() {
        return $this->pos >= strlen( $this->data );
    }

    public function stream_stat() {
        return [ 'size' => strlen( $this->data ) ];
    }
}
stream_wrapper_register( 'php', 'SlipPayMockPhpStream' );

// Mock WordPress Classes
class WP_Error {
    protected $code;
    protected $message;
    protected $data;

    public function __construct( $code = '', $message = '', $data = '' ) {
        $this->code = $code;
        $this->message = $message;
        $this->data = $data;
    }

    public function get_error_code() {
        return $this->code;
    }

    public function get_error_message() {
        return $this->message;
    }
}

class WC_Order {
    public $id;
    public $status = 'pending';
    public $total = 100.00;
    public $meta = [];
    public $notes = [];
    public $paymentCompletedTx = null;

    public function __construct( $id = 1, $total = 100.00 ) {
        $this->id = $id;
        $this->total = (float) $total;
    }

    public function get_id() {
        return $this->id;
    }

    public function get_total() {
        return $this->total;
    }

    public function update_meta_data( $key, $value ) {
        $this->meta[ $key ] = $value;
    }

    public function get_meta( $key ) {
        return $this->meta[ $key ] ?? '';
    }

    public function save() {
        SlipPayTestRegistry::$orders[ $this->id ] = $this;
    }

    public function update_status( $status, $note = '' ) {
        $this->status = $status;
        if ( $note ) {
            $this->add_order_note( $note );
        }
    }

    public function payment_complete( $tx_hash = '' ) {
        $this->status = 'processing';
        $this->paymentCompletedTx = $tx_hash;
    }

    public function add_order_note( $note ) {
        $this->notes[] = $note;
    }
}

class WC_Payment_Gateway {
    public $id = '';
    public $method_title = '';
    public $method_description = '';
    public $has_fields = false;
    public $enabled = 'no';
    public $title = '';
    public $description = '';
    public $settings = [];
    public $form_fields = [];

    public function init_form_fields() {}
    public function init_settings() {}
    public function process_admin_options() {}

    public function get_option( $key, $default = '' ) {
        return $this->settings[ $key ] ?? $default;
    }

    public function set_option( $key, $value ) {
        $this->settings[ $key ] = $value;
    }

    public function is_available() {
        return 'yes' === $this->enabled;
    }
}

class WC_Cart {
    public $total = 100.00;
}

class WC_Gateways_Container {
    public function payment_gateways() {
        if ( SlipPayTestRegistry::$activeGateway ) {
            return [ 'slippay' => SlipPayTestRegistry::$activeGateway ];
        }
        return [];
    }
}

class WooCommerce_Mock {
    public $cart;
    private $gateways;

    public function __construct() {
        $this->cart = new WC_Cart();
        $this->gateways = new WC_Gateways_Container();
    }

    public function payment_gateways() {
        return $this->gateways;
    }
}

function WC() {
    static $wc = null;
    if ( $wc === null ) {
        $wc = new WooCommerce_Mock();
    }
    $wc->cart->total = SlipPayTestRegistry::$cartTotal;
    return $wc;
}

// Mock WordPress & WooCommerce Functions
function status_header( $code ) {
    SlipPayTestRegistry::$statusCode = (int) $code;
}

function wp_json_encode( $data ) {
    return json_encode( $data );
}

function sanitize_text_field( $str ) {
    return trim( strip_tags( (string) $str ) );
}

function sanitize_key( $key ) {
    return strtolower( preg_replace( '/[^a-z0-9_\-]/i', '', (string) $key ) );
}

function esc_html( $text ) {
    return htmlspecialchars( (string) $text, ENT_QUOTES, 'UTF-8' );
}

function esc_html__( $text, $domain = 'default' ) {
    return esc_html( $text );
}

function esc_url( $url ) {
    return filter_var( $url, FILTER_SANITIZE_URL );
}

function admin_url( $path = '' ) {
    return 'https://example.com/wp-admin/' . ltrim( $path, '/' );
}

function plugin_basename( $file ) {
    return basename( $file );
}

function plugin_dir_path( $file ) {
    return dirname( $file ) . '/';
}

function plugins_url( $path = '', $plugin = '' ) {
    return 'https://example.com/wp-content/plugins/' . ltrim( $path, '/' );
}

function apply_filters( $hook, $value, ...$args ) {
    return $value;
}

function add_filter( $hook, $callback, $priority = 10, $accepted_args = 1 ) {
    return true;
}

function add_action( $hook, $callback, $priority = 10, $accepted_args = 1 ) {
    return true;
}

function __( $text, $domain = 'default' ) {
    return $text;
}

function get_woocommerce_currency() {
    return SlipPayTestRegistry::$currency;
}

function get_transient( $key ) {
    return SlipPayTestRegistry::$transients[ $key ] ?? false;
}

function set_transient( $key, $value, $expiration = 0 ) {
    SlipPayTestRegistry::$transients[ $key ] = $value;
    return true;
}

function wc_get_order( $id ) {
    return SlipPayTestRegistry::$orders[ $id ] ?? null;
}

function wc_get_orders( $args = [] ) {
    $results = [];
    $meta_key = $args['meta_key'] ?? null;
    $meta_val = $args['meta_value'] ?? null;

    foreach ( SlipPayTestRegistry::$orders as $order ) {
        if ( $meta_key !== null ) {
            if ( isset( $order->meta[ $meta_key ] ) && $order->meta[ $meta_key ] === $meta_val ) {
                $results[] = $order;
            }
        } else {
            $results[] = $order;
        }
    }
    return $results;
}

function wc_add_notice( $message, $type = 'error' ) {
    SlipPayTestRegistry::$notices[] = [ 'message' => $message, 'type' => $type ];
}

function trailingslashit( $string ) {
    return rtrim( $string, '/\\' ) . '/';
}

function wp_parse_url( $url ) {
    return parse_url( $url );
}

function is_wp_error( $thing ) {
    return $thing instanceof WP_Error;
}

function wp_remote_post( $url, $args = [] ) {
    if ( is_callable( SlipPayTestRegistry::$remotePostHandler ) ) {
        return call_user_func( SlipPayTestRegistry::$remotePostHandler, $url, $args );
    }
    return new WP_Error( 'http_not_mocked', 'Mock wp_remote_post handler not set' );
}

function wp_remote_retrieve_response_code( $response ) {
    if ( is_array( $response ) && isset( $response['response']['code'] ) ) {
        return (int) $response['response']['code'];
    }
    return 0;
}

function wp_remote_retrieve_body( $response ) {
    if ( is_array( $response ) && isset( $response['body'] ) ) {
        return (string) $response['body'];
    }
    return '';
}

// Load plugin classes
require_once dirname( __DIR__ ) . '/includes/class-wc-slippay-gateway.php';
require_once dirname( __DIR__ ) . '/includes/class-wc-slippay-webhook.php';
