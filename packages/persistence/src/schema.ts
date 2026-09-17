// POC SQLite schema. Every business table carries tenant_id so the later server
// migration does not need to retrofit the isolation boundary.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tenant (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_user (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  wecom_userid TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'employee',
  manager_user_id TEXT REFERENCES app_user(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, wecom_userid)
);

CREATE TABLE IF NOT EXISTS user_activation_code (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  user_id TEXT NOT NULL REFERENCES app_user(id),
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  pending_wecom_userid TEXT,
  verified_at TEXT,
  used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, code_hash)
);
CREATE INDEX IF NOT EXISTS idx_activation_user ON user_activation_code(tenant_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS binding_attempt (
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  wecom_userid TEXT NOT NULL,
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, wecom_userid)
);

CREATE TABLE IF NOT EXISTS work_item (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  user_id TEXT NOT NULL REFERENCES app_user(id),
  week_id TEXT NOT NULL,
  name TEXT NOT NULL,
  plan_background TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_work_item_user_week ON work_item(tenant_id, user_id, week_id, deleted);

CREATE TABLE IF NOT EXISTS work_item_revision (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  work_item_id TEXT NOT NULL REFERENCES work_item(id),
  version INTEGER NOT NULL,
  change_type TEXT NOT NULL CHECK(change_type IN ('created','updated','deleted')),
  name TEXT NOT NULL,
  plan_background TEXT NOT NULL DEFAULT '',
  actor_user_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, work_item_id, version)
);

CREATE TABLE IF NOT EXISTS source_message (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  msg_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES app_user(id),
  report_date TEXT NOT NULL,
  content_type TEXT NOT NULL,
  text_content TEXT NOT NULL DEFAULT '',
  quoted_text TEXT,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  process_status TEXT NOT NULL DEFAULT 'received',
  process_error TEXT,
  daily_report_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, msg_id)
);
CREATE INDEX IF NOT EXISTS idx_source_user_date ON source_message(tenant_id, user_id, report_date, created_at);

CREATE TABLE IF NOT EXISTS daily_report (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  user_id TEXT NOT NULL REFERENCES app_user(id),
  report_date TEXT NOT NULL,
  version INTEGER NOT NULL,
  generation_revision INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('collecting','draft','pending_confirmation','confirmed','superseded')),
  summary TEXT,
  progress_json TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, user_id, report_date, version)
);
CREATE INDEX IF NOT EXISTS idx_daily_user_date ON daily_report(tenant_id, user_id, report_date, version DESC);

-- Draft contents are immutable. A correction always creates another report ID.
CREATE TRIGGER IF NOT EXISTS daily_report_immutable_content
BEFORE UPDATE OF tenant_id, user_id, report_date, version, summary, progress_json ON daily_report
BEGIN
  SELECT RAISE(ABORT, '日报内容不可原地覆盖，请创建新版本');
END;

CREATE TABLE IF NOT EXISTS daily_generation_state (
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  user_id TEXT NOT NULL REFERENCES app_user(id),
  report_date TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id, report_date)
);

CREATE TABLE IF NOT EXISTS daily_user_state (
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  user_id TEXT NOT NULL REFERENCES app_user(id),
  state_version INTEGER NOT NULL DEFAULT 0,
  displayed_report_id TEXT REFERENCES daily_report(id),
  editing_report_id TEXT REFERENCES daily_report(id),
  last_confirmed_report_id TEXT REFERENCES daily_report(id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS daily_report_presentation (
  daily_report_id TEXT PRIMARY KEY REFERENCES daily_report(id),
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  user_id TEXT NOT NULL REFERENCES app_user(id),
  content_hash TEXT NOT NULL,
  presented_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_confirmation_receipt (
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  command_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES app_user(id),
  daily_report_id TEXT REFERENCES daily_report(id),
  completed_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, command_id)
);

CREATE TABLE IF NOT EXISTS daily_report_source (
  daily_report_id TEXT NOT NULL REFERENCES daily_report(id),
  source_message_id TEXT NOT NULL REFERENCES source_message(id),
  PRIMARY KEY (daily_report_id, source_message_id)
);

CREATE TABLE IF NOT EXISTS weekly_report (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  user_id TEXT NOT NULL REFERENCES app_user(id),
  week_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  template_version TEXT NOT NULL,
  content TEXT NOT NULL,
  sections_json TEXT NOT NULL DEFAULT '[]',
  cited_report_ids_json TEXT NOT NULL DEFAULT '[]',
  item_snapshot_json TEXT NOT NULL DEFAULT '[]',
  missing_days_json TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  UNIQUE (tenant_id, user_id, week_id, version)
);

CREATE TABLE IF NOT EXISTS manager_feedback (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  weekly_report_id TEXT NOT NULL REFERENCES weekly_report(id),
  work_item_id TEXT REFERENCES work_item(id),
  manager_user_id TEXT NOT NULL REFERENCES app_user(id),
  to_user_id TEXT NOT NULL REFERENCES app_user(id),
  content TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS access_grant (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  token_hash TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES app_user(id),
  resource_type TEXT NOT NULL CHECK(resource_type IN ('weekly_report')),
  resource_id TEXT NOT NULL REFERENCES weekly_report(id),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, token_hash)
);
CREATE INDEX IF NOT EXISTS idx_access_grant_token ON access_grant(tenant_id, token_hash, expires_at);

CREATE TABLE IF NOT EXISTS auth_session (
  token_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  resource_id TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_session_expiry ON auth_session(tenant_id, expires_at, revoked_at);

CREATE TABLE IF NOT EXISTS message_outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  UNIQUE (tenant_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON message_outbox(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  actor_user_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS report_template (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  kind TEXT NOT NULL CHECK(kind IN ('daily','weekly')),
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, kind, version)
);

CREATE TABLE IF NOT EXISTS knowledge_entry (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  kind TEXT NOT NULL CHECK(kind IN ('service_company','park_material','policy','guide')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  source_name TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_kind ON knowledge_entry(tenant_id, kind, active, updated_at DESC);

CREATE TABLE IF NOT EXISTS app_config (
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  config_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, config_key)
);
`;
