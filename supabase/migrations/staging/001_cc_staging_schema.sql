-- Phase 2 STAGING ONLY — schema cc_staging (never public production tables)
-- Apply with: scripts/db/apply-staging-schema.mjs

CREATE SCHEMA IF NOT EXISTS cc_staging;

SET search_path TO cc_staging;

-- ─── Shared trigger for updated_at + version ───────────────────────────────

CREATE OR REPLACE FUNCTION cc_staging.set_row_version()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  NEW.version = OLD.version + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─── Projects ────────────────────────────────────────────────────────────

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  status TEXT,
  color TEXT,
  type TEXT,
  project_category TEXT,
  total_budget NUMERIC(12,2),
  sqft INTEGER,
  start_date DATE,
  finished_date DATE,
  closed_date DATE,
  original_contract NUMERIC(12,2),
  contract_date DATE,
  contract_scope_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ
);

CREATE TABLE project_change_orders (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  amount NUMERIC(12,2),
  status TEXT,
  change_date DATE,
  scope_notes TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_change_orders_project ON project_change_orders(project_id);

-- ─── Phases ──────────────────────────────────────────────────────────────

CREATE TABLE phases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  name_he TEXT,
  sort_order INTEGER,
  status TEXT,
  progress INTEGER,
  who TEXT,
  phase_group TEXT,
  labor_cost NUMERIC(12,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ
);

CREATE TABLE phase_materials (
  id TEXT PRIMARY KEY,
  phase_id TEXT NOT NULL REFERENCES phases(id),
  name TEXT,
  brand TEXT,
  description TEXT,
  color TEXT,
  qty NUMERIC(12,2),
  unit TEXT,
  unit_price NUMERIC(12,2),
  model_num TEXT,
  store TEXT,
  dimensions TEXT,
  buyer TEXT,
  status TEXT,
  image_url TEXT,
  product_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ
);

CREATE TABLE phase_checklists (
  id TEXT PRIMARY KEY,
  phase_id TEXT NOT NULL REFERENCES phases(id),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ
);

CREATE TABLE phase_checklist_items (
  id TEXT PRIMARY KEY,
  checklist_id TEXT NOT NULL REFERENCES phase_checklists(id),
  item_text TEXT NOT NULL,
  is_done BOOLEAN NOT NULL DEFAULT false,
  done_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_phases_project ON phases(project_id);

-- ─── Tasks ───────────────────────────────────────────────────────────────

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  phase_id TEXT REFERENCES phases(id),
  title TEXT NOT NULL,
  assignee TEXT,
  priority TEXT,
  status TEXT,
  due_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ
);

-- ─── Contacts & scopes ───────────────────────────────────────────────────

CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  company TEXT,
  phone TEXT,
  email TEXT,
  type TEXT,
  trade TEXT,
  rating INTEGER,
  license TEXT,
  insurance_expiry TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ
);

CREATE TABLE contact_projects (
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  PRIMARY KEY (contact_id, project_id)
);

CREATE TABLE scopes (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  phase_id TEXT REFERENCES phases(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT,
  price NUMERIC(12,2),
  notes TEXT,
  payment_terms TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ
);

CREATE TABLE scope_stages (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL REFERENCES scopes(id),
  name TEXT NOT NULL,
  description TEXT,
  start_date DATE,
  end_date DATE,
  status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ
);

CREATE TABLE scope_checklists (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL REFERENCES scopes(id),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ
);

CREATE TABLE scope_checklist_items (
  id TEXT PRIMARY KEY,
  checklist_id TEXT NOT NULL REFERENCES scope_checklists(id),
  item_text TEXT NOT NULL,
  is_done BOOLEAN NOT NULL DEFAULT false,
  done_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ
);

CREATE TABLE scope_payment_plans (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL REFERENCES scopes(id),
  plan_index INTEGER NOT NULL,
  amount NUMERIC(12,2),
  due_date DATE,
  milestone TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ
);

CREATE TABLE payment_schedules (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  scope_id TEXT REFERENCES scopes(id),
  payment_num INTEGER,
  amount NUMERIC(12,2),
  due_date DATE,
  milestone TEXT,
  linked_stage TEXT,
  status TEXT,
  paid_date DATE,
  method TEXT,
  confirmation TEXT,
  notes TEXT,
  receipt_doc_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_scopes_contact ON scopes(contact_id);
CREATE INDEX idx_scopes_project ON scopes(project_id);
CREATE INDEX idx_payment_schedules_contact ON payment_schedules(contact_id);

-- ─── Pays (expenses) ─────────────────────────────────────────────────────

CREATE TABLE pays (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  pay_date DATE,
  amount NUMERIC(12,2) NOT NULL,
  payee TEXT,
  vendor TEXT,
  description TEXT,
  method TEXT,
  category TEXT,
  cost_category TEXT,
  notes TEXT,
  confirmation TEXT,
  source TEXT,
  status TEXT,
  paid_date DATE,
  contractor_id TEXT REFERENCES contacts(id),
  scope_id TEXT REFERENCES scopes(id),
  stage_id TEXT REFERENCES scope_stages(id),
  phase_id TEXT REFERENCES phases(id),
  payment_schedule_id TEXT REFERENCES payment_schedules(id),
  receipt_doc_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_pays_project ON pays(project_id);
CREATE INDEX idx_pays_contractor ON pays(contractor_id);

-- ─── Documents ───────────────────────────────────────────────────────────

CREATE TABLE document_folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder_key TEXT NOT NULL UNIQUE,
  parent_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  folder_key TEXT,
  name TEXT NOT NULL,
  mime_type TEXT,
  size_bytes BIGINT,
  notes TEXT,
  expiry_date DATE,
  storage_path TEXT,
  inline_data_present BOOLEAN NOT NULL DEFAULT false,
  kind TEXT,
  contact_id TEXT REFERENCES contacts(id),
  scope_id TEXT REFERENCES scopes(id),
  payment_schedule_id TEXT REFERENCES payment_schedules(id),
  change_order_id TEXT REFERENCES project_change_orders(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ,
  CONSTRAINT documents_single_parent_link CHECK (
    num_nonnulls(contact_id, scope_id, payment_schedule_id, change_order_id) <= 1
  )
);

CREATE INDEX idx_documents_project ON documents(project_id);

-- Deferred FK from payment_schedules.receipt_doc_id → documents (circular)
-- Applied after documents import in migration script

-- ─── Comms & orders ──────────────────────────────────────────────────────

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  sender TEXT,
  body TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  type TEXT,
  message TEXT,
  is_read BOOLEAN NOT NULL DEFAULT false,
  notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ
);

CREATE TABLE material_orders (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  order_num TEXT,
  order_date DATE,
  supplier TEXT,
  supplier_email TEXT,
  supplier_id TEXT REFERENCES contacts(id),
  total NUMERIC(12,2),
  notes TEXT,
  delivery_date DATE,
  actual_delivery DATE,
  status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ
);

CREATE TABLE material_order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES material_orders(id),
  item_index INTEGER NOT NULL,
  name TEXT,
  qty NUMERIC(12,2),
  unit_price NUMERIC(12,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ
);

-- ─── Version triggers (mutable tables) ───────────────────────────────────

DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'projects','project_change_orders','phases','phase_materials',
    'phase_checklists','phase_checklist_items','tasks','contacts',
    'scopes','scope_stages','scope_checklists','scope_checklist_items',
    'scope_payment_plans','payment_schedules','pays','document_folders',
    'documents','messages','notifications','material_orders','material_order_items'
  ]) LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%s_version BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION cc_staging.set_row_version()',
      t, t
    );
  END LOOP;
END $$;
