import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  Address, Keypair, nativeToScVal, Operation, TransactionBuilder,
  xdr, BASE_FEE, Networks,
} from "npm:@stellar/stellar-sdk@13";
import { validateDeployArgs, validateSponsorable } from "../routes/relayer.ts";

const toB = (u: Uint8Array): any => u;

Deno.test("validateDeployArgs accepts canonical constructor arguments", () => {
  const sponsor = Keypair.random();
  const sponsorPubkey = sponsor.publicKey();

  const validPubkey = new Uint8Array(65);
  validPubkey[0] = 0x04;
  for (let i = 1; i < 65; i++) validPubkey[i] = i;

  const validCredId = new Uint8Array(32);
  validCredId.fill(0xab);

  const args: xdr.ScVal[] = [
    xdr.ScVal.scvBytes(toB(validPubkey)),
    xdr.ScVal.scvBytes(toB(validCredId)),
    new Address(sponsorPubkey).toScVal(),
    nativeToScVal(1000000n, { type: "i128" }),
  ];

  const verdict = validateDeployArgs(args, sponsorPubkey, 1000000000n);
  assertEquals(verdict, { ok: true });
});

Deno.test("validateDeployArgs rejects malformed passkey pubkey", () => {
  const sponsor = Keypair.random();
  const sponsorPubkey = sponsor.publicKey();

  // Wrong prefix (compressed key 0x02 instead of 0x04)
  const compressedPubkey = new Uint8Array(65);
  compressedPubkey[0] = 0x02;

  const validCredId = new Uint8Array(32);

  const args: xdr.ScVal[] = [
    xdr.ScVal.scvBytes(toB(compressedPubkey)),
    xdr.ScVal.scvBytes(toB(validCredId)),
    new Address(sponsorPubkey).toScVal(),
    nativeToScVal(1000000n, { type: "i128" }),
  ];

  const verdict = validateDeployArgs(args, sponsorPubkey);
  assertEquals(verdict, { ok: false, reason: "bad_passkey_pubkey" });

  // Wrong length (64 instead of 65)
  const shortPubkey = new Uint8Array(64);
  shortPubkey[0] = 0x04;
  const argsShort: xdr.ScVal[] = [
    xdr.ScVal.scvBytes(toB(shortPubkey)),
    xdr.ScVal.scvBytes(toB(validCredId)),
    new Address(sponsorPubkey).toScVal(),
    nativeToScVal(1000000n, { type: "i128" }),
  ];
  assertEquals(validateDeployArgs(argsShort, sponsorPubkey), { ok: false, reason: "bad_passkey_pubkey" });
});

Deno.test("validateDeployArgs rejects invalid credential id length", () => {
  const sponsor = Keypair.random();
  const sponsorPubkey = sponsor.publicKey();

  const validPubkey = new Uint8Array(65);
  validPubkey[0] = 0x04;

  const shortCredId = new Uint8Array(16); // Expected 32 bytes

  const args: xdr.ScVal[] = [
    xdr.ScVal.scvBytes(toB(validPubkey)),
    xdr.ScVal.scvBytes(toB(shortCredId)),
    new Address(sponsorPubkey).toScVal(),
    nativeToScVal(1000000n, { type: "i128" }),
  ];

  assertEquals(validateDeployArgs(args, sponsorPubkey), { ok: false, reason: "bad_cred_id_length" });
});

Deno.test("validateDeployArgs rejects admin not matching sponsor", () => {
  const sponsor = Keypair.random();
  const attacker = Keypair.random();

  const validPubkey = new Uint8Array(65);
  validPubkey[0] = 0x04;
  const validCredId = new Uint8Array(32);

  const args: xdr.ScVal[] = [
    xdr.ScVal.scvBytes(toB(validPubkey)),
    xdr.ScVal.scvBytes(toB(validCredId)),
    new Address(attacker.publicKey()).toScVal(), // Attacker tries to make themselves admin
    nativeToScVal(1000000n, { type: "i128" }),
  ];

  assertEquals(validateDeployArgs(args, sponsor.publicKey()), { ok: false, reason: "admin_must_be_sponsor" });
});

Deno.test("validateDeployArgs rejects max_abs above ceiling or non-positive", () => {
  const sponsor = Keypair.random();
  const sponsorPubkey = sponsor.publicKey();

  const validPubkey = new Uint8Array(65);
  validPubkey[0] = 0x04;
  const validCredId = new Uint8Array(32);

  // Over ceiling
  const argsOver: xdr.ScVal[] = [
    xdr.ScVal.scvBytes(toB(validPubkey)),
    xdr.ScVal.scvBytes(toB(validCredId)),
    new Address(sponsorPubkey).toScVal(),
    nativeToScVal(2000000000n, { type: "i128" }), // ceiling is 1000000000
  ];
  assertEquals(validateDeployArgs(argsOver, sponsorPubkey, 1000000000n), {
    ok: false,
    reason: "max_abs_over_ceiling",
  });

  // Zero / negative
  const argsZero: xdr.ScVal[] = [
    xdr.ScVal.scvBytes(toB(validPubkey)),
    xdr.ScVal.scvBytes(toB(validCredId)),
    new Address(sponsorPubkey).toScVal(),
    nativeToScVal(0n, { type: "i128" }),
  ];
  assertEquals(validateDeployArgs(argsZero, sponsorPubkey, 1000000000n), {
    ok: false,
    reason: "max_abs_not_positive",
  });
});

Deno.test("validateSponsorable rejects createContractV2 with malformed constructor args in submit XDR", () => {
  const sponsor = Keypair.random();
  const sponsorPubkey = sponsor.publicKey();
  const wasmHash = new Uint8Array(32);
  wasmHash.fill(0xee);

  const wasmHashHex = Array.from(wasmHash, (b) => b.toString(16).padStart(2, "0")).join("");
  Deno.env.set("RELAYER_WASM_HASH", wasmHashHex);

  const malformedPubkey = new Uint8Array(65);
  malformedPubkey[0] = 0x00; // invalid

  const credId = new Uint8Array(32);

  const badDeployOp = Operation.createCustomContract({
    address: new Address(sponsorPubkey),
    wasmHash: toB(wasmHash),
    salt: toB(new Uint8Array(32)),
    constructorArgs: [
      xdr.ScVal.scvBytes(toB(malformedPubkey)),
      xdr.ScVal.scvBytes(toB(credId)),
      new Address(sponsorPubkey).toScVal(),
      nativeToScVal(1000000n, { type: "i128" }),
    ],
  });

  const account = {
    accountId: () => sponsorPubkey,
    sequenceNumber: () => "1",
    incrementSequenceNumber: () => {},
  };

  const tx = new TransactionBuilder(account as any, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  }).addOperation(badDeployOp).setTimeout(60).build();

  const xdrString = tx.toXDR();
  const verdict = validateSponsorable(xdrString, sponsorPubkey);
  assertEquals(verdict, { ok: false, reason: "bad_passkey_pubkey" });
});

Deno.test("validateSponsorable accepts valid createContractV2 with canonical constructor args", () => {
  const sponsor = Keypair.random();
  const sponsorPubkey = sponsor.publicKey();
  const wasmHash = new Uint8Array(32);
  wasmHash.fill(0xaa);

  const wasmHashHex = Array.from(wasmHash, (b) => b.toString(16).padStart(2, "0")).join("");
  Deno.env.set("RELAYER_WASM_HASH", wasmHashHex);

  const validPubkey = new Uint8Array(65);
  validPubkey[0] = 0x04;
  for (let i = 1; i < 65; i++) validPubkey[i] = i;

  const validCredId = new Uint8Array(32);
  validCredId.fill(0x12);

  const goodDeployOp = Operation.createCustomContract({
    address: new Address(sponsorPubkey),
    wasmHash: toB(wasmHash),
    salt: toB(new Uint8Array(32)),
    constructorArgs: [
      xdr.ScVal.scvBytes(toB(validPubkey)),
      xdr.ScVal.scvBytes(toB(validCredId)),
      new Address(sponsorPubkey).toScVal(),
      nativeToScVal(1000000n, { type: "i128" }),
    ],
  });

  const account = {
    accountId: () => sponsorPubkey,
    sequenceNumber: () => "1",
    incrementSequenceNumber: () => {},
  };

  const tx = new TransactionBuilder(account as any, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  }).addOperation(goodDeployOp).setTimeout(60).build();

  const xdrString = tx.toXDR();
  const verdict = validateSponsorable(xdrString, sponsorPubkey);
  assertEquals(verdict, { ok: true });
});
