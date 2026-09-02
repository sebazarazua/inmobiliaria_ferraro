ALTER TABLE imports DROP CONSTRAINT IF EXISTS imports_status_check;
ALTER TABLE imports
  ADD CONSTRAINT imports_status_check CHECK(status IN ('Procesado','Revisión','Error','Omitido','Descartado','Revertido'));

ALTER TABLE contracts DROP CONSTRAINT IF EXISTS contracts_status_check;
ALTER TABLE contracts
  ADD CONSTRAINT contracts_status_check CHECK(status IN ('Borrador','Activo','Finalizado','Vencido','Rescindido','Renovado','Revisión','Anulado','Archivado'));

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS void_reason text,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS previous_contract_id uuid REFERENCES contracts(id);

CREATE INDEX IF NOT EXISTS contracts_previous_contract_idx ON contracts(previous_contract_id);
