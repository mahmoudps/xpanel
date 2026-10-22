export const UPGRADE_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'rolled_back'] as const
export const UPGRADE_PHASES = ['precheck', 'snapshot', 'stage', 'migrate', 'switch', 'health-check', 'rollback'] as const
export const GENERATION_STATUSES = ['pending', 'tested', 'active', 'superseded', 'failed', 'rolled_back'] as const
export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const

export const OPERATIONAL_TABLES = [
  'xpanel_schema_migrations',
  'principals',
  'sessions',
  'totp_enrollments',
  'api_tokens',
  'login_attempts',
  'lockouts',
  'login_failure_counters',
  'config_generations',
  'upgrades',
  'jobs',
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
