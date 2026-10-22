import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'chain_port.dart';

/// In-memory dev/stub implementation of ChainPort.
class StubChainPort implements ChainPort {
  const StubChainPort({
    this.id = ChainId.stellar,
    this.walletAddress = 'C_MANDATE_DEV_ACCOUNT',
  });

  @override
  final ChainId id;
  final String walletAddress;

  @override
  Future<String> connectWallet() async => walletAddress;

  @override
  bool isValidAddress(String address) => address.startsWith('G') || address.startsWith('C');

  @override
  Future<AddressCheck> checkReceiveAddress(String address) async => const AddressCheck(
        validFormat: true,
        accountExists: true,
        hasUsdcTrustline: true,
      );

  @override
  Future<PayResult> payOneTime(OneTimePayArgs args) async =>
      const PayResult('0000000000000000000000000000000000000000000000000000000000000001');

  @override
  Future<PayResult> approveRecurring(ApproveArgs args) async =>
      const PayResult('0000000000000000000000000000000000000000000000000000000000000002');
}

/// Provider for the active chain adapter.
final chainPortProvider = Provider<ChainPort>((ref) {
  return const StubChainPort();
});
