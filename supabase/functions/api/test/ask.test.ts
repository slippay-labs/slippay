import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Hono } from "hono";
import askRoute, {
  MAX_SPAWNS_PER_DAY,
  getSpawnsToday,
  resetDailyBudget,
  refundSpawnReservation,
  tryReserveSpawn,
} from "../routes/ask.ts";

const app = new Hono();
app.route("/v1/ask", askRoute);

let ipCounter = 1;
function nextHeaders(extra: Record<string, string> = {}): Record<string, string> {
  ipCounter += 1;
  return {
    "x-forwarded-for": `192.168.1.${ipCounter}`,
    ...extra,
  };
}

Deno.test("ask route - daily spawn reservation and refund units", () => {
  resetDailyBudget(0);
  assertEquals(getSpawnsToday(), 0);

  // Reserve 1 slot
  const ok1 = tryReserveSpawn();
  assertEquals(ok1, true);
  assertEquals(getSpawnsToday(), 1);

  // Refund 1 slot
  refundSpawnReservation();
  assertEquals(getSpawnsToday(), 0);

  // Refund at 0 does not go negative
  refundSpawnReservation();
  assertEquals(getSpawnsToday(), 0);

  // Drive to ceiling
  resetDailyBudget(MAX_SPAWNS_PER_DAY);
  assertEquals(getSpawnsToday(), MAX_SPAWNS_PER_DAY);

  // Attempting to reserve when exhausted fails and does not increment
  const exhausted = tryReserveSpawn();
  assertEquals(exhausted, false);
  assertEquals(getSpawnsToday(), MAX_SPAWNS_PER_DAY);

  // Day rollover automatically resets quota
  resetDailyBudget(MAX_SPAWNS_PER_DAY, "2000-01-01");
  const rolledOver = tryReserveSpawn();
  assertEquals(rolledOver, true);
  assertEquals(getSpawnsToday(), 1);
});

Deno.test("ask route - rejects requests without valid origin before reserving slot", async () => {
  resetDailyBudget(0);

  // 1. Missing Origin and Referer -> 403 origin_required
  const reqNoOrigin = new Request("http://localhost/v1/ask", {
    method: "POST",
    headers: nextHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ question: "How does SlipPay work?" }),
  });
  const resNoOrigin = await app.request(reqNoOrigin);
  assertEquals(resNoOrigin.status, 403);
  const bodyNoOrigin = await resNoOrigin.json();
  assertEquals(bodyNoOrigin.error, "origin_required");
  assertEquals(getSpawnsToday(), 0, "no slot consumed for missing origin");

  // 2. Disallowed origin -> 403 origin_not_allowed
  const reqBadOrigin = new Request("http://localhost/v1/ask", {
    method: "POST",
    headers: nextHeaders({
      "content-type": "application/json",
      origin: "https://malicious-attacker.com",
    }),
    body: JSON.stringify({ question: "How does SlipPay work?" }),
  });
  const resBadOrigin = await app.request(reqBadOrigin);
  assertEquals(resBadOrigin.status, 403);
  const bodyBadOrigin = await resBadOrigin.json();
  assertEquals(bodyBadOrigin.error, "origin_not_allowed");
  assertEquals(getSpawnsToday(), 0, "no slot consumed for disallowed origin");
});

Deno.test("ask route - returns 429 with configured ceiling when daily quota is exhausted", async () => {
  // Drive budget to exhaustion
  resetDailyBudget(MAX_SPAWNS_PER_DAY);
  assertEquals(getSpawnsToday(), MAX_SPAWNS_PER_DAY);

  const req = new Request("http://localhost/v1/ask", {
    method: "POST",
    headers: nextHeaders({
      "content-type": "application/json",
      origin: "https://slippay.cc",
    }),
    body: JSON.stringify({ question: "What is the platform fee?" }),
  });

  const res = await app.request(req);
  assertEquals(res.status, 429);
  assertEquals(res.headers.get("retry-after"), "3600");

  const data = await res.json();
  assertEquals(data.error, "daily_limit_reached");
  assertEquals(data.ceiling, MAX_SPAWNS_PER_DAY);
  assertEquals(data.limit, MAX_SPAWNS_PER_DAY);
  assertEquals(getSpawnsToday(), MAX_SPAWNS_PER_DAY, "counter unchanged on rejection");
});

Deno.test("ask route - refunds reservation when request body is invalid JSON or empty question", async () => {
  resetDailyBudget(0);

  // 1. Invalid JSON body
  const reqBadJson = new Request("http://localhost/v1/ask", {
    method: "POST",
    headers: nextHeaders({
      "content-type": "application/json",
      origin: "https://slippay.cc",
    }),
    body: "not-json",
  });
  const resBadJson = await app.request(reqBadJson);
  assertEquals(resBadJson.status, 400);
  const dataBadJson = await resBadJson.json();
  assertEquals(dataBadJson.error, "invalid_json");
  assertEquals(getSpawnsToday(), 0, "slot refunded on JSON parse failure");

  // 2. Empty question
  const reqEmptyQ = new Request("http://localhost/v1/ask", {
    method: "POST",
    headers: nextHeaders({
      "content-type": "application/json",
      origin: "https://slippay.cc",
    }),
    body: JSON.stringify({ question: "   " }),
  });
  const resEmptyQ = await app.request(reqEmptyQ);
  assertEquals(resEmptyQ.status, 400);
  const dataEmptyQ = await resEmptyQ.json();
  assertEquals(dataEmptyQ.error, "invalid_question");
  assertEquals(getSpawnsToday(), 0, "slot refunded on empty question");
});

Deno.test("ask route - refunds reservation when spawn/engine fails before CLI starts", async () => {
  resetDailyBudget(0);

  // Token missing in environment -> askSlippayStream throws -> 503 service_unavailable
  Deno.env.delete("CLAUDE_CODE_OAUTH_TOKEN");
  Deno.env.delete("ANTHROPIC_API_KEY");

  const req = new Request("http://localhost/v1/ask", {
    method: "POST",
    headers: nextHeaders({
      "content-type": "application/json",
      origin: "https://slippay.cc",
    }),
    body: JSON.stringify({ question: "Tell me about non-custodial settlement" }),
  });

  const res = await app.request(req);
  assertEquals(res.status, 503);
  const data = await res.json();
  assertEquals(data.error, "service_unavailable");
  assertEquals(getSpawnsToday(), 0, "slot refunded when engine is unconfigured / spawn never happens");
});
