ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS fee_basis_points integer NOT NULL DEFAULT 0;

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_fee_basis_points_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_fee_basis_points_check CHECK (fee_basis_points BETWEEN 0 AND 10000);
