import { assertEquals, assertNotEquals, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";
import app from "../index.ts";
import { CANONICAL_REPO_URL } from "@slippay/shared";

Deno.test("Service Descriptor - returns canonical repository and deployed revision", async () => {
  const req = new Request("https://api.slippay.cc/", {
    headers: {
      host: "api.slippay.cc",
    },
  });
  const res = await app.fetch(req);
  assertEquals(res.status, 200);

  const data = await res.json();
  assertEquals(data.service, "slippay-api");
  assertEquals(data.status, "ok");
  assertEquals(data.health, "/api/health");

  // Canonical repository verification (Issue #217)
  assertEquals(data.repo, CANONICAL_REPO_URL);
  assertEquals(data.repo, "https://github.com/slippay-labs/slippay");
  assertNotEquals(data.repo.includes("Galmanus"), true);
  assertMatch(data.repo, /^https:\/\/github\.com\/slippay-labs\/slippay$/);

  // Revision / commit SHA included
  assertEquals(typeof data.revision, "string");
  assertEquals(typeof data.commit_sha, "string");
  assertEquals(data.revision.length > 0, true);
});

Deno.test("Service Descriptor - reflects deployed commit SHA from environment", async () => {
  const testSha = "9f8e7d6c5b4a3210fedcba0123456789abcdef01";
  Deno.env.set("GIT_SHA", testSha);

  try {
    const req = new Request("https://api.slippay.cc/index.html", {
      headers: {
        host: "api.slippay.cc",
      },
    });
    const res = await app.fetch(req);
    assertEquals(res.status, 200);

    const data = await res.json();
    assertEquals(data.revision, testSha);
    assertEquals(data.commit_sha, testSha);
  } finally {
    Deno.env.delete("GIT_SHA");
  }
});
