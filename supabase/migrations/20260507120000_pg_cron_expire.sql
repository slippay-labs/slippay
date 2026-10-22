create extension if not exists pg_cron;

select cron.schedule(
  'slippay-expire-orders',
  ('*/5 * * * *'),
  $$
    update orders
    set status = 'expired'
    where status = 'pending'
      and expires_at < now();

    insert into webhook_deliveries (order_id, type, payload, next_attempt_at)
    select o.id, 'order.expired',
      jsonb_build_object(
        'type', 'order.expired',
        'data', jsonb_build_object(
          'id', o.id,
          'external_ref', o.external_ref,
          'brl_amount', o.brl_amount,
          'memo', o.memo,
          'expires_at', o.expires_at
        )
      ),
      now()
    from orders o
    where o.status = 'expired'
      and not exists (select 1 from webhook_deliveries w where w.order_id = o.id and w.type = 'order.expired');
  
    -- Rate limiter buckets are shared across isolates and must be cleaned up
    -- so the table does not grow unbounded. Expired backets are safe to delete:
    -- a restarted or fresh isolate will recreate them at full capacity, which
    -- is the correct semantic only after the window has elapsed.
    delete from rate_limit_buckets
    where reset_at < now() - interval '1 hour';
  
    -- Daily counters for /v1/ask are keyed by day and must outlive their day
    -- by at least one full day so the cap is not reset by a cold start
    -- midnight. Keep a generous retention window.
    delete from rate_limit_counters
    where expires_at < now() - interval '7 days';
  $$
);

