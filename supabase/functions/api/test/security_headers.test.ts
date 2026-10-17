import { assertEquals, assertMatch, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { req } from "./_helpers.ts";
import { DEFAULT_CSP, DEFAULT_PERMISSIONS_POLICY } from "../middleware/security_headers.ts";

Deno.test("Security Headers - baseline headers present on responses", async () => {
  const res = await req("/health");
  assertEquals(res.status, 200);

  // 1. MIME sniffing defense
  assertEquals(res.headers.get("x-content-type-options"), "nosniff");

  // 2. Referrer policy
  assertEquals(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");

  // 3. Clickjacking defense
  assertEquals(res.headers.get("x-frame-options"), "DENY");

  // 4. Cross-Origin-Opener-Policy
  assertEquals(res.headers.get("cross-origin-opener-policy"), "same-origin");

  // 5. Permissions-Policy
  assertEquals(res.headers.get("permissions-policy"), DEFAULT_PERMISSIONS_POLICY);
  assertMatch(res.headers.get("permissions-policy") || "", /camera=\(self\)/);
  assertMatch(res.headers.get("permissions-policy") || "", /microphone=\(\)/);

  // 6. Content-Security-Policy baseline report-only mode
  assertEquals(res.headers.get("content-security-policy-report-only"), DEFAULT_CSP);
  assertEquals(res.headers.get("content-security-policy"), "frame-ancestors 'none';");
});

Deno.test("Security Headers - HSTS added when x-forwarded-proto is https", async () => {
  // Plain HTTP request should not have HSTS
  const httpRes = await req("/health");
  assertEquals(httpRes.headers.get("strict-transport-security"), null);

  // HTTPS forwarded request must include HSTS
  const httpsRes = await req("/health", {
    headers: {
      "x-forwarded-proto": "https",
    },
  });
  assertEquals(httpsRes.status, 200);
  assertEquals(
    httpsRes.headers.get("strict-transport-security"),
    "max-age=63072000; includeSubDomains; preload"
  );
});

Deno.test("Security Headers - CSP enforce mode when CSP_ENFORCE=true", async () => {
  Deno.env.set("CSP_ENFORCE", "true");
  try {
    const res = await req("/health");
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-security-policy"), DEFAULT_CSP);
    assertEquals(res.headers.get("content-security-policy-report-only"), null);
  } finally {
    Deno.env.delete("CSP_ENFORCE");
  }
});
