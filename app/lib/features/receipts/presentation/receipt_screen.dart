import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/config/app_config.dart';
import '../../../core/theme/app_theme.dart';

/// On-chain receipt for a settled payment. Mirrors web Comprovante.tsx. The tx
/// hash links to the public explorer: the proof is the chain, not our word.
class ReceiptScreen extends StatelessWidget {
  const ReceiptScreen({required this.txHash, super.key});

  final String txHash;

  /// Public getter for explorer URL, matching the exact format for the configured network.
  String get explorerUrl {
    final net = AppConfig.stellarNetwork == 'PUBLIC' ? 'public' : 'testnet';
    return 'https://stellar.expert/explorer/$net/tx/$txHash';
  }

  String get _explorerUrl => explorerUrl;

  Future<void> _openExplorer(BuildContext context) async {
    final uri = Uri.parse(_explorerUrl);
    bool launched = false;
    try {
      if (await canLaunchUrl(uri)) {
        launched = await launchUrl(
          uri,
          mode: LaunchMode.externalApplication,
        );
      }
    } catch (_) {
      launched = false;
    }

    if (!launched && context.mounted) {
      await _copyHashFallback(context);
    }
  }

  Future<void> _copyHashFallback(BuildContext context) async {
    await Clipboard.setData(ClipboardData(text: txHash));
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Hash copiado para a área de transferência'),
          duration: Duration(seconds: 3),
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        backgroundColor: AppColors.bone,
        elevation: 0,
        title: const Text('Comprovante', style: TextStyle(color: AppColors.ink)),
      ),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              const SizedBox(height: 24),
              const Icon(Icons.check_circle, size: 72, color: AppColors.ok),
              const SizedBox(height: 16),
              const Text(
                'Pago.',
                style: TextStyle(fontSize: 32, fontWeight: FontWeight.w900, color: AppColors.ink),
              ),
              const SizedBox(height: 8),
              const Text(
                'Confirmado on-chain. Verificável por qualquer um.',
                style: TextStyle(fontSize: 15, color: AppColors.gray),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 32),
              _hashField(context, 'TX HASH', txHash),
              const Spacer(),
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: () => _openExplorer(context),
                  icon: const Icon(Icons.open_in_new, size: 16),
                  label: const Text('VER NO EXPLORER'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _hashField(BuildContext context, String label, String value) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
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
              const Spacer(),
              InkWell(
                onTap: () => _openExplorer(context),
                borderRadius: BorderRadius.circular(4),
                child: const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 4, vertical: 2),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        'ver na Stellar',
                        style: TextStyle(
                          fontSize: 11,
                          color: AppColors.ink,
                          decoration: TextDecoration.underline,
                        ),
                      ),
                      SizedBox(width: 2),
                      Icon(Icons.open_in_new, size: 12, color: AppColors.ink),
                    ],
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          InkWell(
            onTap: () => _openExplorer(context),
            child: SelectableText(
              value,
              onTap: () => _openExplorer(context),
              style: const TextStyle(
                fontFamily: 'monospace',
                fontSize: 12,
                color: AppColors.ink,
                decoration: TextDecoration.underline,
              ),
            ),
          ),
        ],
      );
}
