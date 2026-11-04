-- Tenant receivables are separate from ledger expenses. No historical conversion.
ALTER TABLE installments
  ADD COLUMN services_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK(services_amount>=0),
  ADD COLUMN financial_closed_at timestamptz;
CREATE TABLE service_rules (
  id uuid PRIMARY KEY,
  contract_id uuid NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,
  category text NOT NULL,
  description text NOT NULL,
  mode text NOT NULL CHECK(mode IN ('fixed','variable')),
  amount numeric(14,2) CHECK(amount>=0),
  currency char(3) NOT NULL CHECK(currency IN ('ARS','USD')),
  start_period char(7) NOT NULL CHECK(start_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  end_period char(7) NOT NULL CHECK(end_period>=start_period),
  responsibility_reference text NOT NULL,
  reference text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((mode='fixed' AND amount IS NOT NULL) OR (mode='variable' AND amount IS NULL))
);
CREATE TABLE installment_services (
  id uuid PRIMARY KEY,
  installment_id uuid NOT NULL REFERENCES installments(id) ON DELETE RESTRICT,
  rule_id uuid REFERENCES service_rules(id) ON DELETE RESTRICT,
  category text NOT NULL,
  description text NOT NULL,
  original_amount numeric(14,2) CHECK(original_amount>=0),
  forgiven_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK(forgiven_amount>=0),
  currency char(3) NOT NULL CHECK(currency IN ('ARS','USD')),
  status text NOT NULL CHECK(status IN ('Borrador','Confirmado','Anulado')),
  responsibility_reference text,
  reference text,
  expense_id uuid REFERENCES ledger_entries(id) ON DELETE RESTRICT,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(forgiven_amount<=COALESCE(original_amount,0)),
  CHECK(status<>'Confirmado' OR (original_amount IS NOT NULL AND length(trim(responsibility_reference))>=5)),
  UNIQUE(rule_id,installment_id)
);
CREATE INDEX installment_services_installment_idx ON installment_services(installment_id);
-- The projection is maintained atomically in SQL and is read by every balance consumer.
CREATE FUNCTION project_installment_services() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
  target := COALESCE(NEW.installment_id,OLD.installment_id);
  PERFORM 1 FROM installments WHERE id=target FOR UPDATE;
  UPDATE installments SET services_amount=(SELECT COALESCE(SUM(original_amount-forgiven_amount),0)
    FROM installment_services WHERE installment_id=target AND status='Confirmado') WHERE id=target;
  RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER installment_services_projection AFTER INSERT OR UPDATE OR DELETE ON installment_services
  FOR EACH ROW EXECUTE FUNCTION project_installment_services();
-- Immutable audit and idempotency records intentionally retain identifiers without cascades.
CREATE TABLE service_operations (
  request_id uuid PRIMARY KEY,
  contract_id uuid NOT NULL,
  request_hash text NOT NULL,
  result_json jsonb NOT NULL,
  actor_json jsonb NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE payment_requests (
  request_id uuid PRIMARY KEY,
  request_hash text NOT NULL,
  result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
