import { Horizon } from "@stellar/stellar-sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { matchPaymentToOrder, type StellarPaymentEvent } from "./matcher.js";
import { reconcileMatch } from "./reconciler.js";
import { log } from "./log.js";
import { NETWORK } from "@slippay/shared";

const HORIZON: Record<"TESTNET" | "PUBLIC", string> = {
  TESTNET: NETWORK.testnet.horizon,
  PUBLIC:  NETWORK.mainnet.horizon,
};

const POLL_MS = Number(process.env.LISTENER_POLL_MS ?? "4000");
const PAGE_LIMIT = 200;
const ALIVE_LOG_MS = 60_000;
// How many ledgers we will backfill when re-deriving a cursor after a reset.
// Horizon closes ledgers about every 5s and keeps history for a few days;
// a bounded window keeps a reset from replaying the entire chain.
const BACKFILL_LEDGERS = Number(process.env.LISTENER_BACKFILL_LEDDERS ?? "17280"); // ~1 day at 5s/ledger

// Horizon returns a cursor error when the paging token is invalid, pruned,
// or too old. The SDK surfaces this as an HTTP error with a status and a
// message that mentions the cursor. Detect it explicitly so we can reset
// instead of stalling forever on the same bad token.
function isCursorError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const any = e as any;
  const status = any.response?.status ?? any.status ?? any.statusCode;
  const msg = String(any.message ?? any.response?.data?.detail ?? any.response?.data ?? "").toLowerCase();
  // Horizon responds 400 with "cursor" in the detail for an invalid/pruned
  // paging token. Also catch the generic "paging token" wording.
  if (typeof status === "number" && status >= 400 && status < 500 && /cursor|paging token/.test(msg)) return true;
  // Some SDK versions wrap the detail in a nested extras object.
  const detail = String(any.response?.data?.extras?.reason ?? "").toLowerCase();
  if (/cursor|paging token/.test(detail)) return true;
  return false;
}

export interface AccountWatcherDeps {
  db: SupabaseClient;
  network: "TESTNET" | "PUBLIC";
  accountId: string;
}

// Polling watcher (replaces SSE .stream()). Horizon's streaming silently dies —
// the connection hangs with no `onerror`, no events, and no auto-reconnect, so a
// "online" listener stops confirming payments invisibly (observed 2026-06-26).
// Polling makes every tick a fresh HTTP GET: immune to silent-death, and a
// heartbeat log makes a stall reachable. Latency (~POLL_MS) is fine — x402 buyers
// poll for tens of seconds. One poller per account is still gated by the lease.
export async function watchAccount({ db, network, accountId }: AccountWatcherDeps): Promise<{ stop: () => void; reset: () => Promise<void> }> {
  const server = new Horizon.Server(HORIZON[network]);

  // Resume cursor + last-processed ledger + last poll time. If no cursor,
  // start at the current head so we don't replay history.
  const { data: stateRow } = await db
    .from("listener_state")
    .select("paging_token, last_ledger, last_polled_at")
    .eq("account_id", accountId)
    .maybeSingle();
  let cursor: string | undefined = stateRow?.paging_token ?? undefined;
  let lastLedger: number | null = (stateRow?.last_ledger as number | null) ?? null;
  if (!cursor) {
    try {
      const head = await server.payments().forAccount(accountId).order("desc").limit(1).call();
      cursor = head.records[0]?.paging_token;
    } catch (e) { log("error", "head_fetch_error", { account: accountId, error: String(e) }); }
  }

  log("info", "poller_open", { account: accountId, cursor: cursor ?? "head", pollMs: POLL_MS, lastLedger });

  // Re-derive the cursor from a safe ledger sequence when the persisted one
  // is invalid/pruned. We backfill at most BACKFILL_LEDGERS from the current
  // head. If the gap from the last successfully processed ledger exceeds the
  // window, payments may have been missed — alert for manual reconciliation.
  async function resetCursor(): Promise<void> {
    const head = await server.ledgers().order("desc").limit(1).call();
    const headLedger = head.records[0]?.sequence;
    if (!headLedger) throw new Error("head_ledger_unavailable");
    const safeLedger = Math.max(1, headLedger - BACKFILL_LEDGERS);
    const gap = lastLedger !== null ? headLedger - lastLedger : null;
    if (gap !== null && gap > BACKFILL_LEDGERS) {
      // Reset would skip beyond the backfill window: payments may have been
      // missed. Emit a high-signal alert so operators reconcile manually.
      log("error", "cursor_reset_beyond_window", {
        account: accountId, headLedger, lastLedger, gap, backfillLedgers: BACKFILL_LEDGERS,
      });
    } else {
      log("warn", "cursor_reset", { account: accountId, headLedger, lastLedger, safeLedger });
    }
    // Find the first payment at or after the safe ledger to seed the cursor.
    // Horizon payments can be filtered by ledger via the `join()` or by
    // paging through the cursor derived from the ledger's paging token.
    const ledgerResp = await server.ledgers().ledger(safeLedger).call();
    const token = ledgerResp.paging_token;
    if (!token) throw new Error("safe_ledger_token_unavailable");
    cursor = token;
    await db.from("listener_state").upsert({
      account_id: accountId,
      paging_token: cursor,
      last_ledger: lastLedger,
      last_polled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  async function processRecord(raw: any): Promise<void> {
    if (raw.type !== "payment") return;
    const tx = await raw.transaction();
    const ev: StellarPaymentEvent = {
      memo_type: tx.memo_type,
      memo_b64: tx.memo ?? "",
      successful: tx.successful,
      asset_code: raw.asset_code,
      asset_issuer: raw.asset_issuer,
      to: raw.to,
      amount: raw.amount,
      hash: raw.transaction_hash,
    };
    const memoHex = ev.memo_type === "hash" ? Buffer.from(ev.memo_b64, "base64").toString("hex") : "";
    if (!memoHex) return;
    // The recipient lives on merchants.stellar_address (NOT on orders); the fee
    // is on the order (fallback to the merchant's). Selecting a non-existent
    // orders.merchant_stellar_address made this query fail and silently dropped
    // every match — the real cause of x402 non-confirmation (2026-06-26).
    const { data: order } = await db.from("orders")
      .select("id, merchant_id, memo, usdc_amount, platform_fee_bp, merchants ( stellar_address, platform_fee_bp )")
      .eq("memo", memoHex)
      .eq("status", "pending")
      .maybeSingle();
    if (order) {
      // PostgREST embeds a many-to-one relation as an object, but some setups
      // return a single-element array — handle both so stellar_address resolves.
      const mraw = (order as any).merchants;
      const merchant = (Array.isArray(mraw) ? mraw[0] : mraw) as { stellar_address: string; platform_fee_bp: number } | undefined;
      const orderForMatch = {
        id: order.id as string,
        merchant_id: order.merchant_id as string,
        memo: order.memo as string,
        // numeric columns come back as JS numbers; the matcher's stellarToStroops
        // needs a string (it .split()s) — coerce or it throws -> "amount_parse".
        usdc_amount: String(order.usdc_amount),
        merchant_stellar_address: merchant?.stellar_address as string,
        platform_fee_bp: ((order as any).platform_fee_bp ?? merchant?.platform_fee_bp ?? 0) as number,
      };
      const outcome = matchPaymentToOrder(ev, orderForMatch, network);
      await reconcileMatch(db, orderForMatch, outcome, ev.hash);
      log("info", "match_outcome", {
        account: accountId, hash: ev.hash, order_id: orderForMatch.id,
        outcome: outcome.outcome, reason: (outcome as any).reason ?? null,
        to: ev.to, pinned: orderForMatch.merchant_stellar_address, fee_bp: orderForMatch.platform_fee_bp,
      });
    }
  }

  let stopped = false;
  let lastAliveLog = 0;
  let consecutiveErrors = 0;
  // Guard so a cursor reset is not attempted on every tick while Horizon is
  // unavailable. Only one reset in flight at a time.
  let resetting = false;

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      let builder = server.payments().forAccount(accountId).order("asc").limit(PAGE_LIMIT);
      if (cursor) builder = builder.cursor(cursor);
      const page = await builder.call();
      for (const raw of page.records) {
        await processRecord(raw);
        cursor = raw.paging_token;
        // Track the last ledger we successfully processed so a future reset
        // can detect whether it would skip beyond the backfill window.
        if (typeof raw.ledger === "number") lastLedger = raw.ledger;
        await db.from("listener_state").upsert({
          account_id: accountId,
          paging_token: cursor,
          last_ledger: lastLedger,
          last_polled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }
      // Even an empty page is a successful poll — record the poll time so a
      // stall is detectable after the fact.
      if (page.records.length === 0) {
        await db.from("listener_state").upsert({
          account_id: accountId,
          paging_token: cursor,
          last_ledger: lastLedger,
          last_polled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }
      consecutiveErrors = 0;
      const now = Date.now();
      if (now - lastAliveLog > ALIVE_LOG_MS) {
        log("info", "poller_alive", { account: accountId, cursor: cursor ?? "head", lastLedger });
        lastAliveLog = now;
      }
    } catch (e) {
      consecutiveErrors++;
      // An invalid/pruned cursor is external state that can be invalidated.
      // Detect it explicitly and re-derive the cursor from a safe ledger
      // instead of stalling forever on the same bad token.
      if (isCursorError(e) && !resetting) {
        resetting = true;
        try {
          await resetCursor();
          consecutiveErrors = 0;
        } catch (re) {
          log("error", "cursor_reset_failed", { account: accountId, error: String(re) });
        } finally {
          resetting = false;
        }
        return;
      }
      log("error", "poll_error", { account: accountId, error: String(e), consecutive: consecutiveErrors });
    }
  }

  const iv = setInterval(() => { void tick(); }, POLL_MS);
  void tick();

  return {
    stop: () => { stopped = true; clearInterval(iv); },
    // Exposed for tests and operators to force a reset outside the error path.
    reset: async () => { await resetCursor(); },
  };
}
