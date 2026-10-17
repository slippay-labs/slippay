import { describe, it, expect } from "vitest";
import {
  isLoopbackHost,
  assertSecureEndpoint,
  resolveApiBase,
  resolveRelayerBase,
  DEV_DEFAULT_API_BASE,
  CANONICAL_RELAYER_BASE,
} from "./endpointSecurity";

describe("endpointSecurity (Issue #197)", () => {
  describe("isLoopbackHost", () => {
    it("recognizes common local loopback hosts", () => {
      expect(isLoopbackHost("localhost")).toBe(true);
      expect(isLoopbackHost("127.0.0.1")).toBe(true);
      expect(isLoopbackHost("::1")).toBe(true);
      expect(isLoopbackHost("[::1]")).toBe(true);
      expect(isLoopbackHost("subdomain.localhost")).toBe(true);
      expect(isLoopbackHost("0.0.0.0")).toBe(true);
    });

    it("rejects public / remote hostnames", () => {
      expect(isLoopbackHost("api.slippay.cc")).toBe(false);
      expect(isLoopbackHost("slippay.cc")).toBe(false);
      expect(isLoopbackHost("example.com")).toBe(false);
      expect(isLoopbackHost("192.168.1.100")).toBe(false);
    });
  });

  describe("assertSecureEndpoint", () => {
    it("accepts valid https: endpoints", () => {
      expect(
        assertSecureEndpoint("https://api.slippay.cc/functions/v1/api", "VITE_API_BASE")
      ).toBe("https://api.slippay.cc/functions/v1/api");
      expect(
        assertSecureEndpoint("https://api.slippay.cc/functions/v1/api/", "VITE_API_BASE")
      ).toBe("https://api.slippay.cc/functions/v1/api");
    });

    it("accepts http: on loopback hosts for local development", () => {
      expect(
        assertSecureEndpoint("http://localhost:54321/functions/v1/api", "VITE_API_BASE")
      ).toBe("http://localhost:54321/functions/v1/api");
      expect(
        assertSecureEndpoint("http://127.0.0.1:54321/functions/v1/api", "VITE_API_BASE")
      ).toBe("http://127.0.0.1:54321/functions/v1/api");
      expect(
        assertSecureEndpoint("http://[::1]:54321/functions/v1/api", "VITE_API_BASE")
      ).toBe("http://[::1]:54321/functions/v1/api");
    });

    it("strictly rejects plaintext http: on non-loopback hosts", () => {
      expect(() =>
        assertSecureEndpoint("http://api.slippay.cc/functions/v1/api", "VITE_API_BASE")
      ).toThrowError(/Insecure HTTP protocol not allowed for non-loopback endpoint/);

      expect(() =>
        assertSecureEndpoint("http://remote.host.internal/api", "VITE_RELAYER_BASE")
      ).toThrowError(/Insecure HTTP protocol not allowed/);
    });

    it("rejects invalid and malformed URLs", () => {
      expect(() => assertSecureEndpoint("not-a-valid-url", "VITE_API_BASE")).toThrowError(
        /Invalid URL configured for VITE_API_BASE/
      );
      expect(() => assertSecureEndpoint("ftp://ftp.example.com", "VITE_API_BASE")).toThrowError(
        /Unsupported protocol/
      );
    });
  });

  describe("resolveApiBase", () => {
    it("returns loopback default when unset in development mode", () => {
      const resolved = resolveApiBase(undefined, true);
      expect(resolved).toBe(DEV_DEFAULT_API_BASE);
    });

    it("throws a clear error when unset in production mode", () => {
      expect(() => resolveApiBase(undefined, false)).toThrowError(
        /VITE_API_BASE is required in production builds but was not configured/
      );
      expect(() => resolveApiBase("", false)).toThrowError(
        /VITE_API_BASE is required in production builds but was not configured/
      );
      expect(() => resolveApiBase("   ", false)).toThrowError(
        /VITE_API_BASE is required in production builds but was not configured/
      );
    });

    it("proves the loopback default is completely unreachable in production builds", () => {
      // In production mode with no variable provided, loopback must NEVER be returned
      let errorThrown = false;
      try {
        const result = resolveApiBase(undefined, false);
        // If it returns anything, it must not be the loopback default
        expect(result).not.toBe(DEV_DEFAULT_API_BASE);
      } catch (err) {
        errorThrown = true;
        expect((err as Error).message).toContain("required in production builds");
      }
      expect(errorThrown).toBe(true);
    });

    it("resolves securely when explicit HTTPS endpoint is configured", () => {
      const explicit = "https://production-api.slippay.cc/functions/v1/api";
      expect(resolveApiBase(explicit, false)).toBe(explicit);
      expect(resolveApiBase(explicit, true)).toBe(explicit);
    });

    it("rejects insecure plaintext non-loopback endpoint even in development", () => {
      expect(() =>
        resolveApiBase("http://api.slippay.cc/functions/v1/api", true)
      ).toThrowError(/Insecure HTTP protocol not allowed/);
    });
  });

  describe("resolveRelayerBase", () => {
    it("defaults to canonical HTTPS relayer endpoint when unset", () => {
      expect(resolveRelayerBase(undefined)).toBe(CANONICAL_RELAYER_BASE);
      expect(resolveRelayerBase("")).toBe(CANONICAL_RELAYER_BASE);
    });

    it("accepts custom HTTPS relayer endpoint", () => {
      const custom = "https://custom-relayer.slippay.cc/api/v1/relayer";
      expect(resolveRelayerBase(custom)).toBe(custom);
    });

    it("rejects insecure non-loopback HTTP relayer endpoint", () => {
      expect(() =>
        resolveRelayerBase("http://api.slippay.cc/api/v1/relayer")
      ).toThrowError(/Insecure HTTP protocol not allowed/);
    });
  });
});
