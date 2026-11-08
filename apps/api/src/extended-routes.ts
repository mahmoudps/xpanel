import { createHash, createPublicKey, randomUUID } from 'node:crypto'
import { handleAccountDbMaintenanceRoute } from './account-db-maintenance-workspace.ts'
import type { AccountDbMaintenanceHost } from './account-db-maintenance-workspace.ts'
import { isIP } from 'node:net'
import { services as mailServices, system } from '@xpanel/render'
import { join } from 'node:path'
import {
  effectivePlan,
  fail,
  assertBool,
  assertCidr,
  assertLine,
  assertRedirectTarget,
  assertRelPath,
  oneOf,
  assessMailboxMetadataAuthority,
  isXpanelError,
  suggestServerSettings,
  validateDomainName,
  validateServerHostname,
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
import type { StateStore, WriterLease } from '@xpanel/state'
import { readRuntimeRegistry } from '../../agent/src/account-runtime.ts'
import { validateQuotaFilesystem } from '../../agent/src/services/quota.ts'
import { passwordHashFromInput } from './auth.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { createContactToolsRoutes, createContactMetadataAccess, assertContactMutationCapacity } from './mail/contact-tools-routes.ts'
import { assertMailboxMetadataAuthority, captureMailboxMetadataAuthority, readBoundMailboxIdentityRecords, resolveMailboxMetadataAuthority, MAILBOX_METADATA_REVIEW_REQUIRED } from './mail/metadata-authority.ts'
import { createIdentityMetadataRoutes } from './mail/identity-routes.ts'
import { readContactVcards } from './mail/contact-vcard.ts'
import { createCalendarWorkspaceRoutes } from './mail/calendar-workspace.ts'
import type { DavSession } from './mail/dav-store.ts'
import { sameContacts } from './mail/dav-store.ts'
import { createAccountCollaborationRoutes } from './account-collaboration-workspace.ts'
import { parseCalendarWorkspaceIcs, renderCalendarWorkspaceIcs } from './mail/calendar-ics.ts'
import { createWhmBackupWorkspaceRoutes } from './backup-workspace.ts'
import { createTransferWorkspaceRoutes } from './transfer-workspace.ts'
import type { TransferWorkspacePorts } from './transfer-workspace.ts'
import { createTransferSourceDiscovery } from './acct-transfer-discovery.ts'
import { readTransferCredentialToken } from './acct-transfer-credentials.ts'
import { canonicalForwarderAddress, validateForwarderInput, type ForwarderAction } from './mail/forwarder-validation.ts'
import type { ListPolicy } from '../../agent/src/list-moderation-policy.ts'
import { applyMailRoutingChange, commitRoutingRevision, readMailRoutingStatus, reconcileApplied, type MailRoutingRecordState, type MailRoutingStatusView } from './mail/routing-application.ts'
import { createFilterRoutes } from './mail/filter-routes.ts'
import { handleWebAppsRoute } from './web-apps-routes.ts'
import { handleAddressImport } from './mail/address-import.ts'
import { assertDnsZoneRevision, dnsZoneRevision } from './dns-workspace.ts'
import { createAutoresponderRoutes } from './mail/autoresponder-routes.ts'
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

/** The account's calendar store (mail/dav-store.ts): one session per request, one writer per mailbox. */
export interface WebmailDavPorts {
  open: (caller: AuthenticatedCaller, account: Pick<Account, 'id' | 'username'>, authority: MailboxMetadataAuthority) => DavSession
  lock: (key: string) => Promise<() => void>
}

export interface ExtendedRouteHelpers {
  db: Db
  store: StateStore
  dav: WebmailDavPorts
  homeBaseDir?: string
  serverSecret?: string
  /** Fresh read-only enforcement observation from the protected native agent; never a saved setup flag. */
  readQuotaState?: (caller: AuthenticatedCaller, path: string) => Promise<unknown>
  /** The agent's account database check and repair; absent without the host agent. */
  maintainDatabase?: AccountDbMaintenanceHost
  /** Removes a deleted list's held posts as its account; absent without the host agent. */
  purgeListQueue?: (caller: AuthenticatedCaller, accountId: Id, address: string) => Promise<unknown>
  /** Root quota setup on the protected native agent; a refusal carries the agent's own code, text and details. */
  initializeQuota?: (caller: AuthenticatedCaller, path: string) => Promise<Record<string, unknown>>
  backupDestinationHost?: (caller: AuthenticatedCaller, path: string, body?: unknown) => Promise<unknown>
  /** Server-to-server transfer execution (apps/api/src/lifecycle-transfer-execution.ts); absent without the host agent. */
  /** Native transfer execution, background caller and cPanel import; absent without the host agent. */
  transferPorts?: Pick<TransferWorkspacePorts, 'execution' | 'callerFor' | 'cpanel' | 'nodeAuth'>
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
  /** absent on records saved before reject existed means forward */
  action?: ForwarderAction
  destinations: string[]
  rejectMessage?: string
  createdAt: string
}

/** cPanel "default address": what happens to mail for an address that does not exist on the domain. */
export interface DefaultAddressRecord {
  accountId: Id
  domain: string
  kind: 'reject' | 'forward' | 'discard'
  destination: string | null
  updatedAt: string
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
  /** Posting rules beyond `moderation`; set from list moderation. */
  policy?: ListPolicy
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
  /** Daily copies; weekly and monthly copies keep the newest archive of each of that many ISO weeks and months. */
  retentionCount: number
  retentionWeekly: number
  retentionMonthly: number
  compress: 'zstd' | 'gzip'
  includeDatabases: boolean
  includeMail: boolean
  includeDns: boolean
  /** Once-per-run snapshot of desired state and the index database, for disaster recovery and upgrade rollback. */
  includeControl: boolean
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

export interface RemoteDatabaseHostsConfig {
  accountId: Id
  hosts: { address: string; engine: 'mariadb' | 'postgresql' | 'both'; comment: string }[]
  compiledPgHba: string
  compiledMariaDbGrants: string
  updatedAt: string
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

/** An object holding only writable keys; values are validated by the caller before reaching a rendered line. */
const writableFields = (value: unknown, allowed: readonly string[], what: string): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key))
    ? value as Record<string, unknown>
    : fail('VALIDATION', `${what} accepts only ${allowed.join(', ')}`, { stateChanged: false })

const boundedList = (value: unknown, max: number, what: string): unknown[] =>
  Array.isArray(value) && value.length <= max ? value : fail('VALIDATION', `${what} must be a list of at most ${max} entries`, { stateChanged: false })

const matching = (value: unknown, pattern: RegExp, what: string): string =>
  typeof value === 'string' && pattern.test(value) ? value : fail('VALIDATION', `invalid ${what}`, { stateChanged: false })

/** A site path such as /errors/404.html: shared relative-path rules after the leading slash. */
const sitePath = (value: unknown, what: string): string =>
  typeof value === 'string' && value.length > 1 && value.startsWith('/') ? `/${assertRelPath(value.slice(1), what)}` : fail('VALIDATION', `${what} must be a site path starting with /`, { stateChanged: false })

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

/** Internal held StateStore lease, never a JSON field or caller-selected bypass. */
export interface AccountTemplateWriteFence { assertFencingToken(): Promise<unknown> }

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

  async write<T>(relPath: string, value: T, options?: { templateWriter?: AccountTemplateWriteFence }): Promise<T> {
    const target = this.filePath(relPath), templates = this.filePath('accounts/templates.json')
    const template = process.platform === 'win32' ? target.toLowerCase() === templates.toLowerCase() : target === templates
    // This source is pinned by prepared account activation. Every writer must participate in
    // its StateStore fence; an ordinary extended-file write cannot bypass that one-path rule.
    if (template && !options?.templateWriter) return fail('PRECONDITION_FAILED', 'account template writes require the held StateStore writer', { stateChanged: false })
    if (template) await options!.templateWriter!.assertFencingToken()
    await atomicWriteJson(target, value)
    if (template) await options!.templateWriter!.assertFencingToken()
    return value
  }
}

// ---------------------------------------------------------------------------
// Router Handler
// ---------------------------------------------------------------------------

export const createExtendedApiRouter = (helpers: ExtendedRouteHelpers) => {
  const ext = new ExtendedFeaturesStore(helpers.store.rootDir)
  const observeSetupQuota = async (caller: AuthenticatedCaller, path: string, requested: boolean) => {
    const unavailable = (reason: string) => ({ quotaInitialized: false, quotaInitialization: { status: 'unavailable' as const, reason } })
    if (!helpers.readQuotaState) return requested ? unavailable('host_quota_initialization_not_connected')
      : { quotaInitialized: false, quotaInitialization: { status: 'not_requested' as const, reason: null } }
    try {
      const raw = await helpers.readQuotaState(caller, path)
      const value = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null
      if (value?.status === 'unavailable' && typeof value.reason === 'string' && /^[a-z0-9_]{1,80}$/.test(value.reason)) return unavailable(value.reason)
      if (!value || !['enabled', 'disabled'].includes(String(value.status)) || typeof value.filesystem !== 'string'
        || !['ext4', 'xfs'].includes(String(value.filesystemType)) || typeof value.source !== 'string' || !value.source.trim() || value.reason !== null) return unavailable('host_quota_observation_invalid')
      const filesystem = validateQuotaFilesystem(value.filesystem)
      if (filesystem !== '/' && path !== filesystem && !path.startsWith(filesystem + '/')) return unavailable('host_quota_observation_invalid')
      const enabled = value.status === 'enabled'
      return { quotaInitialized: enabled, quotaInitialization: { status: enabled ? 'enabled' as const : 'disabled' as const,
        reason: enabled ? null : 'quota_not_enforced', filesystem, filesystemType: value.filesystemType as 'ext4' | 'xfs', observedAt: new Date().toISOString() } }
    } catch { return unavailable('host_quota_observation_failed') }
  }
  const freshExtendedMailCaller = async (req: Request, previous: AuthenticatedCaller): Promise<AuthenticatedCaller> => {
    const fresh = await helpers.requireCaller(req)
    if (isMailboxPrincipal(fresh) || fresh.principal.id !== previous.principal.id || fresh.principal.kind !== previous.principal.kind || fresh.sessionId !== previous.sessionId || fresh.apiTokenId !== previous.apiTokenId || fresh.principal.kind === 'user' && previous.principal.kind === 'user' && fresh.principal.accountId !== previous.principal.accountId) return fail('FORBIDDEN', 'mail administration authorization changed', { stateChanged: false })
    return fresh
  }
  const publicMailingList = (record: MailingListRecord) => { const { memberAuthorities: _bindings, ...visible } = record; return visible }


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

  const applyMailRouting = (caller: AuthenticatedCaller, revision: number, restore: { relPath: string; previous: unknown }) => applyMailRoutingChange({
    store: helpers.store, db: helpers.db, reconcile: () => helpers.triggerReconcile(caller),
    audit: reason => helpers.emitAudit({ actor: caller.principal.username, action: 'mail.routing.rolled_back', target: 'mail-routing:' + restore.relPath,
      detail: { reason }, outcome: 'failed', principalId: caller.principal.id }),
  }, revision, { path: join(ext.baseDir, restore.relPath), previous: restore.previous })

  const forwarderView = (record: EmailForwarder, status: MailRoutingStatusView) => ({
    ...record, action: record.action ?? 'forward',
    application: status.record('forwarder', record.id, { domain: record.sourceAddress.split('@')[1] ?? '' }),
  })

  const handleAutoresponderRoute = createAutoresponderRoutes({ store: helpers.store, ext, requireCaller: helpers.requireCaller, requireResolvedAccount,
    emitAudit: helpers.emitAudit, readRoutingStatus: () => readMailRoutingStatus(helpers.store, helpers.db), commitRoutingRevision, applyRouting: applyMailRouting })

  const handleFilterRoute = createFilterRoutes({
    store: helpers.store, requireCaller: helpers.requireCaller, emitAudit: helpers.emitAudit,
    readFilters: () => ext.readOrDefault<unknown[]>('mail/filters.json', []),
    writeFilters: values => ext.write('mail/filters.json', values),
    commitRoutingRevision,
    applyFilters: (caller, revision, previous) => applyMailRouting(caller, revision, { relPath: 'mail/filters.json', previous }),
    readRoutingStatus: () => readMailRoutingStatus(helpers.store, helpers.db),
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
    dav: helpers.dav,
    parseIcs: parseCalendarWorkspaceIcs, renderIcs: renderCalendarWorkspaceIcs,
  })
  const handleAccountCollaborationRoute = helpers.serverSecret ? createAccountCollaborationRoutes({
    store: helpers.store, serverSecret: helpers.serverSecret, requireCaller: helpers.requireCaller,
    assertCanAccessAccount: helpers.assertCanAccessAccount, emitAudit: helpers.emitAudit,
    dav: helpers.dav, calendarRoute: handleCalendarWorkspaceRoute,
  }) : async (_req: Request, url: URL, _method: string): Promise<Response | null> => /^\/api\/account\/collaboration(?:\/|$)/.test(url.pathname) ? fail('PRECONDITION_FAILED', 'collaboration authority is unavailable', { stateChanged: false }) : null
  const handleBackupWorkspaceRoute = createWhmBackupWorkspaceRoutes({
    store: helpers.store, requireCaller: helpers.requireCaller, assertRoot: helpers.assertRoot, emitAudit: helpers.emitAudit,
    read: key => ext.readOrDefault<unknown | null>(key, null),
    publish: (key, value, lease) => atomicWriteJson(join(ext.baseDir, key), value, 0o640, () => lease.assertFencingToken()),
    ...(helpers.backupDestinationHost ? { destinationHost: helpers.backupDestinationHost } : {}),
  })
  const handleTransferWorkspaceRoute = createTransferWorkspaceRoutes(helpers, { discover: createTransferSourceDiscovery({ readToken: id => readTransferCredentialToken(helpers.store, id) }),
    ...(helpers.transferPorts ?? {}) })
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
    if (pathname === '/api/setup/wizard/complete') {
      if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
      const caller = await helpers.requireCaller(req)
      await helpers.assertRoot(caller, 'setup.wizard')
      if (await helpers.store.isSetupComplete()) return fail('CONFLICT', 'setup is already complete', { stateChanged: false })
      const settings = await helpers.store.getServerSettings()
      if (!settings) return fail('PRECONDITION_FAILED', 'save the server settings before completing setup', { stateChanged: false })
      await helpers.store.markSetupComplete()
      await helpers.emitAudit({ actor: caller.principal.username, action: 'setup.wizard.completed', target: `server:${settings.hostname}`, outcome: 'ok', principalId: caller.principal.id })
      return jsonResponse({ ok: true, setupComplete: true })
    }
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
        const quotaFilesystem = validateQuotaFilesystem(wizardState?.quotaFilesystem ?? '/home')
        const quota = await observeSetupQuota(caller, quotaFilesystem, wizardState?.quotaInitializationRequested !== false)
        return jsonResponse({
          setupComplete,
          settings,
          ips,
          wizardState: wizardState ? { ...wizardState, ...quota } : null,
          ...quota,
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

        const quotaFilesystem = validateQuotaFilesystem(body.quotaFilesystem ?? '/home')

        const suggested = suggestServerSettings({ cores: 4, memoryMb: 8192 })
        const existingSettings = await helpers.store.getServerSettings()
        if (existingSettings && body.sshPort !== undefined && body.sshPort !== existingSettings.sshPort) return fail('VALIDATION', 'use the guarded SSH workspace to change the SSH port', { stateChanged: false })
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
        if (hostname.length > 64) return fail('VALIDATION', 'the server host name must be at most 64 characters', { stateChanged: false })
        const nameservers = (body.nameservers ?? existingSettings?.nameservers ?? [`ns1.${hostname}`, `ns2.${hostname}`]).map(
          (ns) => validateDomainName(ns),
        )
        const adminEmail = body.contactEmail ?? body.adminEmail ?? existingSettings?.adminEmail ?? `admin@${hostname}`
        const engine = body.engine ?? existingSettings?.engine ?? 'apache'
        const apacheMpm = body.apacheMpm ?? existingSettings?.apacheMpm ?? 'itk'

        if (body.panelPort !== undefined && body.panelPort !== (existingSettings?.panelPort ?? 2087)) return fail('VALIDATION', 'the panel port moves on the Panel access page', { stateChanged: false, reason: 'panel_port_moves_on_panel_access' })
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

        const quotaInitializationRequested = body.initQuotas !== false
        // A successful CLI/installer initialization is reflected by a fresh native read, never by request intent.
        // This setup write does not remount filesystems or initialize quota accounting.
        const { quotaInitialized, quotaInitialization } = await observeSetupQuota(caller, quotaFilesystem, quotaInitializationRequested)

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
          quotaInitializationRequested,
          quotaInitialization,
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
          quotaInitialization,
          reconcile: reconcile?.body ?? null,
        })
      }
    }

    if (method === 'POST' && pathname === '/api/server/hostname') {
      const caller = await helpers.requireCaller(req)
      await helpers.assertRoot(caller, 'server.hostname_change')
      const body = await readJsonBody<{ hostname?: string }>(req)
      if (!body.hostname) return fail('VALIDATION', 'hostname is required')
      const hostname = validateServerHostname(body.hostname, (await helpers.store.listDomains()).map(domain => domain.name))
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

      const reconcile = await helpers.triggerReconcile(caller)
      // Applied only when the agent reconciled and observed the saved name as the kernel host name.
      const observed = reconcile?.body.kernelHostname
      const kernelHostname = typeof observed === 'string' ? observed : null
      const nativeApplied = reconcile !== null && reconcile.ok && (reconcile.body.status === 'applied' || reconcile.body.status === 'noop') && kernelHostname === updated.hostname
      await helpers.emitAudit({
        actor: caller.principal.username,
        action: 'server.hostname_change',
        target: `server:${hostname}`,
        detail: { previousHostname, hostname, nativeApplied },
        outcome: 'ok',
        principalId: caller.principal.id,
      })
      return jsonResponse({
        hostname: updated.hostname,
        previousHostname,
        settings: updated,
        application: { nativeApplied, kernelHostname },
        reconcile: reconcile?.body ?? null,
      })
    }

    if (method === 'POST' && pathname === '/api/server/quotas/init') {
      const caller = await helpers.requireCaller(req)
      await helpers.assertRoot(caller, 'server.quota_init')
      const body = await readJsonBody<{ filesystem?: string }>(req)
      const filesystem = validateQuotaFilesystem(body.filesystem === undefined ? '/home' : body.filesystem)
      if (!helpers.initializeQuota) {
        return fail('SERVICE_UNAVAILABLE', 'host quota initialization is not connected; no quota state was changed', {
          filesystem, stateChanged: false, reason: 'host_quota_initialization_not_connected',
        })
      }
      const audit = (outcome: 'ok' | 'failed', detail: Record<string, unknown>) => helpers.emitAudit({
        actor: caller.principal.username, action: 'server.quota_init', target: `filesystem:${filesystem}`,
        detail: { filesystem, ...detail }, outcome, principalId: caller.principal.id,
      })
      let result: Record<string, unknown>
      try { result = await helpers.initializeQuota(caller, filesystem) }
      catch (error) {
        await audit('failed', { reason: error instanceof Error ? error.message : 'unknown' })
        throw error
      }
      await audit('ok', { changed: result.changed, fstabBackup: result.fstabBackup ?? null })
      return jsonResponse(result)
    }

    // =========================================================================
    // 2. Deep Mail (/api/mail/*)
    // =========================================================================
    const domFwdDeleteMatch = /^\/api\/mail\/domain-forwarders\/([^/]+)$/.exec(pathname)
    if (pathname === '/api/mail/domain-forwarders' || domFwdDeleteMatch) {
      const caller = await helpers.requireCaller(req)
      const domainForwarderView = (record: DomainForwarder, status: MailRoutingStatusView) => ({
        ...record, application: status.record('domain-forwarder', record.id, { domain: record.sourceDomain }),
      })
      if (method === 'GET') {
        const list = await ext.readOrDefault<DomainForwarder[]>('mail/domain-forwarders.json', [])
        const status = await readMailRoutingStatus(helpers.store, helpers.db)
        return jsonResponse({ domainForwarders: (await scopedRecords(caller, list)).map(record => domainForwarderView(record, status)) })
      }
      if (method === 'POST' || method === 'DELETE') {
        const body = await readJsonBody<{ accountId?: Id; sourceDomain?: string; targetDomain?: string; id?: string }>(req)
        let lease: WriterLease | null = await helpers.store.getWriterLock().acquire()
        let record: DomainForwarder | undefined
        let previous: DomainForwarder[] | null
        let revision: number
        try {
          const stored = await ext.readOrDefault<DomainForwarder[] | null>('mail/domain-forwarders.json', null)
          previous = stored
          const list = stored ?? []
          let next: DomainForwarder[]
          if (method === 'POST') {
            const sourceDomain = validateDomainName(body.sourceDomain ?? '')
            const targetDomain = validateDomainName(body.targetDomain ?? '')
            if (sourceDomain === targetDomain) return fail('VALIDATION', 'sourceDomain and targetDomain must be different')
            const account = await requireDomainAccount(helpers.store, caller, sourceDomain, 'mail.domain_forwarder.create', body.accountId)
            await assertAccountFeatures(helpers.store, caller, account, ['forwarders'])
            if (list.some(item => item.sourceDomain === sourceDomain)) return fail('CONFLICT', 'This domain already has a domain forwarder')
            const defaults = await ext.readOrDefault<DefaultAddressRecord[]>('mail/default-addresses.json', [])
            if (defaults.some(item => item.domain === sourceDomain && item.kind !== 'reject')) return fail('CONFLICT', 'Set the default address of this domain to reject before adding a domain forwarder')
            record = { id: randomUUID(), accountId: account.id, sourceDomain, targetDomain, createdAt: new Date().toISOString() }
            next = [...list, record]
          } else {
            const targetId = domFwdDeleteMatch?.[1] ?? url.searchParams.get('id') ?? body.id
            record = list.find(item => item.id === targetId || item.sourceDomain === targetId)
            await assertRecordAccount(caller, record, 'mail.domain_forwarder.delete')
            next = list.filter(item => item !== record)
          }
          await lease.assertFencingToken()
          await ext.write('mail/domain-forwarders.json', next)
          revision = await commitRoutingRevision(lease)
        } finally { await lease?.release(); lease = null }
        const status = await applyMailRouting(caller, revision, { relPath: 'mail/domain-forwarders.json', previous })
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: method === 'POST' ? 'mail.domain_forwarder.created' : 'mail.domain_forwarder.deleted',
          target: `domain-forwarder:${record!.sourceDomain}->${record!.targetDomain}`,
          detail: { revision },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return method === 'POST'
          ? jsonResponse({ domainForwarder: domainForwarderView(record!, status), revision }, 201)
          : jsonResponse({ ok: true, revision })
      }
    }

    const fwdDeleteMatch = /^\/api\/mail\/forwarders\/([^/]+)$/.exec(pathname)
    if (pathname === '/api/mail/forwarders' || fwdDeleteMatch) {
      const caller = await helpers.requireCaller(req)
      if (method === 'GET') {
        const list = await ext.readOrDefault<EmailForwarder[]>('mail/forwarders.json', [])
        const status = await readMailRoutingStatus(helpers.store, helpers.db)
        return jsonResponse({ forwarders: (await scopedRecords(caller, list)).map(record => forwarderView(record, status)), generationId: status.generationId })
      }
      if (method === 'POST' || method === 'DELETE') {
        const input = method === 'POST' ? validateForwarderInput(await readJsonBody<unknown>(req)) : null
        const body = method === 'DELETE' ? await readJsonBody<{ id?: string }>(req) : {}
        let lease: WriterLease | null = await helpers.store.getWriterLock().acquire()
        let record: EmailForwarder | undefined
        let previous: EmailForwarder[] | null
        let revision: number
        try {
          const stored = await ext.readOrDefault<EmailForwarder[] | null>('mail/forwarders.json', null)
          previous = stored
          const list = stored ?? []
          let next: EmailForwarder[]
          if (input) {
            const { sourceAddress } = input
            const account = await requireDomainAccount(helpers.store, caller, sourceAddress.split('@')[1]!, 'mail.forwarder.create', input.accountId)
            await assertAccountFeatures(helpers.store, caller, account, ['forwarders'])
            const accountRecords = list.filter(item => item.accountId === account.id)
            if (accountRecords.some(item => item.sourceAddress.toLowerCase() === sourceAddress)) return fail('CONFLICT', 'A forwarder for this source already exists')
            if (input.action === 'reject') {
              const mailbox = await helpers.store.getServiceUserByLogin(sourceAddress)
              if (mailbox?.services.email) return fail('CONFLICT', 'This address is a mailbox; delete the mailbox before rejecting its mail')
            }
            const plan = await helpers.store.getPlan(account.planId)
            if (!plan) return fail('CONFLICT', 'The account plan is unavailable')
            const cap = effectivePlan(plan, account).caps.forwarders
            if (cap !== 'unlimited' && accountRecords.length >= cap) return fail('LIMIT_EXCEEDED', 'The account forwarder limit has been reached')
            record = {
              id: randomUUID(),
              accountId: account.id,
              sourceAddress,
              action: input.action,
              destinations: input.destinations,
              ...(input.rejectMessage === undefined ? {} : { rejectMessage: input.rejectMessage }),
              createdAt: new Date().toISOString(),
            }
            next = [...list, record]
          } else {
            const targetId = fwdDeleteMatch?.[1] ?? url.searchParams.get('id') ?? body.id
            record = list.find(item => item.id === targetId) ?? (await scopedRecords(caller, list)).find(item => item.sourceAddress === targetId)
            await assertRecordAccount(caller, record, 'mail.forwarder.delete')
            next = list.filter(item => item !== record)
          }
          await lease.assertFencingToken()
          await ext.write('mail/forwarders.json', next)
          revision = await commitRoutingRevision(lease)
        } finally { await lease?.release(); lease = null }
        const status = await applyMailRouting(caller, revision, { relPath: 'mail/forwarders.json', previous })
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: input ? 'mail.forwarder.created' : 'mail.forwarder.deleted',
          target: `forwarder:${record!.sourceAddress}`,
          detail: { action: record!.action ?? 'forward', destinations: record!.destinations, revision },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return input
          ? jsonResponse({ forwarder: forwarderView(record!, status), revision }, 201)
          : jsonResponse({ ok: true, revision })
      }
    }

    if (pathname === '/api/mail/default-addresses') {
      const caller = await helpers.requireCaller(req)
      const account = await requireResolvedAccount(caller, url.searchParams.get('accountId'), 'mail.default_address.read')
      await assertAccountFeatures(helpers.store, caller, account, ['forwarders'])
      const domains = (await helpers.store.listDomains()).filter(domain => domain.accountId === account.id).map(domain => domain.name).sort()
      const view = (records: readonly DefaultAddressRecord[], status: MailRoutingStatusView) => domains.map(domain => {
        const record = records.find(item => item.accountId === account.id && item.domain === domain)
        return { domain, kind: record?.kind ?? 'reject', destination: record?.destination ?? null, updatedAt: record?.updatedAt ?? null,
          application: status.record('default-address', domain, { domain }) }
      })
      if (method === 'GET') {
        const records = await ext.readOrDefault<DefaultAddressRecord[]>('mail/default-addresses.json', [])
        return jsonResponse({ context: { accountId: account.id }, defaultAddresses: view(records, await readMailRoutingStatus(helpers.store, helpers.db)) })
      }
      if (method === 'PUT') {
        const body = await readJsonBody<Record<string, unknown>>(req)
        if (!body || typeof body !== 'object' || Object.keys(body).some(key => !['domain', 'kind', 'destination'].includes(key))) return fail('VALIDATION', 'domain, kind and destination are the only default address fields')
        const domain = validateDomainName(String(body.domain ?? ''))
        if (!domains.includes(domain)) return fail('NOT_FOUND', 'domain not found')
        if (body.kind !== 'reject' && body.kind !== 'forward' && body.kind !== 'discard') return fail('VALIDATION', 'kind must be reject, forward or discard')
        const kind = body.kind
        if (kind !== 'forward' && body.destination != null) return fail('VALIDATION', 'only a forwarding default address has a destination')
        const destination = kind === 'forward' ? canonicalForwarderAddress(body.destination) : null
        let lease: WriterLease | null = await helpers.store.getWriterLock().acquire()
        let previous: DefaultAddressRecord[] | null
        let revision: number
        try {
          const stored = await ext.readOrDefault<DefaultAddressRecord[] | null>('mail/default-addresses.json', null)
          previous = stored
          if (kind !== 'reject' && (await ext.readOrDefault<DomainForwarder[]>('mail/domain-forwarders.json', [])).some(item => item.sourceDomain === domain)) {
            return fail('CONFLICT', 'This domain has a domain forwarder, which already routes its unknown addresses')
          }
          const next = [...(stored ?? []).filter(item => item.domain !== domain),
            ...(kind === 'reject' ? [] : [{ accountId: account.id, domain, kind, destination, updatedAt: new Date().toISOString() }])]
          await lease.assertFencingToken()
          await ext.write('mail/default-addresses.json', next)
          revision = await commitRoutingRevision(lease)
        } finally { await lease?.release(); lease = null }
        const status = await applyMailRouting(caller, revision, { relPath: 'mail/default-addresses.json', previous })
        await helpers.emitAudit({ actor: caller.principal.username, action: 'mail.default_address.updated', target: 'domain:' + domain,
          detail: { kind, destination, revision }, outcome: 'ok', principalId: caller.principal.id }, { accountId: account.id, resellerId: account.ownerId })
        const records = await ext.readOrDefault<DefaultAddressRecord[]>('mail/default-addresses.json', [])
        return jsonResponse({ context: { accountId: account.id }, defaultAddresses: view(records, status), revision })
      }
    }

    const mlDeleteMatch = /^\/api\/mail\/mailing-lists\/([^/]+)$/.exec(pathname)
    if (pathname === '/api/mail/mailing-lists' || mlDeleteMatch) {
      let caller = await helpers.requireCaller(req)
      let lease = method === 'POST' || method === 'DELETE' ? await helpers.store.getWriterLock().acquire() : null
      let attempted = false
      try {
      if (lease) caller = await freshExtendedMailCaller(req, caller)
      const previous = await ext.readOrDefault<MailingListRecord[] | null>('mail/mailing-lists.json', null)
      const list = [...previous ?? []]
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
        const revision = await commitRoutingRevision(lease!)
        await lease!.release(); lease = null
        const { nativeApplied } = await applyMailRouting(caller, revision, { relPath: 'mail/mailing-lists.json', previous })
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'mail.mailing_list.created',
          target: `mailing-list:${record.address}`,
          detail: { membersCount: record.members.length, revision, nativeApplied },
          outcome: 'ok',
          principalId: caller.principal.id,
        }, { accountId: account.id, resellerId: account.ownerId })
        return jsonResponse({ mailingList: publicMailingList(record), revision, nativeApplied }, 201)
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
        const revision = await commitRoutingRevision(lease!)
        await lease!.release(); lease = null
        const { nativeApplied } = await applyMailRouting(caller, revision, { relPath: 'mail/mailing-lists.json', previous })
        const queuePurged = selected?.accountId && helpers.purgeListQueue ? await helpers.purgeListQueue(caller, selected.accountId, selected.address).then(() => true, () => false) : false
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'mail.mailing_list.deleted',
          target: `mailing-list:${String(targetId)}`,
          detail: { revision, nativeApplied, queuePurged },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ ok: true, revision, nativeApplied })
      }
      } catch (error) {
        // a refused configuration test restored the previous lists: report that refusal as is
        if (attempted && !(isXpanelError(error) && error.code === 'CONFIG_TEST_FAILED')) return fail('SERVICE_UNAVAILABLE', 'mailing list administration outcome requires inspection', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
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

    if (method === 'POST' && pathname === '/api/mail/import-csv') return handleAddressImport(req, { helpers, ext, requireAccountId, readJsonBody, jsonResponse })

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
        const body = await readJsonBody<{ mailbox?: string; from?: string; to?: string[] | string; identityId?: Id | null }>(req)
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
        // This JSON store has no SMTP or IMAP behind it: real submission and the Sent copy belong to the sealed mailbox session.
        return fail('PRECONDITION_FAILED', 'send through the mailbox submission at /api/webmail/send; nothing was sent or stored', {
          reason: 'mailbox_submission_required', stateChanged: false,
        })
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
      const applicationOf = (status: MailRoutingStatusView): MailRoutingRecordState => status.record('autoresponder', mailbox, { mailbox })
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
        const application = applicationOf(await readMailRoutingStatus(helpers.store, helpers.db))
        if (!scoped) return jsonResponse({ vacation: projectVacationWorkspace(visible ?? defaultVac), application, metadataReview: MAILBOX_METADATA_REVIEW_REQUIRED })
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
        let previous: WebmailVacationConfig | null = null
        let stateRevision: number
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
          previous = current
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
          stateRevision = await commitRoutingRevision(lease)
        } catch (error) {
          if (writeAttempted) return fail('SERVICE_UNAVAILABLE', 'vacation write requires verification', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
          if (isXpanelError(error)) return fail(error.code, error.message, { ...error.detail, stateChanged: false })
          throw error
        } finally { await lease.release() }
        const application = applicationOf(await applyMailRouting(auditCaller, stateRevision, { relPath: fileKey, previous }))
        try {
          await helpers.emitAudit({ actor: auditCaller.principal.username, action: 'webmail.vacation.updated',
            target: `vacation:${vacation.mailbox}`, detail: { enabled: vacation.enabled, application: application.state, revision: stateRevision },
            outcome: 'ok', principalId: auditCaller.principal.id }, { accountId: auditAccount.id, resellerId: auditAccount.ownerId })
        } catch { return fail('SERVICE_UNAVAILABLE', 'vacation audit requires verification', { stateChanged: true, verificationRequired: true, unknownOutcome: true }) }
        return scoped ? jsonResponse({ context: { mailbox }, vacation: projectVacationWorkspace(vacation),
          revision: vacationWorkspaceRevision(vacation), stateChanged: true, application, metadataReview: MAILBOX_METADATA_REVIEW_REQUIRED })
          : jsonResponse({ vacation: projectVacationWorkspace(vacation), application, metadataReview: MAILBOX_METADATA_REVIEW_REQUIRED })
      }
    }

    // Account view of every mailbox autoresponder; each one is saved through /api/webmail/vacation
    const autoresponders = await handleAutoresponderRoute(req, url, method)
    if (autoresponders) return autoresponders

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
      // Each account has its own store, so a request names its mailbox before any record is read.
      const sentBody = !isMailboxPrincipal(caller) && ['POST', 'PATCH', 'PUT'].includes(method) ? await req.clone().json().catch(() => null) as { owner?: unknown; mailbox?: unknown } | null : null
      const scopeSelector = isMailboxPrincipal(caller) ? undefined : sentBody?.owner ?? sentBody?.mailbox ?? url.searchParams.get('mailbox')
      if (scopeSelector !== undefined && scopeSelector !== null && typeof scopeSelector !== 'string') return fail('VALIDATION', 'mailbox selector must be text', { stateChanged: false })
      const scopeMailbox = await requireMailbox(helpers.store, caller, scopeSelector)
      const scopeAuthority = await captureMailboxMetadataAuthority(helpers.store, scopeMailbox)
      const scopeAccount = await helpers.store.getAccount(scopeAuthority.accountId)
      if (!scopeAccount) return fail('NOT_FOUND', 'mailbox not found', { stateChanged: false })
      const session = helpers.dav.open(caller, scopeAccount, scopeAuthority)
      const contacts = await session.contacts()
      const collectionRevision = (values: readonly WebmailContact[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex')
      const originalCollectionRevision = collectionRevision(contacts)
      const mutateContacts = async <T>(mailbox: string, operation: (fresh: AuthenticatedCaller, current: WebmailContact[],
        persist: (values: WebmailContact[]) => Promise<WebmailContact[]>) => Promise<T>): Promise<T> => {
        if (mailbox !== scopeMailbox) return fail('NOT_FOUND', 'mailbox not found', { stateChanged: false })
        const selected = await helpers.store.getServiceUserByLogin(mailbox)
        if (!selected) return fail('NOT_FOUND', 'mailbox not found', { stateChanged: false })
        const release = await helpers.dav.lock(selected.id)
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
          const current = await session.contacts()
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
            await assertContactMutationCapacity(helpers.store, current, values, mailbox, async owner => owner === mailbox ? session.groups() : [])
            writeAttempted = true
            await session.publishContacts(values)
            const persisted = await session.contacts()
            if (!sameContacts(persisted, values)) throw new Error('contact publication readback mismatch')
            const account = await helpers.store.getAccount(authority.accountId)
            if (!account) throw new Error('contact audit account unavailable')
            await helpers.emitAudit({ actor: fresh.principal.username, action: 'webmail.contact.metadata_written', target: 'mailbox:' + mailbox,
              detail: { operation: method }, outcome: 'ok', principalId: fresh.principal.id }, { accountId: account.id, resellerId: account.ownerId })
            return persisted
          }
          return await operation(fresh, current, persist)
        } catch (error) {
          if (writeAttempted) return fail('SERVICE_UNAVAILABLE', 'contact write requires verification', {
            stateChanged: true, verificationRequired: true, unknownOutcome: true,
          })
          if (isXpanelError(error)) return fail(error.code, error.message, { ...error.detail, stateChanged: false })
          throw error
        } finally { release() }
      }
      const persistLegacyContacts = (values: WebmailContact[], mailbox: string) => mutateContacts(mailbox, async (_fresh, current, persist) => {
        if (collectionRevision(current) !== originalCollectionRevision) return fail('CONFLICT', 'contacts changed; reload before saving', { stateChanged: false })
        return await persist(values)
      })
      // A reply carries what the store holds: its revision is the one the next save must present.
      const storedContact = (records: readonly WebmailContact[], contact: WebmailContact): WebmailContact => records.find(record => record.id === contact.id) ?? contact
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
            return { contact: storedContact(await persist(current.map(value => value.id === targetId ? next : value)), next), account: bound.account }
          }
          next = createWorkspaceContact(mailbox, fields)
          return { contact: storedContact(await persist([...current, next]), next), account: bound.account }
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
          requestedMailbox ?? (isMailboxPrincipal(caller) ? undefined : scopeMailbox),
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
        const stored = await persistLegacyContacts(contacts, owner)
        return jsonResponse({ contacts: imported.map(contact => projectContactWorkspace(storedContact(stored, contact))), importedCount: imported.length }, 201)
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
          return jsonResponse({ contact: projectContactWorkspace(storedContact(await persistLegacyContacts(contacts, callerMailbox), contact)) })
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
        return jsonResponse({ contact: projectContactWorkspace(storedContact(await persistLegacyContacts(contacts, callerMailbox), contact)) })
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
        return jsonResponse({ contact: projectContactWorkspace(storedContact(await persistLegacyContacts(contacts, owner), contact)) }, 201)
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
        return jsonResponse({ contact: projectContactWorkspace(storedContact(await persistLegacyContacts(contacts, mailbox), target)) })
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
      const recordSet = (list: readonly DnsRecord[]): string => JSON.stringify(list.map(r => JSON.stringify([r.name, r.type, r.ttl, r.content, r.priority])).sort())
      const conflicts: string[] = []
      let changed = 0
      // Validate every requested signing key before changing any desired zone.
      for (const { domName, existingZone, domObj, nextRecords, spf, dkim, dmarc } of prepared) {
        // The serial moves only with real content; a zone changed since it was read above is refused, never overwritten.
        if (!existingZone || recordSet(existingZone.records) !== recordSet(nextRecords)) {
          try {
            await helpers.store.saveDnsZone({
              id: existingZone?.id ?? randomUUID(),
              accountId: existingZone?.accountId ?? domObj?.accountId ?? null,
              name: domName,
              serial: mailServices.bumpSerial(existingZone?.serial ?? 0, new Date()),
              records: nextRecords,
            }, { dnsGuard: async latest => {
              assertDnsZoneRevision(latest, dnsZoneRevision(existingZone))
              await requireDomainAccount(helpers.store, await helpers.requireCaller(req), domName, 'dns.email_auth.batch')
            } })
          } catch (error) {
            if (isXpanelError(error) && error.code === 'CONFLICT') { conflicts.push(domName); continue }
            throw error
          }
          changed++
        }
        provisioned.push({ domain: domName, spf, dkim, dmarc })
      }
      let nativeApplied = false
      if (changed) {
        try { nativeApplied = reconcileApplied(await helpers.triggerReconcile(caller)) } catch { /* reported as not applied */ }
      }

      await helpers.emitAudit({
        actor: caller.principal.username,
        action: 'dns.email_auth.batch_provisioned',
        target: 'dns:email-auth',
        detail: { count: provisioned.length, changed, conflicts, nativeApplied },
        outcome: 'ok',
        principalId: caller.principal.id,
      })
      if (conflicts.length) return fail('CONFLICT', 'DNS zone changed; reload and review before retrying', { stateChanged: changed > 0, conflicts, provisioned: provisioned.map(item => item.domain), nativeApplied })
      return jsonResponse({ ok: true, provisioned, count: provisioned.length, nativeApplied })
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
    // 6. Extended File Isolation & Web Extras (/api/web-features/*)
    // =========================================================================
    const webFeatMatch = /^\/api\/web-features\/([^/]+)\/(hotlink-protection|extras)$/.exec(
      pathname,
    )
    if (webFeatMatch) {
      const caller = await helpers.requireCaller(req)
      const account = await helpers.resolveAccountParam(webFeatMatch[1]!)
      const featureKind = webFeatMatch[2]!
      await helpers.assertCanAccessAccount(caller, account, `web_features.${featureKind}`)

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
          const body = writableFields(await readJsonBody(req), ['enabled', 'allowedUrls', 'protectedExtensions', 'allowDirectRequests', 'redirectUrl'], 'hotlink protection')
          const merged = { ...await ext.readOrDefault(fileKey, defaultCfg), ...body }
          // Every value lands in an nginx or Apache line, so stored values are revalidated along with the request.
          const enabled = assertBool(merged.enabled, 'enabled'), allowDirectRequests = assertBool(merged.allowDirectRequests, 'allowDirectRequests')
          const allowedUrls = boundedList(merged.allowedUrls, 100, 'allowedUrls').map(url => validateDomainName(url))
          const protectedExtensions = boundedList(merged.protectedExtensions, 50, 'protectedExtensions').map(value => matching(value, /^[a-z0-9]{1,15}$/, 'protected extension'))
          const redirectUrl = merged.redirectUrl === null ? null : assertRedirectTarget(merged.redirectUrl)
          if (enabled && protectedExtensions.length === 0) return fail('VALIDATION', 'enabled hotlink protection needs at least one protected extension', { stateChanged: false })
          const extPattern = protectedExtensions.join('|')
          const validReferers = [
            ...(allowDirectRequests ? ['none', 'blocked'] : []),
            ...allowedUrls,
          ].join(' ')
          const compiledNginx = enabled
            ? `location ~* \\.(${extPattern})$ {\n  valid_referers ${validReferers};\n  if ($invalid_referer) {\n    return ${redirectUrl ? `302 ${redirectUrl}` : '403'};\n  }\n}`
            : '# Hotlink protection disabled'
          const compiledApache = enabled
            ? `RewriteEngine on\n${allowDirectRequests ? 'RewriteCond %{HTTP_REFERER} !^$\n' : ''}${allowedUrls.map((u) => `RewriteCond %{HTTP_REFERER} !^https?://(www\\.)?${u.replace(/\./g, '\\.')} [NC]`).join('\n')}\nRewriteRule \\.(${extPattern})$ ${redirectUrl ?? '-'} [F,NC,L]`
            : '# Hotlink protection disabled'
          const config: HotlinkProtectionConfig = {
            accountId: account.id,
            enabled,
            allowedUrls,
            protectedExtensions,
            allowDirectRequests,
            redirectUrl,
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
          const body = writableFields(await readJsonBody(req), ['errorPages', 'redirects', 'mimeTypes', 'deniedCidrs', 'directoryIndexMode'], 'web extras')
          const merged = { ...await ext.readOrDefault(fileKey, defaultCfg), ...body }
          // Every value lands in an nginx or Apache line, so stored values are revalidated along with the request.
          const pages = merged.errorPages
          if (!pages || typeof pages !== 'object' || Array.isArray(pages) || Object.keys(pages).length > 20 || Object.keys(pages).some(code => !/^[45][0-9]{2}$/.test(code))) {
            return fail('VALIDATION', 'error pages map at most 20 HTTP 4xx/5xx codes to site paths', { stateChanged: false })
          }
          const errorPages = Object.fromEntries(Object.entries(pages).map(([code, page]) => [code, sitePath(page, 'error page')]))
          const redirects = boundedList(merged.redirects, 100, 'redirects').map((raw): WebExtrasConfig['redirects'][number] => {
            const r = writableFields(raw, ['source', 'target', 'code', 'wildcard'], 'redirect')
            return { source: sitePath(r.source, 'redirect source'), target: assertRedirectTarget(r.target), code: r.code === 301 || r.code === 302 ? r.code : fail('VALIDATION', 'redirect code must be 301 or 302', { stateChanged: false }), wildcard: assertBool(r.wildcard, 'wildcard') }
          })
          const mimeTypes = boundedList(merged.mimeTypes, 100, 'mimeTypes').map(raw => {
            const m = writableFields(raw, ['extension', 'mimeType'], 'mime type')
            return { extension: matching(m.extension, /^\.?[a-z0-9]{1,15}$/, 'mime extension'), mimeType: matching(m.mimeType, /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,126}$/, 'mime type') }
          })
          const deniedCidrs = boundedList(merged.deniedCidrs, 200, 'deniedCidrs').map(cidr => assertCidr(cidr, 'deniedCidr'))
          const directoryIndexMode = oneOf(merged.directoryIndexMode, ['disabled', 'standard', 'fancy'] as const, 'directoryIndexMode')
          const nginxLines: string[] = []
          for (const [code, page] of Object.entries(errorPages)) {
            nginxLines.push(`error_page ${code} ${page};`)
          }
          for (const cidr of deniedCidrs) {
            nginxLines.push(`deny ${cidr};`)
          }
          nginxLines.push(
            `autoindex ${directoryIndexMode === 'disabled' ? 'off' : 'on'};`,
          )
          const apacheLines: string[] = [
            `Options ${directoryIndexMode === 'disabled' ? '-Indexes' : '+Indexes'}`,
            ...Object.entries(errorPages).map(([code, page]) => `ErrorDocument ${code} ${page}`),
            ...mimeTypes.map((m) => `AddType ${m.mimeType} ${m.extension}`),
          ]
          const config: WebExtrasConfig = {
            accountId: account.id,
            errorPages,
            redirects,
            mimeTypes,
            deniedCidrs,
            directoryIndexMode,
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
        const body = writableFields(await readJsonBody(req), ['hosts'], 'remote database hosts')
        // Addresses land in pg_hba lines and GRANT statements: canonical IPs/CIDRs only, no hostnames or quotes.
        const hosts = boundedList(body.hosts ?? [], 100, 'hosts').map(raw => {
          const h = writableFields(raw, ['address', 'engine', 'comment'], 'remote host')
          return {
            address: assertCidr(h.address, 'address'),
            engine: h.engine === undefined ? 'both' as const : oneOf(h.engine, ['mariadb', 'postgresql', 'both'] as const, 'engine'),
            comment: h.comment === undefined ? '' : assertLine(h.comment, 128, 'comment'),
          }
        })
        const compiledPgHba = hosts
          .filter((h) => h.engine === 'postgresql' || h.engine === 'both')
          .map(
            (h) =>
              `host all +${account.username} ${h.address.includes('/') ? h.address : `${h.address}/${h.address.includes(':') ? 128 : 32}`} scram-sha-256`,
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

    const databaseMaintenance = await handleAccountDbMaintenanceRoute(req, url, method, helpers)
    if (databaseMaintenance) return databaseMaintenance

    // Read-only projection of the saved runtime registry; the account owner changes it through /api/account/runtime,
    // where the agent checks the plan and the host. One source for the socket paths: system.cachePaths.
    const cacheMatch = /^\/api\/cache\/([^/]+)$/.exec(pathname)
    if (cacheMatch) {
      const caller = await helpers.requireCaller(req)
      const account = await helpers.resolveAccountParam(cacheMatch[1]!)
      await helpers.assertCanAccessAccount(caller, account, 'cache.manage')
      if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
      const registry = await readRuntimeRegistry(helpers.store.rootDir, account.id)
      const service = (name: system.CacheService) => {
        const saved = registry.cache[name], paths = system.cachePaths(account, name)
        return { enabled: saved?.enabled ?? false, socketPath: paths.socket, maxMemoryMb: saved?.memoryMb ?? null, systemdUnit: paths.unit }
      }
      return jsonResponse({ cache: { accountId: account.id, username: account.username, slice: system.accountSliceName(account.uid), redis: { ...service('redis'), evictionPolicy: 'allkeys-lru' }, memcached: service('memcached') } })
    }

    // Read-only projection of the saved runtime registry: containers publish no port and run only through the agent.
    const containerListMatch = /^\/api\/containers\/([^/]+)$/.exec(pathname)
    if (containerListMatch) {
      const caller = await helpers.requireCaller(req)
      const account = await helpers.resolveAccountParam(containerListMatch[1]!)
      await helpers.assertCanAccessAccount(caller, account, 'containers.manage')
      if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
      const registry = await readRuntimeRegistry(helpers.store.rootDir, account.id)
      return jsonResponse({ containers: registry.containers.map(c => ({ name: c.name, image: c.image, enabled: c.enabled, envKeys: Object.keys(c.env), systemdUnit: system.containerUnitName(account.username, c.name),
        slice: system.accountSliceName(account.uid), publishedPorts: [], updatedAt: c.updatedAt })) })
    }
    const webAppsResponse = await handleWebAppsRoute(req, url, method, { ...helpers, readApps: accountId => ext.readOrDefault<InstalledAppRecord[]>(`apps/${accountId}.json`, []) })
    if (webAppsResponse !== null) return webAppsResponse
    return null
  }

  return {
    ext,
    handleExtendedRoute,
  }
}
