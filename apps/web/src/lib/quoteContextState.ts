import { createContext, useContext } from "react";
import type { Quote } from "./quote.ts";

export interface QuoteCtx {
  quote: Quote | null;
  loading: boolean;
  error: string | null;
}

export const QuoteContext = createContext<QuoteCtx>({ quote: null, loading: true, error: null });

export const useQuote = () => useContext(QuoteContext);
