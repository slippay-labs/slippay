import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { mapDbError } from "../lib/db-error.ts";

Deno.test("mapDbError handles null or undefined with 500 internal_error", () => {
  assertEquals(mapDbError(null), { code: "internal_error", status: 500 });
  assertEquals(mapDbError(undefined), { code: "internal_error", status: 500 });
});

Deno.test("mapDbError maps all recognized Postgres codes correctly", () => {
  assertEquals(mapDbError({ code: "23505" }), { code: "constraint_violation", status: 409 });
  assertEquals(mapDbError({ code: "23503" }), { code: "reference_invalid", status: 400 });
  assertEquals(mapDbError({ code: "23502" }), { code: "value_required", status: 400 });
  assertEquals(mapDbError({ code: "23514" }), { code: "value_invalid", status: 400 });
  assertEquals(mapDbError({ code: "22001" }), { code: "value_too_long", status: 400 });
  assertEquals(mapDbError({ code: "22003" }), { code: "value_out_of_range", status: 400 });
  assertEquals(mapDbError({ code: "22P02" }), { code: "value_invalid", status: 400 });
  assertEquals(mapDbError({ code: "42501" }), { code: "forbidden", status: 403 });
  assertEquals(mapDbError({ code: "40001" }), { code: "conflict_retry", status: 409 });
  assertEquals(mapDbError({ code: "PGRST116" }), { code: "not_found", status: 404 });
});

Deno.test("mapDbError sniffs nested error messages for known patterns", () => {
  assertEquals(mapDbError({ message: "duplicate key value violates unique constraint" }), {
    code: "constraint_violation",
    status: 409,
  });
  assertEquals(mapDbError({ message: "violates check constraint foo_check" }), {
    code: "value_invalid",
    status: 400,
  });
  assertEquals(mapDbError({ message: "violates foreign key constraint bar_fk" }), {
    code: "reference_invalid",
    status: 400,
  });
});

Deno.test("mapDbError maps unmapped errors to 500 internal_error and logs original code", () => {
  const originalConsoleError = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };

  try {
    const unmapped1 = mapDbError({ code: "08006", message: "connection failure" });
    assertEquals(unmapped1, { code: "internal_error", status: 500 });
    assertEquals(logged.some((log) => log.includes("08006")), true);

    const unmapped2 = mapDbError({ code: "57P01", message: "admin shutdown" });
    assertEquals(unmapped2, { code: "internal_error", status: 500 });
    assertEquals(logged.some((log) => log.includes("57P01")), true);

    const unmappedNoCode = mapDbError({ message: "something weird without code" });
    assertEquals(unmappedNoCode, { code: "internal_error", status: 500 });
    assertEquals(logged.some((log) => log.includes("unknown")), true);
  } finally {
    console.error = originalConsoleError;
  }
});
