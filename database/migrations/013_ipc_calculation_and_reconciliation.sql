-- Additive only. Existing financial rows are enrolled by reviewed reconciliation,
-- never rewritten by this migration or by the first scheduled refresh.
CREATE TABLE ipc_index_versions (
  id uuid PRIMARY KEY,
  period char(7) NOT NULL CHECK(period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  index_value numeric(24,10) NOT NULL CHECK(index_value > 0),
  monthly_variation numeric(24,14),
  source text NOT NULL,
  source_url text NOT NULL,
  fetched_at timestamptz NOT NULL,
  content_hash text NOT NULL,
  UNIQUE(period,content_hash)
);
CREATE TABLE ipc_indices (
  period char(7) PRIMARY KEY,
  version_id uuid NOT NULL REFERENCES ipc_index_versions(id)
);
CREATE TABLE ipc_refresh_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  latest_period char(7),
  source_url text
);
INSERT INTO ipc_refresh_state(singleton) VALUES(true);

ALTER TABLE contracts
  ADD COLUMN ipc_clause_text text,
  ADD COLUMN ipc_clause_review_required boolean NOT NULL DEFAULT false;

ALTER TABLE installments
  ADD COLUMN ipc_managed boolean NOT NULL DEFAULT false,
  ADD COLUMN contractual_amount numeric(14,2),
  ADD COLUMN original_expected_amount numeric(14,2),
  ADD COLUMN rent_override_amount numeric(14,2) CHECK(rent_override_amount >= 0),
  ADD COLUMN calculation_hash text,
  ADD COLUMN calculation_json jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX installments_ipc_managed_idx ON installments(contract_id,period) WHERE ipc_managed;

-- Audit identifiers intentionally survive deletion of a contract/installment.
CREATE TABLE rent_adjustment_history (
  id uuid PRIMARY KEY,
  installment_id uuid NOT NULL,
  contract_id uuid NOT NULL,
  version integer NOT NULL,
  previous_amount numeric(14,2),
  new_amount numeric(14,2) NOT NULL,
  effective_period char(7) NOT NULL,
  calculation_hash text NOT NULL,
  reason text NOT NULL,
  details_json jsonb NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(installment_id,version)
);
CREATE INDEX rent_adjustment_history_contract_idx ON rent_adjustment_history(contract_id,effective_period);
