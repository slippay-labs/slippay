-- Issue #256: Record last processed ledger and poll time on listener_state
-- Enables detection of gaps after Horizon outages or cursor resets

alter table listener_state
  add column if not exists last_ledger bigint,
  add column if not exists last_poll_at timestamptz;

comment on column listener_state.last_ledger is
  'Issue #256: Last successfully processed Stellar ledger sequence';

comment on column listener_state.last_poll_at is
  'Issue #256: Timestamp of the last successful Horizon poll cycle';
