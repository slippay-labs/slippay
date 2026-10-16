import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveSafeStaticPath, ALLOWED_STATIC_EXTENSIONS } from "@slippay/shared";

const MOCK_WEB_DIST = "/var/www/slippay/apps/web/dist";

Deno.test("resolveSafeStaticPath: resolves legitimate static assets within webDist", () => {
  const index = resolveSafeStaticPath(MOCK_WEB_DIST, "/index.html");
  assertEquals(index, "/var/www/slippay/apps/web/dist/index.html");

  const js = resolveSafeStaticPath(MOCK_WEB_DIST, "/assets/vendor.js");
  assertEquals(js, "/var/www/slippay/apps/web/dist/assets/vendor.js");

  const css = resolveSafeStaticPath(MOCK_WEB_DIST, "/css/style.css");
  assertEquals(css, "/var/www/slippay/apps/web/dist/css/style.css");

  const favicon = resolveSafeStaticPath(MOCK_WEB_DIST, "/favicon.ico");
  assertEquals(favicon, "/var/www/slippay/apps/web/dist/favicon.ico");
});

Deno.test("resolveSafeStaticPath: rejects path traversal attempts with .. segments", () => {
  assertEquals(resolveSafeStaticPath(MOCK_WEB_DIST, "/../../etc/passwd"), null);
  assertEquals(resolveSafeStaticPath(MOCK_WEB_DIST, "/../app/index.html"), null);
  assertEquals(resolveSafeStaticPath(MOCK_WEB_DIST, "/assets/../../etc/shadow"), null);
  assertEquals(resolveSafeStaticPath(MOCK_WEB_DIST, ".."), null);
  assertEquals(resolveSafeStaticPath(MOCK_WEB_DIST, "/.."), null);
});

Deno.test("resolveSafeStaticPath: rejects percent-encoded traversal sequences (%2e%2e%2f)", () => {
  assertEquals(resolveSafeStaticPath(MOCK_WEB_DIST, "/%2e%2e%2f%2e%2e%2fetc/passwd"), null);
  assertEquals(resolveSafeStaticPath(MOCK_WEB_DIST, "/%2E%2E/%2E%2E/windows/win.ini"), null);
  assertEquals(resolveSafeStaticPath(MOCK_WEB_DIST, "/assets/%2e%2e/secret.json"), null);
});

Deno.test("resolveSafeStaticPath: rejects literal or encoded NUL bytes", () => {
  assertEquals(resolveSafeStaticPath(MOCK_WEB_DIST, "/%00index.html"), null);
  assertEquals(resolveSafeStaticPath(MOCK_WEB_DIST, "/index.html\0.js"), null);
  assertEquals(resolveSafeStaticPath(MOCK_WEB_DIST, "/test%00.png"), null);
});

Deno.test("resolveSafeStaticPath: rejects unknown extensions, triggering SPA fallback rather than octet-stream", () => {
  assertEquals(resolveSafeStaticPath(MOCK_WEB_DIST, "/api/keys.env"), null);
  assertEquals(resolveSafeStaticPath(MOCK_WEB_DIST, "/bin/malware.exe"), null);
  assertEquals(resolveSafeStaticPath(MOCK_WEB_DIST, "/script.sh"), null);
  assertEquals(resolveSafeStaticPath(MOCK_WEB_DIST, "/config.yaml"), null);
  assertEquals(resolveSafeStaticPath(MOCK_WEB_DIST, "/unknown.bin"), null);
  assertEquals(resolveSafeStaticPath(MOCK_WEB_DIST, "/dashboard"), null);
  assertEquals(resolveSafeStaticPath(MOCK_WEB_DIST, "/"), null);
});

Deno.test("resolveSafeStaticPath: verifies allowlisted extensions", () => {
  assert(ALLOWED_STATIC_EXTENSIONS.has("html"));
  assert(ALLOWED_STATIC_EXTENSIONS.has("js"));
  assert(ALLOWED_STATIC_EXTENSIONS.has("css"));
  assert(ALLOWED_STATIC_EXTENSIONS.has("svg"));
  assert(ALLOWED_STATIC_EXTENSIONS.has("json"));
  assert(!ALLOWED_STATIC_EXTENSIONS.has("exe"));
  assert(!ALLOWED_STATIC_EXTENSIONS.has("env"));
});
