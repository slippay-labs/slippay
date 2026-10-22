/**
 * Per-day XLM float budget for the relayer.
 *
 * The budget is denominated in strops and is global across the relayer, not
 * per-IP. This is the hard ceiling on how much sponsor funds the deploy endpoint
 * can move in a single day.
 */

export interface BudgetState {
  /** Day key (UTC YYYY-MM-DD). */
  day: string;
  /** Strops already spent today. */
  spentStrops: number;
  /** Configured ceiling in strops. */
  capStrops: number;
  /** Remaining strops. */
  remainingStrops: number;
}

export interface ReserveResult {
  ok: boolean;
  reason?: "budget_exhausted";
  state: BudgetState;
}

export interface ReleaseResult {
  state: BudgetState;
}

function dayKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function readCapStrops(): number {
  const raw = process.env.RELAYER_DAILY_FLOAT_CAP_STROPS;
  if (!raw) {
    // Default: 100 XLM per day (100 * 10^7 strops).
    return 100 * 10_7;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid RELAYER_DAILY_FLOAT_CAP_STROPS: ${raw}`);
  }
  return Math.floor(n);
}

/**
 * In-memory budget tracker. In a multi-instance deployment this should be
 * backed by a shared store; the interface is kept small so it can be swapped
 * out without changing callers.
 */
class RelayerBudget {
  private day: string;
  private spentStrops: number;
  private capStrops: number;

  constructor() {
    this.day = dayKey();
    this.spentStrops = 0;
    this.capStrops = readCapStrops();
  }

  private rolloverIfNeeded(): void {
    const today = dayKey();
    if (today !== this.day) {
      this.day = today;
      this.spentStrops = 0;
      this.capStrops = readCapStrops();
    }
  }

  state(): BudgetState {
    this.rolloverIfNeeded();
    return {
      day: this.day,
      spentStrops: this.spentStrops,
      capStrops: this.capStrops,
      remainingStrops: Math.max(0, this.capStrops - this.spentStrops),
    };
  }

  /**
   * Reserve strops from the daily budget. Returns false with reason
   * "budget_exhausted" if the reservation would exceed the cap.
   */
  reserve(strops: number): ReserveResult {
    if (!Number.isFinite(strops) || strops < 0) {
      throw new Error(`Invalid reserve amount: ${strops}`);
    }
    this.rolloverIfNeeded();
    const next = this.spentStrops + strops;
    if (next > this.capStrops) {
      return { ok: false, reason: "budget_exhausted", state: this.state() };
    }
    this.spentStrops = next;
    return { ok: true, state: this.state() };
  }

  /** Release a previously reserved amount (e.g. on failure). */
  release(strops: number): ReleaseResult {
    if (!Number.isFinite(strops) || strops < 0) {
      throw new Error(`Invalid release amount: ${strops}`);
    }
    this.rolloverIfNeeded();
    this.spentStrops = Math.max(0, this.spentStrops - strops);
    return { state: this.state() };
  }

  /** Test hook: reset the budget to zero for today. */
  _resetForTest(): void {
    this.day = dayKey();
    this.spentStrops = 0;
    this.capStrops = readCapStrops();
  }
}

export const relayerBudget = new RelayerBudget();
