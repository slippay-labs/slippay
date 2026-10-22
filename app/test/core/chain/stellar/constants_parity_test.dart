import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:slippay/core/chain/stellar/usdc.dart';

void main() {
  group('StellarConstants parity with Web adapter (apps/web/src/lib/chain/stellar/adapter.ts)', () {
    late String adapterTsContent;

    setUpAll(() {
      // Find the web adapter source file whether tests are run from app/ or the repo root.
      final candidates = [
        '../apps/web/src/lib/chain/stellar/adapter.ts',
        '../../apps/web/src/lib/chain/stellar/adapter.ts',
        'apps/web/src/lib/chain/stellar/adapter.ts',
      ];

      File? targetFile;
      for (final p in candidates) {
        final f = File(p);
        if (f.existsSync()) {
          targetFile = f;
          break;
        }
      }

      expect(
        targetFile,
        isNotNull,
        reason: 'apps/web/src/lib/chain/stellar/adapter.ts must exist for parity verification',
      );
      adapterTsContent = targetFile!.readAsStringSync();
    });

    test('USDC_ISSUER.TESTNET matches web adapter verbatim', () {
      final match = RegExp(r'TESTNET:\s*["' "'" r']([A-Z0-9]{56})["' "'" r']')
          .firstMatch(adapterTsContent);
      expect(match, isNotNull, reason: 'Failed to extract TESTNET USDC issuer from adapter.ts');
      final webTestnetIssuer = match!.group(1);

      expect(
        StellarConstants.usdcIssuer[StellarNetwork.testnet],
        equals(webTestnetIssuer),
        reason: 'Flutter testnet USDC issuer must match web adapter verbatim',
      );
    });

    test('USDC_ISSUER.PUBLIC matches web adapter verbatim', () {
      final match = RegExp(r'PUBLIC:\s*["' "'" r']([A-Z0-9]{56})["' "'" r']')
          .firstMatch(adapterTsContent);
      expect(match, isNotNull, reason: 'Failed to extract PUBLIC USDC issuer from adapter.ts');
      final webPublicIssuer = match!.group(1);

      expect(
        StellarConstants.usdcIssuer[StellarNetwork.public],
        equals(webPublicIssuer),
        reason: 'Flutter public/mainnet USDC issuer must match web adapter verbatim',
      );
    });

    test('SUB_CONTRACT fallback default matches web adapter verbatim', () {
      final match = RegExp(r'["' "'" r']([A-Z0-9]{56})["' "'" r']')
          .allMatches(adapterTsContent)
          .map((m) => m.group(1)!)
          .firstWhere(
            (val) => val.startsWith('C'),
            orElse: () => '',
          );

      expect(match, isNotEmpty, reason: 'Failed to extract subscription contract address from adapter.ts');
      expect(
        StellarConstants.subscriptionContractMainnet,
        equals(match),
        reason: 'Flutter subscriptionContractMainnet must match web adapter SUB_CONTRACT default',
      );
    });
  });
}
