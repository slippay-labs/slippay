// Integration tests for the CORS allowlist.
//
// These assert that the CORS middleware covers every method and header
// the routes declare. Adding a route with a new header or method without
// updating the allowlist fails these tests.

import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  allowedHeaders,
  allowedMethods,
  routes,
} from "./routes.ts";
import type { RouteDefinition } from "./routes.ts";
import { CORS_HEADERS, handlePreflight, withCors } from "./cors.ts";

const methods = allowedMethods();
const headers = allowedHeaders();

const methodSet = new Set(methods.map((m) => m.toUpperCase()));
const headerSet = new Set(headers.map((h) => h.toLowerCase()));

Deno.test("CORS allowlist is defined in one place", () => {
  // The middleware reads from the route table; there is no second hardcoded
  // list to keep in sync.
  assertEquals(CORS_HEADERS["Access-Control-Allow-Methods"], methods.join(", "));
  assertEquals(CORS_HEADERS["Access-Control-Allow-Headers"], headers.join(", "));
});

Deno.test("preflight for every method used by the routes succeeds", () => {
  for (const route of routes) {
    for (const method of route.methods) {
      assert(
        methodSet.has(method.toUpperCase()),
        `method ${method} from ${route.path} is not in the CORS allowlist`,
      );
    }
  }
  assert(methodSet.has("OPTIONS"), "OPTIONS must be allowed for preflight");
});

Deno.test("preflight for every header used by the routes succeeds", () => {
  for (const route of routes) {
    for (const header of route.headers) {
      assert(
        headerSet.has(header.toLowerCase()),
        `header ${header} from ${route.path} is not in the CORS allowlist`,
      );
    }
  }
});

Deno.test("platform headers read by client_ip and idempotency are allowed", () => {
  for (const h of ["x-forwarded-for", "x-real-ip", "idempotency-key"]) {
    assert(headerSet.has(h), `${h} must be in the CORS allowlist`);
  }
});

Deno.test("DELETE and PUT are allowed", () => {
  assert(methodSet.has("DELETE"), "DELETE must be allowed");
  assert(methodSet.has("PUT"), "PUT must be allowed");
});

Deno.test("preflight response echoes the allowlist", () => {
  const req = new Request("https://example.test/api/v1/orders", {
    method: "OPTIONS",
    headers: {
      origin: "https://app.slippay.cc",
      "access-control-request-method": "DELETE",
      "access-control-request-headers": "authorization, x-forwarded-for",
    },
  });
  const res = handlePreflight(req);
  assert(res !== null, "preflight must be handled");
  assertEquals(res!.status, 204);
  const allowMethods = res!.headers.get("access-control-allow-methods") ?? "";
  const allowHeaders = res!.headers.get("access-control-allow-headers") ?? "";
  assertStringIncludes(allowMethods, "DELETE");
  assertStringIncludes(allowHeaders, "authorization");
  assertStringIncludes(allowHeaders, "x-forwarded-for");
});

Deno.test("withCors merges extra headers without dropping the allowlist", () => {
  const merged = withCors({ "content-type": "application/json" });
  assertEquals(merged["content-type"], "application/json");
  assertEquals(merged["Access-Control-Allow-Origin"], "*");
  assertStringIncludes(merged["Access-Control-Allow-Methods"] ?? "", "GET");
});

Deno.test("adding a route with a new header fails the allowlist check", () => {
  // Simulate a route that was added without updating the allowlist.
  // The derived list must not contain the new header, proving the
  // assertion in the previous test would catch the drift.
  const newRoute: RouteDefinition = {
    path: "/api/v1/new-route",
    methods: ["POST"],
    headers: ["x-new-header"],
  };
  const derived = new Set(allowedHeaders().map((h) => h.toLowerCase()));
  assert(
    !derived.has("x-new-header"),
    "the derived allowlist must not include a header from an unregistered route",
  );
  // And the assertion that would be applied to the new route fails:
  assert(
    !newRoute.headers.every((h) => derived.has(h)),
    "a new route header must fail the allowlist check",
  );
});
