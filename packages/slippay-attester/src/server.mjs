#!/usr/bin/env node
// SlipPay integrity oracle — HTTP service (zero web deps, Node http).
// The chain-agnostic endpoint any rail calls before settling:
//   GET  /pubkey                     → public: the attester ed25519 key (register it via
//                                       the Soroban set_attester, or verify anywhere)
//   POST /register {agent_id, allowed_recipients, allowed_tools?, max_amount}
//                                     → authenticated: commits the agent's surface, binds
//                                       agent ownership to authenticated principal
//   POST /attest   {agent_id, subscription_id, charges_done, recipient, amount, tools_used?}
//                                     → authenticated: { ok, not_after, signature } | { ok:false, reason }
//                                       only the principal that owns the agent can request attestation
//   POST /verify   {subscription_id, charges_done, not_after, signature, pubkey}
//                                     → public: { valid }
//
// Authentication & Security Model:
//   - Writing endpoints (/register, /attest) require an authenticated principal passed via
//     'Authorization: Bearer <token>' or 'X-API-Key: <token>'. Requests lacking this are rejected (401).
//   - Each agent_id is bound to the principal that originally created its commitment.
//   - An agent cannot be re-registered or attested by any principal other than its owner (403 forbidden).
//   - CORS is strictly locked down to named origins configured via SLIPPAY_ATTESTER_ALLOWED_ORIGINS
//     (comma-separated list). No wildcard CORS is allowed.
//   - Key: SLIPPAY_ATTESTER_SECRET (64-hex / 32 bytes). Must be set in production.
//     Falling back to a dev seed requires explicit opt-in (SLIPPAY_ATTESTER_ALLOW_DEV_KEY=1)
//     and is strictly forbidden when NODE_ENV=production.

import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha256";
import { commitSurface, attest, verifyAttestation, publicKeyHex, hexToBytes } from "./oracle.mjs";

/**
 * Resolves the attester private key fail-closed.
 */
export function resolveAttesterSecret(env = process.env, warn = (msg) => process.stderr.write(msg)) {
  const secret = env.SLIPPAY_ATTESTER_SECRET;
  if (secret) {
    const raw = typeof secret === "string" ? secret.trim() : "";
    let bytes;
    try {
      bytes = hexToBytes(raw);
    } catch {
      throw new Error(`SLIPPAY_ATTESTER_SECRET must be a valid 64-hex character string (32 bytes)`);
    }
    if (bytes.length !== 32) {
      throw new Error(`SLIPPAY_ATTESTER_SECRET must decode to exactly 32 bytes (got ${bytes.length})`);
    }
    return { priv: bytes, isDev: false };
  }

  const allowDevKey = env.SLIPPAY_ATTESTER_ALLOW_DEV_KEY;
  const isDevOptIn = allowDevKey === "1" || allowDevKey === "true";
  const isProduction = env.NODE_ENV === "production";

  if (isProduction) {
    throw new Error(
      `SLIPPAY_ATTESTER_SECRET is required in production environment; dev signing key is refused`
    );
  }

  if (!isDevOptIn) {
    throw new Error(
      `SLIPPAY_ATTESTER_SECRET not set — an attester signing key is required. ` +
      `For local development only, set SLIPPAY_ATTESTER_ALLOW_DEV_KEY=1 to use the insecure fallback seed.`
    );
  }

  warn(
    `[WARNING] SLIPPAY_ATTESTER_SECRET not set. Using insecure fallback dev key because ` +
    `SLIPPAY_ATTESTER_ALLOW_DEV_KEY is set. DO NOT use this in production!\n`
  );
  return {
    priv: sha256(new TextEncoder().encode("slippay-attester-dev-seed")),
    isDev: true,
  };
}

/**
 * Authenticates request principal for writing endpoints.
 * Returns principal string if authenticated, or null if unauthenticated.
 */
export function authenticatePrincipal(req, env = process.env) {
  const authHeader = req.headers?.["authorization"] || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = (match ? match[1] : (req.headers?.["x-api-key"] || "")).trim();
  if (!token) return null;

  // 1. If key-to-principal map configured (JSON or token:principal pairs)
  const keysConfig = env.SLIPPAY_ATTESTER_API_KEYS;
  if (keysConfig) {
    try {
      const parsed = JSON.parse(keysConfig);
      if (parsed[token]) return String(parsed[token]).trim();
    } catch {
      for (const pair of keysConfig.split(",")) {
        const [tok, princ] = pair.split(":");
        if (tok?.trim() === token) return (princ || tok).trim();
      }
    }
    return null;
  }

  // 2. If single shared auth token configured
  const singleToken = env.SLIPPAY_ATTESTER_AUTH_TOKEN;
  if (singleToken) {
    if (token === singleToken.trim()) {
      return (req.headers?.["x-principal"] || "default-principal").trim();
    }
    return null;
  }

  // 3. Fallback: treat non-empty token directly as authenticated principal ID
  return token;
}

/**
 * Matches requested origin against allowed origins list.
 */
export function resolveCorsOrigin(req, allowedOrigins = []) {
  const origin = req.headers?.["origin"];
  if (!origin || !allowedOrigins.length) return null;
  const o = origin.toLowerCase().trim();
  const matched = allowedOrigins.find((item) => item.toLowerCase().trim() === o);
  return matched ? origin : null;
}

/**
 * Creates the attester HTTP server instance.
 */
export function createAttesterServer(options = {}) {
  const env = options.env || process.env;
  const warn = options.warn || ((msg) => process.stderr.write(msg));
  const { priv, isDev } = resolveAttesterSecret(env, warn);

  const rawOrigins = env.SLIPPAY_ATTESTER_ALLOWED_ORIGINS ?? "";
  const allowedOrigins = Array.isArray(rawOrigins)
    ? rawOrigins
    : rawOrigins.split(",").map((s) => s.trim()).filter(Boolean);

  const body = (req) => new Promise((res) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      try { res(d ? JSON.parse(d) : {}); } catch { res({}); }
    });
  });

  const json = (req, res, code, obj) => {
    const corsOrigin = resolveCorsOrigin(req, allowedOrigins);
    const headers = { "content-type": "application/json" };
    if (corsOrigin) {
      headers["access-control-allow-origin"] = corsOrigin;
      headers["access-control-allow-methods"] = "GET, POST, OPTIONS";
      headers["access-control-allow-headers"] = "Content-Type, Authorization, X-API-Key, X-Principal";
      headers["vary"] = "Origin";
    }
    res.writeHead(code, headers);
    res.end(JSON.stringify(obj));
  };

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        const corsOrigin = resolveCorsOrigin(req, allowedOrigins);
        const headers = {
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "Content-Type, Authorization, X-API-Key, X-Principal",
        };
        if (corsOrigin) {
          headers["access-control-allow-origin"] = corsOrigin;
          headers["vary"] = "Origin";
        }
        res.writeHead(204, headers);
        return res.end();
      }

      if (req.method === "GET" && req.url === "/pubkey") {
        return json(req, res, 200, { pubkey: await publicKeyHex(priv) });
      }

      if (req.method === "POST" && req.url === "/register") {
        const principal = authenticatePrincipal(req, env);
        if (!principal) {
          return json(req, res, 401, {
            error: "unauthenticated",
            reason: "authentication_required_for_register",
          });
        }
        const b = await body(req);
        try {
          const commitment = commitSurface(b, principal);
          return json(req, res, 200, { commitment });
        } catch (err) {
          if (err.code === "AGENT_OWNERSHIP_MISMATCH") {
            return json(req, res, 403, {
              error: "forbidden",
              reason: err.message,
            });
          }
          return json(req, res, 400, { error: String(err?.message ?? err) });
        }
      }

      if (req.method === "POST" && req.url === "/attest") {
        const principal = authenticatePrincipal(req, env);
        if (!principal) {
          return json(req, res, 401, {
            error: "unauthenticated",
            reason: "authentication_required_for_attest",
          });
        }
        const b = await body(req);
        const v = await attest(b, priv, { principal });
        if (!v.ok && v.reason?.includes("owned by another principal")) {
          return json(req, res, 403, v);
        }
        return json(req, res, v.ok ? 200 : 403, v);
      }

      if (req.method === "POST" && req.url === "/verify") {
        return json(req, res, 200, await verifyAttestation(await body(req)));
      }

      json(req, res, 404, { error: "not found" });
    } catch (e) {
      json(req, res, 400, { error: String(e?.message ?? e) });
    }
  });

  return { server, priv, isDev, allowedOrigins };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  let app;
  try {
    app = createAttesterServer();
  } catch (err) {
    process.stderr.write(`FATAL: ${err.message}\n`);
    process.exit(1);
  }
  const { server, priv, isDev } = app;
  const PORT = Number(process.env.PORT || 8790);
  server.listen(PORT, async () => {
    process.stderr.write(
      `slippay-attester on :${PORT} · attester ${await publicKeyHex(priv)} · key=${isDev ? "DEV-seed" : "env"}\n`
    );
  });
}
