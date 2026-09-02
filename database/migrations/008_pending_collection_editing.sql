ALTER TABLE installments
  ADD COLUMN IF NOT EXISTS declared_amount numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS manual_partial_amount numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rent_forgiven boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS vat_forgiven boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS late_fee_forgiven boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS discount_is_percentage boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS discount_percentage numeric(8,3),
  ADD COLUMN IF NOT EXISTS discount_details_enabled boolean NOT NULL DEFAULT false;
