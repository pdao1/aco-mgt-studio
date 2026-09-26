ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS email_to text,
  ADD COLUMN IF NOT EXISTS shipping_address text,
  ADD COLUMN IF NOT EXISTS payment_method_type text,
  ADD COLUMN IF NOT EXISTS payment_last4 text;

ALTER TABLE orders
  ADD CONSTRAINT orders_email_to_length_check
    CHECK (email_to IS NULL OR length(email_to) <= 500),
  ADD CONSTRAINT orders_shipping_address_length_check
    CHECK (shipping_address IS NULL OR length(shipping_address) <= 500),
  ADD CONSTRAINT orders_payment_method_type_length_check
    CHECK (payment_method_type IS NULL OR length(payment_method_type) <= 40),
  ADD CONSTRAINT orders_payment_last4_check
    CHECK (payment_last4 IS NULL OR payment_last4 ~ '^[0-9]{4}$');
