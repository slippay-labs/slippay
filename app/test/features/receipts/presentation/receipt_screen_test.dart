import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:slippay/features/receipts/presentation/receipt_screen.dart';

void main() {
  const sampleTxHash = 'a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0';

  group('ReceiptScreen explorerUrl calculation', () {
    test('computes exact explorer URL matching the active network and hash without reformatting', () {
      const screen = ReceiptScreen(txHash: sampleTxHash);
      final url = screen.explorerUrl;

      expect(url.startsWith('https://stellar.expert/explorer/'), isTrue);
      expect(url.endsWith('/tx/$sampleTxHash'), isTrue);
      expect(url.contains('//'), isTrue);
      expect(url, equals('https://stellar.expert/explorer/testnet/tx/$sampleTxHash'));
    });
  });

  group('ReceiptScreen Widget presentation and affordances', () {
    testWidgets('renders confirmation, selectable hash, ver na Stellar link and explorer button',
        (tester) async {
      await tester.pumpWidget(
        const MaterialApp(
          home: ReceiptScreen(txHash: sampleTxHash),
        ),
      );

      // Verify header and status text
      expect(find.text('Comprovante'), findsOneWidget);
      expect(find.text('Pago.'), findsOneWidget);
      expect(find.text('Confirmado on-chain. Verificável por qualquer um.'), findsOneWidget);

      // Verify TX HASH label and selectable text
      expect(find.text('TX HASH'), findsOneWidget);
      expect(find.text(sampleTxHash), findsOneWidget);

      // Verify the 'ver na Stellar' affordance
      expect(find.text('ver na Stellar'), findsOneWidget);

      // Verify the primary action button
      expect(find.text('VER NO EXPLORER'), findsOneWidget);
      expect(find.byType(FilledButton), findsOneWidget);
    });

    testWidgets('tapping VER NO EXPLORER or hash triggers explorer launch without crashing',
        (tester) async {
      await tester.pumpWidget(
        const MaterialApp(
          home: ReceiptScreen(txHash: sampleTxHash),
        ),
      );

      // Tap the action button
      await tester.tap(find.text('VER NO EXPLORER'));
      await tester.pumpAndSettle();

      // Tap the hash affordance
      await tester.tap(find.text('ver na Stellar'));
      await tester.pumpAndSettle();

      // Verify screen remains intact and stable
      expect(find.text('Pago.'), findsOneWidget);
    });
  });
}
