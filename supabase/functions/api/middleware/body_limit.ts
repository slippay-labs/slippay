import type { Context, Next } from "hono";

export const DEFAULT_JSON_BODY_LIMIT = 64 * 1024; // 64 KB default for standard JSON API routes
export const DEFAULT_WEBHOOK_PROXY_BODY_LIMIT = 1024 * 1024; // 1 MB limit for webhook proxy routes (e.g. /shopify/*)

export interface BodyLimitOptions {
  maxBytes?: number;
}

/**
 * Middleware that strictly bounds request body sizes on incoming requests (Audit-004, issue #188).
 * 1. Fast-path: checks Content-Length header against maxBytes.
 * 2. Streaming cap: if Content-Length is missing or forged, streams chunks up to maxBytes.
 *    If bytes read exceed maxBytes, aborts immediately and returns 413 Payload Too Large
 *    without invoking downstream route handlers.
 */
export function bodyLimit(options?: BodyLimitOptions) {
  const maxBytes = options?.maxBytes ?? DEFAULT_JSON_BODY_LIMIT;

  return async (c: Context, next: Next) => {
    // GET, HEAD, OPTIONS do not carry request bodies
    if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      return next();
    }

    // 1. Content-Length header pre-check
    const clHeader = c.req.header("content-length");
    if (clHeader) {
      const declaredLen = parseInt(clHeader, 10);
      if (!Number.isNaN(declaredLen) && declaredLen > maxBytes) {
        return c.json({ error: "payload_too_large" }, 413);
      }
    }

    // If there is no request body, proceed
    const rawBody = c.req.raw.body;
    if (!rawBody) {
      return next();
    }

    // 2. Stream-level cap: guard against omitted or forged Content-Length
    const reader = rawBody.getReader();
    const chunks: Uint8Array[] = [];
    let bytesRead = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          bytesRead += value.byteLength;
          if (bytesRead > maxBytes) {
            await reader.cancel();
            return c.json({ error: "payload_too_large" }, 413);
          }
          chunks.push(value);
        }
      }
    } catch (_err) {
      return c.json({ error: "bad_request" }, 400);
    }

    // Reconstruct full body as a single buffer
    const merged = new Uint8Array(bytesRead);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }

    // Reconstruct request with the buffered body so downstream route can read it
    const newReq = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers: c.req.raw.headers,
      body: merged,
    });
    c.req.raw = newReq;

    return next();
  };
}
