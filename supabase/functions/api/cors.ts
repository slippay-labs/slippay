// CORS middleware for the SlinPay API.
//
// The allowlist is derived from the route table (routes.ts), which is the
// single source of truth for the methods and headers the API actually reads.
// Adding a route with a new header or method automatically extends the
// allowlist, so the middleware can never drift from the routes.

import { allowedHeaders, allowedMethods } from "./routes.ts";

export const CORS_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": allowedMethods().join(", "),
  "Access-Control-Allow-Headers": allowedHeaders().join(", "),
  "Access-Control-Max-Age": "86400",
};

/**
 * Apply the CORS headers to a response. Used by the edge function on
 * every response, including the preflight OPTIONS response.
 */
export function withCors(headers: HeadersInit = {}): HeadersInit {
  return { ...CORS_HEADERS, ...headers };
}

/**
 * Handle a CORS preflight request. Returns true if the request was a
 * preflight and the response has been written.
 */
export function handlePreflight(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;
  return new Response(null, { status: 204, headers: withCors() });
}
