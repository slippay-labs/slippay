import { describe, expect, it } from "vitest";
import { handle, Ramp4pError } from "./ramp4p.ts";

function errorResponse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("4P availability error contract", () => {
  it("maps typed HTTP 501 ramp_disabled to the disabled client error", async () => {
    await expect(handle(errorResponse(501, "ramp_disabled"))).rejects.toMatchObject({
      name: "Ramp4pError",
      code: "disabled",
      status: 501,
    } satisfies Partial<Ramp4pError>);
  });

  it("keeps HTTP 503 as a retryable provider error", async () => {
    await expect(handle(errorResponse(503, "provider_unavailable"))).rejects.toMatchObject({
      name: "Ramp4pError",
      code: "provider_unavailable",
      status: 503,
    } satisfies Partial<Ramp4pError>);
  });

  it("does not classify an untyped HTTP 501 as disabled", async () => {
    await expect(handle(errorResponse(501, "not_implemented"))).rejects.toMatchObject({
      code: "not_implemented",
      status: 501,
    } satisfies Partial<Ramp4pError>);
  });
});
