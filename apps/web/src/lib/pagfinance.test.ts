import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { quote, type QuoteInput } from "./pagfinance.ts";

const BASE = import.meta.env.VITE_PAGFINANCE_BASE ?? "https://app.pag.finance";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];
}

const QUOTE_INPUT: QuoteInput = {
  invoiceCode: "INV-1",
  invoiceType: "PIX",
  assetId: 7,
  amount: 123.45,
  fiatCurrency: "BRL",
  userEmail: "merchant@example.com",
  externalId: "pag_ext_1",
};

describe("quote", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps the UI input to the exact request body (deep equality)", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: { quoteId: "q1" } }));

    const result = await quote(QUOTE_INPUT);

    const [url, init] = lastCall(fetchMock);
    expect(url).toBe(`${BASE}/api/payment/quote`);
    expect(init.method).toBe("POST");
    // Exact body: a renamed/added/removed field must fail this assertion.
    expect(JSON.parse(String(init.body))).toEqual({ fiatCurrency: "BRL", ...QUOTE_INPUT });
    expect(result).toEqual({ quoteId: "q1" });
  });

  it("defaults the fiat currency to BRL when the caller omits it", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: { quoteId: "q2" } }));

    const { fiatCurrency: _omitted, ...rest } = QUOTE_INPUT;
    await quote(rest);

    const [, init] = lastCall(fetchMock);
    expect(JSON.parse(String(init.body)).fiatCurrency).toBe("BRL");
  });

  it("sends the pagfinance client headers", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: { quoteId: "q3" } }));

    await quote(QUOTE_INPUT);

    const [, init] = lastCall(fetchMock);
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-client-id"]).toBeDefined();
    expect(headers.blockchain).toBe("stellar");
  });
});
