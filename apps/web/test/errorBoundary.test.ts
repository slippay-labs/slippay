import { describe, it, expect, vi, beforeEach } from "vitest";
import React, { createElement } from "react";
import {
  ErrorBoundary,
  PaymentErrorBoundary,
  AppRootErrorBoundary,
  sanitizeErrorMessage,
} from "../src/components/ErrorBoundary.js";

describe("ErrorBoundary & Payment Route Protection (closes #333)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("sanitizeErrorMessage — credential leak prevention", () => {
    it("redacts JWT and Bearer tokens from error strings", () => {
      const raw = "Request failed with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThisSignature";
      const sanitized = sanitizeErrorMessage(raw);
      expect(sanitized).not.toContain("eyJhbGci");
      expect(sanitized).toContain("[REDACTED_JWT]");
    });

    it("redacts Stellar secret keys (S...) from error strings", () => {
      // 56-character Stellar secret key
      const secret = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      const raw = `Transaction signing failed for key: ${secret}`;
      const sanitized = sanitizeErrorMessage(raw);
      expect(sanitized).not.toContain(secret);
      expect(sanitized).toContain("[REDACTED_STELLAR_SECRET]");
    });

    it("redacts 64-character hex private keys", () => {
      const hexKey = "0x" + "a".repeat(64);
      const raw = `Invalid key format: ${hexKey}`;
      const sanitized = sanitizeErrorMessage(raw);
      expect(sanitized).not.toContain(hexKey);
      expect(sanitized).toContain("[REDACTED_HEX_KEY]");
    });

    it("redacts sensitive query parameters like ?token= or &secret=", () => {
      const raw = "Failed to load https://api.slippay.cc/v1?token=secret_abc123&session=user_sess_xyz";
      const sanitized = sanitizeErrorMessage(raw);
      expect(sanitized).not.toContain("secret_abc123");
      expect(sanitized).not.toContain("user_sess_xyz");
      expect(sanitized).toContain("token=[REDACTED]");
      expect(sanitized).toContain("session=[REDACTED]");
    });

    it("safely handles empty or undefined error messages", () => {
      expect(sanitizeErrorMessage("")).toBe("");
      expect(sanitizeErrorMessage(null as unknown as string)).toBe("");
    });
  });

  describe("ErrorBoundary lifecycle & state management", () => {
    it("transitions to hasError: true on getDerivedStateFromError and generates ref ID", () => {
      const testError = new Error("Render exploded");
      const nextState = ErrorBoundary.getDerivedStateFromError(testError);

      expect(nextState.hasError).toBe(true);
      expect(nextState.error).toBe(testError);
      expect(nextState.errorId).toMatch(/^ERR-[0-9A-Z]+-[0-9A-Z]+$/);
    });

    it("sanitizes error in componentDidCatch and invokes onError callback", () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const onErrorMock = vi.fn();

      const boundary = new ErrorBoundary({
        children: null,
        name: "TestBoundary",
        onError: onErrorMock,
      });

      const rawSecret = "0x" + "f".repeat(64);
      const testError = new Error(`Crashed with private key: ${rawSecret}`);
      const testInfo = { componentStack: "at FlakyPaymentComponent" };

      boundary.componentDidCatch(testError, testInfo);

      expect(consoleSpy).toHaveBeenCalled();
      expect(onErrorMock).toHaveBeenCalledTimes(1);

      const reportedError = onErrorMock.mock.calls[0]![0] as Error;
      expect(reportedError.message).not.toContain(rawSecret);
      expect(reportedError.message).toContain("[REDACTED_HEX_KEY]");
    });

    it("renders fallback UI rather than crashing blank when hasError is true", () => {
      const boundary = new ErrorBoundary({
        children: createElement("div", { id: "normal-content" }, "Normal Checkout"),
        name: "PaymentRoutes",
        orderId: "ord_live_test_123",
      });

      // Initially renders normal children
      expect(boundary.render()).toEqual(
        createElement("div", { id: "normal-content" }, "Normal Checkout"),
      );

      // Simulate render error catch
      boundary.state = {
        hasError: true,
        error: new Error("Sub-component render failure"),
        errorId: "ERR-TEST-123",
      };

      const fallbackVNode = boundary.render() as React.ReactElement;
      expect(fallbackVNode).toBeDefined();
      expect(fallbackVNode.props["data-testid"]).toBe("error-boundary-fallback");
    });

    it("offers a retry action that clears error state and allows recovery", () => {
      const onResetMock = vi.fn();
      const boundary = new ErrorBoundary({
        children: createElement("div", null, "Recovered"),
        onReset: onResetMock,
      });

      boundary.state = {
        hasError: true,
        error: new Error("Temporary glitch"),
        errorId: "ERR-GLITCH",
      };

      // User clicks retry
      boundary.reset();

      expect(onResetMock).toHaveBeenCalledTimes(1);
      expect(boundary.state.hasError).toBe(false);
      expect(boundary.state.error).toBeNull();
      expect(boundary.state.errorId).toBeNull();
    });

    it("supports custom fallback render prop", () => {
      const customFallback = vi.fn((err: Error, reset: () => void) =>
        createElement("button", { onClick: reset }, `Custom: ${err.message}`),
      );

      const boundary = new ErrorBoundary({
        children: null,
        fallback: customFallback,
      });

      boundary.state = {
        hasError: true,
        error: new Error("Custom error"),
        errorId: "ERR-CUSTOM",
      };

      const rendered = boundary.render();
      expect(customFallback).toHaveBeenCalledWith(boundary.state.error, expect.any(Function));
      expect(rendered).toBeDefined();
    });
  });

  describe("PaymentErrorBoundary and AppRootErrorBoundary helpers", () => {
    it("renders PaymentErrorBoundary with payment context and order reference", () => {
      const paymentBoundary = PaymentErrorBoundary({
        children: createElement("div", null, "Checkout Form"),
        orderId: "ord_xyz789",
      });

      expect(paymentBoundary.props.name).toBe("PaymentRoutes");
      expect(paymentBoundary.props.orderId).toBe("ord_xyz789");
    });

    it("renders AppRootErrorBoundary with AppRoot scope", () => {
      const rootBoundary = AppRootErrorBoundary({
        children: createElement("div", null, "Root App"),
      });

      expect(rootBoundary.props.name).toBe("AppRoot");
    });

    it("isolates payment failures: non-payment failure does not unmount payment route", () => {
      // Demonstrates fault isolation:
      // An error in an unrelated widget (e.g. news/promo) inside an isolated boundary
      // catches its own throw while a sibling PaymentErrorBoundary retains normal children.
      const isolatedWidgetBoundary = new ErrorBoundary({
        name: "PromoWidget",
        children: createElement("div", null, "Promo Banner"),
      });
      isolatedWidgetBoundary.state = {
        hasError: true,
        error: new Error("Promo failed"),
        errorId: "ERR-PROMO",
      };

      const siblingPaymentBoundary = new ErrorBoundary({
        name: "PaymentRoutes",
        children: createElement("div", { id: "active-checkout" }, "Order $100"),
      });

      // Promo widget shows fallback
      expect((isolatedWidgetBoundary.render() as React.ReactElement).props["data-testid"]).toBe(
        "error-boundary-fallback",
      );
      // Payment route remains fully mounted and functional
      expect(siblingPaymentBoundary.render()).toEqual(
        createElement("div", { id: "active-checkout" }, "Order $100"),
      );
    });
  });
});
