CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT 'Argentina',
  ADD COLUMN IF NOT EXISTS province text NOT NULL DEFAULT 'CABA',
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS neighborhood text,
  ADD COLUMN IF NOT EXISTS street text,
  ADD COLUMN IF NOT EXISTS street_number text,
  ADD COLUMN IF NOT EXISTS floor text,
  ADD COLUMN IF NOT EXISTS unit_label text;

ALTER TABLE persons
  ADD COLUMN IF NOT EXISTS person_kind text NOT NULL DEFAULT 'PERSON' CHECK(person_kind IN ('PERSON','COMPANY')),
  ADD COLUMN IF NOT EXISTS first_name text,
  ADD COLUMN IF NOT EXISTS last_name text,
  ADD COLUMN IF NOT EXISTS nationality text,
  ADD COLUMN IF NOT EXISTS whatsapp text,
  ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT 'Argentina',
  ADD COLUMN IF NOT EXISTS province text NOT NULL DEFAULT 'CABA',
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS neighborhood text;

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS alias text,
  ADD COLUMN IF NOT EXISTS payment_period_start_day integer CHECK(payment_period_start_day BETWEEN 1 AND 31),
  ADD COLUMN IF NOT EXISTS payment_period_end_day integer CHECK(payment_period_end_day BETWEEN 1 AND 31),
  ADD COLUMN IF NOT EXISTS adjustment_type text,
  ADD COLUMN IF NOT EXISTS adjustment_value_pct numeric(8,3),
  ADD COLUMN IF NOT EXISTS ipc_lag_months integer NOT NULL DEFAULT 0 CHECK(ipc_lag_months >= 0),
  ADD COLUMN IF NOT EXISTS vat_applicable boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS vat_percentage numeric(5,2),
  ADD COLUMN IF NOT EXISTS late_fee_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS payment_terms_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS import_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS contract_tenants (
  contract_id uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES persons(id) ON DELETE RESTRICT,
  role text NOT NULL DEFAULT 'Titular',
  snapshot_name text,
  snapshot_document text,
  PRIMARY KEY(contract_id, person_id)
);

CREATE TABLE IF NOT EXISTS recurring_charges (
  id uuid PRIMARY KEY,
  contract_id uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  charge_type text NOT NULL,
  custom_name text,
  frequency text,
  responsible_party text,
  calculation_type text,
  value numeric(14,2),
  estimated_amount numeric(14,2),
  currency char(3) NOT NULL DEFAULT 'ARS',
  notes text
);

CREATE TABLE IF NOT EXISTS initial_payments (
  id uuid PRIMARY KEY,
  contract_id uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  payment_type text NOT NULL,
  amount numeric(14,2),
  currency char(3) NOT NULL DEFAULT 'ARS',
  installments_count integer,
  prepaid_months integer,
  prepaid_through_date date,
  notes text
);

CREATE TABLE IF NOT EXISTS configurable_providers (
  id uuid PRIMARY KEY,
  provider_type text NOT NULL,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  UNIQUE(provider_type, name)
);

INSERT INTO configurable_providers(id,provider_type,name)
VALUES
  (gen_random_uuid(),'SURETY_INSURANCE','Respaldar'),
  (gen_random_uuid(),'SURETY_INSURANCE','Argenprop')
ON CONFLICT(provider_type,name) DO NOTHING;
