// Drizzle mirror of migrations/*.sql for typed queries. The SQL files are the
// source of truth: CHECK constraints, expression indexes and triggers live there
// only. schema.test.ts migrates a database and asserts that every table, column
// (name, type, nullability, default), primary key and foreign key matches.
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  cidr,
  customType,
  foreignKey,
  inet,
  integer,
  jsonb,
  type PgTableExtraConfigValue,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
  toDriver: (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength),
  fromDriver: (v) => new Uint8Array(v),
})

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })
const createdAt = () => ts('created_at').notNull().defaultNow()
const updatedAt = () => ts('updated_at').notNull().defaultNow()
/** NULL = unlimited (see mappers.ts) */
const limit = (name: string) => bigint(name, { mode: 'number' })
const id = () => uuid('id').primaryKey().defaultRandom()

export const schemaMigrations = pgTable('xpanel_schema_migrations', {
  version: integer('version').primaryKey(),
  name: text('name').notNull().unique(),
  checksum: text('checksum').notNull(),
  appliedAt: ts('applied_at').notNull().defaultNow(),
  executionMs: integer('execution_ms').notNull().default(0),
})

// ---------------------------------------------------------------- identity

export const principals = pgTable(
  'principals',
  {
    id: id(),
    kind: text('kind', { enum: ['root', 'reseller', 'user'] }).notNull(),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    forcePasswordChange: boolean('force_password_change').notNull().default(false),
    passwordChangedAt: ts('password_changed_at').notNull().defaultNow(),
    totpSecretEnc: bytea('totp_secret_enc'),
    totpEnabledAt: ts('totp_enabled_at'),
    totpRecoveryHashes: text('totp_recovery_hashes').array().notNull().default(sql`'{}'`),
    accountId: uuid('account_id'),
    disabled: boolean('disabled').notNull().default(false),
    lastLoginAt: ts('last_login_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique().on(t.id, t.kind),
    foreignKey({ columns: [t.accountId, t.username], foreignColumns: [accounts.id, accounts.username] }).onDelete('cascade'),
  ],
)

export const sessions = pgTable('sessions', {
  id: id(),
  principalId: uuid('principal_id')
    .notNull()
    .references(() => principals.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  mfaVerified: boolean('mfa_verified').notNull().default(false),
  createdAt: createdAt(),
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  expiresAt: ts('expires_at').notNull(),
  revokedAt: ts('revoked_at'),
})

export const apiTokens = pgTable('api_tokens', {
  id: id(),
  principalId: uuid('principal_id')
    .notNull()
    .references(() => principals.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  scopes: text('scopes').array().notNull().default(sql`'{}'`),
  allowedIps: cidr('allowed_ips').array().notNull().default(sql`'{}'`),
  expiresAt: ts('expires_at').notNull(),
  lastUsedAt: ts('last_used_at'),
  lastUsedIp: inet('last_used_ip'),
  createdAt: createdAt(),
  revokedAt: ts('revoked_at'),
})

export const loginAttempts = pgTable('login_attempts', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  at: ts('at').notNull().defaultNow(),
  surface: text('surface', { enum: ['panel', 'api', 'webmail'] }).notNull().default('panel'),
  username: text('username').notNull(),
  ip: inet('ip').notNull(),
  success: boolean('success').notNull(),
  reason: text('reason'),
})

export const lockouts = pgTable('lockouts', {
  id: id(),
  username: text('username'),
  ip: inet('ip'),
  failures: integer('failures').notNull().default(0),
  reason: text('reason').notNull().default(''),
  lockedUntil: ts('locked_until').notNull(),
  createdAt: createdAt(),
})

// ---------------------------------------------------------------- resellers, plans

export const resellers = pgTable(
  'resellers',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind', { enum: ['reseller'] }).notNull().default('reseller'),
    acl: text('acl').array().notNull().default(sql`'{}'`),
    maxAccounts: limit('max_accounts'),
    totalDiskMb: limit('total_disk_mb'),
    totalBandwidthMb: limit('total_bandwidth_mb'),
    oversell: boolean('oversell').notNull().default(false),
    nameservers: text('nameservers').array().notNull().default(sql`'{}'`),
    delegatedIps: inet('delegated_ips').array().notNull().default(sql`'{}'`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t): PgTableExtraConfigValue[] => [foreignKey({ columns: [t.id, t.kind], foreignColumns: [principals.id, principals.kind] }).onDelete('cascade')],
)

export const featureLists = pgTable('feature_lists', {
  id: id(),
  name: text('name').notNull(),
  ownerId: uuid('owner_id').references(() => resellers.id, { onDelete: 'cascade' }),
  disabled: text('disabled').array().notNull().default(sql`'{}'`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const plans = pgTable('plans', {
  id: id(),
  name: text('name').notNull(),
  ownerId: uuid('owner_id').references(() => resellers.id, { onDelete: 'cascade' }),
  featureListId: uuid('feature_list_id')
    .notNull()
    .references(() => featureLists.id),
  diskMb: limit('disk_mb'),
  bandwidthMbMonth: limit('bandwidth_mb_month'),
  ioReadBps: limit('io_read_bps'),
  ioWriteBps: limit('io_write_bps'),
  ioReadIops: limit('io_read_iops'),
  ioWriteIops: limit('io_write_iops'),
  memoryMb: limit('memory_mb'),
  maxProcesses: limit('max_processes'),
  cpuPercent: limit('cpu_percent'),
  addonDomains: limit('addon_domains'),
  aliasDomains: limit('alias_domains'),
  subdomains: limit('subdomains'),
  mailboxes: limit('mailboxes'),
  forwarders: limit('forwarders'),
  mailingLists: limit('mailing_lists'),
  ftpAccounts: limit('ftp_accounts'),
  databases: limit('databases'),
  phpWorkers: limit('php_workers'),
  dedicatedIp: boolean('dedicated_ip').notNull().default(false),
  shell: text('shell', { enum: ['none', 'jailed'] }).notNull().default('none'),
  defaultMailboxQuotaMb: limit('default_mailbox_quota_mb'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

// ---------------------------------------------------------------- accounts

export const uidAllocator = pgTable('uid_allocator', {
  uid: integer('uid')
    .primaryKey()
    .default(sql`nextval('xpanel_uid_seq')`),
  username: text('username').notNull(),
  allocatedAt: ts('allocated_at').notNull().defaultNow(),
})

export const accounts = pgTable(
  'accounts',
  {
    id: id(),
    username: text('username').notNull(),
    uid: integer('uid').notNull().unique(),
    gid: integer('gid').notNull().unique(),
    home: text('home').notNull().unique(),
    primaryDomain: text('primary_domain').notNull(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id),
    ownerId: uuid('owner_id').references(() => resellers.id),
    status: text('status', { enum: ['active', 'suspended', 'terminating'] })
      .notNull()
      .default('active'),
    suspendReason: text('suspend_reason'),
    suspendedAt: ts('suspended_at'),
    contactEmail: text('contact_email').notNull(),
    ipv4: inet('ipv4').notNull(),
    shell: text('shell', { enum: ['none', 'jailed'] }).notNull().default('none'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique().on(t.id, t.username),
    foreignKey({ columns: [t.uid, t.username], foreignColumns: [uidAllocator.uid, uidAllocator.username] }),
  ],
)

// ---------------------------------------------------------------- web

export const certificates = pgTable('certificates', {
  id: id(),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
  names: text('names').array().notNull(),
  source: text('source', { enum: ['acme', 'upload', 'self-signed'] }).notNull(),
  challenge: text('challenge', { enum: ['http-01', 'dns-01'] }),
  notBefore: ts('not_before'),
  notAfter: ts('not_after').notNull(),
  autoRenew: boolean('auto_renew').notNull().default(false),
  certPath: text('cert_path').notNull(),
  keyPath: text('key_path').notNull(),
  chainPath: text('chain_path'),
  fingerprintSha256: text('fingerprint_sha256'),
  lastError: text('last_error'),
  renewedAt: ts('renewed_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const domains = pgTable(
  'domains',
  {
    id: id(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['primary', 'addon', 'alias', 'subdomain'] }).notNull(),
    parentId: uuid('parent_id'),
    docRoot: text('doc_root').notNull(),
    siteType: text('site_type', { enum: ['php', 'static', 'proxy', 'node', 'python'] })
      .notNull()
      .default('php'),
    upstream: text('upstream'),
    redirectTo: text('redirect_to'),
    redirectCode: smallint('redirect_code'),
    php: jsonb('php').notNull(),
    wildcard: boolean('wildcard').notNull().default(false),
    certificateId: uuid('certificate_id').references(() => certificates.id, { onDelete: 'set null' }),
    suspended: boolean('suspended').notNull().default(false),
    expiresAt: ts('expires_at'),
    pathQuotaMb: limit('path_quota_mb'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    foreignKey({ columns: [t.parentId, t.accountId], foreignColumns: [t.id, t.accountId] }).onDelete('cascade'),
  ],
)

export const serviceUsers = pgTable(
  'service_users',
  {
    id: id(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    domainId: uuid('domain_id').notNull(),
    localPart: text('local_part').notNull(),
    passwordHash: text('password_hash').notNull(),
    email: boolean('email').notNull().default(false),
    ftp: boolean('ftp').notNull().default(false),
    webdisk: boolean('webdisk').notNull().default(false),
    mailboxQuotaMb: limit('mailbox_quota_mb'),
    ftpDir: text('ftp_dir').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    foreignKey({ columns: [t.domainId, t.accountId], foreignColumns: [domains.id, domains.accountId] }).onDelete('cascade'),
  ],
)

// ---------------------------------------------------------------- databases

export const databases = pgTable('databases', {
  id: id(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  engine: text('engine', { enum: ['mariadb'] }).notNull().default('mariadb'),
  name: text('name').notNull(),
  trashedAt: ts('trashed_at'),
  createdAt: createdAt(),
})

export const databaseUsers = pgTable('database_users', {
  id: id(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  authPlugin: text('auth_plugin', { enum: ['mysql_native_password', 'ed25519'] })
    .notNull()
    .default('mysql_native_password'),
  authString: text('auth_string').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const databaseGrants = pgTable(
  'database_grants',
  {
    databaseUserId: uuid('database_user_id').notNull(),
    databaseId: uuid('database_id').notNull(),
    accountId: uuid('account_id').notNull(),
    privileges: text('privileges').array().notNull(),
    createdAt: createdAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    primaryKey({ columns: [t.databaseUserId, t.databaseId] }),
    foreignKey({
      columns: [t.databaseUserId, t.accountId],
      foreignColumns: [databaseUsers.id, databaseUsers.accountId],
    }).onDelete('cascade'),
    foreignKey({ columns: [t.databaseId, t.accountId], foreignColumns: [databases.id, databases.accountId] }).onDelete(
      'cascade',
    ),
  ],
)

// ---------------------------------------------------------------- dns

export const dnsZones = pgTable('dns_zones', {
  id: id(),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  serial: bigint('serial', { mode: 'number' }).notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const dnsRecords = pgTable('dns_records', {
  id: id(),
  zoneId: uuid('zone_id')
    .notNull()
    .references(() => dnsZones.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type', { enum: ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA'] }).notNull(),
  ttl: integer('ttl').notNull().default(14400),
  content: text('content').notNull(),
  priority: integer('priority'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

// ---------------------------------------------------------------- security

export const firewallPrefixLists = pgTable('firewall_prefix_lists', {
  name: text('name').primaryKey(),
  entries: cidr('entries').array().notNull().default(sql`'{}'`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const firewallRules = pgTable('firewall_rules', {
  id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
  kind: text('kind', { enum: ['port', 'ip', 'forward', 'icmp', 'prefix-list'] }).notNull(),
  action: text('action', { enum: ['accept', 'drop', 'reject'] }).notNull(),
  protocol: text('protocol', { enum: ['tcp', 'udp', 'both'] }),
  port: text('port'),
  source: cidr('source'),
  forwardTo: text('forward_to'),
  list: text('list').references(() => firewallPrefixLists.name),
  comment: text('comment').notNull().default(''),
  enabled: boolean('enabled').notNull().default(true),
  sortOrder: integer('sort_order').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const serverSettings = pgTable('server_settings', {
  id: smallint('id').primaryKey().default(1),
  hostname: text('hostname').notNull(),
  nameservers: text('nameservers').array().notNull().default(sql`'{}'`),
  adminEmail: text('admin_email').notNull(),
  engine: text('engine', { enum: ['apache', 'openlitespeed'] }).notNull().default('apache'),
  apacheMpm: text('apache_mpm', { enum: ['itk', 'prefork'] }).notNull().default('itk'),
  panelPort: integer('panel_port').notNull(),
  sshPort: integer('ssh_port').notNull().default(22),
  /** NULL = auto */
  nginxWorkerProcesses: integer('nginx_worker_processes'),
  nginxWorkerConnections: integer('nginx_worker_connections').notNull(),
  nginxWorkerRlimitNofile: integer('nginx_worker_rlimit_nofile').notNull(),
  nginxMultiAccept: boolean('nginx_multi_accept').notNull().default(false),
  nginxKeepaliveTimeoutSec: integer('nginx_keepalive_timeout_sec').notNull(),
  apacheStartServers: integer('apache_start_servers').notNull(),
  apacheMinSpareServers: integer('apache_min_spare_servers').notNull(),
  apacheMaxSpareServers: integer('apache_max_spare_servers').notNull(),
  apacheMaxRequestWorkers: integer('apache_max_request_workers').notNull(),
  apacheMaxConnectionsPerChild: integer('apache_max_connections_per_child').notNull(),
  apacheServerLimit: integer('apache_server_limit').notNull(),
  backendPort: integer('backend_port').notNull(),
  backendTlsPort: integer('backend_tls_port').notNull(),
  setupCompletedAt: ts('setup_completed_at'),
  updatedAt: updatedAt(),
})

// ---------------------------------------------------------------- scheduling, backups

export const cronJobs = pgTable('cron_jobs', {
  id: id(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  schedule: text('schedule').notNull(),
  command: text('command').notNull(),
  comment: text('comment').notNull().default(''),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

const backupScope = ['full', 'home', 'databases', 'mail-filters'] as const

export const backupJobs = pgTable('backup_jobs', {
  id: id(),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  schedule: text('schedule').notNull(),
  scope: text('scope', { enum: backupScope }).notNull(),
  destination: text('destination', { enum: ['account-dir', 'remote'] }).notNull(),
  remoteTarget: text('remote_target'),
  retention: integer('retention').notNull().default(7),
  enabled: boolean('enabled').notNull().default(true),
  lastRunAt: ts('last_run_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const backups = pgTable('backups', {
  id: id(),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  accountUsername: text('account_username'),
  jobId: uuid('job_id').references(() => backupJobs.id, { onDelete: 'set null' }),
  scope: text('scope', { enum: backupScope }).notNull(),
  destination: text('destination', { enum: ['download', 'account-dir', 'remote'] }).notNull(),
  status: text('status', { enum: ['queued', 'running', 'succeeded', 'failed', 'expired'] })
    .notNull()
    .default('queued'),
  location: text('location'),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  sha256: text('sha256'),
  error: text('error'),
  requestedBy: text('requested_by').notNull(),
  createdAt: createdAt(),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
})

// ---------------------------------------------------------------- transfers

export const transfers = pgTable('transfers', {
  id: id(),
  sourceKind: text('source_kind', { enum: ['xpanel-remote', 'xpanel-archive', 'cpanel-archive'] }).notNull(),
  sourceHost: text('source_host'),
  sourcePort: integer('source_port'),
  authMethod: text('auth_method', { enum: ['ssh-key', 'api-token'] }),
  archivePath: text('archive_path'),
  status: text('status', {
    enum: ['pending', 'scanning', 'review', 'running', 'succeeded', 'failed', 'cancelled'],
  })
    .notNull()
    .default('pending'),
  options: jsonb('options').notNull().default(sql`'{}'`),
  actor: text('actor').notNull(),
  error: text('error'),
  createdAt: createdAt(),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
  updatedAt: updatedAt(),
})

export const transferItems = pgTable('transfer_items', {
  id: id(),
  transferId: uuid('transfer_id')
    .notNull()
    .references(() => transfers.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['account', 'plan', 'reseller', 'feature-list'] }).notNull(),
  sourceName: text('source_name').notNull(),
  targetName: text('target_name'),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  selected: boolean('selected').notNull().default(true),
  status: text('status', { enum: ['pending', 'running', 'succeeded', 'failed', 'skipped'] })
    .notNull()
    .default('pending'),
  progress: smallint('progress').notNull().default(0),
  error: text('error'),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
  updatedAt: updatedAt(),
})

// ---------------------------------------------------------------- panel lifecycle

export const UPGRADE_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'rolled_back'] as const
export const UPGRADE_PHASES = ['precheck', 'snapshot', 'stage', 'migrate', 'switch', 'health-check', 'rollback'] as const

export const upgrades = pgTable('upgrades', {
  id: id(),
  fromVersion: text('from_version').notNull(),
  toVersion: text('to_version').notNull(),
  fromSchemaVersion: integer('from_schema_version'),
  toSchemaVersion: integer('to_schema_version'),
  status: text('status', { enum: UPGRADE_STATUSES }).notNull().default('pending'),
  phase: text('phase', { enum: UPGRADE_PHASES }),
  healthReport: jsonb('health_report'),
  snapshotPath: text('snapshot_path'),
  error: text('error'),
  actor: text('actor').notNull(),
  createdAt: createdAt(),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
})

export const GENERATION_STATUSES = ['pending', 'tested', 'active', 'superseded', 'failed', 'rolled_back'] as const

export const configGenerations = pgTable('config_generations', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  createdAt: createdAt(),
  status: text('status', { enum: GENERATION_STATUSES }).notNull().default('pending'),
  checksum: text('checksum').notNull(),
  error: text('error'),
  actor: text('actor').notNull().default('system'),
  testedAt: ts('tested_at'),
  activatedAt: ts('activated_at'),
})

export const auditLog = pgTable('audit_log', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  at: ts('at').notNull().defaultNow(),
  actor: text('actor').notNull(),
  principalId: uuid('principal_id'),
  ip: inet('ip'),
  action: text('action').notNull(),
  target: text('target').notNull(),
  detail: jsonb('detail').notNull().default(sql`'{}'`),
  outcome: text('outcome', { enum: ['ok', 'denied', 'failed'] }).notNull(),
})

export const trashItems = pgTable('trash_items', {
  id: id(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  originalPath: text('original_path').notNull(),
  trashPath: text('trash_path').notNull(),
  isDir: boolean('is_dir').notNull().default(false),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
  deletedAt: ts('deleted_at').notNull().defaultNow(),
  purgeAfter: ts('purge_after').notNull(),
  restoredAt: ts('restored_at'),
})

export const serviceCatalog = pgTable('service_catalog', {
  key: text('key').primaryKey(),
  role: text('role').notNull(),
  version: text('version'),
  status: text('status', { enum: ['installing', 'installed', 'failed', 'removing'] }).notNull(),
  packages: text('packages').array().notNull().default(sql`'{}'`),
  detail: jsonb('detail').notNull().default(sql`'{}'`),
  installedAt: ts('installed_at'),
  updatedAt: updatedAt(),
})

export const schema = {
  schemaMigrations,
  principals,
  sessions,
  apiTokens,
  loginAttempts,
  lockouts,
  resellers,
  featureLists,
  plans,
  uidAllocator,
  accounts,
  certificates,
  domains,
  serviceUsers,
  databases,
  databaseUsers,
  databaseGrants,
  dnsZones,
  dnsRecords,
  firewallPrefixLists,
  firewallRules,
  serverSettings,
  cronJobs,
  backupJobs,
  backups,
  transfers,
  transferItems,
  upgrades,
  configGenerations,
  auditLog,
  trashItems,
  serviceCatalog,
}

export type Schema = typeof schema
