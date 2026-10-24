-- Expand-only operational metadata; preserve the applied initialization and mailbox migrations.
CREATE TABLE IF NOT EXISTS job_runtime_leases (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  idempotency_key TEXT UNIQUE,
  request_fingerprint TEXT NOT NULL DEFAULT '',
  target_revision INTEGER,
  lease_owner TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  lease_expires_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  checkpoint_step TEXT,
  checkpoint_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(checkpoint_json) AND json_type(checkpoint_json) = 'object'),
  completed_steps_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(completed_steps_json) AND json_type(completed_steps_json) = 'array'),
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  cancel_reason TEXT,
  failure_class TEXT CHECK (failure_class IS NULL OR failure_class IN ('retryable', 'permanent', 'unknown_outcome')),
  needs_attention INTEGER NOT NULL DEFAULT 0 CHECK (needs_attention IN (0, 1)),
  reference_code TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS job_runtime_leases_owner_idx ON job_runtime_leases (lease_owner, lease_expires_at);

CREATE TABLE operational_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  issuer_id TEXT NOT NULL UNIQUE CHECK (length(issuer_id) = 36),
  initialized_at TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 3),
  migration_checksums_json TEXT NOT NULL CHECK (json_valid(migration_checksums_json) AND json_type(migration_checksums_json) = 'array'),
  legacy_import_count INTEGER NOT NULL CHECK (legacy_import_count >= 0),
  legacy_import_sha256 TEXT NOT NULL CHECK (length(legacy_import_sha256) = 64)
) STRICT;
CREATE TRIGGER operational_identity_no_update BEFORE UPDATE ON operational_identity
BEGIN SELECT RAISE(ABORT, 'FORBIDDEN: issuing identity is immutable'); END;
CREATE TRIGGER operational_identity_no_delete BEFORE DELETE ON operational_identity
BEGIN SELECT RAISE(ABORT, 'FORBIDDEN: issuing identity is permanent'); END;
CREATE TRIGGER operational_identity_no_replace BEFORE INSERT ON operational_identity
WHEN EXISTS (SELECT 1 FROM operational_identity)
BEGIN SELECT RAISE(ABORT, 'CONFLICT: issuing identity already exists'); END;

CREATE TABLE official_reference_counters (
  issuer_id TEXT NOT NULL REFERENCES operational_identity(issuer_id),
  kind TEXT NOT NULL CHECK (kind = 'job'),
  issued_year INTEGER NOT NULL CHECK (issued_year BETWEEN 1 AND 9999),
  last_sequence INTEGER NOT NULL CHECK (last_sequence BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (issuer_id, kind, issued_year)
) STRICT;
CREATE TRIGGER official_reference_counters_no_delete BEFORE DELETE ON official_reference_counters
BEGIN SELECT RAISE(ABORT, 'FORBIDDEN: reference counter is permanent'); END;
CREATE TRIGGER official_reference_counters_no_replace BEFORE INSERT ON official_reference_counters
WHEN EXISTS (SELECT 1 FROM official_reference_counters WHERE issuer_id=NEW.issuer_id AND kind=NEW.kind AND issued_year=NEW.issued_year)
BEGIN SELECT RAISE(ABORT, 'CONFLICT: reference counter already exists'); END;
CREATE TRIGGER official_reference_counters_no_rewind BEFORE UPDATE ON official_reference_counters
WHEN NEW.issuer_id != OLD.issuer_id OR NEW.kind != OLD.kind OR NEW.issued_year != OLD.issued_year OR NEW.last_sequence < OLD.last_sequence
BEGIN SELECT RAISE(ABORT, 'FORBIDDEN: reference counter cannot rewind'); END;

CREATE TABLE official_reference_ledger (
  issuer_id TEXT NOT NULL REFERENCES operational_identity(issuer_id),
  kind TEXT NOT NULL CHECK (kind = 'job'),
  entity_id TEXT NOT NULL CHECK (length(entity_id) = 36),
  reference_code TEXT NOT NULL CHECK (length(reference_code) BETWEEN 1 AND 128),
  issued_year INTEGER CHECK (issued_year BETWEEN 1 AND 9999),
  sequence INTEGER CHECK (sequence BETWEEN 1 AND 9007199254740991),
  origin TEXT NOT NULL CHECK (origin IN ('legacy', 'new', 'repair')),
  publication_state TEXT NOT NULL CHECK (publication_state IN ('reserved', 'issued', 'abandoned')),
  created_at TEXT NOT NULL,
  issued_at TEXT,
  tombstoned_at TEXT,
  repair_id TEXT,
  CHECK ((issued_year IS NULL) = (sequence IS NULL)),
  CHECK ((publication_state = 'issued') = (issued_at IS NOT NULL)),
  PRIMARY KEY (issuer_id, kind, entity_id),
  UNIQUE (issuer_id, kind, reference_code)
) STRICT;
CREATE UNIQUE INDEX official_reference_sequence_idx ON official_reference_ledger (issuer_id, kind, issued_year, sequence) WHERE sequence IS NOT NULL;
CREATE TRIGGER official_reference_ledger_no_delete BEFORE DELETE ON official_reference_ledger
BEGIN SELECT RAISE(ABORT, 'FORBIDDEN: issued reference history is permanent'); END;
CREATE TRIGGER official_reference_ledger_no_replace BEFORE INSERT ON official_reference_ledger
WHEN EXISTS (SELECT 1 FROM official_reference_ledger WHERE issuer_id=NEW.issuer_id AND kind=NEW.kind AND (entity_id=NEW.entity_id OR reference_code=NEW.reference_code OR (NEW.sequence IS NOT NULL AND issued_year=NEW.issued_year AND sequence=NEW.sequence)))
BEGIN SELECT RAISE(ABORT, 'CONFLICT: permanent reference identity already exists'); END;
CREATE TRIGGER official_reference_ledger_immutable BEFORE UPDATE ON official_reference_ledger
WHEN NEW.issuer_id IS NOT OLD.issuer_id OR NEW.kind IS NOT OLD.kind OR NEW.entity_id IS NOT OLD.entity_id
  OR NEW.reference_code IS NOT OLD.reference_code OR NEW.issued_year IS NOT OLD.issued_year OR NEW.sequence IS NOT OLD.sequence
  OR NEW.origin IS NOT OLD.origin OR NEW.created_at IS NOT OLD.created_at OR NEW.repair_id IS NOT OLD.repair_id
  OR (OLD.publication_state != 'reserved' AND NEW.publication_state IS NOT OLD.publication_state)
  OR (OLD.publication_state = 'reserved' AND NEW.publication_state NOT IN ('reserved', 'issued', 'abandoned'))
  OR (OLD.issued_at IS NOT NULL AND NEW.issued_at IS NOT OLD.issued_at)
  OR (OLD.tombstoned_at IS NOT NULL AND NEW.tombstoned_at IS NOT OLD.tombstoned_at)
BEGIN SELECT RAISE(ABORT, 'FORBIDDEN: reference identity is immutable'); END;
CREATE TRIGGER official_reference_tombstone AFTER DELETE ON jobs
BEGIN UPDATE official_reference_ledger SET tombstoned_at = COALESCE(tombstoned_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE kind = 'job' AND entity_id = OLD.id; END;
CREATE TRIGGER jobs_no_reference_identity_reuse BEFORE INSERT ON jobs
WHEN EXISTS (SELECT 1 FROM official_reference_ledger WHERE kind = 'job' AND entity_id = NEW.id AND tombstoned_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'CONFLICT: pruned job identity cannot be reused'); END;

CREATE TABLE legacy_reference_reviews (
  job_id TEXT PRIMARY KEY CHECK (length(job_id) = 36),
  raw_reference TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('unissued_sentinel', 'internal_id', 'unsafe_reference')),
  recorded_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER legacy_reference_reviews_no_update BEFORE UPDATE ON legacy_reference_reviews
BEGIN SELECT RAISE(ABORT, 'FORBIDDEN: legacy reference provenance is immutable'); END;
CREATE TRIGGER legacy_reference_reviews_no_delete BEFORE DELETE ON legacy_reference_reviews
BEGIN SELECT RAISE(ABORT, 'FORBIDDEN: legacy reference provenance is permanent'); END;
CREATE TRIGGER legacy_reference_reviews_no_replace BEFORE INSERT ON legacy_reference_reviews
WHEN EXISTS (SELECT 1 FROM legacy_reference_reviews WHERE job_id=NEW.job_id)
BEGIN SELECT RAISE(ABORT, 'CONFLICT: legacy reference provenance already exists'); END;

CREATE TABLE legacy_reference_repairs (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  request_key TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL UNIQUE CHECK (length(job_id) = 36),
  principal_id TEXT NOT NULL CHECK (length(principal_id) = 36),
  reason TEXT NOT NULL,
  original_reference TEXT,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  state TEXT NOT NULL CHECK (state IN ('awaiting_intent', 'confirmed')),
  intent_event_uid TEXT,
  intent_entry_hash TEXT,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  CHECK ((state = 'confirmed') = (intent_event_uid IS NOT NULL AND intent_entry_hash IS NOT NULL AND confirmed_at IS NOT NULL))
) STRICT;
CREATE TRIGGER legacy_reference_repairs_no_delete BEFORE DELETE ON legacy_reference_repairs
BEGIN SELECT RAISE(ABORT, 'FORBIDDEN: reference repair history is permanent'); END;
CREATE TRIGGER legacy_reference_repairs_immutable BEFORE UPDATE ON legacy_reference_repairs
WHEN NEW.id IS NOT OLD.id OR NEW.request_key IS NOT OLD.request_key OR NEW.job_id IS NOT OLD.job_id
 OR NEW.principal_id IS NOT OLD.principal_id OR NEW.reason IS NOT OLD.reason OR NEW.original_reference IS NOT OLD.original_reference
 OR NEW.request_fingerprint IS NOT OLD.request_fingerprint OR NEW.created_at IS NOT OLD.created_at
 OR (OLD.state = 'confirmed' AND (NEW.state IS NOT OLD.state OR NEW.intent_event_uid IS NOT OLD.intent_event_uid OR NEW.intent_entry_hash IS NOT OLD.intent_entry_hash OR NEW.confirmed_at IS NOT OLD.confirmed_at))
BEGIN SELECT RAISE(ABORT, 'FORBIDDEN: reference repair binding is immutable'); END;
CREATE TRIGGER legacy_reference_repairs_no_replace BEFORE INSERT ON legacy_reference_repairs
WHEN EXISTS (SELECT 1 FROM legacy_reference_repairs WHERE id=NEW.id OR request_key=NEW.request_key OR job_id=NEW.job_id)
BEGIN SELECT RAISE(ABORT, 'CONFLICT: permanent reference repair already exists'); END;

CREATE TABLE reconcile_host_epochs (
  issuer_id TEXT PRIMARY KEY REFERENCES operational_identity(issuer_id),
  last_epoch INTEGER NOT NULL DEFAULT 0 CHECK (last_epoch BETWEEN 0 AND 9007199254740991)
) STRICT;
CREATE TRIGGER reconcile_host_epochs_no_delete BEFORE DELETE ON reconcile_host_epochs
BEGIN SELECT RAISE(ABORT, 'FORBIDDEN: execution epoch is permanent'); END;
CREATE TRIGGER reconcile_host_epochs_no_replace BEFORE INSERT ON reconcile_host_epochs
WHEN EXISTS (SELECT 1 FROM reconcile_host_epochs WHERE issuer_id=NEW.issuer_id)
BEGIN SELECT RAISE(ABORT, 'CONFLICT: execution epoch already exists'); END;
CREATE TRIGGER reconcile_host_epochs_no_rewind BEFORE UPDATE ON reconcile_host_epochs
WHEN NEW.issuer_id IS NOT OLD.issuer_id OR NEW.last_epoch < OLD.last_epoch
BEGIN SELECT RAISE(ABORT, 'FORBIDDEN: execution epoch cannot rewind'); END;

CREATE TABLE reconcile_operations (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE RESTRICT,
  issuer_id TEXT NOT NULL REFERENCES operational_identity(issuer_id),
  request_key TEXT NOT NULL CHECK (length(request_key) BETWEEN 1 AND 128),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  binding_json TEXT NOT NULL CHECK (json_valid(binding_json) AND json_type(binding_json) = 'object'),
  source_revision INTEGER NOT NULL CHECK (source_revision BETWEEN 0 AND 9007199254740991),
  source_checksum TEXT NOT NULL CHECK (length(source_checksum) = 64 AND source_checksum NOT GLOB '*[^0-9a-f]*'),
  source_committed_lease_id TEXT,
  snapshot_locator TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL CHECK (length(snapshot_sha256) = 64 AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('awaiting_intent', 'queued', 'running', 'cancelling', 'applied', 'unchanged', 'failed', 'cancelled', 'superseded', 'needs_attention')),
  phase TEXT NOT NULL CHECK (phase IN ('intent', 'queued', 'prepare', 'stage', 'test', 'activate', 'reload', 'verify', 'settle', 'settled', 'attention')),
  reason TEXT,
  intent_event_uid TEXT,
  intent_entry_hash TEXT,
  host_epoch INTEGER CHECK (host_epoch BETWEEN 1 AND 9007199254740991),
  execution_started_at TEXT,
  generation_id INTEGER CHECK (generation_id BETWEEN 1 AND 9007199254740991),
  journal_locator TEXT,
  journal_sha256 TEXT,
  receipt_json TEXT CHECK (receipt_json IS NULL OR (json_valid(receipt_json) AND json_type(receipt_json) = 'object')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  settled_at TEXT,
  CHECK ((source_revision = 0 AND source_committed_lease_id IS NULL) OR (source_revision > 0 AND source_committed_lease_id IS NOT NULL AND length(source_committed_lease_id) = 36)),
  CHECK (status NOT IN ('queued', 'running', 'cancelling', 'applied', 'unchanged') OR (intent_event_uid IS NOT NULL AND intent_entry_hash IS NOT NULL)),
  CHECK (status NOT IN ('applied', 'unchanged') OR (receipt_json IS NOT NULL AND generation_id IS NOT NULL AND settled_at IS NOT NULL)),
  CHECK (status != 'awaiting_intent' OR (phase = 'intent' AND receipt_json IS NULL AND intent_event_uid IS NULL AND intent_entry_hash IS NULL)),
  UNIQUE (issuer_id, request_key)
) STRICT;
CREATE INDEX reconcile_operations_eligible_idx ON reconcile_operations (status, created_at);
CREATE TRIGGER reconcile_operations_binding_immutable BEFORE UPDATE ON reconcile_operations
WHEN NEW.job_id IS NOT OLD.job_id OR NEW.issuer_id IS NOT OLD.issuer_id OR NEW.request_key IS NOT OLD.request_key
  OR NEW.request_fingerprint IS NOT OLD.request_fingerprint OR NEW.binding_json IS NOT OLD.binding_json
  OR NEW.source_revision IS NOT OLD.source_revision OR NEW.source_checksum IS NOT OLD.source_checksum
  OR NEW.source_committed_lease_id IS NOT OLD.source_committed_lease_id OR NEW.snapshot_locator IS NOT OLD.snapshot_locator
  OR NEW.snapshot_sha256 IS NOT OLD.snapshot_sha256 OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.intent_event_uid IS NOT NULL AND NEW.intent_event_uid IS NOT OLD.intent_event_uid)
  OR (OLD.intent_entry_hash IS NOT NULL AND NEW.intent_entry_hash IS NOT OLD.intent_entry_hash)
BEGIN SELECT RAISE(ABORT, 'FORBIDDEN: reconcile binding is immutable'); END;
CREATE TRIGGER reconcile_operations_no_delete BEFORE DELETE ON reconcile_operations
BEGIN SELECT RAISE(ABORT, 'FORBIDDEN: reconcile operation history is permanent'); END;
CREATE TRIGGER reconcile_operations_no_replace BEFORE INSERT ON reconcile_operations
WHEN EXISTS (SELECT 1 FROM reconcile_operations WHERE job_id=NEW.job_id OR (issuer_id=NEW.issuer_id AND request_key=NEW.request_key))
BEGIN SELECT RAISE(ABORT, 'CONFLICT: permanent operation identity already exists'); END;
CREATE TRIGGER reconcile_runtime_no_delete BEFORE DELETE ON job_runtime_leases
WHEN EXISTS (SELECT 1 FROM reconcile_operations WHERE job_id=OLD.job_id)
BEGIN SELECT RAISE(ABORT, 'FORBIDDEN: reconcile execution metadata is permanent'); END;
CREATE TRIGGER job_runtime_reference_insert_guard BEFORE INSERT ON job_runtime_leases
WHEN EXISTS (SELECT 1 FROM official_reference_ledger WHERE kind='job' AND entity_id=NEW.job_id AND reference_code != NEW.reference_code)
BEGIN SELECT RAISE(ABORT, 'CONFLICT: job reference mirror differs from authoritative history'); END;
CREATE TRIGGER job_runtime_reference_update_guard BEFORE UPDATE OF reference_code ON job_runtime_leases
WHEN EXISTS (SELECT 1 FROM official_reference_ledger WHERE kind='job' AND entity_id=NEW.job_id AND reference_code != NEW.reference_code)
BEGIN SELECT RAISE(ABORT, 'CONFLICT: job reference mirror differs from authoritative history'); END;

CREATE TABLE reconcile_operation_effects (
  job_id TEXT NOT NULL REFERENCES reconcile_operations(job_id) ON DELETE RESTRICT,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  effect_sequence INTEGER NOT NULL CHECK (effect_sequence BETWEEN 1 AND 1024),
  effect_key TEXT NOT NULL CHECK (length(effect_key) BETWEEN 1 AND 128),
  host_epoch INTEGER NOT NULL CHECK (host_epoch BETWEEN 1 AND 9007199254740991),
  lease_fencing_token INTEGER NOT NULL CHECK (lease_fencing_token BETWEEN 1 AND 9007199254740991),
  intent_json TEXT NOT NULL CHECK (json_valid(intent_json) AND json_type(intent_json) = 'object'),
  intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256) = 64),
  state TEXT NOT NULL CHECK (state IN ('started', 'observed', 'unknown')),
  observation_json TEXT CHECK (observation_json IS NULL OR (json_valid(observation_json) AND json_type(observation_json) = 'object')),
  started_at TEXT NOT NULL,
  observed_at TEXT,
  CHECK ((state = 'observed') = (observation_json IS NOT NULL AND observed_at IS NOT NULL)),
  PRIMARY KEY (job_id, attempt, effect_sequence),
  UNIQUE (job_id, attempt, effect_key)
) STRICT;
CREATE TRIGGER reconcile_operation_effects_no_delete BEFORE DELETE ON reconcile_operation_effects
BEGIN SELECT RAISE(ABORT, 'FORBIDDEN: reconcile effect history is permanent'); END;
CREATE TRIGGER reconcile_operation_effects_immutable BEFORE UPDATE ON reconcile_operation_effects
WHEN NEW.job_id IS NOT OLD.job_id OR NEW.attempt IS NOT OLD.attempt OR NEW.effect_sequence IS NOT OLD.effect_sequence
  OR NEW.effect_key IS NOT OLD.effect_key OR NEW.host_epoch IS NOT OLD.host_epoch OR NEW.lease_fencing_token IS NOT OLD.lease_fencing_token
  OR NEW.intent_json IS NOT OLD.intent_json OR NEW.intent_sha256 IS NOT OLD.intent_sha256 OR NEW.started_at IS NOT OLD.started_at
  OR (OLD.state != 'started' AND (NEW.state IS NOT OLD.state OR NEW.observation_json IS NOT OLD.observation_json OR NEW.observed_at IS NOT OLD.observed_at))
BEGIN SELECT RAISE(ABORT, 'FORBIDDEN: effect intent and observation history are immutable'); END;
CREATE TRIGGER reconcile_operation_effects_no_replace BEFORE INSERT ON reconcile_operation_effects
WHEN EXISTS (SELECT 1 FROM reconcile_operation_effects WHERE job_id=NEW.job_id AND attempt=NEW.attempt AND (effect_sequence=NEW.effect_sequence OR effect_key=NEW.effect_key))
BEGIN SELECT RAISE(ABORT, 'CONFLICT: effect identity already exists'); END;
