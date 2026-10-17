import { describe, it, expect } from "vitest";
import {
  DEFAULT_MAX_ORDER_USDC,
  SYSTEM_MAX_ORDER_USDC,
  DEFAULT_MAX_ORDER_BRL,
  SYSTEM_MAX_ORDER_BRL,
  UsdcAmountSchema,
  CreateOrderInputSchema,
} from "../src/index.ts";

describe("Order maximum limits (Issue #208)", () => {
  it("defines standard default and system maximum limits", () => {
    expect(DEFAULT_MAX_ORDER_USDC).toBe(50_000);
    expect(SYSTEM_MAX_ORDER_USDC).toBe(250_000);
    expect(DEFAULT_MAX_ORDER_BRL).toBe(300_000);
    expect(SYSTEM_MAX_ORDER_BRL).toBe(1_500_000);
  });

  describe("UsdcAmountSchema bounds", () => {
    it("accepts amounts at or below system maximum", () => {
      expect(UsdcAmountSchema.parse("1.00")).toBe("1.00");
      expect(UsdcAmountSchema.parse("50000.0000000")).toBe("50000.0000000");
      expect(UsdcAmountSchema.parse("250000.0000000")).toBe("250000.0000000");
    });

    it("rejects amounts exceeding system maximum", () => {
      expect(() => UsdcAmountSchema.parse("250000.0000001")).toThrow(
        `exceeds system maximum order limit of ${SYSTEM_MAX_ORDER_USDC} USDC`,
      );
      expect(() => UsdcAmountSchema.parse("999999999.00")).toThrow(
        `exceeds system maximum order limit of ${SYSTEM_MAX_ORDER_USDC} USDC`,
      );
    });
  });

  describe("CreateOrderInputSchema bounds", () => {
    it("accepts valid BRL and USD amounts within limit", () => {
      const validBrl = CreateOrderInputSchema.parse({ brl_amount: "100.00" });
      expect(validBrl.brl_amount).toBe("100.00");

      const validUsd = CreateOrderInputSchema.parse({ usd_amount: "50000.00" });
      expect(validUsd.usd_amount).toBe("50000.00");
    });

    it("rejects BRL amounts exceeding system maximum", () => {
      expect(() => CreateOrderInputSchema.parse({ brl_amount: "1500000.01" })).toThrow(
        `exceeds system maximum order limit of ${SYSTEM_MAX_ORDER_BRL} BRL`,
      );
    });

    it("rejects USD amounts exceeding system maximum", () => {
      expect(() => CreateOrderInputSchema.parse({ usd_amount: "250000.01" })).toThrow(
        `exceeds system maximum order limit of ${SYSTEM_MAX_ORDER_USDC} USDC`,
      );
    });
  });
});
