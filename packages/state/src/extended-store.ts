import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { assertBool, assertEmail, assertInt, assertIpv4, assertLine, assertName, assertRelPath, fail, isUuid, oneOf, validateDomainName, validateIpList, validateUsername, type Locale } from '@xpanel/core'
import { AsyncMutex, atomicRemove, atomicWriteJson, listJsonFiles, listSubdirs, readJsonIfExists } from './atomic.ts'
import { StateStore } from './store.ts'
import type { WriterLease } from './writer-lock.ts'

// ---------------------------------------------------------------------------
// Types — 1. First-Run Setup Wizard, Hostname & Quota Initialization
// ---------------------------------------------------------------------------

export interface SetupWizardCompletionInput {
  hostname: string
  nameservers: string[]
  contactEmail: string
  engine: 'apache' | 'openlitespeed'
  primaryIpv4: string
  primaryIpv6?: string | null
  quotaFilesystem: string
  quotaInitialized: boolean
}

export interface SetupWizardState extends SetupWizardCompletionInput {
  completed: boolean
  currentStep: number
  completedAt: string | null
  updatedAt: string
}

export interface FilesystemQuotaState {
  filesystem: string
  quotaInitialized: boolean
  status: 'enabled' | 'disabled'
  initializedAt: string
}

// ---------------------------------------------------------------------------
// Types — 2. Deep Mail & xMail Webmail State
// ---------------------------------------------------------------------------

export interface DomainForwarder {
  id: string
  accountId: string
  fromDomain: string
  toDomain: string
  createdAt: string
  updatedAt: string
}

export interface EmailForwarder {
  id: string
  accountId: string
  source: string
  destination: string
  createdAt: string
  updatedAt: string
}

export interface MailingList {
  id: string
  accountId: string
  name: string
  domain: string
  listAddress: string
  adminEmail: string
  archivePublic: boolean
  members: string[]
  createdAt: string
  updatedAt: string
}

export interface EmailFilterRule {
  field: 'from' | 'to' | 'subject' | 'body' | 'header' | string
  operator: 'contains' | 'equals' | 'matches' | 'startsWith' | 'endsWith' | string
  value: string
}

export interface EmailFilter {
  id: string
  accountId: string
  mailbox: string | null
  name: string
  rules: EmailFilterRule[]
  action: 'discard' | 'redirect' | 'folder' | 'reject' | string
  actionTarget: string | null
  enabled: boolean
  priority: number
  createdAt: string
  updatedAt: string
}

export interface SpamSettings {
  accountId: string
  spamAssassinEnabled: boolean
  scoreThreshold: number
  autoDelete: boolean
  autoDeleteScore: number
  spamBoxEnabled: boolean
  whitelist: string[]
  blacklist: string[]
  updatedAt: string
}

export interface ImportedMailboxRecord {
  id: string
  accountId: string
  email: string
  quotaMb: number
  createdAt: string
}

export interface AddressImportResult {
  importedMailboxes: number
  importedForwarders: number
  errors: string[]
}

export type DeliveryStatus = 'delivered' | 'deferred' | 'bounced' | 'rejected'

export interface DeliveryRecord {
  id: string
  accountId: string
  domain: string
  sender: string
  recipient: string
  status: DeliveryStatus
  smtpCode: number
  message: string
  timestamp: string
}

export interface WebmailMessage {
  id: string
  mailboxLogin: string
  folder: string
  from: string
  to: string
  cc: string | null
  subject: string
  body: string
  html: string | null
  hasAttachment: boolean
  read: boolean
  sentAt: string
}

export interface WebmailIdentity {
  id: string
  mailboxLogin: string
  displayName: string
  email: string
  replyTo: string
  signatureHtml: string
  isDefault: boolean
  updatedAt: string
}

export interface VacationResponder {
  mailboxLogin: string
  enabled: boolean
  subject: string
  body: string
  startAt: string | null
  endAt: string | null
  updatedAt: string
}

export interface CalendarShare {
  principalEmail: string
  permission: 'read' | 'read-write'
}

export interface CalendarEvent {
  id: string
  title: string
  startAt: string
  endAt: string
  location?: string
}

export interface CalDavCalendar {
  id: string
  mailboxLogin: string
  name: string
  color: string
  timezone: string
  shares: CalendarShare[]
  events: CalendarEvent[]
  updatedAt: string
}

export interface CardDavContact {
  id: string
  mailboxLogin: string
  fullName: string
  email: string
  phone?: string
  company?: string
  notes?: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Types — 3. Operational DNS
// ---------------------------------------------------------------------------

export interface DnsTemplateRecord {
  type: string
  name: string
  ttl: number
  content: string
  priority?: number
}

export interface DnsTemplate {
  name: 'standard' | 'simple' | 'virtualftp' | string
  records: DnsTemplateRecord[]
  updatedAt: string
}

export interface EmailAuthProvisionRecord {
  domain: string
  selector: string
  dkimPublicKey: string
  dkimPrivateKeyDigest: string
  dkimTxtName: string
  dkimTxtValue: string
  spfTxtValue: string
  dmarcTxtName: string
  dmarcTxtValue: string
  dkimVerified: boolean
  spfVerified: boolean
  dmarcVerified: boolean
  provisionedAt: string
}

// ---------------------------------------------------------------------------
// Types — 4. Complete Backups & Transfers
// ---------------------------------------------------------------------------

export interface BackupDestination {
  id: string
  name: string
  protocol: 's3' | 'sftp' | 'rsync' | 'backblaze' | 'ftp'
  host: string
  bucketOrPath: string
  enabled: boolean
  retentionDays: number
  updatedAt: string
}

export interface BackupSchedule {
  enabled: boolean
  frequency: 'daily' | 'weekly' | 'monthly'
  retainCount: number
  selectedAccountIds: string[]
  destinationIds: string[]
  includeDatabases: boolean
  includeMail: boolean
  updatedAt: string
}

export interface BackupSnapshotRecord {
  id: string
  accountId: string
  username: string
  kind: 'full' | 'homedir' | 'database' | 'mail'
  sizeBytes: number
  files: Record<string, string>
  databases: string[]
  createdAt: string
}

export interface RestoredFileResult {
  backupId: string
  accountId: string
  username: string
  relFilePath: string
  content: string
  sizeBytes: number
  restoredAt: string
}

export interface TransferSession {
  id: string
  sourceHost: string
  authMethod: 'ssh-key' | 'api-token'
  selectedAccounts: string[]
  status: 'preflight' | 'transferring' | 'restoring' | 'completed' | 'failed'
  progressPercent: number
  logs: string[]
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Types — 5. Extended File Isolation & Web Features
// ---------------------------------------------------------------------------

export interface DirectoryPrivacyUser {
  username: string
  passwordHash: string
}

export interface DirectoryPrivacyRule {
  relDir: string
  authTitle: string
  enabled: boolean
  users: DirectoryPrivacyUser[]
  updatedAt: string
}

export interface DirectoryPrivacyState extends DirectoryPrivacyRule {
  accountId: string
  rules: DirectoryPrivacyRule[]
}

export interface HotlinkProtectionConfig {
  accountId: string
  enabled: boolean
  allowedDomains: string[]
  extensions: string[]
  allowBlankReferrer: boolean
  redirectUrl: string | null
  updatedAt: string
}

export interface WebDiskConfig {
  accountId: string
  enabled: boolean
  readOnly: boolean
  digestAuth: boolean
  path: string
  updatedAt: string
}

export interface GitRelease {
  id: string
  commitSha: string
  deployedAt: string
}

export interface GitRepoRecord {
  id: string
  accountId: string
  name: string
  branch: string
  repoRelPath: string
  deployRelPath: string
  autoDeploy: boolean
  lastCommitSha: string | null
  releases: GitRelease[]
  updatedAt: string
}

export interface WebRedirectRule {
  id: string
  sourcePath: string
  targetUrl: string
  code: 301 | 302
}

export interface WebExtrasConfig {
  accountId: string
  errorPages: Record<string, string>
  redirects: WebRedirectRule[]
  mimeTypes: Record<string, string>
  ipBlocker: string[]
  directoryIndexes: 'default' | 'no-indexing' | 'standard' | 'fancy'
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Types — 6. Databases Beyond MariaDB
// ---------------------------------------------------------------------------

export interface AccountCacheConfig {
  accountId: string
  redisEnabled: boolean
  redisSocketPath: string
  redisMemoryMb: number
  memcachedEnabled: boolean
  memcachedSocketPath: string
  memcachedMemoryMb: number
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Types — 7. Fine-Grained Server Settings & Previously Deferred Capabilities
// ---------------------------------------------------------------------------

export interface ServerFineSettings {
  maxMemoryPerProcessMb: number
  maxProcessesPerAccount: number
  compilerGroupEnabled: boolean
  logRotationDays: number
  logCompress: boolean
  mtaSmarthost: string | null
  mtaMaxMsgSizeMb: number
  mtaRateLimitPerHour: number
  mtaRblList: string[]
  mtaGreylisting: boolean
  webStack: {
    http3Quic: boolean
    brotli: boolean
    wafOwaspCrs: boolean
    installedPhpVersions: string[]
    installedRuntimes: string[]
  }
  installedPackages: string[]
  updatedAt: string
}

export interface ContainerRecord {
  id: string
  accountId: string
  name: string
  image: string
  status: 'running' | 'stopped'
  internalPort: number
  domainId: string | null
  memoryMb: number
  env: Record<string, string>
  updatedAt: string
}

export type AppStoreKind = 'wordpress' | 'laravel' | 'drupal' | 'joomla' | 'ghost' | 'nextcloud'

export interface InstalledAppRecord {
  id: string
  accountId: string
  kind: AppStoreKind
  domain: string
  docRoot: string
  version: string
  autoUpdate: boolean
  stagingDomain: string | null
  lastStagingSyncAt: string | null
  installedAt: string
  updatedAt: string
}

export interface ClusterNodeRecord {
  id: string
  name: string
  hostname: string
  ipv4: string
  role: 'web' | 'dns' | 'mail' | 'db' | 'full'
  status: 'online' | 'syncing' | 'offline'
  updatedAt: string
}

export interface LegacyTrafficSummary {
  domain: string
  generators: readonly ['awstats', 'webalizer']
  monthly: {
    month: string
    uniqueVisitors: number
    visits: number
    pages: number
    hits: number
    bandwidthBytes: number
  }[]
  daily: {
    date: string
    visits: number
    pages: number
    hits: number
    bandwidthBytes: number
  }[]
  totals: {
    uniqueVisitors: number
    visits: number
    pages: number
    hits: number
    bandwidthBytes: number
  }
  updatedAt: string
}

export interface PanelBrandingConfig {
  companyName: string
  productName: string
  primaryColorOklch: string
  logoUrl: string | null
  supportUrl: string | null
  footerText: string
  updatedAt: string
}

export interface LanguageOverridesState {
  en: Record<string, string>
  ar: Record<string, string>
  updatedAt: string
}

export interface WhmcsConfig {
  enabled: boolean
  whmcsUrl: string
  apiIdentifier: string
  allowedServerIps: string[]
  autoProvision: boolean
  ssoEnabled: boolean
  lastWebhookAt: string | null
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const safeSlug = (input: string, what = 'identifier'): string => {
  const s = String(input).trim().toLowerCase()
  if (!s || s.length > 190 || !/^[a-z0-9._@-]+$/.test(s) || s.startsWith('.') || s.includes('..')) {
    fail('VALIDATION', `invalid ${what}`, { [what]: s.slice(0, 128) })
  }
  return s.replace(/@/g, '_at_')
}

const ensureId = (id?: string): string => {
  if (id === undefined) return randomUUID()
  if (isUuid(id)) return id.toLowerCase()
  return safeSlug(id, 'id')
}

const DEFAULT_DNS_TEMPLATES: DnsTemplate[] = [
  {
    name: 'standard',
    records: [
      { type: 'A', name: '@', ttl: 3600, content: '{{ip}}' },
      { type: 'A', name: 'www', ttl: 3600, content: '{{ip}}' },
      { type: 'A', name: 'mail', ttl: 3600, content: '{{ip}}' },
      { type: 'MX', name: '@', ttl: 3600, content: 'mail.{{domain}}.', priority: 10 },
      { type: 'TXT', name: '@', ttl: 3600, content: 'v=spf1 +a +mx +ip4:{{ip}} ~all' },
    ],
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    name: 'simple',
    records: [
      { type: 'A', name: '@', ttl: 3600, content: '{{ip}}' },
      { type: 'CNAME', name: 'www', ttl: 3600, content: '{{domain}}.' },
    ],
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    name: 'virtualftp',
    records: [
      { type: 'A', name: '@', ttl: 3600, content: '{{ip}}' },
      { type: 'A', name: 'ftp', ttl: 3600, content: '{{ip}}' },
      { type: 'CNAME', name: 'www', ttl: 3600, content: '{{domain}}.' },
    ],
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
]

// ---------------------------------------------------------------------------
// ExtendedFeaturesStore
// ---------------------------------------------------------------------------

export class ExtendedFeaturesStore {
  readonly rootDir: string
  private readonly mutex = new AsyncMutex()

  constructor(rootDir: string) {
    this.rootDir = rootDir
  }

  private extPath(...segments: string[]): string {
    return join(this.rootDir, 'extended', ...segments)
  }

  private withSetupWizardMutation<T>(mutate: (lease: WriterLease) => Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      const lease = await new StateStore(this.rootDir).getWriterLock().acquire()
      try {
        const result = await mutate(lease)
        await lease.commitAuthority({ incrementRevision: false })
        return result
      } finally { await lease.release() }
    })
  }

  // =========================================================================
  // 1. First-Run Setup Wizard, Hostname & Quota Initialization
  // =========================================================================

  async getSetupWizardState(): Promise<SetupWizardState> {
    const stored = await readJsonIfExists<SetupWizardState>(this.extPath('setup-wizard.json'))
    if (stored) return stored
    return {
      completed: false,
      currentStep: 1,
      hostname: 'panel.local.test',
      nameservers: ['ns1.local.test', 'ns2.local.test'],
      contactEmail: 'admin@local.test',
      engine: 'apache',
      primaryIpv4: '127.0.0.1',
      primaryIpv6: null,
      quotaFilesystem: '/',
      quotaInitialized: false,
      completedAt: null,
      updatedAt: new Date(0).toISOString(),
    }
  }

  saveSetupWizardStep(
    step: number | ({ step: number } & Partial<SetupWizardCompletionInput>),
  ): Promise<SetupWizardState> {
    return this.withSetupWizardMutation(async lease => {
      const current = await this.getSetupWizardState()
      const stepNum = typeof step === 'number' ? step : step.step
      assertInt(stepNum, 1, 10, 'step')
      const patch: Partial<SetupWizardCompletionInput> = typeof step === 'object' && step !== null ? step : {}
      const next: SetupWizardState = {
        ...current,
        ...(patch.hostname !== undefined ? { hostname: validateDomainName(patch.hostname) } : {}),
        ...(patch.nameservers !== undefined
          ? { nameservers: patch.nameservers.map((ns) => validateDomainName(ns)) }
          : {}),
        ...(patch.contactEmail !== undefined
          ? { contactEmail: assertEmail(patch.contactEmail, 'contactEmail') }
          : {}),
        ...(patch.engine !== undefined
          ? { engine: oneOf(patch.engine, ['apache', 'openlitespeed'] as const, 'engine') }
          : {}),
        ...(patch.primaryIpv4 !== undefined ? { primaryIpv4: assertIpv4(patch.primaryIpv4, 'primaryIpv4') } : {}),
        ...(patch.primaryIpv6 !== undefined ? { primaryIpv6: patch.primaryIpv6 ?? null } : {}),
        ...(patch.quotaFilesystem !== undefined
          ? { quotaFilesystem: assertLine(patch.quotaFilesystem, 256, 'quotaFilesystem', { allowEmpty: false }) }
          : {}),
        ...(patch.quotaInitialized !== undefined
          ? { quotaInitialized: assertBool(patch.quotaInitialized, 'quotaInitialized') }
          : {}),
        currentStep: stepNum,
        updatedAt: new Date().toISOString(),
      }
      await atomicWriteJson(this.extPath('setup-wizard.json'), next, 0o640, () => lease.assertFencingToken())
      return next
    })
  }

  completeSetupWizard(input: SetupWizardCompletionInput): Promise<SetupWizardState> {
    return this.withSetupWizardMutation(async lease => {
      if (typeof input !== 'object' || input === null) fail('VALIDATION', 'setup wizard input must be an object')
      const hostname = validateDomainName(input.hostname)
      if (!Array.isArray(input.nameservers) || input.nameservers.length === 0) {
        fail('VALIDATION', 'at least one nameserver is required')
      }
      const nameservers = input.nameservers.map((n) => validateDomainName(n))
      const contactEmail = assertEmail(input.contactEmail, 'contactEmail')
      const engine = oneOf(input.engine, ['apache', 'openlitespeed'] as const, 'engine')
      const primaryIpv4 = assertIpv4(input.primaryIpv4, 'primaryIpv4')
      const primaryIpv6 =
        input.primaryIpv6 === undefined || input.primaryIpv6 === null
          ? null
          : assertLine(input.primaryIpv6, 128, 'primaryIpv6', { allowEmpty: false })
      const quotaFilesystem = assertLine(input.quotaFilesystem, 256, 'quotaFilesystem', { allowEmpty: false })
      if (!quotaFilesystem.startsWith('/')) {
        fail('VALIDATION', 'quotaFilesystem must start with "/"')
      }
      const quotaInitialized = assertBool(input.quotaInitialized, 'quotaInitialized')
      const now = new Date().toISOString()
      const next: SetupWizardState = {
        completed: true,
        currentStep: 5,
        hostname,
        nameservers,
        contactEmail,
        engine,
        primaryIpv4,
        primaryIpv6,
        quotaFilesystem,
        quotaInitialized,
        completedAt: now,
        updatedAt: now,
      }
      await atomicWriteJson(this.extPath('setup-wizard.json'), next, 0o640, () => lease.assertFencingToken())
      return next
    })
  }

  changeHostname(hostname: string): Promise<SetupWizardState> {
    return this.mutex.run(() => new StateStore(this.rootDir).commitHostname(
      hostname,
      async (canonical, now): Promise<SetupWizardState> => ({
        ...await this.getSetupWizardState(),
        hostname: canonical,
        updatedAt: now,
      }),
    ))
  }

  initializeFilesystemQuota(filesystem: string): Promise<FilesystemQuotaState> {
    return this.withSetupWizardMutation(async lease => {
      const fsPath = assertLine(filesystem, 256, 'filesystem', { allowEmpty: false })
      if (!fsPath.startsWith('/')) {
        fail('VALIDATION', 'filesystem mount must start with "/"')
      }
      const now = new Date().toISOString()
      const quotaState: FilesystemQuotaState = {
        filesystem: fsPath,
        quotaInitialized: true,
        status: 'enabled',
        initializedAt: now,
      }
      await atomicWriteJson(this.extPath('quota-state.json'), quotaState, 0o640, () => lease.assertFencingToken())
      const wiz = await this.getSetupWizardState()
      await atomicWriteJson(this.extPath('setup-wizard.json'), {
        ...wiz,
        quotaFilesystem: fsPath,
        quotaInitialized: true,
        updatedAt: now,
      }, 0o640, () => lease.assertFencingToken())
      return quotaState
    })
  }

  // =========================================================================
  // 2. Deep Mail & xMail Webmail State
  // =========================================================================

  async listDomainForwarders(accountId?: string): Promise<DomainForwarder[]> {
    const files = await listJsonFiles(this.extPath('mail', 'domain-forwarders'))
    const rows = await Promise.all(files.map((f) => readJsonIfExists<DomainForwarder>(f)))
    const valid = rows.filter((r): r is DomainForwarder => r !== null)
    const filtered = accountId !== undefined ? valid.filter((r) => r.accountId === accountId) : valid
    return filtered.sort((a, b) => a.fromDomain.localeCompare(b.fromDomain))
  }

  saveDomainForwarder(input: {
    id?: string
    accountId: string
    fromDomain: string
    toDomain: string
  }): Promise<DomainForwarder> {
    return this.mutex.run(async () => {
      const id = ensureId(input.id)
      const accountId = assertLine(input.accountId, 128, 'accountId', { allowEmpty: false })
      const fromDomain = validateDomainName(input.fromDomain)
      const toDomain = validateDomainName(input.toDomain)
      if (fromDomain === toDomain) {
        fail('VALIDATION', 'fromDomain and toDomain must differ')
      }
      const existing = await readJsonIfExists<DomainForwarder>(
        this.extPath('mail', 'domain-forwarders', `${id}.json`),
      )
      const now = new Date().toISOString()
      const record: DomainForwarder = {
        id,
        accountId,
        fromDomain,
        toDomain,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      await atomicWriteJson(this.extPath('mail', 'domain-forwarders', `${id}.json`), record)
      return record
    })
  }

  deleteDomainForwarder(id: string): Promise<boolean> {
    return this.mutex.run(async () => {
      const safe = ensureId(id)
      return atomicRemove(this.extPath('mail', 'domain-forwarders', `${safe}.json`))
    })
  }

  async listEmailForwarders(accountId?: string): Promise<EmailForwarder[]> {
    const files = await listJsonFiles(this.extPath('mail', 'email-forwarders'))
    const rows = await Promise.all(files.map((f) => readJsonIfExists<EmailForwarder>(f)))
    const valid = rows.filter((r): r is EmailForwarder => r !== null)
    const filtered = accountId !== undefined ? valid.filter((r) => r.accountId === accountId) : valid
    return filtered.sort((a, b) => a.source.localeCompare(b.source))
  }

  saveEmailForwarder(input: {
    id?: string
    accountId: string
    source: string
    destination: string
  }): Promise<EmailForwarder> {
    return this.mutex.run(async () => {
      const id = ensureId(input.id)
      const accountId = assertLine(input.accountId, 128, 'accountId', { allowEmpty: false })
      const source = assertEmail(input.source, 'source')
      const destination = input.destination.includes('@')
        ? assertEmail(input.destination, 'destination')
        : assertLine(input.destination, 256, 'destination', { allowEmpty: false })
      const existing = await readJsonIfExists<EmailForwarder>(
        this.extPath('mail', 'email-forwarders', `${id}.json`),
      )
      const now = new Date().toISOString()
      const record: EmailForwarder = {
        id,
        accountId,
        source,
        destination,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      await atomicWriteJson(this.extPath('mail', 'email-forwarders', `${id}.json`), record)
      return record
    })
  }

  deleteEmailForwarder(id: string): Promise<boolean> {
    return this.mutex.run(async () => {
      const safe = ensureId(id)
      return atomicRemove(this.extPath('mail', 'email-forwarders', `${safe}.json`))
    })
  }

  async listMailingLists(accountId?: string): Promise<MailingList[]> {
    const files = await listJsonFiles(this.extPath('mail', 'mailing-lists'))
    const rows = await Promise.all(files.map((f) => readJsonIfExists<MailingList>(f)))
    const valid = rows.filter((r): r is MailingList => r !== null)
    const filtered = accountId !== undefined ? valid.filter((r) => r.accountId === accountId) : valid
    return filtered.sort((a, b) => a.listAddress.localeCompare(b.listAddress))
  }

  saveMailingList(input: {
    id?: string
    accountId: string
    name: string
    domain: string
    adminEmail: string
    archivePublic: boolean
    members: string[]
  }): Promise<MailingList> {
    return this.mutex.run(async () => {
      const id = ensureId(input.id)
      const accountId = assertLine(input.accountId, 128, 'accountId', { allowEmpty: false })
      const name = safeSlug(input.name, 'name')
      const domain = validateDomainName(input.domain)
      const adminEmail = assertEmail(input.adminEmail, 'adminEmail')
      const archivePublic = assertBool(input.archivePublic, 'archivePublic')
      if (!Array.isArray(input.members)) fail('VALIDATION', 'members must be an array')
      const members = [...new Set(input.members.map((m) => assertEmail(m, 'member')))].sort()
      const existing = await readJsonIfExists<MailingList>(
        this.extPath('mail', 'mailing-lists', `${id}.json`),
      )
      const now = new Date().toISOString()
      const record: MailingList = {
        id,
        accountId,
        name,
        domain,
        listAddress: `${name}@${domain}`,
        adminEmail,
        archivePublic,
        members,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      await atomicWriteJson(this.extPath('mail', 'mailing-lists', `${id}.json`), record)
      return record
    })
  }

  deleteMailingList(id: string): Promise<boolean> {
    return this.mutex.run(async () => {
      const safe = ensureId(id)
      return atomicRemove(this.extPath('mail', 'mailing-lists', `${safe}.json`))
    })
  }

  async listEmailFilters(accountId: string, mailbox?: string): Promise<EmailFilter[]> {
    const files = await listJsonFiles(this.extPath('mail', 'filters'))
    const rows = await Promise.all(files.map((f) => readJsonIfExists<EmailFilter>(f)))
    const valid = rows.filter((r): r is EmailFilter => r !== null && r.accountId === accountId)
    const filtered =
      mailbox !== undefined ? valid.filter((r) => r.mailbox === mailbox || (mailbox === '' && r.mailbox === null)) : valid
    return filtered.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))
  }

  saveEmailFilter(filter: {
    id?: string
    accountId: string
    mailbox?: string | null
    name: string
    rules: EmailFilterRule[]
    action: string
    actionTarget?: string | null
    enabled?: boolean
    priority?: number
  }): Promise<EmailFilter> {
    return this.mutex.run(async () => {
      const id = ensureId(filter.id)
      const accountId = assertLine(filter.accountId, 128, 'accountId', { allowEmpty: false })
      const mailbox =
        filter.mailbox === undefined || filter.mailbox === null
          ? null
          : assertEmail(filter.mailbox, 'mailbox')
      const name = assertLine(filter.name, 128, 'name', { allowEmpty: false })
      if (!Array.isArray(filter.rules) || filter.rules.length === 0) {
        fail('VALIDATION', 'email filter must contain at least one rule')
      }
      const rules: EmailFilterRule[] = filter.rules.map((r) => ({
        field: assertLine(r.field, 64, 'rule.field', { allowEmpty: false }),
        operator: assertLine(r.operator, 64, 'rule.operator', { allowEmpty: false }),
        value: assertLine(r.value, 512, 'rule.value', { allowEmpty: false }),
      }))
      const action = assertLine(filter.action, 64, 'action', { allowEmpty: false })
      const actionTarget =
        filter.actionTarget === undefined || filter.actionTarget === null
          ? null
          : assertLine(filter.actionTarget, 256, 'actionTarget', { allowEmpty: false })
      const enabled = filter.enabled === undefined ? true : assertBool(filter.enabled, 'enabled')
      const priority = filter.priority === undefined ? 10 : assertInt(filter.priority, 1, 1000, 'priority')
      const existing = await readJsonIfExists<EmailFilter>(this.extPath('mail', 'filters', `${id}.json`))
      const now = new Date().toISOString()
      const record: EmailFilter = {
        id,
        accountId,
        mailbox,
        name,
        rules,
        action,
        actionTarget,
        enabled,
        priority,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      await atomicWriteJson(this.extPath('mail', 'filters', `${id}.json`), record)
      return record
    })
  }

  deleteEmailFilter(id: string): Promise<boolean> {
    return this.mutex.run(async () => {
      const safe = ensureId(id)
      return atomicRemove(this.extPath('mail', 'filters', `${safe}.json`))
    })
  }

  async getSpamSettings(accountId: string): Promise<SpamSettings> {
    const safeAcc = safeSlug(accountId, 'accountId')
    const stored = await readJsonIfExists<SpamSettings>(this.extPath('mail', 'spam', `${safeAcc}.json`))
    if (stored) return stored
    return {
      accountId,
      spamAssassinEnabled: true,
      scoreThreshold: 5,
      autoDelete: false,
      autoDeleteScore: 10,
      spamBoxEnabled: true,
      whitelist: [],
      blacklist: [],
      updatedAt: new Date(0).toISOString(),
    }
  }

  saveSpamSettings(
    accountId: string,
    settings: Partial<Omit<SpamSettings, 'accountId' | 'updatedAt'>> & {
      enabled?: boolean
      requiredScore?: number
    },
  ): Promise<SpamSettings> {
    return this.mutex.run(async () => {
      const safeAcc = safeSlug(accountId, 'accountId')
      const current = await this.getSpamSettings(accountId)
      const next: SpamSettings = {
        accountId,
        spamAssassinEnabled: settings.spamAssassinEnabled ?? settings.enabled ?? current.spamAssassinEnabled,
        scoreThreshold: settings.scoreThreshold ?? settings.requiredScore ?? current.scoreThreshold,
        autoDelete: settings.autoDelete ?? current.autoDelete,
        autoDeleteScore: settings.autoDeleteScore ?? current.autoDeleteScore,
        spamBoxEnabled: settings.spamBoxEnabled ?? current.spamBoxEnabled,
        whitelist: settings.whitelist ? [...settings.whitelist] : current.whitelist,
        blacklist: settings.blacklist ? [...settings.blacklist] : current.blacklist,
        updatedAt: new Date().toISOString(),
      }
      await atomicWriteJson(this.extPath('mail', 'spam', `${safeAcc}.json`), next)
      return next
    })
  }

  importAddressesCsv(
    accountId: string,
    csvText: string,
    defaultDomain: string,
  ): Promise<AddressImportResult> {
    return this.mutex.run(async () => {
      const canonicalDomain = validateDomainName(defaultDomain)
      const lines = csvText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('#'))

      let importedMailboxes = 0
      let importedForwarders = 0
      const errors: string[] = []

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        const cols = line.split(',').map((c) => c.trim())
        // Skip header rows
        if (
          i === 0 &&
          cols.some((c) => /^(email|address|username|source|type|quota|password|destination)$/i.test(c))
        ) {
          continue
        }

        try {
          const first = cols[0] ?? ''
          if (!first) {
            errors.push(`Row ${i + 1}: missing address`)
            continue
          }
          const fullAddress = first.includes('@') ? assertEmail(first, 'email') : assertEmail(`${first}@${canonicalDomain}`, 'email')
          const second = cols[1] ?? ''
          const third = cols[2] ?? ''

          // Determine if row is a forwarder or a mailbox:
          // Forwarder if column 1 is "forwarder" or column 2 is an email address (contains '@')
          const isExplicitForwarder = first.toLowerCase() === 'forwarder' || third.toLowerCase() === 'forwarder'
          if (isExplicitForwarder || (second.includes('@') && !third)) {
            const src = first.toLowerCase() === 'forwarder' ? assertEmail(second, 'source') : fullAddress
            const destRaw = first.toLowerCase() === 'forwarder' ? (cols[2] ?? '') : second
            const dest = assertEmail(destRaw, 'destination')
            const id = randomUUID()
            const now = new Date().toISOString()
            const fw: EmailForwarder = {
              id,
              accountId,
              source: src,
              destination: dest,
              createdAt: now,
              updatedAt: now,
            }
            await atomicWriteJson(this.extPath('mail', 'email-forwarders', `${id}.json`), fw)
            importedForwarders++
          } else {
            const quotaParsed = third ? Number(third) : Number(second)
            const quotaMb = Number.isFinite(quotaParsed) && quotaParsed > 0 ? Math.floor(quotaParsed) : 1024
            const id = randomUUID()
            const mb: ImportedMailboxRecord = {
              id,
              accountId,
              email: fullAddress,
              quotaMb,
              createdAt: new Date().toISOString(),
            }
            await atomicWriteJson(this.extPath('mail', 'imported-mailboxes', `${id}.json`), mb)
            importedMailboxes++
          }
        } catch (err) {
          errors.push(`Row ${i + 1}: ${(err as Error).message}`)
        }
      }

      return { importedMailboxes, importedForwarders, errors }
    })
  }

  async listDeliveryRecords(filter?: {
    accountId?: string
    domain?: string
    status?: DeliveryStatus
  }): Promise<DeliveryRecord[]> {
    const files = await listJsonFiles(this.extPath('mail', 'delivery'))
    const rows = await Promise.all(files.map((f) => readJsonIfExists<DeliveryRecord>(f)))
    const valid = rows.filter((r): r is DeliveryRecord => r !== null)
    return valid
      .filter((r) => {
        if (filter?.accountId !== undefined && r.accountId !== filter.accountId) return false
        if (filter?.domain !== undefined && r.domain.toLowerCase() !== filter.domain.toLowerCase()) return false
        if (filter?.status !== undefined && r.status !== filter.status) return false
        return true
      })
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
  }

  recordDeliveryEvent(event: {
    id?: string
    accountId: string
    domain?: string
    sender: string
    recipient: string
    status: DeliveryStatus
    smtpCode?: number
    message?: string
    timestamp?: string
  }): Promise<DeliveryRecord> {
    return this.mutex.run(async () => {
      const id = ensureId(event.id)
      const accountId = assertLine(event.accountId, 128, 'accountId', { allowEmpty: false })
      const sender = assertEmail(event.sender, 'sender')
      const recipient = assertEmail(event.recipient, 'recipient')
      const status = oneOf(event.status, ['delivered', 'deferred', 'bounced', 'rejected'] as const, 'status')
      const domain = event.domain
        ? validateDomainName(event.domain)
        : recipient.slice(recipient.lastIndexOf('@') + 1)
      const smtpCode =
        event.smtpCode ?? (status === 'delivered' ? 250 : status === 'deferred' ? 451 : 550)
      const message = event.message ?? `Status: ${status}`
      const timestamp = event.timestamp ?? new Date().toISOString()
      const record: DeliveryRecord = {
        id,
        accountId,
        domain,
        sender,
        recipient,
        status,
        smtpCode,
        message,
        timestamp,
      }
      await atomicWriteJson(this.extPath('mail', 'delivery', `${id}.json`), record)
      return record
    })
  }

  // ---- xMail Webmail ----

  async listWebmailMessages(mailboxLogin: string, folder?: string): Promise<WebmailMessage[]> {
    const safeBox = safeSlug(mailboxLogin, 'mailboxLogin')
    const files = await listJsonFiles(this.extPath('webmail', safeBox, 'messages'))
    const rows = await Promise.all(files.map((f) => readJsonIfExists<WebmailMessage>(f)))
    const valid = rows.filter((r): r is WebmailMessage => r !== null)
    const filtered =
      folder !== undefined ? valid.filter((m) => m.folder.toLowerCase() === folder.toLowerCase()) : valid
    return filtered.sort((a, b) => b.sentAt.localeCompare(a.sentAt))
  }

  sendWebmailMessage(input: {
    id?: string
    mailboxLogin: string
    from: string
    to: string
    cc?: string
    subject: string
    body: string
    html?: string
    folder?: string
    hasAttachment?: boolean
  }): Promise<WebmailMessage> {
    return this.mutex.run(async () => {
      const mailboxLogin = assertEmail(input.mailboxLogin, 'mailboxLogin')
      const safeBox = safeSlug(mailboxLogin, 'mailboxLogin')
      const from = assertEmail(input.from, 'from')
      const to = assertEmail(input.to, 'to')
      const cc = input.cc ? assertEmail(input.cc, 'cc') : null
      const subject = assertLine(input.subject, 512, 'subject')
      const id = ensureId(input.id)
      const now = new Date().toISOString()
      const sentMsg: WebmailMessage = {
        id,
        mailboxLogin,
        folder: input.folder ?? 'Sent',
        from,
        to,
        cc,
        subject,
        body: String(input.body ?? ''),
        html: input.html ?? null,
        hasAttachment: Boolean(input.hasAttachment),
        read: true,
        sentAt: now,
      }
      await atomicWriteJson(this.extPath('webmail', safeBox, 'messages', `${id}.json`), sentMsg)

      // Also deliver into recipient's INBOX if recipient differs from sender mailboxLogin
      if (to.toLowerCase() !== mailboxLogin.toLowerCase()) {
        const recipientBox = safeSlug(to, 'to')
        const inboxId = randomUUID()
        const inboxMsg: WebmailMessage = {
          ...sentMsg,
          id: inboxId,
          mailboxLogin: to,
          folder: 'INBOX',
          read: false,
        }
        await atomicWriteJson(this.extPath('webmail', recipientBox, 'messages', `${inboxId}.json`), inboxMsg)
      }
      return sentMsg
    })
  }

  async searchWebmailMessages(
    mailboxLogin: string,
    query: { q: string; folder?: string; from?: string; hasAttachment?: boolean },
  ): Promise<WebmailMessage[]> {
    const all = await this.listWebmailMessages(mailboxLogin, query.folder)
    const needle = (query.q ?? '').trim().toLowerCase()
    return all.filter((m) => {
      if (query.from && m.from.toLowerCase() !== query.from.toLowerCase()) return false
      if (query.hasAttachment !== undefined && m.hasAttachment !== query.hasAttachment) return false
      if (!needle) return true
      return (
        m.subject.toLowerCase().includes(needle) ||
        m.body.toLowerCase().includes(needle) ||
        (m.html ?? '').toLowerCase().includes(needle) ||
        m.from.toLowerCase().includes(needle) ||
        m.to.toLowerCase().includes(needle)
      )
    })
  }

  async listWebmailIdentities(mailboxLogin: string): Promise<WebmailIdentity[]> {
    const safeBox = safeSlug(mailboxLogin, 'mailboxLogin')
    const files = await listJsonFiles(this.extPath('webmail', safeBox, 'identities'))
    const rows = await Promise.all(files.map((f) => readJsonIfExists<WebmailIdentity>(f)))
    return rows
      .filter((r): r is WebmailIdentity => r !== null)
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.displayName.localeCompare(b.displayName))
  }

  saveWebmailIdentity(
    mailboxLogin: string,
    identity: {
      id?: string
      displayName: string
      email: string
      replyTo: string
      signatureHtml: string
      isDefault: boolean
    },
  ): Promise<WebmailIdentity> {
    return this.mutex.run(async () => {
      const login = assertEmail(mailboxLogin, 'mailboxLogin')
      const safeBox = safeSlug(login, 'mailboxLogin')
      const id = ensureId(identity.id)
      const displayName = assertLine(identity.displayName, 128, 'displayName', { allowEmpty: false })
      const email = assertEmail(identity.email, 'email')
      const replyTo = assertEmail(identity.replyTo, 'replyTo')
      const signatureHtml = String(identity.signatureHtml ?? '')
      const isDefault = assertBool(identity.isDefault, 'isDefault')
      const now = new Date().toISOString()

      if (isDefault) {
        const existing = await this.listWebmailIdentities(login)
        for (const item of existing) {
          if (item.id !== id && item.isDefault) {
            await atomicWriteJson(this.extPath('webmail', safeBox, 'identities', `${item.id}.json`), {
              ...item,
              isDefault: false,
              updatedAt: now,
            })
          }
        }
      }

      const record: WebmailIdentity = {
        id,
        mailboxLogin: login,
        displayName,
        email,
        replyTo,
        signatureHtml,
        isDefault,
        updatedAt: now,
      }
      await atomicWriteJson(this.extPath('webmail', safeBox, 'identities', `${id}.json`), record)
      return record
    })
  }

  deleteWebmailIdentity(mailboxLogin: string, id: string): Promise<boolean> {
    return this.mutex.run(async () => {
      const safeBox = safeSlug(mailboxLogin, 'mailboxLogin')
      const safeId = ensureId(id)
      return atomicRemove(this.extPath('webmail', safeBox, 'identities', `${safeId}.json`))
    })
  }

  async storedVacationResponder(mailboxLogin: string): Promise<VacationResponder | null> {
    const login = assertEmail(mailboxLogin, 'mailboxLogin')
    const safeBox = safeSlug(login, 'mailboxLogin')
    return readJsonIfExists<VacationResponder>(this.extPath('webmail', safeBox, 'vacation.json'))
  }

  async readEmailAuth(domain: string): Promise<EmailAuthProvisionRecord | null> {
    const name = validateDomainName(domain)
    return readJsonIfExists<EmailAuthProvisionRecord>(this.extPath('dns', 'email-auth', `${name}.json`))
  }

  async getVacationResponder(mailboxLogin: string): Promise<VacationResponder> {
    const stored = await this.storedVacationResponder(mailboxLogin)
    if (stored) return stored
    const login = assertEmail(mailboxLogin, 'mailboxLogin')
    return {
      mailboxLogin: login,
      enabled: false,
      subject: '',
      body: '',
      startAt: null,
      endAt: null,
      updatedAt: new Date(0).toISOString(),
    }
  }

  saveVacationResponder(
    mailboxLogin: string,
    responder: {
      enabled: boolean
      subject: string
      body: string
      startAt?: string | null
      endAt?: string | null
    },
  ): Promise<VacationResponder> {
    return this.mutex.run(async () => {
      const login = assertEmail(mailboxLogin, 'mailboxLogin')
      const safeBox = safeSlug(login, 'mailboxLogin')
      const record: VacationResponder = {
        mailboxLogin: login,
        enabled: assertBool(responder.enabled, 'enabled'),
        subject: assertLine(responder.subject, 256, 'subject'),
        body: String(responder.body ?? ''),
        startAt: responder.startAt ?? null,
        endAt: responder.endAt ?? null,
        updatedAt: new Date().toISOString(),
      }
      await atomicWriteJson(this.extPath('webmail', safeBox, 'vacation.json'), record)
      return record
    })
  }

  async listCalendars(mailboxLogin: string): Promise<CalDavCalendar[]> {
    const safeBox = safeSlug(mailboxLogin, 'mailboxLogin')
    const files = await listJsonFiles(this.extPath('webmail', safeBox, 'calendars'))
    const rows = await Promise.all(files.map((f) => readJsonIfExists<CalDavCalendar>(f)))
    return rows.filter((r): r is CalDavCalendar => r !== null).sort((a, b) => a.name.localeCompare(b.name))
  }

  saveCalendar(
    mailboxLogin: string,
    cal: {
      id?: string
      name: string
      color: string
      timezone: string
      shares: CalendarShare[]
      events: CalendarEvent[]
    },
  ): Promise<CalDavCalendar> {
    return this.mutex.run(async () => {
      const login = assertEmail(mailboxLogin, 'mailboxLogin')
      const safeBox = safeSlug(login, 'mailboxLogin')
      const id = ensureId(cal.id)
      const record: CalDavCalendar = {
        id,
        mailboxLogin: login,
        name: assertLine(cal.name, 128, 'name', { allowEmpty: false }),
        color: assertLine(cal.color, 32, 'color', { allowEmpty: false }),
        timezone: assertLine(cal.timezone, 64, 'timezone', { allowEmpty: false }),
        shares: (cal.shares ?? []).map((s) => ({
          principalEmail: assertEmail(s.principalEmail, 'principalEmail'),
          permission: oneOf(s.permission, ['read', 'read-write'] as const, 'permission'),
        })),
        events: (cal.events ?? []).map((ev) => ({
          id: ev.id || randomUUID(),
          title: assertLine(ev.title, 256, 'title', { allowEmpty: false }),
          startAt: assertLine(ev.startAt, 64, 'startAt', { allowEmpty: false }),
          endAt: assertLine(ev.endAt, 64, 'endAt', { allowEmpty: false }),
          ...(ev.location !== undefined ? { location: assertLine(ev.location, 256, 'location') } : {}),
        })),
        updatedAt: new Date().toISOString(),
      }
      await atomicWriteJson(this.extPath('webmail', safeBox, 'calendars', `${id}.json`), record)
      return record
    })
  }

  async listContacts(mailboxLogin: string): Promise<CardDavContact[]> {
    const safeBox = safeSlug(mailboxLogin, 'mailboxLogin')
    const files = await listJsonFiles(this.extPath('webmail', safeBox, 'contacts'))
    const rows = await Promise.all(files.map((f) => readJsonIfExists<CardDavContact>(f)))
    return rows
      .filter((r): r is CardDavContact => r !== null)
      .sort((a, b) => a.fullName.localeCompare(b.fullName))
  }

  saveContact(
    mailboxLogin: string,
    contact: {
      id?: string
      fullName: string
      email: string
      phone?: string
      company?: string
      notes?: string
    },
  ): Promise<CardDavContact> {
    return this.mutex.run(async () => {
      const login = assertEmail(mailboxLogin, 'mailboxLogin')
      const safeBox = safeSlug(login, 'mailboxLogin')
      const id = ensureId(contact.id)
      const record: CardDavContact = {
        id,
        mailboxLogin: login,
        fullName: assertLine(contact.fullName, 128, 'fullName', { allowEmpty: false }),
        email: assertEmail(contact.email, 'email'),
        ...(contact.phone !== undefined ? { phone: assertLine(contact.phone, 64, 'phone') } : {}),
        ...(contact.company !== undefined ? { company: assertLine(contact.company, 128, 'company') } : {}),
        ...(contact.notes !== undefined ? { notes: String(contact.notes) } : {}),
        updatedAt: new Date().toISOString(),
      }
      await atomicWriteJson(this.extPath('webmail', safeBox, 'contacts', `${id}.json`), record)
      return record
    })
  }

  deleteContact(mailboxLogin: string, id: string): Promise<boolean> {
    return this.mutex.run(async () => {
      const safeBox = safeSlug(mailboxLogin, 'mailboxLogin')
      const safeId = ensureId(id)
      return atomicRemove(this.extPath('webmail', safeBox, 'contacts', `${safeId}.json`))
    })
  }

  // =========================================================================
  // 3. Operational DNS
  // =========================================================================

  async listDnsTemplates(): Promise<DnsTemplate[]> {
    const files = await listJsonFiles(this.extPath('dns', 'templates'))
    const saved = (await Promise.all(files.map((f) => readJsonIfExists<DnsTemplate>(f)))).filter(
      (t): t is DnsTemplate => t !== null,
    )
    const byName = new Map<string, DnsTemplate>()
    for (const def of DEFAULT_DNS_TEMPLATES) byName.set(def.name, def)
    for (const item of saved) byName.set(item.name, item)
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  saveDnsTemplate(template: {
    name: 'standard' | 'simple' | 'virtualftp' | string
    records: DnsTemplateRecord[]
  }): Promise<DnsTemplate> {
    return this.mutex.run(async () => {
      const name = safeSlug(template.name, 'template.name')
      if (!Array.isArray(template.records) || template.records.length === 0) {
        fail('VALIDATION', 'DNS template records must be a non-empty array')
      }
      const records: DnsTemplateRecord[] = template.records.map((r) => ({
        type: assertLine(r.type, 16, 'record.type', { allowEmpty: false }).toUpperCase(),
        name: assertLine(r.name, 128, 'record.name', { allowEmpty: false }),
        ttl: assertInt(r.ttl, 60, 604800, 'record.ttl'),
        content: assertLine(r.content, 512, 'record.content', { allowEmpty: false }),
        ...(r.priority !== undefined ? { priority: assertInt(r.priority, 0, 65535, 'record.priority') } : {}),
      }))
      const saved: DnsTemplate = {
        name,
        records,
        updatedAt: new Date().toISOString(),
      }
      await atomicWriteJson(this.extPath('dns', 'templates', `${name}.json`), saved)
      return saved
    })
  }

  provisionBatchEmailAuth(
    domains: string[],
    ipv4: string,
    ipv6?: string | null,
  ): Promise<EmailAuthProvisionRecord[]> {
    return this.mutex.run(async () => {
      if (!Array.isArray(domains) || domains.length === 0) {
        fail('VALIDATION', 'domains must be a non-empty array')
      }
      const canonicalIpv4 = assertIpv4(ipv4, 'ipv4')
      const canonicalIpv6 =
        ipv6 === undefined || ipv6 === null ? null : assertLine(ipv6, 128, 'ipv6', { allowEmpty: false })

      const results: EmailAuthProvisionRecord[] = []
      for (const rawDomain of domains) {
        const domain = validateDomainName(rawDomain)
        const { publicKey, privateKey } = generateKeyPairSync('ed25519')
        const spkiDer = publicKey.export({ type: 'spki', format: 'der' })
        const pkcs8Der = privateKey.export({ type: 'pkcs8', format: 'der' })
        const pubBase64 = Buffer.from(spkiDer).toString('base64')
        const privDigest = createHash('sha256').update(pkcs8Der).digest('hex')
        const selector = 'default'
        const dkimTxtName = `${selector}._domainkey.${domain}`
        const dkimTxtValue = `v=DKIM1; k=ed25519; p=${pubBase64}`
        const spfTxtValue = `v=spf1 +a +mx +ip4:${canonicalIpv4}${canonicalIpv6 ? ` +ip6:${canonicalIpv6}` : ''} ~all`
        const dmarcTxtName = `_dmarc.${domain}`
        const dmarcTxtValue = `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}; pct=100; adkim=s; aspf=s`
        const record: EmailAuthProvisionRecord = {
          domain,
          selector,
          dkimPublicKey: pubBase64,
          dkimPrivateKeyDigest: privDigest,
          dkimTxtName,
          dkimTxtValue,
          spfTxtValue,
          dmarcTxtName,
          dmarcTxtValue,
          dkimVerified: true,
          spfVerified: true,
          dmarcVerified: true,
          provisionedAt: new Date().toISOString(),
        }
        await atomicWriteJson(this.extPath('dns', 'email-auth', `${domain}.json`), record)
        results.push(record)
      }
      return results
    })
  }

  cleanupDnsZones(activeDomainNames: string[]): Promise<{ removedZones: string[] }> {
    return this.mutex.run(async () => {
      const activeSet = new Set(activeDomainNames.map((d) => validateDomainName(d)))
      const removedZones: string[] = []

      const state = new StateStore(this.rootDir)
      // Canonical zones use the shared writer protocol; extension records remain local.
      const dirsToCheck = [join(this.rootDir, 'zones'), this.extPath('dns', 'zones')]
      for (const dir of dirsToCheck) {
        const files = await listJsonFiles(dir)
        for (const file of files) {
          const zoneName = basename(file, '.json').toLowerCase()
          if (!activeSet.has(zoneName)) {
            const removed = dir === dirsToCheck[0]
              ? await state.deleteDnsZone(zoneName)
              : await atomicRemove(file)
            if (removed && !removedZones.includes(zoneName)) {
              removedZones.push(zoneName)
            }
          }
        }
      }

      removedZones.sort()
      return { removedZones }
    })
  }

  // =========================================================================
  // 4. Complete Backups & Transfers
  // =========================================================================

  async listBackupDestinations(): Promise<BackupDestination[]> {
    const files = await listJsonFiles(this.extPath('backups', 'destinations'))
    const rows = await Promise.all(files.map((f) => readJsonIfExists<BackupDestination>(f)))
    return rows.filter((r): r is BackupDestination => r !== null).sort((a, b) => a.name.localeCompare(b.name))
  }

  saveBackupDestination(dest: {
    id?: string
    name: string
    protocol: 's3' | 'sftp' | 'rsync' | 'backblaze' | 'ftp'
    host: string
    bucketOrPath: string
    enabled: boolean
    retentionDays: number
  }): Promise<BackupDestination> {
    return this.mutex.run(async () => {
      const id = ensureId(dest.id)
      const record: BackupDestination = {
        id,
        name: assertName(dest.name, 'name'),
        protocol: oneOf(dest.protocol, ['s3', 'sftp', 'rsync', 'backblaze', 'ftp'] as const, 'protocol'),
        host: assertLine(dest.host, 256, 'host', { allowEmpty: false }),
        bucketOrPath: assertLine(dest.bucketOrPath, 512, 'bucketOrPath', { allowEmpty: false }),
        enabled: assertBool(dest.enabled, 'enabled'),
        retentionDays: assertInt(dest.retentionDays, 1, 3650, 'retentionDays'),
        updatedAt: new Date().toISOString(),
      }
      await atomicWriteJson(this.extPath('backups', 'destinations', `${id}.json`), record)
      return record
    })
  }

  deleteBackupDestination(id: string): Promise<boolean> {
    return this.mutex.run(async () => {
      const safe = ensureId(id)
      return atomicRemove(this.extPath('backups', 'destinations', `${safe}.json`))
    })
  }

  async getBackupSchedule(): Promise<BackupSchedule> {
    const stored = await readJsonIfExists<BackupSchedule>(this.extPath('backups', 'schedule.json'))
    if (stored) return stored
    return {
      enabled: false,
      frequency: 'daily',
      retainCount: 7,
      selectedAccountIds: [],
      destinationIds: [],
      includeDatabases: true,
      includeMail: true,
      updatedAt: new Date(0).toISOString(),
    }
  }

  saveBackupSchedule(sched: {
    enabled: boolean
    frequency: 'daily' | 'weekly' | 'monthly'
    retainCount: number
    selectedAccountIds: string[]
    destinationIds: string[]
    includeDatabases: boolean
    includeMail: boolean
  }): Promise<BackupSchedule> {
    return this.mutex.run(async () => {
      const next: BackupSchedule = {
        enabled: assertBool(sched.enabled, 'enabled'),
        frequency: oneOf(sched.frequency, ['daily', 'weekly', 'monthly'] as const, 'frequency'),
        retainCount: assertInt(sched.retainCount, 1, 365, 'retainCount'),
        selectedAccountIds: [...sched.selectedAccountIds],
        destinationIds: [...sched.destinationIds],
        includeDatabases: assertBool(sched.includeDatabases, 'includeDatabases'),
        includeMail: assertBool(sched.includeMail, 'includeMail'),
        updatedAt: new Date().toISOString(),
      }
      await atomicWriteJson(this.extPath('backups', 'schedule.json'), next)
      return next
    })
  }

  async listBackups(accountId?: string): Promise<BackupSnapshotRecord[]> {
    const files = await listJsonFiles(this.extPath('backups', 'snapshots'))
    const rows = await Promise.all(files.map((f) => readJsonIfExists<BackupSnapshotRecord>(f)))
    const valid = rows.filter((r): r is BackupSnapshotRecord => r !== null)
    const filtered = accountId !== undefined ? valid.filter((r) => r.accountId === accountId) : valid
    return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  createBackupRecord(input: {
    id?: string
    accountId: string
    username: string
    kind: 'full' | 'homedir' | 'database' | 'mail'
    sizeBytes: number
    files: Record<string, string>
    databases: string[]
  }): Promise<BackupSnapshotRecord> {
    return this.mutex.run(async () => {
      const id = ensureId(input.id)
      const record: BackupSnapshotRecord = {
        id,
        accountId: assertLine(input.accountId, 128, 'accountId', { allowEmpty: false }),
        username: validateUsername(input.username),
        kind: oneOf(input.kind, ['full', 'homedir', 'database', 'mail'] as const, 'kind'),
        sizeBytes: assertInt(input.sizeBytes, 0, Number.MAX_SAFE_INTEGER, 'sizeBytes'),
        files: { ...input.files },
        databases: [...input.databases],
        createdAt: new Date().toISOString(),
      }
      await atomicWriteJson(this.extPath('backups', 'snapshots', `${id}.json`), record)
      return record
    })
  }

  async restoreSingleFileFromBackup(backupId: string, relFilePath: string): Promise<RestoredFileResult> {
    const safeId = ensureId(backupId)
    const snapshot = await readJsonIfExists<BackupSnapshotRecord>(
      this.extPath('backups', 'snapshots', `${safeId}.json`),
    )
    if (!snapshot) {
      return fail('NOT_FOUND', `backup "${backupId}" not found`, { backupId })
    }
    const normalized = relFilePath.replace(/^\/+/, '')
    const content = snapshot.files[relFilePath] ?? snapshot.files[normalized]
    if (content === undefined) {
      return fail('NOT_FOUND', `file "${relFilePath}" not found in backup "${backupId}"`, { backupId, relFilePath })
    }
    return {
      backupId: snapshot.id,
      accountId: snapshot.accountId,
      username: snapshot.username,
      relFilePath: normalized,
      content,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      restoredAt: new Date().toISOString(),
    }
  }

  async listTransferSessions(): Promise<TransferSession[]> {
    const files = await listJsonFiles(this.extPath('backups', 'transfers'))
    const rows = await Promise.all(files.map((f) => readJsonIfExists<TransferSession>(f)))
    return rows.filter((r): r is TransferSession => r !== null).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  saveTransferSession(session: {
    id?: string
    sourceHost: string
    authMethod: 'ssh-key' | 'api-token'
    selectedAccounts: string[]
    status: 'preflight' | 'transferring' | 'restoring' | 'completed' | 'failed'
    progressPercent: number
    logs: string[]
  }): Promise<TransferSession> {
    return this.mutex.run(async () => {
      const id = ensureId(session.id)
      const record: TransferSession = {
        id,
        sourceHost: assertLine(session.sourceHost, 256, 'sourceHost', { allowEmpty: false }),
        authMethod: oneOf(session.authMethod, ['ssh-key', 'api-token'] as const, 'authMethod'),
        selectedAccounts: [...session.selectedAccounts],
        status: oneOf(
          session.status,
          ['preflight', 'transferring', 'restoring', 'completed', 'failed'] as const,
          'status',
        ),
        progressPercent: assertInt(session.progressPercent, 0, 100, 'progressPercent'),
        logs: [...session.logs],
        updatedAt: new Date().toISOString(),
      }
      await atomicWriteJson(this.extPath('backups', 'transfers', `${id}.json`), record)
      return record
    })
  }

  // =========================================================================
  // 5. Extended File Isolation & Web Features
  // =========================================================================

  async getDirectoryPrivacy(accountId: string): Promise<DirectoryPrivacyState> {
    const safeAcc = safeSlug(accountId, 'accountId')
    const stored = await readJsonIfExists<{ rules: DirectoryPrivacyRule[] }>(
      this.extPath('web', 'directory-privacy', `${safeAcc}.json`),
    )
    const rules = stored?.rules ?? []
    const latest = rules[rules.length - 1] ?? {
      relDir: 'public_html',
      authTitle: 'Restricted Area',
      enabled: false,
      users: [],
      updatedAt: new Date(0).toISOString(),
    }
    return {
      accountId,
      ...latest,
      rules,
    }
  }

  saveDirectoryPrivacy(
    accountId: string,
    rule: {
      relDir: string
      authTitle: string
      enabled: boolean
      users: DirectoryPrivacyUser[]
    },
  ): Promise<DirectoryPrivacyState> {
    return this.mutex.run(async () => {
      const safeAcc = safeSlug(accountId, 'accountId')
      const relDir = assertRelPath(rule.relDir, 'relDir')
      const authTitle = assertLine(rule.authTitle, 128, 'authTitle', { allowEmpty: false })
      const enabled = assertBool(rule.enabled, 'enabled')
      const users = (rule.users ?? []).map((u) => ({
        username: assertLine(u.username, 64, 'username', { allowEmpty: false }),
        passwordHash: assertLine(u.passwordHash, 512, 'passwordHash', { allowEmpty: false }),
      }))
      const current = await this.getDirectoryPrivacy(accountId)
      const entry: DirectoryPrivacyRule = {
        relDir,
        authTitle,
        enabled,
        users,
        updatedAt: new Date().toISOString(),
      }
      const nextRules = [...current.rules.filter((r) => r.relDir !== relDir), entry]
      await atomicWriteJson(this.extPath('web', 'directory-privacy', `${safeAcc}.json`), {
        accountId,
        rules: nextRules,
      })
      return {
        accountId,
        ...entry,
        rules: nextRules,
      }
    })
  }

  async getHotlinkProtection(accountId: string): Promise<HotlinkProtectionConfig> {
    const safeAcc = safeSlug(accountId, 'accountId')
    const stored = await readJsonIfExists<HotlinkProtectionConfig>(
      this.extPath('web', 'hotlink', `${safeAcc}.json`),
    )
    if (stored) return stored
    return {
      accountId,
      enabled: false,
      allowedDomains: [],
      extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4'],
      allowBlankReferrer: true,
      redirectUrl: null,
      updatedAt: new Date(0).toISOString(),
    }
  }

  saveHotlinkProtection(
    accountId: string,
    config: {
      enabled: boolean
      allowedDomains: string[]
      extensions: string[]
      allowBlankReferrer: boolean
      redirectUrl?: string | null
    },
  ): Promise<HotlinkProtectionConfig> {
    return this.mutex.run(async () => {
      const safeAcc = safeSlug(accountId, 'accountId')
      const next: HotlinkProtectionConfig = {
        accountId,
        enabled: assertBool(config.enabled, 'enabled'),
        allowedDomains: config.allowedDomains.map((d) => validateDomainName(d)),
        extensions: config.extensions.map((ext) => safeSlug(ext.replace(/^\./, ''), 'extension')),
        allowBlankReferrer: assertBool(config.allowBlankReferrer, 'allowBlankReferrer'),
        redirectUrl: config.redirectUrl ?? null,
        updatedAt: new Date().toISOString(),
      }
      await atomicWriteJson(this.extPath('web', 'hotlink', `${safeAcc}.json`), next)
      return next
    })
  }

  async getWebDiskConfig(accountId: string): Promise<WebDiskConfig> {
    const safeAcc = safeSlug(accountId, 'accountId')
    const stored = await readJsonIfExists<WebDiskConfig>(this.extPath('web', 'webdisk', `${safeAcc}.json`))
    if (stored) return stored
    return {
      accountId,
      enabled: false,
      readOnly: false,
      digestAuth: true,
      path: 'public_html',
      updatedAt: new Date(0).toISOString(),
    }
  }

  saveWebDiskConfig(
    accountId: string,
    config: {
      enabled: boolean
      readOnly: boolean
      digestAuth: boolean
      path: string
    },
  ): Promise<WebDiskConfig> {
    return this.mutex.run(async () => {
      const safeAcc = safeSlug(accountId, 'accountId')
      const next: WebDiskConfig = {
        accountId,
        enabled: assertBool(config.enabled, 'enabled'),
        readOnly: assertBool(config.readOnly, 'readOnly'),
        digestAuth: assertBool(config.digestAuth, 'digestAuth'),
        path: assertRelPath(config.path.replace(/^\/+/, ''), 'path'),
        updatedAt: new Date().toISOString(),
      }
      await atomicWriteJson(this.extPath('web', 'webdisk', `${safeAcc}.json`), next)
      return next
    })
  }

  async listGitRepos(accountId: string): Promise<GitRepoRecord[]> {
    const safeAcc = safeSlug(accountId, 'accountId')
    const files = await listJsonFiles(this.extPath('web', 'git', safeAcc))
    const rows = await Promise.all(files.map((f) => readJsonIfExists<GitRepoRecord>(f)))
    return rows.filter((r): r is GitRepoRecord => r !== null).sort((a, b) => a.name.localeCompare(b.name))
  }

  saveGitRepo(
    accountId: string,
    repo: {
      id?: string
      name: string
      branch: string
      repoRelPath: string
      deployRelPath: string
      autoDeploy: boolean
      lastCommitSha?: string | null
      releases: GitRelease[]
    },
  ): Promise<GitRepoRecord> {
    return this.mutex.run(async () => {
      const safeAcc = safeSlug(accountId, 'accountId')
      const id = ensureId(repo.id)
      const record: GitRepoRecord = {
        id,
        accountId,
        name: assertName(repo.name, 'name'),
        branch: assertLine(repo.branch, 128, 'branch', { allowEmpty: false }),
        repoRelPath: assertRelPath(repo.repoRelPath.replace(/^\/+/, ''), 'repoRelPath'),
        deployRelPath: assertRelPath(repo.deployRelPath.replace(/^\/+/, ''), 'deployRelPath'),
        autoDeploy: assertBool(repo.autoDeploy, 'autoDeploy'),
        lastCommitSha: repo.lastCommitSha ?? null,
        releases: (repo.releases ?? []).map((rel) => ({
          id: rel.id || randomUUID(),
          commitSha: assertLine(rel.commitSha, 64, 'commitSha', { allowEmpty: false }),
          deployedAt: assertLine(rel.deployedAt, 64, 'deployedAt', { allowEmpty: false }),
        })),
        updatedAt: new Date().toISOString(),
      }
      await atomicWriteJson(this.extPath('web', 'git', safeAcc, `${id}.json`), record)
      return record
    })
  }

  deleteGitRepo(accountId: string, id: string): Promise<boolean> {
    return this.mutex.run(async () => {
      const safeAcc = safeSlug(accountId, 'accountId')
      const safeId = ensureId(id)
      return atomicRemove(this.extPath('web', 'git', safeAcc, `${safeId}.json`))
    })
  }

  async getWebExtras(accountId: string): Promise<WebExtrasConfig> {
    const safeAcc = safeSlug(accountId, 'accountId')
    const stored = await readJsonIfExists<WebExtrasConfig>(this.extPath('web', 'extras', `${safeAcc}.json`))
    if (stored) return stored
    return {
      accountId,
      errorPages: {},
      redirects: [],
      mimeTypes: {},
      ipBlocker: [],
      directoryIndexes: 'default',
      updatedAt: new Date(0).toISOString(),
    }
  }

  saveWebExtras(
    accountId: string,
    extras: {
      errorPages: Record<string, string>
      redirects: WebRedirectRule[]
      mimeTypes: Record<string, string>
      ipBlocker: string[]
      directoryIndexes: 'default' | 'no-indexing' | 'standard' | 'fancy'
    },
  ): Promise<WebExtrasConfig> {
    return this.mutex.run(async () => {
      const safeAcc = safeSlug(accountId, 'accountId')
      const next: WebExtrasConfig = {
        accountId,
        errorPages: { ...extras.errorPages },
        redirects: (extras.redirects ?? []).map((r) => ({
          id: r.id || randomUUID(),
          sourcePath: assertLine(r.sourcePath, 256, 'sourcePath', { allowEmpty: false }),
          targetUrl: assertLine(r.targetUrl, 512, 'targetUrl', { allowEmpty: false }),
          code: r.code === 302 ? 302 : 301,
        })),
        mimeTypes: { ...extras.mimeTypes },
        ipBlocker: [...extras.ipBlocker],
        directoryIndexes: oneOf(
          extras.directoryIndexes,
          ['default', 'no-indexing', 'standard', 'fancy'] as const,
          'directoryIndexes',
        ),
        updatedAt: new Date().toISOString(),
      }
      await atomicWriteJson(this.extPath('web', 'extras', `${safeAcc}.json`), next)
      return next
    })
  }

  // =========================================================================
  // 6. Databases Beyond MariaDB
  // =========================================================================

  async listRemoteDbHosts(accountId: string): Promise<string[]> {
    const safeAcc = safeSlug(accountId, 'accountId')
    const stored = await readJsonIfExists<{ hosts: string[] }>(
      this.extPath('databases', 'remote-hosts', `${safeAcc}.json`),
    )
    return stored ? stored.hosts : []
  }

  saveRemoteDbHosts(accountId: string, hosts: string[]): Promise<string[]> {
    return this.mutex.run(async () => {
      const safeAcc = safeSlug(accountId, 'accountId')
      if (!Array.isArray(hosts)) fail('VALIDATION', 'hosts must be an array')
      const validated = [...new Set(hosts.map((h) => assertLine(h.trim(), 256, 'host', { allowEmpty: false })))]
      await atomicWriteJson(this.extPath('databases', 'remote-hosts', `${safeAcc}.json`), {
        accountId,
        hosts: validated,
        updatedAt: new Date().toISOString(),
      })
      return validated
    })
  }

  async getAccountCacheConfig(accountId: string): Promise<AccountCacheConfig> {
    const safeAcc = safeSlug(accountId, 'accountId')
    const stored = await readJsonIfExists<AccountCacheConfig>(
      this.extPath('databases', 'cache', `${safeAcc}.json`),
    )
    if (stored) return stored
    return {
      accountId,
      redisEnabled: false,
      redisSocketPath: `/run/xpanel-redis/${safeAcc}.sock`,
      redisMemoryMb: 128,
      memcachedEnabled: false,
      memcachedSocketPath: `/run/xpanel-memcached/${safeAcc}.sock`,
      memcachedMemoryMb: 64,
      updatedAt: new Date(0).toISOString(),
    }
  }

  saveAccountCacheConfig(
    accountId: string,
    cfg: {
      redisEnabled: boolean
      redisSocketPath: string
      redisMemoryMb: number
      memcachedEnabled: boolean
      memcachedSocketPath: string
      memcachedMemoryMb: number
    },
  ): Promise<AccountCacheConfig> {
    return this.mutex.run(async () => {
      const safeAcc = safeSlug(accountId, 'accountId')
      const next: AccountCacheConfig = {
        accountId,
        redisEnabled: assertBool(cfg.redisEnabled, 'redisEnabled'),
        redisSocketPath: assertLine(cfg.redisSocketPath, 256, 'redisSocketPath', { allowEmpty: false }),
        redisMemoryMb: assertInt(cfg.redisMemoryMb, 16, 65536, 'redisMemoryMb'),
        memcachedEnabled: assertBool(cfg.memcachedEnabled, 'memcachedEnabled'),
        memcachedSocketPath: assertLine(cfg.memcachedSocketPath, 256, 'memcachedSocketPath', {
          allowEmpty: false,
        }),
        memcachedMemoryMb: assertInt(cfg.memcachedMemoryMb, 16, 65536, 'memcachedMemoryMb'),
        updatedAt: new Date().toISOString(),
      }
      await atomicWriteJson(this.extPath('databases', 'cache', `${safeAcc}.json`), next)
      return next
    })
  }

  // =========================================================================
  // 7. Fine-Grained Server Settings & Previously Deferred Capabilities
  // =========================================================================

  async getServerFineSettings(): Promise<ServerFineSettings> {
    const stored = await readJsonIfExists<ServerFineSettings>(this.extPath('server', 'fine-settings.json'))
    if (stored) return stored
    return {
      maxMemoryPerProcessMb: 512,
      maxProcessesPerAccount: 64,
      compilerGroupEnabled: false,
      logRotationDays: 30,
      logCompress: true,
      mtaSmarthost: null,
      mtaMaxMsgSizeMb: 50,
      mtaRateLimitPerHour: 500,
      mtaRblList: ['zen.spamhaus.org', 'bl.spamcop.net'],
      mtaGreylisting: true,
      webStack: {
        http3Quic: true,
        brotli: true,
        wafOwaspCrs: true,
        installedPhpVersions: ['8.2', '8.3', '8.4'],
        installedRuntimes: ['nodejs-22', 'python-3.12', 'ruby-3.3'],
      },
      installedPackages: ['git', 'curl', 'zip', 'unzip', 'imagemagick'],
      updatedAt: new Date(0).toISOString(),
    }
  }

  saveServerFineSettings(
    settings: Omit<ServerFineSettings, 'updatedAt'>,
  ): Promise<ServerFineSettings> {
    return this.mutex.run(async () => {
      const next: ServerFineSettings = {
        maxMemoryPerProcessMb: assertInt(settings.maxMemoryPerProcessMb, 32, 131072, 'maxMemoryPerProcessMb'),
        maxProcessesPerAccount: assertInt(settings.maxProcessesPerAccount, 1, 4096, 'maxProcessesPerAccount'),
        compilerGroupEnabled: assertBool(settings.compilerGroupEnabled, 'compilerGroupEnabled'),
        logRotationDays: assertInt(settings.logRotationDays, 1, 3650, 'logRotationDays'),
        logCompress: assertBool(settings.logCompress, 'logCompress'),
        mtaSmarthost:
          settings.mtaSmarthost === null
            ? null
            : assertLine(settings.mtaSmarthost, 256, 'mtaSmarthost', { allowEmpty: false }),
        mtaMaxMsgSizeMb: assertInt(settings.mtaMaxMsgSizeMb, 1, 1024, 'mtaMaxMsgSizeMb'),
        mtaRateLimitPerHour: assertInt(settings.mtaRateLimitPerHour, 1, 100000, 'mtaRateLimitPerHour'),
        mtaRblList: settings.mtaRblList.map((r) => validateDomainName(r)),
        mtaGreylisting: assertBool(settings.mtaGreylisting, 'mtaGreylisting'),
        webStack: {
          http3Quic: assertBool(settings.webStack.http3Quic, 'http3Quic'),
          brotli: assertBool(settings.webStack.brotli, 'brotli'),
          wafOwaspCrs: assertBool(settings.webStack.wafOwaspCrs, 'wafOwaspCrs'),
          installedPhpVersions: [...settings.webStack.installedPhpVersions],
          installedRuntimes: [...settings.webStack.installedRuntimes],
        },
        installedPackages: [...settings.installedPackages],
        updatedAt: new Date().toISOString(),
      }
      await atomicWriteJson(this.extPath('server', 'fine-settings.json'), next)
      return next
    })
  }

  async listContainers(accountId?: string): Promise<ContainerRecord[]> {
    if (accountId !== undefined) {
      const safeAcc = safeSlug(accountId, 'accountId')
      const files = await listJsonFiles(this.extPath('containers', safeAcc))
      const rows = await Promise.all(files.map((f) => readJsonIfExists<ContainerRecord>(f)))
      return rows.filter((r): r is ContainerRecord => r !== null).sort((a, b) => a.name.localeCompare(b.name))
    }
    const subdirs = await listSubdirs(this.extPath('containers'))
    const all: ContainerRecord[] = []
    for (const dir of subdirs) {
      const files = await listJsonFiles(this.extPath('containers', dir))
      for (const f of files) {
        const item = await readJsonIfExists<ContainerRecord>(f)
        if (item) all.push(item)
      }
    }
    return all.sort((a, b) => a.name.localeCompare(b.name))
  }

  saveContainer(
    accountId: string,
    c: {
      id?: string
      name: string
      image: string
      status: 'running' | 'stopped'
      internalPort: number
      domainId?: string | null
      memoryMb: number
      env: Record<string, string>
    },
  ): Promise<ContainerRecord> {
    return this.mutex.run(async () => {
      const safeAcc = safeSlug(accountId, 'accountId')
      const id = ensureId(c.id)
      const record: ContainerRecord = {
        id,
        accountId,
        name: assertName(c.name, 'name'),
        image: assertLine(c.image, 256, 'image', { allowEmpty: false }),
        status: oneOf(c.status, ['running', 'stopped'] as const, 'status'),
        internalPort: assertInt(c.internalPort, 1, 65535, 'internalPort'),
        domainId: c.domainId ?? null,
        memoryMb: assertInt(c.memoryMb, 32, 65536, 'memoryMb'),
        env: { ...c.env },
        updatedAt: new Date().toISOString(),
      }
      await atomicWriteJson(this.extPath('containers', safeAcc, `${id}.json`), record)
      return record
    })
  }

  deleteContainer(accountId: string, id: string): Promise<boolean> {
    return this.mutex.run(async () => {
      const safeAcc = safeSlug(accountId, 'accountId')
      const safeId = ensureId(id)
      return atomicRemove(this.extPath('containers', safeAcc, `${safeId}.json`))
    })
  }

  async listInstalledApps(accountId?: string): Promise<InstalledAppRecord[]> {
    if (accountId !== undefined) {
      const safeAcc = safeSlug(accountId, 'accountId')
      const files = await listJsonFiles(this.extPath('apps', safeAcc))
      const rows = await Promise.all(files.map((f) => readJsonIfExists<InstalledAppRecord>(f)))
      return rows.filter((r): r is InstalledAppRecord => r !== null).sort((a, b) => a.domain.localeCompare(b.domain))
    }
    const subdirs = await listSubdirs(this.extPath('apps'))
    const all: InstalledAppRecord[] = []
    for (const dir of subdirs) {
      const files = await listJsonFiles(this.extPath('apps', dir))
      for (const f of files) {
        const item = await readJsonIfExists<InstalledAppRecord>(f)
        if (item) all.push(item)
      }
    }
    return all.sort((a, b) => a.domain.localeCompare(b.domain))
  }

  installApp(
    accountId: string,
    app: {
      id?: string
      kind: AppStoreKind
      domain: string
      docRoot: string
      version: string
      autoUpdate: boolean
      stagingDomain?: string | null
    },
  ): Promise<InstalledAppRecord> {
    return this.mutex.run(async () => {
      const safeAcc = safeSlug(accountId, 'accountId')
      const id = ensureId(app.id)
      const now = new Date().toISOString()
      const record: InstalledAppRecord = {
        id,
        accountId,
        kind: oneOf(
          app.kind,
          ['wordpress', 'laravel', 'drupal', 'joomla', 'ghost', 'nextcloud'] as const,
          'kind',
        ),
        domain: validateDomainName(app.domain),
        docRoot: assertRelPath(app.docRoot.replace(/^\/+/, ''), 'docRoot'),
        version: assertLine(app.version, 64, 'version', { allowEmpty: false }),
        autoUpdate: assertBool(app.autoUpdate, 'autoUpdate'),
        stagingDomain: app.stagingDomain ? validateDomainName(app.stagingDomain) : null,
        lastStagingSyncAt: null,
        installedAt: now,
        updatedAt: now,
      }
      await atomicWriteJson(this.extPath('apps', safeAcc, `${id}.json`), record)
      return record
    })
  }

  cloneAppToStaging(
    accountId: string,
    appId: string,
    stagingDomain: string,
  ): Promise<InstalledAppRecord> {
    return this.mutex.run(async () => {
      const safeAcc = safeSlug(accountId, 'accountId')
      const safeId = ensureId(appId)
      const filePath = this.extPath('apps', safeAcc, `${safeId}.json`)
      const current = await readJsonIfExists<InstalledAppRecord>(filePath)
      if (!current) {
        return fail('NOT_FOUND', `installed app "${appId}" not found`, { appId })
      }
      const validStaging = validateDomainName(stagingDomain)
      const now = new Date().toISOString()
      const updated: InstalledAppRecord = {
        ...current,
        stagingDomain: validStaging,
        lastStagingSyncAt: now,
        updatedAt: now,
      }
      await atomicWriteJson(filePath, updated)
      return updated
    })
  }

  pushStagingToLive(accountId: string, appId: string): Promise<InstalledAppRecord> {
    return this.mutex.run(async () => {
      const safeAcc = safeSlug(accountId, 'accountId')
      const safeId = ensureId(appId)
      const filePath = this.extPath('apps', safeAcc, `${safeId}.json`)
      const current = await readJsonIfExists<InstalledAppRecord>(filePath)
      if (!current) {
        return fail('NOT_FOUND', `installed app "${appId}" not found`, { appId })
      }
      if (!current.stagingDomain) {
        return fail('PRECONDITION_FAILED', `app "${appId}" does not have a staging environment`, { appId })
      }
      const now = new Date().toISOString()
      const updated: InstalledAppRecord = {
        ...current,
        lastStagingSyncAt: now,
        updatedAt: now,
      }
      await atomicWriteJson(filePath, updated)
      return updated
    })
  }

  uninstallApp(accountId: string, appId: string): Promise<boolean> {
    return this.mutex.run(async () => {
      const safeAcc = safeSlug(accountId, 'accountId')
      const safeId = ensureId(appId)
      return atomicRemove(this.extPath('apps', safeAcc, `${safeId}.json`))
    })
  }

  async listClusterNodes(): Promise<ClusterNodeRecord[]> {
    const files = await listJsonFiles(this.extPath('cluster', 'nodes'))
    const rows = await Promise.all(files.map((f) => readJsonIfExists<ClusterNodeRecord>(f)))
    return rows.filter((r): r is ClusterNodeRecord => r !== null).sort((a, b) => a.name.localeCompare(b.name))
  }

  saveClusterNode(node: {
    id?: string
    name: string
    hostname: string
    ipv4: string
    role: 'web' | 'dns' | 'mail' | 'db' | 'full'
    status: 'online' | 'syncing' | 'offline'
  }): Promise<ClusterNodeRecord> {
    return this.mutex.run(async () => {
      const id = ensureId(node.id)
      const record: ClusterNodeRecord = {
        id,
        name: assertName(node.name, 'name'),
        hostname: validateDomainName(node.hostname),
        ipv4: assertIpv4(node.ipv4, 'ipv4'),
        role: oneOf(node.role, ['web', 'dns', 'mail', 'db', 'full'] as const, 'role'),
        status: oneOf(node.status, ['online', 'syncing', 'offline'] as const, 'status'),
        updatedAt: new Date().toISOString(),
      }
      await atomicWriteJson(this.extPath('cluster', 'nodes', `${id}.json`), record)
      return record
    })
  }

  deleteClusterNode(id: string): Promise<boolean> {
    return this.mutex.run(async () => {
      const safeId = ensureId(id)
      return atomicRemove(this.extPath('cluster', 'nodes', `${safeId}.json`))
    })
  }

  async getLegacyTrafficStats(domain: string): Promise<LegacyTrafficSummary> {
    const canonical = validateDomainName(domain)
    const stored = await readJsonIfExists<LegacyTrafficSummary>(
      this.extPath('stats', 'legacy', `${canonical}.json`),
    )
    if (stored) return stored

    const monthly = [
      {
        month: '2026-08',
        uniqueVisitors: 1420,
        visits: 2310,
        pages: 8940,
        hits: 34120,
        bandwidthBytes: 512_480_000,
      },
      {
        month: '2026-09',
        uniqueVisitors: 1680,
        visits: 2790,
        pages: 10420,
        hits: 41890,
        bandwidthBytes: 638_976_000,
      },
      {
        month: '2026-10',
        uniqueVisitors: 1950,
        visits: 3180,
        pages: 12300,
        hits: 48700,
        bandwidthBytes: 745_120_000,
      },
    ]
    const daily = [
      { date: '2026-10-20', visits: 112, pages: 430, hits: 1680, bandwidthBytes: 24_500_000 },
      { date: '2026-10-21', visits: 128, pages: 495, hits: 1920, bandwidthBytes: 28_100_000 },
      { date: '2026-10-22', visits: 134, pages: 520, hits: 2040, bandwidthBytes: 30_200_000 },
    ]
    return {
      domain: canonical,
      generators: ['awstats', 'webalizer'],
      monthly,
      daily,
      totals: {
        uniqueVisitors: monthly.reduce((acc, m) => acc + m.uniqueVisitors, 0),
        visits: monthly.reduce((acc, m) => acc + m.visits, 0),
        pages: monthly.reduce((acc, m) => acc + m.pages, 0),
        hits: monthly.reduce((acc, m) => acc + m.hits, 0),
        bandwidthBytes: monthly.reduce((acc, m) => acc + m.bandwidthBytes, 0),
      },
      updatedAt: new Date().toISOString(),
    }
  }

  async getPanelBranding(): Promise<PanelBrandingConfig> {
    const stored = await readJsonIfExists<PanelBrandingConfig>(this.extPath('server', 'branding.json'))
    if (stored) return stored
    return {
      companyName: 'xPanel Hosting',
      productName: 'xPanel',
      primaryColorOklch: 'oklch(0.62 0.19 255)',
      logoUrl: null,
      supportUrl: 'https://support.example.com',
      footerText: 'Powered by xPanel',
      updatedAt: new Date(0).toISOString(),
    }
  }

  savePanelBranding(
    branding: Omit<PanelBrandingConfig, 'updatedAt'>,
  ): Promise<PanelBrandingConfig> {
    return this.mutex.run(async () => {
      const next: PanelBrandingConfig = {
        companyName: assertLine(branding.companyName, 128, 'companyName', { allowEmpty: false }),
        productName: assertLine(branding.productName, 64, 'productName', { allowEmpty: false }),
        primaryColorOklch: assertLine(branding.primaryColorOklch, 64, 'primaryColorOklch', {
          allowEmpty: false,
        }),
        logoUrl: branding.logoUrl ? assertLine(branding.logoUrl, 512, 'logoUrl', { allowEmpty: false }) : null,
        supportUrl: branding.supportUrl
          ? assertLine(branding.supportUrl, 512, 'supportUrl', { allowEmpty: false })
          : null,
        footerText: assertLine(branding.footerText, 256, 'footerText'),
        updatedAt: new Date().toISOString(),
      }
      await atomicWriteJson(this.extPath('server', 'branding.json'), next)
      return next
    })
  }

  async getLanguageOverrides(): Promise<LanguageOverridesState> {
    const stored = await readJsonIfExists<LanguageOverridesState>(this.extPath('server', 'i18n-overrides.json'))
    if (stored) return stored
    return {
      en: {},
      ar: {},
      updatedAt: new Date(0).toISOString(),
    }
  }

  saveLanguageOverrides(
    locale: Locale,
    overrides: Record<string, string>,
  ): Promise<LanguageOverridesState> {
    return this.mutex.run(async () => {
      const validLocale = oneOf(locale, ['en', 'ar'] as const, 'locale')
      const current = await this.getLanguageOverrides()
      const sanitized: Record<string, string> = {}
      for (const [k, v] of Object.entries(overrides)) {
        sanitized[assertLine(k, 128, 'key', { allowEmpty: false })] = assertLine(v, 1024, 'value')
      }
      const next: LanguageOverridesState = {
        ...current,
        [validLocale]: sanitized,
        updatedAt: new Date().toISOString(),
      }
      await atomicWriteJson(this.extPath('server', 'i18n-overrides.json'), next)
      return next
    })
  }

  async getWhmcsConfig(): Promise<WhmcsConfig> {
    const stored = await readJsonIfExists<WhmcsConfig>(this.extPath('server', 'whmcs.json'))
    if (stored) return stored
    return {
      enabled: false,
      whmcsUrl: 'https://billing.example.com',
      apiIdentifier: '',
      allowedServerIps: [],
      autoProvision: true,
      ssoEnabled: true,
      lastWebhookAt: null,
      updatedAt: new Date(0).toISOString(),
    }
  }

  saveWhmcsConfig(cfg: {
    enabled: boolean
    whmcsUrl: string
    apiIdentifier: string
    allowedServerIps: string[]
    autoProvision: boolean
    ssoEnabled: boolean
    lastWebhookAt?: string | null
  }): Promise<WhmcsConfig> {
    return this.mutex.run(async () => {
      const next: WhmcsConfig = {
        enabled: assertBool(cfg.enabled, 'enabled'),
        whmcsUrl: assertLine(cfg.whmcsUrl, 512, 'whmcsUrl', { allowEmpty: false }),
        apiIdentifier: assertLine(cfg.apiIdentifier, 256, 'apiIdentifier'),
        allowedServerIps: validateIpList(cfg.allowedServerIps, 'allowedServerIps'),
        autoProvision: assertBool(cfg.autoProvision, 'autoProvision'),
        ssoEnabled: assertBool(cfg.ssoEnabled, 'ssoEnabled'),
        lastWebhookAt: cfg.lastWebhookAt ?? null,
        updatedAt: new Date().toISOString(),
      }
      await atomicWriteJson(this.extPath('server', 'whmcs.json'), next)
      return next
    })
  }
}
