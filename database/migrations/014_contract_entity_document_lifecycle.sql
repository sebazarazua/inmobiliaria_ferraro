-- Additive only. Lifecycle states for contracts, archiving of shared entities and
-- exclusion of PDFs from automatic imports. No existing row is rewritten.
ALTER TABLE contracts DROP CONSTRAINT IF EXISTS contracts_status_check;
ALTER TABLE contracts
  ADD CONSTRAINT contracts_status_check CHECK(status IN ('Borrador','Activo','Finalizado','Vencido','Rescindido','Renovado','Revisión','Anulado','Archivado','Desactivado'));

-- Status held before a temporary deactivation and before an archive, restored verbatim afterwards.
-- They are separate so archiving a deactivated contract keeps both steps reversible.
ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS deactivated_from_status text,
  ADD COLUMN IF NOT EXISTS archived_from_status text,
  ADD COLUMN IF NOT EXISTS finalized_at timestamptz;

ALTER TABLE properties ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE persons ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- Every attempt keeps its own row; a new attempt points to the one it replaces.
ALTER TABLE imports ADD COLUMN IF NOT EXISTS previous_import_id uuid;
CREATE INDEX IF NOT EXISTS imports_sha_created_idx ON imports(sha256,created_at DESC);
CREATE INDEX IF NOT EXISTS imports_path_idx ON imports(absolute_path);

-- The scanner never imports a PDF whose content hash is listed here.
CREATE TABLE IF NOT EXISTS import_exclusions (
  sha256 char(64) PRIMARY KEY,
  filename text,
  absolute_path text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
