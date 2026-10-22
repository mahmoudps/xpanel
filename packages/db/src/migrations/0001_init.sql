-- xPanel operational & derived-index SQLite schema (0001_init.sql).
-- Authoritative desired state lives in atomic JSON files under /var/lib/xpanel/state/
-- owned by @xpanel/state. This SQLite database holds only:
--   1. Operational tables (principals, sessions, api_tokens, login_attempts,
--      lockouts, config_generations, upgrades, jobs, metrics_history, audit_log)
--   2. Rebuildable derived index tables (idx_*) and FTS5 search index (search_fts)
--      populated from the state directory via `xpanel reindex`.

-- ---------------------------------------------------------------------------
-- 1. Identity, Sessions, API Tokens, Brute-Force Lockouts
-- ---------------------------------------------------------------------------

CREATE TABLE principals (
  id TEXT PRIMARY KEY CHECK (
    length(id) = 36 AND
    id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  kind TEXT NOT NULL CHECK (kind IN ('root', 'reseller', 'user')),
  username TEXT NOT NULL CHECK (
    length(username) BETWEEN 1 AND 32 AND
    username = lower(username) AND
    substr(username, 1, 1) GLOB '[a-z]' AND
    username NOT GLOB '*[^a-z0-9_-]*'
  ),
  password_hash TEXT NOT NULL CHECK (
    length(password_hash) BETWEEN 30 AND 512 AND
    password_hash GLOB '$argon2id$v=19$*'
  ),
  force_password_change INTEGER NOT NULL DEFAULT 0 CHECK (force_password_change IN (0, 1)),
  password_changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  totp_secret_enc BLOB CHECK (totp_secret_enc IS NULL OR (length(totp_secret_enc) BETWEEN 16 AND 1024)),
  totp_enabled_at TEXT,
  totp_recovery_hashes TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(totp_recovery_hashes) AND json_type(totp_recovery_hashes) = 'array'
  ),
  totp_last_step INTEGER CHECK (totp_last_step IS NULL OR totp_last_step BETWEEN 0 AND 9007199254740991),
  account_id TEXT CHECK (account_id IS NULL OR length(account_id) = 36),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((kind = 'user' AND account_id IS NOT NULL) OR (kind IN ('root', 'reseller') AND account_id IS NULL)),
  CHECK ((totp_secret_enc IS NULL) = (totp_enabled_at IS NULL)),
  CHECK (totp_secret_enc IS NOT NULL OR totp_last_step IS NULL)
) STRICT;

CREATE UNIQUE INDEX principals_username_key ON principals (lower(username));
CREATE INDEX principals_account_id_idx ON principals (account_id) WHERE account_id IS NOT NULL;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK (
    length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  ip TEXT CHECK (ip IS NULL OR (length(ip) BETWEEN 2 AND 45)),
  user_agent TEXT CHECK (user_agent IS NULL OR length(user_agent) <= 512),
  mfa_verified INTEGER NOT NULL DEFAULT 0 CHECK (mfa_verified IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK (expires_at > created_at)
) STRICT;

CREATE INDEX sessions_principal_id_idx ON sessions (principal_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE totp_enrollments (
  principal_id TEXT PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
  enrollment_id TEXT NOT NULL UNIQUE CHECK (length(enrollment_id) = 36),
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sealed_secret BLOB NOT NULL CHECK (length(sealed_secret) BETWEEN 16 AND 1024),
  recovery_hashes TEXT NOT NULL CHECK (json_valid(recovery_hashes) AND json_type(recovery_hashes) = 'array'),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > created_at)
) STRICT;

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  token_hash TEXT NOT NULL UNIQUE CHECK (
    length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  scopes TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
  allowed_ips TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allowed_ips) AND json_type(allowed_ips) = 'array'),
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  last_used_ip TEXT CHECK (last_used_ip IS NULL OR (length(last_used_ip) BETWEEN 2 AND 45)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revoked_at TEXT,
  CHECK (expires_at > created_at)
) STRICT;

CREATE INDEX api_tokens_principal_id_idx ON api_tokens (principal_id);

CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  surface TEXT NOT NULL DEFAULT 'panel' CHECK (surface IN ('panel', 'api', 'webmail')),
  username TEXT NOT NULL CHECK (length(username) BETWEEN 1 AND 128),
  ip TEXT NOT NULL CHECK (length(ip) BETWEEN 2 AND 45),
  success INTEGER NOT NULL CHECK (success IN (0, 1)),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 255)
) STRICT;

CREATE INDEX login_attempts_username_at_idx ON login_attempts (lower(username), at DESC);
CREATE INDEX login_attempts_ip_at_idx ON login_attempts (ip, at DESC);

CREATE TABLE lockouts (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  username TEXT CHECK (username IS NULL OR (length(username) BETWEEN 1 AND 128 AND username = lower(username))),
  ip TEXT CHECK (ip IS NULL OR (length(ip) BETWEEN 2 AND 45)),
  failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  reason TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 255),
  locked_until TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((username IS NOT NULL AND ip IS NULL) OR (username IS NULL AND ip IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX lockouts_username_key ON lockouts (lower(username)) WHERE username IS NOT NULL;
CREATE UNIQUE INDEX lockouts_ip_key ON lockouts (ip) WHERE ip IS NOT NULL;
CREATE INDEX lockouts_locked_until_idx ON lockouts (locked_until);

CREATE TABLE login_failure_counters (
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('username', 'ip')),
  subject_value TEXT NOT NULL CHECK (
    length(subject_value) BETWEEN 1 AND 128 AND
    (subject_kind != 'username' OR subject_value = lower(subject_value)) AND
    (subject_kind != 'ip' OR length(subject_value) BETWEEN 2 AND 45)
  ),
  failures INTEGER NOT NULL CHECK (failures BETWEEN 1 AND 1000000),
  window_started_at TEXT NOT NULL,
  PRIMARY KEY (subject_kind, subject_value)
) STRICT;

-- ---------------------------------------------------------------------------
-- 2. Config Generations, Upgrades, Background Jobs, Metrics, Audit Index
-- ---------------------------------------------------------------------------

CREATE TABLE config_generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'tested', 'active', 'superseded', 'failed', 'rolled_back')
  ),
  checksum TEXT NOT NULL CHECK (length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*'),
  error TEXT CHECK (error IS NULL OR (length(error) BETWEEN 1 AND 16384)),
  actor TEXT NOT NULL DEFAULT 'system' CHECK (length(actor) BETWEEN 1 AND 255),
  tested_at TEXT,
  activated_at TEXT,
  CHECK ((status IN ('failed', 'rolled_back') AND error IS NOT NULL) OR (status NOT IN ('failed', 'rolled_back'))),
  CHECK (status NOT IN ('tested', 'active', 'superseded') OR tested_at IS NOT NULL),
  CHECK (status NOT IN ('active', 'superseded') OR activated_at IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX config_generations_single_active_idx
  ON config_generations (status) WHERE status = 'active';

CREATE TRIGGER config_generations_transition_guard
BEFORE UPDATE ON config_generations
BEGIN
  SELECT CASE
    WHEN NEW.checksum <> OLD.checksum THEN
      RAISE(ABORT, 'VALIDATION: config_generations.checksum is immutable')
    WHEN OLD.status = NEW.status THEN NULL
    WHEN OLD.status = 'pending' AND NEW.status IN ('tested', 'failed') THEN NULL
    WHEN OLD.status = 'tested' AND NEW.status IN ('active', 'failed') THEN NULL
    WHEN OLD.status = 'active' AND NEW.status IN ('superseded', 'rolled_back') THEN NULL
    WHEN OLD.status = 'superseded' AND NEW.status = 'active' THEN NULL
    ELSE
      RAISE(ABORT, 'VALIDATION: illegal config_generations status transition')
  END;
END;

CREATE TABLE upgrades (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  from_version TEXT NOT NULL CHECK (
    length(from_version) BETWEEN 5 AND 64 AND from_version GLOB '[0-9]*.[0-9]*.[0-9]*'
  ),
  to_version TEXT NOT NULL CHECK (
    length(to_version) BETWEEN 5 AND 64 AND to_version GLOB '[0-9]*.[0-9]*.[0-9]*' AND from_version <> to_version
  ),
  from_schema_version INTEGER CHECK (from_schema_version IS NULL OR from_schema_version >= 0),
  to_schema_version INTEGER CHECK (to_schema_version IS NULL OR to_schema_version >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'running', 'succeeded', 'failed', 'rolled_back')
  ),
  phase TEXT CHECK (
    phase IS NULL OR phase IN ('precheck', 'snapshot', 'stage', 'migrate', 'switch', 'health-check', 'rollback')
  ),
  health_report TEXT CHECK (
    health_report IS NULL OR (json_valid(health_report) AND json_type(health_report) = 'object')
  ),
  snapshot_path TEXT CHECK (
    snapshot_path IS NULL OR (length(snapshot_path) BETWEEN 2 AND 1024 AND substr(snapshot_path, 1, 1) = '/')
  ),
  error TEXT CHECK (error IS NULL OR (length(error) BETWEEN 1 AND 16384)),
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 255),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  finished_at TEXT,
  CHECK ((status IN ('failed', 'rolled_back') AND error IS NOT NULL) OR (status NOT IN ('failed', 'rolled_back'))),
  CHECK ((status IN ('succeeded', 'failed', 'rolled_back') AND finished_at IS NOT NULL) OR (status IN ('pending', 'running') AND finished_at IS NULL))
) STRICT;

CREATE UNIQUE INDEX upgrades_single_inflight_idx
  ON upgrades ((1)) WHERE status IN ('pending', 'running');

CREATE TABLE jobs (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  kind TEXT NOT NULL CHECK (
    length(kind) BETWEEN 1 AND 128 AND
    substr(kind, 1, 1) GLOB '[a-z]' AND
    kind NOT GLOB '*[^a-z0-9_.:-]*'
  ),
  account_id TEXT CHECK (account_id IS NULL OR length(account_id) = 36),
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 255),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')
  ),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  summary TEXT NOT NULL DEFAULT '' CHECK (length(summary) <= 512),
  detail TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail) AND json_type(detail) = 'object'),
  error TEXT CHECK (error IS NULL OR (length(error) BETWEEN 1 AND 16384)),
  log_path TEXT CHECK (log_path IS NULL OR (length(log_path) BETWEEN 2 AND 1024 AND substr(log_path, 1, 1) = '/')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX jobs_status_created_idx ON jobs (status, created_at DESC);
CREATE INDEX jobs_account_id_idx ON jobs (account_id, created_at DESC) WHERE account_id IS NOT NULL;

CREATE TABLE metrics_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  scope TEXT NOT NULL CHECK (scope IN ('host', 'account')),
  account_id TEXT CHECK (
    (scope = 'host' AND account_id IS NULL) OR
    (scope = 'account' AND account_id IS NOT NULL AND length(account_id) = 36)
  ),
  cpu_percent REAL NOT NULL DEFAULT 0 CHECK (cpu_percent >= 0),
  memory_mb REAL NOT NULL DEFAULT 0 CHECK (memory_mb >= 0),
  disk_mb REAL NOT NULL DEFAULT 0 CHECK (disk_mb >= 0),
  bandwidth_bytes INTEGER NOT NULL DEFAULT 0 CHECK (bandwidth_bytes >= 0),
  io_read_bps INTEGER NOT NULL DEFAULT 0 CHECK (io_read_bps >= 0),
  io_write_bps INTEGER NOT NULL DEFAULT 0 CHECK (io_write_bps >= 0),
  processes INTEGER NOT NULL DEFAULT 0 CHECK (processes >= 0),
  load1 REAL NOT NULL DEFAULT 0 CHECK (load1 >= 0)
) STRICT;

CREATE INDEX metrics_history_scope_at_idx ON metrics_history (scope, account_id, at DESC);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor TEXT NOT NULL CHECK (
    length(actor) BETWEEN 1 AND 255 AND
    instr(actor, char(10)) = 0 AND
    instr(actor, char(13)) = 0 AND
    instr(actor, char(0)) = 0
  ),
  principal_id TEXT CHECK (principal_id IS NULL OR length(principal_id) = 36),
  ip TEXT CHECK (ip IS NULL OR (length(ip) BETWEEN 2 AND 45)),
  action TEXT NOT NULL CHECK (
    length(action) BETWEEN 1 AND 128 AND
    substr(action, 1, 1) GLOB '[a-z]' AND
    action NOT GLOB '*[^a-z0-9_.:-]*'
  ),
  target TEXT NOT NULL CHECK (
    length(target) <= 512 AND
    instr(target, char(10)) = 0 AND
    instr(target, char(13)) = 0 AND
    instr(target, char(0)) = 0
  ),
  detail TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(detail) AND json_type(detail) = 'object' AND length(detail) <= 65536
  ),
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'denied', 'failed'))
) STRICT;

CREATE INDEX audit_log_actor_idx ON audit_log (actor, id DESC);
CREATE INDEX audit_log_action_idx ON audit_log (action, id DESC);
CREATE INDEX audit_log_target_idx ON audit_log (target, id DESC);

CREATE TRIGGER audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'FORBIDDEN: audit_log is append-only');
END;

CREATE TRIGGER audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'FORBIDDEN: audit_log is append-only');
END;

-- ---------------------------------------------------------------------------
-- 3. Rebuildable Derived Index Tables (populated from /var/lib/xpanel/state/)
-- ---------------------------------------------------------------------------

CREATE TABLE idx_resellers (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  username TEXT NOT NULL UNIQUE,
  acl TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(acl) AND json_type(acl) = 'array'),
  max_accounts INTEGER,
  total_disk_mb INTEGER,
  total_bandwidth_mb INTEGER,
  oversell INTEGER NOT NULL DEFAULT 0 CHECK (oversell IN (0, 1)),
  nameservers TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(nameservers) AND json_type(nameservers) = 'array'),
  delegated_ips TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(delegated_ips) AND json_type(delegated_ips) = 'array'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE idx_plans (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  name TEXT NOT NULL,
  owner_id TEXT,
  feature_list_id TEXT NOT NULL,
  disk_mb INTEGER,
  bandwidth_mb_month INTEGER,
  memory_mb INTEGER,
  cpu_percent INTEGER,
  max_processes INTEGER,
  php_workers INTEGER,
  dedicated_ip INTEGER NOT NULL DEFAULT 0 CHECK (dedicated_ip IN (0, 1)),
  shell TEXT NOT NULL DEFAULT 'none' CHECK (shell IN ('none', 'jailed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_plans_owner_idx ON idx_plans (owner_id);

CREATE TABLE idx_accounts (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  username TEXT NOT NULL UNIQUE,
  uid INTEGER NOT NULL UNIQUE CHECK (uid BETWEEN 20000 AND 60000),
  gid INTEGER NOT NULL UNIQUE CHECK (gid BETWEEN 20000 AND 60000),
  home TEXT NOT NULL UNIQUE,
  primary_domain TEXT NOT NULL UNIQUE,
  plan_id TEXT NOT NULL,
  owner_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'terminating')),
  suspend_reason TEXT,
  suspended_at TEXT,
  contact_email TEXT NOT NULL,
  ipv4 TEXT NOT NULL,
  shell TEXT NOT NULL CHECK (shell IN ('none', 'jailed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_accounts_owner_idx ON idx_accounts (owner_id);
CREATE INDEX idx_accounts_plan_idx ON idx_accounts (plan_id);
CREATE INDEX idx_accounts_status_idx ON idx_accounts (status);

CREATE TABLE idx_domains (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('primary', 'addon', 'alias', 'subdomain')),
  parent_id TEXT,
  doc_root TEXT NOT NULL,
  site_type TEXT NOT NULL CHECK (site_type IN ('php', 'static', 'proxy', 'node', 'python')),
  upstream TEXT,
  redirect_to TEXT,
  redirect_code INTEGER,
  php_version TEXT NOT NULL,
  php_handler TEXT NOT NULL,
  wildcard INTEGER NOT NULL DEFAULT 0 CHECK (wildcard IN (0, 1)),
  certificate_id TEXT,
  suspended INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0, 1)),
  expires_at TEXT,
  path_quota_mb INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX idx_domains_name_key ON idx_domains (lower(name));
CREATE INDEX idx_domains_account_idx ON idx_domains (account_id);

CREATE TABLE idx_service_users (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  local_part TEXT NOT NULL,
  address TEXT NOT NULL,
  email INTEGER NOT NULL DEFAULT 0 CHECK (email IN (0, 1)),
  ftp INTEGER NOT NULL DEFAULT 0 CHECK (ftp IN (0, 1)),
  webdisk INTEGER NOT NULL DEFAULT 0 CHECK (webdisk IN (0, 1)),
  mailbox_quota_mb INTEGER,
  ftp_dir TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX idx_service_users_address_key ON idx_service_users (lower(address));
CREATE INDEX idx_service_users_account_idx ON idx_service_users (account_id);

CREATE TABLE idx_databases (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL,
  engine TEXT NOT NULL DEFAULT 'mariadb' CHECK (engine IN ('mariadb')),
  name TEXT NOT NULL UNIQUE,
  trashed_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_databases_account_idx ON idx_databases (account_id);

-- Full-text search virtual table across accounts, domains, service users, databases, plans, resellers
CREATE VIRTUAL TABLE search_fts USING fts5(
  kind,
  entity_id,
  account_id,
  owner_id,
  title,
  subtitle,
  keywords,
  tokenize = 'unicode61 remove_diacritics 2'
);
