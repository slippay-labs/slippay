import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DARK,
  dk,
  detectTheme,
  setTheme,
  normalizeTheme,
  THEME_KEY,
  DEFAULT_THEME,
} from "../src/lib/darkTheme.js";

describe("lib/darkTheme.ts: Theme Tokens & Persistence", () => {
  let store: Record<string, string> = {};

  const mockLocalStorage = {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, val: string) => {
      store[key] = val;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    length: 0,
    key: vi.fn(() => null),
  };

  beforeEach(() => {
    store = {};
    vi.clearAllMocks();
    vi.stubGlobal("localStorage", mockLocalStorage);
    vi.stubGlobal("window", { localStorage: mockLocalStorage });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("Theme Tokens Consistency", () => {
    it("exposes immutable DARK color palette tokens matching Secuury/V3 register", () => {
      expect(DARK.bg).toBe("#0a0e1a");
      expect(DARK.bg2).toBe("#0d1322");
      expect(DARK.ink).toBe("#f3f5fb");
      expect(DARK.muted).toBe("#8a93ad");
      expect(DARK.cyan).toBe("#22d3ee");
      expect(DARK.cyan2).toBe("#38bdf8");
      expect(DARK.line).toBe("rgba(255,255,255,0.08)");
      expect(DARK.ok).toBe("#34d399");
      expect(DARK.leak).toBe("#fb7185");
    });

    it("exposes consistent Tailwind utility fragments in dk", () => {
      expect(dk.page).toContain("bg-[#0a0e1a]");
      expect(dk.page).toContain("text-[#f3f5fb]");
      expect(dk.panel).toContain("bg-[#0d1322]");
      expect(dk.panel).toContain("rounded-2xl");
      expect(dk.cta).toContain("bg-gradient-to-r from-[#22d3ee] to-[#38bdf8]");
      expect(dk.ghost).toContain("border-[#22d3ee]");
      expect(dk.card).toContain("bg-[#0d1322]");
      expect(dk.label).toContain("tracking-[0.22em]");
    });
  });

  describe("normalizeTheme", () => {
    it("accepts valid theme values 'dark' and 'system'", () => {
      expect(normalizeTheme("dark")).toBe("dark");
      expect(normalizeTheme("system")).toBe("system");
    });

    it("falls back to DEFAULT_THEME ('dark') on unknown or malformed input", () => {
      expect(normalizeTheme("light")).toBe(DEFAULT_THEME);
      expect(normalizeTheme("neon")).toBe(DEFAULT_THEME);
      expect(normalizeTheme("")).toBe(DEFAULT_THEME);
      expect(normalizeTheme(null)).toBe(DEFAULT_THEME);
      expect(normalizeTheme(undefined)).toBe(DEFAULT_THEME);
      expect(normalizeTheme(42)).toBe(DEFAULT_THEME);
    });
  });

  describe("detectTheme and setTheme persistence", () => {
    it("defaults to 'dark' when storage is empty", () => {
      expect(detectTheme()).toBe(DEFAULT_THEME);
      expect(mockLocalStorage.getItem).toHaveBeenCalledWith(THEME_KEY);
    });

    it("reads persisted 'dark' from storage", () => {
      store[THEME_KEY] = "dark";
      expect(detectTheme()).toBe("dark");
      expect(mockLocalStorage.getItem).toHaveBeenCalledWith(THEME_KEY);
    });

    it("reads persisted 'system' from storage", () => {
      store[THEME_KEY] = "system";
      expect(detectTheme()).toBe("system");
      expect(mockLocalStorage.getItem).toHaveBeenCalledWith(THEME_KEY);
    });

    it("ignores unrecognized stored themes and falls back to 'dark'", () => {
      store[THEME_KEY] = "light";
      expect(detectTheme()).toBe("dark");

      store[THEME_KEY] = "unknown";
      expect(detectTheme()).toBe("dark");
    });

    it("persists theme change via setTheme", () => {
      setTheme("system");
      expect(store[THEME_KEY]).toBe("system");
      expect(mockLocalStorage.setItem).toHaveBeenCalledWith(THEME_KEY, "system");

      setTheme("dark");
      expect(store[THEME_KEY]).toBe("dark");
    });

    it("gracefully catches storage errors on read and write", () => {
      mockLocalStorage.getItem.mockImplementationOnce(() => {
        throw new Error("Access Denied");
      });
      expect(detectTheme()).toBe(DEFAULT_THEME);

      mockLocalStorage.setItem.mockImplementationOnce(() => {
        throw new Error("Storage full");
      });
      expect(() => setTheme("system")).not.toThrow();
    });
  });
});
