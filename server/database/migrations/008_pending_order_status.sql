-- Keep a generic retailer acknowledgement separate from an explicit
-- confirmation. A later confirmation email can promote pending -> confirmed
-- through the existing monotonic status_rank upsert logic.
CREATE OR REPLACE FUNCTION status_rank(value text) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE value
    WHEN 'pending' THEN 1
    WHEN 'confirmed' THEN 2
    WHEN 'processing' THEN 3
    WHEN 'shipped' THEN 4
    WHEN 'delivered' THEN 5
    WHEN 'cancelled' THEN 6
    ELSE 0
  END
$$;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'));

ALTER TABLE shipments DROP CONSTRAINT IF EXISTS shipments_status_check;
ALTER TABLE shipments ADD CONSTRAINT shipments_status_check
  CHECK (status IN ('pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'));

ALTER TABLE order_events DROP CONSTRAINT IF EXISTS order_events_status_check;
ALTER TABLE order_events ADD CONSTRAINT order_events_status_check
  CHECK (status IN ('pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'));

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_override_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_override_check
  CHECK (status_override IS NULL OR status_override IN ('pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'));
