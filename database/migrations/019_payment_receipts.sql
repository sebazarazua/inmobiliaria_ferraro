-- Administrative receipts are immutable evidence of recorded payments.
-- No existing payment or installment is rewritten by this migration.
CREATE SEQUENCE payment_receipt_number_seq AS bigint START WITH 1;

CREATE TABLE payment_receipts (
  id uuid PRIMARY KEY,
  receipt_number bigint NOT NULL UNIQUE DEFAULT nextval('payment_receipt_number_seq'),
  payment_id uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  replaces_receipt_id uuid REFERENCES payment_receipts(id) ON DELETE RESTRICT,
  issued_at timestamptz NOT NULL,
  snapshot_json jsonb NOT NULL,
  pdf_bytes bytea NOT NULL,
  pdf_sha256 char(64) NOT NULL,
  status text NOT NULL DEFAULT 'Emitido' CHECK (status IN ('Emitido','Anulado')),
  voided_at timestamptz,
  void_reason text,
  CHECK ((status='Emitido' AND voided_at IS NULL AND void_reason IS NULL) OR
         (status='Anulado' AND voided_at IS NOT NULL AND length(trim(void_reason))>=5))
);
ALTER SEQUENCE payment_receipt_number_seq OWNED BY payment_receipts.receipt_number;
CREATE UNIQUE INDEX payment_receipts_one_active_per_payment ON payment_receipts(payment_id) WHERE status='Emitido';
CREATE UNIQUE INDEX payment_receipts_one_replacement ON payment_receipts(replaces_receipt_id) WHERE replaces_receipt_id IS NOT NULL;

CREATE TABLE payment_receipt_events (
  id uuid PRIMARY KEY,
  receipt_id uuid NOT NULL REFERENCES payment_receipts(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('Emitido','Anulado')),
  reason text,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_receipt_events_receipt_idx ON payment_receipt_events(receipt_id,created_at);

CREATE FUNCTION protect_receipted_payment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM payment_receipts WHERE payment_id=OLD.id) THEN
    RAISE EXCEPTION 'El pago tiene un recibo emitido; use una rectificación auditada.';
  END IF;
  IF TG_OP='UPDATE' THEN RETURN NEW; END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER protect_receipted_payment_change BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION protect_receipted_payment();

CREATE FUNCTION protect_receipt_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.receipt_number IS DISTINCT FROM OLD.receipt_number
    OR NEW.payment_id IS DISTINCT FROM OLD.payment_id
    OR NEW.replaces_receipt_id IS DISTINCT FROM OLD.replaces_receipt_id
    OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
    OR NEW.snapshot_json IS DISTINCT FROM OLD.snapshot_json
    OR NEW.pdf_bytes IS DISTINCT FROM OLD.pdf_bytes
    OR NEW.pdf_sha256 IS DISTINCT FROM OLD.pdf_sha256
    OR OLD.status='Anulado'
    OR NEW.status<>'Anulado' THEN
    RAISE EXCEPTION 'El comprobante emitido es inmutable.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_receipt_evidence_change BEFORE UPDATE OR DELETE ON payment_receipts
  FOR EACH ROW EXECUTE FUNCTION protect_receipt_evidence();
