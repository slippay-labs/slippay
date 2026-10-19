import 'dart:convert';

import '../../../core/money/usdc_amount.dart';

/// Parsed, structured on-chain payment intent decoded from a scanned QR payload.
/// Protects against what-you-see-is-what-you-sign (WYSIWYS) blind signing attacks.
class ParsedPaymentPayload {
  const ParsedPaymentPayload({
    required this.recipient,
    this.amount,
    this.asset = 'USDC',
    this.network,
    this.rawPayload = '',
  });

  /// Validated destination address (Stellar G.../C... or EVM 0x...).
  final String recipient;

  /// Human or exact minor amount (null if open-ended payment).
  final UsdcAmount? amount;

  /// Asset ticker (defaults to USDC).
  final String asset;

  /// Target network name if encoded or inferred.
  final String? network;

  /// The raw scanned string kept for support/debugging disclosure.
  final String rawPayload;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ParsedPaymentPayload &&
          runtimeType == other.runtimeType &&
          recipient == other.recipient &&
          amount == other.amount &&
          asset == other.asset &&
          network == other.network;

  @override
  int get hashCode => Object.hash(recipient, amount, asset, network);
}

bool _isValidStellarAddress(String s) {
  if (s.length != 56) return false;
  final prefix = s[0];
  if (prefix != 'G' && prefix != 'C') return false;
  return RegExp(r'^[A-Z2-7]{56}$').hasMatch(s);
}

bool _isValidEvmAddress(String s) {
  if (s.length != 42) return false;
  if (!s.startsWith('0x') && !s.startsWith('0X')) return false;
  return RegExp(r'^0x[0-9a-fA-F]{40}$').hasMatch(s);
}

bool _isValidAddress(String s) => _isValidStellarAddress(s) || _isValidEvmAddress(s);

/// Parses a scanned QR payload into a structured [ParsedPaymentPayload].
///
/// Accepts:
/// - Bare address: Stellar (G... / C...) or EVM (0x...)
/// - SEP-0007 / Stellar URI: `web+stellar:pay?destination=G...&amount=12.50&asset_code=USDC`
/// - Slippay URI: `slippay:pay?to=G...&amount=10&asset=USDC`
/// - EIP-681 Base/Ethereum transfer: `ethereum:0xTOKEN@8453/transfer?address=0xRECIP&uint256=1000000`
/// - JSON format: `{"to": "G...", "amount": "12.50", "asset": "USDC"}`
/// - Query string: `to=G...&amount=12.50`
///
/// Returns `null` if the payload cannot be parsed or lacks a valid recipient address.
ParsedPaymentPayload? parsePaymentPayload(String raw) {
  final text = raw.trim();
  if (text.isEmpty) return null;

  // 1) Bare address (Stellar G... / C... or EVM 0x...)
  if (_isValidAddress(text)) {
    return ParsedPaymentPayload(
      recipient: text,
      asset: 'USDC',
      rawPayload: text,
    );
  }

  // 2) JSON payload
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      final map = jsonDecode(text);
      if (map is Map<String, dynamic>) {
        final to = (map['to'] ?? map['destination'] ?? map['recipient'] ?? map['address'])?.toString();
        if (to != null && _isValidAddress(to)) {
          final amtStr = (map['amount'] ?? map['amountUsdc'])?.toString();
          final asset = (map['asset'] ?? map['asset_code'] ?? 'USDC').toString().toUpperCase();
          UsdcAmount? amount;
          if (amtStr != null) {
            try {
              amount = UsdcAmount.parse(amtStr);
            } catch (_) {}
          }
          return ParsedPaymentPayload(
            recipient: to,
            amount: amount,
            asset: asset,
            rawPayload: text,
          );
        }
      }
    } catch (_) {}
  }

  // 3) URI schemes
  final uri = Uri.tryParse(text);
  if (uri != null && uri.hasScheme) {
    final scheme = uri.scheme.toLowerCase();

    // 3a) web+stellar: or stellar:
    if (scheme == 'web+stellar' || scheme == 'stellar') {
      final params = uri.queryParameters;
      final dest = params['destination'] ?? params['to'] ?? uri.path;
      if (dest.isNotEmpty && _isValidAddress(dest)) {
        final amtStr = params['amount'];
        final asset = (params['asset_code'] ?? params['asset'] ?? 'USDC').toUpperCase();
        UsdcAmount? amount;
        if (amtStr != null) {
          try {
            amount = UsdcAmount.parse(amtStr);
          } catch (_) {}
        }
        return ParsedPaymentPayload(
          recipient: dest,
          amount: amount,
          asset: asset,
          network: 'Stellar',
          rawPayload: text,
        );
      }
    }

    // 3b) slippay:
    if (scheme == 'slippay') {
      final params = uri.queryParameters;
      final dest = params['to'] ?? params['destination'] ?? params['recipient'] ?? uri.path;
      if (dest.isNotEmpty && _isValidAddress(dest)) {
        final amtStr = params['amount'];
        final asset = (params['asset'] ?? 'USDC').toUpperCase();
        UsdcAmount? amount;
        if (amtStr != null) {
          try {
            amount = UsdcAmount.parse(amtStr);
          } catch (_) {}
        }
        return ParsedPaymentPayload(
          recipient: dest,
          amount: amount,
          asset: asset,
          rawPayload: text,
        );
      }
    }

    // 3c) ethereum: (EIP-681)
    if (scheme == 'ethereum') {
      final body = text.substring('ethereum:'.length);
      final qIndex = body.indexOf('?');
      final pathPart = qIndex >= 0 ? body.substring(0, qIndex) : body;
      final queryPart = qIndex >= 0 ? body.substring(qIndex + 1) : '';
      final params = Uri.splitQueryString(queryPart);
      final target = (pathPart.split('@').first).split('/').first;

      if (pathPart.contains('/transfer')) {
        final recip = params['address'];
        if (recip != null && _isValidEvmAddress(recip)) {
          final units = params['uint256'] ?? params['amount'];
          UsdcAmount? amount;
          if (units != null && RegExp(r'^\d+$').hasMatch(units)) {
            // EVM USDC has 6 decimals, UsdcAmount is 7 decimals: multiply by 10
            final bi = BigInt.parse(units);
            amount = UsdcAmount(minor: bi * BigInt.from(10));
          }
          return ParsedPaymentPayload(
            recipient: recip,
            amount: amount,
            asset: 'USDC',
            network: 'Base',
            rawPayload: text,
          );
        }
        return null;
      }

      if (_isValidEvmAddress(target)) {
        return ParsedPaymentPayload(
          recipient: target,
          asset: 'USDC',
          network: 'Ethereum',
          rawPayload: text,
        );
      }
    }
  }

  // 4) Key-value pairs (e.g. "to=G...&amount=10.00&asset=USDC")
  if (text.contains('to=') || text.contains('destination=')) {
    try {
      final params = Uri.splitQueryString(text);
      final to = params['to'] ?? params['destination'] ?? params['recipient'];
      if (to != null && _isValidAddress(to)) {
        final amtStr = params['amount'];
        final asset = (params['asset'] ?? params['asset_code'] ?? 'USDC').toUpperCase();
        UsdcAmount? amount;
        if (amtStr != null) {
          try {
            amount = UsdcAmount.parse(amtStr);
          } catch (_) {}
        }
        return ParsedPaymentPayload(
          recipient: to,
          amount: amount,
          asset: asset,
          rawPayload: text,
        );
      }
    } catch (_) {}
  }

  return null;
}
