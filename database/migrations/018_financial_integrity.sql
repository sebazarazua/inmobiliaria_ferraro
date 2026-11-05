-- Additive only. No financial row is updated, merged or deleted.
-- Findings that need human reconciliation are recorded instead of being "fixed" automatically.
CREATE TABLE IF NOT EXISTS integrity_findings (
  id bigserial PRIMARY KEY,
  check_name text NOT NULL,
  details_json jsonb NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution text
);

-- A ledger expense backs at most one tenant obligation, even after that charge was voided.
-- Declarative uniqueness only when the history allows it; otherwise the legacy repeats are listed.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM installment_services WHERE expense_id IS NOT NULL GROUP BY expense_id HAVING COUNT(*)>1) THEN
    CREATE UNIQUE INDEX installment_services_expense_uq ON installment_services(expense_id) WHERE expense_id IS NOT NULL;
  ELSE
    INSERT INTO integrity_findings(check_name,details_json)
      SELECT 'installment_services_expense_duplicates',jsonb_build_object('expense_id',expense_id,'charge_ids',jsonb_agg(id ORDER BY created_at,id),'count',COUNT(*))
      FROM installment_services WHERE expense_id IS NOT NULL GROUP BY expense_id HAVING COUNT(*)>1;
  END IF;
END $$;

-- Guards every new or re-pointed charge, with or without the unique index: one charge per expense
-- and the same currency as its installment and its expense. Existing rows are not revalidated.
CREATE FUNCTION guard_installment_service_links() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE installment_currency char(3); expense_currency char(3);
BEGIN
  IF TG_OP='INSERT' OR NEW.installment_id IS DISTINCT FROM OLD.installment_id OR NEW.currency IS DISTINCT FROM OLD.currency THEN
    SELECT currency INTO installment_currency FROM installments WHERE id=NEW.installment_id;
    IF installment_currency IS DISTINCT FROM NEW.currency THEN
      RAISE EXCEPTION 'La moneda del cargo no coincide con la de la cuota.' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.expense_id IS NOT NULL AND (TG_OP='INSERT' OR NEW.expense_id IS DISTINCT FROM OLD.expense_id OR NEW.currency IS DISTINCT FROM OLD.currency) THEN
    -- Serializes concurrent links of the same expense; each later query sees committed rows.
    PERFORM pg_advisory_xact_lock(hashtext('ferraro:expense-link:'||NEW.expense_id::text));
    IF EXISTS (SELECT 1 FROM installment_services WHERE expense_id=NEW.expense_id AND id<>NEW.id) THEN
      RAISE EXCEPTION 'Este gasto ya tiene un cargo asociado, incluso si fue anulado.' USING ERRCODE='23505';
    END IF;
    SELECT currency INTO expense_currency FROM ledger_entries WHERE id=NEW.expense_id;
    IF expense_currency IS DISTINCT FROM NEW.currency THEN
      RAISE EXCEPTION 'La moneda del cargo no coincide con la del gasto vinculado.' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER installment_services_link_guard BEFORE INSERT OR UPDATE OF expense_id,installment_id,currency ON installment_services
  FOR EACH ROW EXECUTE FUNCTION guard_installment_service_links();

-- Durable, resumable recovery of official BNA rates (one row per queried bulletin day).
CREATE TABLE IF NOT EXISTS late_fee_sync_days (
  day date PRIMARY KEY,
  status text NOT NULL CHECK(status IN ('no_publication','unsupported_notice','imported','index_error','network_error','format_error','source_error','contradiction')),
  attempts integer NOT NULL DEFAULT 1 CHECK(attempts>0),
  first_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  links_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  index_sha256 text,
  error text
);
CREATE INDEX IF NOT EXISTS late_fee_sync_days_status_idx ON late_fee_sync_days(status,day);
ALTER TABLE late_fee_sync_state
  ADD COLUMN IF NOT EXISTS recovery_json jsonb NOT NULL DEFAULT '{}'::jsonb;
