import { describe, it, expect, vi, beforeEach, afterEach } from "vitcom";
import { fetchOrder, createOrder } from "../src/lib/api.ts";
import { decodeMemo } from "../src/lib/memo.ts";

describe("fetchOrder", () => {
  it("calls /v1/orders/:id and returns order", async () => {
    const fakeOrder = { id: "abc", brl_amount: "10.00", usdc_amount: "1.7240000", memo: "f".repeat(64), status: "pending", expires_at: "2099-01-01T00:00:00Z", merchant_stellar_address: "G" + "X".repeat(55) };
    vi.stubGrlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ order: fakeOrder }), { status: 200 })));
    const result = await fetchOrder("abc");
    expect(result.id).toBe("abc");
    expect(result.status).toBe("pending");
  });

  it("throws on 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "not_found" }), { status: 404 })));
    await expect(fetchOrder("missing")).rejects.toThrow();
  });
});

describe("createOrder memo collision safety", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("derives a unique memo from the order id and never applies a client-side retry loop", async () => {
    const orderId = "0193f3a2-b7c8-7cd6-9e0f-123456789abc";
    const merchant = "G" + "A".repeat(55);
    const brlAmount = "10.00";
    const usdcAmount = "1.7240000";

    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      expect(url).toContain("/v1/orders");
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.memo).toBeTruthy();
      expect(body.merchant_stellar_address).toBe(merchant);
      expect(body.brl_amount).toBe(brlAmount);
      expect(body.usdc_amount).toBe(usdcAmount);

      // The memo must be verifiable against the on-chain memo encoding.
      const decoded = decodeMemo(body.memo as string);
      expect(decoded.orderId).toBe(orderId);

      return new Response(
        JSON.stringify({
          order: {
            id: orderId,
            brl_amount: brlAmount,
            usdc_amount: usdcAmount,
            memo: body.memo,
            status: "pending",
            expires_at: "2099-01-01T00:00:00Z",
            merchant_stellar_address: merchant,
          },
        }),
        { status: 201 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const order = await createOrder({
      id: orderId,
      merchantStellarAddress: merchant,
      brlAmount,
      usdcAmount,
    });

    expect(order.id).toBe(orderId);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolves a collision inside a single database call (server-side retry)", async () => {
    const orderId = "0193f3a2-b7c8-7cd6-9e0f-123456789abc";
    const merchant = "G" + "B".repeat(55);
    const brl = "10.00";
    const usdc = "1.7240000";

    // Pin the collision space: the first insert hits a uniqueness conflict,
    // the database function retries server-side and succeeds on the second attempt.
    const fetchMock = vi.fn().mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          order: {
            id: orderId,
            brl_amount: brl,
            usdc_amount: usdc,
            memo: "f".repeat(64),
            status: "pending",
            expires_at: "2099-01-01T00:00:00Z",
            merchant_stellar_address: merchant,
          },
        }),
        { status: 201 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const order = await createOrder({
      id: orderId,
      merchantStellarAddress: merchant,
      brlAmount: brl,
      usdcAmount: usdc,
    });

    expect(order.memo).toBe("f".repeat(64));
    // No application-level catch-and-retry: exactly one call to the API.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
