CREATE TABLE mailbox_sessions (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE CHECK (length(session_id) = 36),
  mailbox TEXT NOT NULL CHECK (length(mailbox) BETWEEN 3 AND 254 AND instr(mailbox, '@') > 1),
  service_user_id TEXT NOT NULL CHECK (length(service_user_id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  sealed_password BLOB NOT NULL CHECK (length(sealed_password) BETWEEN 29 AND 1024),
  created_at TEXT NOT NULL
) STRICT;
