import {
  assertEquals,
  assertMatch,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const source = await Deno.readTextFile(
  new URL("./fourp.ts", import.meta.url),
);

Deno.test("disabled 4P integration uses a distinct 501 status", () => {
  const responses = [
    ...source.matchAll(
      /error:\s*["']ramp_disabled["']\s*}\s*,\s*(\d+)/g,
    ),
  ];

  assertEquals(responses.length > 0, true);
  assertEquals(
    responses.map((match) => match[1]),
    Array(responses.length).fill("501"),
  );
});

Deno.test("configured-provider failures retain gateway error semantics", () => {
  assertMatch(source, /instanceof\s+FourPError/);
  assertMatch(source, /\b502\b/);
});
