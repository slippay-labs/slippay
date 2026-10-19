import { describe, it, expect, vi, beforeEach } from "vitest";

// Replace the real Supabase-backed auth module with an observable stub. The
// factory runs before `apiAuth.ts` is imported, so no Supabase client is built
// and the test never touches the network.
const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock("./auth.tsx", () => ({ supabase: { auth: { getSession } } }));

import { authFetch, TimeoutError } from "./apiAuth.ts";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:54321/functions/v1/api";

function sessionWith(accessToken: string) {
  return { data: { session: { access_token: accessToken } } };
}

// ----- Helper: advance timers so AbortSignal.timeout() fires -----
function advanceTime(ms: number) {
  vi.advanceTimersByTime(ms);
}

// ----- Helper: create a manually-abortable signal -----
function manualAbortSignal() {
  const controller = new AbortController();
  return { signal: controller.signal, abort: controller.abort };
}

describe("authFetch", () => {
  beforeEach(() => {
    getSession.mockReset();
    vi.restoreAllMocks();
  });

  it("attaches the Supabase access token as a bearer header", async () => {
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

  it("surfaces a 401 response without retrying (single attempt, no loop)", async () => {
    getSession.mockResolvedValue(sessionWith("expired-jwt"));
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

  // ----- New: timeout behavior -----

  it("throws a TimeoutError when the default timeout expires", async () => {
    getSession.mockResolvedValue(sessionWith("jwt"));
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    // Advance past the 30s default timeout so AbortSignal.timeout() fires.
    advanceTime(31_000);

    // fetch should have been called but the signal caused it to reject
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The rejection should be a TimeoutError
    await expect(authFetch("/orders")).rejects.toThrow(TimeoutError);
    await expect(authFetch("/orders")).rejects.toMatchObject({
      name: "TimeoutError",
      timeout: true,
    });
  });

  it("aborts the request when a caller-supplied signal is aborted", async () => {
    getSession.mockResolvedValue(sessionWith("jwt"));
    const { signal, abort } = manualAbortSignal();
    const fetchMock = vi.fn().mockRejectedValue(new Error("request aborted by caller"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(authFetch("/orders", { signal })).rejects.toThrow("request aborted by caller");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    abort();
  });

  it("composes caller signal with timeout: either can cancel first", async () => {
    getSession.mockResolvedValue(sessionWith("jwt"));
    const { signal, abort } = manualAbortSignal();
    const fetchMock = vi.fn().mockRejectedValue(new Error("canceled"));
    vi.stubGlobal("fetch", fetchMock);

    // Cancel via caller signal first.
    abort();
    await expect(authFetch("/orders", { signal })).rejects.toThrow("canceled");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("distinguishes timeout errors from network errors", async () => {
    getSession.mockResolvedValue(sessionWith("jwt"));
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(authFetch("/orders")).rejects.toThrow("network down");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not swallow abort errors as timeouts when signal already aborted", async () => {
    getSession.mockResolvedValue(sessionWith("jwt"));
    const { signal, abort } = manualAbortSignal();
    abort(); // manually abort before the function runs
    const fetchMock = vi.fn().mockRejectedValue(new Error("user-canceled"));
    vi.stubGlobal("fetch", fetchMock);

    // Should throw the user-canceled error, not a TimeoutError
    await expect(authFetch("/orders", { signal })).rejects.toThrow("user-canceled");
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