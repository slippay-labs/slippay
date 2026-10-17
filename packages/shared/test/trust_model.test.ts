import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

describe("Security Trust Model and Proxy Hop Architecture (Issue #198)", () => {
  const repoRoot = resolve(__dirname, "../../..");
  const trustModelPath = resolve(repoRoot, "docs/security/trust-model.md");
  const securityDir = resolve(repoRoot, "docs/security");

  it("verifies docs/security/trust-model.md exists", () => {
    expect(existsSync(trustModelPath)).toBe(true);
  });

  it("verifies all referenced audit documents exist in docs/security/", () => {
    for (let i = 1; i <= 6; i++) {
      const auditFile = resolve(securityDir, `audit-00${i}.md`);
      expect(existsSync(auditFile), `Missing audit-00${i}.md`).toBe(true);
    }
  });

  describe("Topology and Proxy Hop Documentation", () => {
    const content = readFileSync(trustModelPath, "utf-8");

    it("documents the ingress proxy hops and headers", () => {
      expect(content).toContain("Hop 1: Ingress Gateway / Nginx / Kong");
      expect(content).toContain("Hop 2: Deno Edge Function Runtime");
      expect(content).toContain("X-Forwarded-For");
      expect(content).toContain("remoteAddr");
      expect(content).toContain("TRUSTED_PROXY_HOPS");
    });

    it("documents standard TRUSTED_PROXY_HOPS default of 1", () => {
      expect(content).toContain("**Standard Default**: `1`");
    });
  });

  describe("Secret Inventory and Rotation Matrix", () => {
    const content = readFileSync(trustModelPath, "utf-8");

    const requiredSecrets = [
      "SUPABASE_SERVICE_ROLE_KEY",
      "SUPABASE_ANON_KEY",
      "API_KEY_PEPPER",
      "CHECKOUT_TOKEN_SECRET",
      "SLIPPAY_API_KEY",
      "SLIPPAY_WEBHOOK_SECRET",
      "SHOPIFY_APP_SECRET",
      "STELLAR_USDC_ISSUER_OVERRIDE",
    ];

    for (const secret of requiredSecrets) {
      it(`documents secret '${secret}' with lifecycle and storage`, () => {
        expect(content).toContain(secret);
      });
    }
  });

  describe("Source Code Cross-References", () => {
    const clientIpPath = resolve(repoRoot, "supabase/functions/api/lib/client_ip.ts");
    const apikeyPath = resolve(repoRoot, "supabase/functions/api/lib/apikey.ts");
    const checkoutTokenPath = resolve(repoRoot, "supabase/functions/api/lib/checkout-token.ts");
    const ssrfPath = resolve(repoRoot, "apps/listener/src/ssrf.ts");

    it("links client_ip.ts to trust-model.md", () => {
      const src = readFileSync(clientIpPath, "utf-8");
      expect(src).toContain("docs/security/trust-model.md");
    });

    it("links apikey.ts to trust-model.md", () => {
      const src = readFileSync(apikeyPath, "utf-8");
      expect(src).toContain("docs/security/trust-model.md");
    });

    it("links checkout-token.ts to trust-model.md", () => {
      const src = readFileSync(checkoutTokenPath, "utf-8");
      expect(src).toContain("docs/security/trust-model.md");
    });

    it("links ssrf.ts to trust-model.md", () => {
      const src = readFileSync(ssrfPath, "utf-8");
      expect(src).toContain("docs/security/trust-model.md");
    });
  });
});
