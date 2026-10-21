import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { quoteBRLtoUSDC, StaleRateError, type Quote } from "./quote.ts";

interface QuoteCtx {
  quote: Quote | null;
  loading: boolean;
  error: string | null;
  // True when the live rate is unavailable and the consumer must retry instead
  // of showing a price. Distinct from a transport error so the UI can offer a
  // retry affordance.
  stale: boolean;
}

const Ctx = createContext<QuoteCtx>({ quote: null, loading: true, error: null, stale: false });

// Page-level FX quote: fetch once, share across every consumer. On top of the
// promise dedup in quote.ts, this guarantees a page with several quote
// consumers performs one upstream fetch instead of one per component.
//
// Stale rates are refused by default: the provider surfaces a retry state
// (stale: true) rather than a price. Callers that genuinely need a degraded
// price can opt in explicitly via `allowStale`.
export function QuoteProvider({ brlIn, spreadBps, allowStale = false, children }: {
  brlIn: number;
  spreadBps?: number;
  allowStale?: boolean;
  children: ReactNode;
}) {
  const [quote, setQuote] = useState<Quote | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  useEffect(() => {
    let on = true;
    setLoading(true);
    quoteBRLtoUSDC(brlIn, spreadBps, { allowStale })
      .then((q) => {
        if (!on) return;
        setQuote(q);
        setStale(q.stale);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!on) return;
        setQuote(null);
        if (e instanceof StaleRateError) {
          setStale(true);
          setError(e.message);
        } else {
          setStale(false);
          setError(e instanceof Error ? e.message : "Erro ao buscar cotacao.");
        }
      })
      .finally(() => { if (on) setLoading(false); });
    return () => { on = false; };
  }, [brlIn, spreadBps, allowStale]);
  return <Ctx.Provider value={{ quote, loading, error, stale }}>{children}</Ctx.Provider>;
}

export const useQuote = () => useContext(Ctx);