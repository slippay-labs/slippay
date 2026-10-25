#!/usr/bin/env node
// SlipPay integrity oracle — HTTP service (zero web deps, Node http).
// The chain-agnostic endpoint any rail calls before settling:
//   GET  /pubkey                     → the attester ed25519 key (register it via
//                                       the Soroban set_attester, or verify anywhere)
//   POST /register {agent_id, allowed_recipients, allowed_tools?, max_amount}
//                                     → commits the agent's surface, returns commitment
//   POST /attest   {agent_id, subscription_id, charges_done, recipient, amount, tools_used?}
//                                     → { ok, not_after, signature } | { ok:false, reason }
//   POST /verify   {subscription_id, charges_done, not_after, signature, pubkey}
//                                     → { valid }
//
// Key: SLIPPAY_ATTESTER_SECRET (64-hex / 32 bytes). Must be set in production.
// Falling back to a dev seed requires explicit opt-in (SLIPPAY_ATTESTER_ALLOW_DEV_KEY=1)
// and is strictly forbidden when NODE_ENV=production.

import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha256";
import { commitSurface, attest, verifyAttestation, publicKeyHex, hexToBytes } from "./oracle.mjs";

/**
 * Resolves the attester private key fail-closed.
 * Throws when SLIPPAY_ATTESTER_SECRET is unset or invalid unless explicitly opted-in
 * via SLIPPAY_ATTESTER_ALLOW_DEV_KEY in non-production environments.
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

  // Secret is unset
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
 * Creates the attester HTTP server instance.
 */
export function createAttesterServer(options = {}) {
  const env = options.env || process.env;
  const warn = options.warn || ((msg) => process.stderr.write(msg));
  const { priv, isDev } = resolveAttesterSecret(env, warn);

  const body = (req) => new Promise((res) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      try { res(d ? JSON.parse(d) : {}); } catch { res({}); }
    });
  });
  const json = (r, code, obj) => {
    r.writeHead(code, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    });
    r.end(JSON.stringify(obj));
  };

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/pubkey") {
        return json(res, 200, { pubkey: await publicKeyHex(priv) });
      }
      if (req.method === "POST" && req.url === "/register") {
        return json(res, 200, { commitment: commitSurface(await body(req)) });
      }
      if (req.method === "POST" && req.url === "/attest") {
        const v = await attest(await body(req), priv);
        return json(res, v.ok ? 200 : 403, v);
      }
      if (req.method === "POST" && req.url === "/verify") {
        return json(res, 200, await verifyAttestation(await body(req)));
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 400, { error: String(e?.message ?? e) });
    }
  });

  return { server, priv, isDev };
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
