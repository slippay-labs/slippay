import { describe, it, expect, vi, beforeEach } from "vitest";
import { lookup } from "node:dns/promises";

// deliverOnce now always resolves + validates the target (audit-003 L1). These
// tests pass allowLocal:true (dev-only flag) so the blocklist/https/port checks
// are skipped for the example.com mock server, but the hostname still goes
// through DNS resolution — mock it to keep the tests hermetic.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

import {
  nextBackoff,
  deliverOnce,
  readCappedBody,
  MAX_RESPONSE_BODY_BYTES,
  MAX_STORED_BODY_CHARS,
} from "../src/webhook.js";

const mockLookup = lookup as unknown as ReturnType<typeof vi.fn>;

describe("nextBackoff", () => {
  it("returns escalating delays per attempt", () => {
    expect(nextBackoff(0)).toBe(60);
    expect(nextBackoff(1)).toBe(300);
    expect(nextBackoff(2)).toBe(1800);
    expect(nextBackoff(3)).toBe(7200);
    expect(nextBackoff(4)).toBe(43200);
    expect(nextBackoff(5)).toBe(86400);
    expect(nextBackoff(6)).toBe(null);
  });
});

describe("deliverOnce", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mockLookup.mockReset();
    // example.com resolves to a public IP; allowLocal:true skips the blocklist
    // anyway, but validateWebhookUrl still pins the resolved address.
    mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  it("returns sent on 2xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));
    const r = await deliverOnce({
      url: "https://example.com/wh",
      secret: "s",
      deliveryId: "d-1",
      payload: { type: "order.paid", data: { id: "o-1" } },
      allowLocal: true,
    });
    expect(r.status).toBe("sent");
    expect(r.code).toBe(200);
  });

  it("returns failed on 5xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("err", { status: 503 })));
    const r = await deliverOnce({ url: "https://example.com/wh", secret: "s", deliveryId: "d-2", payload: {}, allowLocal: true });
    expect(r.status).toBe("failed");
  });

  it("returns failed on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("dns")));
    const r = await deliverOnce({ url: "https://example.com/wh", secret: "s", deliveryId: "d-3", payload: {}, allowLocal: true });
    expect(r.status).toBe("failed");
  });

  // M3 regression guard at the deliverOnce layer: with allowLocal=false (the
  // production default), a webhook_url resolving to a blocked literal IP is
  // rejected before any fetch is attempted, regardless of network. Audit-003 L1.
  it("rejects a blocked literal IP without fetching (allowLocal=false)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    for (const url of ["http://169.254.169.254/", "http://127.0.0.1/"]) {
      const r = await deliverOnce({ url, secret: "s", deliveryId: "d-blocked", payload: {}, allowLocal: false });
      expect(r.status).toBe("failed");
      expect(r.body).toMatch(/^unsafe_url:/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("caps large response body to MAX_RESPONSE_BODY_BYTES in deliverOnce", async () => {
    const hugeBody = "X".repeat(10_000);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(hugeBody, { status: 200 })));
    const r = await deliverOnce({
      url: "https://example.com/wh",
      secret: "s",
      deliveryId: "d-large",
      payload: {},
      allowLocal: true,
    });
    expect(r.status).toBe("sent");
    expect(r.body?.length).toBe(MAX_RESPONSE_BODY_BYTES);
    expect(r.body).toBe("X".repeat(MAX_RESPONSE_BODY_BYTES));
  });
});

describe("readCappedBody", () => {
  it("truncates a single chunk larger than the cap to exactly the cap", async () => {
    const bigChunk = new Uint8Array(1024).fill(65); // 1024 'A' bytes
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bigChunk);
        controller.close();
      },
    });
    const cap = 500;
    const result = await readCappedBody({ body: stream }, cap);
    expect(result.length).toBe(cap);
    expect(result).toBe("A".repeat(cap));
  });

  it("asserts decoded string is never larger than retained bytes across multi-chunk stream", async () => {
    const chunk1 = new TextEncoder().encode("Header data: "); // 13 bytes
    const chunk2 = new Uint8Array(800).fill(66); // 800 'B' bytes
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk1);
        controller.enqueue(chunk2);
        controller.close();
      },
    });
    const cap = 500;
    const result = await readCappedBody({ body: stream }, cap);
    expect(result.length).toBeLessThanOrEqual(cap);
    expect(result.length).toBe(cap);
    expect(result.startsWith("Header data: ")).toBe(true);
    expect(result.slice(13)).toBe("B".repeat(cap - 13));
  });

  it("returns empty string when body is null", async () => {
    const result = await readCappedBody({ body: null }, 500);
    expect(result).toBe("");
  });

  it("returns full text when body is smaller than the cap", async () => {
    const smallText = "webhook received successfully";
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(smallText));
        controller.close();
      },
    });
    const result = await readCappedBody({ body: stream }, 500);
    expect(result).toBe(smallText);
  });
});

