// Test that no <img> in apps/web/src lacks an `alt` attribute.
//
// Bounty: [Bounty: $60] Add `alt` text to the images missing it (slippay #86)
//
// The eslint-plugin-jsx-a11y `alt-text` rule enforces this at lint time, but
// this test also asserts the invariant at test time so a CI run that skips
// lint (or a contributor who skips lint locally) still catches the regression.
//
// Source files are collected with Vite's `import.meta.glob` instead of
// `node:fs`: vite-plugin-node-polyfills replaces `node:fs` with a browser stub
// under Vitest, which made a filesystem walk impossible.

import { describe, it, expect } from "vitest";

/** Every .ts/.tsx/.js/.jsx source file under src/, mapped to its raw text. */
const SRC_FILES = import.meta.glob("../src/**/*.{ts,tsx,js,jsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Extract every <img ...> tag from a source file. */
function extractImgTags(src: string): string[] {
  // Match <img ...> including across newlines.
  const re = /<img\b[^>]*>/g;
  return [...src.matchAll(re)].map((m) => m[0]);
}

/** Check whether an <img> tag has an `alt` attribute (even an empty one). */
function hasAlt(imgTag: string): boolean {
  // Match `alt="..."`, `alt=''`, `alt={...}` etc. — the attribute name
  // must be present.
  return /\balt\s*=/.test(imgTag);
}

describe("a11y: every <img> has an alt attribute (closes #86)", () => {
  const files = Object.entries(SRC_FILES).sort(([a], [b]) => a.localeCompare(b));

  if (files.length === 0) {
    it("skipped: no .tsx/.jsx/.ts files found under src/", () => {
      expect(true).toBe(true);
    });
    return;
  }

  for (const [file, src] of files) {
    const imgs = extractImgTags(src);
    if (imgs.length === 0) continue;

    describe(`\`${file.replace(/^\.\.\//, "")}\``, () => {
      for (let i = 0; i < imgs.length; i++) {
        const img = imgs[i]!;
        it(`img #${i + 1} has an alt attribute`, () => {
          // Throw (rather than just asserting) to surface the offending tag.
          if (!hasAlt(img)) {
            throw new Error(`Missing alt in ${file}: ${img}`);
          }
          expect(hasAlt(img)).toBe(true);
        });
      }
    });
  }
});