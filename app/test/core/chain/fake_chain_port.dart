import 'package:slippay/core/chain/chain_port.dart';

/// Configurable Fake ChainPort for widget and unit tests without a network.
class FakeChainPort implements ChainPort {
  FakeChainPort({
    this.id = ChainId.stellar,
    this.walletAddress = 'C_FAKE_WALLET_ADDRESS',
    this.validFormat = true,
    this.accountExists = true,
    this.hasUsdcTrustline = true,
    this.oneTimePayResult = const PayResult('0000000000000000000000000000000000000000000000000000000000000001'),
    this.approveResult = const PayResult('0000000000000000000000000000000000000000000000000000000000000002'),
    this.shouldThrowOnPay = false,
    this.shouldThrowOnApprove = false,
  });

  @override
  final ChainId id;
  final String walletAddress;

  bool validFormat;
  bool? accountExists;
  bool? hasUsdcTrustline;

  PayResult oneTimePayResult;
  PayResult approveResult;

  bool shouldThrowOnPay;
  bool shouldThrowOnApprove;

  int checkCalls = 0;
  String? lastCheckedAddress;

  int payCalls = 0;
  OneTimePayArgs? lastPayArgs;

  int approveCalls = 0;
  ApproveArgs? lastApproveArgs;

  @override
  Future<String> connectWallet() async => walletAddress;

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
  Future<PayResult> payOneTime(OneTimePayArgs args) async {
    payCalls++;
    lastPayArgs = args;
    if (shouldThrowOnPay) {
      throw StateError('Simulated payOneTime failure');
    }
    return oneTimePayResult;
  }

  @override
  Future<PayResult> approveRecurring(ApproveArgs args) async {
    approveCalls++;
    lastApproveArgs = args;
    if (shouldThrowOnApprove) {
      throw StateError('Simulated approveRecurring failure');
    }
    return approveResult;
  }
}
