import type { Context, Next } from "hono";

export const DEFAULT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https:",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "connect-src 'self' https: wss:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self' https:",
].join("; ");

export const DEFAULT_PERMISSIONS_POLICY = [
  "camera=(self)",
  "publickey-credentials-get=(self)",
  "microphone=()",
  "geolocation=()",
  "payment=(self)",
].join(", ");

/**
 * Global HTTP Security Headers middleware (Issue #185).
 * Enforces defense-in-depth headers on all API routes, static assets, and SPA responses:
 * - X-Content-Type-Options: nosniff
 * - Referrer-Policy: strict-origin-when-cross-origin
 * - X-Frame-Options: DENY
 * - Permissions-Policy (camera for scanner, webauthn for passkeys)
 * - Cross-Origin-Opener-Policy: same-origin
 * - Strict-Transport-Security on HTTPS connections
 * - Content-Security-Policy / Content-Security-Policy-Report-Only
 */
export async function securityHeadersMiddleware(c: Context, next: Next) {
  await next();

  // 1. Mandatory MIME sniffing protection
  c.header("x-content-type-options", "nosniff");

  // 2. Prevent token/referrer leakage across origins
  c.header("referrer-policy", "strict-origin-when-cross-origin");

  // 3. Clickjacking defense
  c.header("x-frame-options", "DENY");

  // 4. Isolation against cross-origin openers
  c.header("cross-origin-opener-policy", "same-origin");

  // 5. Restrict browser device feature access
  c.header("permissions-policy", DEFAULT_PERMISSIONS_POLICY);

  // 6. Content Security Policy
  const enforceCsp = Deno.env.get("CSP_ENFORCE") === "true";
  if (enforceCsp) {
    c.header("content-security-policy", DEFAULT_CSP);
  } else {
    c.header("content-security-policy-report-only", DEFAULT_CSP);
    // Baseline clickjacking frame-ancestors enforcement
    c.header("content-security-policy", "frame-ancestors 'none';");
  }

  // 7. HSTS on HTTPS or forwarded HTTPS traffic
  const url = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto") ?? url.protocol.replace(":", "");
  if (proto === "https") {
    c.header("strict-transport-security", "max-age=63072000; includeSubDomains; preload");
  }
}
