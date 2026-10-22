import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../../core/chain/chain_port.dart';
import '../../../core/chain/chain_provider.dart';
import '../../../core/config/app_config.dart';
import '../../../core/theme/app_theme.dart';
import '../domain/parsed_payment_payload.dart';

/// Pay: scan a QR, then a TRUSTED confirm sheet shows the decoded recipient +
/// amount (the WebAuthn assertion proves presence, NOT intent, so OUR app must
/// render the intent), then biometric sign -> fee-bump -> submit. The signing
/// path is stubbed until the chain adapter is wired; the scan + confirm UI is real.
class PayScreen extends ConsumerStatefulWidget {
  const PayScreen({
    this.chainPort,
    this.expectedMerchantAddress,
    super.key,
  });

  /// Optional ChainPort override for testing/mocking.
  final ChainPort? chainPort;

  /// Optional committed merchant recipient address to guard against recipient drift.
  final String? expectedMerchantAddress;

  @override
  ConsumerState<PayScreen> createState() => _PayScreenState();
}

class _PayScreenState extends ConsumerState<PayScreen> {
  String? _scanned;
  bool _handled = false;

  void _onDetect(BarcodeCapture capture) {
    if (_handled) return;
    final raw = capture.barcodes.firstOrNull?.rawValue;
    if (raw == null) return;
    _handlePayload(raw);
  }

  Future<void> _handlePayload(String raw) async {
    setState(() {
      _handled = true;
      _scanned = raw;
    });

    final parsed = parsePaymentPayload(raw);
    if (parsed == null) {
      if (mounted) {
        _showError('QR Code inválido: formato de pagamento não reconhecido');
        setState(() => _handled = false);
      }
      return;
    }

    // Recipient-redirection guard: compare against merchant's committed address
    if (widget.expectedMerchantAddress != null &&
        parsed.recipient.toUpperCase() != widget.expectedMerchantAddress!.toUpperCase()) {
      if (mounted) {
        _showError('Atenção: o destinatário do pagamento mudou e não confere com o comerciante esperado.');
        setState(() => _handled = false);
      }
      return;
    }

    // Network & receive guard: verify address on-chain before showing confirmation
    final port = widget.chainPort ?? ref.read(chainPortProvider);
    final check = await port.checkReceiveAddress(parsed.recipient);

    if (!check.validFormat) {
      if (mounted) {
        _showError('Endereço de destino inválido');
        setState(() => _handled = false);
      }
      return;
    }

    if (check.accountExists == false) {
      if (mounted) {
        _showError('Conta de destino não existe na rede.');
        setState(() => _handled = false);
      }
      return;
    }

    if (check.hasUsdcTrustline == false) {
      if (mounted) {
        _showError('Conta de destino não possui linha de confiança (trustline) USDC.');
        setState(() => _handled = false);
      }
      return;
    }

    if (!mounted) return;
    await _showConfirm(parsed);
    if (mounted) setState(() => _handled = false);
  }

  void _showError(String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: AppColors.leak,
        duration: const Duration(seconds: 4),
      ),
    );
  }

  String _truncate(String s, [int head = 8, int tail = 8]) {
    if (s.length <= head + tail + 1) return s;
    return '${s.substring(0, head)}…${s.substring(s.length - tail)}';
  }

  Future<void> _showConfirm(ParsedPaymentPayload parsed) async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.bone,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'CONFIRME O PAGAMENTO',
              style: TextStyle(
                fontFamily: 'monospace',
                fontSize: 10,
                letterSpacing: 2,
                color: AppColors.gray,
              ),
            ),
            const SizedBox(height: 16),
            const Text(
              'Verifique os detalhes antes de assinar',
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: AppColors.ink),
            ),
            const SizedBox(height: 20),

            // Discrete fields: recipient
            _fieldRow(
              label: 'DESTINATÁRIO',
              value: parsed.recipient,
              displayValue: _truncate(parsed.recipient),
              copyable: true,
            ),
            const SizedBox(height: 14),

            // Discrete fields: amount & asset
            _fieldRow(
              label: 'VALOR',
              value: parsed.amount != null
                  ? '\$${parsed.amount!.toHuman()} ${parsed.asset}'
                  : 'Valor aberto (${parsed.asset})',
            ),
            const SizedBox(height: 14),

            // Discrete fields: asset & network
            _fieldRow(
              label: 'ATIVO / REDE',
              value: '${parsed.asset} · ${parsed.network ?? AppConfig.stellarNetwork}',
            ),
            const SizedBox(height: 16),

            // Raw payload kept behind a disclosure for support
            Theme(
              data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
              child: ExpansionTile(
                tilePadding: EdgeInsets.zero,
                childrenPadding: const EdgeInsets.only(top: 4, bottom: 12),
                title: const Text(
                  'Ver payload original (suporte)',
                  style: TextStyle(
                    fontFamily: 'monospace',
                    fontSize: 10,
                    letterSpacing: 1.2,
                    color: AppColors.gray,
                  ),
                ),
                children: [
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: Colors.black.withOpacity(0.04),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: SelectableText(
                      parsed.rawPayload,
                      style: const TextStyle(
                        fontFamily: 'monospace',
                        fontSize: 11,
                        color: AppColors.gray,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),

            SizedBox(
              width: double.infinity,
              child: FilledButton(
                onPressed: () {
                  Navigator.of(context).pop();
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('assinatura on-chain: pendente do chain adapter')),
                  );
                },
                child: const Text('AUTORIZAR COM A BIOMETRIA'),
              ),
            ),
            const SizedBox(height: 8),
            Center(
              child: TextButton(
                onPressed: () {
                  Navigator.of(context).pop();
                },
                child: const Text('cancelar', style: TextStyle(color: AppColors.gray)),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _fieldRow({
    required String label,
    required String value,
    String? displayValue,
    bool copyable = false,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(
            fontFamily: 'monospace',
            fontSize: 10,
            letterSpacing: 2,
            color: AppColors.gray,
          ),
        ),
        const SizedBox(height: 4),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Expanded(
              child: SelectableText(
                displayValue ?? value,
                style: const TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                  color: AppColors.ink,
                ),
              ),
            ),
            if (copyable)
              IconButton(
                icon: const Icon(Icons.copy, size: 16, color: AppColors.gray),
                tooltip: 'Copiar endereço completo',
                padding: EdgeInsets.zero,
                constraints: const BoxConstraints(),
                onPressed: () async {
                  await Clipboard.setData(ClipboardData(text: value));
                  if (mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(
                        content: Text('Endereço copiado!'),
                        duration: Duration(seconds: 2),
                      ),
                    );
                  }
                },
              ),
          ],
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        backgroundColor: AppColors.bone,
        elevation: 0,
        title: const Text('Pagar', style: TextStyle(color: AppColors.ink)),
      ),
      body: Stack(
        children: [
          MobileScanner(onDetect: _onDetect),
          Positioned(
            bottom: 40,
            left: 0,
            right: 0,
            child: Text(
              _scanned == null ? 'aponte pra um QR de pagamento' : 'lido',
              textAlign: TextAlign.center,
              style: const TextStyle(color: Colors.white, fontSize: 14),
            ),
          ),
        ],
      ),
    );
  }
}
