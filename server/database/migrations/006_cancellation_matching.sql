-- Cancellation notices often arrive from a different sender address than the
-- original confirmation. Keep customer-scoped order-number lookups indexed so
-- those notices can update the existing order instead of creating a duplicate.
CREATE INDEX IF NOT EXISTS orders_customer_order_number_idx
  ON orders(workspace_id, customer_id, order_number);
