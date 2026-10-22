function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}
function numOr(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid env ${name}: ${raw}`);
  return n;
}
const rawNetwork = (process.env.STELLAR_NETWORK ?? "TESTNET").toUpperCase() as "TESTNET" | "PUBLIC";

export const config = {
  supabaseUrl: need("SUPABASE_URL"),
  supabaseServiceRoleKey: need("SUPABASE_SERVICE_ROLE_KEY"),
  network: rawNetwork,
  // The merchants.network column stores "testnet" | "mainnet" (lowercase). The
  // listener must only watch merchants on the SAME network it streams, or it
  // tries to stream a testnet address against mainnet Horizon (or vice-versa)
  // and the stream errors forever. Map the Stellar-facing shape to that column.
  merchantNetwork: rawNetwork === "TESTNET" ? "testnet" : "mainnet",
  // Fail-closed gating flag: anything not explicitly TESTNET is treated as
  // mainnet. `network` keeps its Stellar-facing "TESTNET" | "PUBLIC" shape (used
  // by horizon/manager); this flag is the one the SSRF guard keys off of so a
  // PUBLIC network can never silently disable the webhook blocklist (audit-003).
  isMainnet: rawNetwork !== "TESTNET",
  // Dev-only escape hatch. When "1", permits http/localhost/RFC1918 webhook
  // targets so local mock servers work in tests. NEVER set in production.
  allowLocalWebhooks: (process.env.ALLOW_LOCAL_WEBHOOKS ?? "") === "1",
  merchantPollMs: Number(process.env.MERCHANT_POLL_MS ?? "30000"),
  // Horizon cursor reset recovery. When a stream cursor is rejected as
  // invalid/pruned, the listener re-derives it from the last persisted
  // ledger (or a recent ledger if none is known) and backfills forward.
  // cursorResetLookbackLedgers is the maximum gap the backfill will cover;
  // a reset that would skip further than this raises an alert for manual
  // reconciliation (payments may have been missed).
  cursorResetLookbackLedgers: numOr("CURSOR_RESET_LOOKBACK_LEDGERS", 120),
  // How many ledgers behind the current tip to start a fresh stream when no
  // last-processed ledger is known. Keeps the restart window bounded.
  cursorResetFromTipLedgers: numOr("CURSOR_RESET_FROM_TIP_LEDGERS", 12),
};
