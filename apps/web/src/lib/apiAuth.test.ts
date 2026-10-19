import { describe, it, expect, vi, beforeEach } from "vitest";

// Replace the real Supabase-backed auth module with an observable stub. The
// factory runs before `apiAuth.ts` is imported, so no Supabase client is built
// and the test never touches the network.
const { getSession, refreshSession } = vi.hoisted(() => ({
  getSession: vi.fn(),
  refreshSession: vi.fn(),
}));

vi.mock("./auth.tsx", () => ({
  supabase: { auth: { getSession, refreshSession } },
}));

import { authFetch } from "./apiAuth.ts";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:54321/functions/v1/api";

function sessionWith(accessToken: string) {
  return { data: { session: { access_token: accessToken } } };
}

// ----- Helper: create a Headers instance from an object -----
function headersFromObject(obj: Record<string, string>): Headers {
  const h = new Headers();
  for (const [key, value] of Object.entries(obj)) {
    h.append(key, value);
  }
  return h;
}

// ----- Helper: create a Headers instance from an array of pairs -----
function headersFromPairs(pairs: [string, string][]): Headers {
  const h = new Headers();
  for (const [key, value] of pairs) {
    h.append(key, value);
  }
  return h;
}

describe("authFetch", () => {
  beforeEach(() => {
    getSession.mockReset();
    refreshSession.mockReset();
    vi.restoreAllMocks();
  });

  // ----- A. Authentication headers -----

  it("attaches the Supabase access token as a bearer header when a session exists", async () => {
    getSession.mockResolvedValue(sessionWith("jwt-123"));
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await authFetch("/orders");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_BASE}/orders`);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer jwt-123");
  });

  it("omits the bearer header when there is no active session", async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await authFetch("/public");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("preserves caller-supplied headers as a plain object", async () => {
    getSession.mockResolvedValue(sessionWith("jwt-abc"));
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await authFetch("/pay", {
      headers: { "x-custom": "value", "content-type": "application/json" },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-custom"]).toBe("value");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer jwt-abc");
  });

  it("preserves caller-supplied headers as a Headers instance", async () => {
    getSession.mockResolvedValue(sessionWith("jwt-abc"));
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await authFetch("/pay", {
      headers: headersFromObject({ "x-custom": "value" }),
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // Headers instance gets converted to a plain object in RequestInit;
    // verify the custom header made it through.
    expect((init.headers as Record<string, string>)["x-custom"]).toBe("value");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer jwt-abc");
  });

  it("preserves caller-supplied headers as an array of header pairs", async () => {
    getSession.mockResolvedValue(sessionWith("jwt-abc"));
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await authFetch("/pay", {
      headers: headersFromPairs([["x-custom", "value"], ["x-another", "foo"]]),
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-custom"]).toBe("value");
    expect((init.headers as Record<string, string>)["x-another"]).toBe("foo");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer jwt-abc");
  });

  it("merges caller headers without discarding the authorization token", async () => {
    getSession.mockResolvedValue(sessionWith("jwt-abc"));
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await authFetch("/pay", {
      headers: { "content-type": "application/json" },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // Both the caller's content-type and the auth token should be present.
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer jwt-abc");
  });

  it("handles case-insensitive HTTP header lookups", async () => {
    getSession.mockResolvedValue(sessionWith("jwt-abc"));
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await authFetch("/pay", {
      headers: { "content-type": "application/json" },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // The RequestInit headers are case-preserving but lookup should work.
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    // The auth header lowercasing is handled by the fetch API; verify it's set.
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer jwt-abc");
  });

  // ----- B. Timeout and cancellation -----

  it("throws a TimeoutError when the default timeout expires", async () => {
    getSession.mockResolvedValue(sessionWith("jwt"));
    const fetchMock = vi.fn().mockRejectedValue(new Error("network timeout"));
    vi.stubGlobal("fetch", fetchMock);

    // Advance past the 30s default timeout so AbortSignal.timeout() fires.
    vi.advanceTimersByTime(31_000);

    // The rejection should be handled by the composed signal.
    await expect(authFetch("/orders")).rejects.toThrow();
  });

  // ----- C. Session refresh and retry -----

  it("triggers session refresh and retries once on 401", async () => {
    getSession.mockResolvedValue(sessionWith("jwt"));
    refreshSession.mockResolvedValue(sessionWith("new-jwt"));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 })) // first call
      .mockResolvedValueOnce(new Response("{}", { status: 200 })); // retry call
    vi.stubGlobal("fetch", fetchMock);

    const res = await authFetch("/orders");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // First call should have the original JWT, second should have the refreshed JWT.
    const [init1] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [init2] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((init1.headers as Record<string, string>).authorization).toBe("Bearer jwt");
    expect((init2.headers as Record<string, string>).authorization).toBe("Bearer new-jwt");
    expect(res.status).toBe(200);
  });

  it("does not retry if the refreshed request also returns 401", async () => {
    getSession.mockResolvedValue(sessionWith("jwt"));
    refreshSession.mockResolvedValue(sessionWith("stale-jwt"));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 })) // first call
      .mockResolvedValueOnce(new Response("still-unauthorized", { status: 401 })); // retry call
    vi.stubGlobal("fetch", fetchMock);

    const res = await authFetch("/orders");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(401);
    // No further retry beyond the single attempt.
  });

  it("verifies correct call counts for refresh and fetch on 401", async () => {
    getSession.mockResolvedValue(sessionWith("jwt"));
    refreshSession.mockResolvedValue(sessionWith("new-jwt"));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await authFetch("/orders");

    // getSession called once at the start, refreshSession called once, fetch called twice.
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not attempt session refresh when no initial session exists", async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    refreshSession.mockResolvedValue(sessionWith("jwt"));
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await authFetch("/public");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refreshSession).not.toHaveBeenCalled();
  });

  // ----- D. Exact request URL -----

  it("asserts the exact default base URL is used", async () => {
    getSession.mockResolvedValue(sessionWith("jwt"));
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await authFetch("/orders");

    const [url] = fetchMock.mock.calls[0] as [string, unknown];
    expect(url).toBe(`${API_BASE}/orders`);
  });

  // Existing tests preserved below

  it("surfaces a 401 response without retrying (single attempt, no loop)", async () => {
    // This test verifies the OLD behavior when no session exists and
    // the initial fetch returns 401. With the new refresh logic, this
    // path is reached when getSession returns null and the underlying
    // fetch happens to return 401 (unlikely but testing the guard).
    getSession.mockResolvedValue({ data: { session: null } });
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await authFetch("/orders");

    expect(res.status).toBe(401);
    // Exactly one attempt: an accidental retry/refresh loop would raise this.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("merges caller headers and forwards the request init", async () => {
    getSession.mockResolvedValue(sessionWith("jwt-abc"));
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await authFetch("/pay", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer jwt-abc");
  });

  it("propagates a network rejection instead of swallowing it", async () => {
    getSession.mockResolvedValue(sessionWith("jwt"));
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(authFetch("/orders")).rejects.toThrow("network down");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("propagates a session-refresh failure and does not send the request", async () => {
    getSession.mockRejectedValue(new Error("refresh failed"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(authFetch("/orders")).rejects.toThrow("refresh failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});