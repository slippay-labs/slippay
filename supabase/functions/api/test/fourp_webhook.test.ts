import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { req } from "./_helpers.ts";
import { redactSensitiveQueryParams } from "../routes/fourp.ts";

Deno.test("redactSensitiveQueryParams - redacts credentials from query strings", () => {
  assertEquals(
    redactSensitiveQueryParams("https://api.slippay.cc/api/v1/4p/webhook?token=sensitive_token_abc"),
    "/api/v1/4p/webhook?token=%5BREDACTED%5D",
  );

  assertEquals(
    redactSensitiveQueryParams("/v1/4p/webhook?notification_token=secret123&client_id=comex_42"),
    "/v1/4p/webhook?notification_token=%5BREDACTED%5D&client_id=comex_42",
  );

  assertEquals(
    redactSensitiveQueryParams("/v1/4p/webhook?safe_param=hello"),
    "/v1/4p/webhook?safe_param=hello",
  );
});

Deno.test("POST /v1/4p/webhook - rejects credentials supplied solely via query parameters", async () => {
  const prevKey = Deno.env.get("FOURP_API_KEY");
  Deno.env.set("FOURP_API_KEY", "mock_fourp_api_key");

  try {
    // Query param `token` with no body must return 400 missing_token
    const res1 = await req("/v1/4p/webhook?token=secret_in_query", {
      method: "POST",
    });
    assertEquals(res1.status, 400);
    const body1 = await res1.json();
    assertEquals(body1, { error: "missing_token" });

    // Query param `notification_token` with empty json body must also return 400 missing_token
    const res2 = await req("/v1/4p/webhook?notification_token=secret_in_query_2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assertEquals(res2.status, 400);
    const body2 = await res2.json();
    assertEquals(body2, { error: "missing_token" });
  } finally {
    if (prevKey === undefined) {
      Deno.env.delete("FOURP_API_KEY");
    } else {
      Deno.env.set("FOURP_API_KEY", prevKey);
    }
  }
});

Deno.test("POST /v1/4p/webhook - parses token correctly from body shapes", async () => {
  // When token is provided via body, it passes missing_token validation.
  // In unconfigured state (no FOURP_API_KEY), route reaches ramp_disabled check (503).
  const testPayloads = [
    { token: "body_token_1" },
    { notification_token: "body_token_2" },
    { notificationToken: "body_token_3" },
  ];

  for (const payload of testPayloads) {
    const res = await req("/v1/4p/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    // Should NOT be 400 missing_token
    assertEquals(res.status === 400, false);
  }
});
