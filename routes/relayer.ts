import { Router, type Request, type Response, type NextFunction } from "express";
import { getClientIp } from "../lib/client_ip";
import { issueDeployToken, verifyDeployToken } from "../lib/deploy_token";
import { relayerBudget } from "../lib/relayer_budget";

/**
 * Relayer routes.
 *
 * POST /v1/relayer/deploy deploys a smart-wallet contract and transfers a
 * demo float into the new wallet. Both operations cost sponsor funds, so the
 * endpoint is authenticated and budgeted:
 *
 *   1. Per-IP rate limit (outer layer).
 *   2. Single-use deploy token bound to the passkey public key.
 *   3. Per-day XLM float budget across the whole relayer.
 */

export interface RelayerDependencies {
  /** Deploy a smart-wallet contract for the given passkey public key. */
  deployWallet(passkeyPubKey: string): Promise<{ walletAddress: string; deployFeeStrops: number }>;
  /** Transfer the demo float into the new wallet. */
  transferFloat(walletAddress: string, amountStrops: number): Promise<{ txHash: string }>;
}

const FUND_AMOUNT_STROPS = Number(process.env.FUND_AMOUNT ?? "2000000");

/**
 * Simple token-bucket rate limiter keyed by client IP.
 */
interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

const RATE_CAPACITY = 12;
const RATE_REFILL_PER_SEC = 0.1;
const buckets = new Map<string, Bucket>();

function takeToken(key: string): boolean {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: RATE_CAPACITY, lastRefillMs: now };
    buckets.set(key, b);
  }
  const elapsedSec = (now - b.lastRefillMs) / 1000;
  b.tokens = Math.min(RATE_CAPACITY, b.tokens + elapsedSec * RATE_REFILL_PER_SEC);
  b.lastRefillMs = now;
  if (b.tokens < 1) {
    return false;
  }
  b.tokens -= 1;
  return true;
}

export function _resetRateLimiterForTest(): void {
  buckets.clear();
}

export function createRelayerRouter(deps: RelayerDependencies): Router {
  const router = Router();

  /**
   * GET /info -- issue a short-lived, single-use deploy token bound to the
   * passkey public key the client intends to deploy.
   */
  router.get("/info", (req: Request, res: Response) => {
    const passkeyPubKey = String(req.query.passkeyPubKey ?? "");
    if (!passkeyPubKey) {
      res.status(400).json({ error: "missing_passkey_pub_key" });
      return;
    }
    try {
      const token = issueDeployToken(passkeyPubKey);
      res.json({
        token: token.token,
        expiresAt: token.expiresAt,
        passkeyPubKey: token.passkeyPubKey,
        budget: relayerBudget.state(),
      });
    } catch (err) {
      res.status(400).json({ error: "bad_request", message: (err as Error).message });
    }
  });

  /**
   * POST /v1/relayer/deploy -- deploy a smart-wallet and fund it with the demo
   * float. Requires a valid deploy token bound to the request's passkey pub
   * key, and a reservation from the daily XLM float budget.
   */
  router.post("/v1/relayer/deploy", async (req: Request, res: Response, _next: NextFunction) => {
    // 1. Outer layer: per-IP rate limit.
    const ip = getClientIp(req);
    if (!takeToken(ip)) {
      res.set("Retry-After", "10");
      res.status(429).json({ error: "rate_limited", reason: "rate_limited" });
      return;
    }

    // 2. Authentication: verify the single-use deploy token and bind it to the
    //    passkey public key in the request.
    const body = (req.body ?? {}) as {
      passkeyPubKey?: unknown;
      deployToken?: unknown;
    };
    const passkeyPubKey = typeof body.passkeyPubKey === "string" ? body.passkeyPubKey : "";
    const deployToken = typeof body.deployToken === "string" ? body.deployToken : "";

    if (!passkeyPubKey || !deployToken) {
      res.status(401).json({ error: "unauthorized", reason: "missing_credentials" });
      return;
    }

    const verification = verifyDeployToken(deployToken, passkeyPubKey);
    if (!verification.ok) {
      res.status(401).json({ error: "unauthorized", reason: verification.reason ?? "invalid_token" });
      return;
    }

    // 3. Budget: reserve the float from the daily XLM ceiling before spending.
    const reservation = relayerBudget.reserve(FUND_AMOUNT_STROPS);
    if (!reservation.ok) {
      res.status(429).json({
        error: "budget_exhausted",
        reason: reservation.reason,
        budget: reservation.state,
      });
      return;
    }

    // 4. Deploy the wallet and transfer the float. On any failure we release
    //    the reservation so the budget reflects actual spend.
    let walletAddress: string;
    let deployFeeStrops: number;
    try {
      const deployed = await deps.deployWallet(passkeyPubKey);
      walletAddress = deployed.walletAddress;
      deployFeeStrops = deployed.deployFeeStrops;
    } catch (err) {
      relayerBudget.release(FUND_AMOUNT_STROPS);
      res.status(502).json({ error: "deploy_failed", message: (err as Error).message });
      return;
    }

    let txHash: string;
    try {
      const transferred = await deps.transferFloat(walletAddress, FUND_AMOUNT_STROPS);
      txHash = transferred.txHash;
    } catch (err) {
      // The wallet is deployed but the float did not land; release the budget
      // reservation so it can be reused.
      relayerBudget.release(FUND_AMOUNT_STROPS);
      res.status(502).json({
        error: "transfer_failed",
        walletAddress: walletAddress,
        message: (err as Error).message,
      });
      return;
    }

    // 5. Log each funded wallet so the daily spend is reconcilable against the
    //    sponsor account.
    console.log(
      JSON.stringify({
        event: "relayer_deploy_funded",
        walletAddress,
        passkeyPubKey,
        deployFeeStrops,
        fundAmountStrops: FUND_AMOUNT_STROPS,
        txHash,
        day: reservation.state.day,
        spentStrops: reservation.state.spentStrops,
        capStrops: reservation.state.capStrops,
        clientIp: ip,
      }),
    );

    res.json({
      walletAddress: walletAddress,
      txHash: txHash,
      fundAmountStrops: FUND_AMOUNT_STROPS,
      deployFeeStrops: deployFeeStrops,
      budget: reservation.state,
    });
  });

  return router;
}

export default createRelayerRouter;
