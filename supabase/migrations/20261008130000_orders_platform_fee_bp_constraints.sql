-- Migration: backfill orders.platform_fee_bp, enforce NOT NULL, set default 297, and add CHECK constraint [0, 1000]
-- Fixes: slippay-labs/slippay#96
-- See also: slippay-labs/slippay#229

-- 1. Backfill existing orders from their merchant's platform_fee_bp.
--    Only touches orders whose merchant matches; orphan orders stay NULL and
--    are handled below. (merchants.platform_fee_bp is NOT NULL, so the
--    coalesce is defence only — it never invents a rate for an orphan.)
update orders o
set platform_fee_bp = coalesce(m.platform_fee_bp, 297)
from merchants m
where o.merchant_id = m.id and o.platform_fee_bp is null;

-- 2. Enumerate orphan orders (no matching merchants row) and abort.
--    Do NOT assign them a business value: stamping 297 would assert what fee
--    was historically due on an order whose merchant cannot be found, and
--    NOT NULL below would make that guess permanent and indistinguishable from
--    a real rate.
do $$
declare
  orphan_count  int;
  orphan_ids    uuid[];
  stranded_null int;
begin
  select count(*), coalesce(array_agg(o.id order by o.created_at), '{}')
    into orphan_count, orphan_ids
    from orders o
   where o.platform_fee_bp is null
     and not exists (select 1 from merchants m where m.id = o.merchant_id);

  if orphan_count > 0 then
    raise exception using
      message = format(
        '%s orphan order(s) have no matching merchants row; refusing to assign a platform fee to them. Orphan order ids: %s',
        orphan_count,
        array_to_string(orphan_ids, ', ')
      ),
      detail  = 'These rows violate referential integrity on orders.merchant_id and must be investigated (merchant deleted? row restored from a dump without the FK?) before platform_fee_bp can be constrained. See slippay-labs/slippay#229.',
      hint    = 'Resolve or quarantine the orphans, then re-run this migration. It intentionally leaves their platform_fee_bp NULL.';
  end if;

  -- Safety net: a matched order still NULL here means the backfill itself broke.
  select count(*) into stranded_null from orders o where o.platform_fee_bp is null;
  if stranded_null > 0 then
    raise exception using
      message = format('%s order(s) with a matching merchant still have NULL platform_fee_bp after backfill', stranded_null),
      detail  = 'The backfill expression failed to produce a value; refusing to weaken NOT NULL to accommodate it.';
  end if;
end $$;

-- 3. Set default to 297 (canonical default platform fee, 2.97%)
alter table orders
  alter column platform_fee_bp set default 297;

-- 4. Enforce NOT NULL
alter table orders
  alter column platform_fee_bp set not null;

-- 5. Enforce CHECK constraint (between 0 and 1000 bp, i.e. 0% to 10%)
alter table orders
  add constraint orders_platform_fee_bp_check
  check (platform_fee_bp between 0 and 1000);
