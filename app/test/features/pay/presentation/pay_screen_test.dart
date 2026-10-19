import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:slippay/core/chain/chain_port.dart';
import 'package:slippay/features/pay/presentation/pay_screen.dart';

class MockChainPort implements ChainPort {
  MockChainPort({
    this.validFormat = true,
    this.accountExists = true,
    this.hasUsdcTrustline = true,
  });

  final bool validFormat;
  final bool? accountExists;
  final bool? hasUsdcTrustline;
  int checkCalls = 0;
  String? lastCheckedAddress;

  @override
  ChainId get id => ChainId.stellar;

  @override
  Future<String> connectWallet() async => 'C_WALLET';

  @override
  bool isValidAddress(String address) => validFormat;

  @override
  Future<AddressCheck> checkReceiveAddress(String address) async {
    checkCalls++;
    lastCheckedAddress = address;
    return AddressCheck(
      validFormat: validFormat,
      accountExists: accountExists,
      hasUsdcTrustline: hasUsdcTrustline,
    );
  }

  @override
  Future<PayResult> payOneTime(OneTimePayArgs args) async => const PayResult('tx_one_time');

  @override
  Future<PayResult> approveRecurring(ApproveArgs args) async => const PayResult('tx_approve');
}

void main() {
  const merchantA = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
  const attackerB = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

  group('PayScreen Scanned Payload Guard and Confirmation', () {
    testWidgets('renders camera scanner view and idle hint', (tester) async {
      await tester.pumpWidget(
        const ProviderScope(
          child: MaterialApp(
            home: PayScreen(),
          ),
        ),
      );

      expect(find.text('Pagar'), findsOneWidget);
      expect(find.byType(MobileScanner), findsOneWidget);
      expect(find.text('aponte pra um QR de pagamento'), findsOneWidget);
    });

    testWidgets('rejects malformed payload without opening confirmation sheet', (tester) async {
      final mock = MockChainPort();
      await tester.pumpWidget(
        ProviderScope(
          child: MaterialApp(
            home: PayScreen(chainPort: mock),
          ),
        ),
      );

      final scanner = tester.widget<MobileScanner>(find.byType(MobileScanner));
      scanner.onDetect?.call(
        const BarcodeCapture(
          barcodes: [
            Barcode(rawValue: 'invalid_malformed_qr_payload'),
          ],
        ),
      );

      await tester.pumpAndSettle();

      // Confirmation sheet must NEVER open on malformed input
      expect(find.text('CONFIRME O PAGAMENTO'), findsNothing);
      expect(find.text('QR Code inválido: formato de pagamento não reconhecido'), findsOneWidget);
      expect(mock.checkCalls, 0);
    });

    testWidgets('blocks payment and alerts when recipient drifts from expected merchant address', (tester) async {
      final mock = MockChainPort();
      await tester.pumpWidget(
        ProviderScope(
          child: MaterialApp(
            home: PayScreen(
              chainPort: mock,
              expectedMerchantAddress: merchantA,
            ),
          ),
        ),
      );

      // Scanned payload substitutes recipient with attackerB
      final scanner = tester.widget<MobileScanner>(find.byType(MobileScanner));
      scanner.onDetect?.call(
        const BarcodeCapture(
          barcodes: [
            Barcode(rawValue: 'slippay:pay?to=$attackerB&amount=10.00'),
          ],
        ),
      );

      await tester.pumpAndSettle();

      expect(find.text('CONFIRME O PAGAMENTO'), findsNothing);
      expect(
        find.text('Atenção: o destinatário do pagamento mudou e não confere com o comerciante esperado.'),
        findsOneWidget,
      );
    });

    testWidgets('blocks payment when destination address has no USDC trustline', (tester) async {
      final mock = MockChainPort(hasUsdcTrustline: false);
      await tester.pumpWidget(
        ProviderScope(
          child: MaterialApp(
            home: PayScreen(chainPort: mock),
          ),
        ),
      );

      final scanner = tester.widget<MobileScanner>(find.byType(MobileScanner));
      scanner.onDetect?.call(
        const BarcodeCapture(
          barcodes: [
            Barcode(rawValue: merchantA),
          ],
        ),
      );

      await tester.pumpAndSettle();

      expect(find.text('CONFIRME O PAGAMENTO'), findsNothing);
      expect(
        find.text('Conta de destino não possui linha de confiança (trustline) USDC.'),
        findsOneWidget,
      );
    });

    testWidgets('opens confirmation sheet and displays discrete fields for valid payload', (tester) async {
      final mock = MockChainPort();
      await tester.pumpWidget(
        ProviderScope(
          child: MaterialApp(
            home: PayScreen(
              chainPort: mock,
              expectedMerchantAddress: merchantA,
            ),
          ),
        ),
      );

      final scanner = tester.widget<MobileScanner>(find.byType(MobileScanner));
      scanner.onDetect?.call(
        const BarcodeCapture(
          barcodes: [
            Barcode(rawValue: 'slippay:pay?to=$merchantA&amount=35.00&asset=USDC'),
          ],
        ),
      );

      await tester.pumpAndSettle();

      // Sheet is visible
      expect(find.text('CONFIRME O PAGAMENTO'), findsOneWidget);
      expect(find.text('DESTINATÁRIO'), findsOneWidget);
      expect(find.text('VALOR'), findsOneWidget);
      expect(find.text('\$35.00 USDC'), findsOneWidget);
      expect(find.text('ATIVO / REDE'), findsOneWidget);

      // Raw payload is behind disclosure
      expect(find.text('Ver payload original (suporte)'), findsOneWidget);
      expect(find.text('AUTORIZAR COM A BIOMETRIA'), findsOneWidget);
    });
  });
}
