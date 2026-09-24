ALTER TABLE whop_memberships
  ADD COLUMN company_id text,
  ADD COLUMN product_id text,
  ADD COLUMN license_hash text,
  ADD COLUMN whop_username text;
CREATE UNIQUE INDEX whop_license_product_idx ON whop_memberships(product_id, license_hash)
  WHERE license_hash IS NOT NULL;
-- Fetch current keys for existing memberships without retaining raw serials.
UPDATE whop_memberships SET next_check_at = now();
