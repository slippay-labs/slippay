import { createContext, useContext } from "react";
import type { Session } from "@supabase/supabase-js";

export interface AuthCtx {
  session: Session | null;
  loading: boolean;
}

export const AuthContext = createContext<AuthCtx>({ session: null, loading: true });

export const useAuth = () => useContext(AuthContext);
