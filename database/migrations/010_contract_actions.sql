ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS rescinded_at date,
  ADD COLUMN IF NOT EXISTS rescission_penalty numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deposit_returned_at date,
  ADD COLUMN IF NOT EXISTS deposit_returned_amount numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deactivated_at timestamptz,
  ADD COLUMN IF NOT EXISTS deletion_reason text;
