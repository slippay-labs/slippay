import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import { config } from "./config.js";

const SCHEMA = process.env.SLIPPAY_DB_SCHEMA ?? "public";

// Cast to the default-generic SupabaseClient so consumers (watchAccount,
// startWebhookWorker, reconcileMatch, etc.) receive a uniformly-typed
// client regardless of which schema we routed it at runtime.
//
// `transport: ws` is required on Node < 22 (no native WebSocket); supabase-js
// 2.105+ throws at construction otherwise even though the listener never uses
// realtime.
export const db: SupabaseClient = createClient(
  config.supabaseUrl,
  config.supabaseServiceRoleKey,
  {
    auth: { persistSession: false },
    db: { schema: SCHEMA },
    realtime: { transport: WebSocket as unknown as never },
  },
) as unknown as SupabaseClient;

// Database CHECK constraint for the fee column. The `numeric` column type
// permits fractional values (e.g. 297.5), which would later throw a
// RangeError in `BigInt(10_000 - platform_fee_bp)`. Enforcing integrality
// at the storage layer prevents the invalid state from being persisted.
//
// This is the migration that must be applied to the database:
//
//   ALTER TABLE orders
//     ADD CONSTRAINT orders_platform_fee_bp_integer
//     CHECK (platform_fee_bp = trunc(platform_fee_bp));
//
// The check is exposed here so the listener can assert its presence at
// startup and so tests can reference the exact constraint expression.
export const PLATFORM_FEE_BP_INTEGER_CHECK =
  "platform_fee_bp = trunc(platform_fee_bp)";

/**
 * Returns true when the database enforces integral `platform_fee_bp`.
 * Used as a startup assertion so a missing migration fails loud rather
 * than silently allowing fractional fee basis-points to reach the matcher.
 */
export async function hasPlatformFeeBpIntegerCheck(): Promise<boolean> {
  const { data, error } = await db
    .from("pg_constraints")
    .select("constraint_name, check_clause")
    .eq("conrelid", "orders")
    .like("constraint_name", "%platform_fee_bp%");

  if (error) {
    throw new Error(
      `pg_constraints lookup failed: ${error.message}`,
    );
  }

  return (data ?? []).some((row) => {
    const clause = (row as { check_clause: string | null }).check_clause;
    return typeof clause === "string" && clause.replace(/\s/g, "").includes("trunc(platform_fee_bp)");
  });
}
