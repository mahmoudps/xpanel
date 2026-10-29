-- Team member sign-in. Members, roles, status and expiry stay in accounts/team/<account>.json;
-- these rows only authenticate: an Argon2id credential, one pending single-use password link
-- (SHA-256 of the link secret, never the secret) and interactive sessions.
CREATE TABLE team_credentials (
  member_id TEXT PRIMARY KEY CHECK (length(member_id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  password_hash TEXT CHECK (password_hash IS NULL OR (
    length(password_hash) BETWEEN 30 AND 512 AND
    password_hash GLOB '$argon2id$v=19$*'
  )),
  password_set_at TEXT,
  link_hash TEXT UNIQUE CHECK (link_hash IS NULL OR (length(link_hash) = 64 AND link_hash NOT GLOB '*[^0-9a-f]*')),
  link_expires_at TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((password_hash IS NULL) = (password_set_at IS NULL)),
  CHECK ((link_hash IS NULL) = (link_expires_at IS NULL))
) STRICT;

CREATE INDEX team_credentials_account_id_idx ON team_credentials (account_id);

CREATE TABLE team_sessions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  member_id TEXT NOT NULL REFERENCES team_credentials(member_id) ON DELETE CASCADE,
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  owner_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  login TEXT NOT NULL CHECK (length(login) BETWEEN 3 AND 128 AND login = lower(login)),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  ip TEXT CHECK (ip IS NULL OR (length(ip) BETWEEN 2 AND 45)),
  user_agent TEXT CHECK (user_agent IS NULL OR length(user_agent) <= 512),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK (expires_at > created_at)
) STRICT;

CREATE INDEX team_sessions_member_id_idx ON team_sessions (member_id);
