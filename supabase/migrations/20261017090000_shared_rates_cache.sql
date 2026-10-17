-- Shared FX Rates Cache & Order Rate Auditability (Issue #236)
-- Provides a cross-isolate, horizontally scalable shared store for FX exchange rates
-- so cold workers never trigger unnecessary upstream queries and orders record audit trail.

CREATE TABLE IF NOT EXISTS public.fx_rates (
  pair text PRIMARY KEY,
  rate numeric(20,7) NOT NULL,
  source text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE public.fx_rates ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'fx_rates' AND policyname = 'service_role_fx_rates'
  ) THEN
    CREATE POLICY "service_role_fx_rates" ON public.fx_rates
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Add rate_source and rate_observed_at to orders table for price audit trail
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS rate_source text,
  ADD COLUMN IF NOT EXISTS rate_observed_at timestamptz;
