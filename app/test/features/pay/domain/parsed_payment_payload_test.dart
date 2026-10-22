import 'package:flutter_test/flutter_test.dart';
import 'package:slippay/core/money/usdc_amount.dart';
import 'package:slippay/features/pay/domain/parsed_payment_payload.dart';

void main() {
  const stellarMerchant = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
  const contractRecipient = 'CBJMQ6ZYQJ2OMM46FGXPEIKKZDRHHERBXUVE54ZN64FDPKN5DJKSEVQN';
  const evmRecipient = '0x25d5dCDACFd88Cc902E707823d3c88f584491fF0';
  const evmToken = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

  group('parsePaymentPayload', () {
    test('parses a bare Stellar account address', () {
      final parsed = parsePaymentPayload(stellarMerchant);
      expect(parsed, isNotNull);
      expect(parsed!.recipient, stellarMerchant);
      expect(parsed.amount, isNull);
      expect(parsed.asset, 'USDC');
    });

    test('parses a bare Soroban contract address', () {
      final parsed = parsePaymentPayload(contractRecipient);
      expect(parsed, isNotNull);
      expect(parsed!.recipient, contractRecipient);
      expect(parsed.amount, isNull);
    });

    test('parses a bare EVM address', () {
      final parsed = parsePaymentPayload(evmRecipient);
      expect(parsed, isNotNull);
      expect(parsed!.recipient, evmRecipient);
      expect(parsed.asset, 'USDC');
    });

    test('trims surrounding whitespace on bare address', () {
      final parsed = parsePaymentPayload('   $stellarMerchant   ');
      expect(parsed, isNotNull);
      expect(parsed!.recipient, stellarMerchant);
    });

    test('parses SEP-0007 / web+stellar payment URI with amount and asset', () {
      final uri = 'web+stellar:pay?destination=$stellarMerchant&amount=15.50&asset_code=USDC';
      final parsed = parsePaymentPayload(uri);
      expect(parsed, isNotNull);
      expect(parsed!.recipient, stellarMerchant);
      expect(parsed.amount, UsdcAmount.parse('15.50'));
      expect(parsed.asset, 'USDC');
      expect(parsed.network, 'Stellar');
    });

    test('parses slippay scheme URI', () {
      final uri = 'slippay:pay?to=$stellarMerchant&amount=42.00';
      final parsed = parsePaymentPayload(uri);
      expect(parsed, isNotNull);
      expect(parsed!.recipient, stellarMerchant);
      expect(parsed.amount, UsdcAmount.parse('42.00'));
      expect(parsed.asset, 'USDC');
    });

    test('parses structured JSON payment payload', () {
      final json = '{"to": "$stellarMerchant", "amount": "9.99", "asset": "USDC"}';
      final parsed = parsePaymentPayload(json);
      expect(parsed, isNotNull);
      expect(parsed!.recipient, stellarMerchant);
      expect(parsed.amount, UsdcAmount.parse('9.99'));
      expect(parsed.asset, 'USDC');
    });

    test('parses query string key-value payload', () {
      final kv = 'to=$stellarMerchant&amount=100.00&asset=USDC';
      final parsed = parsePaymentPayload(kv);
      expect(parsed, isNotNull);
      expect(parsed!.recipient, stellarMerchant);
      expect(parsed.amount, UsdcAmount.parse('100.00'));
    });

    test('parses EIP-681 ERC-20 transfer URI with uint256 units', () {
      final uri = 'ethereum:$evmToken@8453/transfer?address=$evmRecipient&uint256=1830000';
      final parsed = parsePaymentPayload(uri);
      expect(parsed, isNotNull);
      expect(parsed!.recipient, evmRecipient);
      expect(parsed.amount, UsdcAmount.parse('1.83'));
      expect(parsed.network, 'Base');
    });

    test('rejects empty or whitespace input', () {
      expect(parsePaymentPayload(''), isNull);
      expect(parsePaymentPayload('    '), isNull);
    });

    test('rejects arbitrary text / malformed address', () {
      expect(parsePaymentPayload('hello world'), isNull);
      expect(parsePaymentPayload('https://slippay.cc/random'), isNull);
      expect(parsePaymentPayload('0x1234'), isNull);
      expect(parsePaymentPayload('G_TOO_SHORT'), isNull);
    });

    test('rejects transfer URI without a valid recipient', () {
      expect(parsePaymentPayload('ethereum:$evmToken@8453/transfer?uint256=1000000'), isNull);
    });
  });
}
