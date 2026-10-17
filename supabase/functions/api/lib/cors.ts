// Canonical CORS policy configuration (Issue #212)
// Defines the single source of truth for allowed HTTP methods and request headers
// read across all API endpoints, proxy routes, and middleware.

export const CORS_ALLOW_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

export const CORS_ALLOW_HEADERS = [
  "authorization",
  "content-type",
  "x-forwarded-for",
  "x-real-ip",
  "x-client-id",
  "x-api-key",
  "x-slippay-signature",
  "idempotency-key",
] as const;
