import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";

// Shared Supabase client. Kept separate from auth.tsx so the provider module
// only exports components (react-refresh/only-export-components).
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);
