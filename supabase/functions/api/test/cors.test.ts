import { assertEquals, assert, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { ALLOWED_ORIGINS_SET } from "@slippay/shared";
import { CORS_ALLOW_METHODS, CORS_ALLOW_HEADERS } from "../lib/cors.ts";

function createCorsApp() {
  const app = new Hono();
  app.use(
    "*",
    cors({
      origin: (origin) => (origin && ALLOWED_ORIGINS_SET.has(origin)) ? origin : "",
      allowMethods: [...CORS_ALLOW_METHODS],
      allowHeaders: [...CORS_ALLOW_HEADERS],
    }),
  );
  app.get("/test", (c) => c.text("ok"));
  app.post("/test", (c) => c.text("created"));
  app.put("/test", (c) => c.text("updated"));
  app.delete("/test", (c) => c.text("deleted"));
  return app;
}

Deno.test("CORS single source of truth exports comprehensive methods and headers", () => {
  assert(CORS_ALLOW_METHODS.includes("GET"));
  assert(CORS_ALLOW_METHODS.includes("POST"));
  assert(CORS_ALLOW_METHODS.includes("PUT"));
  assert(CORS_ALLOW_METHODS.includes("PATCH"));
  assert(CORS_ALLOW_METHODS.includes("DELETE"));
  assert(CORS_ALLOW_METHODS.includes("OPTIONS"));

  assert(CORS_ALLOW_HEADERS.includes("authorization"));
  assert(CORS_ALLOW_HEADERS.includes("content-type"));
  assert(CORS_ALLOW_HEADERS.includes("x-forwarded-for"));
  assert(CORS_ALLOW_HEADERS.includes("x-real-ip"));
  assert(CORS_ALLOW_HEADERS.includes("x-client-id"));
  assert(CORS_ALLOW_HEADERS.includes("x-api-key"));
  assert(CORS_ALLOW_HEADERS.includes("x-slippay-signature"));
  assert(CORS_ALLOW_HEADERS.includes("idempotency-key"));
});

Deno.test("CORS preflight succeeds for allowed origin across all HTTP methods", async () => {
  const app = createCorsApp();
  const allowedOrigin = "http://localhost:5173";

  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    const res = await app.request("/test", {
      method: "OPTIONS",
      headers: {
        origin: allowedOrigin,
        "access-control-request-method": method,
      },
    });

    assertEquals(res.status, 204);
    assertEquals(res.headers.get("access-control-allow-origin"), allowedOrigin);
    const allowMethods = res.headers.get("access-control-allow-methods") ?? "";
    assert(allowMethods.includes(method));
  }
});

Deno.test("CORS preflight succeeds for all API request headers", async () => {
  const app = createCorsApp();
  const allowedOrigin = "https://app.slippay.cc";
  const requestedHeaders = [
    "authorization",
    "content-type",
    "x-real-ip",
    "x-client-id",
    "x-api-key",
    "x-slippay-signature",
    "idempotency-key",
  ].join(", ");

  const res = await app.request("/test", {
    method: "OPTIONS",
    headers: {
      origin: allowedOrigin,
      "access-control-request-method": "POST",
      "access-control-request-headers": requestedHeaders,
    },
  });

  assertEquals(res.status, 204);
  assertEquals(res.headers.get("access-control-allow-origin"), allowedOrigin);
  const allowedHeadersHeader = res.headers.get("access-control-allow-headers")?.toLowerCase() ?? "";
  assert(allowedHeadersHeader.includes("authorization"));
  assert(allowedHeadersHeader.includes("content-type"));
  assert(allowedHeadersHeader.includes("idempotency-key"));
  assert(allowedHeadersHeader.includes("x-slippay-signature"));
});

Deno.test("CORS preflight rejects untrusted origin", async () => {
  const app = createCorsApp();
  const res = await app.request("/test", {
    method: "OPTIONS",
    headers: {
      origin: "https://malicious-phishing-site.com",
      "access-control-request-method": "POST",
    },
  });

  // Untrusted origin must not get allow-origin reflected
  assertNotEquals(res.headers.get("access-control-allow-origin"), "https://malicious-phishing-site.com");
});
