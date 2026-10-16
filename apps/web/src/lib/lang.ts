import { useEffect, useState } from "react";

// Landing locale. PT is PRIMARY — the audience is Brazilians who earn in
// dollars (freelancers, IT/dev exporters, creators, gig workers), they read
// Portuguese. We default to PT and only switch to EN when the browser is
// explicitly non-pt (the EN mirror is the secondary). Persisted in localStorage
// so a manual toggle sticks.
export type Lang = "pt" | "en";

export const LANG_KEY = "slippay_lang";
export const DEFAULT_LANG: Lang = "pt";

export function normalizeLang(raw: unknown): Lang {
  if (raw === "pt" || raw === "en") return raw;
  return DEFAULT_LANG;
}

function getStorage(): Storage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    /* ignore */
  }
  return null;
}

export function detectLang(): Lang {
  const storage = getStorage();
  if (storage) {
    try {
      const stored = storage.getItem(LANG_KEY);
      if (stored === "pt" || stored === "en") return stored;
    } catch {
      /* ignore storage errors */
    }
  }
  // Default to PT (primary audience). Only EN for an explicitly English browser.
  const nav = typeof navigator !== "undefined" ? navigator.language : "";
  return nav?.toLowerCase().startsWith("en") ? "en" : DEFAULT_LANG;
}

export function useLang(): [Lang, (l: Lang) => void] {
  const [lang, setLangState] = useState<Lang>(() => detectLang());
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = lang === "pt" ? "pt-BR" : "en";
    }
  }, [lang]);
  const setLang = (l: Lang) => {
    const storage = getStorage();
    if (storage) {
      try {
        storage.setItem(LANG_KEY, l);
      } catch {
        /* ignore */
      }
    }
    setLangState(l);
  };
  return [lang, setLang];
}
