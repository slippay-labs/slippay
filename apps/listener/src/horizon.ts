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

// Max ledgers we consider within a safe automatic backfill window when resetting
// an invalid/pruned cursor (~5s per Stellar ledger -> 1000 ledgers ~ 83 minutes).
export const DEFAULT_BACKFILL_WINDOW_LEDGERS = Number(process.env.LISTENER_BACKFILL_WINDOW_LEDGERS ?? "1000");

/**
 * Extracts the 32-bit ledger sequence from a 64-bit Stellar operation/payment paging token.
 * Horizon paging tokens for operations encode `(ledger_sequence << 32) | (tx_index << 12) | op_index`.
 */
export function ledgerFromPagingToken(token: string): number | null {
  try {
    const rawBig = BigInt(token);
    const ledger = Number(rawBig >> 32n);
    return Number.isSafeInteger(ledger) && ledger > 0 ? ledger : null;
  } catch {
    return null;
  }
}

interface HorizonErrorLike {
  status?: number;
  response?: {
    status?: number;
    data?: {
      type?: string;
      title?: string;
      extras?: {
        invalid_field?: string;
      };
    };
  };
  message?: string;
}

/**
 * Determines whether an error thrown by Horizon indicates an invalid, stale,
 * or pruned cursor (e.g. 410 Gone, bad_request on cursor, before_history).
 */
export function isCursorError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const anyErr = e as HorizonErrorLike;
  const status = anyErr.status ?? anyErr.response?.status;
  if (status === 410) return true;

  const data = anyErr?.response?.data;
  if (data?.extras?.invalid_field === "cursor") return true;
  if (typeof data?.type === "string" && (data.type.includes("before_history") || data.type.includes("stale_history"))) return true;
  if (typeof data?.title === "string" && data.title.toLowerCase().includes("before history")) return true;

  const msg = String(anyErr?.message ?? "").toLowerCase();
  if (
    msg.includes("before_history") ||
    msg.includes("before history") ||
    msg.includes("stale_history") ||
    msg.includes("stale history") ||
    ((msg.includes("cursor") || msg.includes("paging token") || msg.includes("paging_token")) &&
      (msg.includes("invalid") || msg.includes("stale") || msg.includes("pruned") || msg.includes("gone")))
  ) {
    return true;
  }
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
// heartbeat log makes a stall visible. Latency (~POLL_MS) is fine — x402 buyers
// poll for tens of seconds. One poller per account is still gated by the lease.
export async function watchAccount({ db, network, accountId }: AccountWatcherDeps): Promise<() => void> {
  const server = new Horizon.Server(HORIZON[network]);

  // Resume cursor. If none, start at the current head so we don't replay history.
  const { data: stateRow } = await db
    .from("listener_state")
    .select("paging_token, last_ledger, last_poll_at")
    .eq("account_id", accountId)
    .maybeSingle();

  let cursor: string | undefined = stateRow?.paging_token ?? undefined;
  let lastLedger: number | null = stateRow?.last_ledger != null ? Number(stateRow.last_ledger) : null;
  if (cursor && !lastLedger) {
    lastLedger = ledgerFromPagingToken(cursor);
  }

  if (!cursor) {
    try {
      const head = await server.payments().forAccount(accountId).order("desc").limit(1).call();
      cursor = head.records[0]?.paging_token;
      if (cursor) {
        lastLedger = ledgerFromPagingToken(cursor);
      }
    } catch (e) {
      log("error", "head_fetch_error", { account: accountId, error: String(e) });
    }
  }

  log("info", "poller_open", { account: accountId, cursor: cursor ?? "head", pollMs: POLL_MS, lastLedger });

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

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      let builder = server.payments().forAccount(accountId).order("asc").limit(PAGE_LIMIT);
      if (cursor) builder = builder.cursor(cursor);
      const page = await builder.call();
      for (const raw of page.records) {
        await processRecord(raw);
        cursor = raw.paging_token;
        const recLedger = ledgerFromPagingToken(cursor);
        if (recLedger != null) {
          lastLedger = recLedger;
        }
        await db.from("listener_state").upsert({
          account_id: accountId,
          paging_token: cursor,
          last_ledger: lastLedger,
          last_poll_at: new Date().toISOString(),
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
      if (isCursorError(e)) {
        // Horizon reported cursor invalid, pruned, or before history!
        // Reset and re-derive cursor from head to keep the stream moving.
        log("warn", "horizon_cursor_invalid", {
          account: accountId,
          failedCursor: cursor,
          error: String(e),
        });

        try {
          const head = await server.payments().forAccount(accountId).order("desc").limit(1).call();
          const newHeadCursor = head.records[0]?.paging_token;
          const newLedger = newHeadCursor ? ledgerFromPagingToken(newHeadCursor) : null;

          if (lastLedger != null && newLedger != null) {
            const gap = newLedger - lastLedger;
            if (gap > DEFAULT_BACKFILL_WINDOW_LEDGERS) {
              // Reset skipped beyond the backfill window -> raise an alert
              log("alert", "cursor_reset_exceeded_backfill_window", {
                account: accountId,
                oldLedger: lastLedger,
                newLedger,
                gapLedgers: gap,
                backfillWindow: DEFAULT_BACKFILL_WINDOW_LEDGERS,
                message: "Horizon cursor reset skipped beyond backfill window; payments may require manual reconciliation",
              });
            } else {
              log("info", "cursor_reset_within_window", {
                account: accountId,
                oldLedger: lastLedger,
                newLedger,
                gapLedgers: gap,
              });
            }
          } else {
            log("alert", "cursor_reset_gap_unknown", {
              account: accountId,
              oldCursor: cursor,
              newCursor: newHeadCursor,
            });
          }

          cursor = newHeadCursor;
          if (newLedger != null) lastLedger = newLedger;

          if (cursor) {
            await db.from("listener_state").upsert({
              account_id: accountId,
              paging_token: cursor,
              last_ledger: lastLedger,
              last_poll_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });
          }
        } catch (recoverErr) {
          log("error", "cursor_recovery_failed", {
            account: accountId,
            error: String(recoverErr),
          });
        }
      } else {
        consecutiveErrors++;
        log("error", "poll_error", { account: accountId, error: String(e), consecutive: consecutiveErrors });
      }
    }
  }

  const iv = setInterval(() => { void tick(); }, POLL_MS);
  void tick();

  return () => { stopped = true; clearInterval(iv); };
}
