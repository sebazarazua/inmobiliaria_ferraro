ALTER TABLE installments
  ADD COLUMN IF NOT EXISTS vat_amount numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS late_fee_amount numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_amount numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS internal_notes text;

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS payment_type text NOT NULL DEFAULT 'Alquiler',
  ADD COLUMN IF NOT EXISTS account_name text,
  ADD COLUMN IF NOT EXISTS tax_status text NOT NULL DEFAULT 'Declarado',
  ADD COLUMN IF NOT EXISTS is_split boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS split_json jsonb NOT NULL DEFAULT '[]'::jsonb;
