// Route table for the SlipPay API.
//
// This is the single source of truth for what the API exposes: the HTTP methods and the request headers that each route actually reads.
// The CORS allowlist is derived from this table (see cors.ts), so adding a route with a new header or method
// automatically extends the allowlist and the integration test catches any drift.

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE" | "OPTIONS";

export interface RouteDefinition {
  /** Path pattern (e.g. "/api/v1/orders"). */
  path: string;
  /** HTTP methods this route responds to. */
  methods: HttpMethod[];
  /**
   * Request headers the route reads from the incoming request.
   * All lowercase, as HTTP compares them case-insensitively and the browser
   * sends them lowercase in preflight.
   */
  headers: string[];
}

/**
 * Headers that are always present on browser-initiated requests and are
 * not controlled by the application. These are added to the allowlist
 * unconditionally because the browser will send them regardless of what
 * the route declares.
 */
export const INTRINSIC_HEADERS: readonly string[] = [
  "accept",
  "accept-language",
  "content-language",
  "origin",
  "referer",
];

/**
 * Headers the API reads that are not declared by a single route but are
 * produced by the edge/client-IP derivation layer (lib/client_ip.ts) and
 * the idempotency layer. Keeping them here makes the allowlist complete
 * without duplicating them on every route.
 */
export const PLATFORM_HEADERS: readonly string[] = [
  "x-forwarded-for",
  "x-real-ip",
  "idempotency-key",
];

/**
 * Route table. Every entry declares the methods and headers the route
 * actually consumes. The CORS middleware derives its allowlist from this.
 */
export const routes: readonly RouteDefinition[] = [
  {
    path: "/api/v1/orders",
    methods: ["GET", "POST"],
    headers: ["authorization", "content-type", "idempotency-key"],
  },
  {
    path: "/api/v1/orders/:id",
    methods: ["GET", "PATCH", "DELETE"],
    headers: ["authorization", "content-type"],
  },
  {
    path: "/api/v1/keys",
    methods: ["GET", "POST"],
    headers: ["authorization", "content-type", "idempotency-key"],
  },
  {
    path: "/api/v1/keys/:id",
    methods: ["DELETE", "PUT"],
    headers: ["authorization", "content-type"],
  },
  {
    path: "/api/v1/webhooks/slippay",
    methods: ["POST"],
    headers: [
      "content-type",
      "x-slippay-signature",
      "x-slippay-delivery",
      "x-slippay-event",
    ],
  },
  {
    path: "/api/v1/webhooks/slippay/:id",
    methods: ["POST"],
    headers: [
      "content-type",
      "x-slippay-signature",
      "x-slippay-delivery",
    ],
  },
];

/**
 * Derive the complete set of HTTP methods the API exposes.
 * OPTIONS is always included because it is the preflight method.
 */
export function allowedMethods(): string[] {
  const set = new Set<string>(["OPTIONS"]);
  for (const route of routes) {
    for (const m of route.methods) set.add(m);
  }
  return [...set].sort();
}

/**
 * Derive the complete set of request headers the API reads.
 */
export function allowedHeaders(): string[] {
  const set = new Set<string>();
  for (const h of INTRINSIC_HEADERS) set.add(h);
  for (const h of PLATFORM_HEADERS) set.add(h);
  for (const route of routes) {
    for (const h of route.headers) set.add(h);
  }
  return [...set].sort();
}
// End of route table. CORS allowlist is derived from allowedMethods/allowedHeaders.
