// Test that every interactive form control has an accessible name,
// and that QrScanner and FaceScan announce state changes via live regions.
//
// Issue: fix(a11y): label the interactive controls that rely on placeholder text (closes #335)
//
// Acceptance criteria:
// 1. The jsx-a11y recommended set is enabled for the web app in eslint.config.js.
// 2. No form control relies solely on a placeholder for its name, asserted across all src files.
// 3. Scanner and face-scan state changes are announced via live regions.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FaceScan } from "../src/components/FaceScan.tsx";

const SRC_ROOT = fileURLToPath(new URL("../src/", import.meta.url));
const ESLINT_CONFIG_PATH = fileURLToPath(new URL("../../../eslint.config.js", import.meta.url));

/** Recursively collect every .tsx / .jsx file under a directory. */
function* walkTsx(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walkTsx(full);
    } else if (st.isFile()) {
      const ext = extname(full);
      if (ext === ".tsx" || ext === ".jsx") {
        yield full;
      }
    }
  }
}

describe("a11y configuration (issue #335)", () => {
  it("enables the broader jsx-a11y recommended rule set in eslint.config.js", () => {
    const configContent = readFileSync(ESLINT_CONFIG_PATH, "utf-8");
    expect(configContent).toContain("...a11y.configs.recommended.rules");
    expect(configContent).toContain('files: ["apps/web/src/**/*.{ts,tsx,jsx}"]');
  });
});

describe("a11y: every form control exposes an accessible name (no placeholder-only controls, issue #335)", () => {
  const files = [...walkTsx(SRC_ROOT)];

  it("found .tsx source files to audit", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const relPath = file.replace(SRC_ROOT, "src/");
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");

    const formControlLines: Array<{ lineNum: number; tag: string; snippet: string }> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (
        (line.includes("<input") || line.includes("<textarea") || line.includes("<select")) &&
        !line.includes("type=\"hidden\"")
      ) {
        // Grab context around control: 6 lines before and 12 lines after
        const start = Math.max(0, i - 6);
        const end = Math.min(lines.length, i + 14);
        const snippet = lines.slice(start, end).join("\n");
        formControlLines.push({
          lineNum: i + 1,
          tag: line.trim(),
          snippet,
        });
      }
    }

    if (formControlLines.length === 0) continue;

    describe(`\`${relPath}\``, () => {
      for (const ctrl of formControlLines) {
        it(`form control at line ${ctrl.lineNum} has an accessible label or name`, () => {
          const s = ctrl.snippet;
          const hasAriaLabel = /\baria-label\s*=/.test(s);
          const hasAriaLabelledBy = /\baria-labelledby\s*=/.test(s);
          const isWrappedInLabel = /<label[\s>]/.test(s);
          const hasHtmlFor = /\bhtmlFor\s*=/.test(s);

          const isAccessible = hasAriaLabel || hasAriaLabelledBy || isWrappedInLabel || hasHtmlFor;

          if (!isAccessible) {
            console.error(
              `Accessibility failure in ${relPath}:${ctrl.lineNum}\n` +
              `Control relies solely on placeholder or lacks accessible name:\n${ctrl.tag}`
            );
          }

          expect(isAccessible).toBe(true);
        });
      }
    });
  }
});

describe("a11y: QrScanner live region and keyboard accessibility (issue #335)", () => {
  const qrScannerPath = join(SRC_ROOT, "components", "QrScanner.tsx");
  const content = readFileSync(qrScannerPath, "utf-8");

  it("QrScanner exposes modal dialog semantics and accessible label", () => {
    expect(content).toContain('role="dialog"');
    expect(content).toContain('aria-modal="true"');
    expect(content).toContain('aria-label="Leitor de QR code"');
  });

  it("QrScanner has a live region announcing scan status", () => {
    expect(content).toContain('role="status"');
    expect(content).toContain('aria-live="polite"');
    expect(content).toContain('aria-atomic="true"');
  });

  it("QrScanner has an alert live region for camera or scan errors", () => {
    expect(content).toContain('role="alert"');
    expect(content).toContain('aria-live="assertive"');
  });

  it("QrScanner supports Escape key navigation to cancel", () => {
    expect(content).toContain('e.key === "Escape"');
    expect(content).toContain("onClose()");
  });

  it("QrScanner cancel button has an explicit accessible label", () => {
    expect(content).toContain('aria-label="Cancelar leitura do QR code"');
  });
});

describe("a11y: FaceScan live region and screen reader announcement (issue #335)", () => {
  const faceScanPath = join(SRC_ROOT, "components", "FaceScan.tsx");
  const content = readFileSync(faceScanPath, "utf-8");

  it("FaceScan root contains role=status and aria-live=polite", () => {
    expect(content).toContain('role="status"');
    expect(content).toContain('aria-live="polite"');
    expect(content).toContain('aria-atomic="true"');
  });

  it("announces scanning status to screen readers", () => {
    const markup = renderToStaticMarkup(React.createElement(FaceScan, { state: "scanning" }));
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("Verificando biometria facial...");
  });

  it("announces completion status to screen readers", () => {
    const markup = renderToStaticMarkup(React.createElement(FaceScan, { state: "done" }));
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("Biometria facial confirmada com sucesso");
  });

  it("hides decorative glyphs and animation lines with aria-hidden", () => {
    const markup = renderToStaticMarkup(React.createElement(FaceScan, { state: "scanning" }));
    expect(markup).toContain('aria-hidden="true"');
  });
});
