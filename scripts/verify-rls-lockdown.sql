-- scripts/verify-rls-lockdown.sql
--
-- Security verification script: asserts RLS enablement and client grant revokes
-- for x402_resources, listener_leases, listener_state, and merchants.
-- Fails loudly with an exception if any policy or grant violation is found.

DO $$
DECLARE
  v_missing_rls text[];
  v_illegal_table_grants text[];
  v_illegal_col_grants text[];
BEGIN
  -- 1. Assert Row Level Security (RLS) is enabled on all four tables
  SELECT array_agg(t) INTO v_missing_rls
  FROM unnest(ARRAY['x402_resources', 'listener_leases', 'listener_state', 'merchants']) t
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = t AND rowsecurity = true
  );

  IF v_missing_rls IS NOT NULL AND array_length(v_missing_rls, 1) > 0 THEN
    RAISE EXCEPTION 'RLS Lockdown Failure: RLS is disabled on: %', array_to_string(v_missing_rls, ', ');
  END IF;

  -- 2. Assert NO client-role grants (anon, authenticated) on internal operational tables
  SELECT array_agg(format('%s on %s to %s', privilege_type, table_name, grantee)) INTO v_illegal_table_grants
  FROM information_schema.table_privileges
  WHERE table_schema = 'public'
    AND table_name IN ('x402_resources', 'listener_leases', 'listener_state')
    AND grantee IN ('anon', 'authenticated');

  IF v_illegal_table_grants IS NOT NULL AND array_length(v_illegal_table_grants, 1) > 0 THEN
    RAISE EXCEPTION 'RLS Lockdown Failure: Unauthorized client privileges found: %', array_to_string(v_illegal_table_grants, ', ');
  END IF;

  -- 3. Assert secret columns on merchants table are NOT readable by authenticated role
  SELECT array_agg(column_name) INTO v_illegal_col_grants
  FROM information_schema.column_privileges
  WHERE table_schema = 'public'
    AND table_name = 'merchants'
    AND grantee = 'authenticated'
    AND privilege_type = 'SELECT'
    AND column_name IN ('api_key_hash', 'webhook_secret');

  IF v_illegal_col_grants IS NOT NULL AND array_length(v_illegal_col_grants, 1) > 0 THEN
    RAISE EXCEPTION 'RLS Lockdown Failure: Secret columns exposed to authenticated on merchants: %', array_to_string(v_illegal_col_grants, ', ');
  END IF;

  RAISE NOTICE 'SUCCESS: RLS lockdown and column grant assertions verified across all four tables.';
END $$;
