-- Additive: historical amounts and obligations remain unchanged.
ALTER TABLE ledger_entries
  ADD COLUMN responsibility text NOT NULL DEFAULT 'undetermined' CHECK(responsibility IN ('owner','agency','tenant','undetermined')),
  ADD COLUMN voided_at timestamptz,
  ADD COLUMN void_reason text;
ALTER TABLE installment_services ADD COLUMN charge_kind text NOT NULL DEFAULT 'service' CHECK(charge_kind IN ('service','recoverable','other'));
ALTER TABLE service_rules ADD COLUMN charge_kind text NOT NULL DEFAULT 'service' CHECK(charge_kind IN ('service','recoverable','other'));
-- Existing links are preserved, including any legacy repeats. New operations reject repeats under the financial lock.
CREATE INDEX installment_services_expense_idx ON installment_services(expense_id) WHERE expense_id IS NOT NULL;
CREATE TABLE expense_operations (
  request_id uuid PRIMARY KEY,
  request_hash text NOT NULL,
  result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE late_fee_sync_state (
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  checked_at timestamptz,
  successful_at timestamptz,
  updated_at timestamptz,
  status text NOT NULL DEFAULT 'never',
  error text,
  discovery_json jsonb NOT NULL DEFAULT '{}'::jsonb
);
INSERT INTO late_fee_sync_state(id) VALUES(true);
