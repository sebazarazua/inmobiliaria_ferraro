-- No backfill of historical interest or payments. Every new amount is reviewed.
ALTER TABLE installments
  ADD COLUMN late_fee_calculated_amount numeric(14,2) CHECK(late_fee_calculated_amount>=0),
  ADD COLUMN late_fee_forgiven_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK(late_fee_forgiven_amount>=0),
  ADD COLUMN late_fee_calculation_json jsonb,
  ADD COLUMN late_fee_calculation_hash text;
CREATE TABLE late_fee_reviews (
  id uuid PRIMARY KEY,
  contract_id uuid NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,
  terms_json jsonb NOT NULL,
  evidence_json jsonb NOT NULL,
  actor_json jsonb NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX late_fee_reviews_contract_idx ON late_fee_reviews(contract_id,created_at DESC);
CREATE TABLE late_fee_rate_sources (
  id uuid PRIMARY KEY,
  url text NOT NULL,
  content_hash text NOT NULL UNIQUE,
  content_html text NOT NULL,
  product text NOT NULL,
  retrieved_at timestamptz NOT NULL DEFAULT now(),
  actor_json jsonb NOT NULL
);
CREATE TABLE late_fee_rates (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES late_fee_rate_sources(id) ON DELETE RESTRICT,
  product text NOT NULL,
  valid_from date NOT NULL,
  valid_until date NOT NULL CHECK(valid_until>valid_from),
  annual_percentage numeric(12,6) NOT NULL CHECK(annual_percentage>0),
  UNIQUE(source_id,product,valid_from)
);
CREATE INDEX late_fee_rates_coverage_idx ON late_fee_rates(product,valid_from,valid_until);
CREATE TABLE late_fee_history (
  id uuid PRIMARY KEY,
  installment_id uuid NOT NULL REFERENCES installments(id) ON DELETE RESTRICT,
  version integer NOT NULL,
  request_id uuid NOT NULL UNIQUE,
  details_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(installment_id,version)
);
CREATE TABLE late_fee_operations (
  request_id uuid PRIMARY KEY,
  request_hash text NOT NULL,
  result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
