import { describe, it, expect } from "vitest";
import {
  resolveSafeStaticPath,
  ALLOWED_STATIC_EXTENSIONS,
} from "../src/static_resolver.ts";

describe("static_resolver: path traversal prevention and containment", () => {
  const root = "/app/web/dist";

  it("resolves valid static files contained within webDist", () => {
    expect(resolveSafeStaticPath(root, "/index.html")).toBe("/app/web/dist/index.html");
    expect(resolveSafeStaticPath(root, "/assets/app.js")).toBe("/app/web/dist/assets/app.js");
    expect(resolveSafeStaticPath(root, "styles/main.css")).toBe("/app/web/dist/styles/main.css");
    expect(resolveSafeStaticPath(root, "/favicon.ico")).toBe("/app/web/dist/favicon.ico");
  });

  it("rejects path traversal attempts with literal .. segments", () => {
    expect(resolveSafeStaticPath(root, "/../../etc/passwd")).toBeNull();
    expect(resolveSafeStaticPath(root, "/../app/index.html")).toBeNull();
    expect(resolveSafeStaticPath(root, "/assets/../../etc/shadow")).toBeNull();
    expect(resolveSafeStaticPath(root, "..")).toBeNull();
    expect(resolveSafeStaticPath(root, "/..")).toBeNull();
  });

  it("rejects percent-encoded path traversal sequences (%2e%2e%2f)", () => {
    expect(resolveSafeStaticPath(root, "/%2e%2e%2f%2e%2e%2fetc/passwd")).toBeNull();
    expect(resolveSafeStaticPath(root, "/%2E%2E/%2E%2E/windows/win.ini")).toBeNull();
    expect(resolveSafeStaticPath(root, "/assets/%2e%2e/secret.json")).toBeNull();
    expect(resolveSafeStaticPath(root, "%2e%2e")).toBeNull();
  });

  it("rejects paths containing literal or percent-encoded NUL bytes", () => {
    expect(resolveSafeStaticPath(root, "/%00index.html")).toBeNull();
    expect(resolveSafeStaticPath(root, "/index.html\0.js")).toBeNull();
    expect(resolveSafeStaticPath(root, "/test%00.png")).toBeNull();
  });

  it("rejects unknown extensions or paths without extension (falling back rather than octet-stream)", () => {
    expect(resolveSafeStaticPath(root, "/api/keys.env")).toBeNull();
    expect(resolveSafeStaticPath(root, "/bin/malware.exe")).toBeNull();
    expect(resolveSafeStaticPath(root, "/script.sh")).toBeNull();
    expect(resolveSafeStaticPath(root, "/config.yaml")).toBeNull();
    expect(resolveSafeStaticPath(root, "/dashboard")).toBeNull();
    expect(resolveSafeStaticPath(root, "/")).toBeNull();
  });

  it("verifies full set of allowed web extensions", () => {
    for (const ext of ["html", "js", "css", "json", "png", "svg", "ico", "woff", "woff2", "webp"]) {
      expect(ALLOWED_STATIC_EXTENSIONS.has(ext)).toBe(true);
    }
    expect(ALLOWED_STATIC_EXTENSIONS.has("exe")).toBe(false);
    expect(ALLOWED_STATIC_EXTENSIONS.has("env")).toBe(false);
    expect(ALLOWED_STATIC_EXTENSIONS.has("sh")).toBe(false);
  });
});
