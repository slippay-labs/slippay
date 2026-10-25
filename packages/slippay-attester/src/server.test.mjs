import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAttesterSecret, createAttesterServer } from "./server.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const serverScript = resolve(__dirname, "server.mjs");

console.log("testing slippay-attester startup & secret guard...");

// 1. Unset secret without dev opt-in throws
{
  assert.throws(
    () => resolveAttesterSecret({}),
    (err) => {
      assert.match(err.message, /SLIPPAY_ATTESTER_SECRET/);
      assert.match(err.message, /not set/);
      return true;
    },
    "should fail when SLIPPAY_ATTESTER_SECRET is unset",
  );
  console.log("  ✓ unset secret without opt-in throws and names variable");
}

// 2. Invalid hex secret throws
{
  assert.throws(
    () => resolveAttesterSecret({ SLIPPAY_ATTESTER_SECRET: "not-a-valid-hex-key" }),
    (err) => {
      assert.match(err.message, /SLIPPAY_ATTESTER_SECRET/);
      assert.match(err.message, /64-hex/);
      return true;
    },
    "should fail on invalid hex string",
  );
  console.log("  ✓ invalid hex secret throws");
}

// 3. Wrong length secret (e.g. 16 bytes instead of 32) throws
{
  const shortHex = "00".repeat(16);
  assert.throws(
    () => resolveAttesterSecret({ SLIPPAY_ATTESTER_SECRET: shortHex }),
    (err) => {
      assert.match(err.message, /SLIPPAY_ATTESTER_SECRET/);
      assert.match(err.message, /32 bytes/);
      return true;
    },
    "should fail when key length is not 32 bytes",
  );
  console.log("  ✓ wrong length secret (non-32 bytes) throws");
}

// 4. Refuse dev key in production even if opt-in flag is enabled
{
  assert.throws(
    () =>
      resolveAttesterSecret({
        NODE_ENV: "production",
        SLIPPAY_ATTESTER_ALLOW_DEV_KEY: "1",
      }),
    (err) => {
      assert.match(err.message, /SLIPPAY_ATTESTER_SECRET/);
      assert.match(err.message, /production/i);
      return true;
    },
    "should refuse dev key when NODE_ENV=production",
  );
  console.log("  ✓ dev key strictly refused when NODE_ENV=production");
}

// 5. Explicit opt-in in development produces dev key with a warning
{
  let warningCaptured = "";
  const res = resolveAttesterSecret(
    {
      NODE_ENV: "development",
      SLIPPAY_ATTESTER_ALLOW_DEV_KEY: "1",
    },
    (msg) => {
      warningCaptured += msg;
    },
  );
  assert.equal(res.isDev, true);
  assert.equal(res.priv.length, 32);
  assert.match(warningCaptured, /WARNING.*SLIPPAY_ATTESTER_SECRET/);
  console.log("  ✓ dev key allowed with warning under explicit opt-in outside production");
}

// 6. Valid 32-byte hex secret resolves cleanly
{
  const validHex = "ab".repeat(32);
  const res = resolveAttesterSecret({ SLIPPAY_ATTESTER_SECRET: validHex });
  assert.equal(res.isDev, false);
  assert.equal(res.priv.length, 32);
  assert.equal(res.priv[0], 0xab);
  console.log("  ✓ valid 32-byte hex secret resolves successfully");
}

// 7. createAttesterServer factory fails closed when secret missing
{
  assert.throws(
    () => createAttesterServer({ env: {} }),
    (err) => {
      assert.match(err.message, /SLIPPAY_ATTESTER_SECRET/);
      return true;
    },
  );
  console.log("  ✓ createAttesterServer fails closed when secret missing");
}

// 8. Process level CLI guard: exits non-zero without env vars
{
  const proc = spawnSync(process.execPath, [serverScript], {
    env: { ...process.env, SLIPPAY_ATTESTER_SECRET: "", SLIPPAY_ATTESTER_ALLOW_DEV_KEY: "" },
    encoding: "utf8",
  });
  assert.equal(proc.status, 1, "process must exit with status 1");
  assert.match(proc.stderr, /FATAL: SLIPPAY_ATTESTER_SECRET not set/);
  console.log("  ✓ CLI process exits non-zero (code 1) when secret unset");
}

// 9. Process level CLI guard: exits non-zero when production + dev opt-in
{
  const proc = spawnSync(process.execPath, [serverScript], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      SLIPPAY_ATTESTER_SECRET: "",
      SLIPPAY_ATTESTER_ALLOW_DEV_KEY: "1",
    },
    encoding: "utf8",
  });
  assert.equal(proc.status, 1, "process must exit with status 1 in production with dev key");
  assert.match(proc.stderr, /production environment/);
  console.log("  ✓ CLI process exits non-zero in production even with dev key opt-in");
}

console.log("\n=== all 9 startup guard tests passed ===");
