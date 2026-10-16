import type { SupabaseClient } from "@supabase/supabase-js";
import { watchAccount } from "./horizon.js";
import { log } from "./log.js";
import { config } from "./config.js";
import { acquireLease } from "./lease.js";

interface Active {
  stop: () => void;
  releaseLease: () => Promise<void>;
  getExpiresAt?: () => string;
  getLastPollAt?: () => string | null;
  getCursor?: () => string | undefined;
}

export interface AccountLeaseInfo {
  account_id: string;
  leased: boolean;
  lease_expires_at?: string;
  last_poll_at?: string;
  cursor?: string;
}

export interface ManagerInspection {
  desiredAccounts: string[];
  activeAccounts: string[];
  leases: AccountLeaseInfo[];
  lostLeases: string[];
}

export interface ManagerHandle {
  (): Promise<void>;
  getInspection: () => ManagerInspection;
}

export function startManager(db: SupabaseClient): ManagerHandle {
  const active = new Map<string, Active>();
  let desiredAccounts: string[] = [];
  const lostAccounts = new Set<string>();

  async function tick() {
    // Only watch merchants on the same network this listener streams (audit:
    // a testnet merchant left active would otherwise stream-error forever on a
    // mainnet listener). Fail-closed: a row with a null/other network is skipped.
    const { data, error } = await db.from("merchants").select("stellar_address").eq("active", true).eq("network", config.merchantNetwork).not("stellar_address", "is", null);
    if (error) { log("error", "manager_query_failed", { error: error.message }); return; }
    desiredAccounts = (data ?? []).map(r => r.stellar_address as string);
    const desired = new Set(desiredAccounts);

    for (const addr of desired) {
      if (!active.has(addr)) {
        // audit-003 L2: serialize watchAccount on a per-account lease so two
        // pods can never run Horizon streams against the same merchant.
        const lease = await acquireLease(db, addr);
        if (!lease.acquired) {
          log("info", "manager_lease_held_elsewhere", { addr, heldBy: lease.heldBy, expiresAt: lease.expiresAt });
          continue;
        }
        try {
          lease.onLost?.(() => {
            log("warn", "manager_lease_lost", { addr });
            lostAccounts.add(addr);
            const a = active.get(addr);
            if (a) {
              a.stop();
              active.delete(addr);
            }
          });
          const stop = await watchAccount({ db, network: config.network, accountId: addr });
          active.set(addr, {
            stop,
            releaseLease: lease.release,
            getExpiresAt: lease.getExpiresAt,
            getLastPollAt: () => (typeof (stop as any).getLastPollAt === "function" ? (stop as any).getLastPollAt() : undefined),
            getCursor: () => (typeof (stop as any).getCursor === "function" ? (stop as any).getCursor() : undefined),
          });
          log("info", "manager_started", { addr });
        } catch (e) {
          log("error", "manager_start_failed", { addr, error: String(e) });
          await lease.release();
        }
      }
    }
    for (const addr of [...active.keys()]) {
      if (!desired.has(addr)) {
        const a = active.get(addr);
        a?.stop();
        await a?.releaseLease();
        active.delete(addr);
        lostAccounts.delete(addr);
        log("info", "manager_stopped", { addr });
      }
    }
  }

  tick();
  const id = setInterval(tick, config.merchantPollMs);

  function getInspection(): ManagerInspection {
    const activeArr = Array.from(active.keys());
    const lostArr = Array.from(lostAccounts);

    const leases: AccountLeaseInfo[] = desiredAccounts.map((addr) => {
      const a = active.get(addr);
      if (a) {
        return {
          account_id: addr,
          leased: true,
          lease_expires_at: a.getExpiresAt?.(),
          last_poll_at: a.getLastPollAt?.() ?? undefined,
          cursor: a.getCursor?.() ?? undefined,
        };
      }
      return {
        account_id: addr,
        leased: false,
      };
    });

    return {
      desiredAccounts,
      activeAccounts: activeArr,
      leases,
      lostLeases: lostArr,
    };
  }

  const shutdown: ManagerHandle = Object.assign(
    async () => {
      clearInterval(id);
      for (const a of active.values()) {
        a.stop();
        await a.releaseLease();
      }
      active.clear();
    },
    {
      getInspection,
    },
  );

  return shutdown;
}
