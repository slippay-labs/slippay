import type { SupabaseClient } from "@supabase/supabase-js";
import type { MatchOutcome, OrderForMatch } from "./matcher.js";
import { log } from "./log.js";

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

  const orderPatch: Record<string, unknown> = {
    status: newStatus,
    tx_hash: txHash,
    paid_at: newStatus === "paid" ? new Date().toISOString() : null,
  };
  if (outcome.outcome === "paid") {
    if (outcome.received !== undefined) orderPatch.received_usdc = outcome.received;
    if (outcome.surplus !== undefined) orderPatch.surplus_usdc = outcome.surplus;
  } else if (outcome.outcome === "underpaid") {
    if (outcome.received !== undefined) orderPatch.received_usdc = outcome.received;
  }

  const { data, error } = await db.from("orders")
    .update(orderPatch)
    .eq("id", order.id)
    .in("status", allowedPriorStatuses)
    .select("*").single();

  if (error || !data) {
    log("warn", "reconcile_skipped", { order_id: order.id, error: error?.message ?? "no_pending_row" });
    return;
  }

  const subscriptionId: string | null = data.subscription_id ?? null;

  // If this order was generated from a subscription and was successfully paid,
  // bump charges_done. If it hits max_periods, expire the subscription.
  if (subscriptionId && newStatus === "paid") {
    const { data: sub, error: subFetchErr } = await db.from("subscriptions")
      .select("charges_done, max_periods, status").eq("id", subscriptionId).maybeSingle();
    if (sub && !subFetchErr) {
      const nextCount = (sub.charges_done ?? 0) + 1;
      const reachedMax = sub.max_periods != null && nextCount >= sub.max_periods;
      const patch: Record<string, unknown> = {
        charges_done: nextCount,
        last_charge_at: new Date().toISOString(),
      };
      if (reachedMax) patch.status = "expired";
      const { error: subUpdErr } = await db.from("subscriptions")
        .update(patch).eq("id", subscriptionId);
      if (subUpdErr) {
        log("error", "subscription_update_failed", { subscription_id: subscriptionId, error: subUpdErr.message });
      }
    }
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
      ...(outcome.outcome === "paid" && outcome.surplus !== undefined ? {
        expected: outcome.expected ?? data.usdc_amount,
        received: outcome.received ?? data.usdc_amount,
        surplus: outcome.surplus,
      } : {}),
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
    surplus: (outcome as any).surplus ?? null,
  });
}
