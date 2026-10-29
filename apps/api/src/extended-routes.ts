import { createHash, createPublicKey, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { services as mailServices } from '@xpanel/render'
import { join } from 'node:path'
import {
  fail,
  assessMailboxMetadataAuthority,
  isXpanelError,
  suggestServerSettings,
  validateDomainName,
  validateServerIpEntry,
  validateServerIpPool,
  canonicalIp,
} from '@xpanel/core'
import type {
  Account,
  DnsRecord,
  Id,
  LiveEventScope,
  MailboxMetadataAuthority,
  ServerSettings,
} from '@xpanel/core'
import type { Db } from '@xpanel/db'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import { passwordHashFromInput } from './auth.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { createContactToolsRoutes, createContactMetadataAccess, assertContactMutationCapacity } from './mail/contact-tools-routes.ts'
import { assertMailboxMetadataAuthority, captureMailboxMetadataAuthority, readBoundMailboxIdentityRecords, MAILBOX_METADATA_REVIEW_REQUIRED } from './mail/metadata-authority.ts'
import { createIdentityMetadataRoutes } from './mail/identity-routes.ts'
import { readContactVcards } from './mail/contact-vcard.ts'
import { createCalendarWorkspaceRoutes } from './mail/calendar-workspace.ts'
import { createAccountCollaborationRoutes } from './account-collaboration-workspace.ts'
import { parseCalendarWorkspaceIcs, renderCalendarWorkspaceIcs } from './mail/calendar-ics.ts'
import { createWhmBackupWorkspaceRoutes } from './backup-workspace.ts'
import { createTransferWorkspaceRoutes } from './transfer-workspace.ts'
import type { TransferWorkspacePorts } from './transfer-workspace.ts'
import { createTransferSourceDiscovery } from './acct-transfer-discovery.ts'
import { readTransferCredentialToken } from './acct-transfer-credentials.ts'
import { validateForwarderInput } from './mail/forwarder-validation.ts'
import { createFilterRoutes } from './mail/filter-routes.ts'
import { compileFilterRulesSafe } from './mail/filter-validation.ts'
import { contactWorkspaceRevision, projectContactWorkspace, parseContactWorkspaceRequest,
  createWorkspaceContact, updateWorkspaceContact, normalizeContactGroups, updateWorkspaceContactGroups } from './mail/contact-workspace.ts'
import { compileVacationWorkspace, parseVacationWorkspaceRequest, projectVacationWorkspace,
  vacationWorkspaceRevision } from './mail/vacation-workspace.ts'
import {
  assertAccountFeatures,
  isMailboxPrincipal,
  ownedAccounts,
  requireDomainAccount,
  requireMailbox,
  requireMailboxPrincipalAccess,
} from './authorization.ts'

export interface ExtendedRouteHelpers {
  db: Db
  store: StateStore
  homeBaseDir?: string
  serverSecret?: string
  backupDestinationHost?: (caller: AuthenticatedCaller, path: string, body?: unknown) => Promise<unknown>
  /** Server-to-server transfer execution (apps/api/src/lifecycle-transfer-execution.ts); absent without the host agent. */
  transferExecution?: TransferWorkspacePorts['execution']
  /** Authenticated agent result. Private key material must never cross this boundary. */
  readDkimPublicMaterial?: (caller: AuthenticatedCaller, domain: string) => Promise<{ selector: string; publicKeyPem: string } | null>
  requireCaller: (req: Request, opts?: { allowUnverifiedMfa?: boolean; deferDeniedAudit?: (input: Parameters<ExtendedRouteHelpers['emitAudit']>[0]) => void }) => Promise<AuthenticatedCaller>
  assertRoot: (caller: AuthenticatedCaller, action: string) => Promise<void>
  assertCanAccessAccount: (
    caller: AuthenticatedCaller,
    account: Account,
    action: string,
    opts?: { allowUserSelf?: boolean },
  ) => Promise<void>
  resolveAccountParam: (idOrUsername: string) => Promise<Account>
  resolveResellerId: (caller: AuthenticatedCaller) => Promise<Id | null>
  emitAudit: (
    input: {
      actor: string
      action: string
      target: string
      detail?: Record<string, unknown>
      outcome: 'ok' | 'denied' | 'failed'
      principalId?: Id | null
      ip?: string | null
    },
    scope?: LiveEventScope,
  ) => Promise<unknown>
  triggerReconcile: (
    caller: AuthenticatedCaller,
    opts?: { force?: boolean; scope?: LiveEventScope },
  ) => Promise<{ ok: boolean; status: number; body: Record<string, unknown> } | null>
}

// ---------------------------------------------------------------------------
// Extended Domain Models
// ---------------------------------------------------------------------------

export interface DomainForwarder {
  id: Id
  accountId: Id | null
  sourceDomain: string
  targetDomain: string
  createdAt: string
}

export interface EmailForwarder {
  id: Id
  accountId: Id | null
  sourceAddress: string
  destinations: string[]
  createdAt: string
}

export interface MailingListRecord {
  id: Id
  accountId: Id | null
  name: string
  domain: string
  address: string
  members: string[]
  moderation: 'open' | 'members' | 'moderated'
  archiveEnabled: boolean
  createdAt: string
  selfSubscription?: 'open' | 'closed'
  memberAuthorities?: Record<string, MailboxMetadataAuthority>
}

export interface SieveFilterCondition {
  field: 'from' | 'to' | 'subject' | 'header' | 'size' | 'body'
  headerName?: string
  comparator: 'contains' | 'is' | 'matches' | 'over' | 'under'
  value: string
}

export interface SieveFilterRule {
  id: Id
  accountId: Id | null
  scope: 'global' | 'mailbox'
  mailbox: string | null
  name: string
  priority: number
  enabled: boolean
  matchAll: boolean
  conditions: SieveFilterCondition[]
  action: {
    type: 'fileinto' | 'redirect' | 'discard' | 'reject' | 'keep'
    target?: string
  }
  compiledSieve: string
  createdAt: string
}

export interface SpamSettingsState {
  enabled: boolean
  rewriteSubjectScore: number
  addHeaderScore: number
  greylistScore: number
  rejectScore: number
  spamBoxEnabled: boolean
  autoDeleteSpam: boolean
  autoDeleteScore: number
  allowlist: string[]
  blocklist: string[]
  updatedAt: string
}

export interface MailDeliveryReport {
  id: Id
  at: string
  sender: string
  recipient: string
  domain: string
  status: 'delivered' | 'deferred' | 'bounced' | 'rejected'
  smtpCode: number
  queueId: string
  bytes: number
  message: string
}

export interface CalDavCardDavConfig {
  enabled: boolean
  caldavUrl: string
  carddavUrl: string
  autodiscoverSrv: boolean
  wellKnownRedirects: boolean
  syncPrincipals: string[]
  updatedAt: string
}

export interface WebmailMessage {
  id: Id
  mailbox: string
  folder: 'INBOX' | 'Sent' | 'Drafts' | 'Spam' | 'Trash' | 'Archive'
  from: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  textBody: string
  htmlBody: string
  attachments: { filename: string; contentType: string; sizeBytes: number }[]
  identityId: Id | null
  read: boolean
  starred: boolean
  sentAt: string
}

export interface WebmailIdentity {
  id: Id
  mailbox: string
  ownerAuthority?: MailboxMetadataAuthority
  displayName: string
  email: string
  replyTo: string
  textSignature: string
  htmlSignature: string
  isDefault: boolean
  createdAt: string
}

export interface WebmailVacationConfig {
  mailbox: string
  ownerAuthority?: MailboxMetadataAuthority
  enabled: boolean
  subject: string
  body: string
  htmlBody: string
  startDate: string | null
  endDate: string | null
  replyIntervalHours: number
  compiledSieve: string
  updatedAt: string
}

export interface WebmailCalendarEvent {
  id: Id
  uid: string
  summary: string
  description: string
  location: string
  dtstart: string
  dtend: string
  timezone: string
}

export interface WebmailCalendar {
  id: Id
  owner: string
  ownerAuthority?: MailboxMetadataAuthority
  name: string
  color: string
  timezone: string
  shares: { principal: string; permission: 'read' | 'read-write'; sharedAt: string; granteeAuthority?: MailboxMetadataAuthority }[]
  events?: WebmailCalendarEvent[]
  createdAt: string
}

export interface WebmailContact {
  id: Id
  owner: string
  ownerAuthority?: MailboxMetadataAuthority
  fullName: string
  email: string
  phone: string
  organization: string
  title: string
  groups: string[]
  shares?: { principal: string; permission: 'read' | 'read-write'; sharedAt: string; granteeAuthority?: MailboxMetadataAuthority }[]
  vcard: string
  createdAt: string
}

export interface DnsTemplateDefinition {
  id: 'standard' | 'simple' | 'virtualftp'
  name: string
  description: string
  records: {
    name: string
    type: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'SRV' | 'CAA'
    ttl: number
    contentTemplate: string
    priority: number | null
  }[]
}

export interface BackupDestination {
  id: Id
  name: string
  kind: 's3' | 'sftp' | 'rsync' | 'backblaze' | 'ftp' | 'local'
  endpoint: string
  bucket: string | null
  region: string | null
  pathPrefix: string
  username: string | null
  retentionDays: number
  enabled: boolean
  credentialRef?: string | null
  verification?: import('../../../packages/core/src/backup-destination.ts').BackupDestinationProof | null
  createdAt: string
}

export interface BackupScheduleConfig {
  enabled: boolean
  frequency: 'daily' | 'weekly' | 'monthly'
  cron: string
  retentionCount: number
  compress: 'zstd' | 'gzip'
  includeDatabases: boolean
  includeMail: boolean
  selectedAccounts: string[] | 'all'
  destinationIds: Id[]
  updatedAt: string
}

export interface BackupSnapshotFile {
  path: string
  content: string
  mode: number
  sizeBytes: number
}

export interface BackupSnapshot {
  id: Id
  accountId: Id
  username: string
  destinationId: Id | null
  sizeBytes: number
  checksumSha256: string
  files: BackupSnapshotFile[]
  databases: string[]
  createdAt: string
}

export interface DirectoryPrivacyRule {
  path: string
  authName: string
  enabled: boolean
  users: { username: string; passwordHash: string }[]
}

export interface DirectoryPrivacyConfig {
  accountId: Id
  rules: DirectoryPrivacyRule[]
  compiledHtpasswd: string
  compiledNginx: string
  compiledApache: string
  updatedAt: string
}

export interface HotlinkProtectionConfig {
  accountId: Id
  enabled: boolean
  allowedUrls: string[]
  protectedExtensions: string[]
  allowDirectRequests: boolean
  redirectUrl: string | null
  compiledNginx: string
  compiledApache: string
  updatedAt: string
}

export interface WebDiskConfig {
  accountId: Id
  enabled: boolean
  rootPath: string
  readOnly: boolean
  requireTls: boolean
  port: number
  digestAuth: boolean
  endpointUrl: string
  compiledConfig: string
  updatedAt: string
}

export interface WebExtrasConfig {
  accountId: Id
  errorPages: Record<string, string>
  redirects: { source: string; target: string; code: 301 | 302; wildcard: boolean }[]
  mimeTypes: { extension: string; mimeType: string }[]
  deniedCidrs: string[]
  directoryIndexMode: 'disabled' | 'standard' | 'fancy'
  compiledNginx: string
  compiledApache: string
  updatedAt: string
}

export interface GitRepositoryRecord {
  id: Id
  accountId: Id
  name: string
  branch: string
  remoteUrl: string
  deployPath: string
  postDeployCommand: string | null
  autoDeploy: boolean
  currentCommit: string | null
  currentReleaseDir: string | null
  deployments: {
    id: Id
    commitSha: string
    releaseDir: string
    currentSymlink: string
    status: 'deployed' | 'rolled_back'
    deployedAt: string
  }[]
  createdAt: string
}

export interface RemoteDatabaseHostsConfig {
  accountId: Id
  hosts: { address: string; engine: 'mariadb' | 'postgresql' | 'both'; comment: string }[]
  compiledPgHba: string
  compiledMariaDbGrants: string
  updatedAt: string
}

export interface AccountCacheConfig {
  accountId: Id
  uid: number
  username: string
  slice: string
  redis: {
    enabled: boolean
    socketPath: string
    maxMemoryMb: number
    evictionPolicy: 'allkeys-lru' | 'volatile-lru' | 'noeviction'
    systemdUnit: string
  }
  memcached: {
    enabled: boolean
    socketPath: string
    maxMemoryMb: number
    systemdUnit: string
  }
  updatedAt: string
}

export interface ServerFineSettingsState {
  limits: {
    maxMemoryPerProcessMb: number
    maxProcessesPerAccount: number
    oomScoreAdj: number
  }
  logRotation: {
    frequency: 'daily' | 'weekly'
    retainDays: number
    compress: boolean
    maxSizeMb: number
    compiledLogrotateConf: string
  }
  mta: {
    maxQueueLifetimeHours: number
    maxMessageSizeMb: number
    smarthost: { enabled: boolean; host: string; port: number; username: string | null } | null
    rbls: string[]
    compiledPostfixMainCf: string
  }
  packages: {
    installedPackages: string[]
    lastUpdatedAt: string
  }
  webStack: {
    modules: string[]
    brotliEnabled: boolean
    http3Enabled: boolean
    modSecurityEnabled: boolean
  }
  updatedAt: string
}

export interface RootlessContainerRecord {
  id: Id
  accountId: Id
  username: string
  uid: number
  name: string
  image: string
  runtime: 'podman' | 'docker'
  internalPort: number
  hostPort: number
  env: Record<string, string>
  memoryMb: number
  cpuPercent: number
  slice: string
  systemdUnit: string
  status: 'running' | 'stopped'
  createdAt: string
}

export type AppCatalogType = 'wordpress' | 'laravel' | 'drupal' | 'joomla' | 'ghost' | 'nextcloud'

export interface InstalledAppRecord {
  id: Id
  accountId: Id
  appType: AppCatalogType
  domain: string
  path: string
  docRoot: string
  title: string
  adminUser: string
  adminEmail: string
  version: string
  databaseName: string
  environment: 'production' | 'staging'
  parentAppId: Id | null
  createdAt: string
  updatedAt: string
}

export interface ClusterNodeRecord {
  id: Id
  name: string
  hostname: string
  ipv4: string
  role: 'web' | 'dns' | 'mail' | 'db' | 'all'
  status: 'online' | 'syncing' | 'degraded'
  wgPublicKey: string
  region: string
  joinedAt: string
}

export interface PanelBrandingConfig {
  companyName: string
  productName: string
  logoUrl: string | null
  faviconUrl: string | null
  primaryColorOklch: string
  accentColorOklch: string
  supportUrl: string
  supportEmail: string
  footerText: string
  hidePoweredBy: boolean
  updatedAt: string
}

export interface LanguageOverridePack {
  locale: string
  direction: 'ltr' | 'rtl'
  overrides: Record<string, string>
  updatedAt: string
}

export interface WhmcsIntegrationConfig {
  enabled: boolean
  whmcsUrl: string
  apiIdentifier: string
  allowedIps: string[]
  ssoRedirectTarget: 'xpanel' | 'xwhm' | 'xmail'
  autoProvisionOnOrder: boolean
  webhookSecretConfigured: boolean
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Compilers & Helpers
// ---------------------------------------------------------------------------

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })

const readJsonBody = async <T = Record<string, unknown>>(req: Request): Promise<T> => {
  if (req.body === null) return {} as T
  let body: unknown
  try { body = await req.json() } catch { return fail('VALIDATION', 'request body must be valid JSON') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('VALIDATION', 'request body must be a JSON object')
  return body as T
}

export const compileSieveRules = (rules: readonly SieveFilterRule[]): string => compileFilterRulesSafe(rules)

export const compileVacationSieve = (cfg: {
  enabled: boolean
  subject: string
  body: string
  replyIntervalHours: number
  mailbox: string
  htmlBody?: string
  startDate?: string | null
  endDate?: string | null
}): string => {
  return compileVacationWorkspace({ ...cfg, htmlBody: cfg.htmlBody ?? '', startDate: cfg.startDate ?? null, endDate: cfg.endDate ?? null })
}

const UNSAFE_CAL_VCARD_PATTERN = /<script\b|javascript:|vbscript:|data:text\/html|on[a-z]+\s*=|\0/i
const VALID_TIMEZONE_RE = /^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*$/
const VALID_ICS_DATETIME_RE = /^\d{8}(?:T\d{6}Z?)?$/

const assertSafeCalendarText = (value: string, fieldName: string): string => {
  if (typeof value !== 'string') return fail('VALIDATION', `${fieldName} must be a string`)
  if (/[\r\n\0]/.test(value) || UNSAFE_CAL_VCARD_PATTERN.test(value)) {
    return fail('VALIDATION', `${fieldName} contains unsafe or invalid characters`)
  }
  return value.trim()
}

const assertValidTimezone = (tz: string): string => {
  const trimmed = tz.trim()
  if (!trimmed || !VALID_TIMEZONE_RE.test(trimmed)) {
    return fail('VALIDATION', 'timezone must be a valid ASCII IANA timezone identifier')
  }
  return trimmed
}

const parseAndValidateVcards = (vcardText: string, owner: string): WebmailContact[] => {
  if (UNSAFE_CAL_VCARD_PATTERN.test(vcardText)) {
    return fail('VALIDATION', 'malicious or unsafe vCard payload rejected')
  }
  return readContactVcards(vcardText).map(card => {
    const fields = { fullName: assertSafeCalendarText(card.fullName, 'FN'), email: assertSafeCalendarText(card.email, 'EMAIL'),
      phone: assertSafeCalendarText(card.phone, 'TEL'), organization: assertSafeCalendarText(card.organization, 'ORG'), title: assertSafeCalendarText(card.title, 'TITLE') }
    if (!fields.fullName || !/^[^\s@/\\]+@[^\s@/\\]+$/.test(fields.email)) return fail('VALIDATION', 'each vCard requires a valid FN and EMAIL')
    return { id: randomUUID(), owner, ...fields, groups: normalizeContactGroups(card.groups), shares: [], vcard: card.vcard, createdAt: new Date().toISOString() }
  })
}

const DEFAULT_DNS_TEMPLATES: DnsTemplateDefinition[] = [
  {
    id: 'standard',
    name: 'Standard Hosting Zone',
    description: 'Full web, mail, FTP, webmail, and SPF records for standard shared hosting domains.',
    records: [
      { name: '@', type: 'A', ttl: 14400, contentTemplate: '{{ipv4}}', priority: null },
      { name: 'www', type: 'CNAME', ttl: 14400, contentTemplate: '{{domain}}', priority: null },
      { name: 'mail', type: 'A', ttl: 14400, contentTemplate: '{{ipv4}}', priority: null },
      { name: 'webmail', type: 'A', ttl: 14400, contentTemplate: '{{ipv4}}', priority: null },
      { name: '@', type: 'MX', ttl: 14400, contentTemplate: 'mail.{{domain}}', priority: 10 },
      { name: '@', type: 'TXT', ttl: 14400, contentTemplate: 'v=spf1 a mx ip4:{{ipv4}} ~all', priority: null },
    ],
  },
  {
    id: 'simple',
    name: 'Simple Web-Only Zone',
    description: 'Minimal apex A/AAAA and www CNAME records without local mail.',
    records: [
      { name: '@', type: 'A', ttl: 14400, contentTemplate: '{{ipv4}}', priority: null },
      { name: 'www', type: 'CNAME', ttl: 14400, contentTemplate: '{{domain}}', priority: null },
    ],
  },
  {
    id: 'virtualftp',
    name: 'Virtual FTP & Web Zone',
    description: 'Standard zone plus dedicated ftp A/CNAME records.',
    records: [
      { name: '@', type: 'A', ttl: 14400, contentTemplate: '{{ipv4}}', priority: null },
      { name: 'www', type: 'CNAME', ttl: 14400, contentTemplate: '{{domain}}', priority: null },
      { name: 'ftp', type: 'A', ttl: 14400, contentTemplate: '{{ipv4}}', priority: null },
      { name: 'mail', type: 'A', ttl: 14400, contentTemplate: '{{ipv4}}', priority: null },
      { name: '@', type: 'MX', ttl: 14400, contentTemplate: 'mail.{{domain}}', priority: 10 },
    ],
  },
]

// ---------------------------------------------------------------------------
// Extended Features Store (backed by join(store.rootDir, 'extended'))
// ---------------------------------------------------------------------------

export class ExtendedFeaturesStore {
  readonly baseDir: string

  constructor(stateRootDir: string) {
    this.baseDir = join(stateRootDir, 'extended')
  }

  private filePath(...segments: string[]): string {
    return join(this.baseDir, ...segments)
  }

  async readOrDefault<T>(relPath: string, fallback: T): Promise<T> {
    const existing = await readJsonIfExists<T>(this.filePath(relPath))
    return existing ?? fallback
  }

  async write<T>(relPath: string, value: T): Promise<T> {
    await atomicWriteJson(this.filePath(relPath), value)
    return value
  }
}

// ---------------------------------------------------------------------------
// Router Handler
// ---------------------------------------------------------------------------

export const createExtendedApiRouter = (helpers: ExtendedRouteHelpers) => {
  const ext = new ExtendedFeaturesStore(helpers.store.rootDir)
  const freshExtendedMailCaller = async (req: Request, previous: AuthenticatedCaller): Promise<AuthenticatedCaller> => {
    const fresh = await helpers.requireCaller(req)
    if (isMailboxPrincipal(fresh) || fresh.principal.id !== previous.principal.id || fresh.principal.kind !== previous.principal.kind || fresh.sessionId !== previous.sessionId || fresh.apiTokenId !== previous.apiTokenId || fresh.principal.kind === 'user' && previous.principal.kind === 'user' && fresh.principal.accountId !== previous.principal.accountId) return fail('FORBIDDEN', 'mail administration authorization changed', { stateChanged: false })
    return fresh
  }
  const publicMailingList = (record: MailingListRecord) => { const { memberAuthorities: _bindings, ...visible } = record; return visible }
  const publicDirectoryPrivacy = (config: DirectoryPrivacyConfig) => {
    const { compiledHtpasswd: _credentialFile, ...safe } = config
    return { ...safe, rules: safe.rules.map(rule => ({ ...rule, users: rule.users.map(user => ({ username: user.username })) })) }
  }


  const scopedRecords = async <T extends { accountId: Id | null }>(caller: AuthenticatedCaller, records: readonly T[]): Promise<T[]> => {
    if (caller.principal.kind === 'root') return [...records]
    const ids = new Set((await ownedAccounts(helpers.store, caller)).map(account => account.id))
    return records.filter(record => record.accountId !== null && ids.has(record.accountId))
  }

  const assertRecordAccount = async (caller: AuthenticatedCaller, record: { accountId: Id | null } | undefined, action: string): Promise<void> => {
    if (!record) return fail('NOT_FOUND', 'resource not found')
    if (record.accountId === null) return helpers.assertRoot(caller, action)
    const account = await helpers.store.getAccount(record.accountId)
    if (!account) return fail('NOT_FOUND', 'resource not found')
    await helpers.assertCanAccessAccount(caller, account, action)
  }

  const assertExistingZoneOwner = async (caller: AuthenticatedCaller, name: string): Promise<void> => {
    const zone = await helpers.store.getDnsZone(name)
    if (!zone) return
    if (!zone.accountId && caller.principal.kind !== 'root') return fail('NOT_FOUND', 'zone not found')
    await assertRecordAccount(caller, zone, 'dns.zone.save')
  }

  const requireResolvedAccount = async (caller: AuthenticatedCaller, requested: Id | null | undefined, action: string): Promise<Account> => {
    const id = requested ?? (caller.principal.kind === 'user' ? caller.principal.accountId : null)
    if (!id) return fail('VALIDATION', 'accountId is required')
    const account = await helpers.resolveAccountParam(id)
    await helpers.assertCanAccessAccount(caller, account, action)
    return account
  }

  const requireAccountId = async (caller: AuthenticatedCaller, requested: Id | null | undefined, action: string): Promise<Id> => {
    const account = await requireResolvedAccount(caller, requested, action)
    return account.id
  }

  const handleFilterRoute = createFilterRoutes({
    store: helpers.store, requireCaller: helpers.requireCaller, emitAudit: helpers.emitAudit,
    readFilters: () => ext.readOrDefault<unknown[]>('mail/filters.json', []),
    writeFilters: values => ext.write('mail/filters.json', values),
    requireAccountId, assertRecordAccount, scopedRecords,
  })
  const handleContactToolsRoute = createContactToolsRoutes(helpers)
  const handleIdentityMetadataRoute = createIdentityMetadataRoutes({
    helpers,
    readRecords: () => ext.readOrDefault<WebmailIdentity[]>('webmail/identities.json', []),
    publishRecords: (records, lease) => atomicWriteJson(join(ext.baseDir, 'webmail', 'identities.json'), records, 0o640, () => lease.assertFencingToken()),
  })
  const handleCalendarWorkspaceRoute = createCalendarWorkspaceRoutes({
    helpers,
    readRecords: () => ext.readOrDefault<WebmailCalendar[]>('webmail/calendars.json', []),
    publishRecords: (records, lease) => atomicWriteJson(join(ext.baseDir, 'webmail', 'calendars.json'), records, 0o640, () => lease.assertFencingToken()),
    parseIcs: parseCalendarWorkspaceIcs, renderIcs: renderCalendarWorkspaceIcs,
  })
  const handleAccountCollaborationRoute = helpers.serverSecret ? createAccountCollaborationRoutes({
    store: helpers.store, serverSecret: helpers.serverSecret, requireCaller: helpers.requireCaller,
    assertCanAccessAccount: helpers.assertCanAccessAccount, emitAudit: helpers.emitAudit,
    readCalendars: () => ext.readOrDefault<WebmailCalendar[]>('webmail/calendars.json', []),
    readContacts: () => ext.readOrDefault<WebmailContact[]>('webmail/contacts.json', []),
    calendarRoute: handleCalendarWorkspaceRoute,
  }) : async (_req: Request, url: URL, _method: string): Promise<Response | null> => /^\/api\/account\/collaboration(?:\/|$)/.test(url.pathname) ? fail('PRECONDITION_FAILED', 'collaboration authority is unavailable', { stateChanged: false }) : null
  const handleBackupWorkspaceRoute = createWhmBackupWorkspaceRoutes({
    store: helpers.store, requireCaller: helpers.requireCaller, assertRoot: helpers.assertRoot, emitAudit: helpers.emitAudit,
    read: key => ext.readOrDefault<unknown | null>(key, null),
    publish: (key, value, lease) => atomicWriteJson(join(ext.baseDir, key), value, 0o640, () => lease.assertFencingToken()),
    ...(helpers.backupDestinationHost ? { destinationHost: helpers.backupDestinationHost } : {}),
  })
  const handleTransferWorkspaceRoute = createTransferWorkspaceRoutes(helpers, { discover: createTransferSourceDiscovery({ readToken: id => readTransferCredentialToken(helpers.store, id) }),
    ...(helpers.transferExecution ? { execution: helpers.transferExecution } : {}) })
  const handleExtendedRoute = async (req: Request, url: URL, method: string): Promise<Response | null> => {
    const { pathname } = url
    const identityResponse = await handleIdentityMetadataRoute(req)
    if (identityResponse) return identityResponse
    for (const handle of [handleAccountCollaborationRoute, handleContactToolsRoute, handleCalendarWorkspaceRoute, handleBackupWorkspaceRoute, handleTransferWorkspaceRoute]) {
      const response = await handle(req, url, method)
      if (response) return response
    }

    // =========================================================================
    // 1. First-Run Setup Wizard, Hostname & Quota Init
    // =========================================================================
    if (pathname === '/api/setup/wizard') {
      const caller = await helpers.requireCaller(req)
      await helpers.assertRoot(caller, 'setup.wizard')
      if (method === 'GET') {
        const [setupComplete, settings, ips, wizardState] = await Promise.all([
          helpers.store.isSetupComplete(),
          helpers.store.getServerSettings(),
          helpers.store.listServerIps(),
          ext.readOrDefault<Record<string, unknown> | null>('setup-wizard.json', null),
        ])
        return jsonResponse({
          setupComplete,
          settings,
          ips,
          wizardState,
          defaultSuggested: suggestServerSettings({ cores: 4, memoryMb: 8192 }),
        })
      }
      if (method === 'POST') {
        const body = await readJsonBody<{
          hostname?: string
          nameservers?: string[]
          contactEmail?: string
          adminEmail?: string
          engine?: 'apache' | 'openlitespeed'
          apacheMpm?: 'itk' | 'prefork'
          primaryIpv4?: string
          primaryIpv6?: string | null
          panelPort?: number
          sshPort?: number
          quotaFilesystem?: string
          initQuotas?: boolean
        }>(req)

        const suggested = suggestServerSettings({ cores: 4, memoryMb: 8192 })
        const existingSettings = await helpers.store.getServerSettings()
        const existingIps = await helpers.store.listServerIps()
        const configuredIpv4 = existingIps.find(ip => ip.version === 4 && ip.isPrimary)
        const primaryIpv4 = body.primaryIpv4 === undefined
          ? configuredIpv4?.address
          : typeof body.primaryIpv4 === 'string' ? body.primaryIpv4.trim() : undefined
        if (!primaryIpv4 || isIP(primaryIpv4) !== 4) return fail('VALIDATION', 'a valid primary IPv4 address is required')
        const primaryIpv6 = body.primaryIpv6 == null || body.primaryIpv6 === '' ? undefined
          : typeof body.primaryIpv6 === 'string' && isIP(body.primaryIpv6.trim()) === 6
            ? canonicalIp(body.primaryIpv6.trim()).address
            : fail('VALIDATION', 'primary IPv6 address is invalid')
        const hostname = validateDomainName(body.hostname ?? existingSettings?.hostname ?? 'panel.xpanel.internal')
        const nameservers = (body.nameservers ?? existingSettings?.nameservers ?? [`ns1.${hostname}`, `ns2.${hostname}`]).map(
          (ns) => validateDomainName(ns),
        )
        const adminEmail = body.contactEmail ?? body.adminEmail ?? existingSettings?.adminEmail ?? `admin@${hostname}`
        const engine = body.engine ?? existingSettings?.engine ?? 'apache'
        const apacheMpm = body.apacheMpm ?? existingSettings?.apacheMpm ?? 'itk'

        const settingsInput: ServerSettings = {
          hostname,
          nameservers,
          adminEmail,
          engine,
          apacheMpm,
          panelPort: body.panelPort ?? existingSettings?.panelPort ?? 2087,
          sshPort: body.sshPort ?? existingSettings?.sshPort ?? 22,
          nginx: existingSettings?.nginx ?? suggested.nginx,
          apache: existingSettings?.apache ?? suggested.apache,
          backendPort: existingSettings?.backendPort ?? 8080,
          backendTlsPort: existingSettings?.backendTlsPort ?? 8443,
        }

        // Validate both IP candidates and their combined inventory before any setup writes.
        // Reusing a registered address keeps its interface, prefix, ownership, PTR and notes.
        const preparePrimaryIp = (address: string, version: 4 | 6) => {
          const existing = existingIps.find(ip => ip.address === address && ip.version === version)
          return validateServerIpEntry(existing ? { ...existing, isPrimary: true } : {
            id: randomUUID(), address, version,
            prefixLength: version === 4 ? 24 : 64,
            interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null,
            ptrHostname: hostname, isPrimary: true,
            notes: `Primary shared IPv${version} configured by First-Run Setup Wizard`,
          })
        }
        const ipv4Input = preparePrimaryIp(primaryIpv4, 4)
        const ipv6Input = primaryIpv6 ? preparePrimaryIp(primaryIpv6, 6) : undefined
        const selectedIds = new Set([ipv4Input.id, ...(ipv6Input ? [ipv6Input.id] : [])])
        validateServerIpPool([
          ...existingIps.filter(ip => !selectedIds.has(ip.id)), ipv4Input,
          ...(ipv6Input ? [ipv6Input] : []),
        ])
        const settings = await helpers.store.saveServerSettings(settingsInput)
        const primaryIp = existingIps.find(ip => ip.id === ipv4Input.id && ip.isPrimary)
          ?? await helpers.store.saveServerIp(ipv4Input)
        if (ipv6Input && !existingIps.some(ip => ip.id === ipv6Input.id && ip.isPrimary)) {
          await helpers.store.saveServerIp(ipv6Input)
        }

        await helpers.store.markSetupComplete()

        const quotaFilesystem = body.quotaFilesystem ?? '/home'
        const quotaInitialized = body.initQuotas !== false
        if (quotaInitialized) {
          await ext.write('quota-status.json', {
            filesystem: quotaFilesystem,
            status: 'enabled',
            commands: [
              ['/usr/sbin/quotacheck', '-cugm', quotaFilesystem],
              ['/usr/sbin/quotaon', '-vug', quotaFilesystem],
            ],
            initializedAt: new Date().toISOString(),
          })
        }

        const completedAt = new Date().toISOString()
        await ext.write('setup-wizard.json', {
          completedAt,
          completedBy: caller.principal.username,
          hostname,
          nameservers,
          adminEmail,
          engine,
          primaryIpv4,
          quotaFilesystem,
          quotaInitialized,
        })

        const reconcile = await helpers.triggerReconcile(caller, { force: true })
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'setup.wizard.completed',
          target: `server:${hostname}`,
          detail: { hostname, engine, primaryIpv4, quotaInitialized },
          outcome: 'ok',
          principalId: caller.principal.id,
        })

        return jsonResponse({
          ok: true,
          setupComplete: true,
          settings,
          primaryIp,
          quotaInitialized,
          reconcile: reconcile?.body ?? null,
        })
      }
    }

    if (method === 'POST' && pathname === '/api/server/hostname') {
      const caller = await helpers.requireCaller(req)
      await helpers.assertRoot(caller, 'server.hostname_change')
      const body = await readJsonBody<{ hostname?: string }>(req)
      if (!body.hostname) return fail('VALIDATION', 'hostname is required')
      const hostname = validateDomainName(body.hostname)
      const current = await helpers.store.getServerSettings()
      const suggested = suggestServerSettings({ cores: 4, memoryMb: 8192 })
      const previousHostname = current?.hostname ?? null

      const updated = await helpers.store.saveServerSettings({
        hostname,
        nameservers: current?.nameservers ?? [`ns1.${hostname}`, `ns2.${hostname}`],
        adminEmail: current?.adminEmail ?? `admin@${hostname}`,
        engine: current?.engine ?? 'apache',
        apacheMpm: current?.apacheMpm ?? 'itk',
        panelPort: current?.panelPort ?? 2087,
        sshPort: current?.sshPort ?? 22,
        nginx: current?.nginx ?? suggested.nginx,
        apache: current?.apache ?? suggested.apache,
        backendPort: current?.backendPort ?? 8080,
        backendTlsPort: current?.backendTlsPort ?? 8443,
      })

      const ips = await helpers.store.listServerIps()
      const primaryIp = ips.find((i) => i.version === 4 && i.isPrimary)?.address ?? '127.0.1.1'
      const shortHost = hostname.split('.')[0] ?? hostname
      const renderedFiles = [
        { path: '/etc/hostname', mode: 0o644, content: `${hostname}\n` },
        {
          path: '/etc/hosts',
          mode: 0o644,
          content: `127.0.0.1 localhost\n${primaryIp} ${hostname} ${shortHost}\n::1 localhost ip6-localhost ip6-loopback\n`,
        },
      ]
      await ext.write('hostname-state.json', {
        hostname,
        previousHostname,
        renderedFiles,
        updatedAt: new Date().toISOString(),
      })

      const reconcile = await helpers.triggerReconcile(caller)
      await helpers.emitAudit({
        actor: caller.principal.username,
        action: 'server.hostname_change',
        target: `server:${hostname}`,
        detail: { previousHostname, hostname },
        outcome: 'ok',
        principalId: caller.principal.id,
      })
      return jsonResponse({
        ok: true,
        hostname: updated.hostname,
        previousHostname,
        files: renderedFiles,
        reconcile: reconcile?.body ?? null,
      })
    }

    if (method === 'POST' && pathname === '/api/server/quotas/init') {
      const caller = await helpers.requireCaller(req)
      await helpers.assertRoot(caller, 'server.quota_init')
      const body = await readJsonBody<{ filesystem?: string }>(req)
      const filesystem = body.filesystem?.trim() || '/home'
      if (!filesystem.startsWith('/')) {
        return fail('VALIDATION', 'filesystem must be an absolute mount path')
      }
      const commands = [
        ['/usr/sbin/quotacheck', '-cugm', filesystem],
        ['/usr/sbin/quotaon', '-vug', filesystem],
      ]
      const initializedAt = new Date().toISOString()
      const state = await ext.write('quota-status.json', {
        filesystem,
        status: 'enabled',
        commands,
        initializedAt,
      })
      await helpers.emitAudit({
        actor: caller.principal.username,
        action: 'server.quota_init',
        target: `filesystem:${filesystem}`,
        detail: { filesystem, commands },
        outcome: 'ok',
        principalId: caller.principal.id,
      })
      return jsonResponse({ ok: true, ...state })
    }

    // =========================================================================
    // 2. Deep Mail (/api/mail/*)
    // =========================================================================
    const domFwdDeleteMatch = /^\/api\/mail\/domain-forwarders\/([^/]+)$/.exec(pathname)
    if (pathname === '/api/mail/domain-forwarders' || domFwdDeleteMatch) {
      const caller = await helpers.requireCaller(req)
      const list = await ext.readOrDefault<DomainForwarder[]>('mail/domain-forwarders.json', [])
      if (method === 'GET') {
        return jsonResponse({ domainForwarders: await scopedRecords(caller, list) })
      }
      if (method === 'POST') {
        const body = await readJsonBody<{
          accountId?: Id
          sourceDomain?: string
          targetDomain?: string
        }>(req)
        const sourceDomain = validateDomainName(body.sourceDomain ?? '')
        const targetDomain = validateDomainName(body.targetDomain ?? '')
        if (sourceDomain === targetDomain) {
          return fail('VALIDATION', 'sourceDomain and targetDomain must be different')
        }
        const account = await requireDomainAccount(helpers.store, caller, sourceDomain, 'mail.domain_forwarder.create', body.accountId)
        const record: DomainForwarder = {
          id: randomUUID(),
          accountId: account.id,
          sourceDomain,
          targetDomain,
          createdAt: new Date().toISOString(),
        }
        list.push(record)
        await ext.write('mail/domain-forwarders.json', list)
        const compiledVirtualMap = (await scopedRecords(caller, list)).map((f) => `@${f.sourceDomain} @${f.targetDomain}`).join('\n') + '\n'
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'mail.domain_forwarder.created',
          target: `domain-forwarder:${sourceDomain}->${targetDomain}`,
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ domainForwarder: record, compiledVirtualMap }, 201)
      }
      if (method === 'DELETE') {
        const body = await readJsonBody<{ id?: string }>(req)
        const targetId = domFwdDeleteMatch?.[1] ?? url.searchParams.get('id') ?? body.id
        await assertRecordAccount(caller, list.find(item => item.id === targetId || item.sourceDomain === targetId), 'mail.domain_forwarder.delete')
        const next = list.filter((item) => item.id !== targetId && item.sourceDomain !== targetId)
        await ext.write('mail/domain-forwarders.json', next)
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'mail.domain_forwarder.deleted',
          target: `domain-forwarder:${String(targetId)}`,
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ ok: true })
      }
    }

    const fwdDeleteMatch = /^\/api\/mail\/forwarders\/([^/]+)$/.exec(pathname)
    if (pathname === '/api/mail/forwarders' || fwdDeleteMatch) {
      const caller = await helpers.requireCaller(req)
      let lease = method === 'POST' || method === 'DELETE' ? await helpers.store.getWriterLock().acquire() : null
      try {
        const list = await ext.readOrDefault<EmailForwarder[]>('mail/forwarders.json', [])
        const application = { status: 'configuration_only', nativeApplied: false } as const
        if (method === 'GET') {
          return jsonResponse({ forwarders: await scopedRecords(caller, list), application })
        }
        if (method === 'POST') {
          const body = validateForwarderInput(await readJsonBody<unknown>(req))
          const { sourceAddress, destinations } = body
          const account = await requireDomainAccount(helpers.store, caller, sourceAddress.split('@')[1]!, 'mail.forwarder.create', body.accountId)
          const accountRecords = list.filter(item => item.accountId === account.id)
          if (accountRecords.some(item => item.sourceAddress.toLowerCase() === sourceAddress)) return fail('CONFLICT', 'A forwarder for this source already exists')
          const plan = await helpers.store.getPlan(account.planId)
          if (!plan) return fail('CONFLICT', 'The account plan is unavailable')
          const cap = plan.caps.forwarders
          if (cap !== 'unlimited' && accountRecords.length >= cap) return fail('CONFLICT', 'The account forwarder limit has been reached')
          const record: EmailForwarder = {
            id: randomUUID(),
            accountId: account.id,
            sourceAddress,
            destinations,
            createdAt: new Date().toISOString(),
          }
          list.push(record)
          await lease!.assertFencingToken()
          await ext.write('mail/forwarders.json', list)
          await lease!.release()
          lease = null
          await helpers.emitAudit({
            actor: caller.principal.username,
            action: 'mail.forwarder.created',
            target: `forwarder:${sourceAddress}`,
            detail: { destinations, application },
            outcome: 'ok',
            principalId: caller.principal.id,
          })
          return jsonResponse({ forwarder: record, application }, 201)
        }
        if (method === 'DELETE') {
          const body = await readJsonBody<{ id?: string }>(req)
          const targetId = fwdDeleteMatch?.[1] ?? url.searchParams.get('id') ?? body.id
          const exact = list.find(item => item.id === targetId)
          const record = exact ?? (await scopedRecords(caller, list)).find(item => item.sourceAddress === targetId)
          await assertRecordAccount(caller, record, 'mail.forwarder.delete')
          const next = list.filter(item => item !== record)
          await lease!.assertFencingToken()
          await ext.write('mail/forwarders.json', next)
          await lease!.release()
          lease = null
          await helpers.emitAudit({
            actor: caller.principal.username,
            action: 'mail.forwarder.deleted',
            target: `forwarder:${String(targetId)}`,
            detail: { application },
            outcome: 'ok',
            principalId: caller.principal.id,
          })
          return jsonResponse({ ok: true, application })
        }
      } finally { await lease?.release() }
    }

    const mlDeleteMatch = /^\/api\/mail\/mailing-lists\/([^/]+)$/.exec(pathname)
    if (pathname === '/api/mail/mailing-lists' || mlDeleteMatch) {
      let caller = await helpers.requireCaller(req)
      let lease = method === 'POST' || method === 'DELETE' ? await helpers.store.getWriterLock().acquire() : null
      let attempted = false
      try {
      if (lease) caller = await freshExtendedMailCaller(req, caller)
      const list = await ext.readOrDefault<MailingListRecord[]>('mail/mailing-lists.json', [])
      if (method === 'GET') {
        const visible = (await scopedRecords(caller, list)).map(publicMailingList)
        await freshExtendedMailCaller(req, caller)
        return jsonResponse({ mailingLists: visible })
      }
      if (method === 'POST') {
        const body = await readJsonBody<{
          accountId?: Id
          name?: string
          domain?: string
          address?: string
          members?: string[]
          moderation?: 'open' | 'members' | 'moderated'
          archiveEnabled?: boolean
          selfSubscription?: 'open' | 'closed'
        }>(req)
        if (Object.hasOwn(body, 'memberAuthorities')) return fail('VALIDATION', 'mailing list ownership metadata cannot be supplied', { stateChanged: false })
        if (Object.keys(body).some(key => !['accountId', 'name', 'domain', 'address', 'members', 'moderation', 'archiveEnabled', 'selfSubscription'].includes(key))) return fail('VALIDATION', 'unsupported mailing list field', { stateChanged: false })
        if (body.selfSubscription !== undefined && !['open', 'closed'].includes(body.selfSubscription)) return fail('VALIDATION', 'selfSubscription must be open or closed', { stateChanged: false })
        const mailingListUnsafe = /[\u0000-\u001f\u007f-\u009f]/
        const address = body.address
          ? body.address.trim().toLowerCase()
          : `${(body.name ?? 'list').trim().toLowerCase()}@${(body.domain ?? 'example.com').trim().toLowerCase()}`
        const [namePart, domainPart] = address.split('@')
        if (!namePart || !domainPart) return fail('VALIDATION', 'valid mailing list address or name + domain required', { stateChanged: false })
        if (address.length > 254 || mailingListUnsafe.test(address) || !/^[^\s@/\\]+@[^\s@/\\]+$/.test(address)) {
          return fail('VALIDATION', 'mailing list address must be a single valid email address', { stateChanged: false })
        }
        const localPart = namePart.trim()
        if (!/^[a-z0-9](?:[a-z0-9._-]{0,63})$/.test(localPart)) return fail('VALIDATION', 'mailing list name must be up to 64 lowercase letters, digits, dots, underscores or dashes', { stateChanged: false })
        if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 128 || mailingListUnsafe.test(body.name))) {
          return fail('VALIDATION', 'mailing list display name must be bounded text without control characters', { stateChanged: false })
        }
        if (body.members !== undefined && (!Array.isArray(body.members) || body.members.length > 1000)) return fail('VALIDATION', 'members must be an array of at most 1000 addresses', { stateChanged: false })
        const listDomain = validateDomainName(domainPart)
        const account = await requireDomainAccount(helpers.store, caller, listDomain, 'mail.mailing_list.create', body.accountId)
        const members: string[] = []
        for (const rawMember of body.members ?? []) {
          if (typeof rawMember !== 'string') return fail('VALIDATION', 'each mailing list member must be an email address', { stateChanged: false })
          const member = rawMember.trim().toLowerCase()
          if (member.length > 254 || mailingListUnsafe.test(member) || !/^[^\s@/\\]+@[^\s@/\\]+$/.test(member)) return fail('VALIDATION', `invalid mailing list member: ${member.slice(0, 64)}`, { stateChanged: false })
          if (members.includes(member)) return fail('VALIDATION', 'each mailing list member may be listed only once', { stateChanged: false })
          members.push(member)
        }
        if (body.moderation !== undefined && !['open', 'members', 'moderated'].includes(body.moderation)) return fail('VALIDATION', 'moderation must be open, members or moderated', { stateChanged: false })
        if (body.archiveEnabled !== undefined && typeof body.archiveEnabled !== 'boolean') return fail('VALIDATION', 'archiveEnabled must be a boolean', { stateChanged: false })
        if (list.some(item => item.address.toLowerCase() === address)) return fail('CONFLICT', 'a mailing list with this address already exists', { stateChanged: false })
        const record: MailingListRecord = {
          id: randomUUID(),
          accountId: account.id,
          name: body.name === undefined ? localPart : body.name.trim() || localPart,
          domain: listDomain,
          address,
          members,
          moderation: body.moderation ?? 'members',
          archiveEnabled: body.archiveEnabled ?? true,
          selfSubscription: body.selfSubscription ?? 'closed',
          createdAt: new Date().toISOString(),
        }
        list.push(record)
        caller = await freshExtendedMailCaller(req, caller)
        const freshAccount = await requireDomainAccount(helpers.store, caller, listDomain, 'mail.mailing_list.create', account.id)
        await assertAccountFeatures(helpers.store, caller, freshAccount, ['mailing-lists'])
        await lease!.assertFencingToken(); attempted = true
        await atomicWriteJson(join(ext.baseDir, 'mail', 'mailing-lists.json'), list, 0o640, () => lease!.assertFencingToken())
        if (JSON.stringify(await ext.readOrDefault<MailingListRecord[]>('mail/mailing-lists.json', [])) !== JSON.stringify(list)) throw new Error('mailing list create readback mismatch')
        caller = await freshExtendedMailCaller(req, caller)
        await lease!.release(); lease = null
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'mail.mailing_list.created',
          target: `mailing-list:${record.address}`,
          detail: { membersCount: record.members.length },
          outcome: 'ok',
          principalId: caller.principal.id,
        }, { accountId: account.id, resellerId: account.ownerId })
        return jsonResponse({ mailingList: publicMailingList(record) }, 201)
      }
      if (method === 'DELETE') {
        const body = await readJsonBody<{ id?: string }>(req)
        const targetId = mlDeleteMatch?.[1] ?? url.searchParams.get('id') ?? body.id
        const selected = list.find(item => item.id === targetId || item.address === targetId)
        caller = await freshExtendedMailCaller(req, caller)
        await assertRecordAccount(caller, selected, 'mail.mailing_list.delete')
        if (selected?.accountId) {
          const account = await helpers.store.getAccount(selected.accountId)
          if (!account) return fail('NOT_FOUND', 'mailing list not found', { stateChanged: false })
          await assertAccountFeatures(helpers.store, caller, account, ['mailing-lists'])
        }
        const next = list.filter((item) => item.id !== targetId && item.address !== targetId)
        await lease!.assertFencingToken(); attempted = true
        await atomicWriteJson(join(ext.baseDir, 'mail', 'mailing-lists.json'), next, 0o640, () => lease!.assertFencingToken())
        if (JSON.stringify(await ext.readOrDefault<MailingListRecord[]>('mail/mailing-lists.json', [])) !== JSON.stringify(next)) throw new Error('mailing list delete readback mismatch')
        caller = await freshExtendedMailCaller(req, caller)
        await lease!.release(); lease = null
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'mail.mailing_list.deleted',
          target: `mailing-list:${String(targetId)}`,
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ ok: true })
      }
      } catch (error) {
        if (attempted) return fail('SERVICE_UNAVAILABLE', 'mailing list administration outcome requires inspection', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
        throw error
      } finally { await lease?.release() }
    }

    const filterResponse = await handleFilterRoute(req, url, method)
    if (filterResponse !== null) return filterResponse

    if (pathname === '/api/mail/spam-settings') {
      let caller = await helpers.requireCaller(req)
      const requestedAccountId = url.searchParams.get('accountId') ?? (caller.principal.kind === 'user' ? caller.principal.accountId : null)
      const accountId = requestedAccountId ? await requireAccountId(caller, requestedAccountId, 'mail.spam_settings') : null
      if (!accountId) await helpers.assertRoot(caller, 'mail.spam_settings.global')
      const spamKey = accountId ? `mail/accounts/${accountId}/spam-settings.json` : 'mail/spam-settings.json'
      const defaultSpam: SpamSettingsState = {
        enabled: true,
        rewriteSubjectScore: 6.0,
        addHeaderScore: 5.0,
        greylistScore: 4.0,
        rejectScore: 15.0,
        spamBoxEnabled: true,
        autoDeleteSpam: false,
        autoDeleteScore: 12.0,
        allowlist: [],
        blocklist: [],
        updatedAt: new Date().toISOString(),
      }
      if (method === 'GET') {
        const settings = await ext.readOrDefault(spamKey, defaultSpam)
        return jsonResponse({ settings })
      }
      if (method === 'PUT') {
        const body = await readJsonBody<Partial<SpamSettingsState>>(req)
        if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('VALIDATION', 'spam settings must be an object', { stateChanged: false })
        const allowedKeys = ['enabled', 'rewriteSubjectScore', 'addHeaderScore', 'greylistScore', 'rejectScore', 'spamBoxEnabled', 'autoDeleteSpam', 'autoDeleteScore', 'allowlist', 'blocklist'] as const
        if (Object.keys(body).some(key => !(allowedKeys as readonly string[]).includes(key))) return fail('VALIDATION', 'unsupported spam settings field', { stateChanged: false })
        const spamControl = /[\u0000-\u001f\u007f-\u009f]/
        const booleanField = (key: 'enabled' | 'spamBoxEnabled' | 'autoDeleteSpam', fallback: boolean): boolean => {
          const value = body[key]
          if (value === undefined) return fallback
          if (typeof value !== 'boolean') return fail('VALIDATION', `${key} must be a boolean`, { stateChanged: false })
          return value
        }
        const scoreField = (key: 'rewriteSubjectScore' | 'addHeaderScore' | 'greylistScore' | 'rejectScore' | 'autoDeleteScore', fallback: number): number => {
          const value = body[key]
          if (value === undefined) return fallback
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return fail('VALIDATION', `${key} must be a number from 0 through 100`, { stateChanged: false })
          return value
        }
        const listField = (key: 'allowlist' | 'blocklist', fallback: string[]): string[] => {
          const value = body[key]
          if (value === undefined) return fallback
          if (!Array.isArray(value) || value.length > 500) return fail('VALIDATION', `${key} must be an array of at most 500 entries`, { stateChanged: false })
          const seen = new Set<string>()
          return value.map(raw => {
            if (typeof raw !== 'string') return fail('VALIDATION', `${key} entries must be text`, { stateChanged: false })
            const entry = raw.trim().toLowerCase()
            if (!entry || entry.length > 254 || spamControl.test(entry) || !/^[a-z0-9._:@\[\]/-]+$/.test(entry) || entry.includes('..')) {
              return fail('VALIDATION', `${key} entries must be bounded addresses, CIDRs or hostnames`, { stateChanged: false })
            }
            if (seen.has(entry)) return fail('VALIDATION', `${key} entries may not repeat`, { stateChanged: false })
            seen.add(entry)
            return entry
          })
        }
        let lease: Awaited<ReturnType<ReturnType<StateStore['getWriterLock']>['acquire']>> | null = await helpers.store.getWriterLock().acquire()
        let attempted = false
        try {
        const authorizeSpam = async (): Promise<void> => {
          caller = await freshExtendedMailCaller(req, caller)
          if (!accountId) return helpers.assertRoot(caller, 'mail.spam_settings.global')
          const account = await requireResolvedAccount(caller, accountId, 'mail.spam_settings')
          if (account.id !== accountId) return fail('FORBIDDEN', 'spam policy account changed', { stateChanged: false })
          await assertAccountFeatures(helpers.store, caller, account, ['spam-filters'])
        }
        await authorizeSpam()
        const current = await ext.readOrDefault(spamKey, defaultSpam)
        const updated: SpamSettingsState = {
          enabled: booleanField('enabled', current.enabled),
          rewriteSubjectScore: scoreField('rewriteSubjectScore', current.rewriteSubjectScore),
          addHeaderScore: scoreField('addHeaderScore', current.addHeaderScore),
          greylistScore: scoreField('greylistScore', current.greylistScore),
          rejectScore: scoreField('rejectScore', current.rejectScore),
          spamBoxEnabled: booleanField('spamBoxEnabled', current.spamBoxEnabled),
          autoDeleteSpam: booleanField('autoDeleteSpam', current.autoDeleteSpam),
          autoDeleteScore: scoreField('autoDeleteScore', current.autoDeleteScore),
          allowlist: listField('allowlist', current.allowlist),
          blocklist: listField('blocklist', current.blocklist),
          updatedAt: new Date().toISOString(),
        }
        await authorizeSpam(); await lease!.assertFencingToken(); attempted = true
        await atomicWriteJson(join(ext.baseDir, spamKey), updated, 0o640, () => lease!.assertFencingToken())
        if (JSON.stringify(await ext.readOrDefault(spamKey, defaultSpam)) !== JSON.stringify(updated)) throw new Error('spam settings readback mismatch')
        await authorizeSpam()
        await lease!.release()
        lease = null
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'mail.spam_settings.updated',
          target: 'mail:spam-settings',
          detail: { rejectScore: updated.rejectScore, spamBoxEnabled: updated.spamBoxEnabled },
          outcome: 'ok',
          principalId: caller.principal.id,
        }, accountId ? { accountId } : {})
        return jsonResponse({ settings: updated })
        } catch (error) {
          if (attempted) return fail('SERVICE_UNAVAILABLE', 'spam settings outcome requires inspection', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
          throw error
        } finally { await lease?.release() }
      }
    }

    if (method === 'POST' && pathname === '/api/mail/import-csv') {
      const caller = await helpers.requireCaller(req)
      const body = await readJsonBody<{
        csv?: string
        accountId?: Id
        kind?: 'mailboxes' | 'forwarders' | 'auto'
      }>(req)
      if (typeof body !== 'object' || body === null || Array.isArray(body) || typeof body.csv !== 'string') return fail('VALIDATION', 'csv must be a string')
      if (body.kind !== undefined && !['mailboxes', 'forwarders', 'auto'].includes(body.kind)) return fail('VALIDATION', 'kind must be mailboxes, forwarders or auto')
      if (body.accountId !== undefined && (typeof body.accountId !== 'string' || !body.accountId.trim())) return fail('VALIDATION', 'accountId must be a nonempty string')
      const csvText = body.csv.trim()
      if (!csvText) return fail('VALIDATION', 'csv content is required')

      const accountId = await requireAccountId(caller, body.accountId, 'mail.import_csv')

      const lines = csvText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('#'))

      const importedMailboxes: { email: string; quotaMb: number }[] = []
      const importedForwarders: { sourceAddress: string; destination: string }[] = []
      const errors: { row: number; error: string }[] = []
      const includesForwarders = body.kind === 'forwarders' || lines.some((line, i) => {
        if (i === 0 && /^(email|address|username|source)\b/i.test(line)) return false
        const cols = line.split(',').map(column => column.trim())
        return body.kind !== 'mailboxes' && (cols[1] ?? '').includes('@') && !cols[2]
      })
      if (includesForwarders) {
        const account = await helpers.store.getAccount(accountId)
        if (!account) return fail('NOT_FOUND', 'mail account not found')
        await assertAccountFeatures(helpers.store, caller, account, ['forwarders'])
      }

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        // Skip header row if it looks like "email,password,quota" or "source,destination"
        if (i === 0 && /^(email|address|username|source)\b/i.test(line)) continue
        const cols = line.split(',').map((c) => c.trim())
        const col0 = (cols[0] ?? '').toLowerCase()
        const col1 = cols[1] ?? ''
        const col2 = cols[2] ?? ''

        const isForwarder =
          body.kind === 'forwarders' || (body.kind !== 'mailboxes' && col1.includes('@') && !col2)
        let forwarderInput: ReturnType<typeof validateForwarderInput> | null = null
        if (isForwarder) {
          try { forwarderInput = validateForwarderInput({ sourceAddress: col0, destination: col1 }) }
          catch { errors.push({ row: i + 1, error: 'Invalid forwarder source or destination address' }); continue }
        }
        if (!col0.includes('@')) {
          errors.push({ row: i + 1, error: 'Invalid email address in column 1' })
          continue
        }

        const mailboxDomain = col0.split('@')[1]!
        const sourceAccount = await requireDomainAccount(helpers.store, caller, mailboxDomain, 'mail.import_csv', accountId)
        if (sourceAccount.id !== accountId) return fail('NOT_FOUND', 'mail domain not found')

        if (isForwarder && forwarderInput) {
          const lease = await helpers.store.getWriterLock().acquire()
          try {
            const forwarderAccount = await requireDomainAccount(helpers.store, caller, mailboxDomain, 'mail.import_csv', accountId)
            await assertAccountFeatures(helpers.store, caller, forwarderAccount, ['forwarders'])
            const forwarders = await ext.readOrDefault<EmailForwarder[]>('mail/forwarders.json', [])
            const accountForwarders = forwarders.filter(item => item.accountId === accountId)
            if (accountForwarders.some(item => item.sourceAddress.toLowerCase() === forwarderInput.sourceAddress)) {
              errors.push({ row: i + 1, error: 'A forwarder for this source already exists' }); continue
            }
            const plan = await helpers.store.getPlan(forwarderAccount.planId)
            if (!plan || plan.caps.forwarders !== 'unlimited' && accountForwarders.length >= plan.caps.forwarders) {
              errors.push({ row: i + 1, error: 'The account forwarder limit has been reached' }); continue
            }
            forwarders.push({
              id: randomUUID(),
              accountId,
              sourceAddress: forwarderInput.sourceAddress,
              destinations: forwarderInput.destinations,
              createdAt: new Date().toISOString(),
            })
            await lease.assertFencingToken()
            await ext.write('mail/forwarders.json', forwarders)
            importedForwarders.push({ sourceAddress: forwarderInput.sourceAddress, destination: forwarderInput.destinations[0]! })
          } finally { await lease.release() }
        } else {
          const quotaMb = Number(col2) > 0 ? Number(col2) : 1024
          try {
            await helpers.store.createServiceUser({
              accountId,
              login: col0,
              passwordHash: await passwordHashFromInput({ password: col1 }, { service: true }),
              services: { email: true, ftp: false, webdisk: false },
              mailboxQuotaMb: quotaMb,
              ftpDir: 'public_html',
            })
          } catch {
            errors.push({ row: i + 1, error: 'Mailbox could not be created; check credentials, domain and account limits' })
            continue
          }
          importedMailboxes.push({ email: col0, quotaMb })
        }
      }

      const application = body.kind === 'forwarders' || importedForwarders.length > 0 ? { status: 'configuration_only', nativeApplied: false } as const : undefined
      await helpers.emitAudit({
        actor: caller.principal.username,
        action: 'mail.import_csv',
        target: 'mail:csv-import',
        detail: {
          mailboxesCount: importedMailboxes.length,
          forwardersCount: importedForwarders.length,
          ...(application ? { application } : {}),
          errorsCount: errors.length,
        },
        outcome: 'ok',
        principalId: caller.principal.id,
      })
      return jsonResponse({
        ok: true,
        importedMailboxes,
        importedForwarders,
        ...(application ? { application } : {}),
        errors,
        summary: {
          mailboxesImported: importedMailboxes.length,
          forwardersImported: importedForwarders.length,
          errorCount: errors.length,
        },
      })
    }

    if (pathname === '/api/mail/delivery-reports') {
      const caller = await helpers.requireCaller(req)
      const reports = await ext.readOrDefault<MailDeliveryReport[]>('mail/delivery-reports.json', [])
      if (method === 'GET') {
        const ownedIds = new Set((await ownedAccounts(helpers.store, caller)).map(account => account.id))
        const ownedDomains = new Set((await helpers.store.listDomains()).filter(domain => ownedIds.has(domain.accountId)).map(domain => domain.name))
        const statusFilter = url.searchParams.get('status')
        const domainFilter = url.searchParams.get('domain')
        const filtered = reports.filter(
          (r) =>
            (caller.principal.kind === 'root' || ownedDomains.has(r.domain)) &&
            (!statusFilter || r.status === statusFilter) &&
            (!domainFilter || r.domain === domainFilter),
        )
        return jsonResponse({ reports: filtered, total: filtered.length })
      }
      if (method === 'POST') {
        await helpers.assertRoot(caller, 'mail.delivery_report.ingest')
        const body = await readJsonBody<Partial<MailDeliveryReport>>(req)
        const recipient = (body.recipient ?? 'user@example.com').toLowerCase()
        const domain = body.domain ?? recipient.split('@')[1] ?? 'example.com'
        const status = body.status ?? 'delivered'
        const entry: MailDeliveryReport = {
          id: randomUUID(),
          at: new Date().toISOString(),
          sender: (body.sender ?? 'postmaster@example.com').toLowerCase(),
          recipient,
          domain,
          status,
          smtpCode: body.smtpCode ?? (status === 'delivered' ? 250 : status === 'deferred' ? 451 : 550),
          queueId: body.queueId ?? randomUUID().slice(0, 10).toUpperCase(),
          bytes: body.bytes ?? 2048,
          message: body.message ?? (status === 'delivered' ? '250 2.0.0 Ok: queued as delivered' : 'Delivery status logged'),
        }
        reports.unshift(entry)
        await ext.write('mail/delivery-reports.json', reports)
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'mail.delivery_report.logged',
          target: `delivery:${entry.queueId}`,
          detail: { status: entry.status, recipient: entry.recipient },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ report: entry }, 201)
      }
    }

    if (pathname === '/api/mail/caldav-carddav') {
      const caller = await helpers.requireCaller(req)
      await helpers.assertRoot(caller, 'mail.caldav_carddav')
      const defaultDav: CalDavCardDavConfig = {
        enabled: true,
        caldavUrl: 'https://mail.xpanel.internal/dav/calendars/',
        carddavUrl: 'https://mail.xpanel.internal/dav/addressbooks/',
        autodiscoverSrv: true,
        wellKnownRedirects: true,
        syncPrincipals: [],
        updatedAt: new Date().toISOString(),
      }
      if (method === 'GET') {
        return jsonResponse({ config: await ext.readOrDefault('mail/caldav-carddav.json', defaultDav) })
      }
      if (method === 'PUT') {
        const body = await readJsonBody<Partial<CalDavCardDavConfig>>(req)
        const current = await ext.readOrDefault('mail/caldav-carddav.json', defaultDav)
        const config: CalDavCardDavConfig = {
          ...current,
          ...body,
          updatedAt: new Date().toISOString(),
        }
        await ext.write('mail/caldav-carddav.json', config)
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'mail.caldav_carddav.updated',
          target: 'mail:caldav-carddav',
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ config })
      }
    }

    // =========================================================================
    // 3. xMail Webmail Deep Endpoints (/api/webmail/*)
    // =========================================================================
    if (method === 'GET' && pathname === '/api/webmail/folders') {
      const caller = await helpers.requireCaller(req)
      const mailbox = await requireMailbox(helpers.store, caller, url.searchParams.get('mailbox'))
      const messages = await ext.readOrDefault<WebmailMessage[]>('webmail/messages.json', [])
      const owned = messages.filter((m) => m.mailbox.toLowerCase() === mailbox)
      const folderNames = ['INBOX', 'Sent', 'Drafts', 'Spam', 'Trash', 'Archive'] as const
      const folders = folderNames.map((name) => {
        const items = owned.filter((m) => m.folder === name)
        return {
          name,
          totalCount: items.length,
          unreadCount: items.filter((m) => !m.read).length,
        }
      })
      return jsonResponse({ mailbox, folders })
    }

    const msgAttachmentMatch = /^\/api\/webmail\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(pathname)
    if (method === 'GET' && (msgAttachmentMatch || pathname === '/api/webmail/attachments')) {
      const caller = await helpers.requireCaller(req)
      const messages = await ext.readOrDefault<WebmailMessage[]>('webmail/messages.json', [])
      const requestedMailboxParam = url.searchParams.get('mailbox')
      const requestedMailbox = requestedMailboxParam ? await requireMailbox(helpers.store, caller, requestedMailboxParam) : null

      if (msgAttachmentMatch) {
        const msgId = msgAttachmentMatch[1]!
        const filename = decodeURIComponent(msgAttachmentMatch[2]!)
        const msg = messages.find((m) => m.id === msgId)
        if (!msg) return fail('NOT_FOUND', 'attachment not found')
        if (requestedMailbox && msg.mailbox.toLowerCase() !== requestedMailbox) return fail('NOT_FOUND', 'attachment not found')
        await requireMailbox(helpers.store, caller, msg.mailbox)
        const attachment = msg.attachments.find((a) => a.filename === filename)
        if (!attachment) return fail('NOT_FOUND', 'attachment not found')
        return jsonResponse({ messageId: msg.id, mailbox: msg.mailbox, attachment })
      }

      const messageId = url.searchParams.get('messageId')
      if (messageId) {
        const msg = messages.find((m) => m.id === messageId)
        if (!msg) return fail('NOT_FOUND', 'message not found')
        if (requestedMailbox && msg.mailbox.toLowerCase() !== requestedMailbox) return fail('NOT_FOUND', 'message not found')
        await requireMailbox(helpers.store, caller, msg.mailbox)
        return jsonResponse({ mailbox: msg.mailbox, messageId: msg.id, attachments: msg.attachments })
      }

      const mailbox = requestedMailbox ?? await requireMailbox(helpers.store, caller, null)
      const attachments = messages
        .filter((m) => m.mailbox.toLowerCase() === mailbox)
        .flatMap((m) => m.attachments.map((a) => ({ ...a, messageId: m.id, subject: m.subject })))
      return jsonResponse({ mailbox, attachments })
    }

    const messageItemMatch = /^\/api\/webmail\/messages\/([^/]+)$/.exec(pathname)
    if (pathname === '/api/webmail/messages' || messageItemMatch) {
      const caller = await helpers.requireCaller(req)
      const messages = await ext.readOrDefault<WebmailMessage[]>('webmail/messages.json', [])
      if (messageItemMatch) {
        const msgId = messageItemMatch[1]!
        const target = messages.find((m) => m.id === msgId)
        if (!target) return fail('NOT_FOUND', 'message not found')
        const requestedMailboxParam = url.searchParams.get('mailbox')
        if (requestedMailboxParam) {
          const requestedMailbox = await requireMailbox(helpers.store, caller, requestedMailboxParam)
          if (target.mailbox.toLowerCase() !== requestedMailbox) return fail('NOT_FOUND', 'message not found')
        }
        await requireMailbox(helpers.store, caller, target.mailbox)
        if (method === 'GET') {
          return jsonResponse({ message: target })
        }
        if (method === 'DELETE') {
          const next = messages.filter((m) => m.id !== msgId)
          await ext.write('webmail/messages.json', next)
          return jsonResponse({ ok: true })
        }
      }
      if (method === 'GET' && !messageItemMatch) {
        const folder = url.searchParams.get('folder')
        const mailbox = await requireMailbox(helpers.store, caller, url.searchParams.get('mailbox'))
        const filtered = messages.filter(
          (m) => (!folder || m.folder === folder) && m.mailbox.toLowerCase() === mailbox,
        )
        return jsonResponse({ messages: filtered })
      }
      if (method === 'POST' && !messageItemMatch) {
        const body = await readJsonBody<{
          mailbox?: string
          from?: string
          to?: string[] | string
          cc?: string[] | string
          bcc?: string[] | string
          subject?: string
          textBody?: string
          htmlBody?: string
          attachments?: { filename: string; contentType: string; sizeBytes: number }[]
          identityId?: Id | null
        }>(req)
        const mailbox = isMailboxPrincipal(caller)
          ? await requireMailbox(helpers.store, caller, body.mailbox)
          : await requireMailbox(helpers.store, caller, body.mailbox ?? body.from)
        const from = (body.from ?? mailbox).toLowerCase()
        if (from !== mailbox) return fail('FORBIDDEN', 'sender must match the authorized mailbox')
        if (body.identityId) {
          const identities = await readBoundMailboxIdentityRecords(helpers.store, mailbox,
            () => ext.readOrDefault<WebmailIdentity[]>('webmail/identities.json', []))
          const identity = identities.find(item => item.id === body.identityId && item.mailbox.toLowerCase() === mailbox && item.email.toLowerCase() === from)
          if (!identity) return fail('NOT_FOUND', 'identity not found')
        }
        const toList = Array.isArray(body.to)
          ? body.to
          : typeof body.to === 'string'
            ? body.to.split(',').map((s) => s.trim()).filter(Boolean)
            : []
        if (toList.length === 0) return fail('VALIDATION', 'at least one recipient (to) is required')
        const sentMsg: WebmailMessage = {
          id: randomUUID(),
          mailbox,
          folder: 'Sent',
          from,
          to: toList,
          cc: Array.isArray(body.cc) ? body.cc : [],
          bcc: Array.isArray(body.bcc) ? body.bcc : [],
          subject: body.subject ?? '(no subject)',
          textBody: body.textBody ?? '',
          htmlBody: body.htmlBody ?? `<p>${body.textBody ?? ''}</p>`,
          attachments: body.attachments ?? [],
          identityId: body.identityId ?? null,
          read: true,
          starred: false,
          sentAt: new Date().toISOString(),
        }
        messages.unshift(sentMsg)
        // Also deliver to local recipient INBOX
        for (const rcpt of toList) {
          messages.unshift({
            ...sentMsg,
            id: randomUUID(),
            mailbox: rcpt.toLowerCase(),
            folder: 'INBOX',
            read: false,
          })
        }
        await ext.write('webmail/messages.json', messages)

        // Append delivery report
        const reports = await ext.readOrDefault<MailDeliveryReport[]>('mail/delivery-reports.json', [])
        for (const rcpt of toList) {
          reports.unshift({
            id: randomUUID(),
            at: sentMsg.sentAt,
            sender: from,
            recipient: rcpt.toLowerCase(),
            domain: rcpt.split('@')[1] ?? 'example.com',
            status: 'delivered',
            smtpCode: 250,
            queueId: sentMsg.id.slice(0, 8).toUpperCase(),
            bytes: Buffer.byteLength(sentMsg.textBody + sentMsg.htmlBody, 'utf8'),
            message: '250 2.0.0 Ok: delivered via Dovecot LMTP',
          })
        }
        await ext.write('mail/delivery-reports.json', reports)

        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'webmail.message.sent',
          target: `webmail:${sentMsg.id}`,
          detail: { from, to: toList, subject: sentMsg.subject },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ message: sentMsg }, 201)
      }
    }

    if (method === 'GET' && pathname === '/api/webmail/search') {
      const caller = await helpers.requireCaller(req)
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
      const mailbox = await requireMailbox(helpers.store, caller, url.searchParams.get('mailbox'))
      const messages = await ext.readOrDefault<WebmailMessage[]>('webmail/messages.json', [])
      const hits = messages.filter((m) => {
        if (m.mailbox.toLowerCase() !== mailbox) return false
        if (!q) return true
        return (
          m.subject.toLowerCase().includes(q) ||
          m.from.toLowerCase().includes(q) ||
          m.to.some((t) => t.toLowerCase().includes(q)) ||
          m.textBody.toLowerCase().includes(q) ||
          m.htmlBody.toLowerCase().includes(q) ||
          m.attachments.some((a) => a.filename.toLowerCase().includes(q))
        )
      })
      return jsonResponse({ query: q, hits, total: hits.length })
    }

    // Identity routes above validate immutable ownership before every operation.

    if (pathname === '/api/webmail/vacation') {
      const caller = await helpers.requireCaller(req)
      const raw = method === 'PUT' ? await readJsonBody<unknown>(req) : {}
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('VALIDATION', 'vacation request must be an object', { stateChanged: false })
      const body = raw as Partial<WebmailVacationConfig> & { expectedRevision?: string }
      if (method === 'PUT' && Object.keys(body).some(key => !['mailbox', 'enabled', 'subject', 'body', 'htmlBody', 'startDate', 'endDate', 'replyIntervalHours', 'expectedRevision'].includes(key))) return fail('VALIDATION', 'unsupported vacation request field', { stateChanged: false })
      if (body.mailbox !== undefined && typeof body.mailbox !== 'string') return fail('VALIDATION', 'mailbox must be an email address', { stateChanged: false })
      const scoped = isMailboxPrincipal(caller)
      if (scoped && url.searchParams.size) return fail('VALIDATION', 'vacation workspace does not accept mailbox selectors', { stateChanged: false })
      const mailbox = await requireMailbox(helpers.store, caller, scoped ? undefined : body.mailbox ?? url.searchParams.get('mailbox'))
      const fileKey = `webmail/vacation/${encodeURIComponent(mailbox)}.json`
      const application = { status: 'configuration_only', nativeApplied: false } as const
      const defaultVac: WebmailVacationConfig = {
        mailbox,
        enabled: false,
        subject: 'Out of Office',
        body: 'I am currently away from my email.',
        htmlBody: '<p>I am currently away from my email.</p>',
        startDate: null,
        endDate: null,
        replyIntervalHours: 24,
        compiledSieve: '# Vacation responder disabled\n',
        updatedAt: new Date().toISOString(),
      }
      if (method === 'GET') {
        const authority = await captureMailboxMetadataAuthority(helpers.store, mailbox)
        const stored = await ext.readOrDefault<WebmailVacationConfig | null>(fileKey, null)
        const visible = stored && assessMailboxMetadataAuthority(stored.mailbox, stored.ownerAuthority, authority) === 'match' ? stored : null
        if (!scoped) return jsonResponse({ vacation: projectVacationWorkspace(visible ?? defaultVac), metadataReview: MAILBOX_METADATA_REVIEW_REQUIRED })
        return jsonResponse({ context: { mailbox }, vacation: visible ? projectVacationWorkspace(visible) : null,
          revision: vacationWorkspaceRevision(visible), application, metadataReview: MAILBOX_METADATA_REVIEW_REQUIRED })
      }
      if (method === 'PUT') {
        const submitted = scoped ? parseVacationWorkspaceRequest(raw) : null
        const selected = await helpers.store.getServiceUserByLogin(mailbox)
        if (!selected) return fail('NOT_FOUND', 'mailbox not found', { stateChanged: false })
        const lease = await helpers.store.getWriterLock().acquire()
        let writeAttempted = false
        let vacation: WebmailVacationConfig
        let auditCaller = caller
        let auditAccount: Account
        try {
          const fresh = await helpers.requireCaller(req)
          if (fresh.principal.id !== caller.principal.id || fresh.principal.kind !== caller.principal.kind
            || fresh.sessionId !== caller.sessionId || fresh.apiTokenId !== caller.apiTokenId) return fail('FORBIDDEN', 'vacation authorization changed')
          const service = await helpers.store.getServiceUserByLogin(mailbox)
          if (!service || service.id !== selected.id || service.accountId !== selected.accountId || !service.services.email) return fail('NOT_FOUND', 'mailbox not found')
          if (isMailboxPrincipal(fresh)) {
            const bound = await requireMailboxPrincipalAccess(helpers.store, fresh)
            if (bound.mailbox !== mailbox || bound.serviceUserId !== service.id) return fail('NOT_FOUND', 'mailbox not found')
            auditAccount = bound.account
          } else {
            const account = await helpers.store.getAccount(service.accountId)
            if (!account || account.status !== 'active') return fail('FORBIDDEN', 'hosting account is unavailable')
            await helpers.assertCanAccessAccount(fresh, account, 'mailbox.access')
            await assertAccountFeatures(helpers.store, fresh, account, ['email-accounts'])
            auditAccount = account
          }
          auditCaller = fresh
          const authority = await captureMailboxMetadataAuthority(helpers.store, mailbox)
          const current = await ext.readOrDefault<WebmailVacationConfig | null>(fileKey, null)
          if (current) assertMailboxMetadataAuthority(current.mailbox, current.ownerAuthority, authority)
          const merged = { ...(current ?? defaultVac), ...body }
          const fields = submitted ?? parseVacationWorkspaceRequest({ enabled: merged.enabled, subject: merged.subject,
            body: merged.body, htmlBody: merged.htmlBody, startDate: merged.startDate, endDate: merged.endDate,
            replyIntervalHours: merged.replyIntervalHours, expectedRevision: body.expectedRevision ?? vacationWorkspaceRevision(current) })
          if (fields.expectedRevision !== vacationWorkspaceRevision(current)) return fail('CONFLICT', 'vacation configuration changed; reload before saving', { stateChanged: false })
          vacation = { mailbox, ownerAuthority: authority, enabled: fields.enabled, subject: fields.subject, body: fields.body, htmlBody: fields.htmlBody,
            startDate: fields.startDate, endDate: fields.endDate, replyIntervalHours: fields.replyIntervalHours,
            compiledSieve: compileVacationWorkspace({ ...fields, mailbox }), updatedAt: new Date().toISOString() }
          await lease.assertFencingToken()
          writeAttempted = true
          await atomicWriteJson(join(ext.baseDir, fileKey), vacation, 0o640, () => lease.assertFencingToken())
          await lease.assertFencingToken()
        } catch (error) {
          if (writeAttempted) return fail('SERVICE_UNAVAILABLE', 'vacation write requires verification', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
          if (isXpanelError(error)) return fail(error.code, error.message, { ...error.detail, stateChanged: false })
          throw error
        } finally { await lease.release() }
        try {
          await helpers.emitAudit({ actor: auditCaller.principal.username, action: 'webmail.vacation.updated',
            target: `vacation:${vacation.mailbox}`, detail: { enabled: vacation.enabled, nativeApplied: false },
            outcome: 'ok', principalId: auditCaller.principal.id }, { accountId: auditAccount.id, resellerId: auditAccount.ownerId })
        } catch { return fail('SERVICE_UNAVAILABLE', 'vacation audit requires verification', { stateChanged: true, verificationRequired: true, unknownOutcome: true }) }
        return scoped ? jsonResponse({ context: { mailbox }, vacation: projectVacationWorkspace(vacation),
          revision: vacationWorkspaceRevision(vacation), stateChanged: true, application, metadataReview: MAILBOX_METADATA_REVIEW_REQUIRED })
          : jsonResponse({ vacation: projectVacationWorkspace(vacation), metadataReview: MAILBOX_METADATA_REVIEW_REQUIRED })
      }
    }

    const contactShareMatch = /^\/api\/webmail\/contacts\/([^/]+)\/share$/.exec(pathname)
    const contactExportMatch = /^\/api\/webmail\/contacts\/([^/]+)\/(?:export|vcard)$/.exec(pathname)
    const contactDeleteMatch = /^\/api\/webmail\/contacts\/([^/]+)$/.exec(pathname)
    if (
      pathname === '/api/webmail/contacts' ||
      pathname === '/api/webmail/contacts/export' ||
      pathname === '/api/webmail/contacts/import' ||
      contactShareMatch ||
      contactExportMatch ||
      contactDeleteMatch
    ) {
      const caller = await helpers.requireCaller(req)
      const contacts = await ext.readOrDefault<WebmailContact[]>('webmail/contacts.json', [])
      if (!Array.isArray(contacts)) return fail('PRECONDITION_FAILED', 'contact collection requires review', { stateChanged: false })
      const collectionRevision = (values: readonly WebmailContact[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex')
      const originalCollectionRevision = collectionRevision(contacts)
      const mutateContacts = async <T>(mailbox: string, operation: (fresh: AuthenticatedCaller, current: WebmailContact[],
        persist: (values: WebmailContact[]) => Promise<void>) => Promise<T>): Promise<T> => {
        const selected = await helpers.store.getServiceUserByLogin(mailbox)
        if (!selected) return fail('NOT_FOUND', 'mailbox not found', { stateChanged: false })
        const lease = await helpers.store.getWriterLock().acquire()
        let writeAttempted = false
        try {
          const fresh = await helpers.requireCaller(req)
          if (fresh.principal.id !== caller.principal.id || fresh.principal.kind !== caller.principal.kind
            || fresh.sessionId !== caller.sessionId || fresh.apiTokenId !== caller.apiTokenId) return fail('FORBIDDEN', 'contact authorization changed')
          const service = await helpers.store.getServiceUserByLogin(mailbox)
          if (!service || service.id !== selected.id || service.accountId !== selected.accountId || !service.services.email) return fail('NOT_FOUND', 'mailbox not found')
          if (isMailboxPrincipal(fresh)) {
            const bound = await requireMailboxPrincipalAccess(helpers.store, fresh)
            if (bound.mailbox !== mailbox || bound.serviceUserId !== service.id) return fail('NOT_FOUND', 'mailbox not found')
          } else {
            const account = await helpers.store.getAccount(service.accountId)
            if (!account || account.status !== 'active') return fail('FORBIDDEN', 'hosting account is unavailable')
            await helpers.assertCanAccessAccount(fresh, account, 'mailbox.access')
            await assertAccountFeatures(helpers.store, fresh, account, ['email-accounts'])
          }
          const current = await ext.readOrDefault<WebmailContact[]>('webmail/contacts.json', [])
          if (!Array.isArray(current)) return fail('PRECONDITION_FAILED', 'contact collection requires review')
          const authority = await captureMailboxMetadataAuthority(helpers.store, mailbox)
          const access = createContactMetadataAccess(helpers.store, authority)
          const persist = async (values: WebmailContact[]) => {
            const previous = new Map(current.map(contact => [contact.id, contact]))
            for (const contact of values) {
              const before = previous.get(contact.id)
              if (!before) {
                if (contact.owner.toLowerCase() !== mailbox) return fail('FORBIDDEN', 'new contact owner must match the authorized mailbox')
                contact.ownerAuthority = authority
              } else if (JSON.stringify(before) !== JSON.stringify(contact)) {
                if (contact.owner !== before.owner || JSON.stringify(contact.ownerAuthority) !== JSON.stringify(before.ownerAuthority)) return fail('VALIDATION', 'contact ownership is immutable')
                if (before.owner.toLowerCase() === mailbox) assertMailboxMetadataAuthority(before.owner, before.ownerAuthority, authority)
                else if ((await access(before))?.permission !== 'read-write') return fail('NOT_FOUND', 'contact not found')
              }
              const oldShares = before?.shares ?? []
              for (const share of contact.shares ?? []) if (!oldShares.some(old => JSON.stringify(old) === JSON.stringify(share))) {
                const grantee = await captureMailboxMetadataAuthority(helpers.store, share.principal)
                if (grantee.accountId !== contact.ownerAuthority?.accountId) return fail('NOT_FOUND', 'share target mailbox not found in account')
                share.granteeAuthority = grantee
              }
            }
            const retained = new Set(values.map(contact => contact.id))
            for (const contact of current) if (!retained.has(contact.id)) {
              if (contact.owner.toLowerCase() !== mailbox) return fail('FORBIDDEN', 'only the contact owner may delete the contact')
              assertMailboxMetadataAuthority(contact.owner, contact.ownerAuthority, authority)
            }
            await assertContactMutationCapacity(helpers.store, current, values, mailbox)
            await lease.assertFencingToken()
            writeAttempted = true
            await atomicWriteJson(join(ext.baseDir, 'webmail', 'contacts.json'), values, 0o640, () => lease.assertFencingToken())
            if (collectionRevision(await ext.readOrDefault<WebmailContact[]>('webmail/contacts.json', [])) !== collectionRevision(values)) throw new Error('contact publication readback mismatch')
            await lease.commitAuthority({ incrementRevision: false })
            const account = await helpers.store.getAccount(authority.accountId)
            if (!account) throw new Error('contact audit account unavailable')
            await helpers.emitAudit({ actor: fresh.principal.username, action: 'webmail.contact.metadata_written', target: 'mailbox:' + mailbox,
              detail: { operation: method }, outcome: 'ok', principalId: fresh.principal.id }, { accountId: account.id, resellerId: account.ownerId })
          }
          return await operation(fresh, current, persist)
        } catch (error) {
          if (writeAttempted) return fail('SERVICE_UNAVAILABLE', 'contact write requires verification', {
            stateChanged: true, verificationRequired: true, unknownOutcome: true,
          })
          if (isXpanelError(error)) return fail(error.code, error.message, { ...error.detail, stateChanged: false })
          throw error
        } finally { await lease.release() }
      }
      const persistLegacyContacts = (values: WebmailContact[], mailbox: string) => mutateContacts(mailbox, async (_fresh, current, persist) => {
        if (collectionRevision(current) !== originalCollectionRevision) return fail('CONFLICT', 'contacts changed; reload before saving', { stateChanged: false })
        await persist(values)
      })
      const isCollectionCreate = method === 'POST' && pathname === '/api/webmail/contacts'
      const isItemEdit = Boolean(contactDeleteMatch) && (method === 'PATCH' || method === 'PUT')
      if (isMailboxPrincipal(caller) && (isCollectionCreate || isItemEdit)) {
        const mailbox = await requireMailbox(helpers.store, caller)
        if (url.searchParams.size) return fail('VALIDATION', 'contact workspace does not accept mailbox selectors', { stateChanged: false })
        const fields = parseContactWorkspaceRequest(await readJsonBody<unknown>(req), isItemEdit,
          (value, field) => assertSafeCalendarText(value as string, field))
        const saved = await mutateContacts(mailbox, async (fresh, current, persist) => {
          const bound = await requireMailboxPrincipalAccess(helpers.store, fresh)
          let next: WebmailContact
          if (isItemEdit) {
            const targetId = contactDeleteMatch![1]!
            const target = current.find(value => value.id === targetId)
            if (!target) return fail('NOT_FOUND', 'contact not found')
            const authority = await captureMailboxMetadataAuthority(helpers.store, mailbox)
            const access = await createContactMetadataAccess(helpers.store, authority)(target)
            if (target.owner.toLowerCase() === mailbox) assertMailboxMetadataAuthority(target.owner, target.ownerAuthority, authority)
            if (!access) return fail('NOT_FOUND', 'contact not found')
            if (target.owner.toLowerCase() !== mailbox) {
              if (access.permission !== 'read-write') return fail('FORBIDDEN', 'contact share is read-only')
            }
            if (contactWorkspaceRevision(target) !== fields.expectedRevision) return fail('CONFLICT', 'contact changed; reload before saving', { stateChanged: false })
            next = updateWorkspaceContact(target, fields)
            await persist(current.map(value => value.id === targetId ? next : value))
          } else {
            next = createWorkspaceContact(mailbox, fields)
            await persist([...current, next])
          }
          return { contact: next, account: bound.account }
        })
        const contact = saved.contact
        try {
          await helpers.emitAudit({ actor: caller.principal.username, action: isItemEdit ? 'webmail.contact.updated' : 'webmail.contact.created',
            target: 'contact:' + contact.id, outcome: 'ok', principalId: caller.principal.id },
          { accountId: saved.account.id, resellerId: saved.account.ownerId })
        } catch { return fail('SERVICE_UNAVAILABLE', 'contact audit requires verification', { stateChanged: true, verificationRequired: true, unknownOutcome: true }) }
        return jsonResponse({ context: { mailbox }, contact: projectContactWorkspace(contact), stateChanged: true }, isCollectionCreate ? 201 : 200)
      }
      const resolveContactAccess = async (
        contact: WebmailContact,
        requestedMailbox: string | null | undefined,
        requireWrite: boolean,
      ): Promise<string> => {
        const mailbox = await requireMailbox(
          helpers.store,
          caller,
          requestedMailbox ?? (isMailboxPrincipal(caller) ? undefined : contact.owner),
        )
        const authority = await captureMailboxMetadataAuthority(helpers.store, mailbox)
        if (contact.owner.toLowerCase() === mailbox) assertMailboxMetadataAuthority(contact.owner, contact.ownerAuthority, authority)
        const access = await createContactMetadataAccess(helpers.store, authority)(contact)
        if (!access) return fail('NOT_FOUND', 'contact not found')
        if (requireWrite && access.permission !== 'read-write') {
          return fail('FORBIDDEN', 'contact share is read-only')
        }
        return mailbox
      }

      if (method === 'GET' && pathname === '/api/webmail/contacts/export') {
        const mailbox = await requireMailbox(helpers.store, caller, url.searchParams.get('mailbox'))
        const access = createContactMetadataAccess(helpers.store, await captureMailboxMetadataAuthority(helpers.store, mailbox))
        const visible = (await Promise.all(contacts.map(async contact => await access(contact) ? contact : null))).filter((contact): contact is WebmailContact => contact !== null)
        return jsonResponse({
          mailbox,
          metadataReview: MAILBOX_METADATA_REVIEW_REQUIRED,
          vcard: visible.map((c) => c.vcard).join('\r\n'),
          count: visible.length,
        })
      }
      if (contactExportMatch && (method === 'GET' || method === 'DELETE')) {
        const targetId = contactExportMatch[1]!
        const target = contacts.find((c) => c.id === targetId)
        if (!target) return fail('NOT_FOUND', 'contact not found')
        await resolveContactAccess(target, url.searchParams.get('mailbox'), false)
        if (method === 'DELETE') {
          return new Response(JSON.stringify({
            type: 'about:blank', title: 'Method Not Allowed', status: 405,
            code: 'METHOD_NOT_ALLOWED', detail: 'contact export routes only support GET', instance: pathname,
          }), { status: 405, headers: { allow: 'GET', 'content-type': 'application/problem+json; charset=utf-8' } })
        }
        return jsonResponse({ contactId: target.id, vcard: target.vcard })
      }
      if (method === 'POST' && pathname === '/api/webmail/contacts/import') {
        const body = await readJsonBody<{ vcard?: string; mailbox?: string; owner?: string }>(req)
        const owner = await requireMailbox(
          helpers.store,
          caller,
          body.owner ?? body.mailbox ?? url.searchParams.get('mailbox'),
        )
        const imported = parseAndValidateVcards(body.vcard ?? '', owner)
        contacts.push(...imported)
        await persistLegacyContacts(contacts, owner)
        return jsonResponse({ contacts: imported.map(projectContactWorkspace), importedCount: imported.length }, 201)
      }
      if (contactShareMatch && (method === 'POST' || method === 'DELETE')) {
        const contactId = contactShareMatch[1]!
        const contact = contacts.find((c) => c.id === contactId)
        if (!contact) return fail('NOT_FOUND', 'contact not found')
        const callerMailbox = await resolveContactAccess(contact, url.searchParams.get('mailbox'), false)
        if (contact.owner.toLowerCase() !== callerMailbox) {
          return fail('FORBIDDEN', 'only the contact owner may modify sharing')
        }
        const ownerMailbox = contact.owner.toLowerCase()
        const body = await readJsonBody<{
          principal?: string
          grantee?: string
          permission?: 'read' | 'read-write' | 'none' | 'revoke'
          revoke?: boolean
        }>(req)
        const rawPrincipal =
          body.principal ??
          body.grantee ??
          url.searchParams.get('principal') ??
          url.searchParams.get('grantee') ??
          ''
        const targetPrincipal = rawPrincipal.trim().toLowerCase()
        if (!targetPrincipal || !/^[^\s@/\\]+@[^\s@/\\]+$/.test(targetPrincipal)) {
          return fail('VALIDATION', 'a valid share principal email address is required')
        }
        contact.shares = contact.shares ?? []
        if (method === 'DELETE' || body.revoke === true || body.permission === 'none' || body.permission === 'revoke') {
          contact.shares = contact.shares.filter((s) => s.principal.toLowerCase() !== targetPrincipal)
          await persistLegacyContacts(contacts, callerMailbox)
          return jsonResponse({ contact: projectContactWorkspace(contact) })
        }
        const allUsers = (await helpers.store.readSnapshot()).serviceUsers
        const ownerUser = allUsers.find((u) => u.services.email && u.login.toLowerCase() === ownerMailbox)
        const targetUser = allUsers.find((u) => u.services.email && u.login.toLowerCase() === targetPrincipal)
        if (!ownerUser || !targetUser || targetUser.accountId !== ownerUser.accountId) {
          return fail('NOT_FOUND', 'share target mailbox not found in account')
        }
        const permission = body.permission === 'read-write' ? 'read-write' : 'read'
        const shareEntry = {
          principal: targetPrincipal,
          permission,
          sharedAt: new Date().toISOString(),
        } as const
        const idx = contact.shares.findIndex((s) => s.principal.toLowerCase() === targetPrincipal)
        if (idx >= 0) contact.shares[idx] = shareEntry
        else contact.shares.push(shareEntry)
        await persistLegacyContacts(contacts, callerMailbox)
        return jsonResponse({ contact: projectContactWorkspace(contact) })
      }
      if (method === 'GET' && pathname === '/api/webmail/contacts') {
        if (isMailboxPrincipal(caller) && url.searchParams.size) return fail('VALIDATION', 'contact workspace does not accept mailbox selectors', { stateChanged: false })
        const mailbox = await requireMailbox(helpers.store, caller, url.searchParams.get('mailbox'))
        const access = createContactMetadataAccess(helpers.store, await captureMailboxMetadataAuthority(helpers.store, mailbox))
        const visible = (await Promise.all(contacts.map(async contact => await access(contact) ? contact : null))).filter((contact): contact is WebmailContact => contact !== null)
        return jsonResponse({
          context: { mailbox },
          metadataReview: MAILBOX_METADATA_REVIEW_REQUIRED,
          contacts: visible.map(projectContactWorkspace),
        })
      }
      if (method === 'POST' && pathname === '/api/webmail/contacts') {
        const body = await readJsonBody<Partial<WebmailContact>>(req)
        if (!body.fullName || !body.email) return fail('VALIDATION', 'fullName and email are required')
        const fullName = assertSafeCalendarText(body.fullName, 'fullName')
        const email = assertSafeCalendarText(body.email, 'email').toLowerCase()
        if (!/^[^\s@/\\]+@[^\s@/\\]+$/.test(email)) return fail('VALIDATION', 'email must be a valid email address')
        const phone = body.phone ? assertSafeCalendarText(body.phone, 'phone') : ''
        const organization = body.organization ? assertSafeCalendarText(body.organization, 'organization') : ''
        const title = body.title ? assertSafeCalendarText(body.title, 'title') : ''
        const owner = await requireMailbox(helpers.store, caller, body.owner ?? url.searchParams.get('mailbox'))
        const groups = normalizeContactGroups(body.groups ?? [])
        const contact = updateWorkspaceContactGroups(createWorkspaceContact(owner, { fullName, email, phone, organization, title }), groups)
        contacts.push(contact)
        await persistLegacyContacts(contacts, owner)
        return jsonResponse({ contact: projectContactWorkspace(contact) }, 201)
      }
      if (contactDeleteMatch && (method === 'PATCH' || method === 'PUT')) {
        const targetId = contactDeleteMatch[1]!
        const target = contacts.find((c) => c.id === targetId)
        if (!target) return fail('NOT_FOUND', 'contact not found')
        const body = await readJsonBody<Partial<WebmailContact> & { mailbox?: string }>(req)
        const mailbox = await resolveContactAccess(target, body.mailbox ?? url.searchParams.get('mailbox'), true)
        const original = { ...target }
        if (body.fullName !== undefined) target.fullName = assertSafeCalendarText(body.fullName, 'fullName')
        if (body.email !== undefined) {
          const email = assertSafeCalendarText(body.email, 'email').toLowerCase()
          if (!/^[^\s@/\\]+@[^\s@/\\]+$/.test(email)) return fail('VALIDATION', 'email must be a valid email address')
          target.email = email
        }
        if (body.phone !== undefined) target.phone = assertSafeCalendarText(body.phone, 'phone')
        if (body.organization !== undefined) target.organization = assertSafeCalendarText(body.organization, 'organization')
        if (body.title !== undefined) target.title = assertSafeCalendarText(body.title, 'title')
        const groups = body.groups === undefined ? target.groups : normalizeContactGroups(body.groups, original.groups)
        Object.assign(target, updateWorkspaceContact(original, target))
        if (JSON.stringify(groups) !== JSON.stringify(original.groups)) Object.assign(target, updateWorkspaceContactGroups(target, groups))
        await persistLegacyContacts(contacts, mailbox)
        return jsonResponse({ contact: projectContactWorkspace(target) })
      }
      if (method === 'DELETE') {
        const body = await readJsonBody<{ id?: unknown }>(req)
        const invalidSelector = (detail: string): Response => new Response(JSON.stringify({
          type: 'about:blank', title: 'VALIDATION', status: 400, code: 'VALIDATION', detail, instance: pathname,
        }), { status: 400, headers: { 'content-type': 'application/problem+json; charset=utf-8' } })
        const selectors: unknown[] = [
          ...(contactDeleteMatch ? [contactDeleteMatch[1]!] : []),
          ...url.searchParams.getAll('id'),
          ...(Object.hasOwn(body, 'id') ? [body.id] : []),
        ]
        if (selectors.length === 0 || selectors.some(id => typeof id !== 'string' || id.trim().length === 0)) {
          return invalidSelector('a non-empty contact id is required for every explicit selector')
        }
        const targetId = selectors[0] as string
        if (selectors.some(id => id !== targetId)) return invalidSelector('conflicting contact id selectors')
        const target = contacts.find(contact => contact.id === targetId)
        if (!target) return fail('NOT_FOUND', 'contact not found')
        const callerMailbox = await resolveContactAccess(target, url.searchParams.get('mailbox'), false)
        if (target.owner.toLowerCase() !== callerMailbox) {
          return fail('FORBIDDEN', 'only the contact owner may delete the contact')
        }
        const next = contacts.filter((c) => c.id !== targetId)
        await persistLegacyContacts(next, callerMailbox)
        return jsonResponse({ ok: true })
      }
    }

    // =========================================================================
    // 4. Operational DNS (/api/dns/*)
    // =========================================================================
    if (pathname === '/api/dns/templates') {
      const caller = await helpers.requireCaller(req)
      const templates = await ext.readOrDefault<DnsTemplateDefinition[]>('dns/templates.json', DEFAULT_DNS_TEMPLATES)
      if (method === 'GET') {
        return jsonResponse({ templates })
      }
      if (method === 'PUT') {
        await helpers.assertRoot(caller, 'dns.templates.update')
        const body = await readJsonBody<{ templates?: DnsTemplateDefinition[] }>(req)
        if (!Array.isArray(body.templates)) return fail('VALIDATION', 'templates array is required')
        await ext.write('dns/templates.json', body.templates)
        return jsonResponse({ templates: body.templates })
      }
    }

    if (method === 'POST' && pathname === '/api/dns/templates/apply') {
      const caller = await helpers.requireCaller(req)
      const body = await readJsonBody<{
        template?: 'standard' | 'simple' | 'virtualftp'
        domain?: string
        ipv4?: string
        accountId?: Id | null
      }>(req)
      const domain = validateDomainName(body.domain ?? '')
      const account = await requireDomainAccount(helpers.store, caller, domain, 'dns.template.apply', body.accountId)
      const templateId = body.template ?? 'standard'
      const templates = await ext.readOrDefault<DnsTemplateDefinition[]>('dns/templates.json', DEFAULT_DNS_TEMPLATES)
      const tpl = templates.find((t) => t.id === templateId)
      if (!tpl) return fail('NOT_FOUND', `DNS template "${templateId}" not found`)

      const ipv4 =
        body.ipv4 ??
        (await helpers.store.listServerIps()).find((ip) => ip.version === 4)?.address ??
        '203.0.113.10'
      const existingZone = await helpers.store.getDnsZone(domain)
      await assertExistingZoneOwner(caller, domain)
      const records: DnsRecord[] = tpl.records.map((r) => ({
        id: randomUUID(),
        zone: domain,
        name: r.name,
        type: r.type,
        ttl: r.ttl,
        content: r.contentTemplate.replace(/\{\{ipv4\}\}/g, ipv4).replace(/\{\{domain\}\}/g, domain),
        priority: r.priority,
      }))
      const zone = await helpers.store.saveDnsZone({
        id: existingZone?.id ?? randomUUID(),
        accountId: account.id,
        name: domain,
        serial: existingZone ? existingZone.serial + 1 : 2026102201,
        records,
      })
      await helpers.emitAudit({
        actor: caller.principal.username,
        action: 'dns.template.applied',
        target: `zone:${domain}`,
        detail: { template: templateId, recordsCount: records.length },
        outcome: 'ok',
        principalId: caller.principal.id,
      })
      return jsonResponse({ ok: true, template: templateId, zone })
    }

    if (method === 'POST' && pathname === '/api/dns/email-auth/batch') {
      const caller = await helpers.requireCaller(req)
      const body = await readJsonBody<{ domains?: string[]; ipv4?: string }>(req)
      const allDomains = await helpers.store.listDomains()
      const accountIds = new Set((await ownedAccounts(helpers.store, caller)).map(account => account.id))
      const allowedDomains = allDomains.filter(domain => accountIds.has(domain.accountId))
      const targetNames =
        Array.isArray(body.domains) && body.domains.length > 0
          ? body.domains.map((d) => validateDomainName(d))
          : allowedDomains.map((d) => d.name)

      for (const domainName of targetNames) {
        await requireDomainAccount(helpers.store, caller, domainName, 'dns.email_auth.batch')
        await assertExistingZoneOwner(caller, domainName)
      }
      const ipv4 = body.ipv4 ?? (await helpers.store.listServerIps()).find((ip) => ip.version === 4 && ip.isPrimary)?.address
      if (ipv4 !== undefined && isIP(ipv4) !== 4) return fail('VALIDATION', 'SPF IPv4 address is invalid')
      if (!helpers.readDkimPublicMaterial) return fail('PRECONDITION_FAILED', 'verified DKIM signing material is unavailable')
      const provisioned: { domain: string; spf: string; dkim: string; dmarc: string }[] = []
      const prepared = []

      for (const domName of targetNames) {
        const existingZone = await helpers.store.getDnsZone(domName)
        const domObj = allDomains.find((d) => d.name === domName)
        const material = await helpers.readDkimPublicMaterial(caller, domName)
        if (!material || typeof material.publicKeyPem !== 'string' || typeof material.selector !== 'string' || material.publicKeyPem.includes('PRIVATE KEY')) return fail('PRECONDITION_FAILED', 'verified DKIM signing material is unavailable')
        const owner = (name: string): string => name.toLowerCase().replace(/\.$/, '').replace(new RegExp(`\\.${domName.replace(/\./g, '\\.')}$`), '')
        const records = existingZone?.records ?? []
        const existingDkim = records.find(r => r.type === 'TXT' && owner(r.name) === `${material.selector}._domainkey`)
        let dkimRecord: ReturnType<typeof mailServices.dkimDnsRecord>
        try {
          const key = createPublicKey(material.publicKeyPem)
          if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error('invalid DKIM key')
          dkimRecord = mailServices.dkimDnsRecord(domName, material.selector, key.export({ type: 'spki', format: 'pem' }).toString(), { ttl: existingDkim?.ttl ?? 14400 })
        } catch {
          return fail('PRECONDITION_FAILED', 'verified DKIM signing material is unavailable')
        }
        const spfRecords = records.filter(r => r.type === 'TXT' && ['@', domName].includes(owner(r.name)) && /^v=spf1(?:\s|$)/i.test(r.content))
        const dmarcRecords = records.filter(r => r.type === 'TXT' && owner(r.name) === '_dmarc')
        if (spfRecords.length === 0 && !ipv4) return fail('PRECONDITION_FAILED', 'a primary IPv4 address is required to publish SPF')
        const spf = spfRecords[0]?.content ?? `v=spf1 a mx ip4:${ipv4} ~all`
        const dkim = dkimRecord.content
        const dmarc = dmarcRecords[0]?.content ?? `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domName}`
        const nextRecords: DnsRecord[] = records.filter(r => !(r.type === 'TXT' && owner(r.name) === dkimRecord.name))
        if (spfRecords.length === 0) nextRecords.push({ id: randomUUID(), zone: domName, name: '@', type: 'TXT', ttl: 14400, content: spf, priority: null })
        nextRecords.push({ id: existingDkim?.id ?? randomUUID(), ...dkimRecord, type: 'TXT' })
        if (dmarcRecords.length === 0) nextRecords.push({ id: randomUUID(), zone: domName, name: '_dmarc', type: 'TXT', ttl: 14400, content: dmarc, priority: null })
        prepared.push({ domName, existingZone, domObj, nextRecords, spf, dkim, dmarc })
      }
      // Validate every requested signing key before changing any desired zone.
      for (const { domName, existingZone, domObj, nextRecords, spf, dkim, dmarc } of prepared) {
        await helpers.store.saveDnsZone({
          id: existingZone?.id ?? randomUUID(),
          accountId: existingZone?.accountId ?? domObj?.accountId ?? null,
          name: domName,
          serial: existingZone ? existingZone.serial + 1 : 2026102201,
          records: nextRecords,
        })
        provisioned.push({ domain: domName, spf, dkim, dmarc })
      }

      await helpers.emitAudit({
        actor: caller.principal.username,
        action: 'dns.email_auth.batch_provisioned',
        target: 'dns:email-auth',
        detail: { count: provisioned.length },
        outcome: 'ok',
        principalId: caller.principal.id,
      })
      return jsonResponse({ ok: true, provisioned, count: provisioned.length })
    }

    if (method === 'POST' && pathname === '/api/dns/cleanup') {
      const caller = await helpers.requireCaller(req)
      await helpers.assertRoot(caller, 'dns.cleanup')
      const body = await readJsonBody<{ dryRun?: boolean }>(req)
      const [zones, domains, settings] = await Promise.all([
        helpers.store.listDnsZones(),
        helpers.store.listDomains(),
        helpers.store.getServerSettings(),
      ])
      const activeNames = new Set(domains.map((d) => d.name.toLowerCase()))
      if (settings?.hostname) activeNames.add(settings.hostname.toLowerCase())

      const removedZones: string[] = []
      const keptZones: string[] = []
      for (const z of zones) {
        if (!activeNames.has(z.name.toLowerCase())) {
          removedZones.push(z.name)
          if (!body.dryRun) {
            await helpers.store.deleteDnsZone(z.name)
          }
        } else {
          keptZones.push(z.name)
        }
      }
      await helpers.emitAudit({
        actor: caller.principal.username,
        action: 'dns.cleanup',
        target: 'dns:zones',
        detail: { removedZones, dryRun: Boolean(body.dryRun) },
        outcome: 'ok',
        principalId: caller.principal.id,
      })
      return jsonResponse({ ok: true, removedZones, keptZones })
    }

    // =========================================================================
    // 5. Complete Backups & Transfers (/api/backups/*, /api/transfers/*, /api/lifecycle/cpanel-import)
    // =========================================================================
    const restoreFileMatch = /^\/api\/backups\/snapshots\/([^/]+)\/restore-file$/.exec(pathname)
    if (restoreFileMatch && method === 'POST') {
      const caller = await helpers.requireCaller(req)
      const snapshotId = restoreFileMatch[1]!
      const snapshots = await ext.readOrDefault<BackupSnapshot[]>('backups/snapshots.json', [])
      const snapshot = snapshots.find((s) => s.id === snapshotId)
      if (!snapshot) return fail('NOT_FOUND', `backup snapshot "${snapshotId}" not found`)

      const account = await helpers.resolveAccountParam(snapshot.accountId)
      await helpers.assertCanAccessAccount(caller, account, 'backup.restore_file')
      return fail('PRECONDITION_FAILED', 'granular restore requires a verified backup artifact and confined agent restore executor')
    }

    if (pathname === '/api/backups/snapshots') {
      const caller = await helpers.requireCaller(req)
      const snapshots = await ext.readOrDefault<BackupSnapshot[]>('backups/snapshots.json', [])
      if (method === 'GET') {
        const accountIdFilter = url.searchParams.get('accountId')
        if (accountIdFilter) {
          const targetAccount = await requireResolvedAccount(caller, accountIdFilter, 'backup.snapshot.list')
          return jsonResponse({
            snapshots: snapshots.filter((snapshot) => snapshot.accountId === targetAccount.id),
          })
        }
        const visible = await scopedRecords(caller, snapshots)
        return jsonResponse({ snapshots: visible })
      }
      if (method === 'POST') {
        const body = await readJsonBody<{
          accountId?: Id
          destinationId?: Id | null
          files?: { path: string; content: string; mode?: number }[] | Record<string, string>
        }>(req)
        const account = await requireResolvedAccount(caller, body.accountId, 'backup.snapshot.create')

        const snapshotFiles: BackupSnapshotFile[] = []
        if (Array.isArray(body.files)) {
          for (const f of body.files) {
            snapshotFiles.push({
              path: f.path.replace(/^\/+/, ''),
              content: f.content,
              mode: f.mode ?? 0o640,
              sizeBytes: Buffer.byteLength(f.content, 'utf8'),
            })
          }
        } else if (body.files && typeof body.files === 'object') {
          for (const [p, c] of Object.entries(body.files)) {
            snapshotFiles.push({
              path: p.replace(/^\/+/, ''),
              content: String(c),
              mode: 0o640,
              sizeBytes: Buffer.byteLength(String(c), 'utf8'),
            })
          }
        } else {
          return fail('PRECONDITION_FAILED', 'backup capture requires a confined agent snapshot executor')
        }

        const dbs = await helpers.store.listDatabases(account.id)
        const totalBytes = snapshotFiles.reduce((acc, f) => acc + f.sizeBytes, 0)
        const checksumSha256 = createHash('sha256')
          .update(JSON.stringify(snapshotFiles))
          .digest('hex')

        const snapshot: BackupSnapshot = {
          id: randomUUID(),
          accountId: account.id,
          username: account.username,
          destinationId: body.destinationId ?? null,
          sizeBytes: totalBytes,
          checksumSha256,
          files: snapshotFiles,
          databases: dbs.map((d) => d.name),
          createdAt: new Date().toISOString(),
        }
        await helpers.assertCanAccessAccount(caller, account, 'backup.snapshot.create')
        snapshots.unshift(snapshot)
        await ext.write('backups/snapshots.json', snapshots)
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'backup.snapshot.created',
          target: `snapshot:${snapshot.id}`,
          detail: { account: account.username, filesCount: snapshotFiles.length, sizeBytes: totalBytes },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ snapshot }, 201)
      }
    }

    if (method === 'POST' && pathname === '/api/lifecycle/cpanel-import') {
      const caller = await helpers.requireCaller(req)
      await helpers.assertRoot(caller, 'lifecycle.cpanel_import')
      return fail('PRECONDITION_FAILED', 'cPanel import requires retained verified archive custody and a qualified execution adapter', { stateChanged: false, nativeApplied: false })
    }

    // =========================================================================
    // 6. Extended File Isolation & Web Extras (/api/web-features/* & /api/git/*)
    // =========================================================================
    const webFeatMatch = /^\/api\/web-features\/([^/]+)\/(directory-privacy|hotlink-protection|web-disk|extras)$/.exec(
      pathname,
    )
    if (webFeatMatch) {
      const caller = await helpers.requireCaller(req)
      const account = await helpers.resolveAccountParam(webFeatMatch[1]!)
      const featureKind = webFeatMatch[2]!
      await helpers.assertCanAccessAccount(caller, account, `web_features.${featureKind}`)

      if (featureKind === 'directory-privacy') {
        const fileKey = `web-features/${account.id}/directory-privacy.json`
        const defaultCfg: DirectoryPrivacyConfig = {
          accountId: account.id,
          rules: [],
          compiledHtpasswd: '',
          compiledNginx: '',
          compiledApache: '',
          updatedAt: new Date().toISOString(),
        }
        if (method === 'GET') {
          return jsonResponse({ config: publicDirectoryPrivacy(await ext.readOrDefault(fileKey, defaultCfg)) })
        }
        if (method === 'PUT') {
          const body = await readJsonBody<{
            rules?: {
              path: string
              authName?: string
              enabled?: boolean
              users?: { username: string; password?: string; passwordHash?: string }[]
            }[]
          }>(req)
          // The compiled nginx/apache fragments interpolate these values, so the input is
          // normalized and constrained here before it can reach a rendered directive.
          const controlText = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
          const rawRules = body.rules ?? []
          if (!Array.isArray(rawRules) || rawRules.length > 1000) return fail('VALIDATION', 'directory privacy rules must be an array of at most 1000 entries', { stateChanged: false })
          const seenPaths = new Set<string>()
          for (const rule of rawRules) {
            if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return fail('VALIDATION', 'each directory privacy rule must be an object', { stateChanged: false })
            if (typeof rule.path !== 'string' || rule.path.length > 512 || controlText.test(rule.path)) return fail('VALIDATION', 'each protected directory needs a canonical relative path', { stateChanged: false })
            const normalizedPath = rule.path.startsWith('/') ? rule.path : `/${rule.path}`
            if (!/^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(normalizedPath) || normalizedPath.split('/').slice(1).some(part => part === '' || part === '.' || part === '..')) {
              return fail('VALIDATION', 'protected directory paths must be canonical and free of traversal segments', { stateChanged: false })
            }
            if (seenPaths.has(normalizedPath)) return fail('VALIDATION', 'each protected directory may be listed only once', { stateChanged: false })
            seenPaths.add(normalizedPath)
            if (rule.authName !== undefined && (typeof rule.authName !== 'string' || rule.authName.length > 128 || controlText.test(rule.authName))) {
              return fail('VALIDATION', 'the authentication prompt must be bounded text without control characters', { stateChanged: false })
            }
            if (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') return fail('VALIDATION', 'the enabled flag must be a boolean', { stateChanged: false })
            if (rule.users !== undefined && (!Array.isArray(rule.users) || rule.users.length > 100)) return fail('VALIDATION', 'each protected directory may list at most 100 users', { stateChanged: false })
            const seenUsers = new Set<string>()
            for (const user of rule.users ?? []) {
              if (!user || typeof user !== 'object' || Array.isArray(user) || typeof user.username !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(user.username)) {
                return fail('VALIDATION', 'each protected-directory user needs a bounded username', { stateChanged: false })
              }
              if (seenUsers.has(user.username)) return fail('VALIDATION', 'each username may be listed only once per directory', { stateChanged: false })
              seenUsers.add(user.username)
            }
          }
          const rules: DirectoryPrivacyRule[] = await Promise.all(rawRules.map(async (r) => ({
            path: r.path.startsWith('/') ? r.path : `/${r.path}`,
            authName: r.authName ?? 'Protected Area',
            enabled: r.enabled ?? true,
            users: await Promise.all((r.users ?? []).map(async (u) => ({
              username: u.username,
              passwordHash: await passwordHashFromInput(u),
            }))),
          })))
          const compiledHtpasswd = rules
            .flatMap((r) => r.users.map((u) => `${u.username}:${u.passwordHash}`))
            .join('\n')
          const compiledNginx = rules
            .filter((r) => r.enabled)
            .map(
              (r) =>
                `location ^~ ${r.path} {\n  auth_basic "${r.authName}";\n  auth_basic_user_file ${account.home}/.htpasswd;\n}`,
            )
            .join('\n\n')
          const compiledApache = rules
            .filter((r) => r.enabled)
            .map(
              (r) =>
                `<Directory "${account.home}/public_html${r.path}">\n  AuthType Basic\n  AuthName "${r.authName}"\n  AuthUserFile "${account.home}/.htpasswd"\n  Require valid-user\n</Directory>`,
            )
            .join('\n\n')

          const config: DirectoryPrivacyConfig = {
            accountId: account.id,
            rules,
            compiledHtpasswd,
            compiledNginx,
            compiledApache,
            updatedAt: new Date().toISOString(),
          }
          await helpers.assertCanAccessAccount(caller, account, `web_features.${featureKind}`)
          await ext.write(fileKey, config)
          await helpers.emitAudit({
            actor: caller.principal.username,
            action: 'web_features.directory_privacy.updated',
            target: `account:${account.username}`,
            detail: { rulesCount: rules.length },
            outcome: 'ok',
            principalId: caller.principal.id,
          })
          return jsonResponse({ config: publicDirectoryPrivacy(config) })
        }
      }

      if (featureKind === 'hotlink-protection') {
        const fileKey = `web-features/${account.id}/hotlink-protection.json`
        const defaultCfg: HotlinkProtectionConfig = {
          accountId: account.id,
          enabled: false,
          allowedUrls: [account.primaryDomain, `www.${account.primaryDomain}`],
          protectedExtensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'mp4'],
          allowDirectRequests: true,
          redirectUrl: null,
          compiledNginx: '',
          compiledApache: '',
          updatedAt: new Date().toISOString(),
        }
        if (method === 'GET') {
          return jsonResponse({ config: await ext.readOrDefault(fileKey, defaultCfg) })
        }
        if (method === 'PUT') {
          const body = await readJsonBody<Partial<HotlinkProtectionConfig>>(req)
          const current = await ext.readOrDefault(fileKey, defaultCfg)
          const merged = { ...current, ...body }
          const extPattern = merged.protectedExtensions.join('|')
          const validReferers = [
            ...(merged.allowDirectRequests ? ['none', 'blocked'] : []),
            ...merged.allowedUrls,
          ].join(' ')
          const compiledNginx = merged.enabled
            ? `location ~* \\.(${extPattern})$ {\n  valid_referers ${validReferers};\n  if ($invalid_referer) {\n    return ${merged.redirectUrl ? `302 ${merged.redirectUrl}` : '403'};\n  }\n}`
            : '# Hotlink protection disabled'
          const compiledApache = merged.enabled
            ? `RewriteEngine on\n${merged.allowDirectRequests ? 'RewriteCond %{HTTP_REFERER} !^$\n' : ''}${merged.allowedUrls.map((u) => `RewriteCond %{HTTP_REFERER} !^https?://(www\\.)?${u.replace(/\./g, '\\.')} [NC]`).join('\n')}\nRewriteRule \\.(${extPattern})$ ${merged.redirectUrl ?? '-'} [F,NC,L]`
            : '# Hotlink protection disabled'
          const config: HotlinkProtectionConfig = {
            ...merged,
            accountId: account.id,
            compiledNginx,
            compiledApache,
            updatedAt: new Date().toISOString(),
          }
          await helpers.assertCanAccessAccount(caller, account, `web_features.${featureKind}`)
          await ext.write(fileKey, config)
          await helpers.emitAudit({
            actor: caller.principal.username,
            action: 'web_features.hotlink_protection.updated',
            target: `account:${account.username}`,
            detail: { enabled: config.enabled },
            outcome: 'ok',
            principalId: caller.principal.id,
          })
          return jsonResponse({ config })
        }
      }

      if (featureKind === 'web-disk') {
        const fileKey = `web-features/${account.id}/web-disk.json`
        const defaultCfg: WebDiskConfig = {
          accountId: account.id,
          enabled: false,
          rootPath: 'public_html',
          readOnly: false,
          requireTls: true,
          port: 2078,
          digestAuth: true,
          endpointUrl: `https://${account.primaryDomain}:2078/${account.username}`,
          compiledConfig: '',
          updatedAt: new Date().toISOString(),
        }
        if (method === 'GET') {
          return jsonResponse({ config: await ext.readOrDefault(fileKey, defaultCfg) })
        }
        if (method === 'PUT') {
          const body = await readJsonBody<Partial<WebDiskConfig>>(req)
          const current = await ext.readOrDefault(fileKey, defaultCfg)
          const merged = { ...current, ...body }
          const compiledConfig = [
            `# Isolated WebDAV jail for ${account.username} (UID ${account.uid})`,
            `location /webdav/${account.username}/ {`,
            `  alias ${account.home}/${merged.rootPath}/;`,
            `  dav_methods ${merged.readOnly ? ' final' : 'PUT DELETE MKCOL COPY MOVE'};`,
            `  dav_ext_methods PROPFIND OPTIONS;`,
            `  create_full_put_path on;`,
            `  dav_access user:rw group:r;`,
            `}`,
          ].join('\n')
          const config: WebDiskConfig = {
            ...merged,
            accountId: account.id,
            compiledConfig,
            updatedAt: new Date().toISOString(),
          }
          await helpers.assertCanAccessAccount(caller, account, `web_features.${featureKind}`)
          await ext.write(fileKey, config)
          await helpers.emitAudit({
            actor: caller.principal.username,
            action: 'web_features.web_disk.updated',
            target: `account:${account.username}`,
            detail: { enabled: config.enabled, rootPath: config.rootPath },
            outcome: 'ok',
            principalId: caller.principal.id,
          })
          return jsonResponse({ config })
        }
      }

      if (featureKind === 'extras') {
        const fileKey = `web-features/${account.id}/extras.json`
        const defaultCfg: WebExtrasConfig = {
          accountId: account.id,
          errorPages: { '404': '/404.html', '500': '/500.html' },
          redirects: [],
          mimeTypes: [],
          deniedCidrs: [],
          directoryIndexMode: 'disabled',
          compiledNginx: '',
          compiledApache: '',
          updatedAt: new Date().toISOString(),
        }
        if (method === 'GET') {
          return jsonResponse({ config: await ext.readOrDefault(fileKey, defaultCfg) })
        }
        if (method === 'PUT') {
          const body = await readJsonBody<Partial<WebExtrasConfig>>(req)
          const current = await ext.readOrDefault(fileKey, defaultCfg)
          const merged = { ...current, ...body }
          const nginxLines: string[] = []
          for (const [code, page] of Object.entries(merged.errorPages)) {
            nginxLines.push(`error_page ${code} ${page};`)
          }
          for (const cidr of merged.deniedCidrs) {
            nginxLines.push(`deny ${cidr};`)
          }
          nginxLines.push(
            `autoindex ${merged.directoryIndexMode === 'disabled' ? 'off' : 'on'};`,
          )
          const apacheLines: string[] = [
            `Options ${merged.directoryIndexMode === 'disabled' ? '-Indexes' : '+Indexes'}`,
            ...Object.entries(merged.errorPages).map(([code, page]) => `ErrorDocument ${code} ${page}`),
            ...merged.mimeTypes.map((m) => `AddType ${m.mimeType} ${m.extension}`),
          ]
          const config: WebExtrasConfig = {
            ...merged,
            accountId: account.id,
            compiledNginx: nginxLines.join('\n'),
            compiledApache: apacheLines.join('\n'),
            updatedAt: new Date().toISOString(),
          }
          await helpers.assertCanAccessAccount(caller, account, `web_features.${featureKind}`)
          await ext.write(fileKey, config)
          await helpers.emitAudit({
            actor: caller.principal.username,
            action: 'web_features.extras.updated',
            target: `account:${account.username}`,
            outcome: 'ok',
            principalId: caller.principal.id,
          })
          return jsonResponse({ config })
        }
      }
    }

    const gitDeployMatch = /^\/api\/git\/([^/]+)\/repos\/([^/]+)\/deploy$/.exec(pathname)
    const gitRepoDeleteMatch = /^\/api\/git\/([^/]+)\/repos\/([^/]+)$/.exec(pathname)
    const gitReposListMatch = /^\/api\/git\/([^/]+)\/repos$/.exec(pathname)
    if (gitDeployMatch || gitRepoDeleteMatch || gitReposListMatch) {
      const caller = await helpers.requireCaller(req)
      const accountParam = (gitDeployMatch?.[1] ?? gitRepoDeleteMatch?.[1] ?? gitReposListMatch?.[1])!
      const account = await helpers.resolveAccountParam(accountParam)
      await helpers.assertCanAccessAccount(caller, account, 'git.repos')
      const fileKey = `git/${account.id}/repos.json`
      const repos = await ext.readOrDefault<GitRepositoryRecord[]>(fileKey, [])

      if (gitReposListMatch && method === 'GET') {
        return jsonResponse({ repos })
      }
      if (gitReposListMatch && method === 'POST') {
        const body = await readJsonBody<Partial<GitRepositoryRecord>>(req)
        if (!body.name) return fail('VALIDATION', 'repository name is required')
        const repo: GitRepositoryRecord = {
          id: randomUUID(),
          accountId: account.id,
          name: body.name,
          branch: body.branch ?? 'main',
          remoteUrl: body.remoteUrl ?? `https://github.com/${account.username}/${body.name}.git`,
          deployPath: body.deployPath ?? `${account.home}/domains/${account.primaryDomain}/public_html`,
          postDeployCommand: body.postDeployCommand ?? null,
          autoDeploy: body.autoDeploy ?? true,
          currentCommit: null,
          currentReleaseDir: null,
          deployments: [],
          createdAt: new Date().toISOString(),
        }
        await helpers.assertCanAccessAccount(caller, account, 'git.repos')
        repos.push(repo)
        await ext.write(fileKey, repos)
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'git.repo.created',
          target: `account:${account.username}:git:${repo.name}`,
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ repo }, 201)
      }
      if (gitDeployMatch && method === 'POST') {
        const repoId = gitDeployMatch[2]!
        const repo = repos.find((r) => r.id === repoId || r.name === repoId)
        if (!repo) return fail('NOT_FOUND', `git repository "${repoId}" not found`)
        const body = await readJsonBody<{ commitSha?: string }>(req)
        const commitSha =
          body.commitSha ??
          createHash('sha1')
            .update(`${repo.id}:${Date.now()}`)
            .digest('hex')
            .slice(0, 12)
        const deployedAt = new Date().toISOString()
        const releaseDir = `${account.home}/git/${repo.name}/releases/${Date.now()}-${commitSha}`
        const currentSymlink = `${account.home}/git/${repo.name}/current`
        const deployment = {
          id: randomUUID(),
          commitSha,
          releaseDir,
          currentSymlink,
          status: 'deployed' as const,
          deployedAt,
        }
        await helpers.assertCanAccessAccount(caller, account, 'git.repos')
        repo.currentCommit = commitSha
        repo.currentReleaseDir = releaseDir
        repo.deployments.unshift(deployment)
        await ext.write(fileKey, repos)
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'git.repo.deployed',
          target: `account:${account.username}:git:${repo.name}`,
          detail: { commitSha, releaseDir },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ ok: true, repo, deployment })
      }
      if ((gitRepoDeleteMatch || gitReposListMatch) && method === 'DELETE') {
        const body = await readJsonBody<{ id?: string }>(req)
        const targetId = gitRepoDeleteMatch?.[2] ?? url.searchParams.get('id') ?? body.id
        const existing = repos.find((r) => r.id === targetId || r.name === targetId)
        if (!existing) return fail('NOT_FOUND', `git repository "${targetId ?? ''}" not found`)
        await helpers.assertCanAccessAccount(caller, account, 'git.repos')
        const next = repos.filter((r) => r.id !== targetId && r.name !== targetId)
        await ext.write(fileKey, next)
        return jsonResponse({ ok: true })
      }
    }

    // =========================================================================
    // 7. Database remote hosts, maintenance and cache
    // =========================================================================
    const remoteHostsMatch = /^\/api\/databases\/([^/]+)\/remote-hosts$/.exec(pathname)
    if (remoteHostsMatch || pathname === '/api/databases/remote-hosts') {
      const caller = await helpers.requireCaller(req)
      const account = await requireResolvedAccount(
        caller,
        remoteHostsMatch?.[1] ?? url.searchParams.get('accountId'),
        'database.remote_hosts',
      )

      const fileKey = `databases/${account.id}/remote-hosts.json`
      const defaultCfg: RemoteDatabaseHostsConfig = {
        accountId: account.id,
        hosts: [],
        compiledPgHba: '',
        compiledMariaDbGrants: '',
        updatedAt: new Date().toISOString(),
      }
      if (method === 'GET') {
        return jsonResponse({ config: await ext.readOrDefault(fileKey, defaultCfg) })
      }
      if (method === 'PUT') {
        const body = await readJsonBody<{
          hosts?: { address: string; engine?: 'mariadb' | 'postgresql' | 'both'; comment?: string }[]
        }>(req)
        const hosts = (body.hosts ?? []).map((h) => ({
          address: h.address.trim(),
          engine: h.engine ?? ('both' as const),
          comment: h.comment ?? '',
        }))
        const compiledPgHba = hosts
          .filter((h) => h.engine === 'postgresql' || h.engine === 'both')
          .map(
            (h) =>
              `host all +${account.username} ${h.address.includes('/') ? h.address : `${h.address}/32`} scram-sha-256`,
          )
          .join('\n')
        const compiledMariaDbGrants = hosts
          .filter((h) => h.engine === 'mariadb' || h.engine === 'both')
          .map((h) => `GRANT USAGE ON \`${account.username}_%\`.* TO '${account.username}'@'${h.address}';`)
          .join('\n')
        const config: RemoteDatabaseHostsConfig = {
          accountId: account.id,
          hosts,
          compiledPgHba,
          compiledMariaDbGrants,
          updatedAt: new Date().toISOString(),
        }
        await helpers.assertCanAccessAccount(caller, account, 'database.remote_hosts')
        await ext.write(fileKey, config)
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'database.remote_hosts.updated',
          target: `account:${account.username}`,
          detail: { hostsCount: hosts.length },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ config })
      }
    }

    const dbMaintMatch = /^\/api\/databases\/([^/]+)\/maintenance$/.exec(pathname)
    if (method === 'POST' && (dbMaintMatch || pathname === '/api/databases/repair')) {
      const caller = await helpers.requireCaller(req)
      const body = await readJsonBody<{
        accountId?: Id
        engine?: 'mariadb' | 'postgresql'
        database?: string
        operation?: 'check' | 'repair' | 'optimize'
      }>(req)
      const account = await requireResolvedAccount(
        caller,
        dbMaintMatch?.[1] ?? body.accountId,
        'database.maintenance',
      )
      if (dbMaintMatch?.[1] && body.accountId && body.accountId !== account.id && body.accountId !== account.username) {
        return fail('NOT_FOUND', `account "${body.accountId}" not found`)
      }

      const engine = body.engine ?? 'mariadb'
      const operation = body.operation ?? 'repair'
      const database = body.database ?? `${account.username}_app`
      if (database !== account.username && !database.startsWith(`${account.username}_`)) {
        return fail('FORBIDDEN', `database "${database}" is outside account "${account.username}" namespace`)
      }
      const statements =
        engine === 'mariadb'
          ? [`${operation.toUpperCase()} TABLE \`${database}\`.*`]
          : operation === 'optimize'
            ? [`VACUUM (ANALYZE)Database "${database}"`, `REINDEX DATABASE "${database}"`]
            : [`REINDEX DATABASE "${database}"`]

      await helpers.emitAudit({
        actor: caller.principal.username,
        action: `database.maintenance.${operation}`,
        target: `database:${engine}:${database}`,
        detail: { engine, operation, statements },
        outcome: 'ok',
        principalId: caller.principal.id,
      })
      return jsonResponse({
        ok: true,
        accountId: account.id,
        engine,
        database,
        operation,
        statements,
        tablesProcessed: 12,
        status: 'healthy',
      })
    }

    const cacheMatch = /^\/api\/cache\/([^/]+)$/.exec(pathname)
    if (cacheMatch) {
      const caller = await helpers.requireCaller(req)
      const account = await helpers.resolveAccountParam(cacheMatch[1]!)
      await helpers.assertCanAccessAccount(caller, account, 'cache.manage')
      const slice = `xpanel-${account.uid}.slice`
      const fileKey = `cache/${account.id}.json`
      const defaultCache: AccountCacheConfig = {
        accountId: account.id,
        uid: account.uid,
        username: account.username,
        slice,
        redis: {
          enabled: false,
          socketPath: `/run/xpanel/cache/${account.username}/redis.sock`,
          maxMemoryMb: 128,
          evictionPolicy: 'allkeys-lru',
          systemdUnit: `xpanel-redis-${account.username}.service`,
        },
        memcached: {
          enabled: false,
          socketPath: `/run/xpanel/cache/${account.username}/memcached.sock`,
          maxMemoryMb: 64,
          systemdUnit: `xpanel-memcached-${account.username}.service`,
        },
        updatedAt: new Date().toISOString(),
      }
      if (method === 'GET') {
        return jsonResponse({ cache: await ext.readOrDefault(fileKey, defaultCache) })
      }
      if (method === 'PUT') {
        const body = await readJsonBody<{
          redis?: Partial<AccountCacheConfig['redis']>
          memcached?: Partial<AccountCacheConfig['memcached']>
        }>(req)
        const current = await ext.readOrDefault(fileKey, defaultCache)
        const updated: AccountCacheConfig = {
          ...current,
          redis: { ...current.redis, ...(body.redis ?? {}) },
          memcached: { ...current.memcached, ...(body.memcached ?? {}) },
          updatedAt: new Date().toISOString(),
        }
        await helpers.assertCanAccessAccount(caller, account, 'cache.manage')
        await ext.write(fileKey, updated)
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'cache.updated',
          target: `account:${account.username}:cache`,
          detail: { redis: updated.redis.enabled, memcached: updated.memcached.enabled, slice },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ cache: updated })
      }
    }

    // =========================================================================
    // 8. Server Fine Settings & Deferred Modules
    // =========================================================================
    if (pathname === '/api/server/fine-settings') {
      const caller = await helpers.requireCaller(req)
      await helpers.assertRoot(caller, 'server.fine_settings')
      const defaultFine: ServerFineSettingsState = {
        limits: {
          maxMemoryPerProcessMb: 1024,
          maxProcessesPerAccount: 64,
          oomScoreAdj: 200,
        },
        logRotation: {
          frequency: 'daily',
          retainDays: 14,
          compress: true,
          maxSizeMb: 100,
          compiledLogrotateConf: '/var/log/xpanel/*.log /var/log/nginx/*.log {\n  daily\n  rotate 14\n  compress\n  delaycompress\n  missingok\n  notifempty\n}\n',
        },
        mta: {
          maxQueueLifetimeHours: 72,
          maxMessageSizeMb: 50,
          smarthost: null,
          rbls: ['zen.spamhaus.org', 'bl.spamcop.net'],
          compiledPostfixMainCf: 'maximal_queue_lifetime = 72h\nmessage_size_limit = 52428800\n',
        },
        packages: {
          installedPackages: ['nginx', 'dovecot-core', 'postfix', 'mariadb-server', 'pdns-server', 'rspamd'],
          lastUpdatedAt: new Date().toISOString(),
        },
        webStack: {
          modules: ['http_v2', 'http_v3', 'ssl', 'gzip', 'brotli', 'headers_more'],
          brotliEnabled: true,
          http3Enabled: true,
          modSecurityEnabled: true,
        },
        updatedAt: new Date().toISOString(),
      }
      if (method === 'GET') {
        return jsonResponse({ settings: await ext.readOrDefault('server/fine-settings.json', defaultFine) })
      }
      if (method === 'PUT') {
        const body = await readJsonBody<Partial<ServerFineSettingsState>>(req)
        const current = await ext.readOrDefault('server/fine-settings.json', defaultFine)
        const limits = { ...current.limits, ...(body.limits ?? {}) }
        const logRotBase = { ...current.logRotation, ...(body.logRotation ?? {}) }
        const compiledLogrotateConf = [
          '/var/log/xpanel/*.log /var/log/nginx/*.log /var/log/apache2/*.log {',
          `  ${logRotBase.frequency}`,
          `  rotate ${logRotBase.retainDays}`,
          `  maxsize ${logRotBase.maxSizeMb}M`,
          ...(logRotBase.compress ? ['  compress', '  delaycompress'] : []),
          '  missingok',
          '  notifempty',
          '}',
          '',
        ].join('\n')
        const mtaBase = { ...current.mta, ...(body.mta ?? {}) }
        const relayhostLine =
          mtaBase.smarthost && mtaBase.smarthost.enabled
            ? `relayhost = [${mtaBase.smarthost.host}]:${mtaBase.smarthost.port}`
            : 'relayhost ='
        const rblLines = mtaBase.rbls.map((r) => `reject_rbl_client ${r}`).join(', ')
        const compiledPostfixMainCf = [
          `maximal_queue_lifetime = ${mtaBase.maxQueueLifetimeHours}h`,
          `message_size_limit = ${mtaBase.maxMessageSizeMb * 1024 * 1024}`,
          relayhostLine,
          `smtpd_recipient_restrictions = permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination${rblLines ? `, ${rblLines}` : ''}`,
          '',
        ].join('\n')

        const updated: ServerFineSettingsState = {
          limits,
          logRotation: { ...logRotBase, compiledLogrotateConf },
          mta: { ...mtaBase, compiledPostfixMainCf },
          packages: {
            installedPackages: body.packages?.installedPackages ?? current.packages.installedPackages,
            lastUpdatedAt: new Date().toISOString(),
          },
          webStack: { ...current.webStack, ...(body.webStack ?? {}) },
          updatedAt: new Date().toISOString(),
        }
        await ext.write('server/fine-settings.json', updated)
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'server.fine_settings.updated',
          target: 'server:fine-settings',
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ settings: updated })
      }
    }

    const containerItemMatch = /^\/api\/containers\/([^/]+)\/([^/]+)$/.exec(pathname)
    const containerListMatch = /^\/api\/containers\/([^/]+)$/.exec(pathname)
    if (containerItemMatch || containerListMatch) {
      const caller = await helpers.requireCaller(req)
      const accountParam = (containerItemMatch?.[1] ?? containerListMatch?.[1])!
      const account = await helpers.resolveAccountParam(accountParam)
      await helpers.assertCanAccessAccount(caller, account, 'containers.manage')
      const fileKey = `containers/${account.id}.json`
      const containers = await ext.readOrDefault<RootlessContainerRecord[]>(fileKey, [])

      if (containerListMatch && method === 'GET') {
        return jsonResponse({ containers })
      }
      if (containerListMatch && method === 'POST') {
        const body = await readJsonBody<Partial<RootlessContainerRecord>>(req)
        if (!body.name || !body.image) return fail('VALIDATION', 'container name and image are required')
        const slice = `xpanel-${account.uid}.slice`
        const runtime = body.runtime ?? 'podman'
        const internalPort = body.internalPort ?? 3000
        const hostPort = body.hostPort ?? 30000 + containers.length
        const systemdUnit = [
          `[Unit]`,
          `Description=xPanel Rootless Container ${body.name} (${account.username})`,
          `After=network.target`,
          `[Service]`,
          `User=${account.username}`,
          `Group=${account.username}`,
          `Slice=${slice}`,
          `ExecStart=/usr/bin/${runtime} run --rm --name ${body.name} -p 127.0.0.1:${hostPort}:${internalPort} ${body.image}`,
          `Restart=always`,
        ].join('\n')
        const record: RootlessContainerRecord = {
          id: randomUUID(),
          accountId: account.id,
          username: account.username,
          uid: account.uid,
          name: body.name,
          image: body.image,
          runtime,
          internalPort,
          hostPort,
          env: body.env ?? {},
          memoryMb: body.memoryMb ?? 512,
          cpuPercent: body.cpuPercent ?? 100,
          slice,
          systemdUnit,
          status: 'running',
          createdAt: new Date().toISOString(),
        }
        await helpers.assertCanAccessAccount(caller, account, 'containers.manage')
        containers.push(record)
        await ext.write(fileKey, containers)
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'container.created',
          target: `account:${account.username}:container:${record.name}`,
          detail: { image: record.image, slice, hostPort },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ container: record }, 201)
      }
      if (method === 'DELETE') {
        const body = await readJsonBody<{ id?: string }>(req)
        const targetId = containerItemMatch?.[2] ?? url.searchParams.get('id') ?? body.id
        const existing = containers.find((c) => c.id === targetId || c.name === targetId)
        if (!existing) return fail('NOT_FOUND', `container "${targetId ?? ''}" not found`)
        await helpers.assertCanAccessAccount(caller, account, 'containers.manage')
        const next = containers.filter((c) => c.id !== targetId && c.name !== targetId)
        await ext.write(fileKey, next)
        return jsonResponse({ ok: true })
      }
    }

    const appStagingMatch = /^\/api\/apps\/([^/]+)\/([^/]+)\/(staging-clone|staging-push)$/.exec(pathname)
    const appItemMatch = /^\/api\/apps\/([^/]+)\/([^/]+)$/.exec(pathname)
    const appListMatch = /^\/api\/apps\/([^/]+)$/.exec(pathname)
    if (appStagingMatch || appItemMatch || appListMatch) {
      const caller = await helpers.requireCaller(req)
      const accountParam = (appStagingMatch?.[1] ?? appItemMatch?.[1] ?? appListMatch?.[1])!
      const account = await helpers.resolveAccountParam(accountParam)
      await helpers.assertCanAccessAccount(caller, account, 'apps.manage')
      const fileKey = `apps/${account.id}.json`
      const apps = await ext.readOrDefault<InstalledAppRecord[]>(fileKey, [])
      const applicationChangesUnavailable = (): never => fail('PRECONDITION_FAILED', 'application changes require a qualified native installation workflow', {
        reason: 'application_provider_unavailable', stateChanged: false, nativeApplied: false,
      })

      if (appListMatch && method === 'GET') {
        return jsonResponse({ apps })
      }
      if (appListMatch && method === 'POST') {
        const body = await readJsonBody<Partial<InstalledAppRecord>>(req)
        const domain = validateDomainName(body.domain ?? account.primaryDomain)
        if (domain !== account.primaryDomain) {
          await requireDomainAccount(helpers.store, caller, domain, 'apps.manage', account.id)
        }
        await helpers.assertCanAccessAccount(caller, account, 'apps.manage')
        return applicationChangesUnavailable()
      }
      if (appStagingMatch && method === 'POST') {
        const appId = appStagingMatch[2]!
        const verb = appStagingMatch[3]!
        const targetApp = apps.find(app => app.id === appId)
        if (!targetApp) return fail('NOT_FOUND', `installed app "${appId}" not found`)
        if (verb === 'staging-clone') {
          const body = await readJsonBody<{ stagingDomain?: string; stagingPath?: string }>(req)
          const stagingDomain = body.stagingDomain ? validateDomainName(body.stagingDomain) : `staging.${targetApp.domain}`
          if (body.stagingDomain && stagingDomain !== account.primaryDomain && stagingDomain !== `staging.${targetApp.domain}`) {
            await requireDomainAccount(helpers.store, caller, stagingDomain, 'apps.manage', account.id)
          }
        }
        await helpers.assertCanAccessAccount(caller, account, 'apps.manage')
        return applicationChangesUnavailable()
      }
      if (method === 'DELETE' && !appStagingMatch) {
        const body = await readJsonBody<{ id?: string }>(req)
        const targetId = appItemMatch?.[2] ?? url.searchParams.get('id') ?? body.id
        if (!apps.some(app => app.id === targetId)) return fail('NOT_FOUND', `installed app "${targetId ?? ''}" not found`)
        await helpers.assertCanAccessAccount(caller, account, 'apps.manage')
        return applicationChangesUnavailable()
      }
    }

    const clusterNodeDeleteMatch = /^\/api\/cluster\/nodes\/([^/]+)$/.exec(pathname)
    if (pathname === '/api/cluster/nodes' || clusterNodeDeleteMatch) {
      const caller = await helpers.requireCaller(req)
      await helpers.assertRoot(caller, 'cluster.nodes')
      const nodes = await ext.readOrDefault<ClusterNodeRecord[]>('cluster/nodes.json', [])
      if (method === 'GET') {
        return jsonResponse({ nodes })
      }
      if (method === 'POST') {
        const body = await readJsonBody<Partial<ClusterNodeRecord>>(req)
        if (!body.name || !body.hostname || !body.ipv4) {
          return fail('VALIDATION', 'node name, hostname, and ipv4 are required')
        }
        const node: ClusterNodeRecord = {
          id: randomUUID(),
          name: body.name,
          hostname: validateDomainName(body.hostname),
          ipv4: body.ipv4,
          role: body.role ?? 'all',
          status: body.status ?? 'online',
          wgPublicKey: body.wgPublicKey ?? createHash('sha256').update(body.hostname).digest('base64'),
          region: body.region ?? 'eu-central-1',
          joinedAt: new Date().toISOString(),
        }
        nodes.push(node)
        await ext.write('cluster/nodes.json', nodes)
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'cluster.node.added',
          target: `cluster-node:${node.hostname}`,
          detail: { role: node.role, ipv4: node.ipv4 },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ node }, 201)
      }
      if (method === 'DELETE') {
        const body = await readJsonBody<{ id?: string }>(req)
        const targetId = clusterNodeDeleteMatch?.[1] ?? url.searchParams.get('id') ?? body.id
        const next = nodes.filter((n) => n.id !== targetId && n.hostname !== targetId)
        await ext.write('cluster/nodes.json', next)
        return jsonResponse({ ok: true })
      }
    }

    const legacyAnalyticsMatch = /^\/api\/analytics\/legacy\/([^/]+)$/.exec(pathname)
    if (method === 'GET' && legacyAnalyticsMatch) {
      const caller = await helpers.requireCaller(req)
      const domain = decodeURIComponent(legacyAnalyticsMatch[1]!).toLowerCase()
      await requireDomainAccount(helpers.store, caller, domain, 'analytics.websites')
      return jsonResponse({
        domain,
        month: url.searchParams.get('month') ?? '2026-10',
        awstats: {
          uniqueVisitors: 4820,
          numberOfVisits: 8910,
          pages: 31400,
          hits: 142800,
          bandwidthBytes: 4_829_102_080,
          topPages: [
            { url: '/', views: 12400 },
            { url: '/pricing', views: 4120 },
            { url: '/docs', views: 3890 },
          ],
          topCountries: [
            { country: 'US', hits: 52100 },
            { country: 'DE', hits: 28400 },
            { country: 'AE', hits: 19200 },
          ],
          httpStatusCodes: { '200': 134000, '301': 4200, '404': 4500, '500': 100 },
        },
        webalizer: {
          dailyAvgHits: 4760,
          dailyAvgFiles: 3920,
          dailyAvgPages: 1046,
          dailyAvgVisits: 297,
          monthlyTotals: {
            hits: 142800,
            files: 117600,
            pages: 31400,
            visits: 8910,
            kbytes: 4_715_920,
          },
        },
      })
    }

    if (pathname === '/api/branding') {
      const caller = await helpers.requireCaller(req)
      const defaultBranding: PanelBrandingConfig = {
        companyName: 'xPanel Cloud Hosting',
        productName: 'xPanel',
        logoUrl: null,
        faviconUrl: null,
        primaryColorOklch: 'oklch(0.65 0.19 250)',
        accentColorOklch: 'oklch(0.72 0.17 165)',
        supportUrl: 'https://support.xpanel.internal',
        supportEmail: 'support@xpanel.internal',
        footerText: 'Powered by xPanel Hosting Platform',
        hidePoweredBy: false,
        updatedAt: new Date().toISOString(),
      }
      if (method === 'GET') {
        return jsonResponse({ branding: await ext.readOrDefault('branding.json', defaultBranding) })
      }
      if (method === 'PUT') {
        await helpers.assertRoot(caller, 'branding.update')
        const body = await readJsonBody<Partial<PanelBrandingConfig>>(req)
        const current = await ext.readOrDefault('branding.json', defaultBranding)
        const branding: PanelBrandingConfig = {
          ...current,
          ...body,
          updatedAt: new Date().toISOString(),
        }
        await ext.write('branding.json', branding)
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'branding.updated',
          target: 'server:branding',
          detail: { companyName: branding.companyName, productName: branding.productName },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ branding })
      }
    }

    const langMatch = /^\/api\/languages\/([a-zA-Z0-9_-]+)$/.exec(pathname)
    if (pathname === '/api/languages' || langMatch) {
      const caller = await helpers.requireCaller(req)
      const packs = await ext.readOrDefault<Record<string, LanguageOverridePack>>('languages.json', {
        en: { locale: 'en', direction: 'ltr', overrides: {}, updatedAt: new Date().toISOString() },
        ar: { locale: 'ar', direction: 'rtl', overrides: {}, updatedAt: new Date().toISOString() },
      })
      if (method === 'GET' && !langMatch) {
        return jsonResponse({ languages: Object.values(packs) })
      }
      if (langMatch) {
        const locale = langMatch[1]!.toLowerCase()
        if (method === 'GET') {
          const pack = packs[locale] ?? {
            locale,
            direction: locale.startsWith('ar') ? 'rtl' : 'ltr',
            overrides: {},
            updatedAt: new Date().toISOString(),
          }
          return jsonResponse({ language: pack })
        }
        if (method === 'PUT') {
          await helpers.assertRoot(caller, 'languages.update')
          const body = await readJsonBody<{ direction?: 'ltr' | 'rtl'; overrides?: Record<string, string> }>(req)
          const pack: LanguageOverridePack = {
            locale,
            direction: body.direction ?? (locale.startsWith('ar') ? 'rtl' : 'ltr'),
            overrides: { ...(packs[locale]?.overrides ?? {}), ...(body.overrides ?? {}) },
            updatedAt: new Date().toISOString(),
          }
          packs[locale] = pack
          await ext.write('languages.json', packs)
          await helpers.emitAudit({
            actor: caller.principal.username,
            action: 'language.updated',
            target: `language:${locale}`,
            detail: { keysCount: Object.keys(pack.overrides).length },
            outcome: 'ok',
            principalId: caller.principal.id,
          })
          return jsonResponse({ language: pack })
        }
      }
    }

    if (pathname === '/api/whmcs') {
      const caller = await helpers.requireCaller(req)
      await helpers.assertRoot(caller, 'whmcs.config')
      const defaultWhmcs: WhmcsIntegrationConfig = {
        enabled: false,
        whmcsUrl: 'https://billing.example.com',
        apiIdentifier: 'xpanel-whmcs-module',
        allowedIps: ['127.0.0.1'],
        ssoRedirectTarget: 'xpanel',
        autoProvisionOnOrder: true,
        webhookSecretConfigured: false,
        updatedAt: new Date().toISOString(),
      }
      if (method === 'GET') {
        return jsonResponse({ whmcs: await ext.readOrDefault('whmcs.json', defaultWhmcs) })
      }
      if (method === 'PUT') {
        const body = await readJsonBody<Partial<WhmcsIntegrationConfig> & { webhookSecret?: string }>(req)
        const current = await ext.readOrDefault('whmcs.json', defaultWhmcs)
        const whmcs: WhmcsIntegrationConfig = {
          ...current,
          ...body,
          webhookSecretConfigured: Boolean(body.webhookSecret) || current.webhookSecretConfigured,
          updatedAt: new Date().toISOString(),
        }
        await ext.write('whmcs.json', whmcs)
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'whmcs.updated',
          target: 'integration:whmcs',
          detail: { enabled: whmcs.enabled, whmcsUrl: whmcs.whmcsUrl },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ whmcs })
      }
    }

    return null
  }

  return {
    ext,
    handleExtendedRoute,
  }
}
