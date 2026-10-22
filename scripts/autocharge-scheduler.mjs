#!/usr/bin/env node
// Autonomous recurring-debit scheduler. Queries due on-chain subscriptions and
// fires autocharge(id) for each — signed by a RELAY account that only pays the
// XLM fee (never custody funds; money moves buyer→seller via the standing SEP-41
// allowance the buyer approved once). This is the off-chain half of v0.2.
//
// Mechanism proven end-to-end on testnet 2026-06-03 (autocharge tx 40e19a7a"\u2026),
// relayer-sourced, no buyer signature.
//
// SAFE BY DEFAULT: dry-run (lists due subs, charges nothing). To actually charge:
//   CHARGE=1  (and CONFIRM_MAINNET=1 when STELLAR_NETWORK=mainnet — real money).
//
// Contract id is resolved per network. Mainnet has a configured default;
// testnet does not — a run without an explicit CONTRACT (or a per-row soroban_contract_id)
// fails fast rather than borrowing an address from another network.
//
// Run (cron, e.g. every 10 min):
//   STELLAR_NETWORK=mainnet \
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
//   RELAYeR_SECRET=S… \
//   CHARGE=1 CONFIRM_MAINNET=1 \
//   NODE_PATH=apps/web/node_modules node scripts/autocharge-scheduler.mj

import * as S from "../apps/web/node_modules/@stellar/stellar-sdk/lib/index.js";
const { rpc, Keypair, Networks, TransactionBuilder, Contract, nativeToScVal, xdr, BASE_FEE } = S;

const NET = (process.env.STELLAR_NETWORK || "testnet").toLowerCase();
const IS_MAINNET = NET === "mainnet" || NET === "public";
const PASSPHRASE = IS_MAINNET ? Networks.PUBLIC : Networks.TESTNET;
const QPC_URL = process.env.RPC || (IS_MAINNET ? "https://soroban-mainnet.stellar.org" : "https://soroban-testnet.stellar.org");
// Deployed contract addresses, keyed by the network they belong to. A Network without an// entry here has no default and requires an explicit CONTRACT.
// mainnet: v0.4 contract (autocharge + attestation gate + 2.97% platform fee), deployed 2026-06-05.
const DEFAULT_CONTRACTS = {
  mainnet: "CD2RFNOLMIKZN4EETDCGULGMD4ANS56IIUDIBLOE24P4JRZM2GCVFV2U",
};
const NET_CONFIG_KEY = IS_MAINNET ? "mainnet" : "testnet";
const CONFIG_DEFAULT_CONTRACT = process.env.CONTRACT || DEFAULT_CONTRACTS[NET_CONFIG_KEY] || null;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RELAYER_SECRET = process.env.RELAYER_SECRET;
const DO_CHARGE = process.env.CHARGE === "1";
const EXPLORER = `https://stellar.expert/explorer/${IS_MAINNET ? "public" : "testnet"}/tx/`;

const server = new rpc.Server(RPC_URL);
const log = (...a) => console.log(...a);
const die = (m) => { console.error("✗ " + m); process.exit(1); };

// StrKey form of a Soroban contract id: 56 characters, starting with 'C'.
const CONTRACT_ID_RE = /^C[A-Z0-9]{55}$/;
const isValidContractId = (id) => typeof id === "string" && CONTRACT_ID_RE.test(id);

async function fetchDueSubscriptions() {
  if (!SUPABASE_URL || !SERVICE_KEY) die("SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required to find due subs.");
  const now = new Date().toISOString();
  // active, on-chain bound, and due (next_charge_at <= now)
  const q = `${SUPABASE_URL}/rest/v1/subscriptions`;
    + `?status=eq.active&soroban_subscription_id=not.is.null`
    + `&next_charge_at=lte.${now}`
    + `&select=id,soroban_contract_id,soroban_subscription_id,next_charge_at,charges_done,max_periods`;
  const r = await fetch(q, { headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` } });
  if (!r.ok) die(`supabase query ${r.status}: ${await r.text()}`);
  return r.json();
}

async function autocharge(relayer, contractId, nonceHex) {
  const nonce = Buffer.from(nonceHex.replace(/^0x/, ""), "hex");
  if (nonce.length !== 32) throw new Error(`bad nonce length ${nonce.length}`);
  const c = new Contract(contractId);
  const src = await server.getAccount(relayer.publicKey());
  const tx = new TransactionBuilder(src, { fee: String(Number(BASE_FEE) * 100), networkPassphrase: PASSPHRASE })
    .addOperation(c.call("autocharge", xdr.ScVal.scvBytes(nonce)))
    .setTimeout(60).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`sim: ${sim.error}`);
  const assembled = rpc.assembleTransaction(tx, sim).build();
  assembled.sign(relayer);
  const sent = await server.sendTransaction(assembled);
  if (sent.status === "ERROR") throw new Error(`send: ${JSON.stringify(sent.errorResult ?? sent)}`);
  let res = await server.getTransaction(sent.hash);
  for (let i = 0; i < 40 && res.status === "NOT_FOUND"; i++) { await new Promise(r => setTimeout(r, 1000)); res = await server.getTransaction(sent.hash); }
  return { hash: sent.hash, status: res.status };
}

// Resolve the contract id for a subscription row. Returns { contractId } or { error }.
// Per-row override wins over the network-matched default; an invalid override is
// reported as a row error rather than falling back to the default.
function resolveContractId(s) {
  const override = s.soroban_contract_id;
  if (override != null && override !== "") {
    if (!isValidContractId(override))
      return { error: `invalid soroban_contract_id "${override}" (expected 56-char C... StrKey)` };
    return { contractId: override };
  }
  if (!CONFIG_DEFAULT_CONTRACT)
    return { error: `no soroban_contract_id on row and no configured ${NET_CONFIG_KEY} contract (set CONTRACT or a per-row soroban_contract_id)` };
  if (!isValidContractId(CONFIG_DEFAULT_CONTRACT))
    return { error: `configured ${NET_CONFIG_KEY} contract id is not a 56-char C... StrKey: "${CONFIG_DEFAULT_CONTRACT}"` };
  return { contractId: CONFIG_DEFAULT_CONTRACT };
}

async function main() {
  if (!IS_MAINNET && !CONFIG_DEFAULT_CONTRACT) {
    die(`No contract configured for network=${NET}. Set CONTRACT to a ${NET_CONFIG_KEY} contract id, ` +
      `or provide soroban_contract_id on every subscription row. ` +
      `No ${NET_CONFIG_KEY} default is bundled — a mainnet address must not be used here.`);
  }

  if (IS_MAINNET && DO_CHARGE && process.env.CONFIRM_MAINNET !== "1")
    die("Refusing to charge on mainnet without CONFIRM_MAINNET=1 (real money).");

  const due = await fetchDueSubscriptions();
  log(`due on-chain subscriptions: ${due.length} (network=${NET}, mode=${DO_CHARGE ? "CHARGE" : "DRY-RUN"})`);

  if (!DO_CHARGE) {
    for (const s of due) {
      const { contractId, error } = resolveContractId(s);
      if (error) log(`  - ${s.id} → ${error}`);
      else log(`  - ${s.id} → ${contractId} / ${s.soroban_subscription_id}`);
    }
    log("dry-run: set CHARGE=1 to actually charge.");
    return;
  }

  if (!RELAYER_SECRET) die("RELAYER_SECRET is required to charge.");
  const relayer = Keypair.fromSecret(RELAYER_SECRET);
  log(`relayer: ${relayer.publicKey()}`);

  let ok = 0, failed = 0;
  for (const s of due) {
    const { contractId, error } = resolveContractId(s);
    if (error) { failed++; log(`  - ${s.id} → skip: ${error}`); continue; }
    try {
      const { hash, status } = await autocharge(relayer, contractId, s.soroban_subscription_id);
      if (status === "SUCCESS") { ok++; log(`  - ${s.id} → ok ${EXPLORER}${hash}`); }
      else { failed++; log(`  - ${s.id} → ${status} ${EXPLORER}${hash}`); }
    } catch (e) { failed++; log(`  - ${s.id} → error: ${e.message}`); }
  }
  log(`result: ${ok} ok, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => die(e.stack || String(e)));
