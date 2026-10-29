-- One-time cross-panel handoff: xWHM "log in to xPanel" (account owner) and xPanel "open webmail" (mailbox).
-- Only the SHA-256 of the 256-bit link secret is stored; the secret itself is never persisted.
-- A row is consumed once, by its audience listener, before expires_at; expired rows are purged on use.
CREATE TABLE panel_handoffs (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  audience TEXT NOT NULL CHECK (audience IN ('xpanel', 'xmail')),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('account-owner', 'mailbox')),
  target_account_id TEXT NOT NULL CHECK (length(target_account_id) = 36),
  target_principal_id TEXT REFERENCES principals(id) ON DELETE CASCADE CHECK (target_principal_id IS NULL OR length(target_principal_id) = 36),
  target_service_user_id TEXT CHECK (target_service_user_id IS NULL OR length(target_service_user_id) = 36),
  target_mailbox TEXT CHECK (target_mailbox IS NULL OR (length(target_mailbox) BETWEEN 3 AND 254 AND instr(target_mailbox, '@') > 1 AND target_mailbox = lower(target_mailbox))),
  landing TEXT NOT NULL CHECK (landing IN ('home', 'calendar', 'contacts')),
  issuer_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE CHECK (length(issuer_principal_id) = 36),
  issuer_entry_point TEXT NOT NULL CHECK (issuer_entry_point IN ('xwhm', 'xpanel')),
  issuer_team_member_id TEXT CHECK (issuer_team_member_id IS NULL OR length(issuer_team_member_id) = 36),
  issuer_login TEXT NOT NULL CHECK (length(issuer_login) BETWEEN 1 AND 254),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  CHECK (
    (audience = 'xpanel' AND target_kind = 'account-owner' AND issuer_entry_point = 'xwhm' AND landing = 'home'
      AND target_principal_id IS NOT NULL AND target_service_user_id IS NULL AND target_mailbox IS NULL AND issuer_team_member_id IS NULL)
    OR (audience = 'xmail' AND target_kind = 'mailbox' AND issuer_entry_point = 'xpanel'
      AND target_principal_id IS NULL AND target_service_user_id IS NOT NULL AND target_mailbox IS NOT NULL)
  )
) STRICT;

CREATE INDEX panel_handoffs_expires_at_idx ON panel_handoffs (expires_at);

-- An impersonated session records the issuing identity, re-checked on every request; a team member issuer is the
-- owning account's principal plus its member id. Deleting the issuing principal ends the session.
ALTER TABLE sessions ADD COLUMN impersonator_principal_id TEXT REFERENCES principals(id) ON DELETE CASCADE
  CHECK (impersonator_principal_id IS NULL OR length(impersonator_principal_id) = 36);
ALTER TABLE sessions ADD COLUMN impersonator_login TEXT
  CHECK ((impersonator_login IS NULL) = (impersonator_principal_id IS NULL) AND (impersonator_login IS NULL OR length(impersonator_login) BETWEEN 1 AND 254));
ALTER TABLE sessions ADD COLUMN impersonator_team_member_id TEXT
  CHECK (impersonator_team_member_id IS NULL OR (impersonator_principal_id IS NOT NULL AND length(impersonator_team_member_id) = 36));

-- A handed-off mailbox session binds the mailbox without its password. Mailbox content that needs
-- IMAP authentication stays unavailable in such a session; nothing substitutes another credential.
CREATE TABLE handoff_mailbox_sessions (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE CHECK (length(session_id) = 36),
  mailbox TEXT NOT NULL CHECK (length(mailbox) BETWEEN 3 AND 254 AND instr(mailbox, '@') > 1),
  service_user_id TEXT NOT NULL CHECK (length(service_user_id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 36),
  created_at TEXT NOT NULL
) STRICT;
