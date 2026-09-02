ALTER TABLE persons
  ADD COLUMN IF NOT EXISTS tax_id text,
  ADD COLUMN IF NOT EXISTS vat_condition text,
  ADD COLUMN IF NOT EXISTS liquidation_email_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fiscal_address text,
  ADD COLUMN IF NOT EXISTS gross_income_number text,
  ADD COLUMN IF NOT EXISTS activity_start_date date;

CREATE UNIQUE INDEX IF NOT EXISTS persons_tax_id_uq
  ON persons(tax_id)
  WHERE tax_id IS NOT NULL AND tax_id <> '';
