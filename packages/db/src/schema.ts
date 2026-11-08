import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checksumOf, MIGRATIONS_DIR } from './migrate.ts'

export const OPERATIONAL_MIGRATION_NAMES = ['0001_init.sql', '0002_mailbox_sessions.sql', '0003_job_references_reconcile.sql', '0004_host_metrics_observations.sql', '0005_team_sign_in.sql', '0006_panel_handoffs.sql', '0007_reseller_oversell.sql', '0008_identity_factors.sql'] as const
// The reference/identity contract remains version 3; additive metric, team and handoff migrations do not reissue identities.
export const OPERATIONAL_SCHEMA_VERSION = 3

const reviewedMigrations = OPERATIONAL_MIGRATION_NAMES.map((name, index) => Object.freeze({
  version: index + 1, name, checksum: checksumOf(readFileSync(join(MIGRATIONS_DIR, name), 'utf8')),
}))

/** Immutable reference identity schema 3 predates additive host metrics migration 4. */
export const OPERATIONAL_IDENTITY_MIGRATIONS_JSON = JSON.stringify(reviewedMigrations.slice(0, OPERATIONAL_SCHEMA_VERSION))

/**
 * The applied migration set a database reader accepts. `complete`: this build's whole reviewed set, for the API,
 * the agent, installation and every path after migration. `pre-migration`: an exact prefix of that set, at least
 * the identity schema long, for this build's lifecycle reads of a host database before its migrate phase.
 */
export type OperationalMigrationMode = 'complete' | 'pre-migration'

/** Applied rows must match name, version and checksum row by row: the complete reviewed set, or an exact reviewed prefix in `pre-migration`. */
export const isReviewedOperationalMigrationSet = (value: unknown, mode: OperationalMigrationMode): boolean => Array.isArray(value)
  && (mode === 'complete' ? value.length === reviewedMigrations.length
    : mode === 'pre-migration' && value.length >= OPERATIONAL_SCHEMA_VERSION && value.length <= reviewedMigrations.length)
  && value.every((row: unknown, index: number) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return false
    const entry = row as Record<string, unknown>
    const expected = reviewedMigrations[index]!
    return Object.keys(entry).length === 3 && entry.version === expected.version
      && entry.name === expected.name && entry.checksum === expected.checksum
  })

export const matchesReviewedOperationalMigrations = (receipt: unknown, applied: unknown, mode: OperationalMigrationMode): boolean => {
  // Never filter applied rows: missing/extra versions and any checksum mismatch fail here.
  if (typeof receipt !== 'string' || !isReviewedOperationalMigrationSet(applied, mode)) return false
  const exactAppliedReceipt = JSON.stringify(applied)
  // The immutable issuing identity keeps its exact reviewed schema 3 receipt.
  // Private schema 4 receipts remain valid only with exact applied evidence: the same set they were issued for.
  return receipt === OPERATIONAL_IDENTITY_MIGRATIONS_JSON || receipt === exactAppliedReceipt
}

export const UPGRADE_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'rolled_back'] as const
export const UPGRADE_PHASES = ['precheck', 'snapshot', 'stage', 'migrate', 'switch', 'health-check', 'rollback'] as const
export const GENERATION_STATUSES = ['pending', 'tested', 'active', 'superseded', 'failed', 'rolled_back'] as const
export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const

export const OPERATIONAL_TABLES = [
  'xpanel_schema_migrations',
  'principals',
  'sessions',
  'mailbox_sessions',
  'handoff_mailbox_sessions',
  'totp_enrollments',
  'api_tokens',
  'login_attempts',
  'lockouts',
  'login_failure_counters',
  'team_credentials',
  'team_sessions',
  'panel_handoffs',
  'security_questions',
  'security_verified_ips',
  'external_identities',
  'config_generations',
  'upgrades',
  'jobs',
  'job_runtime_leases',
  'operational_identity',
  'official_reference_counters',
  'official_reference_ledger',
  'legacy_reference_reviews',
  'legacy_reference_repairs',
  'reconcile_host_epochs',
  'reconcile_operations',
  'reconcile_operation_effects',
  'metrics_history',
  'audit_log',
] as const

export const DERIVED_INDEX_TABLES = [
  'idx_resellers',
  'idx_plans',
  'idx_accounts',
  'idx_domains',
  'idx_service_users',
  'idx_databases',
] as const

export const ALL_STRICT_TABLES = [...OPERATIONAL_TABLES, ...DERIVED_INDEX_TABLES] as const
