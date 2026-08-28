ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS items jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_items_array_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_items_array_check CHECK (jsonb_typeof(items) = 'array');
