import 'package:flutter_test/flutter_test.dart';
import 'package:slippay/core/chain/stellar/usdc.dart';

void main() {
  group('StellarConstants', () {
    test('defines exact Circle USDC issuer per network', () {
      expect(
        StellarConstants.usdcIssuer[StellarNetwork.testnet],
        equals('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'),
      );
      expect(
        StellarConstants.usdcIssuer[StellarNetwork.public],
        equals('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'),
      );
    });

    test('defines exact subscription contract mainnet address', () {
      expect(
        StellarConstants.subscriptionContractMainnet,
        equals('CBJMQ6ZYQJ2OMM46FGXPEIKKZDRHHERBXUVE54ZN64FDPKN5DJKSEVQN'),
      );
    });

    test('assetCode is USDC', () {
      expect(StellarConstants.assetCode, equals('USDC'));
    });

    test('passphrase returns standard network passphrases', () {
      expect(
        StellarConstants.passphrase(StellarNetwork.public),
        equals('Public Global Stellar Network ; September 2015'),
      );
      expect(
        StellarConstants.passphrase(StellarNetwork.testnet),
        equals('Test SDF Network ; September 2015'),
      );
    });

    group('networkFromString', () {
      test('maps valid strings to StellarNetwork enum (case-insensitive)', () {
        expect(StellarConstants.networkFromString('PUBLIC'), equals(StellarNetwork.public));
        expect(StellarConstants.networkFromString('public'), equals(StellarNetwork.public));
        expect(StellarConstants.networkFromString('Public'), equals(StellarNetwork.public));

        expect(StellarConstants.networkFromString('TESTNET'), equals(StellarNetwork.testnet));
        expect(StellarConstants.networkFromString('testnet'), equals(StellarNetwork.testnet));
        expect(StellarConstants.networkFromString('Testnet'), equals(StellarNetwork.testnet));
      });

      test('rejects unexpected or unrecognised values rather than silently defaulting to testnet', () {
        expect(() => StellarConstants.networkFromString('mainnet'), throwsArgumentError);
        expect(() => StellarConstants.networkFromString('PRIVATE'), throwsArgumentError);
        expect(() => StellarConstants.networkFromString(''), throwsArgumentError);
        expect(() => StellarConstants.networkFromString('stellar'), throwsArgumentError);
        expect(() => StellarConstants.networkFromString('localhost'), throwsArgumentError);
      });
    });
  });
}
