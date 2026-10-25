import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  Address, Asset, Keypair, nativeToScVal, Operation, TransactionBuilder,
  xdr, BASE_FEE, Networks,
} from "npm:@stellar/stellar-sdk@13";
import { getAllowedSacContracts, validateSponsorable } from "../routes/relayer.ts";

const toB = (u: Uint8Array): any => u;

Deno.test("getAllowedSacContracts includes native SAC and configured USDC", () => {
  const nativeSac = Asset.native().contractId(Networks.TESTNET);
  const defaultAllowed = getAllowedSacContracts(Networks.TESTNET);
  assertEquals(defaultAllowed.includes(nativeSac), true);

  const mockUsdc = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
  Deno.env.set("RELAYER_USDC_CONTRACT", mockUsdc);
  const withUsdc = getAllowedSacContracts(Networks.TESTNET);
  assertEquals(withUsdc.includes(mockUsdc), true);
  Deno.env.delete("RELAYER_USDC_CONTRACT");
});

Deno.test("validateSponsorable accepts sponsored transfer on native SAC within amount cap", () => {
  const sponsor = Keypair.random();
  const sponsorPubkey = sponsor.publicKey();
  const nativeSac = Asset.native().contractId(Networks.TESTNET);

  const passkeyWalletContract = Address.contract(new Uint8Array(32));
  const destinationUser = Keypair.random();

  const transferOp = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(new xdr.InvokeContractArgs({
      contractAddress: new Address(nativeSac).toScAddress(),
      functionName: "transfer",
      args: [
        passkeyWalletContract.toScVal(),
        new Address(destinationUser.publicKey()).toScVal(),
        nativeToScVal(1000000n, { type: "i128" }), // 0.1 XLM, <= AMOUNT_CAP
      ],
    })),
    auth: [],
  });

  const account = {
    accountId: () => sponsorPubkey,
    sequenceNumber: () => "1",
    incrementSequenceNumber: () => {},
  };

  const tx = new TransactionBuilder(account as any, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  }).addOperation(transferOp).setTimeout(60).build();

  const verdict = validateSponsorable(tx.toXDR(), sponsorPubkey);
  assertEquals(verdict, { ok: true });
});

Deno.test("validateSponsorable rejects sponsored transfer targeting unauthorized contract and names the contract", () => {
  const sponsor = Keypair.random();
  const sponsorPubkey = sponsor.publicKey();

  // Malicious or unauthorized contract target
  const maliciousContract = Address.contract(new Uint8Array(32).fill(0x66));
  const maliciousContractId = maliciousContract.toString();

  const passkeyWalletContract = Address.contract(new Uint8Array(32));
  const destinationUser = Keypair.random();

  const transferOp = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(new xdr.InvokeContractArgs({
      contractAddress: maliciousContract.toScAddress(),
      functionName: "transfer",
      args: [
        passkeyWalletContract.toScVal(),
        new Address(destinationUser.publicKey()).toScVal(),
        nativeToScVal(1000000n, { type: "i128" }),
      ],
    })),
    auth: [],
  });

  const account = {
    accountId: () => sponsorPubkey,
    sequenceNumber: () => "1",
    incrementSequenceNumber: () => {},
  };

  const tx = new TransactionBuilder(account as any, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  }).addOperation(transferOp).setTimeout(60).build();

  const verdict = validateSponsorable(tx.toXDR(), sponsorPubkey);
  assertEquals(verdict, {
    ok: false,
    reason: `target_contract_not_allowed: ${maliciousContractId}`,
  });
});

Deno.test("validateSponsorable rejects sponsored transfer with non-address destination", () => {
  const sponsor = Keypair.random();
  const sponsorPubkey = sponsor.publicKey();
  const nativeSac = Asset.native().contractId(Networks.TESTNET);

  const passkeyWalletContract = Address.contract(new Uint8Array(32));

  // Malformed destination: raw bytes instead of ScVal scvAddress
  const badDestination = xdr.ScVal.scvBytes(toB(new Uint8Array(32)));

  const transferOp = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(new xdr.InvokeContractArgs({
      contractAddress: new Address(nativeSac).toScAddress(),
      functionName: "transfer",
      args: [
        passkeyWalletContract.toScVal(),
        badDestination,
        nativeToScVal(1000000n, { type: "i128" }),
      ],
    })),
    auth: [],
  });

  const account = {
    accountId: () => sponsorPubkey,
    sequenceNumber: () => "1",
    incrementSequenceNumber: () => {},
  };

  const tx = new TransactionBuilder(account as any, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  }).addOperation(transferOp).setTimeout(60).build();

  const verdict = validateSponsorable(tx.toXDR(), sponsorPubkey);
  assertEquals(verdict, { ok: false, reason: "to_not_address" });
});

Deno.test("validateSponsorable rejects sponsored transfer when amount exceeds cap", () => {
  const sponsor = Keypair.random();
  const sponsorPubkey = sponsor.publicKey();
  const nativeSac = Asset.native().contractId(Networks.TESTNET);

  const passkeyWalletContract = Address.contract(new Uint8Array(32));
  const destinationUser = Keypair.random();

  const transferOp = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(new xdr.InvokeContractArgs({
      contractAddress: new Address(nativeSac).toScAddress(),
      functionName: "transfer",
      args: [
        passkeyWalletContract.toScVal(),
        new Address(destinationUser.publicKey()).toScVal(),
        nativeToScVal(99999999999n, { type: "i128" }), // far over AMOUNT_CAP
      ],
    })),
    auth: [],
  });

  const account = {
    accountId: () => sponsorPubkey,
    sequenceNumber: () => "1",
    incrementSequenceNumber: () => {},
  };

  const tx = new TransactionBuilder(account as any, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  }).addOperation(transferOp).setTimeout(60).build();

  const verdict = validateSponsorable(tx.toXDR(), sponsorPubkey);
  assertEquals(verdict, { ok: false, reason: "amount_over_cap" });
});
