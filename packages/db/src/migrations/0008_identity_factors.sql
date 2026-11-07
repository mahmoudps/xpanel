-- Security questions for the verified-address sign-in policy: only Argon2id hashes of normalised answers are stored.
CREATE TABLE security_questions (
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE CHECK (length(principal_id) = 36),
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 5),
  question TEXT NOT NULL CHECK (length(question) BETWEEN 8 AND 200),
  answer_hash TEXT NOT NULL CHECK (length(answer_hash) BETWEEN 30 AND 512 AND answer_hash GLOB '$argon2id$v=19$*'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, position)
) STRICT;

-- Addresses a principal answered from or listed; an IPv4 entry may end in one '*' octet.
CREATE TABLE security_verified_ips (
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE CHECK (length(principal_id) = 36),
  address TEXT NOT NULL CHECK (length(address) BETWEEN 3 AND 45 AND address NOT GLOB '*[^0-9a-f.:*]*'),
  source TEXT NOT NULL CHECK (source IN ('answered', 'added')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, address)
) STRICT;

-- An OpenID Connect identity, linked only by its owner's re-authenticated action and never matched by e-mail.
CREATE TABLE external_identities (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE CHECK (length(principal_id) = 36),
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 32 AND provider_id NOT GLOB '*[^a-z0-9-]*'),
  issuer TEXT NOT NULL CHECK (length(issuer) BETWEEN 9 AND 256 AND issuer GLOB 'https://*'),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  label TEXT CHECK (label IS NULL OR length(label) BETWEEN 1 AND 254),
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  UNIQUE (issuer, subject)
) STRICT;

CREATE INDEX external_identities_principal_idx ON external_identities (principal_id);
CREATE INDEX external_identities_provider_idx ON external_identities (provider_id);
