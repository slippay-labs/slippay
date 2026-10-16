import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Hono } from "hono";
import {
  bodyLimit,
  DEFAULT_JSON_BODY_LIMIT,
  DEFAULT_WEBHOOK_PROXY_BODY_LIMIT,
} from "../middleware/body_limit.ts";

Deno.test("bodyLimit: allows requests within cap", async () => {
  const app = new Hono();
  let handlerRan = false;
  app.use("*", bodyLimit({ maxBytes: 1024 }));
  app.post("/test", async (c) => {
    handlerRan = true;
    const json = await c.req.json();
    return c.json({ received: json });
  });

  const payload = JSON.stringify({ hello: "world" });
  const res = await app.fetch(
    new Request("http://localhost/test", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(payload.length) },
      body: payload,
    }),
  );

  assertEquals(res.status, 200);
  assert(handlerRan);
  const data = await res.json();
  assertEquals(data.received.hello, "world");
});

Deno.test("bodyLimit: returns 413 on declared Content-Length > maxBytes without running handler", async () => {
  const app = new Hono();
  let handlerRan = false;
  app.use("*", bodyLimit({ maxBytes: 100 }));
  app.post("/test", () => {
    handlerRan = true;
    return new Response("ok");
  });

  const res = await app.fetch(
    new Request("http://localhost/test", {
      method: "POST",
      headers: { "content-length": "101" },
      body: "a".repeat(101),
    }),
  );

  assertEquals(res.status, 413);
  assertEquals(handlerRan, false);
  const json = await res.json();
  assertEquals(json.error, "payload_too_large");
});

Deno.test("bodyLimit: returns 413 when Content-Length is forged to small value but stream exceeds cap", async () => {
  const app = new Hono();
  let handlerRan = false;
  app.use("*", bodyLimit({ maxBytes: 100 }));
  app.post("/test", () => {
    handlerRan = true;
    return new Response("ok");
  });

  // Forged Content-Length claim of 50, but actual streamed body is 150 bytes
  const largeBody = "x".repeat(150);
  const res = await app.fetch(
    new Request("http://localhost/test", {
      method: "POST",
      headers: { "content-length": "50" },
      body: largeBody,
    }),
  );

  assertEquals(res.status, 413);
  assertEquals(handlerRan, false);
  const json = await res.json();
  assertEquals(json.error, "payload_too_large");
});

Deno.test("bodyLimit: returns 413 when Content-Length is omitted but stream exceeds cap", async () => {
  const app = new Hono();
  let handlerRan = false;
  app.use("*", bodyLimit({ maxBytes: 100 }));
  app.post("/test", () => {
    handlerRan = true;
    return new Response("ok");
  });

  // Streaming body without Content-Length header
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("y".repeat(60)));
      controller.enqueue(new TextEncoder().encode("y".repeat(60)));
      controller.close();
    },
  });

  const res = await app.fetch(
    new Request("http://localhost/test", {
      method: "POST",
      body: stream,
      // @ts-ignore
      duplex: "half",
    }),
  );

  assertEquals(res.status, 413);
  assertEquals(handlerRan, false);
  const json = await res.json();
  assertEquals(json.error, "payload_too_large");
});

Deno.test("bodyLimit: verifies default constants for JSON (64KB) and Webhooks (1MB)", () => {
  assertEquals(DEFAULT_JSON_BODY_LIMIT, 64 * 1024);
  assertEquals(DEFAULT_WEBHOOK_PROXY_BODY_LIMIT, 1024 * 1024);
  assert(DEFAULT_WEBHOOK_PROXY_BODY_LIMIT > DEFAULT_JSON_BODY_LIMIT);
});
