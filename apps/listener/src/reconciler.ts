import type { SupabaseClient } from "@supabase/supabase-js";
import type { MatchOutcome, OrderForMatch } from "./matcher.js";
import { log } from "./log.js";

/**
 * Atomically bumps `charges_done` for a subscription with optimistic concurrency
 * control (Audit-003 L11 / Issue #489). Prevents lost updates when concurrent
 * payments or duplicate reconciliation runs process the same subscription.
 * When `charges_done` reaches `max_periods`, sets `status = 'expired'`.
 */
export async function bumpSubscriptionCharges(
  db: SupabaseClient,
  subscriptionId: string,
  maxRetries = 5,
): Promise<{ charges_done: number; status: string } | null> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const { data: sub, error: subFetchErr } = await db
      .from("subscriptions")
      .select("charges_done, max_periods, status")
      .eq("id", subscriptionId)
      .maybeSingle();

    if (subFetchErr || !sub) {
      if (subFetchErr) {
        log("error", "subscription_fetch_failed", {
          subscription_id: subscriptionId,
          error: subFetchErr.message,
        });
      }
      return null;
    }

    const currentCount = (sub.charges_done as number | null) ?? 0;
    const nextCount = currentCount + 1;
    const reachedMax = sub.max_periods != null && nextCount >= (sub.max_periods as number);

    const patch: Record<string, unknown> = {
      charges_done: nextCount,
      last_charge_at: new Date().toISOString(),
    };
    if (reachedMax) {
      patch.status = "expired";
    }

    let updateQuery = db
      .from("subscriptions")
      .update(patch)
      .eq("id", subscriptionId);

    if (sub.charges_done === null || sub.charges_done === undefined) {
      // In Supabase query builder, if .is is supported use it; or check equality
      updateQuery = typeof (updateQuery as any).is === "function"
        ? (updateQuery as any).is("charges_done", null)
        : updateQuery.eq("charges_done", null);
    } else {
      updateQuery = updateQuery.eq("charges_done", currentCount);
    }

    const { data: updatedSub, error: subUpdErr } = await updateQuery
      .select("charges_done, status")
      .maybeSingle();

    if (subUpdErr) {
      log("error", "subscription_update_failed", {
        subscription_id: subscriptionId,
        error: subUpdErr.message,
      });
      return null;
    }

    if (updatedSub) {
      return {
        charges_done: (updatedSub as any).charges_done,
        status: (updatedSub as any).status,
      };
    }

    log("info", "subscription_charges_bump_retry", {
      subscription_id: subscriptionId,
      attempt,
      currentCount,
    });
  }

  log("error", "subscription_charges_bump_max_retries_exceeded", {
    subscription_id: subscriptionId,
  });
  return null;
}

export async function reconcileMatch(
  db: SupabaseClient,
  order: OrderForMatch & { merchant_id: string },
  outcome: MatchOutcome,
  txHash: string,
) {
  if (outcome.outcome === "ignore") return;

  const newStatus = outcome.outcome === "paid" ? "paid" : "underpaid";

  // Allow underpaid → paid transition (audit-003 L3). Without this, a partial
  // payment followed by a top-up leaves the order stuck in underpaid forever
  // and silently drops the second event. The transition matrix here is
  // explicit: only forward transitions, never backward.
  const allowedPriorStatuses = newStatus === "paid"
    ? ["pending", "underpaid"]
    : ["pending"];

  const { data, error } = await db.from("orders")
    .update({ status: newStatus, tx_hash: txHash, paid_at: newStatus === "paid" ? new Date().toISOString() : null })
    .eq("id", order.id)
    .in("status", allowedPriorStatuses)
    .select("*").single();

  if (error || !data) {
    log("warn", "reconcile_skipped", { order_id: order.id, error: error?.message ?? "no_pending_row" });
    return;
  }

  const subscriptionId: string | null = data.subscription_id ?? null;

  // If this order was generated from a subscription and was successfully paid,
  // bump charges_done atomically. If it hits max_periods, expire the subscription.
  if (subscriptionId && newStatus === "paid") {
    await bumpSubscriptionCharges(db, subscriptionId);
  }

  const payload = {
    type: outcome.outcome === "paid"
      ? (subscriptionId ? "subscription.charged" : "order.paid")
      : "order.underpaid",
    data: {
      id: order.id,
      subscription_id: subscriptionId,
      external_ref: data.external_ref,
      brl_amount: data.brl_amount,
      usdc_amount: data.usdc_amount,
      tx_hash: txHash,
      memo: order.memo,
      paid_at: data.paid_at,
      ...(outcome.outcome === "underpaid" ? { expected: outcome.expected, received: outcome.received } : {}),
    },
  };

  const { error: webhookError } = await db.from("webhook_deliveries").insert({
    order_id: order.id,
    type: payload.type,
    payload,
  });

  if (webhookError) {
    // 23505 = unique_violation. With the partial unique index on
    // webhook_deliveries(order_id, type) for terminal types, duplicate
    // inserts on Horizon stream replay are expected and silent (audit-003 L3).
    const code = (webhookError as { code?: string }).code;
    if (code === "23505") {
      log("info", "webhook_insert_dedup", { order_id: order.id, type: payload.type });
    } else {
      log("error", "webhook_insert_failed", { order_id: order.id, error: webhookError.message });
    }
  }

  log("info", "order_reconciled", {
    order_id: order.id,
    subscription_id: subscriptionId,
    status: newStatus,
    tx_hash: txHash,
  });
}
