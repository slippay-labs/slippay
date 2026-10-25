import { assertEquals, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  Account,
  Address,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "npm:@stellar/stellar-sdk@13";
import {
  AMOUNT_CAP,
  FEE_CAP,
  PASSPHRASE,
  getAmountCap,
  getFeeCap,
  getWasmHashHex,
  validateSponsorable,
} from "../routes/relayer.ts";

const toB = (u: Uint8Array): any => u;

function randomContractAddress(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const scAddr = xdr.ScAddress.scAddressTypeContract(toB(bytes));
  return Address.fromScAddress(scAddr).toString();
}

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function buildTx(
  sourceKp: Keypair,
  operations: xdr.Operation[],
  fee: bigint = 100n,
  passphrase: string = PASSPHRASE,
): string {
  const account = new Account(sourceKp.publicKey(), "1000");
  const builder = new TransactionBuilder(account, {
    fee: fee.toString(),
    networkPassphrase: passphrase,
  });
  for (const op of operations) {
    builder.addOperation(op);
  }
  return builder.setTimeout(60).build().toXDR();
}

Deno.test("validateSponsorable: rejects invalid XDR string with bad_xdr", () => {
  const sponsor = Keypair.random();
  const verdict = validateSponsorable("not-a-valid-xdr-string", sponsor.publicKey());
  assertEquals(verdict.ok, false);
  assertMatch(verdict.reason ?? "", /^bad_xdr:/);
});

Deno.test("validateSponsorable: rejects FeeBump envelope with fee_bump_not_accepted", () => {
  const sponsor = Keypair.random();
  const payer = Keypair.random();
  const innerAccount = new Account(payer.publicKey(), "50");
  const innerTx = new TransactionBuilder(innerAccount, {
    fee: "100",
    networkPassphrase: PASSPHRASE,
  }).addOperation(Operation.payment({
    destination: sponsor.publicKey(),
    asset: Asset.native(),
    amount: "1",
  })).setTimeout(0).build();

  const feeBump = TransactionBuilder.buildFeeBumpTransaction(
    sponsor,
    "200",
    innerTx,
    PASSPHRASE,
  );
  const verdict = validateSponsorable(feeBump.toXDR(), sponsor.publicKey());
  assertEquals(verdict, { ok: false, reason: "fee_bump_not_accepted" });
});

Deno.test("validateSponsorable: rejects when source is not the sponsor", () => {
  const sponsor = Keypair.random();
  const attacker = Keypair.random();
  const op = Operation.payment({
    destination: sponsor.publicKey(),
    asset: Asset.native(),
    amount: "1",
  });
  const txXdr = buildTx(attacker, [op]);
  const verdict = validateSponsorable(txXdr, sponsor.publicKey());
  assertEquals(verdict, { ok: false, reason: "source_not_sponsor" });
});

Deno.test("validateSponsorable: asserts fee cap boundary (FEE_CAP is accepted, FEE_CAP + 1 rejected)", () => {
  const sponsor = Keypair.random();
  const sac = Asset.native().contractId(PASSPHRASE);
  const fromContract = randomContractAddress();
  const toDestination = Keypair.random().publicKey();

  const invokeOp = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(new xdr.InvokeContractArgs({
      contractAddress: new Address(sac).toScAddress(),
      functionName: "transfer",
      args: [
        new Address(fromContract).toScVal(),
        new Address(toDestination).toScVal(),
        nativeToScVal(1000n, { type: "i128" }),
      ],
    })),
    auth: [],
  });

  // Exactly at FEE_CAP
  const okFeeXdr = buildTx(sponsor, [invokeOp], FEE_CAP);
  const okVerdict = validateSponsorable(okFeeXdr, sponsor.publicKey());
  assertEquals(okVerdict.ok, true);

  // Exactly 1 stroop above FEE_CAP
  const overFeeXdr = buildTx(sponsor, [invokeOp], FEE_CAP + 1n);
  const overVerdict = validateSponsorable(overFeeXdr, sponsor.publicKey());
  assertEquals(overVerdict, { ok: false, reason: "fee_over_cap" });
});

Deno.test("validateSponsorable: rejects multiple operations with must_be_single_op", () => {
  const sponsor = Keypair.random();
  const p1 = Operation.payment({
    destination: Keypair.random().publicKey(),
    asset: Asset.native(),
    amount: "1",
  });
  const p2 = Operation.payment({
    destination: Keypair.random().publicKey(),
    asset: Asset.native(),
    amount: "1",
  });
  const txXdr = buildTx(sponsor, [p1, p2]);
  const verdict = validateSponsorable(txXdr, sponsor.publicKey());
  assertEquals(verdict, { ok: false, reason: "must_be_single_op" });
});

Deno.test("validateSponsorable: rejects single operation if not invokeHostFunction", () => {
  const sponsor = Keypair.random();
  const p = Operation.payment({
    destination: Keypair.random().publicKey(),
    asset: Asset.native(),
    amount: "1",
  });
  const txXdr = buildTx(sponsor, [p]);
  const verdict = validateSponsorable(txXdr, sponsor.publicKey());
  assertEquals(verdict, { ok: false, reason: "not_invoke_host_function" });
});

Deno.test("validateSponsorable: rejects deploy when executable is not WASM with deploy_not_wasm", () => {
  const sponsor = Keypair.random();
  const cc = new xdr.CreateContractArgs({
    contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
      new xdr.ContractIdPreimageFromAddress({
        address: new Address(sponsor.publicKey()).toScAddress(),
        salt: toB(new Uint8Array(32)),
      }),
    ),
    executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
  });
  const op = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeCreateContract(cc),
    auth: [],
  });
  const txXdr = buildTx(sponsor, [op]);
  const verdict = validateSponsorable(txXdr, sponsor.publicKey());
  assertEquals(verdict, { ok: false, reason: "deploy_not_wasm" });
});

Deno.test("validateSponsorable: rejects contract deploy when wasm hash does not match WASM_HASH_HEX", () => {
  const sponsor = Keypair.random();
  const fakeBytes = new Uint8Array(32);
  fakeBytes.fill(0xaa);
  const cc = new xdr.CreateContractArgs({
    contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
      new xdr.ContractIdPreimageFromAddress({
        address: new Address(sponsor.publicKey()).toScAddress(),
        salt: toB(new Uint8Array(32)),
      }),
    ),
    executable: xdr.ContractExecutable.contractExecutableWasm(toB(fakeBytes)),
  });
  const op = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeCreateContract(cc),
    auth: [],
  });
  const txXdr = buildTx(sponsor, [op]);
  const verdict = validateSponsorable(txXdr, sponsor.publicKey());
  assertEquals(verdict, { ok: false, reason: "wrong_wasm_hash" });
});

Deno.test("validateSponsorable: accepts correctly-formed deploy when wasm hash matches configured hash", () => {
  const expectedBytes = new Uint8Array(32);
  expectedBytes.fill(0x5a);
  const expectedHex = hex(expectedBytes);

  Deno.env.set("RELAYER_WASM_HASH", expectedHex);
  try {
    const sponsor = Keypair.random();
    const cc = new xdr.CreateContractArgs({
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: new Address(sponsor.publicKey()).toScAddress(),
          salt: toB(new Uint8Array(32)),
        }),
      ),
      executable: xdr.ContractExecutable.contractExecutableWasm(toB(expectedBytes)),
    });
    const op = Operation.invokeHostFunction({
      func: xdr.HostFunction.hostFunctionTypeCreateContract(cc),
      auth: [],
    });
    const txXdr = buildTx(sponsor, [op]);
    const verdict = validateSponsorable(txXdr, sponsor.publicKey());
    assertEquals(verdict, { ok: true });
  } finally {
    Deno.env.delete("RELAYER_WASM_HASH");
  }
});

Deno.test("validateSponsorable: rejects invokeContract when function is not transfer", () => {
  const sponsor = Keypair.random();
  const sac = Asset.native().contractId(PASSPHRASE);
  const op = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(new xdr.InvokeContractArgs({
      contractAddress: new Address(sac).toScAddress(),
      functionName: "mint",
      args: [],
    })),
    auth: [],
  });
  const txXdr = buildTx(sponsor, [op]);
  const verdict = validateSponsorable(txXdr, sponsor.publicKey());
  assertEquals(verdict, { ok: false, reason: "not_transfer" });
});

Deno.test("validateSponsorable: rejects invokeContract when args length is not 3", () => {
  const sponsor = Keypair.random();
  const sac = Asset.native().contractId(PASSPHRASE);
  const op = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(new xdr.InvokeContractArgs({
      contractAddress: new Address(sac).toScAddress(),
      functionName: "transfer",
      args: [
        new Address(randomContractAddress()).toScVal(),
        new Address(Keypair.random().publicKey()).toScVal(),
      ], // 2 args instead of 3
    })),
    auth: [],
  });
  const txXdr = buildTx(sponsor, [op]);
  const verdict = validateSponsorable(txXdr, sponsor.publicKey());
  assertEquals(verdict, { ok: false, reason: "bad_transfer_args" });
});

Deno.test("validateSponsorable: rejects transfer when from is a classic account instead of contract", () => {
  const sponsor = Keypair.random();
  const sac = Asset.native().contractId(PASSPHRASE);
  const classicFrom = Keypair.random().publicKey(); // classic G... account
  const op = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(new xdr.InvokeContractArgs({
      contractAddress: new Address(sac).toScAddress(),
      functionName: "transfer",
      args: [
        new Address(classicFrom).toScVal(),
        new Address(Keypair.random().publicKey()).toScVal(),
        nativeToScVal(100n, { type: "i128" }),
      ],
    })),
    auth: [],
  });
  const txXdr = buildTx(sponsor, [op]);
  const verdict = validateSponsorable(txXdr, sponsor.publicKey());
  assertEquals(verdict, { ok: false, reason: "from_not_contract" });
});

Deno.test("validateSponsorable: rejects transfer when amount is not i128", () => {
  const sponsor = Keypair.random();
  const sac = Asset.native().contractId(PASSPHRASE);
  const op = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(new xdr.InvokeContractArgs({
      contractAddress: new Address(sac).toScAddress(),
      functionName: "transfer",
      args: [
        new Address(randomContractAddress()).toScVal(),
        new Address(Keypair.random().publicKey()).toScVal(),
        nativeToScVal(100n, { type: "u64" }), // u64 instead of i128
      ],
    })),
    auth: [],
  });
  const txXdr = buildTx(sponsor, [op]);
  const verdict = validateSponsorable(txXdr, sponsor.publicKey());
  assertEquals(verdict, { ok: false, reason: "amount_not_i128" });
});

Deno.test("validateSponsorable: rejects transfer when amount is not positive (0 or negative)", () => {
  const sponsor = Keypair.random();
  const sac = Asset.native().contractId(PASSPHRASE);
  const fromContract = randomContractAddress();
  const toDestination = Keypair.random().publicKey();

  const zeroOp = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(new xdr.InvokeContractArgs({
      contractAddress: new Address(sac).toScAddress(),
      functionName: "transfer",
      args: [
        new Address(fromContract).toScVal(),
        new Address(toDestination).toScVal(),
        nativeToScVal(0n, { type: "i128" }),
      ],
    })),
    auth: [],
  });
  const zeroXdr = buildTx(sponsor, [zeroOp]);
  const verdictZero = validateSponsorable(zeroXdr, sponsor.publicKey());
  assertEquals(verdictZero, { ok: false, reason: "amount_not_positive" });
});

Deno.test("validateSponsorable: asserts amount cap boundary (AMOUNT_CAP is accepted, AMOUNT_CAP + 1 rejected)", () => {
  const sponsor = Keypair.random();
  const sac = Asset.native().contractId(PASSPHRASE);
  const fromContract = randomContractAddress();
  const toDestination = Keypair.random().publicKey();

  // Exactly at AMOUNT_CAP
  const atCapOp = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(new xdr.InvokeContractArgs({
      contractAddress: new Address(sac).toScAddress(),
      functionName: "transfer",
      args: [
        new Address(fromContract).toScVal(),
        new Address(toDestination).toScVal(),
        nativeToScVal(AMOUNT_CAP, { type: "i128" }),
      ],
    })),
    auth: [],
  });
  const atCapXdr = buildTx(sponsor, [atCapOp]);
  const verdictAtCap = validateSponsorable(atCapXdr, sponsor.publicKey());
  assertEquals(verdictAtCap, { ok: true });

  // Exactly 1 stroop above AMOUNT_CAP
  const overCapOp = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(new xdr.InvokeContractArgs({
      contractAddress: new Address(sac).toScAddress(),
      functionName: "transfer",
      args: [
        new Address(fromContract).toScVal(),
        new Address(toDestination).toScVal(),
        nativeToScVal(AMOUNT_CAP + 1n, { type: "i128" }),
      ],
    })),
    auth: [],
  });
  const overCapXdr = buildTx(sponsor, [overCapOp]);
  const verdictOverCap = validateSponsorable(overCapXdr, sponsor.publicKey());
  assertEquals(verdictOverCap, { ok: false, reason: "amount_over_cap" });
});

Deno.test("validateSponsorable: accepts valid native-SAC transfer within cap", () => {
  const sponsor = Keypair.random();
  const sac = Asset.native().contractId(PASSPHRASE);
  const fromContract = randomContractAddress();
  const toDestination = Keypair.random().publicKey();

  const op = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(new xdr.InvokeContractArgs({
      contractAddress: new Address(sac).toScAddress(),
      functionName: "transfer",
      args: [
        new Address(fromContract).toScVal(),
        new Address(toDestination).toScVal(),
        nativeToScVal(500_000n, { type: "i128" }),
      ],
    })),
    auth: [],
  });
  const txXdr = buildTx(sponsor, [op]);
  const verdict = validateSponsorable(txXdr, sponsor.publicKey());
  assertEquals(verdict, { ok: true });
});

Deno.test("validateSponsorable: rejects unsupported host function with unsupported_host_function", () => {
  const sponsor = Keypair.random();
  const wasmCode = new Uint8Array([0x00, 0x61, 0x73, 0x6d]);
  const op = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeUploadContractWasm(toB(wasmCode)),
    auth: [],
  });
  const txXdr = buildTx(sponsor, [op]);
  const verdict = validateSponsorable(txXdr, sponsor.publicKey());
  assertEquals(verdict.ok, false);
  assertMatch(verdict.reason ?? "", /^unsupported_host_function:/);
});
