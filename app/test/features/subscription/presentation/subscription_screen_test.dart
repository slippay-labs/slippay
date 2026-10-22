import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:slippay/features/subscription/presentation/subscription_screen.dart';

void main() {
  group('SubscriptionScreen decision points and validation', () {
    testWidgets('renders initial UI with default cap 12.00 and authorization button',
        (tester) async {
      await tester.pumpWidget(
        const ProviderScope(
          child: MaterialApp(
            home: SubscriptionScreen(),
          ),
        ),
      );

      expect(find.text('Autorização recorrente'), findsOneWidget);
      expect(find.text('LIMITE MENSAL · USDC'), findsOneWidget);
      expect(find.text('12.00'), findsOneWidget);
      expect(find.text('AUTORIZAR COM A BIOMETRIA'), findsOneWidget);
    });

    testWidgets('rejects zero cap and displays error message', (tester) async {
      await tester.pumpWidget(
        const ProviderScope(
          child: MaterialApp(
            home: SubscriptionScreen(),
          ),
        ),
      );

      final textField = find.byType(TextField);
      await tester.enterText(textField, '0.00');
      await tester.tap(find.text('AUTORIZAR COM A BIOMETRIA'));
      await tester.pump();

      expect(find.text('defina um limite maior que zero'), findsOneWidget);
    });

    testWidgets('rejects non-numeric or malformed cap and displays valor inválido', (tester) async {
      await tester.pumpWidget(
        const ProviderScope(
          child: MaterialApp(
            home: SubscriptionScreen(),
          ),
        ),
      );

      final textField = find.byType(TextField);
      await tester.enterText(textField, 'abc');
      await tester.tap(find.text('AUTORIZAR COM A BIOMETRIA'));
      await tester.pump();

      expect(find.text('valor inválido'), findsOneWidget);
    });

    testWidgets('accepts valid non-zero cap and proceeds to authorization feedback', (tester) async {
      await tester.pumpWidget(
        const ProviderScope(
          child: MaterialApp(
            home: SubscriptionScreen(),
          ),
        ),
      );

      final textField = find.byType(TextField);
      await tester.enterText(textField, '25.50');
      await tester.tap(find.text('AUTORIZAR COM A BIOMETRIA'));
      await tester.pump();

      // No error text should be displayed on the input
      expect(find.text('defina um limite maior que zero'), findsNothing);
      expect(find.text('valor inválido'), findsNothing);

      // Verify SnackBar feedback with the formatted cap
      expect(find.textContaining('autorizar até \$25.50'), findsOneWidget);
    });
  });
}
