import { describe, it, expect, vi, beforeEach } from "vitest";
import { lookup } from "node:dns/promises";
import {
  validateWebhookUrl,
  createPinnedLookup,
  pinnedDispatcher,
  type ValidatedTarget,
} from "../src/ssrf.js";
import { deliverOnce } from "../src/webhook.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

const mockLookup = lookup as unknown as ReturnType<typeof vi.fn>;

describe("DNS Rebinding & Pinning Protection (Issue #251)", () => {
  const dummyTarget: ValidatedTarget = {
    hostname: "safe.example.com",
    ip: "93.184.216.34",
    family: 4,
    port: 443,
    protocol: "https:",
  };

  const dummyIpv6Target: ValidatedTarget = {
    hostname: "ipv6.example.com",
    ip: "2606:2800:220:1:248:1893:25c8:1946",
    family: 6,
    port: 443,
    protocol: "https:",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createPinnedLookup callback modes", () => {
    it("returns an array of address objects when opts.all is true (mode required by undici)", () => {
      const lookupFn = createPinnedLookup(dummyTarget);
      let cbErr: Error | null = new Error("not called");
      let cbAddress: any;
      let cbFamily: number | undefined;

      lookupFn("safe.example.com", { all: true }, (err, address, family) => {
        cbErr = err;
        cbAddress = address;
        cbFamily = family;
      });

      expect(cbErr).toBeNull();
      expect(Array.isArray(cbAddress)).toBe(true);
      expect(cbAddress).toEqual([{ address: "93.184.216.34", family: 4 }]);
      expect(cbFamily).toBeUndefined();
    });

    it("returns an array of address objects with IPv6 family when opts.all is true", () => {
      const lookupFn = createPinnedLookup(dummyIpv6Target);
      let cbErr: Error | null = null;
      let cbAddress: any;

      lookupFn("ipv6.example.com", { all: true }, (err, address) => {
        cbErr = err;
        cbAddress = address;
      });

      expect(cbErr).toBeNull();
      expect(cbAddress).toEqual([
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      ]);
    });

    it("returns (err, ip, family) when opts.all is false, undefined, or empty", () => {
      const lookupFn = createPinnedLookup(dummyTarget);

      for (const opts of [undefined, {}, { all: false }]) {
        let cbErr: Error | null = new Error("not called");
        let cbAddress: any;
        let cbFamily: number | undefined;

        lookupFn("safe.example.com", opts, (err, address, family) => {
          cbErr = err;
          cbAddress = address;
          cbFamily = family;
        });

        expect(cbErr).toBeNull();
        expect(cbAddress).toBe("93.184.216.34");
        expect(cbFamily).toBe(4);
      }
    });
  });

  describe("DNS rebinding pinning end-to-end", () => {
    it("pins connection address even if subsequent DNS answers rebind to an internal address", async () => {
      // 1. Initial resolution during validation yields public IP 93.184.216.34
      mockLookup.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);

      const validated = await validateWebhookUrl("https://rebinding.attacker.example/wh", false);
      expect(validated.safe).toBe(true);
      if (!validated.safe) return;

      expect(validated.target.ip).toBe("93.184.216.34");

      // 2. Attacker DNS rebinding triggers: subsequent DNS resolves to cloud metadata 169.254.169.254
      mockLookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);

      // 3. Dispatcher lookup must still strictly resolve to the pinned target.ip
      const pinnedLookup = createPinnedLookup(validated.target);

      pinnedLookup("rebinding.attacker.example", { all: true }, (err, addresses) => {
        expect(err).toBeNull();
        expect(addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
      });

      pinnedLookup("rebinding.attacker.example", {}, (err, address, family) => {
        expect(err).toBeNull();
        expect(address).toBe("93.184.216.34");
        expect(family).toBe(4);
      });
    });

    it("pinnedDispatcher instantiates an Agent with the pinned lookup callback", () => {
      const dispatcher = pinnedDispatcher(dummyTarget);
      expect(dispatcher).toBeDefined();
    });
  });

  describe("validation-time rejection prevents any outbound connection attempt", () => {
    it("does not initiate any fetch or socket connection when URL validation fails", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      // Blocked literal IP URL
      const res = await deliverOnce({
        url: "http://169.254.169.254/latest/meta-data/",
        secret: "sec_123",
        deliveryId: "del_1",
        payload: { test: true },
        allowLocal: false,
      });

      expect(res.status).toBe("failed");
      expect(res.body).toContain("unsafe_url");
      expect(fetchSpy).not.toHaveBeenCalled();

      // Blocked via DNS resolution to private IP
      mockLookup.mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }]);
      const dnsRes = await deliverOnce({
        url: "https://evil.internal.example/webhook",
        secret: "sec_123",
        deliveryId: "del_2",
        payload: { test: true },
        allowLocal: false,
      });

      expect(dnsRes.status).toBe("failed");
      expect(dnsRes.body).toContain("unsafe_url");
      expect(fetchSpy).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
    });
  });
});
