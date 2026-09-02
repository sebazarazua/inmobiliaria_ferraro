ALTER TABLE guarantees
  ADD COLUMN IF NOT EXISTS guarantor_email text,
  ADD COLUMN IF NOT EXISTS guarantor_phone text,
  ADD COLUMN IF NOT EXISTS guarantor_address text;
