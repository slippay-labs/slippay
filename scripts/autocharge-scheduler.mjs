#!/usr/bin/env node
// Autonomous recurring-debit scheduler. Queries due on-chain subscriptions and
// fires autocharge(id) for each — signed by a RELAYER account that only pays the
// XLM fee (never custodies funds; money moves buyer→merchant via the standing
// SEP-41 allowance the buyer approved once). This is the off-chain half of v0.2.
//
// Mechanism proven end-to-end on testnet 2026-06-03 (autocharge tx 40e19a7a…),
// relayer-sourced, no buyer signature.
//
// SAFE BY DEFAULT: dry-run (lists due subs, charges nothing). To actually charge:
//   CHARGE=1  (and CONFIRM_MAINNET=1 when STELLAR_NETWORK=mainnet — real money).
//
// Run (cron, e.g. every 10 min):
//   STELLAR_NETWORK=mainnet \
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
//   RELAYER_SECRET=S… \
//   CHARGE=1 CONFIRM_MAINNET=1 \
//   NODE_PATH=apps/web/node_modules node scripts/autocharge-scheduler.mjs

import { fileURLToPath } from "node:url";
import * as S from "../apps/web/node_modules/@stellar/stellar-sdk/lib/index.js";
const { rpc, Keypair, Networks, TransactionBuilder, Contract, nativeToScVal, scValToNative, xdr, BASE_FEE } = S;

const NET = (process.env.STELLAR_NETWORK || "testnet").toLowerCase();
const IS_MAINNET = NET === "mainnet" || NET === "public";
const PASSPHRASE = IS_MAINNET ? Networks.PUBLIC : Networks.TESTNET;
const RPC_URL = process.env.RPC || (IS_MAINNET ? "https://soroban-mainnet.stellar.org" : "https://soroban-testnet.stellar.org");

export const MAINNET_DEFAULT_CONTRACT =
  process.env.SLIPPAY_SUBSCRIPTION_CONTRACT_MAINNET ||
  "CD2RFNOLMIKZN4EETDCGULGMD4ANS56IIUDIBLOE24P4JRZM2GCVFV2U";

export function resolveDefaultContract(network = process.env.STELLAR_NETWORK, envContract = process.env.CONTRACT) {
  if (envContract && envContract.trim()) {
    return envContract.trim();
  }
  const net = (network || "testnet").toLowerCase();
  const isMainnet = net === "mainnet" || net === "public";
  if (isMainnet) {
    return MAINNET_DEFAULT_CONTRACT;
  }
  return process.env.SLIPPAY_SUBSCRIPTION_CONTRACT_TESTNET || process.env.CONTRACT_TESTNET || null;
}

export function isValidContractId(id) {
  return typeof id === "string" && /^C[A-Z2-7]{55}$/.test(id);
}

export function resolveSubscriptionContract(sub, network = NET, defaultContract = null) {
  const directId = sub?.soroban_contract_id?.trim();
  const resolved = directId || defaultContract;
  if (!resolved) {
    return {
      ok: false,
      error: "missing_contract",
      reason: `no contract configured for network ${network} (set CONTRACT or SLIPPAY_SUBSCRIPTION_CONTRACT_TESTNET)`,
    };
  }
  if (!isValidContractId(resolved)) {
    return {
      ok: false,
      error: "invalid_contract_id",
      reason: `"${resolved}" is not a valid 56-character C... StrKey`,
    };
  }
  return { ok: true, contractId: resolved };
}

export const BASE_BACKOFF_SECONDS = 600; // 10 minutes (matches cron cadence)
export const MAX_BACKOFF_SECONDS = 86400; // 24 hours max backoff

export function computeBackoff(consecutiveFailures, baseSeconds = BASE_BACKOFF_SECONDS, maxSeconds = MAX_BACKOFF_SECONDS) {
  const count = Math.max(1, Number(consecutiveFailures) || 1);
  const factor = Math.pow(2, count - 1);
  const backoff = Math.min(baseSeconds * factor, maxSeconds);
  return Math.round(backoff);
}

export function isTerminalError(errorMessage, status) {
  if (!errorMessage && !status) return false;
  const msg = String(errorMessage || status).toLowerCase();
  return (
    msg.includes("maxperiodsreached") ||
    msg.includes("error(contract, #5)") ||
    msg.includes("error(contract, 5)") ||
    msg.includes("expired") ||
    msg.includes("error(contract, #6)") ||
    msg.includes("error(contract, 6)") ||
    msg.includes("notactive") ||
    msg.includes("error(contract, #3)") ||
    msg.includes("error(contract, 3)") ||
    msg.includes("mandate expired")
  );
}

export function computeNextChargeAt(nowMs, periodSeconds, contractNextDue) {
  if (contractNextDue != null && Number(contractNextDue) > 0) {
    return new Date(Number(contractNextDue) * 1000).toISOString();
  }
  const period = Number(periodSeconds) > 0 ? Number(periodSeconds) : 86400;
  return new Date(nowMs + period * 1000).toISOString();
}

export function isUnderBackoff(sub, now = new Date()) {
  if (!sub?.metadata?.next_retry_at) return false;
  const retryAt = new Date(sub.metadata.next_retry_at);
  return !isNaN(retryAt.getTime()) && retryAt > now;
}

export function extractChargedResult(res, scValToNativeFn = scValToNative, xdrModule = xdr) {
  if (!res) return { chargesDone: null, nextDue: null };

  // 1. Check resultMetaXdr events
  if (res.resultMetaXdr && xdrModule && scValToNativeFn) {
    try {
      const meta = xdrModule.TransactionMeta.fromXDR(res.resultMetaXdr, "base64");
      const sorobanMeta = meta.v3?.()?.sorobanMeta?.();
      const events = sorobanMeta?.events?.() || [];
      for (const evt of events) {
        const topics = evt.body?.()?.v0?.()?.topics?.()?.map((t) => {
          try { return scValToNativeFn(t); } catch { return null; }
        });
        if (topics && topics[0] === "subscription_charged") {
          const data = scValToNativeFn(evt.body().v0().data());
          // Contract event: (id, amount, charges_done, next_due)
          if (Array.isArray(data) && data.length >= 3) {
            const cd = Number(data[2]);
            const nextDue = data[3] != null ? Number(data[3]) : null;
            return {
              chargesDone: isNaN(cd) ? null : cd,
              nextDue: isNaN(nextDue) ? null : nextDue,
            };
          }
        }
      }
    } catch {
      // ignore parsing failure and fall back
    }
  }

  // 2. Check returnValue (u64 next_due from autocharge)
  if (res.returnValue && scValToNativeFn) {
    try {
      const ret = scValToNativeFn(res.returnValue);
      const nd = Number(ret);
      if (!isNaN(nd) && nd > 0) {
        return { chargesDone: null, nextDue: nd };
      }
    } catch {
      // ignore
    }
  }

  return { chargesDone: null, nextDue: null };
}

const DEFAULT_CONTRACT = resolveDefaultContract(NET);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RELAYER_SECRET = process.env.RELAYER_SECRET;
const DO_CHARGE = process.env.CHARGE === "1";
const EXPLORER = `https://stellar.expert/explorer/${IS_MAINNET ? "public" : "testnet"}/tx/`;

const server = new rpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith("http://") });
const log = (...a) => console.log(...a);
const die = (m) => { console.error("✗ " + m); process.exit(1); };

export async function fetchDueSubscriptions(supabaseUrl = SUPABASE_URL, serviceKey = SERVICE_KEY, fetchFn = fetch) {
  if (!supabaseUrl || !serviceKey) die("SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required to find due subs.");
  const now = new Date().toISOString();
  // active, on-chain bound, and due (next_charge_at <= now)
  const q = `${supabaseUrl}/rest/v1/subscriptions` +
    `?status=eq.active&soroban_subscription_id=not.is.null` +
    `&next_charge_at=lte.${now}` +
    `&select=id,soroban_contract_id,soroban_subscription_id,next_charge_at,charges_done,max_periods,period_seconds,metadata`;
  const r = await fetchFn(q, { headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` } });
  if (!r.ok) die(`supabase query ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function updateSubscriptionRow(subId, patch, supabaseUrl = SUPABASE_URL, serviceKey = SERVICE_KEY, fetchFn = fetch) {
  if (!supabaseUrl || !serviceKey) {
    throw new Error("SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required to update subscription.");
  }
  const url = `${supabaseUrl}/rest/v1/subscriptions?id=eq.${subId}`;
  const r = await fetchFn(url, {
    method: "PATCH",
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      "content-type": "application/json",
      prefer: "return=representation",
    },
    body: JSON.stringify(patch),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`supabase PATCH error ${r.status}: ${text}`);
  }
  const data = await r.json().catch(() => []);
  return data?.[0] ?? patch;
}

export async function autocharge(relayer, contractId, nonceHex) {
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
  for (let i = 0; i < 40 && res.status === "NOT_FOUND"; i++) {
    await new Promise(r => setTimeout(r, 1000));
    res = await server.getTransaction(sent.hash);
  }
  return {
    hash: sent.hash,
    status: res.status,
    returnValue: res.returnValue,
    resultMetaXdr: res.resultMetaXdr,
  };
}

export async function processSubscription(sub, relayer, options = {}) {
  const {
    network = NET,
    defaultContract = DEFAULT_CONTRACT,
    autochargeFn = autocharge,
    updateSubscriptionFn = updateSubscriptionRow,
    supabaseUrl = SUPABASE_URL,
    serviceKey = SERVICE_KEY,
    now = new Date(),
  } = options;

  // 1. Backoff check: if still in backoff, skip this tick
  if (isUnderBackoff(sub, now)) {
    return {
      action: "skipped_backoff",
      id: sub.id,
      next_retry_at: sub.metadata.next_retry_at,
      failures: sub.metadata.consecutive_charge_failures,
    };
  }

  // 2. Resolve contract
  const res = resolveSubscriptionContract(sub, network, defaultContract);
  if (!res.ok) {
    const consecutiveFailures = (sub.metadata?.consecutive_charge_failures || 0) + 1;
    const backoffSeconds = computeBackoff(consecutiveFailures);
    const nextRetryAt = new Date(now.getTime() + backoffSeconds * 1000).toISOString();
    const patch = {
      metadata: {
        ...(sub.metadata || {}),
        last_charge_attempt_at: now.toISOString(),
        consecutive_charge_failures: consecutiveFailures,
        next_retry_at: nextRetryAt,
        last_charge_error: `${res.error}: ${res.reason}`,
      },
    };
    await updateSubscriptionFn(sub.id, patch, supabaseUrl, serviceKey);
    return { action: "failed", id: sub.id, error: res.error, reason: res.reason, nextRetryAt };
  }

  const contractId = res.contractId;

  // 3. Attempt autocharge
  let chargeResult;
  try {
    chargeResult = await autochargeFn(relayer, contractId, sub.soroban_subscription_id);
  } catch (err) {
    const errMsg = err?.message ?? String(err);
    if (isTerminalError(errMsg)) {
      const patch = {
        status: "expired",
        metadata: {
          ...(sub.metadata || {}),
          last_charge_attempt_at: now.toISOString(),
          last_charge_error: errMsg,
          expired_at: now.toISOString(),
          expire_reason: "terminal_contract_error",
        },
      };
      await updateSubscriptionFn(sub.id, patch, supabaseUrl, serviceKey);
      return { action: "expired", id: sub.id, error: errMsg };
    }

    // Transient failure: back off, NEVER advance next_charge_at
    const consecutiveFailures = (sub.metadata?.consecutive_charge_failures || 0) + 1;
    const backoffSeconds = computeBackoff(consecutiveFailures);
    const nextRetryAt = new Date(now.getTime() + backoffSeconds * 1000).toISOString();
    const patch = {
      metadata: {
        ...(sub.metadata || {}),
        last_charge_attempt_at: now.toISOString(),
        consecutive_charge_failures: consecutiveFailures,
        next_retry_at: nextRetryAt,
        last_charge_error: errMsg,
      },
    };
    await updateSubscriptionFn(sub.id, patch, supabaseUrl, serviceKey);
    return { action: "failed", id: sub.id, error: errMsg, nextRetryAt };
  }

  // 4. Handle result
  if (chargeResult.status === "SUCCESS") {
    const extracted = extractChargedResult(chargeResult);
    const resolvedChargesDone = extracted.chargesDone != null
      ? extracted.chargesDone
      : (Number(sub.charges_done) || 0) + 1;

    const nextChargeAtIso = computeNextChargeAt(
      now.getTime(),
      sub.period_seconds,
      extracted.nextDue
    );

    const isMaxPeriodsReached =
      sub.max_periods != null &&
      sub.max_periods > 0 &&
      resolvedChargesDone >= sub.max_periods;

    const patch = {
      last_charge_at: now.toISOString(),
      next_charge_at: nextChargeAtIso,
      charges_done: resolvedChargesDone,
      metadata: {
        ...(sub.metadata || {}),
        last_charge_success_at: now.toISOString(),
        last_charge_tx: chargeResult.hash,
        consecutive_charge_failures: 0,
        next_retry_at: null,
        last_charge_error: null,
      },
    };

    if (isMaxPeriodsReached) {
      patch.status = "expired";
    }

    await updateSubscriptionFn(sub.id, patch, supabaseUrl, serviceKey);
    return {
      action: isMaxPeriodsReached ? "success_expired" : "success",
      id: sub.id,
      hash: chargeResult.hash,
      charges_done: resolvedChargesDone,
      next_charge_at: nextChargeAtIso,
    };
  } else {
    const statusMsg = chargeResult.status || "unknown_status";
    if (isTerminalError(statusMsg)) {
      const patch = {
        status: "expired",
        metadata: {
          ...(sub.metadata || {}),
          last_charge_attempt_at: now.toISOString(),
          last_charge_error: statusMsg,
          expired_at: now.toISOString(),
        },
      };
      await updateSubscriptionFn(sub.id, patch, supabaseUrl, serviceKey);
      return { action: "expired", id: sub.id, error: statusMsg };
    }

    // Transient failure: back off, leave next_charge_at unchanged
    const consecutiveFailures = (sub.metadata?.consecutive_charge_failures || 0) + 1;
    const backoffSeconds = computeBackoff(consecutiveFailures);
    const nextRetryAt = new Date(now.getTime() + backoffSeconds * 1000).toISOString();
    const patch = {
      metadata: {
        ...(sub.metadata || {}),
        last_charge_attempt_at: now.toISOString(),
        consecutive_charge_failures: consecutiveFailures,
        next_retry_at: nextRetryAt,
        last_charge_error: statusMsg,
      },
    };
    await updateSubscriptionFn(sub.id, patch, supabaseUrl, serviceKey);
    return { action: "failed", id: sub.id, status: statusMsg, nextRetryAt };
  }
}

async function main() {
  if (IS_MAINNET && DO_CHARGE && process.env.CONFIRM_MAINNET !== "1")
    die("Refusing to charge on mainnet without CONFIRM_MAINNET=1 (real money).");

  const due = await fetchDueSubscriptions();
  log(`due on-chain subscriptions: ${due.length} (network=${NET}, mode=${DO_CHARGE ? "CHARGE" : "DRY-RUN"})`);
  if (!due.length) return;

  if (!DO_CHARGE) {
    for (const s of due) {
      const backoffInfo = isUnderBackoff(s) ? ` · [BACKOFF until ${s.metadata.next_retry_at}]` : "";
      log(`  [dry-run] sub ${s.id} · nonce ${String(s.soroban_subscription_id).slice(0, 12)}… · due ${s.next_charge_at} · ${s.charges_done}/${s.max_periods || "∞"}${backoffInfo}`);
    }
    log("Set CHARGE=1 to fire autocharge for each (relayer-signed).");
    return;
  }

  if (!RELAYER_SECRET) die("RELAYER_SECRET required to charge.");
  const relayer = Keypair.fromSecret(RELAYER_SECRET);
  log(`relayer (fee payer, not buyer): ${relayer.publicKey()}\n`);

  let ok = 0, fail = 0, skipped = 0, expired = 0;
  for (const s of due) {
    const outcome = await processSubscription(s, relayer, {
      network: NET,
      defaultContract: DEFAULT_CONTRACT,
    });
    if (outcome.action === "success") {
      ok++;
      log(`✓ sub ${s.id} → charged tx ${EXPLORER}${outcome.hash} · next_charge_at=${outcome.next_charge_at} · charges_done=${outcome.charges_done}`);
    } else if (outcome.action === "success_expired") {
      ok++;
      expired++;
      log(`✓ sub ${s.id} → charged & marked expired (max_periods reached) · tx ${EXPLORER}${outcome.hash}`);
    } else if (outcome.action === "expired") {
      expired++;
      log(`⚰ sub ${s.id} → marked expired: ${outcome.error}`);
    } else if (outcome.action === "skipped_backoff") {
      skipped++;
      log(`⏳ sub ${s.id} → skipped (in backoff until ${outcome.next_retry_at}, failures=${outcome.failures})`);
    } else {
      fail++;
      log(`✗ sub ${s.id} → ${outcome.error || outcome.status} (retrying with backoff after ${outcome.nextRetryAt})`);
    }
  }
  log(`\ndone: ${ok} charged (${expired} expired), ${fail} failed, ${skipped} skipped in backoff.`);
}

export { main };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(e => { console.error("FAILED:", e?.message ?? e); process.exit(1); });
}
