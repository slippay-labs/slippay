import type { Context, Next } from "hono";
import { ZodError } from "zod";

// Audit-004 · C3+M1 — Zod issues are useful for developers calling the API
// directly, but in production we don't want to echo field names / regex
// patterns. Toggle by ZOD_VERBOSE env (default: terse).
const VERBOSE_ZOD = Deno.env.get("ZOD_VERBOSE") === "1";

// Single source of truth for the validation-error body shape. Every
// route that needs to render a Zod failure must go through here so the
// ZOD_VERBOSE gate applies uniformly and the shape can't drift.
// Audit-004 C3+M1.
export function validationErrorBody(error: unknown): Record<string, unknown> {
  const body: Record<string, unknown> = { error: "validation_error" };
  if (VERBOSE_ZOD && error instanceof ZodError) body.issues = error.issues;
  return body;
}

export async function errorMiddleware(c: Context, next: Next) {
  try {
    await next();
  } catch (e) {
    if (e instanceof ZodError) {
      return c.json(validationErrorBody(e), 400);
    }
    // Server-side log keeps full detail for ops; client gets opaque enum.
    console.error("api_error", e);
    return c.json({ error: "internal_error" }, 500);
  }
}
