-- 0001_init: xPanel control database (desired state).
--
-- Limits: every capped quantity is a bigint where NULL means "unlimited".
-- Negative values (including the -1 sentinel) are rejected by CHECK, so
-- "unlimited" cannot come out of arithmetic or a typo. Mappers translate
-- NULL <-> core Limit 'unlimited' explicitly. The upper bound 2^53-1 keeps
-- every value exact as a JavaScript number.
--
-- Requires PostgreSQL 13+ (gen_random_uuid) and no extensions.
-- Expand-only: later migrations add, they never drop or retype (see migrate.ts).

-- ---------------------------------------------------------------- helpers

CREATE FUNCTION xpanel_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE FUNCTION xpanel_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % rejected', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

-- true when every element is non-null and matches pattern (empty array: true)
CREATE FUNCTION xpanel_all_match(arr text[], pattern text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT coalesce(bool_and(x IS NOT NULL AND x ~ pattern), true) FROM unnest(arr) AS x
$$;

-- every element is a single address (/32 or /128), none NULL
CREATE FUNCTION xpanel_all_hosts(arr inet[]) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT coalesce(bool_and(x IS NOT NULL AND masklen(x) = CASE family(x) WHEN 4 THEN 32 ELSE 128 END), true) FROM unnest(arr) AS x
$$;

-- lowercase LDH host name with at least two labels; IDNs arrive as punycode
CREATE FUNCTION xpanel_is_hostname(v text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT length(v) <= 253
    AND v ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
$$;

CREATE FUNCTION xpanel_is_email(v text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT length(v) <= 254
    AND v ~* '^[a-z0-9._%+-]{1,64}@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
$$;

-- absolute path that is safe to place in config files: no '.'/'..' segments,
-- no empty segments, no spaces, quotes or shell metacharacters
CREATE FUNCTION xpanel_is_abs_path(v text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT length(v) <= 1024
    AND v ~ '^(/[A-Za-z0-9._@+-]+)+$'
    AND v !~ '/\.{1,2}(/|$)'
$$;

-- relative path (to an account home) with the same alphabet; '' is the home itself
CREATE FUNCTION xpanel_is_rel_path(v text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT v = '' OR (
    length(v) <= 1024
    AND v ~ '^[A-Za-z0-9._@+-]+(/[A-Za-z0-9._@+-]+)*$'
    AND v !~ '(^|/)\.{1,2}(/|$)'
  )
$$;

-- user-owned relative path (file manager names may contain spaces/unicode);
-- never handed to a shell, only to argv/syscalls
CREATE FUNCTION xpanel_is_user_path(v text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT length(v) BETWEEN 1 AND 4096
    AND v !~ '[[:cntrl:]]'
    AND v !~ '^/'
    AND v !~ '(^|/)\.{1,2}(/|$)'
    AND v !~ '//'
$$;

-- single line of free text
CREATE FUNCTION xpanel_is_line(v text, max_len integer) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT length(v) <= max_len AND v !~ '[[:cntrl:]]'
$$;

-- "80" or "8000-8100", no leading zeros
CREATE FUNCTION xpanel_is_port_spec(v text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE
    WHEN v ~ '^[1-9][0-9]{0,4}$' THEN v::integer BETWEEN 1 AND 65535
    WHEN v ~ '^[1-9][0-9]{0,4}-[1-9][0-9]{0,4}$' THEN
      split_part(v, '-', 1)::integer BETWEEN 1 AND 65535
      AND split_part(v, '-', 2)::integer BETWEEN 1 AND 65535
      AND split_part(v, '-', 1)::integer < split_part(v, '-', 2)::integer
    ELSE false
  END
$$;

CREATE FUNCTION xpanel_is_cron_schedule(v text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT v ~ '^(@(yearly|annually|monthly|weekly|daily|hourly|reboot)|[0-9*/,-]{1,64} [0-9*/,-]{1,64} [0-9*/,-]{1,64} [0-9A-Za-z*/,-]{1,64} [0-9A-Za-z*/,-]{1,64})$'
$$;

CREATE FUNCTION xpanel_is_semver(v text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT length(v) <= 64
    AND v ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'
$$;

-- ---------------------------------------------------------------- identity

CREATE TABLE principals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('root', 'reseller', 'user')),
  username text NOT NULL CHECK (username ~ '^[a-z][a-z0-9_-]{0,31}$'),
  -- Argon2id (RFC 9106) PHC string; plain and other hash schemes are refused
  password_hash text NOT NULL
    -- (Postgres regex bounds stop at 255, so the overall length is checked separately)
    CHECK (length(password_hash) <= 512
      AND password_hash ~ '^\$argon2id\$v=19\$m=[1-9][0-9]{0,9},t=[1-9][0-9]{0,9},p=[1-9][0-9]{0,2}\$[A-Za-z0-9+/]{11,128}\$[A-Za-z0-9+/]{16,}$'),
  force_password_change boolean NOT NULL DEFAULT false,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  -- TOTP secret sealed by the API (nonce || ciphertext || tag) before storage; never plaintext
  totp_secret_enc bytea NULL CHECK (octet_length(totp_secret_enc) BETWEEN 16 AND 1024),
  totp_enabled_at timestamptz NULL,
  totp_recovery_hashes text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(totp_recovery_hashes) <= 32 AND xpanel_all_match(totp_recovery_hashes, '^[0-9a-f]{64}$')),
  -- set for kind = 'user': the account this login owns
  account_id uuid NULL,
  disabled boolean NOT NULL DEFAULT false,
  last_login_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- target of resellers (id, kind): a reseller row always sits on a reseller login
  UNIQUE (id, kind),
  CHECK ((kind = 'user') = (account_id IS NOT NULL)),
  CHECK (totp_enabled_at IS NULL OR totp_secret_enc IS NOT NULL)
);
CREATE UNIQUE INDEX principals_username_key ON principals (lower(username));
CREATE UNIQUE INDEX principals_account_key ON principals (account_id) WHERE account_id IS NOT NULL;

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
  -- sha256 (hex) of the bearer secret; the secret itself is never stored
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  ip inet NULL,
  user_agent text NULL CHECK (xpanel_is_line(user_agent, 512)),
  mfa_verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NULL,
  CHECK (expires_at > created_at)
);
CREATE INDEX sessions_principal_idx ON sessions (principal_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name ~ '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$'),
  -- sha256 (hex) of the token; shown once at creation, never stored
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(scopes) <= 64 AND xpanel_all_match(scopes, '^[a-z][a-z0-9:._*-]{0,63}$')),
  -- empty array: any source address
  allowed_ips cidr[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(allowed_ips) <= 256 AND array_position(allowed_ips, NULL) IS NULL),
  -- tokens always expire (STANDARDS security baseline)
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz NULL,
  last_used_ip inet NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz NULL,
  UNIQUE (principal_id, name),
  CHECK (expires_at > created_at)
);

CREATE TABLE login_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  surface text NOT NULL DEFAULT 'panel' CHECK (surface IN ('panel', 'api', 'webmail')),
  -- the name as typed; may not exist, so bounded instead of validated
  username text NOT NULL CHECK (xpanel_is_line(username, 128)),
  ip inet NOT NULL,
  success boolean NOT NULL,
  reason text NULL CHECK (reason ~ '^[a-z][a-z0-9-]{0,31}$')
);
CREATE INDEX login_attempts_username_idx ON login_attempts (lower(username), at);
CREATE INDEX login_attempts_ip_idx ON login_attempts (ip, at);

-- one active lock per username and per address
CREATE TABLE lockouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NULL CHECK (xpanel_is_line(username, 128)),
  ip inet NULL,
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  reason text NOT NULL DEFAULT '' CHECK (xpanel_is_line(reason, 255)),
  locked_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(username, ip) = 1)
);
CREATE UNIQUE INDEX lockouts_username_key ON lockouts (lower(username)) WHERE username IS NOT NULL;
CREATE UNIQUE INDEX lockouts_ip_key ON lockouts (ip) WHERE ip IS NOT NULL;

-- ---------------------------------------------------------------- resellers, plans

CREATE TABLE resellers (
  id uuid PRIMARY KEY,
  kind text NOT NULL DEFAULT 'reseller' CHECK (kind = 'reseller'),
  acl text[] NOT NULL DEFAULT '{}' CHECK (
    array_position(acl, NULL) IS NULL
    AND acl <@ ARRAY[
      'create-account', 'edit-account', 'suspend-account', 'terminate-account',
      'change-plan', 'manage-plans', 'manage-feature-lists', 'manage-dns',
      'manage-ssl', 'change-password', 'list-accounts', 'allow-unlimited-plans',
      'allow-oversell', 'transfer'
    ]::text[]
  ),
  max_accounts bigint NULL CHECK (max_accounts BETWEEN 0 AND 9007199254740991),
  total_disk_mb bigint NULL CHECK (total_disk_mb BETWEEN 0 AND 9007199254740991),
  total_bandwidth_mb bigint NULL CHECK (total_bandwidth_mb BETWEEN 0 AND 9007199254740991),
  oversell boolean NOT NULL DEFAULT false,
  nameservers text[] NOT NULL DEFAULT '{}' CHECK (
    cardinality(nameservers) <= 8
    AND xpanel_all_match(nameservers, '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$')
  ),
  -- single hosts, never networks
  delegated_ips inet[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(delegated_ips) <= 4096 AND xpanel_all_hosts(delegated_ips)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (id, kind) REFERENCES principals (id, kind) ON DELETE CASCADE
);

CREATE TABLE feature_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (name ~ '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$'),
  -- NULL: owned by root
  owner_id uuid NULL REFERENCES resellers (id) ON DELETE CASCADE,
  disabled text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(disabled) <= 1024 AND xpanel_all_match(disabled, '^[a-z0-9][a-z0-9._-]{0,63}$')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX feature_lists_name_key
  ON feature_lists (coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

-- resource limits (slice) must be >= 1 when capped; plan caps may be 0 (= none allowed)
CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (name ~ '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$'),
  owner_id uuid NULL REFERENCES resellers (id) ON DELETE CASCADE,
  feature_list_id uuid NOT NULL REFERENCES feature_lists (id),
  disk_mb bigint NULL CHECK (disk_mb BETWEEN 1 AND 9007199254740991),
  bandwidth_mb_month bigint NULL CHECK (bandwidth_mb_month BETWEEN 1 AND 9007199254740991),
  io_read_bps bigint NULL CHECK (io_read_bps BETWEEN 1 AND 9007199254740991),
  io_write_bps bigint NULL CHECK (io_write_bps BETWEEN 1 AND 9007199254740991),
  io_read_iops bigint NULL CHECK (io_read_iops BETWEEN 1 AND 9007199254740991),
  io_write_iops bigint NULL CHECK (io_write_iops BETWEEN 1 AND 9007199254740991),
  memory_mb bigint NULL CHECK (memory_mb BETWEEN 1 AND 9007199254740991),
  max_processes bigint NULL CHECK (max_processes BETWEEN 1 AND 9007199254740991),
  cpu_percent bigint NULL CHECK (cpu_percent BETWEEN 1 AND 9007199254740991),
  addon_domains bigint NULL CHECK (addon_domains BETWEEN 0 AND 9007199254740991),
  alias_domains bigint NULL CHECK (alias_domains BETWEEN 0 AND 9007199254740991),
  subdomains bigint NULL CHECK (subdomains BETWEEN 0 AND 9007199254740991),
  mailboxes bigint NULL CHECK (mailboxes BETWEEN 0 AND 9007199254740991),
  forwarders bigint NULL CHECK (forwarders BETWEEN 0 AND 9007199254740991),
  mailing_lists bigint NULL CHECK (mailing_lists BETWEEN 0 AND 9007199254740991),
  ftp_accounts bigint NULL CHECK (ftp_accounts BETWEEN 0 AND 9007199254740991),
  databases bigint NULL CHECK (databases BETWEEN 0 AND 9007199254740991),
  php_workers bigint NULL CHECK (php_workers BETWEEN 1 AND 9007199254740991),
  dedicated_ip boolean NOT NULL DEFAULT false,
  shell text NOT NULL DEFAULT 'none' CHECK (shell IN ('none', 'jailed')),
  default_mailbox_quota_mb bigint NULL CHECK (default_mailbox_quota_mb BETWEEN 1 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX plans_name_key
  ON plans (coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
CREATE INDEX plans_feature_list_idx ON plans (feature_list_id);

-- ---------------------------------------------------------------- accounts

-- Account UIDs (and their private GIDs): 20000..60000, handed out once and
-- never reused. 60000 is core's MAX_ACCOUNT_UID (login.defs UID_MAX); above it
-- sit systemd's reserved ranges, nobody (65534) and the 16-bit -1.
CREATE SEQUENCE xpanel_uid_seq AS integer START WITH 20000 MINVALUE 20000 MAXVALUE 60000 NO CYCLE;

-- every UID ever handed out; rows are never updated or deleted, so a number
-- cannot come back even after its account is gone
CREATE TABLE uid_allocator (
  uid integer PRIMARY KEY DEFAULT nextval('xpanel_uid_seq') CHECK (uid BETWEEN 20000 AND 60000),
  username text NOT NULL CHECK (username ~ '^[a-z][a-z0-9]{0,15}$'),
  allocated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (uid, username)
);
CREATE TRIGGER uid_allocator_append_only BEFORE UPDATE OR DELETE ON uid_allocator
  FOR EACH ROW EXECUTE FUNCTION xpanel_reject_change();
CREATE TRIGGER uid_allocator_no_truncate BEFORE TRUNCATE ON uid_allocator
  FOR EACH STATEMENT EXECUTE FUNCTION xpanel_reject_change();

CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL CHECK (username ~ '^[a-z][a-z0-9]{0,15}$'),
  uid integer NOT NULL UNIQUE,
  -- private group with the same number as the user
  gid integer NOT NULL UNIQUE CHECK (gid = uid),
  home text NOT NULL UNIQUE CHECK (xpanel_is_abs_path(home) AND right(home, length(username) + 1) = '/' || username),
  primary_domain text NOT NULL CHECK (xpanel_is_hostname(primary_domain)),
  plan_id uuid NOT NULL REFERENCES plans (id),
  -- NULL: owned by root. A reseller that still owns accounts cannot be deleted.
  owner_id uuid NULL REFERENCES resellers (id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'terminating')),
  suspend_reason text NULL CHECK (xpanel_is_line(suspend_reason, 512)),
  suspended_at timestamptz NULL,
  contact_email text NOT NULL CHECK (xpanel_is_email(contact_email)),
  ipv4 inet NOT NULL CHECK (family(ipv4) = 4 AND masklen(ipv4) = 32),
  shell text NOT NULL DEFAULT 'none' CHECK (shell IN ('none', 'jailed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- target of principals (account_id, username): an owner login carries its account's name
  UNIQUE (id, username),
  FOREIGN KEY (uid, username) REFERENCES uid_allocator (uid, username),
  CHECK (status = 'suspended' OR (suspend_reason IS NULL AND suspended_at IS NULL)),
  CHECK (status <> 'suspended' OR suspended_at IS NOT NULL)
);
CREATE UNIQUE INDEX accounts_username_key ON accounts (lower(username));
CREATE UNIQUE INDEX accounts_primary_domain_key ON accounts (lower(primary_domain));
CREATE INDEX accounts_owner_idx ON accounts (owner_id);
CREATE INDEX accounts_plan_idx ON accounts (plan_id);

ALTER TABLE principals ADD CONSTRAINT principals_account_fkey
  FOREIGN KEY (account_id, username) REFERENCES accounts (id, username) ON DELETE CASCADE;

-- ---------------------------------------------------------------- web

CREATE TABLE certificates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL: server certificate (hostname, panel)
  account_id uuid NULL REFERENCES accounts (id) ON DELETE CASCADE,
  names text[] NOT NULL CHECK (
    cardinality(names) BETWEEN 1 AND 100
    AND xpanel_all_match(names, '^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$')
  ),
  source text NOT NULL CHECK (source IN ('acme', 'upload', 'self-signed')),
  challenge text NULL CHECK (challenge IN ('http-01', 'dns-01')),
  not_before timestamptz NULL,
  not_after timestamptz NOT NULL,
  auto_renew boolean NOT NULL DEFAULT false,
  -- file locations only: certificate and key material stay on disk (key 0600, root)
  cert_path text NOT NULL CHECK (xpanel_is_abs_path(cert_path)),
  key_path text NOT NULL CHECK (xpanel_is_abs_path(key_path)),
  chain_path text NULL CHECK (xpanel_is_abs_path(chain_path)),
  fingerprint_sha256 text NULL CHECK (fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  last_error text NULL CHECK (length(last_error) <= 4000),
  renewed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((source = 'acme') = (challenge IS NOT NULL)),
  CHECK (source = 'acme' OR NOT auto_renew),
  -- ACME proves wildcard names only over DNS
  CHECK (challenge IS DISTINCT FROM 'http-01' OR array_to_string(names, ' ') NOT LIKE '%*%'),
  CHECK (not_before IS NULL OR not_before < not_after)
);
CREATE INDEX certificates_account_idx ON certificates (account_id);
CREATE INDEX certificates_not_after_idx ON certificates (not_after);

CREATE TABLE domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (xpanel_is_hostname(name)),
  kind text NOT NULL CHECK (kind IN ('primary', 'addon', 'alias', 'subdomain')),
  parent_id uuid NULL,
  -- strictly inside the account home (trigger below), never a hidden directory
  doc_root text NOT NULL CHECK (xpanel_is_abs_path(doc_root) AND doc_root !~ '/\.'),
  site_type text NOT NULL DEFAULT 'php' CHECK (site_type IN ('php', 'static', 'proxy', 'node', 'python')),
  upstream text NULL CHECK (
    length(upstream) <= 512
    AND upstream ~ '^https?://([a-z0-9.-]+|\[[0-9a-f:]+\])(:[0-9]{1,5})?(/[A-Za-z0-9._~%/-]*)?$'
  ),
  redirect_to text NULL CHECK (
    length(redirect_to) <= 2048
    AND redirect_to ~ '^https?://[^/]'
    AND redirect_to !~ '[[:space:][:cntrl:]"''<>{}|^`;]'
    AND strpos(redirect_to, chr(92)) = 0
  ),
  redirect_code smallint NULL CHECK (redirect_code IN (301, 302)),
  php jsonb NOT NULL CHECK (
    jsonb_typeof(php) = 'object'
    AND php ->> 'version' ~ '^[0-9]{1,2}\.[0-9]{1,2}$'
    AND php ->> 'handler' IN ('fpm', 'cgi', 'suphp', 'lsphp')
    AND jsonb_typeof(php -> 'fpm') = 'object'
    AND jsonb_typeof(php -> 'ini') = 'object'
  ),
  -- serves *.name (DNS * record + ServerAlias); explicit subdomains win
  wildcard boolean NOT NULL DEFAULT false,
  certificate_id uuid NULL REFERENCES certificates (id) ON DELETE SET NULL,
  suspended boolean NOT NULL DEFAULT false,
  expires_at timestamptz NULL,
  path_quota_mb bigint NULL CHECK (path_quota_mb BETWEEN 1 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id),
  -- a parent always belongs to the same account
  FOREIGN KEY (parent_id, account_id) REFERENCES domains (id, account_id) ON DELETE CASCADE,
  CHECK ((kind IN ('primary', 'addon')) = (parent_id IS NULL)),
  CHECK (parent_id IS NULL OR parent_id <> id),
  CHECK ((site_type IN ('proxy', 'node', 'python')) = (upstream IS NOT NULL)),
  CHECK ((redirect_to IS NULL) = (redirect_code IS NULL))
);
-- server-wide and case-insensitive: one vhost per name
CREATE UNIQUE INDEX domains_name_key ON domains (lower(name));
CREATE UNIQUE INDEX domains_one_primary_key ON domains (account_id) WHERE kind = 'primary';
CREATE INDEX domains_account_idx ON domains (account_id);
CREATE INDEX domains_parent_idx ON domains (parent_id);
CREATE INDEX domains_certificate_idx ON domains (certificate_id);

CREATE FUNCTION xpanel_check_doc_root() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  acct_home text;
BEGIN
  SELECT home INTO acct_home FROM accounts WHERE id = NEW.account_id;
  IF acct_home IS NOT NULL AND left(NEW.doc_root, length(acct_home) + 1) <> acct_home || '/' THEN
    RAISE EXCEPTION 'domains.doc_root must be inside the account home' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER domains_doc_root_in_home BEFORE INSERT OR UPDATE OF doc_root, account_id ON domains
  FOR EACH ROW EXECUTE FUNCTION xpanel_check_doc_root();

-- a vhost only loads a certificate (and its key) of its own account
CREATE FUNCTION xpanel_check_domain_certificate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.certificate_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM certificates WHERE id = NEW.certificate_id AND account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'domains.certificate_id must be a certificate of the same account' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER domains_certificate_same_account BEFORE INSERT OR UPDATE OF certificate_id, account_id ON domains
  FOR EACH ROW EXECUTE FUNCTION xpanel_check_domain_certificate();

-- mail / FTP / WebDisk logins; credentials on the account UID, never a panel principal
CREATE TABLE service_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- login is local_part@<domain name>, so a domain rename carries its users
  domain_id uuid NOT NULL,
  -- core validateEmailLocalPart: no '+' (the recipient delimiter), no '..'
  local_part text NOT NULL CHECK (local_part ~ '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9_-])?$' AND local_part !~ '\.\.'),
  -- scheme-tagged hash for dovecot/ftp passwd files: no ':' or whitespace
  password_hash text NOT NULL CHECK (length(password_hash) BETWEEN 1 AND 512 AND password_hash !~ '[[:space:][:cntrl:]:]'),
  email boolean NOT NULL DEFAULT false,
  ftp boolean NOT NULL DEFAULT false,
  webdisk boolean NOT NULL DEFAULT false,
  mailbox_quota_mb bigint NULL CHECK (mailbox_quota_mb BETWEEN 1 AND 9007199254740991),
  -- relative to the home; never a hidden directory such as .ssh
  ftp_dir text NOT NULL DEFAULT '' CHECK (xpanel_is_rel_path(ftp_dir) AND ftp_dir !~ '(^|/)\.'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (domain_id, account_id) REFERENCES domains (id, account_id) ON DELETE CASCADE,
  CHECK (email OR ftp OR webdisk)
);
CREATE UNIQUE INDEX service_users_login_key ON service_users (domain_id, local_part);
CREATE INDEX service_users_account_idx ON service_users (account_id);

-- ---------------------------------------------------------------- databases

CREATE TABLE databases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  engine text NOT NULL DEFAULT 'mariadb' CHECK (engine = 'mariadb'),
  -- "<username>_<suffix>"; the prefix is checked against the owner by trigger
  name text NOT NULL CHECK (length(name) <= 64 AND name ~ '^[a-z][a-z0-9]{0,15}_[a-z0-9][a-z0-9_]*$'),
  -- set when moved to the MariaDB trash; dropped after retention
  trashed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id)
);
CREATE UNIQUE INDEX databases_name_key ON databases (name);
CREATE INDEX databases_account_idx ON databases (account_id);

CREATE TABLE database_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- 32: MySQL-compatible user name limit, so dumps restore on either server
  name text NOT NULL CHECK (length(name) <= 32 AND name ~ '^[a-z][a-z0-9]{0,15}_[a-z0-9][a-z0-9_]*$'),
  -- MariaDB authentication string (hash), applied with IDENTIFIED VIA ... USING; never plaintext
  auth_plugin text NOT NULL DEFAULT 'mysql_native_password' CHECK (auth_plugin IN ('mysql_native_password', 'ed25519')),
  auth_string text NOT NULL CHECK (auth_string ~ '^[A-Za-z0-9*+/=]{1,128}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id)
);
CREATE UNIQUE INDEX database_users_name_key ON database_users (name);
CREATE INDEX database_users_account_idx ON database_users (account_id);

-- composite keys pin both sides of a grant to the same account
CREATE TABLE database_grants (
  database_user_id uuid NOT NULL,
  database_id uuid NOT NULL,
  account_id uuid NOT NULL,
  privileges text[] NOT NULL CHECK (
    cardinality(privileges) BETWEEN 1 AND 32
    AND array_position(privileges, NULL) IS NULL
    AND privileges <@ ARRAY[
      'ALL PRIVILEGES', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP',
      'INDEX', 'ALTER', 'CREATE TEMPORARY TABLES', 'LOCK TABLES', 'EXECUTE',
      'CREATE VIEW', 'SHOW VIEW', 'CREATE ROUTINE', 'ALTER ROUTINE', 'EVENT',
      'TRIGGER', 'REFERENCES'
    ]::text[]
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (database_user_id, database_id),
  FOREIGN KEY (database_user_id, account_id) REFERENCES database_users (id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (database_id, account_id) REFERENCES databases (id, account_id) ON DELETE CASCADE
);
CREATE INDEX database_grants_database_idx ON database_grants (database_id);

CREATE FUNCTION xpanel_check_db_prefix() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  acct_username text;
BEGIN
  SELECT username INTO acct_username FROM accounts WHERE id = NEW.account_id;
  IF acct_username IS NOT NULL AND split_part(NEW.name, '_', 1) <> acct_username THEN
    RAISE EXCEPTION '%.name must start with "%_"', TG_TABLE_NAME, acct_username
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER databases_name_prefix BEFORE INSERT OR UPDATE OF name, account_id ON databases
  FOR EACH ROW EXECUTE FUNCTION xpanel_check_db_prefix();
CREATE TRIGGER database_users_name_prefix BEFORE INSERT OR UPDATE OF name, account_id ON database_users
  FOR EACH ROW EXECUTE FUNCTION xpanel_check_db_prefix();

-- ---------------------------------------------------------------- dns

CREATE TABLE dns_zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL: server zone (hostname, nameservers)
  account_id uuid NULL REFERENCES accounts (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (xpanel_is_hostname(name)),
  serial bigint NOT NULL DEFAULT 1 CHECK (serial BETWEEN 1 AND 4294967295),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX dns_zones_name_key ON dns_zones (lower(name));
CREATE INDEX dns_zones_account_idx ON dns_zones (account_id);

CREATE TABLE dns_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id uuid NOT NULL REFERENCES dns_zones (id) ON DELETE CASCADE,
  -- relative name: '@' apex, '*' wildcard, or labels (optionally under '*.')
  name text NOT NULL CHECK (
    length(name) <= 253
    AND name ~ '^(@|\*|(\*\.)?[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*)$'
  ),
  type text NOT NULL CHECK (type IN ('A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA')),
  ttl integer NOT NULL DEFAULT 14400 CHECK (ttl BETWEEN 0 AND 2147483647),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 4096 AND content !~ '[[:cntrl:]]'),
  priority integer NULL CHECK (priority BETWEEN 0 AND 65535),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((type IN ('MX', 'SRV')) = (priority IS NOT NULL)),
  CHECK (CASE type
    WHEN 'A' THEN content ~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
    WHEN 'AAAA' THEN content ~ '^[0-9a-f:.]{2,45}$'
    ELSE true
  END)
);
CREATE INDEX dns_records_zone_idx ON dns_records (zone_id, name, type);

-- ---------------------------------------------------------------- security

-- operator-uploaded CIDR lists referenced by prefix-list rules (nftables sets)
CREATE TABLE firewall_prefix_lists (
  name text PRIMARY KEY CHECK (name ~ '^[a-z][a-z0-9_]{0,23}$'),
  entries cidr[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(entries) <= 65536 AND array_position(entries, NULL) IS NULL),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Evaluated top-down by sort_order (first match wins); forwards are DNAT and win
-- wherever they sit. Ids are text so the default rules and JSON imports keep theirs.
CREATE TABLE firewall_rules (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  kind text NOT NULL CHECK (kind IN ('port', 'ip', 'forward', 'icmp', 'prefix-list')),
  action text NOT NULL CHECK (action IN ('accept', 'drop', 'reject')),
  protocol text NULL CHECK (protocol IN ('tcp', 'udp', 'both')),
  port text NULL CHECK (xpanel_is_port_spec(port)),
  -- cidr refuses host bits right of the mask
  source cidr NULL,
  -- for kind = 'forward': "a.b.c.d:port" or "[v6]:port"
  forward_to text NULL
    CHECK (length(forward_to) <= 64 AND forward_to ~ '^([0-9]{1,3}(\.[0-9]{1,3}){3}|\[[0-9A-Fa-f:.]+\]):[1-9][0-9]{0,4}$'),
  list text NULL REFERENCES firewall_prefix_lists (name),
  -- nftables keeps 128 bytes of comment and has no escape syntax
  comment text NOT NULL DEFAULT '' CHECK (octet_length(comment) <= 128 AND comment !~ '[[:cntrl:]"\$<>{}|^~`]'),
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL CHECK (sort_order >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- deferred so a reorder can renumber every row in one transaction
  CONSTRAINT firewall_rules_sort_order_key UNIQUE (sort_order) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((kind = 'forward') = (forward_to IS NOT NULL)),
  CHECK ((kind = 'prefix-list') = (list IS NOT NULL)),
  CHECK (kind NOT IN ('port', 'forward') OR port IS NOT NULL),
  CHECK (kind <> 'forward' OR (action = 'accept' AND strpos(port, '-') = 0)),
  CHECK (kind <> 'ip' OR source IS NOT NULL),
  CHECK (kind <> 'prefix-list' OR source IS NULL),
  CHECK (kind <> 'icmp' OR (port IS NULL AND protocol IS NULL)),
  CHECK (port IS NULL OR protocol IS NOT NULL)
);

-- exactly one row (id = 1), written by the first-login wizard
CREATE TABLE server_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  hostname text NOT NULL CHECK (xpanel_is_hostname(hostname)),
  nameservers text[] NOT NULL DEFAULT '{}' CHECK (
    cardinality(nameservers) <= 8
    AND xpanel_all_match(nameservers, '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$')
  ),
  admin_email text NOT NULL CHECK (xpanel_is_email(admin_email)),
  engine text NOT NULL DEFAULT 'apache' CHECK (engine IN ('apache', 'openlitespeed')),
  apache_mpm text NOT NULL DEFAULT 'itk' CHECK (apache_mpm IN ('itk', 'prefork')),
  panel_port integer NOT NULL CHECK (panel_port BETWEEN 1 AND 65535),
  ssh_port integer NOT NULL DEFAULT 22 CHECK (ssh_port BETWEEN 1 AND 65535),
  -- NULL means "auto" (one worker per core), mapped explicitly like Limit
  nginx_worker_processes integer NULL CHECK (nginx_worker_processes BETWEEN 1 AND 1024),
  nginx_worker_connections integer NOT NULL CHECK (nginx_worker_connections BETWEEN 64 AND 1048576),
  nginx_worker_rlimit_nofile integer NOT NULL CHECK (nginx_worker_rlimit_nofile BETWEEN 1 AND 1048576),
  nginx_multi_accept boolean NOT NULL DEFAULT false,
  nginx_keepalive_timeout_sec integer NOT NULL CHECK (nginx_keepalive_timeout_sec BETWEEN 0 AND 3600),
  apache_start_servers integer NOT NULL CHECK (apache_start_servers BETWEEN 1 AND 20000),
  apache_min_spare_servers integer NOT NULL CHECK (apache_min_spare_servers BETWEEN 1 AND 20000),
  apache_max_spare_servers integer NOT NULL CHECK (apache_max_spare_servers BETWEEN 1 AND 20000),
  apache_max_request_workers integer NOT NULL CHECK (apache_max_request_workers BETWEEN 1 AND 20000),
  -- Apache semantics: 0 = children are never recycled
  apache_max_connections_per_child integer NOT NULL CHECK (apache_max_connections_per_child BETWEEN 0 AND 100000000),
  apache_server_limit integer NOT NULL CHECK (apache_server_limit BETWEEN 1 AND 20000),
  backend_port integer NOT NULL CHECK (backend_port BETWEEN 1 AND 65535),
  backend_tls_port integer NOT NULL CHECK (backend_tls_port BETWEEN 1 AND 65535),
  setup_completed_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- core apacheWorkerErrors / nginxWorkerErrors, repeated as a second line
  CHECK (nginx_worker_rlimit_nofile >= 2 * nginx_worker_connections),
  CHECK (apache_min_spare_servers < apache_max_spare_servers),
  CHECK (apache_start_servers BETWEEN apache_min_spare_servers AND apache_max_spare_servers),
  CHECK (apache_max_spare_servers <= apache_max_request_workers),
  CHECK (apache_max_request_workers <= apache_server_limit),
  CHECK (
    panel_port NOT IN (ssh_port, backend_port, backend_tls_port, 80, 443)
    AND ssh_port NOT IN (backend_port, backend_tls_port, 80, 443)
    AND backend_port NOT IN (backend_tls_port, 80, 443)
    AND backend_tls_port NOT IN (80, 443)
  )
);

-- ---------------------------------------------------------------- scheduling, backups

CREATE TABLE cron_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  schedule text NOT NULL CHECK (xpanel_is_cron_schedule(schedule)),
  -- runs as the account UID inside its slice; one line, no control characters
  command text NOT NULL CHECK (length(command) >= 1 AND xpanel_is_line(command, 4096)),
  comment text NOT NULL DEFAULT '' CHECK (xpanel_is_line(comment, 255)),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cron_jobs_account_idx ON cron_jobs (account_id);

CREATE TABLE backup_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL: server-wide job (xWHM)
  account_id uuid NULL REFERENCES accounts (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name ~ '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$'),
  schedule text NOT NULL CHECK (xpanel_is_cron_schedule(schedule)),
  scope text NOT NULL CHECK (scope IN ('full', 'home', 'databases', 'mail-filters')),
  destination text NOT NULL CHECK (destination IN ('account-dir', 'remote')),
  -- name of a remote target configured on the host; credentials never live here
  remote_target text NULL CHECK (remote_target ~ '^[a-z][a-z0-9_-]{0,31}$'),
  retention integer NOT NULL DEFAULT 7 CHECK (retention BETWEEN 1 AND 365),
  enabled boolean NOT NULL DEFAULT true,
  last_run_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((destination = 'remote') = (remote_target IS NOT NULL))
);
CREATE INDEX backup_jobs_account_idx ON backup_jobs (account_id);

CREATE TABLE backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- kept after the account is gone so it can still be restored
  account_id uuid NULL REFERENCES accounts (id) ON DELETE SET NULL,
  account_username text NULL CHECK (account_username ~ '^[a-z][a-z0-9]{0,15}$'),
  job_id uuid NULL REFERENCES backup_jobs (id) ON DELETE SET NULL,
  scope text NOT NULL CHECK (scope IN ('full', 'home', 'databases', 'mail-filters')),
  destination text NOT NULL CHECK (destination IN ('download', 'account-dir', 'remote')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'expired')),
  location text NULL CHECK (xpanel_is_line(location, 1024)),
  size_bytes bigint NULL CHECK (size_bytes BETWEEN 0 AND 9007199254740991),
  sha256 text NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  error text NULL CHECK (length(error) <= 4000),
  requested_by text NOT NULL CHECK (length(requested_by) >= 1 AND xpanel_is_line(requested_by, 255)),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NULL,
  finished_at timestamptz NULL,
  CHECK (status <> 'succeeded' OR (location IS NOT NULL AND finished_at IS NOT NULL)),
  CHECK (status <> 'failed' OR error IS NOT NULL)
);
CREATE INDEX backups_account_idx ON backups (account_id, created_at);

-- ---------------------------------------------------------------- transfers

CREATE TABLE transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind text NOT NULL CHECK (source_kind IN ('xpanel-remote', 'xpanel-archive', 'cpanel-archive')),
  source_host text NULL CHECK (source_host ~ '^([a-z0-9.-]{1,253}|\[[0-9a-f:]+\])$'),
  source_port integer NULL CHECK (source_port BETWEEN 1 AND 65535),
  -- how the remote is reached; the key or token itself is never stored here
  auth_method text NULL CHECK (auth_method IN ('ssh-key', 'api-token')),
  archive_path text NULL CHECK (xpanel_is_abs_path(archive_path)),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'scanning', 'review', 'running', 'succeeded', 'failed', 'cancelled')),
  options jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(options) = 'object'),
  actor text NOT NULL CHECK (length(actor) >= 1 AND xpanel_is_line(actor, 255)),
  error text NULL CHECK (length(error) <= 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NULL,
  finished_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((source_kind = 'xpanel-remote') = (source_host IS NOT NULL)),
  CHECK ((source_kind = 'xpanel-remote') = (auth_method IS NOT NULL)),
  CHECK ((source_kind = 'xpanel-remote') <> (archive_path IS NOT NULL)),
  CHECK (status <> 'failed' OR error IS NOT NULL)
);

CREATE TABLE transfer_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id uuid NOT NULL REFERENCES transfers (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('account', 'plan', 'reseller', 'feature-list')),
  source_name text NOT NULL CHECK (length(source_name) >= 1 AND xpanel_is_line(source_name, 255)),
  target_name text NULL CHECK (length(target_name) >= 1 AND xpanel_is_line(target_name, 255)),
  account_id uuid NULL REFERENCES accounts (id) ON DELETE SET NULL,
  selected boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  progress smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  error text NULL CHECK (length(error) <= 4000),
  started_at timestamptz NULL,
  finished_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transfer_id, kind, source_name)
);

-- ---------------------------------------------------------------- panel lifecycle

CREATE TABLE upgrades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_version text NOT NULL CHECK (xpanel_is_semver(from_version)),
  to_version text NOT NULL CHECK (xpanel_is_semver(to_version)),
  -- control-schema version, independent of the product version
  from_schema_version integer NULL CHECK (from_schema_version >= 0),
  to_schema_version integer NULL CHECK (to_schema_version >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'rolled_back')),
  phase text NULL CHECK (phase IN ('precheck', 'snapshot', 'stage', 'migrate', 'switch', 'health-check', 'rollback')),
  health_report jsonb NULL CHECK (jsonb_typeof(health_report) = 'object'),
  snapshot_path text NULL CHECK (xpanel_is_abs_path(snapshot_path)),
  error text NULL CHECK (length(error) <= 16000),
  actor text NOT NULL CHECK (length(actor) >= 1 AND xpanel_is_line(actor, 255)),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NULL,
  finished_at timestamptz NULL,
  CHECK (from_version <> to_version),
  CHECK (status IN ('pending', 'running') OR finished_at IS NOT NULL),
  CHECK (status NOT IN ('failed', 'rolled_back') OR error IS NOT NULL)
);
-- at most one upgrade in flight; the next one starts only from a settled state
CREATE UNIQUE INDEX upgrades_one_in_flight_key ON upgrades ((true)) WHERE status IN ('pending', 'running');
CREATE INDEX upgrades_created_idx ON upgrades (created_at);

-- superseded: was active, replaced by a newer generation (rollback target)
CREATE TABLE config_generations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'tested', 'active', 'superseded', 'failed', 'rolled_back')),
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  error text NULL CHECK (length(error) <= 16000),
  actor text NOT NULL DEFAULT 'system' CHECK (length(actor) >= 1 AND xpanel_is_line(actor, 255)),
  tested_at timestamptz NULL,
  activated_at timestamptz NULL,
  CHECK (status NOT IN ('failed', 'rolled_back') OR error IS NOT NULL),
  CHECK (status NOT IN ('tested', 'active', 'superseded', 'rolled_back') OR tested_at IS NOT NULL),
  CHECK (status NOT IN ('active', 'superseded', 'rolled_back') OR activated_at IS NOT NULL)
);
CREATE UNIQUE INDEX config_generations_one_active_key ON config_generations (status) WHERE status = 'active';

CREATE FUNCTION xpanel_generation_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.checksum <> OLD.checksum OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'config generation % is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.status = 'pending' AND NEW.status IN ('tested', 'failed'))
    OR (OLD.status = 'tested' AND NEW.status IN ('active', 'failed'))
    OR (OLD.status = 'active' AND NEW.status IN ('superseded', 'rolled_back'))
    OR (OLD.status = 'superseded' AND NEW.status = 'active')
  ) THEN
    RAISE EXCEPTION 'config generation % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER config_generations_transition BEFORE UPDATE ON config_generations
  FOR EACH ROW EXECUTE FUNCTION xpanel_generation_transition();

-- append-only: a trigger rejects UPDATE, DELETE and TRUNCATE
CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL CHECK (length(actor) >= 1 AND xpanel_is_line(actor, 255)),
  -- no foreign key: entries outlive the principal they mention
  principal_id uuid NULL,
  ip inet NULL,
  -- a code-defined verb such as account.suspend (core auditEntry)
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.:-]{0,127}$'),
  target text NOT NULL CHECK (xpanel_is_line(target, 512)),
  detail jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(detail) = 'object'),
  outcome text NOT NULL CHECK (outcome IN ('ok', 'denied', 'failed'))
);
CREATE INDEX audit_log_at_idx ON audit_log (at);
CREATE INDEX audit_log_actor_idx ON audit_log (actor, at);
CREATE INDEX audit_log_target_idx ON audit_log (target, at);
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION xpanel_reject_change();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION xpanel_reject_change();

-- files moved to the account trash (inside the home, so they count against quota)
CREATE TABLE trash_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- both relative to the account home
  original_path text NOT NULL CHECK (xpanel_is_user_path(original_path)),
  trash_path text NOT NULL CHECK (xpanel_is_user_path(trash_path)),
  is_dir boolean NOT NULL DEFAULT false,
  size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes BETWEEN 0 AND 9007199254740991),
  deleted_at timestamptz NOT NULL DEFAULT now(),
  purge_after timestamptz NOT NULL,
  restored_at timestamptz NULL,
  CHECK (purge_after > deleted_at)
);
CREATE UNIQUE INDEX trash_items_path_key ON trash_items (account_id, trash_path);
CREATE INDEX trash_items_purge_idx ON trash_items (purge_after) WHERE restored_at IS NULL;

-- services installed on this host from the service catalog
CREATE TABLE service_catalog (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9.+_-]{0,63}$'),
  role text NOT NULL CHECK (role ~ '^[a-z][a-z0-9-]{0,31}$'),
  version text NULL CHECK (version ~ '^[0-9A-Za-z.+:~_-]{1,64}$'),
  status text NOT NULL CHECK (status IN ('installing', 'installed', 'failed', 'removing')),
  packages text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(packages) <= 256 AND xpanel_all_match(packages, '^[A-Za-z0-9][A-Za-z0-9.+_:-]{0,127}$')),
  detail jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(detail) = 'object'),
  installed_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- updated_at

CREATE TRIGGER principals_touch BEFORE UPDATE ON principals FOR EACH ROW EXECUTE FUNCTION xpanel_touch_updated_at();
CREATE TRIGGER resellers_touch BEFORE UPDATE ON resellers FOR EACH ROW EXECUTE FUNCTION xpanel_touch_updated_at();
CREATE TRIGGER feature_lists_touch BEFORE UPDATE ON feature_lists FOR EACH ROW EXECUTE FUNCTION xpanel_touch_updated_at();
CREATE TRIGGER plans_touch BEFORE UPDATE ON plans FOR EACH ROW EXECUTE FUNCTION xpanel_touch_updated_at();
CREATE TRIGGER accounts_touch BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION xpanel_touch_updated_at();
CREATE TRIGGER certificates_touch BEFORE UPDATE ON certificates FOR EACH ROW EXECUTE FUNCTION xpanel_touch_updated_at();
CREATE TRIGGER domains_touch BEFORE UPDATE ON domains FOR EACH ROW EXECUTE FUNCTION xpanel_touch_updated_at();
CREATE TRIGGER service_users_touch BEFORE UPDATE ON service_users FOR EACH ROW EXECUTE FUNCTION xpanel_touch_updated_at();
CREATE TRIGGER database_users_touch BEFORE UPDATE ON database_users FOR EACH ROW EXECUTE FUNCTION xpanel_touch_updated_at();
CREATE TRIGGER dns_zones_touch BEFORE UPDATE ON dns_zones FOR EACH ROW EXECUTE FUNCTION xpanel_touch_updated_at();
CREATE TRIGGER dns_records_touch BEFORE UPDATE ON dns_records FOR EACH ROW EXECUTE FUNCTION xpanel_touch_updated_at();
CREATE TRIGGER firewall_prefix_lists_touch BEFORE UPDATE ON firewall_prefix_lists FOR EACH ROW EXECUTE FUNCTION xpanel_touch_updated_at();
CREATE TRIGGER firewall_rules_touch BEFORE UPDATE ON firewall_rules FOR EACH ROW EXECUTE FUNCTION xpanel_touch_updated_at();
CREATE TRIGGER server_settings_touch BEFORE UPDATE ON server_settings FOR EACH ROW EXECUTE FUNCTION xpanel_touch_updated_at();
CREATE TRIGGER cron_jobs_touch BEFORE UPDATE ON cron_jobs FOR EACH ROW EXECUTE FUNCTION xpanel_touch_updated_at();
CREATE TRIGGER backup_jobs_touch BEFORE UPDATE ON backup_jobs FOR EACH ROW EXECUTE FUNCTION xpanel_touch_updated_at();
CREATE TRIGGER transfers_touch BEFORE UPDATE ON transfers FOR EACH ROW EXECUTE FUNCTION xpanel_touch_updated_at();
CREATE TRIGGER transfer_items_touch BEFORE UPDATE ON transfer_items FOR EACH ROW EXECUTE FUNCTION xpanel_touch_updated_at();
CREATE TRIGGER service_catalog_touch BEFORE UPDATE ON service_catalog FOR EACH ROW EXECUTE FUNCTION xpanel_touch_updated_at();

-- ---------------------------------------------------------------- reconciler wake-up

-- Statement-level and inside the writing transaction, so the notification is
-- delivered on commit and dropped on rollback; Postgres folds identical
-- notifications of one transaction into one. The payload (table name) is a
-- hint only: the agent re-reads the tables and reconciles fully.
CREATE FUNCTION xpanel_notify_desired_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('xpanel_desired_state', TG_TABLE_NAME);
  RETURN NULL;
END
$$;

CREATE TRIGGER principals_notify AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON principals FOR EACH STATEMENT EXECUTE FUNCTION xpanel_notify_desired_state();
CREATE TRIGGER resellers_notify AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON resellers FOR EACH STATEMENT EXECUTE FUNCTION xpanel_notify_desired_state();
CREATE TRIGGER plans_notify AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON plans FOR EACH STATEMENT EXECUTE FUNCTION xpanel_notify_desired_state();
CREATE TRIGGER accounts_notify AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON accounts FOR EACH STATEMENT EXECUTE FUNCTION xpanel_notify_desired_state();
CREATE TRIGGER certificates_notify AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON certificates FOR EACH STATEMENT EXECUTE FUNCTION xpanel_notify_desired_state();
CREATE TRIGGER domains_notify AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON domains FOR EACH STATEMENT EXECUTE FUNCTION xpanel_notify_desired_state();
CREATE TRIGGER service_users_notify AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON service_users FOR EACH STATEMENT EXECUTE FUNCTION xpanel_notify_desired_state();
CREATE TRIGGER databases_notify AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON databases FOR EACH STATEMENT EXECUTE FUNCTION xpanel_notify_desired_state();
CREATE TRIGGER database_users_notify AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON database_users FOR EACH STATEMENT EXECUTE FUNCTION xpanel_notify_desired_state();
CREATE TRIGGER database_grants_notify AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON database_grants FOR EACH STATEMENT EXECUTE FUNCTION xpanel_notify_desired_state();
CREATE TRIGGER dns_zones_notify AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON dns_zones FOR EACH STATEMENT EXECUTE FUNCTION xpanel_notify_desired_state();
CREATE TRIGGER dns_records_notify AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON dns_records FOR EACH STATEMENT EXECUTE FUNCTION xpanel_notify_desired_state();
CREATE TRIGGER firewall_prefix_lists_notify AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON firewall_prefix_lists FOR EACH STATEMENT EXECUTE FUNCTION xpanel_notify_desired_state();
CREATE TRIGGER firewall_rules_notify AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON firewall_rules FOR EACH STATEMENT EXECUTE FUNCTION xpanel_notify_desired_state();
CREATE TRIGGER server_settings_notify AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON server_settings FOR EACH STATEMENT EXECUTE FUNCTION xpanel_notify_desired_state();
CREATE TRIGGER cron_jobs_notify AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON cron_jobs FOR EACH STATEMENT EXECUTE FUNCTION xpanel_notify_desired_state();
CREATE TRIGGER backup_jobs_notify AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON backup_jobs FOR EACH STATEMENT EXECUTE FUNCTION xpanel_notify_desired_state();
CREATE TRIGGER backups_notify AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON backups FOR EACH STATEMENT EXECUTE FUNCTION xpanel_notify_desired_state();
CREATE TRIGGER transfers_notify AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON transfers FOR EACH STATEMENT EXECUTE FUNCTION xpanel_notify_desired_state();
CREATE TRIGGER transfer_items_notify AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON transfer_items FOR EACH STATEMENT EXECUTE FUNCTION xpanel_notify_desired_state();
CREATE TRIGGER upgrades_notify AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON upgrades FOR EACH STATEMENT EXECUTE FUNCTION xpanel_notify_desired_state();
CREATE TRIGGER trash_items_notify AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON trash_items FOR EACH STATEMENT EXECUTE FUNCTION xpanel_notify_desired_state();
CREATE TRIGGER service_catalog_notify AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON service_catalog FOR EACH STATEMENT EXECUTE FUNCTION xpanel_notify_desired_state();
