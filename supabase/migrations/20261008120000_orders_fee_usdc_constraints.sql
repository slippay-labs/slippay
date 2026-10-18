-- Migration: add precision/scale, NOT NULL constraint, non-negative CHECK, and backfill fee_usdc on orders
-- Fixes: slippay-labs/slippay#99
-- See also: slippay-labs/slippay#229

-- 0. Verify referential integrity before touching any fee data.
--    orders.merchant_id is declared `not null references merchants(id)`
--    in 20260507100000_initial_schema.sql, so a validated foreign key must
--    already exist. If it does not (e.g. a restored dump skipped it), orphan
--    orders cannot be ruled out and this migration must not guess their fees.
do $$
begin
  if not exists (
    select 1
      from pg_constraint c
      join pg_attribute a
        on a.attrelid = c.conrelid
       and a.attnum   = any (c.conkey)
     where c.conrelid   = 'orders'::regclass
       and c.contype    = 'f'
       and a.attname    = 'merchant_id'
       and c.confrelid  = 'merchants'::regclass
       and c.convalidated
  ) then
    raise exception using
      message = 'orders.merchant_id has no validated foreign key to merchants(id)',
      hint    = 'Add the foreign key and resolve any orphan orders before backfilling fees. See slippay-labs/slippay#229.';
  end if;
end $$;

-- 1. Backfill existing orders where fee_usdc is NULL
update orders o
set fee_usdc = coalesce(
  round(o.usdc_amount * coalesce(o.platform_fee_bp, m.platform_fee_bp, 297) / 10000.0, 7),
  0
)
from merchants m
where o.merchant_id = m.id and o.fee_usdc is null;

-- 2. Enumerate orphan orders (no matching merchants row) and abort.
--    Do NOT assign them a business value: zeroing asserts no fee was ever due,
--    and NOT NULL below would make that assertion permanent and
--    indistinguishable from a genuine zero-fee order.
do $$
declare
  orphan_count  int;
  orphan_ids    uuid[];
  stranded_null int;
begin
  select count(*), coalesce(array_agg(o.id order by o.created_at), '{}')
    into orphan_count, orphan_ids
    from orders o
   where o.fee_usdc is null
     and not exists (select 1 from merchants m where m.id = o.merchant_id);

  if orphan_count > 0 then
    raise exception using
      message = format(
        '%s orphan order(s) have no matching merchants row; refusing to assign a fee to them. Orphan order ids: %s',
        orphan_count,
        array_to_string(orphan_ids, ', ')
      ),
      detail  = 'These rows violate referential integrity on orders.merchant_id and must be investigated (merchant deleted? row restored from a dump without the FK?) before fees can be constrained. See slippay-labs/slippay#229.',
      hint    = 'Resolve or quarantine the orphans, then re-run this migration. It intentionally leaves their fee_usdc NULL.';
  end if;

  -- Safety net: a matched order still NULL here means the backfill itself broke.
  select count(*) into stranded_null from orders o where o.fee_usdc is null;
  if stranded_null > 0 then
    raise exception using
      message = format('%s order(s) with a matching merchant still have NULL fee_usdc after backfill', stranded_null),
      detail  = 'The backfill expression failed to produce a value; refusing to weaken NOT NULL to accommodate it.';
  end if;
end $$;

-- 3. Set numeric precision and scale to numeric(20,7)
alter table orders
  alter column fee_usdc type numeric(20,7);

-- 4. Enforce NOT NULL
alter table orders
  alter column fee_usdc set not null;

-- 5. Enforce non-negative and max 7 decimal places check
alter table orders
  add constraint orders_fee_usdc_check
  check (fee_usdc >= 0 and scale(fee_usdc) <= 7);
