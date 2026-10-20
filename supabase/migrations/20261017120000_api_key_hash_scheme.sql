-- Audit-004 / Issue #193: Track API key hash scheme to monitor and eliminate legacy unsalted SHA-256 keys.
ALTER TABLE public.merchants
  ADD COLUMN IF NOT EXISTS api_key_scheme TEXT NOT NULL DEFAULT 'peppered_hmac'
  CONSTRAINT merchants_api_key_scheme_check CHECK (api_key_scheme IN ('legacy_sha256', 'peppered_hmac'));

CREATE INDEX IF NOT EXISTS idx_merchants_api_key_scheme
  ON public.merchants (api_key_scheme)
  WHERE active = true;
