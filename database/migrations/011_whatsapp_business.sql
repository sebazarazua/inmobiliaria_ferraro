ALTER TABLE persons
  ADD COLUMN IF NOT EXISTS whatsapp_normalized text,
  ADD COLUMN IF NOT EXISTS whatsapp_opt_in boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS whatsapp_preferences_json jsonb NOT NULL DEFAULT '{"liquidations":true,"payments":true,"adjustments":true,"expirations":true,"documents":true}'::jsonb,
  ADD COLUMN IF NOT EXISTS whatsapp_session_revoked_at timestamptz;

CREATE INDEX IF NOT EXISTS persons_whatsapp_normalized_idx
  ON persons(whatsapp_normalized)
  WHERE whatsapp_normalized IS NOT NULL AND whatsapp_normalized <> '';

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS owner_visible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS owner_visible_from timestamptz;

CREATE TABLE IF NOT EXISTS whatsapp_conversations (
  id uuid PRIMARY KEY,
  owner_id uuid REFERENCES persons(id) ON DELETE SET NULL,
  phone_e164 text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING_AUTH' CHECK(status IN ('PENDING_AUTH','VERIFIED','HUMAN_HANDOFF','CLOSED','BLOCKED')),
  failed_auth_attempts integer NOT NULL DEFAULT 0,
  session_verified_at timestamptz,
  session_expires_at timestamptz,
  last_message_at timestamptz,
  opted_out_at timestamptz,
  handoff_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS whatsapp_conversations_phone_idx ON whatsapp_conversations(phone_e164);
CREATE INDEX IF NOT EXISTS whatsapp_conversations_owner_idx ON whatsapp_conversations(owner_id);
CREATE INDEX IF NOT EXISTS whatsapp_conversations_status_idx ON whatsapp_conversations(status);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id uuid PRIMARY KEY,
  conversation_id uuid REFERENCES whatsapp_conversations(id) ON DELETE SET NULL,
  direction text NOT NULL CHECK(direction IN ('INBOUND','OUTBOUND','STATUS')),
  whatsapp_message_id text UNIQUE,
  phone_e164 text,
  message_type text NOT NULL DEFAULT 'text',
  body text,
  status text,
  template_name text,
  related_entity_type text,
  related_entity_id uuid,
  automated boolean NOT NULL DEFAULT true,
  error text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS whatsapp_messages_conversation_idx ON whatsapp_messages(conversation_id,created_at DESC);
CREATE INDEX IF NOT EXISTS whatsapp_messages_status_idx ON whatsapp_messages(status);

CREATE TABLE IF NOT EXISTS whatsapp_webhook_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  payload_hash char(64) NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS owner_portal_tokens (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  used_at timestamptz,
  created_via text NOT NULL DEFAULT 'whatsapp',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS owner_portal_tokens_owner_idx ON owner_portal_tokens(owner_id,expires_at DESC);

CREATE TABLE IF NOT EXISTS whatsapp_templates (
  name text PRIMARY KEY,
  meta_template_name text NOT NULL,
  category text NOT NULL DEFAULT 'UTILITY',
  language text NOT NULL DEFAULT 'es_AR',
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('DRAFT','PENDING','APPROVED','REJECTED','PAUSED','DISABLED')),
  description text,
  components_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_automations (
  id uuid PRIMARY KEY,
  event_type text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT true,
  trigger_description text NOT NULL,
  template_name text REFERENCES whatsapp_templates(name),
  preference_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_outbound_jobs (
  id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  conversation_id uuid REFERENCES whatsapp_conversations(id) ON DELETE SET NULL,
  owner_id uuid REFERENCES persons(id) ON DELETE SET NULL,
  phone_e164 text NOT NULL,
  payload_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','SENDING','SENT','FAILED','DEAD')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  meta_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS whatsapp_outbound_jobs_status_idx ON whatsapp_outbound_jobs(status,next_attempt_at);

CREATE TABLE IF NOT EXISTS whatsapp_automation_events (
  id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  event_type text NOT NULL,
  owner_id uuid REFERENCES persons(id) ON DELETE SET NULL,
  related_entity_type text,
  related_entity_id uuid,
  job_id uuid REFERENCES whatsapp_outbound_jobs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO whatsapp_templates(name,meta_template_name,category,language,status,description,components_json) VALUES
  ('propietario_nueva_liquidacion','propietario_nueva_liquidacion','UTILITY','es_AR','PENDING','Aviso de nueva liquidación disponible','{"body":["nombre","periodo"]}'::jsonb),
  ('propietario_transferencia_realizada','propietario_transferencia_realizada','UTILITY','es_AR','PENDING','Aviso de transferencia realizada','{"body":["nombre","periodo"]}'::jsonb),
  ('propietario_ajuste_proximo','propietario_ajuste_proximo','UTILITY','es_AR','PENDING','Aviso de ajuste próximo','{"body":["propiedad","fecha"]}'::jsonb),
  ('propietario_contrato_por_vencer','propietario_contrato_por_vencer','UTILITY','es_AR','PENDING','Aviso de contrato por vencer','{"body":["propiedad","fecha"]}'::jsonb),
  ('propietario_documento_disponible','propietario_documento_disponible','UTILITY','es_AR','PENDING','Aviso de documento disponible','{"body":["nombre"]}'::jsonb),
  ('propietario_actualizacion','propietario_actualizacion','UTILITY','es_AR','PENDING','Actualización general','{"body":["nombre","detalle"]}'::jsonb)
ON CONFLICT(name) DO NOTHING;

INSERT INTO whatsapp_automations(id,event_type,enabled,trigger_description,template_name,preference_key) VALUES
  (gen_random_uuid(),'NEW_LIQUIDATION',true,'Cuando se registra una nueva liquidación oficial para un propietario','propietario_nueva_liquidacion','liquidations'),
  (gen_random_uuid(),'TRANSFER_DONE',true,'Cuando se marca una transferencia al propietario como realizada','propietario_transferencia_realizada','payments'),
  (gen_random_uuid(),'UPCOMING_ADJUSTMENT',true,'Cuando un contrato vinculado tendrá un ajuste próximo','propietario_ajuste_proximo','adjustments'),
  (gen_random_uuid(),'CONTRACT_EXPIRING',true,'Cuando un contrato vinculado está próximo a vencer','propietario_contrato_por_vencer','expirations'),
  (gen_random_uuid(),'DOCUMENT_AVAILABLE',true,'Cuando se habilita un documento para propietarios','propietario_documento_disponible','documents'),
  (gen_random_uuid(),'PAYMENT_REGISTERED',true,'Cuando se registra un cobro que corresponde informar al propietario','propietario_actualizacion','payments')
ON CONFLICT(event_type) DO NOTHING;
