import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import app, { CANONICAL_REPO } from "../index.ts";
import { req } from "./_helpers.ts";

Deno.test("GET /health returns ok", async () => {
  const res = await req("/health");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body, { ok: true });
});

Deno.test("GET / on api.slippay.cc reports canonical repository URL and deployed revision", async () => {
  const request = new Request("https://api.slippay.cc/", {
    headers: { host: "api.slippay.cc" },
  });
  const res = await app.fetch(request);
  assertEquals(res.status, 200);
  const body = await res.json();

  assertEquals(body.service, "slippay-api");
  assertEquals(body.status, "ok");
  assertEquals(body.canonical_app, "https://app.slippay.cc");
  assertEquals(body.health, "/api/health");

  // Acceptance criteria: The descriptor reports the canonical repository URL
  assertEquals(body.repo, "https://github.com/slippay-labs/slippay");
  assertEquals(body.repo, CANONICAL_REPO);

  // Acceptance criteria: A test fails if the URL is changed to a non-canonical repository (e.g. personal forks)
  const isCanonical = body.repo === "https://github.com/slippay-labs/slippay";
  assertEquals(isCanonical, true);
  assertNotEquals(body.repo, "https://github.com/Galmanus/slippay");
  assertEquals(body.repo.startsWith("https://github.com/slippay-labs/"), true);

  // Acceptance criteria: The response includes the deployed commit SHA
  assertEquals(typeof body.commit_sha, "string");
  assertEquals(body.commit_sha.length > 0, true);
});

Deno.test("GET / on api.slippay.cc picks up deployed commit SHA from environment", async () => {
  const sampleCommit = "7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b";
  Deno.env.set("COMMIT_SHA", sampleCommit);
  try {
    const request = new Request("https://api.slippay.cc/", {
      headers: { host: "api.slippay.cc" },
    });
    const res = await app.fetch(request);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.commit_sha, sampleCommit);
    assertEquals(body.revision, sampleCommit);
  } finally {
    Deno.env.delete("COMMIT_SHA");
  }
});

