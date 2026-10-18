// Biometric-pay (WebAuthn / passkey) primitives for the browser.
//
// The crypto + on-chain construction here mirrors the PROVEN testnet e2e
// (scripts/e2e-passkey-pay-testnet.mjs, tx 5b1d7d0a…): a payment authorized
// ONLY by a real WebAuthn assertion, verified on-chain by the smart-wallet's
// __check_auth. The only difference here is the assertion comes from the
// device's real Face ID / fingerprint instead of a synthetic P-256 key.
//
// Flow:
//   1. createPasskey()  → device prompts Face ID, returns the secp256r1 pubkey
//      (65-byte uncompressed) + credential id. Deploy a wallet bound to it.
//   2. payWithBiometric() → device prompts Face ID, signs the Soroban auth
//      payload as a WebAuthn assertion, submits the transfer.

import {
  Address, Asset, BASE_FEE, Networks, Operation, TransactionBuilder,
  hash, nativeToScVal, rpc, xdr, Keypair,
} from "@stellar/stellar-sdk";

// stellar-sdk APIs are typed for Node `Buffer` but accept Uint8Array at runtime
// (the SDK bundles its own buffer; no global Buffer exists in the browser).
// This cast lets us pass Uint8Array without referencing the missing global.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toB = (u: Uint8Array): any => u;

const P256_N =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/** secp256r1 group-order, big-endian, for low-S normalization. */
function normalizeLowS(sig64: Uint8Array): Uint8Array {
  const r = sig64.slice(0, 32);
  let s = BigInt("0x" + bytesToHex(sig64.slice(32, 64)));
  if (s > P256_N / 2n) {
    s = P256_N - s;
    const out = new Uint8Array(64);
    out.set(r, 0);
    out.set(hexToBytes(s.toString(16).padStart(64, "0")), 32);
    return out;
  }
  return sig64;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function stripLeadingZeros(b: Uint8Array): Uint8Array {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  return b.slice(i);
}
function leftPad32(b: Uint8Array): Uint8Array {
  if (b.length >= 32) return b.slice(b.length - 32);
  const out = new Uint8Array(32);
  out.set(b, 32 - b.length);
  return out;
}

/** WebAuthn assertion signatures are DER (SEQUENCE{INTEGER r, INTEGER s}).
 *  Soroban secp256r1_verify wants raw 64-byte r||s, low-S normalized. */
export function derToRaw64(der: Uint8Array): Uint8Array {
  let o = 2;
  const b1 = der[1] ?? 0;
  if (b1 & 0x80) o = 2 + (b1 & 0x7f);
  if (der[o] !== 0x02) throw new Error("bad DER signature (r)");
  const rLen = der[o + 1] ?? 0;
  const r = der.slice(o + 2, o + 2 + rLen);
  o = o + 2 + rLen;
  if (der[o] !== 0x02) throw new Error("bad DER signature (s)");
  const sLen = der[o + 1] ?? 0;
  const s = der.slice(o + 2, o + 2 + sLen);
  const out = new Uint8Array(64);
  out.set(leftPad32(stripLeadingZeros(r)), 0);
  out.set(leftPad32(stripLeadingZeros(s)), 32);
  return normalizeLowS(out);
}

export interface PasskeyHandle {
  /** 65-byte uncompressed secp256r1 public key (0x04 || X || Y). */
  pubKey: Uint8Array;
  /** WebAuthn credential id. */
  credId: Uint8Array;
}

/** A user-initiated outcome that is NOT an error: the person cancelled the
 *  Face ID / fingerprint prompt, it timed out, or this device can't do passkeys.
 *  Genuine failures still throw. */
export type PasskeyOutcome =
  | { ok: false; reason: "cancelled" }
  | { ok: false; reason: "timeout" }
  | { ok: false; reason: "unsupported"; message: string };

export type PasskeyResult<T> = { ok: true; value: T } | PasskeyOutcome;

export interface PasskeyAssertion {
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  signature: Uint8Array;
}

const UNSUPPORTED_MESSAGE =
  "Este dispositivo não suporta passkey / Face ID. Ative a biometria nas configurações do aparelho ou use outro dispositivo.";

const CEREMONY_TIMEOUT_MS = 60000;
// The browser's own timeout is deliberately LONGER than ours. If they were equal,
// the browser could win the race and report a timeout as NotAllowedError, which
// looks identical to the user cancelling.
const BROWSER_TIMEOUT_MS = CEREMONY_TIMEOUT_MS + 5000;

/** Run a WebAuthn ceremony and translate cancel / timeout / unsupported into
 *  results. Anything else is a genuine failure and is re-thrown. */
async function runCeremony(
  call: (signal: AbortSignal) => Promise<Credential | null>,
): Promise<PasskeyResult<PublicKeyCredential>> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, CEREMONY_TIMEOUT_MS);
  try {
    const cred = await call(controller.signal);
    if (!cred) return { ok: false, reason: "cancelled" };
    return { ok: true, value: cred as PublicKeyCredential };
  } catch (err) {
    // NotAllowedError is used for cancel AND timeout, so the error name can't
    // tell them apart. Our own flag can.
    if (timedOut) return { ok: false, reason: "timeout" };
    const name = (err as { name?: string } | null)?.name;
    if (name === "NotAllowedError" || name === "AbortError") return { ok: false, reason: "cancelled" };
    if (name === "NotSupportedError") return { ok: false, reason: "unsupported", message: UNSUPPORTED_MESSAGE };
    throw err; // genuine failure: keep it loud
  } finally {
    clearTimeout(timer);
  }
}

/** User-facing text for a non-ok outcome, or null when nothing should be shown
 *  (the user cancelled on purpose, so the UI just returns quietly). */
export function passkeyOutcomeMessage(o: PasskeyOutcome): string | null {
  switch (o.reason) {
    case "cancelled":
      return null;
    case "timeout":
      return "A biometria demorou demais para responder. Tente novamente.";
    case "unsupported":
      return o.message;
  }
}

/** Prompt the platform authenticator (Face ID / fingerprint) to MINT a new
 *  passkey. Returns the secp256r1 pubkey to bind a wallet to. */
export async function createPasskey(userName: string): Promise<PasskeyResult<PasskeyHandle>> {
  if (!window.PublicKeyCredential) return { ok: false, reason: "unsupported", message: UNSUPPORTED_MESSAGE };
  const r = await runCeremony((signal) =>
    navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: "Slippay" },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: userName,
          displayName: userName,
        },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }], // ES256 / secp256r1
        authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "preferred" },
        timeout: BROWSER_TIMEOUT_MS,
      },
      signal,
    }),
  );
  if (!r.ok) return r;
  const cred = r.value;
  const resp = cred.response as AuthenticatorAttestationResponse;
  // getPublicKey() returns the DER SPKI; for P-256 the uncompressed EC point
  // (0x04 || X || Y) is the trailing 65 bytes.
  const spki = new Uint8Array(resp.getPublicKey()!);
  const pubKey = spki.slice(spki.length - 65);
  if (pubKey[0] !== 0x04 || pubKey.length !== 65) throw new Error("passkey is not an uncompressed P-256 key");
  return { ok: true, value: { pubKey, credId: new Uint8Array(cred.rawId) } };
}

/** Prompt the authenticator to SIGN `challenge` (the Soroban auth payload).
 *  Returns the raw WebAuthn assertion blobs the contract verifies. */
export async function getAssertion(
  challenge: Uint8Array,
  credId?: Uint8Array,
): Promise<PasskeyResult<PasskeyAssertion>> {
  const r = await runCeremony((signal) =>
    navigator.credentials.get({
      publicKey: {
        challenge: challenge as BufferSource,
        ...(credId ? { allowCredentials: [{ type: "public-key" as const, id: credId as BufferSource }] } : {}),
        userVerification: "required",
        timeout: BROWSER_TIMEOUT_MS,
      },
      signal,
    }),
  );
  if (!r.ok) return r;
  const resp = r.value.response as AuthenticatorAssertionResponse;
  return {
    ok: true,
    value: {
      authenticatorData: new Uint8Array(resp.authenticatorData),
      clientDataJSON: new Uint8Array(resp.clientDataJSON),
      signature: derToRaw64(new Uint8Array(resp.signature)),
    },
  };
}

const HORIZON_RPC: Record<string, string> = {
  TESTNET: "https://soroban-testnet.stellar.org",
  PUBLIC: "https://soroban-rpc.mainnet.stellar.gateway.fm",
};

async function sha256(buf: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf as BufferSource));
}

/** Fund a fresh testnet account via friendbot (free testnet XLM). Returns when funded. */
export async function friendbotFund(publicKey: string): Promise<void> {
  const r = await fetch(`https://friendbot.stellar.org/?addr=${publicKey}`);
  if (!r.ok && r.status !== 400) throw new Error(`friendbot failed: ${r.status}`);
}

/** Deploy a smart-wallet instance bound to `pubKey` (the device passkey), paid
 *  for by `feeSource`. Returns the new contract id. Testnet-only path (the page
 *  funds feeSource via friendbot); mainnet uses a server relayer instead. */
export async function deployPasskeyWallet(opts: {
  network: "TESTNET" | "PUBLIC";
  wasmHash: Uint8Array; // 32 bytes
  feeSource: Keypair;
  pubKey: Uint8Array; // 65 bytes
  credId: Uint8Array;
  admin: string;
  maxAbsolutePerCharge: string; // stroops
}): Promise<string> {
  const passphrase = opts.network === "PUBLIC" ? Networks.PUBLIC : Networks.TESTNET;
  const server = new rpc.Server(HORIZON_RPC[opts.network]!, { allowHttp: false });
  const credId32 = await sha256(opts.credId); // contract stores BytesN<32>; sha256 normalizes length
  const ctorArgs: xdr.ScVal[] = [
    xdr.ScVal.scvBytes(toB(opts.pubKey)),
    xdr.ScVal.scvBytes(toB(credId32)),
    new Address(opts.admin).toScVal(),
    nativeToScVal(BigInt(opts.maxAbsolutePerCharge), { type: "i128" }),
  ];
  const op = Operation.createCustomContract({
    address: new Address(opts.feeSource.publicKey()),
    wasmHash: toB(opts.wasmHash),
    salt: toB(crypto.getRandomValues(new Uint8Array(32))),
    constructorArgs: ctorArgs,
  });
  const src = await server.getAccount(opts.feeSource.publicKey());
  const tx = new TransactionBuilder(src, { fee: String(Number(BASE_FEE) * 1000), networkPassphrase: passphrase })
    .addOperation(op).setTimeout(60).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error("deploy sim failed: " + sim.error);
  const assembled = rpc.assembleTransaction(tx, sim).build();
  assembled.sign(opts.feeSource);
  const sent = await server.sendTransaction(assembled);
  let res = await server.getTransaction(sent.hash);
  for (let i = 0; i < 40 && res.status === "NOT_FOUND"; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    res = await server.getTransaction(sent.hash);
  }
  if (res.status !== "SUCCESS") throw new Error("deploy failed: " + res.status);
  return Address.fromScVal(res.returnValue!).toString();
}

/** Give a wallet contract XLM balance: native-SAC transfer feeSource → wallet. */
export async function fundWalletXlm(opts: {
  network: "TESTNET" | "PUBLIC";
  feeSource: Keypair;
  walletId: string;
  amount: string; // stroops
}): Promise<void> {
  const passphrase = opts.network === "PUBLIC" ? Networks.PUBLIC : Networks.TESTNET;
  const server = new rpc.Server(HORIZON_RPC[opts.network]!, { allowHttp: false });
  const sac = payAssetSac(opts.network, (opts as { asset?: "USDC" | "XLM" }).asset, passphrase);
  const op = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(new xdr.InvokeContractArgs({
      contractAddress: new Address(sac).toScAddress(),
      functionName: "transfer",
      args: [
        new Address(opts.feeSource.publicKey()).toScVal(),
        new Address(opts.walletId).toScVal(),
        nativeToScVal(BigInt(opts.amount), { type: "i128" }),
      ],
    })),
    auth: [],
  });
  const src = await server.getAccount(opts.feeSource.publicKey());
  const tx = new TransactionBuilder(src, { fee: String(Number(BASE_FEE) * 100), networkPassphrase: passphrase })
    .addOperation(op).setTimeout(60).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error("fund sim failed: " + sim.error);
  const assembled = rpc.assembleTransaction(tx, sim).build();
  assembled.sign(opts.feeSource);
  const sent = await server.sendTransaction(assembled);
  let res = await server.getTransaction(sent.hash);
  for (let i = 0; i < 30 && res.status === "NOT_FOUND"; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    res = await server.getTransaction(sent.hash);
  }
  if (res.status !== "SUCCESS") throw new Error("fund failed: " + res.status);
}

/** Move `amount` (stroops) of native XLM from a passkey-bound wallet to
 *  `recipient`, authorized by a live Face ID / fingerprint tap. `feeSource`
 *  pays the network fee and submits (in production this is a relayer; for the
 *  demo it is a funded testnet account). Returns the settled tx hash. */
// Resolve the SAC contract for the asset being paid. Absent/"XLM" → native SAC
// (preserves the original demo behavior); "USDC" → the Circle USDC SAC, so the
// same biometric+QR flow settles dollars instead of XLM.
function payAssetSac(network: "TESTNET" | "PUBLIC", asset: "USDC" | "XLM" | undefined, passphrase: string): string {
  if (asset !== "USDC") return Asset.native().contractId(passphrase);
  const issuer = network === "PUBLIC"
    ? "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
    : ((import.meta.env.VITE_USDC_ISSUER as string | undefined) ?? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
  return new Asset("USDC", issuer).contractId(passphrase);
}

export async function payWithBiometric(opts: {
  network: "TESTNET" | "PUBLIC";
  walletId: string;
  recipient: string;
  amount: string; // stroops
  asset?: "USDC" | "XLM";
  feeSource: Keypair;
  credId?: Uint8Array;
}): Promise<PasskeyResult<string>> {
  const passphrase = opts.network === "PUBLIC" ? Networks.PUBLIC : Networks.TESTNET;
  const server = new rpc.Server(HORIZON_RPC[opts.network]!, { allowHttp: false });
  const sac = payAssetSac(opts.network, (opts as { asset?: "USDC" | "XLM" }).asset, passphrase);
  const scAddr = (id: string) => new Address(id).toScVal();
  const i128 = (n: string) => nativeToScVal(BigInt(n), { type: "i128" });

  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(sac).toScAddress(),
        functionName: "transfer",
        args: [scAddr(opts.walletId), scAddr(opts.recipient), i128(opts.amount)],
      }),
    ),
    subInvocations: [],
  });

  const { sequence } = await server.getLatestLedger();
  const sigExp = sequence + 200;
  const nonce = (BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))).toString();

  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(toB(new TextEncoder().encode(passphrase))),
      nonce: xdr.Int64.fromString(nonce),
      signatureExpirationLedger: sigExp,
      invocation,
    }),
  );
  const payload = new Uint8Array(hash(preimage.toXDR()));

  // ← the only human action: Face ID / fingerprint signs the payload.
  const asserted = await getAssertion(payload, opts.credId);
  if (!asserted.ok) return asserted; // cancelled / timeout / unsupported: nothing was signed
  const a = asserted.value;

  const walletAuth = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Passkey"),
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("authenticator_data"), val: xdr.ScVal.scvBytes(toB(a.authenticatorData)) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("client_data_json"), val: xdr.ScVal.scvBytes(toB(a.clientDataJSON)) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("signature"), val: xdr.ScVal.scvBytes(toB(a.signature)) }),
    ]),
  ]);
  const authEntry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(opts.walletId).toScAddress(),
        nonce: xdr.Int64.fromString(nonce),
        signatureExpirationLedger: sigExp,
        signature: walletAuth,
      }),
    ),
    rootInvocation: invocation,
  });

  const op = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(sac).toScAddress(),
        functionName: "transfer",
        args: [scAddr(opts.walletId), scAddr(opts.recipient), i128(opts.amount)],
      }),
    ),
    auth: [authEntry],
  });

  const src = await server.getAccount(opts.feeSource.publicKey());
  const tx = new TransactionBuilder(src, { fee: String(Number(BASE_FEE) * 100), networkPassphrase: passphrase })
    .addOperation(op).setTimeout(60).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error("biometric auth rejected: " + sim.error);
  const assembled = rpc.assembleTransaction(tx, sim).build();
  assembled.sign(opts.feeSource);
  const sent = await server.sendTransaction(assembled);
  let res = await server.getTransaction(sent.hash);
  for (let i = 0; i < 30 && res.status === "NOT_FOUND"; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    res = await server.getTransaction(sent.hash);
  }
  if (res.status !== "SUCCESS") throw new Error("payment failed: " + res.status);
  return { ok: true, value: sent.hash };
}

/** Mainnet biometric payment via the gas-sponsor relayer (option A, zero
 *  friction — no wallet connect). Identical auth construction to
 *  `payWithBiometric`, but the tx SOURCE is the relayer's sponsor account and
 *  we never hold its key: we build + simulate + assemble, then POST the XDR
 *  (with the Face-ID auth entry attached) to the relayer, which validates it is
 *  a bounded slippay transfer, signs the envelope (pays gas only), and submits.
 *  The user's funds move ONLY because the on-chain __check_auth accepts the
 *  passkey assertion — the relayer cannot move them. Returns the settled hash. */
export async function payViaRelayer(opts: {
  network: "TESTNET" | "PUBLIC";
  relayerBase: string; // e.g. https://api.slippay.cc/api/v1/relayer
  sponsor: string; // sponsor pubkey — the tx source / fee payer
  walletId: string;
  recipient: string;
  amount: string; // stroops
  asset?: "USDC" | "XLM";
  credId?: Uint8Array;
}): Promise<PasskeyResult<string>> {
  const passphrase = opts.network === "PUBLIC" ? Networks.PUBLIC : Networks.TESTNET;
  const server = new rpc.Server(HORIZON_RPC[opts.network]!, { allowHttp: false });
  const sac = payAssetSac(opts.network, (opts as { asset?: "USDC" | "XLM" }).asset, passphrase);
  const scAddr = (id: string) => new Address(id).toScVal();
  const i128 = (n: string) => nativeToScVal(BigInt(n), { type: "i128" });

  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(sac).toScAddress(),
        functionName: "transfer",
        args: [scAddr(opts.walletId), scAddr(opts.recipient), i128(opts.amount)],
      }),
    ),
    subInvocations: [],
  });

  const { sequence } = await server.getLatestLedger();
  const sigExp = sequence + 200;
  const nonce = (BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))).toString();
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(toB(new TextEncoder().encode(passphrase))),
      nonce: xdr.Int64.fromString(nonce),
      signatureExpirationLedger: sigExp,
      invocation,
    }),
  );
  const payload = new Uint8Array(hash(preimage.toXDR()));

  // ← the only human action: Face ID / fingerprint signs the payload.
  const asserted = await getAssertion(payload, opts.credId);
  if (!asserted.ok) return asserted; // cancelled / timeout / unsupported: nothing was signed
  const a = asserted.value;

  const walletAuth = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Passkey"),
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("authenticator_data"), val: xdr.ScVal.scvBytes(toB(a.authenticatorData)) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("client_data_json"), val: xdr.ScVal.scvBytes(toB(a.clientDataJSON)) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("signature"), val: xdr.ScVal.scvBytes(toB(a.signature)) }),
    ]),
  ]);
  const authEntry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(opts.walletId).toScAddress(),
        nonce: xdr.Int64.fromString(nonce),
        signatureExpirationLedger: sigExp,
        signature: walletAuth,
      }),
    ),
    rootInvocation: invocation,
  });

  const op = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(sac).toScAddress(),
        functionName: "transfer",
        args: [scAddr(opts.walletId), scAddr(opts.recipient), i128(opts.amount)],
      }),
    ),
    auth: [authEntry],
  });

  // Source = the relayer's sponsor account (it pays the fee). We never sign.
  const src = await server.getAccount(opts.sponsor);
  const tx = new TransactionBuilder(src, { fee: String(Number(BASE_FEE) * 100), networkPassphrase: passphrase })
    .addOperation(op).setTimeout(60).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error("biometric auth rejected: " + sim.error);
  const assembled = rpc.assembleTransaction(tx, sim).build();

  // Hand the assembled (unsigned) XDR to the relayer to sponsor + submit.
  const resp = await fetch(`${opts.relayerBase}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ xdr: assembled.toXDR() }),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`relayer rejected: ${j.reason ?? j.error ?? resp.status}`);
  return { ok: true, value: j.hash as string };
}
