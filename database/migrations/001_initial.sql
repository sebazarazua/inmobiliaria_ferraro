CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS persons (
  id uuid PRIMARY KEY,
  full_name text NOT NULL,
  document_type text NOT NULL DEFAULT 'DNI',
  document_number text,
  email text,
  phone text,
  address text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS persons_document_uq ON persons(document_number) WHERE document_number IS NOT NULL AND document_number <> '';

CREATE TABLE IF NOT EXISTS properties (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  address text NOT NULL,
  normalized_address text NOT NULL UNIQUE,
  property_type text NOT NULL DEFAULT 'Departamento',
  status text NOT NULL DEFAULT 'Alquilada' CHECK(status IN ('Disponible','Alquilada','Inactiva')),
  unit text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS property_owners (
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES persons(id) ON DELETE RESTRICT,
  ownership_percentage numeric(5,2),
  PRIMARY KEY(property_id, person_id)
);

CREATE TABLE IF NOT EXISTS contracts (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  property_id uuid NOT NULL REFERENCES properties(id),
  tenant_id uuid NOT NULL REFERENCES persons(id),
  rental_type text NOT NULL CHECK(rental_type IN ('Residencial','Comercial','Profesional','Temporario','Otro')),
  duration_months integer NOT NULL CHECK(duration_months > 0),
  start_date date NOT NULL,
  end_date date NOT NULL,
  initial_amount numeric(14,2) NOT NULL CHECK(initial_amount >= 0),
  currency char(3) NOT NULL DEFAULT 'ARS',
  adjustment_frequency_months integer,
  adjustment_index text,
  payment_due_day integer NOT NULL DEFAULT 10 CHECK(payment_due_day BETWEEN 1 AND 31),
  management_fee_pct numeric(5,2) NOT NULL DEFAULT 3 CHECK(management_fee_pct BETWEEN 2 AND 5),
  deposit_amount numeric(14,2),
  bank_name text,
  cbu varchar(22),
  status text NOT NULL DEFAULT 'Activo' CHECK(status IN ('Borrador','Activo','Finalizado','Rescindido','Revisión')),
  source_document_id uuid,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contracts_property_idx ON contracts(property_id);
CREATE INDEX IF NOT EXISTS contracts_tenant_idx ON contracts(tenant_id);
CREATE INDEX IF NOT EXISTS contracts_status_end_idx ON contracts(status,end_date);

CREATE TABLE IF NOT EXISTS contract_owners (
  contract_id uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES persons(id),
  PRIMARY KEY(contract_id, person_id)
);
CREATE TABLE IF NOT EXISTS guarantees (
  id uuid PRIMARY KEY,
  contract_id uuid NOT NULL UNIQUE REFERENCES contracts(id) ON DELETE CASCADE,
  guarantee_type text NOT NULL CHECK(guarantee_type IN ('Seguro de caución','Garantía propietaria','Sin garantía','Otra')),
  provider text CHECK(provider IN ('Respaldar','Argenprop','Otra')),
  provider_detail text,
  guarantor_name text,
  guarantor_document text,
  guaranteed_property text,
  policy_number text,
  expiry_date date,
  notes text
);
CREATE TABLE IF NOT EXISTS installments (
  id uuid PRIMARY KEY,
  contract_id uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  period char(7) NOT NULL,
  due_date date NOT NULL,
  expected_amount numeric(14,2),
  currency char(3) NOT NULL DEFAULT 'ARS',
  adjustment_pending boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'Pendiente' CHECK(status IN ('Pendiente','Pagado','Parcial','Vencido')),
  UNIQUE(contract_id, period)
);
CREATE INDEX IF NOT EXISTS installments_status_due_idx ON installments(status,due_date);
CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY,
  installment_id uuid NOT NULL REFERENCES installments(id),
  amount numeric(14,2) NOT NULL CHECK(amount > 0),
  paid_at date NOT NULL,
  method text NOT NULL DEFAULT 'Transferencia',
  bank_name text,
  reference text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_installment_idx ON payments(installment_id);
CREATE INDEX IF NOT EXISTS payments_paid_at_idx ON payments(paid_at);
CREATE TABLE IF NOT EXISTS incidents (
  id uuid PRIMARY KEY,
  property_id uuid REFERENCES properties(id),
  contract_id uuid REFERENCES contracts(id),
  title text NOT NULL,
  description text,
  priority text NOT NULL DEFAULT 'Media' CHECK(priority IN ('Baja','Media','Alta','Urgente')),
  status text NOT NULL DEFAULT 'Abierta' CHECK(status IN ('Abierta','En seguimiento','Resuelta','Cerrada')),
  opened_at date NOT NULL,
  resolved_at date,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS incidents_status_idx ON incidents(status);
CREATE TABLE IF NOT EXISTS ledger_entries (
  id uuid PRIMARY KEY,
  entry_date date NOT NULL,
  kind text NOT NULL CHECK(kind IN ('Ingreso','Gasto')),
  category text NOT NULL,
  description text NOT NULL,
  amount numeric(14,2) NOT NULL CHECK(amount >= 0),
  currency char(3) NOT NULL DEFAULT 'ARS',
  property_id uuid REFERENCES properties(id),
  contract_id uuid REFERENCES contracts(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_date_idx ON ledger_entries(entry_date);
CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY,
  filename text NOT NULL,
  absolute_path text NOT NULL UNIQUE,
  sha256 char(64) NOT NULL UNIQUE,
  mime_type text NOT NULL DEFAULT 'application/pdf',
  property_id uuid REFERENCES properties(id),
  contract_id uuid REFERENCES contracts(id),
  extracted_text text,
  imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS imports (
  id uuid PRIMARY KEY,
  filename text NOT NULL,
  absolute_path text NOT NULL,
  sha256 char(64),
  status text NOT NULL CHECK(status IN ('Procesado','Revisión','Error','Omitido')),
  confidence numeric(4,3),
  warnings_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  result_json jsonb,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS imports_status_created_idx ON imports(status,created_at DESC);
CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  action text NOT NULL,
  details_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_entity_idx ON audit_log(entity_type,entity_id,created_at DESC);
