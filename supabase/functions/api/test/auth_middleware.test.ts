import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Hono, type Context } from "hono";
import { requireApiKey } from "../middleware/auth_apikey.ts";
import { requireApiKeyOrJwt } from "../middleware/auth_any.ts";

Deno.test("requireApiKey rejects non-bearer or unrecognized prefix with 401", async () => {
  const app = new Hono();
  app.get("/test", requireApiKey, (c: Context) => c.text("ok"));

  // No auth header
  const r1 = await app.request("/test");
  assertEquals(r1.status, 401);
  assertEquals(await r1.json(), { error: "unauthenticated" });

  // Unrecognized prefix
  const r2 = await app.request("/test", {
    headers: { authorization: "Bearer sk_invalid_12345" },
  });
  assertEquals(r2.status, 401);
  assertEquals(await r2.json(), { error: "unauthenticated" });
});

Deno.test("requireApiKeyOrJwt routes unrecognized authorization to 401", async () => {
  const app = new Hono();
  app.get("/test", requireApiKeyOrJwt, (c: Context) => c.text("ok"));

  // Invalid auth header format
  const r1 = await app.request("/test", {
    headers: { authorization: "Basic dXNlcjpwYXNz" },
  });
  assertEquals(r1.status, 401);
  assertEquals(await r1.json(), { error: "unauthenticated" });
});
