import { assertEquals, assert } from "https://den.land/std/assert@latest/assert.ts";
import { join } from "https://den.land/std/path@latest/mod.ts";
import { resolveStaticPath } from "./static.ts";

const WEB_DIST = "/tmp/slippay-web-dist";

Deno.test("resolveStaticPath returns index.html for root", () => {
  const r = resolveStaticPath(WEB_DIST, "/");
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.path, join(WEB_DIST, "index.html"));
});

Deno.test("resolveStaticPath resolves a normal asset", () => {
  const r = resolveStaticPath(WEB_DIST, "/assets/app.js");
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.path, join(WEB_DIST, "assets", "app.js"));
});

Deno.test("resolveStaticPath rejects literal traversal", () => {
  const r = resolveStaticPath(WEB_DIST, "/../../etc/passwd");
  assertEquals(r.ok, false);
});

Deno.test("resolveStaticPath rejects percent-encoded traversal", () => {
  const r = resolveStaticPath(WEB_DIST, "/%2e2e%2f%2e2e%2fetc/passwd");
  assertEquals(r.ok, false);
});

Deno.test("resolveStaticPath rejects NUL bytes", () => {
  const r = resolveStaticPath(WEB_DIST, "/%00index.html");
  assertEquals(r.ok, false);
});

Deno.test("resolveStaticPath rejects disallowed extension", () => {
  const r = resolveStaticPath(WEB_DIST, "/secret.bin");
  assertEquals(r.ok, false);
});

Deno.test("resolveStaticPath asserts containment for any input", () => {
  const inputs = [
    "/../etc/passwd",
    "/../../etc/passwd",
    "/%2e%2e%2fetc/passwd",
    "/%00index.html",
    "/foo/../../etc/passwd",
    "/foo/%2e2e/etc/passwd",
  ];
  const root = Deno.realPathSync(WEB_DIST);
  for (const input of inputs) {
    const r = resolveStaticPath(WEB_DIST, input);
    if (r.ok) {
      assert(r.path === root || r.path.startsWith(root + "/"), `outside root: ${r.path}`);
    }
  }
});
