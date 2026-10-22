import { describe, it, expect, vi, beforeEach } from "vitest";

const { getSession, refreshSession } = vi.hoisted(() => ({
  getSession: vi.fn(),
  refreshSession: vi.fn(),
}));

vi.mock("./auth.tsx", () => ({
  supabase: {
    auth: {
      getSession,
      refreshSession,
    },
  },
}));

import { authFetch, API_BASE } from "./apiAuth.ts";

function sessionWith(accessToken: string) {
  return { data: { session: { access_token: accessToken } } };
}

describe("authFetch", () => {
  beforeEach(() => {
    getSession.mockReset();
    refreshSession.mockReset();
  });

  describe("bearer token attachment", () => {
    it("attaches the Supabase access token as a bearer header", async () => {
      getSession.mockResolvedValue(sessionWith("jwt-123"));
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      await authFetch("/orders");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${API_BASE}/orders`);
      const h = new Headers(init.headers);
      expect(h.get("authorization")).toBe("Bearer jwt-123");
    });

    it("omits the bearer header when there is no active session", async () => {
      getSession.mockResolvedValue({ data: { session: null } });
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      await authFetch("/public");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const h = new Headers(init.headers);
      expect(h.has("authorization")).toBe(false);
    });
  });

  describe("header shapes and merging (Issue 321)", () => {
    it("merges caller headers from a plain object literal", async () => {
      getSession.mockResolvedValue(sessionWith("jwt-plain"));
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      await authFetch("/pay", {
        method: "POST",
        headers: { "content-type": "application/json", "x-custom-key": "val-plain" },
        body: "{}",
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe("POST");
      expect(init.body).toBe("{}");
      const h = new Headers(init.headers);
      expect(h.get("content-type")).toBe("application/json");
      expect(h.get("x-custom-key")).toBe("val-plain");
      expect(h.get("authorization")).toBe("Bearer jwt-plain");
    });

    it("merges caller headers from a Headers instance without dropping entries", async () => {
      getSession.mockResolvedValue(sessionWith("jwt-instance"));
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const callerHeaders = new Headers();
      callerHeaders.set("content-type", "application/json");
      callerHeaders.set("idempotency-key", "idem-uuid-999");
      callerHeaders.set("x-route-trace", "trace-42");

      await authFetch("/orders", {
        method: "POST",
        headers: callerHeaders,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const h = new Headers(init.headers);
      expect(h.get("content-type")).toBe("application/json");
      expect(h.get("idempotency-key")).toBe("idem-uuid-999");
      expect(h.get("x-route-trace")).toBe("trace-42");
      expect(h.get("authorization")).toBe("Bearer jwt-instance");
    });

    it("merges caller headers from an array of pairs", async () => {
      getSession.mockResolvedValue(sessionWith("jwt-pairs"));
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      await authFetch("/orders", {
        headers: [
          ["content-type", "application/json"],
          ["x-batch-id", "batch-10"],
        ],
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const h = new Headers(init.headers);
      expect(h.get("content-type")).toBe("application/json");
      expect(h.get("x-batch-id")).toBe("batch-10");
      expect(h.get("authorization")).toBe("Bearer jwt-pairs");
    });
  });

  describe("401 session refresh and replay (Issue 324 & 328)", () => {
    it("refreshes the session on a 401 and replays the request once successfully", async () => {
      getSession.mockResolvedValue(sessionWith("expired-jwt"));
      refreshSession.mockResolvedValue(sessionWith("fresh-jwt"));

      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
        .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const res = await authFetch("/orders", {
        headers: { "x-req": "1" },
      });

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // First attempt with expired token
      const [, firstInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      const firstH = new Headers(firstInit.headers);
      expect(firstH.get("authorization")).toBe("Bearer expired-jwt");
      expect(firstH.get("x-req")).toBe("1");

      // Second attempt with fresh token
      const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      const secondH = new Headers(secondInit.headers);
      expect(secondH.get("authorization")).toBe("Bearer fresh-jwt");
      expect(secondH.get("x-req")).toBe("1");
    });

    it("does not enter an infinite loop if the replayed request also returns 401", async () => {
      getSession.mockResolvedValue(sessionWith("expired-jwt"));
      refreshSession.mockResolvedValue(sessionWith("still-bad-jwt"));

      const fetchMock = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
      vi.stubGlobal("fetch", fetchMock);

      const res = await authFetch("/orders");

      expect(res.status).toBe(401);
      // Strictly bounded to 2 attempts: 1 initial attempt + exactly 1 replay attempt
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(refreshSession).toHaveBeenCalledTimes(1);
    });

    it("surfaces initial 401 without retry if session refresh fails", async () => {
      getSession.mockResolvedValue(sessionWith("expired-jwt"));
      refreshSession.mockRejectedValue(new Error("refresh network down"));

      const fetchMock = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
      vi.stubGlobal("fetch", fetchMock);

      const res = await authFetch("/orders");

      expect(res.status).toBe(401);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("abort signal and timeout (Issue 322)", () => {
    it("respects caller-supplied abort signal", async () => {
      getSession.mockResolvedValue(sessionWith("jwt-123"));
      const controller = new AbortController();

      const fetchMock = vi.fn().mockImplementation((_url, init) => {
        if (init?.signal?.aborted) {
          return Promise.reject(new DOMException("The user aborted a request.", "AbortError"));
        }
        return Promise.resolve(new Response("{}", { status: 200 }));
      });
      vi.stubGlobal("fetch", fetchMock);

      controller.abort();
      await expect(authFetch("/orders", { signal: controller.signal })).rejects.toThrow(/abort/i);
    });
  });

  describe("network rejection propagation and URL pinning (Issue 323)", () => {
    it("propagates a network rejection without swallowing it", async () => {
      getSession.mockResolvedValue(sessionWith("jwt"));
      const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
      vi.stubGlobal("fetch", fetchMock);

      await expect(authFetch("/orders")).rejects.toThrow("network down");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("pins the target URL against API_BASE without loopback default", async () => {
      getSession.mockResolvedValue({ data: { session: null } });
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      await authFetch("/v1/merchants/me");

      const [targetUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(targetUrl).toBe(`${API_BASE}/v1/merchants/me`);
      expect(targetUrl.startsWith("http://127.0.0.1")).toBe(false);
    });
  });
});
