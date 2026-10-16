import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  detectLang,
  normalizeLang,
  useLang,
  LANG_KEY,
  DEFAULT_LANG,
} from "../src/lib/lang.js";

describe("lib/lang.ts: Locale Strategy & Language Helper", () => {
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
    vi.stubGlobal("document", {
      documentElement: { lang: "pt-BR" },
    });
    vi.stubGlobal("navigator", { language: "pt-BR" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("normalizeLang", () => {
    it("preserves supported languages 'pt' and 'en'", () => {
      expect(normalizeLang("pt")).toBe("pt");
      expect(normalizeLang("en")).toBe("en");
    });

    it("falls back to DEFAULT_LANG ('pt') for unsupported strings or invalid types", () => {
      expect(normalizeLang("es")).toBe(DEFAULT_LANG);
      expect(normalizeLang("fr")).toBe(DEFAULT_LANG);
      expect(normalizeLang("zh")).toBe(DEFAULT_LANG);
      expect(normalizeLang("")).toBe(DEFAULT_LANG);
      expect(normalizeLang(null)).toBe(DEFAULT_LANG);
      expect(normalizeLang(undefined)).toBe(DEFAULT_LANG);
      expect(normalizeLang(123)).toBe(DEFAULT_LANG);
      expect(normalizeLang({})).toBe(DEFAULT_LANG);
    });
  });

  describe("detectLang", () => {
    it("returns stored 'pt' when storage contains 'pt'", () => {
      store[LANG_KEY] = "pt";
      expect(detectLang()).toBe("pt");
      expect(mockLocalStorage.getItem).toHaveBeenCalledWith(LANG_KEY);
    });

    it("returns stored 'en' when storage contains 'en'", () => {
      store[LANG_KEY] = "en";
      expect(detectLang()).toBe("en");
      expect(mockLocalStorage.getItem).toHaveBeenCalledWith(LANG_KEY);
    });

    it("ignores unsupported stored values and falls back safely", () => {
      store[LANG_KEY] = "unsupported_locale";
      vi.stubGlobal("navigator", { language: "pt-BR" });
      expect(detectLang()).toBe("pt");
    });

    it("detects 'en' when navigator language starts with 'en' and no valid storage", () => {
      vi.stubGlobal("navigator", { language: "en-US" });
      expect(detectLang()).toBe("en");

      vi.stubGlobal("navigator", { language: "EN-GB" });
      expect(detectLang()).toBe("en");
    });

    it("defaults to 'pt' when navigator language is non-English", () => {
      vi.stubGlobal("navigator", { language: "pt-BR" });
      expect(detectLang()).toBe("pt");

      vi.stubGlobal("navigator", { language: "es-ES" });
      expect(detectLang()).toBe("pt");

      vi.stubGlobal("navigator", { language: "ja-JP" });
      expect(detectLang()).toBe("pt");
    });

    it("gracefully handles localStorage exceptions (e.g. storage disabled/blocked)", () => {
      mockLocalStorage.getItem.mockImplementationOnce(() => {
        throw new Error("SecurityError: storage access denied");
      });
      vi.stubGlobal("navigator", { language: "pt-BR" });
      expect(() => detectLang()).not.toThrow();
      expect(detectLang()).toBe("pt");
    });
  });

  describe("useLang contract & runtime export", () => {
    it("exports useLang function as valid callable hook", () => {
      expect(typeof useLang).toBe("function");
    });
  });
});
