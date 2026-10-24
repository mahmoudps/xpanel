import { createHash, createPublicKey, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { services as mailServices } from '@xpanel/render'
import { join } from 'node:path'
import {
  fail,
  suggestServerSettings,
  validateDomainName,
} from '@xpanel/core'
import type {
  Account,
  DnsRecord,
  Id,
  LiveEventScope,
  ServerSettings,
} from '@xpanel/core'
import type { Db } from '@xpanel/db'
import {
  buildReview,
  createTransferSession,
  reviewDigest,
  transition,
} from '@xpanel/lifecycle'
import type { TransferEvent, TransferSession } from '@xpanel/lifecycle'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import { passwordHashFromInput } from './auth.ts'
import type { AuthenticatedCaller } from './auth.ts'
import {
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
  /** Authenticated agent result. Private key material must never cross this boundary. */
  readDkimPublicMaterial?: (caller: AuthenticatedCaller, domain: string) => Promise<{ selector: string; publicKeyPem: string } | null>
  requireCaller: (req: Request, opts?: { allowUnverifiedMfa?: boolean }) => Promise<AuthenticatedCaller>
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
  name: string
  color: string
  timezone: string
  shares: { principal: string; permission: 'read' | 'read-write'; sharedAt: string }[]
  events?: WebmailCalendarEvent[]
  createdAt: string
}

export interface WebmailContact {
  id: Id
  owner: string
  fullName: string
  email: string
  phone: string
  organization: string
  title: string
  groups: string[]
  shares?: { principal: string; permission: 'read' | 'read-write'; sharedAt: string }[]
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

export interface DnsClusterConfig {
  enabled: boolean
  provider: 'powerdns-cluster' | 'cloudflare' | 'route53' | 'axfr'
  nodes: { id: Id; hostname: string; ip: string; role: 'nameserver' | 'supermaster'; status: 'synced' | 'pending' }[]
  cloudflareZoneMap: Record<string, string>
  autoSyncOnReconcile: boolean
  updatedAt: string
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

export interface PostgresDatabaseRecord {
  id: Id
  accountId: Id
  name: string
  encoding: string
  locale: string
  extensions: string[]
  compiledSql: string
  createdAt: string
}

export interface PostgresUserRecord {
  id: Id
  accountId: Id
  username: string
  databaseIds: Id[]
  privileges: ('ALL' | 'CONNECT' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE')[]
  scramHash: string
  compiledSql: string
  createdAt: string
}

export interface RemoteDatabaseHostsConfig {
  accountId: Id
  hosts: { address: string; engine: 'mariadb' | 'postgresql' | 'both'; comment: string }[]
  compiledPgHba: string
  compiledMariaDbGrants: string
  updatedAt: string
}

export interface MongoDatabaseRecord {
  id: Id
  accountId: Id
  name: string
  username: string
  roles: string[]
  connectionUri: string
  createdAt: string
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

export const compileSieveRules = (rules: readonly SieveFilterRule[]): string => {
  const active = [...rules].filter((r) => r.enabled).sort((a, b) => a.priority - b.priority)
  const lines: string[] = [
    '# Generated by xPanel Sieve Compiler (RFC 5228)',
    'require ["fileinto", "reject", "envelope", "body", "relational"];',
    '',
  ]
  for (const rule of active) {
    lines.push(`# Rule: ${rule.name} (priority ${rule.priority})`)
    const condStrings = rule.conditions.map((c) => {
      if (c.field === 'size') {
        const dir = c.comparator === 'under' ? ':under' : ':over'
        return `size ${dir} ${c.value}`
      }
      if (c.field === 'body') {
        return `body :contains "${c.value.replace(/"/g, '\\"')}"`
      }
      const header =
        c.field === 'from'
          ? 'From'
          : c.field === 'to'
            ? 'To'
            : c.field === 'subject'
              ? 'Subject'
              : (c.headerName ?? 'X-Spam-Flag')
      const comp = c.comparator === 'is' ? ':is' : c.comparator === 'matches' ? ':matches' : ':contains'
      return `header ${comp} "${header}" "${c.value.replace(/"/g, '\\"')}"`
    })
    const joiner = rule.matchAll ? 'allof' : 'anyof'
    const conditionExpr =
      condStrings.length === 0
        ? 'true'
        : condStrings.length === 1
          ? condStrings[0]!
          : `${joiner} (${condStrings.join(', ')})`
    let actionStmt = 'keep;'
    switch (rule.action.type) {
      case 'fileinto':
        actionStmt = `fileinto "${(rule.action.target ?? 'INBOX').replace(/"/g, '\\"')}"; stop;`
        break
      case 'redirect':
        actionStmt = `redirect "${(rule.action.target ?? '').replace(/"/g, '\\"')}"; stop;`
        break
      case 'discard':
        actionStmt = 'discard; stop;'
        break
      case 'reject':
        actionStmt = `reject "${(rule.action.target ?? 'Message rejected by filter').replace(/"/g, '\\"')}"; stop;`
        break
      case 'keep':
        actionStmt = 'keep;'
        break
    }
    lines.push(`if ${conditionExpr} {`)
    lines.push(`  ${actionStmt}`)
    lines.push('}')
    lines.push('')
  }
  return lines.join('\n')
}

export const compileVacationSieve = (cfg: {
  enabled: boolean
  subject: string
  body: string
  replyIntervalHours: number
  mailbox: string
}): string => {
  if (!cfg.enabled) {
    return '# Vacation responder disabled\n'
  }
  const days = Math.max(1, Math.round(cfg.replyIntervalHours / 24))
  return [
    'require ["vacation"];',
    `vacation :days ${days} :addresses ["${cfg.mailbox}"] :subject "${cfg.subject.replace(/"/g, '\\"')}" "${cfg.body.replace(/"/g, '\\"')}";`,
    '',
  ].join('\n')
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

const parseAndValidateIcs = (icsText: string, defaultTimezone: string): WebmailCalendarEvent[] => {
  if (typeof icsText !== 'string' || !icsText.trim() || Buffer.byteLength(icsText, 'utf8') > 256 * 1024) {
    return fail('VALIDATION', 'valid ICS content is required')
  }
  if (UNSAFE_CAL_VCARD_PATTERN.test(icsText) || /ATTACH[^:\r\n]*:(?:file|javascript|data):/i.test(icsText)) {
    return fail('VALIDATION', 'malicious or unsafe ICS payload rejected')
  }
  const lines = icsText.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (lines[0] !== 'BEGIN:VCALENDAR' || lines[lines.length - 1] !== 'END:VCALENDAR') {
    return fail('VALIDATION', 'ICS payload must begin with BEGIN:VCALENDAR and end with END:VCALENDAR')
  }
  let inEvent = false
  let current: Partial<WebmailCalendarEvent> = {}
  const events: WebmailCalendarEvent[] = []
  let calendarTz = defaultTimezone
  for (const line of lines) {
    if (line.startsWith('X-WR-TIMEZONE:')) {
      calendarTz = assertValidTimezone(line.slice('X-WR-TIMEZONE:'.length))
      continue
    }
    if (line === 'BEGIN:VEVENT') {
      if (inEvent) return fail('VALIDATION', 'nested VEVENT blocks are not permitted')
      inEvent = true
      current = { id: randomUUID(), uid: randomUUID(), description: '', location: '', timezone: calendarTz }
      continue
    }
    if (line === 'END:VEVENT') {
      if (!inEvent) return fail('VALIDATION', 'unmatched END:VEVENT in ICS payload')
      if (!current.summary || !current.dtstart) {
        return fail('VALIDATION', 'each VEVENT requires SUMMARY and DTSTART')
      }
      events.push({
        id: current.id ?? randomUUID(),
        uid: current.uid ?? randomUUID(),
        summary: current.summary,
        description: current.description ?? '',
        location: current.location ?? '',
        dtstart: current.dtstart,
        dtend: current.dtend ?? current.dtstart,
        timezone: current.timezone ?? calendarTz,
      })
      inEvent = false
      current = {}
      continue
    }
    if (!inEvent) continue
    const colonIdx = line.indexOf(':')
    if (colonIdx <= 0) return fail('VALIDATION', 'malformed property line in VEVENT')
    const rawKey = line.slice(0, colonIdx)
    const rawVal = line.slice(colonIdx + 1).trim()
    const [propName, ...params] = rawKey.split(';')
    for (const param of params) {
      if (param.toUpperCase().startsWith('TZID=')) {
        current.timezone = assertValidTimezone(param.slice(5))
      }
    }
    const keyUpper = (propName ?? '').toUpperCase()
    if (keyUpper === 'UID') current.uid = assertSafeCalendarText(rawVal, 'UID')
    else if (keyUpper === 'SUMMARY') current.summary = assertSafeCalendarText(rawVal, 'SUMMARY')
    else if (keyUpper === 'DESCRIPTION') current.description = assertSafeCalendarText(rawVal, 'DESCRIPTION')
    else if (keyUpper === 'LOCATION') current.location = assertSafeCalendarText(rawVal, 'LOCATION')
    else if (keyUpper === 'DTSTART') {
      if (!VALID_ICS_DATETIME_RE.test(rawVal)) return fail('VALIDATION', 'DTSTART must use ASCII iCalendar timestamp format')
      current.dtstart = rawVal
    } else if (keyUpper === 'DTEND') {
      if (!VALID_ICS_DATETIME_RE.test(rawVal)) return fail('VALIDATION', 'DTEND must use ASCII iCalendar timestamp format')
      current.dtend = rawVal
    }
  }
  if (inEvent || events.length === 0) {
    return fail('VALIDATION', 'ICS payload must contain at least one complete VEVENT')
  }
  return events
}

const renderCalendarIcs = (cal: WebmailCalendar): string => {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//xPanel//Webmail CalDAV//EN',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${cal.name}`,
    `X-WR-TIMEZONE:${cal.timezone}`,
  ]
  for (const ev of cal.events ?? []) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${ev.uid}`,
      `SUMMARY:${ev.summary}`,
      `DTSTART;TZID=${ev.timezone || cal.timezone}:${ev.dtstart}`,
      `DTEND;TZID=${ev.timezone || cal.timezone}:${ev.dtend}`,
      ...(ev.description ? [`DESCRIPTION:${ev.description}`] : []),
      ...(ev.location ? [`LOCATION:${ev.location}`] : []),
      'END:VEVENT',
    )
  }
  lines.push('END:VCALENDAR')
  return lines.join('\r\n')
}

const parseAndValidateVcards = (vcardText: string, owner: string): WebmailContact[] => {
  if (typeof vcardText !== 'string' || !vcardText.trim() || Buffer.byteLength(vcardText, 'utf8') > 256 * 1024) {
    return fail('VALIDATION', 'valid vCard content is required')
  }
  if (UNSAFE_CAL_VCARD_PATTERN.test(vcardText)) {
    return fail('VALIDATION', 'malicious or unsafe vCard payload rejected')
  }
  const lines = vcardText.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const contacts: WebmailContact[] = []
  let inCard = false
  let fullName = ''
  let email = ''
  let phone = ''
  let organization = ''
  let title = ''
  for (const line of lines) {
    if (line === 'BEGIN:VCARD') {
      if (inCard) return fail('VALIDATION', 'nested VCARD blocks are not permitted')
      inCard = true
      fullName = ''
      email = ''
      phone = ''
      organization = ''
      title = ''
      continue
    }
    if (line === 'END:VCARD') {
      if (!inCard) return fail('VALIDATION', 'unmatched END:VCARD in vCard payload')
      if (!fullName || !email || !/^[^\s@/\\]+@[^\s@/\\]+$/.test(email)) {
        return fail('VALIDATION', 'each vCard requires a valid FN and EMAIL')
      }
      const normalizedVcard = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `FN:${fullName}`,
        `EMAIL;TYPE=INTERNET:${email}`,
        ...(phone ? [`TEL;TYPE=CELL:${phone}`] : []),
        ...(organization ? [`ORG:${organization}`] : []),
        ...(title ? [`TITLE:${title}`] : []),
        'END:VCARD',
      ].join('\r\n')
      contacts.push({
        id: randomUUID(),
        owner,
        fullName,
        email,
        phone,
        organization,
        title,
        groups: [],
        shares: [],
        vcard: normalizedVcard,
        createdAt: new Date().toISOString(),
      })
      inCard = false
      continue
    }
    if (!inCard) return fail('VALIDATION', 'vCard payload must begin with BEGIN:VCARD and end with END:VCARD')
    const colonIdx = line.indexOf(':')
    if (colonIdx <= 0) return fail('VALIDATION', 'malformed vCard line')
    const prop = line.slice(0, colonIdx).split(';')[0]!.toUpperCase()
    const val = assertSafeCalendarText(line.slice(colonIdx + 1), prop)
    if (prop === 'FN') fullName = val
    else if (prop === 'EMAIL') email = val.toLowerCase()
    else if (prop === 'TEL') phone = val
    else if (prop === 'ORG') organization = val
    else if (prop === 'TITLE') title = val
  }
  if (inCard || contacts.length === 0) {
    return fail('VALIDATION', 'vCard payload must contain at least one complete VCARD')
  }
  return contacts
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
  const liveTransfers = new Map<string, TransferSession>()
  const publicPostgresUser = (user: PostgresUserRecord) => {
    const { scramHash: _credential, compiledSql: _sql, ...safe } = user
    return safe
  }
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

  const handleExtendedRoute = async (req: Request, url: URL, method: string): Promise<Response | null> => {
    const { pathname } = url

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

        const settings = await helpers.store.saveServerSettings(settingsInput)
        const primaryIpv4 = body.primaryIpv4 ?? '203.0.113.10'
        const primaryIp = await helpers.store.saveServerIp({
          address: primaryIpv4,
          version: 4,
          prefixLength: 24,
          interfaceName: 'eth0',
          role: 'shared',
          ownerKind: 'root',
          ownerId: null,
          ptrHostname: hostname,
          isPrimary: true,
          notes: 'Primary shared IPv4 configured by First-Run Setup Wizard',
        })
        if (body.primaryIpv6) {
          await helpers.store.saveServerIp({
            address: body.primaryIpv6,
            version: 6,
            prefixLength: 64,
            interfaceName: 'eth0',
            role: 'shared',
            ownerKind: 'root',
            ownerId: null,
            ptrHostname: hostname,
            isPrimary: true,
            notes: 'Primary shared IPv6 configured by First-Run Setup Wizard',
          })
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
      const list = await ext.readOrDefault<EmailForwarder[]>('mail/forwarders.json', [])
      if (method === 'GET') {
        return jsonResponse({ forwarders: await scopedRecords(caller, list) })
      }
      if (method === 'POST') {
        const body = await readJsonBody<{
          accountId?: Id
          sourceAddress?: string
          destination?: string
          destinations?: string[]
        }>(req)
        const sourceAddress = (body.sourceAddress ?? '').trim().toLowerCase()
        if (!sourceAddress.includes('@')) {
          return fail('VALIDATION', 'sourceAddress must be a valid email address')
        }
        const destinations = Array.isArray(body.destinations)
          ? body.destinations.map((d) => d.trim().toLowerCase()).filter(Boolean)
          : body.destination
            ? [body.destination.trim().toLowerCase()]
            : []
        if (destinations.length === 0) {
          return fail('VALIDATION', 'at least one destination is required')
        }
        const account = await requireDomainAccount(helpers.store, caller, sourceAddress.split('@')[1]!, 'mail.forwarder.create', body.accountId)
        const record: EmailForwarder = {
          id: randomUUID(),
          accountId: account.id,
          sourceAddress,
          destinations,
          createdAt: new Date().toISOString(),
        }
        list.push(record)
        await ext.write('mail/forwarders.json', list)
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'mail.forwarder.created',
          target: `forwarder:${sourceAddress}`,
          detail: { destinations },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ forwarder: record }, 201)
      }
      if (method === 'DELETE') {
        const body = await readJsonBody<{ id?: string }>(req)
        const targetId = fwdDeleteMatch?.[1] ?? url.searchParams.get('id') ?? body.id
        await assertRecordAccount(caller, list.find(item => item.id === targetId || item.sourceAddress === targetId), 'mail.forwarder.delete')
        const next = list.filter((item) => item.id !== targetId && item.sourceAddress !== targetId)
        await ext.write('mail/forwarders.json', next)
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'mail.forwarder.deleted',
          target: `forwarder:${String(targetId)}`,
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ ok: true })
      }
    }

    const mlDeleteMatch = /^\/api\/mail\/mailing-lists\/([^/]+)$/.exec(pathname)
    if (pathname === '/api/mail/mailing-lists' || mlDeleteMatch) {
      const caller = await helpers.requireCaller(req)
      const list = await ext.readOrDefault<MailingListRecord[]>('mail/mailing-lists.json', [])
      if (method === 'GET') {
        return jsonResponse({ mailingLists: await scopedRecords(caller, list) })
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
        }>(req)
        const address = body.address
          ? body.address.trim().toLowerCase()
          : `${(body.name ?? 'list').trim().toLowerCase()}@${(body.domain ?? 'example.com').trim().toLowerCase()}`
        const [namePart, domainPart] = address.split('@')
        if (!namePart || !domainPart) return fail('VALIDATION', 'valid mailing list address or name + domain required')
        const account = await requireDomainAccount(helpers.store, caller, validateDomainName(domainPart), 'mail.mailing_list.create', body.accountId)
        const record: MailingListRecord = {
          id: randomUUID(),
          accountId: account.id,
          name: body.name ?? namePart,
          domain: validateDomainName(domainPart),
          address,
          members: (body.members ?? []).map((m) => m.trim().toLowerCase()),
          moderation: body.moderation ?? 'members',
          archiveEnabled: body.archiveEnabled ?? true,
          createdAt: new Date().toISOString(),
        }
        list.push(record)
        await ext.write('mail/mailing-lists.json', list)
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'mail.mailing_list.created',
          target: `mailing-list:${record.address}`,
          detail: { membersCount: record.members.length },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ mailingList: record }, 201)
      }
      if (method === 'DELETE') {
        const body = await readJsonBody<{ id?: string }>(req)
        const targetId = mlDeleteMatch?.[1] ?? url.searchParams.get('id') ?? body.id
        await assertRecordAccount(caller, list.find(item => item.id === targetId || item.address === targetId), 'mail.mailing_list.delete')
        const next = list.filter((item) => item.id !== targetId && item.address !== targetId)
        await ext.write('mail/mailing-lists.json', next)
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'mail.mailing_list.deleted',
          target: `mailing-list:${String(targetId)}`,
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ ok: true })
      }
    }

    const filterDeleteMatch = /^\/api\/mail\/filters\/([^/]+)$/.exec(pathname)
    if (pathname === '/api/mail/filters' || filterDeleteMatch) {
      const caller = await helpers.requireCaller(req)
      const filters = await ext.readOrDefault<SieveFilterRule[]>('mail/filters.json', [])
      if (method === 'GET') {
        if (isMailboxPrincipal(caller)) {
          const mailbox = await requireMailbox(helpers.store, caller, url.searchParams.get('mailbox'))
          const filtered = filters.filter((f) => f.scope === 'mailbox' && f.mailbox?.toLowerCase() === mailbox)
          return jsonResponse({
            filters: filtered,
            compiledSieve: compileSieveRules(filtered),
          })
        }
        const requestedMailbox = url.searchParams.get('mailbox')
        const mailbox = requestedMailbox ? await requireMailbox(helpers.store, caller, requestedMailbox) : null
        const visible = await scopedRecords(caller, filters)
        const filtered = mailbox ? visible.filter((f) => f.mailbox === mailbox || f.scope === 'global') : visible
        return jsonResponse({
          filters: filtered,
          compiledSieve: compileSieveRules(filtered),
        })
      }
      if (method === 'POST') {
        const body = await readJsonBody<{
          accountId?: Id
          scope?: 'global' | 'mailbox'
          mailbox?: string | null
          name?: string
          priority?: number
          enabled?: boolean
          matchAll?: boolean
          conditions?: SieveFilterCondition[]
          action?: SieveFilterRule['action']
        }>(req)
        if (!body.name) return fail('VALIDATION', 'filter name is required')
        let accountId: Id
        let mailbox: string | null
        let scope: 'global' | 'mailbox'
        if (isMailboxPrincipal(caller)) {
          if (body.scope === 'global') {
            return fail('FORBIDDEN', 'mailbox principals cannot create global domain filters')
          }
          const bound = await requireMailboxPrincipalAccess(helpers.store, caller)
          if (body.accountId && body.accountId !== bound.account.id) {
            return fail('NOT_FOUND', 'account not found')
          }
          mailbox = await requireMailbox(helpers.store, caller, body.mailbox)
          accountId = bound.account.id
          scope = 'mailbox'
        } else {
          accountId = await requireAccountId(caller, body.accountId, 'mail.filter.create')
          mailbox = body.mailbox ? await requireMailbox(helpers.store, caller, body.mailbox) : null
          if (mailbox) {
            const owner = (await helpers.store.listServiceUsers(accountId)).find(user => user.login.toLowerCase() === mailbox && user.services.email)
            if (!owner) return fail('NOT_FOUND', 'mailbox not found')
          }
          scope = body.scope ?? (body.mailbox ? 'mailbox' : 'global')
        }
        const ruleBase: Omit<SieveFilterRule, 'compiledSieve'> = {
          id: randomUUID(),
          accountId,
          scope,
          mailbox,
          name: body.name,
          priority: body.priority ?? filters.length + 1,
          enabled: body.enabled ?? true,
          matchAll: body.matchAll ?? true,
          conditions: body.conditions ?? [{ field: 'subject', comparator: 'contains', value: '[SPAM]' }],
          action: body.action ?? { type: 'fileinto', target: 'Spam' },
          createdAt: new Date().toISOString(),
        }
        const singleCompiled = compileSieveRules([{ ...ruleBase, compiledSieve: '' }])
        const rule: SieveFilterRule = { ...ruleBase, compiledSieve: singleCompiled }
        filters.push(rule)
        await ext.write('mail/filters.json', filters)
        const visibleAfter = isMailboxPrincipal(caller)
          ? filters.filter((f) => f.scope === 'mailbox' && f.mailbox?.toLowerCase() === mailbox)
          : await scopedRecords(caller, filters)
        const compiledSieve = compileSieveRules(visibleAfter)
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'mail.filter.created',
          target: `sieve-filter:${rule.name}`,
          detail: { scope: rule.scope, mailbox: rule.mailbox },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ filter: rule, compiledSieve }, 201)
      }
      if (method === 'DELETE') {
        const body = await readJsonBody<{ id?: string }>(req)
        const targetId = filterDeleteMatch?.[1] ?? url.searchParams.get('id') ?? body.id
        const target = filters.find(filter => filter.id === targetId)
        if (isMailboxPrincipal(caller)) {
          if (!target) return fail('NOT_FOUND', 'resource not found')
          if (target.scope !== 'mailbox' || !target.mailbox) {
            return fail('FORBIDDEN', 'mailbox principals cannot delete global filters')
          }
          const boundMailbox = await requireMailbox(helpers.store, caller, target.mailbox)
          const next = filters.filter((f) => f.id !== targetId)
          await ext.write('mail/filters.json', next)
          await helpers.emitAudit({
            actor: caller.principal.username,
            action: 'mail.filter.deleted',
            target: `sieve-filter:${String(targetId)}`,
            outcome: 'ok',
            principalId: caller.principal.id,
          })
          return jsonResponse({
            ok: true,
            compiledSieve: compileSieveRules(next.filter((f) => f.scope === 'mailbox' && f.mailbox?.toLowerCase() === boundMailbox)),
          })
        }
        await assertRecordAccount(caller, target, 'mail.filter.delete')
        if (target?.mailbox) await requireMailbox(helpers.store, caller, target.mailbox)
        const next = filters.filter((f) => f.id !== targetId)
        await ext.write('mail/filters.json', next)
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'mail.filter.deleted',
          target: `sieve-filter:${String(targetId)}`,
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ ok: true, compiledSieve: compileSieveRules(await scopedRecords(caller, next)) })
      }
    }

    if (pathname === '/api/mail/spam-settings') {
      const caller = await helpers.requireCaller(req)
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
        const current = await ext.readOrDefault(spamKey, defaultSpam)
        const updated: SpamSettingsState = {
          ...current,
          ...body,
          updatedAt: new Date().toISOString(),
        }
        await ext.write(spamKey, updated)
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'mail.spam_settings.updated',
          target: 'mail:spam-settings',
          detail: { rejectScore: updated.rejectScore, spamBoxEnabled: updated.spamBoxEnabled },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ settings: updated })
      }
    }

    if (method === 'POST' && pathname === '/api/mail/import-csv') {
      const caller = await helpers.requireCaller(req)
      const body = await readJsonBody<{
        csv?: string
        accountId?: Id
        kind?: 'mailboxes' | 'forwarders' | 'auto'
      }>(req)
      const csvText = (body.csv ?? '').trim()
      if (!csvText) return fail('VALIDATION', 'csv content is required')

      const accountId = await requireAccountId(caller, body.accountId, 'mail.import_csv')

      const lines = csvText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('#'))

      const importedMailboxes: { email: string; quotaMb: number }[] = []
      const importedForwarders: { sourceAddress: string; destination: string }[] = []
      const errors: { row: number; error: string }[] = []
      const forwarders = await ext.readOrDefault<EmailForwarder[]>('mail/forwarders.json', [])

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        // Skip header row if it looks like "email,password,quota" or "source,destination"
        if (i === 0 && /^(email|address|username|source)\b/i.test(line)) continue
        const cols = line.split(',').map((c) => c.trim())
        const col0 = (cols[0] ?? '').toLowerCase()
        const col1 = cols[1] ?? ''
        const col2 = cols[2] ?? ''

        if (!col0.includes('@')) {
          errors.push({ row: i + 1, error: 'Invalid email address in column 1' })
          continue
        }

        const mailboxDomain = col0.split('@')[1]!
        const sourceAccount = await requireDomainAccount(helpers.store, caller, mailboxDomain, 'mail.import_csv', accountId)
        if (sourceAccount.id !== accountId) return fail('NOT_FOUND', 'mail domain not found')

        const isForwarder =
          body.kind === 'forwarders' || (body.kind !== 'mailboxes' && col1.includes('@') && !col2)

        if (isForwarder) {
          const dest = col1.toLowerCase()
          if (!dest.includes('@')) {
            errors.push({ row: i + 1, error: 'Invalid forwarder destination email' })
            continue
          }
          forwarders.push({
            id: randomUUID(),
            accountId,
            sourceAddress: col0,
            destinations: [dest],
            createdAt: new Date().toISOString(),
          })
          importedForwarders.push({ sourceAddress: col0, destination: dest })
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

      await ext.write('mail/forwarders.json', forwarders)
      await helpers.emitAudit({
        actor: caller.principal.username,
        action: 'mail.import_csv',
        target: 'mail:csv-import',
        detail: {
          mailboxesCount: importedMailboxes.length,
          forwardersCount: importedForwarders.length,
          errorsCount: errors.length,
        },
        outcome: 'ok',
        principalId: caller.principal.id,
      })
      return jsonResponse({
        ok: true,
        importedMailboxes,
        importedForwarders,
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
          const identities = await ext.readOrDefault<WebmailIdentity[]>('webmail/identities.json', [])
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

    const identityDeleteMatch = /^\/api\/webmail\/identities\/([^/]+)$/.exec(pathname)
    if (pathname === '/api/webmail/identities' || identityDeleteMatch) {
      const caller = await helpers.requireCaller(req)
      const identities = await ext.readOrDefault<WebmailIdentity[]>('webmail/identities.json', [])
      if (method === 'GET') {
        const mailbox = await requireMailbox(helpers.store, caller, url.searchParams.get('mailbox'))
        return jsonResponse({ identities: identities.filter(identity => identity.mailbox.toLowerCase() === mailbox) })
      }
      if (method === 'POST') {
        const body = await readJsonBody<Partial<WebmailIdentity>>(req)
        if (!body.email) return fail('VALIDATION', 'identity email is required')
        const mailbox = isMailboxPrincipal(caller)
          ? await requireMailbox(helpers.store, caller, body.mailbox)
          : await requireMailbox(helpers.store, caller, body.mailbox ?? body.email)
        if (body.email.toLowerCase() !== mailbox) return fail('FORBIDDEN', 'identity email must match its authorized mailbox')
        const identity: WebmailIdentity = {
          id: randomUUID(),
          mailbox,
          displayName: body.displayName ?? caller.principal.username,
          email: body.email.toLowerCase(),
          replyTo: (body.replyTo ?? body.email).toLowerCase(),
          textSignature: body.textSignature ?? '',
          htmlSignature: body.htmlSignature ?? '',
          isDefault: body.isDefault ?? !identities.some(identity => identity.mailbox.toLowerCase() === mailbox),
          createdAt: new Date().toISOString(),
        }
        identities.push(identity)
        await ext.write('webmail/identities.json', identities)
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'webmail.identity.created',
          target: `identity:${identity.email}`,
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ identity }, 201)
      }
      if (method === 'PATCH' || method === 'PUT') {
        const body = await readJsonBody<Partial<WebmailIdentity>>(req)
        const targetId = identityDeleteMatch?.[1] ?? url.searchParams.get('id') ?? body.id
        const target = identities.find(identity => identity.id === targetId)
        if (!target) return fail('NOT_FOUND', 'identity not found')
        await requireMailbox(helpers.store, caller, target.mailbox)
        if (body.mailbox && body.mailbox.toLowerCase() !== target.mailbox.toLowerCase()) {
          return fail('FORBIDDEN', 'identity mailbox cannot be changed')
        }
        if (body.email && body.email.toLowerCase() !== target.mailbox.toLowerCase()) {
          return fail('FORBIDDEN', 'identity email must match its authorized mailbox')
        }
        if (body.displayName !== undefined) target.displayName = body.displayName
        if (body.replyTo !== undefined) target.replyTo = body.replyTo.toLowerCase()
        if (body.textSignature !== undefined) target.textSignature = body.textSignature
        if (body.htmlSignature !== undefined) target.htmlSignature = body.htmlSignature
        if (body.isDefault !== undefined) target.isDefault = body.isDefault
        await ext.write('webmail/identities.json', identities)
        return jsonResponse({ identity: target })
      }
      if (method === 'DELETE') {
        const body = await readJsonBody<{ id?: string }>(req)
        const targetId = identityDeleteMatch?.[1] ?? url.searchParams.get('id') ?? body.id
        const target = identities.find(identity => identity.id === targetId)
        if (!target) return fail('NOT_FOUND', 'identity not found')
        await requireMailbox(helpers.store, caller, target.mailbox)
        const next = identities.filter((i) => i.id !== targetId)
        await ext.write('webmail/identities.json', next)
        return jsonResponse({ ok: true })
      }
    }

    if (pathname === '/api/webmail/vacation') {
      const caller = await helpers.requireCaller(req)
      const body = method === 'PUT' ? await readJsonBody<Partial<WebmailVacationConfig>>(req) : {}
      const mailbox = await requireMailbox(helpers.store, caller, body.mailbox ?? url.searchParams.get('mailbox'))
      const fileKey = `webmail/vacation/${encodeURIComponent(mailbox)}.json`
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
        return jsonResponse({ vacation: await ext.readOrDefault(fileKey, defaultVac) })
      }
      if (method === 'PUT') {
        const current = await ext.readOrDefault(fileKey, defaultVac)
        const merged = { ...current, ...body, mailbox }
        const vacation: WebmailVacationConfig = {
          ...merged,
          compiledSieve: compileVacationSieve(merged),
          updatedAt: new Date().toISOString(),
        }
        await ext.write(fileKey, vacation)
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'webmail.vacation.updated',
          target: `vacation:${vacation.mailbox}`,
          detail: { enabled: vacation.enabled },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ vacation })
      }
    }

    const calShareMatch = /^\/api\/webmail\/calendars\/([^/]+)\/share$/.exec(pathname)
    const calExportMatch = /^\/api\/webmail\/calendars\/([^/]+)\/(?:export|ics)$/.exec(pathname)
    const calImportMatch = /^\/api\/webmail\/calendars\/([^/]+)\/import$/.exec(pathname)
    const calItemMatch = /^\/api\/webmail\/calendars\/([^/]+)$/.exec(pathname)
    if (
      pathname === '/api/webmail/calendars' ||
      pathname === '/api/webmail/calendars/import' ||
      calShareMatch ||
      calExportMatch ||
      calImportMatch ||
      calItemMatch
    ) {
      const caller = await helpers.requireCaller(req)
      const calendars = await ext.readOrDefault<WebmailCalendar[]>('webmail/calendars.json', [])
      const resolveCalendarAccess = async (
        cal: WebmailCalendar,
        requestedMailbox: string | null | undefined,
        requireWrite: boolean,
      ): Promise<string> => {
        const mailbox = await requireMailbox(
          helpers.store,
          caller,
          requestedMailbox ?? (isMailboxPrincipal(caller) ? undefined : cal.owner),
        )
        if (cal.owner.toLowerCase() === mailbox) return mailbox
        const share = cal.shares.find((s) => s.principal.toLowerCase() === mailbox)
        if (!share) return fail('NOT_FOUND', `calendar "${cal.id}" not found`)
        if (requireWrite && share.permission !== 'read-write') {
          return fail('FORBIDDEN', 'calendar share is read-only')
        }
        return mailbox
      }

      if (method === 'GET' && pathname === '/api/webmail/calendars') {
        const mailbox = await requireMailbox(helpers.store, caller, url.searchParams.get('mailbox'))
        return jsonResponse({
          calendars: calendars.filter(
            (calendar) =>
              calendar.owner.toLowerCase() === mailbox ||
              calendar.shares.some((share) => share.principal.toLowerCase() === mailbox),
          ),
        })
      }
      if (method === 'POST' && pathname === '/api/webmail/calendars') {
        const body = await readJsonBody<Partial<WebmailCalendar>>(req)
        if (!body.name) return fail('VALIDATION', 'calendar name is required')
        const name = assertSafeCalendarText(body.name, 'calendar name')
        const timezone = assertValidTimezone(body.timezone ?? 'UTC')
        const owner = await requireMailbox(helpers.store, caller, body.owner ?? url.searchParams.get('mailbox'))
        const cal: WebmailCalendar = {
          id: randomUUID(),
          owner,
          name,
          color: body.color ?? 'oklch(0.65 0.18 250)',
          timezone,
          shares: [],
          events: [],
          createdAt: new Date().toISOString(),
        }
        calendars.push(cal)
        await ext.write('webmail/calendars.json', calendars)
        return jsonResponse({ calendar: cal }, 201)
      }
      if (calExportMatch && method === 'GET') {
        const calId = calExportMatch[1]!
        const cal = calendars.find((c) => c.id === calId)
        if (!cal) return fail('NOT_FOUND', `calendar "${calId}" not found`)
        await resolveCalendarAccess(cal, url.searchParams.get('mailbox'), false)
        const ics = renderCalendarIcs(cal)
        return jsonResponse({ calendarId: cal.id, ics, eventsCount: (cal.events ?? []).length })
      }
      if ((calImportMatch || pathname === '/api/webmail/calendars/import') && method === 'POST') {
        const body = await readJsonBody<{ ics?: string; mailbox?: string; calendarId?: string }>(req)
        const calId = calImportMatch?.[1] ?? body.calendarId ?? url.searchParams.get('calendarId') ?? ''
        const cal = calendars.find((c) => c.id === calId)
        if (!cal) return fail('NOT_FOUND', `calendar "${calId}" not found`)
        await resolveCalendarAccess(cal, body.mailbox ?? url.searchParams.get('mailbox'), true)
        const importedEvents = parseAndValidateIcs(body.ics ?? '', cal.timezone)
        cal.events = [...(cal.events ?? []), ...importedEvents]
        await ext.write('webmail/calendars.json', calendars)
        return jsonResponse({ calendar: cal, importedCount: importedEvents.length, events: cal.events }, 201)
      }
      if (calShareMatch && (method === 'POST' || method === 'DELETE')) {
        const calId = calShareMatch[1]!
        const cal = calendars.find((c) => c.id === calId)
        if (!cal) return fail('NOT_FOUND', `calendar "${calId}" not found`)
        const callerMailbox = await resolveCalendarAccess(cal, url.searchParams.get('mailbox'), false)
        if (cal.owner.toLowerCase() !== callerMailbox) {
          return fail('FORBIDDEN', 'only the calendar owner may modify sharing')
        }
        const ownerMailbox = cal.owner.toLowerCase()
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
        if (method === 'DELETE' || body.revoke === true || body.permission === 'none' || body.permission === 'revoke') {
          cal.shares = cal.shares.filter((s) => s.principal.toLowerCase() !== targetPrincipal)
          await ext.write('webmail/calendars.json', calendars)
          await helpers.emitAudit({
            actor: caller.principal.username,
            action: 'webmail.calendar.share_revoked',
            target: `calendar:${cal.id}`,
            detail: { principal: targetPrincipal },
            outcome: 'ok',
            principalId: caller.principal.id,
          })
          return jsonResponse({ calendar: cal })
        }
        const allUsers = (await helpers.store.readSnapshot()).serviceUsers
        const ownerUser = allUsers.find((u) => u.services.email && u.login.toLowerCase() === ownerMailbox)
        const targetUser = allUsers.find((u) => u.services.email && u.login.toLowerCase() === targetPrincipal)
        if (!ownerUser || !targetUser || targetUser.accountId !== ownerUser.accountId) {
          return fail('NOT_FOUND', 'share target mailbox not found in account')
        }
        const permission = body.permission === 'read-write' ? 'read-write' : 'read'
        const existingIdx = cal.shares.findIndex((s) => s.principal.toLowerCase() === targetPrincipal)
        const shareEntry = {
          principal: targetPrincipal,
          permission,
          sharedAt: new Date().toISOString(),
        } as const
        if (existingIdx >= 0) cal.shares[existingIdx] = shareEntry
        else cal.shares.push(shareEntry)
        await ext.write('webmail/calendars.json', calendars)
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'webmail.calendar.shared',
          target: `calendar:${cal.id}`,
          detail: { principal: shareEntry.principal, permission },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ calendar: cal })
      }
      if (calItemMatch && (method === 'PATCH' || method === 'PUT')) {
        const calId = calItemMatch[1]!
        const cal = calendars.find((c) => c.id === calId)
        if (!cal) return fail('NOT_FOUND', `calendar "${calId}" not found`)
        const body = await readJsonBody<Partial<WebmailCalendar> & { mailbox?: string }>(req)
        await resolveCalendarAccess(cal, body.mailbox ?? url.searchParams.get('mailbox'), true)
        if (body.name !== undefined) cal.name = assertSafeCalendarText(body.name, 'calendar name')
        if (body.color !== undefined) cal.color = body.color
        if (body.timezone !== undefined) cal.timezone = assertValidTimezone(body.timezone)
        if (Array.isArray(body.events)) {
          cal.events = body.events.map((ev) => ({
            id: ev.id ?? randomUUID(),
            uid: assertSafeCalendarText(ev.uid ?? randomUUID(), 'UID'),
            summary: assertSafeCalendarText(ev.summary ?? '', 'SUMMARY'),
            description: assertSafeCalendarText(ev.description ?? '', 'DESCRIPTION'),
            location: assertSafeCalendarText(ev.location ?? '', 'LOCATION'),
            dtstart: ev.dtstart,
            dtend: ev.dtend ?? ev.dtstart,
            timezone: assertValidTimezone(ev.timezone ?? cal.timezone),
          }))
        }
        await ext.write('webmail/calendars.json', calendars)
        return jsonResponse({ calendar: cal })
      }
      if (calItemMatch && method === 'DELETE') {
        const calId = calItemMatch[1]!
        const cal = calendars.find((c) => c.id === calId)
        if (!cal) return fail('NOT_FOUND', `calendar "${calId}" not found`)
        const callerMailbox = await resolveCalendarAccess(cal, url.searchParams.get('mailbox'), false)
        if (cal.owner.toLowerCase() !== callerMailbox) {
          return fail('FORBIDDEN', 'only the calendar owner may delete the calendar')
        }
        const next = calendars.filter((c) => c.id !== calId)
        await ext.write('webmail/calendars.json', next)
        return jsonResponse({ ok: true })
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
        if (contact.owner.toLowerCase() === mailbox) return mailbox
        const share = (contact.shares ?? []).find((s) => s.principal.toLowerCase() === mailbox)
        if (!share) return fail('NOT_FOUND', 'contact not found')
        if (requireWrite && share.permission !== 'read-write') {
          return fail('FORBIDDEN', 'contact share is read-only')
        }
        return mailbox
      }

      if (method === 'GET' && pathname === '/api/webmail/contacts/export') {
        const mailbox = await requireMailbox(helpers.store, caller, url.searchParams.get('mailbox'))
        const visible = contacts.filter(
          (contact) =>
            contact.owner.toLowerCase() === mailbox ||
            (contact.shares ?? []).some((s) => s.principal.toLowerCase() === mailbox),
        )
        return jsonResponse({
          mailbox,
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
        await ext.write('webmail/contacts.json', contacts)
        return jsonResponse({ contacts: imported, importedCount: imported.length }, 201)
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
          await ext.write('webmail/contacts.json', contacts)
          return jsonResponse({ contact })
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
        await ext.write('webmail/contacts.json', contacts)
        return jsonResponse({ contact })
      }
      if (method === 'GET' && pathname === '/api/webmail/contacts') {
        const mailbox = await requireMailbox(helpers.store, caller, url.searchParams.get('mailbox'))
        return jsonResponse({
          contacts: contacts.filter(
            (contact) =>
              contact.owner.toLowerCase() === mailbox ||
              (contact.shares ?? []).some((s) => s.principal.toLowerCase() === mailbox),
          ),
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
        const vcard = [
          'BEGIN:VCARD',
          'VERSION:3.0',
          `FN:${fullName}`,
          `EMAIL;TYPE=INTERNET:${email}`,
          ...(phone ? [`TEL;TYPE=CELL:${phone}`] : []),
          ...(organization ? [`ORG:${organization}`] : []),
          ...(title ? [`TITLE:${title}`] : []),
          'END:VCARD',
        ].join('\r\n')
        const contact: WebmailContact = {
          id: randomUUID(),
          owner,
          fullName,
          email,
          phone,
          organization,
          title,
          groups: body.groups ?? [],
          shares: [],
          vcard,
          createdAt: new Date().toISOString(),
        }
        contacts.push(contact)
        await ext.write('webmail/contacts.json', contacts)
        return jsonResponse({ contact }, 201)
      }
      if (contactDeleteMatch && (method === 'PATCH' || method === 'PUT')) {
        const targetId = contactDeleteMatch[1]!
        const target = contacts.find((c) => c.id === targetId)
        if (!target) return fail('NOT_FOUND', 'contact not found')
        const body = await readJsonBody<Partial<WebmailContact> & { mailbox?: string }>(req)
        await resolveContactAccess(target, body.mailbox ?? url.searchParams.get('mailbox'), true)
        if (body.fullName !== undefined) target.fullName = assertSafeCalendarText(body.fullName, 'fullName')
        if (body.email !== undefined) {
          const email = assertSafeCalendarText(body.email, 'email').toLowerCase()
          if (!/^[^\s@/\\]+@[^\s@/\\]+$/.test(email)) return fail('VALIDATION', 'email must be a valid email address')
          target.email = email
        }
        if (body.phone !== undefined) target.phone = assertSafeCalendarText(body.phone, 'phone')
        if (body.organization !== undefined) target.organization = assertSafeCalendarText(body.organization, 'organization')
        if (body.title !== undefined) target.title = assertSafeCalendarText(body.title, 'title')
        if (Array.isArray(body.groups)) target.groups = body.groups
        target.vcard = [
          'BEGIN:VCARD',
          'VERSION:3.0',
          `FN:${target.fullName}`,
          `EMAIL;TYPE=INTERNET:${target.email}`,
          ...(target.phone ? [`TEL;TYPE=CELL:${target.phone}`] : []),
          ...(target.organization ? [`ORG:${target.organization}`] : []),
          ...(target.title ? [`TITLE:${target.title}`] : []),
          'END:VCARD',
        ].join('\r\n')
        await ext.write('webmail/contacts.json', contacts)
        return jsonResponse({ contact: target })
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
        await ext.write('webmail/contacts.json', next)
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

    if (pathname === '/api/dns/cluster') {
      const caller = await helpers.requireCaller(req)
      await helpers.assertRoot(caller, 'dns.cluster')
      const defaultCluster: DnsClusterConfig = {
        enabled: false,
        provider: 'powerdns-cluster',
        nodes: [],
        cloudflareZoneMap: {},
        autoSyncOnReconcile: true,
        updatedAt: new Date().toISOString(),
      }
      if (method === 'GET') {
        return jsonResponse({ cluster: await ext.readOrDefault('dns/cluster.json', defaultCluster) })
      }
      if (method === 'PUT') {
        const body = await readJsonBody<Partial<DnsClusterConfig>>(req)
        const current = await ext.readOrDefault('dns/cluster.json', defaultCluster)
        const cluster: DnsClusterConfig = {
          ...current,
          ...body,
          updatedAt: new Date().toISOString(),
        }
        await ext.write('dns/cluster.json', cluster)
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'dns.cluster.updated',
          target: 'dns:cluster',
          detail: { provider: cluster.provider, enabled: cluster.enabled, nodesCount: cluster.nodes.length },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ cluster })
      }
    }

    // =========================================================================
    // 5. Complete Backups & Transfers (/api/backups/*, /api/transfers/*, /api/lifecycle/cpanel-import)
    // =========================================================================
    const destDeleteMatch = /^\/api\/backups\/destinations\/([^/]+)$/.exec(pathname)
    if (pathname === '/api/backups/destinations' || destDeleteMatch) {
      const caller = await helpers.requireCaller(req)
      await helpers.assertRoot(caller, 'backups.destinations')
      const destinations = await ext.readOrDefault<BackupDestination[]>('backups/destinations.json', [])
      if (method === 'GET') {
        return jsonResponse({ destinations })
      }
      if (method === 'POST') {
        const body = await readJsonBody<Partial<BackupDestination>>(req)
        if (!body.name || !body.kind) return fail('VALIDATION', 'destination name and kind are required')
        const dest: BackupDestination = {
          id: randomUUID(),
          name: body.name,
          kind: body.kind,
          endpoint: body.endpoint ?? 'https://s3.us-east-1.amazonaws.com',
          bucket: body.bucket ?? 'xpanel-backups',
          region: body.region ?? 'us-east-1',
          pathPrefix: body.pathPrefix ?? '/backups/daily',
          username: body.username ?? null,
          retentionDays: body.retentionDays ?? 30,
          enabled: body.enabled ?? true,
          createdAt: new Date().toISOString(),
        }
        destinations.push(dest)
        await ext.write('backups/destinations.json', destinations)
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'backup.destination.created',
          target: `backup-destination:${dest.name}`,
          detail: { kind: dest.kind, endpoint: dest.endpoint },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ destination: dest }, 201)
      }
      if (method === 'DELETE') {
        const body = await readJsonBody<{ id?: string }>(req)
        const targetId = destDeleteMatch?.[1] ?? url.searchParams.get('id') ?? body.id
        const next = destinations.filter((d) => d.id !== targetId)
        await ext.write('backups/destinations.json', next)
        return jsonResponse({ ok: true })
      }
    }

    if (pathname === '/api/backups/schedule') {
      const caller = await helpers.requireCaller(req)
      await helpers.assertRoot(caller, 'backups.schedule')
      const defaultSched: BackupScheduleConfig = {
        enabled: true,
        frequency: 'daily',
        cron: '0 2 * * *',
        retentionCount: 7,
        compress: 'zstd',
        includeDatabases: true,
        includeMail: true,
        selectedAccounts: 'all',
        destinationIds: [],
        updatedAt: new Date().toISOString(),
      }
      if (method === 'GET') {
        return jsonResponse({ schedule: await ext.readOrDefault('backups/schedule.json', defaultSched) })
      }
      if (method === 'PUT') {
        const body = await readJsonBody<Partial<BackupScheduleConfig>>(req)
        const current = await ext.readOrDefault('backups/schedule.json', defaultSched)
        const schedule: BackupScheduleConfig = {
          ...current,
          ...body,
          updatedAt: new Date().toISOString(),
        }
        await ext.write('backups/schedule.json', schedule)
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'backup.schedule.updated',
          target: 'backup:schedule',
          detail: { frequency: schedule.frequency, retentionCount: schedule.retentionCount },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ schedule })
      }
    }

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

    const transferPatchMatch = /^\/api\/transfers\/sessions\/([^/]+)$/.exec(pathname)
    if (pathname === '/api/transfers/sessions' || transferPatchMatch) {
      const caller = await helpers.requireCaller(req)
      await helpers.assertRoot(caller, 'transfers.sessions')
      if (method === 'GET') {
        return jsonResponse({ sessions: [...liveTransfers.values()] })
      }
      if (method === 'POST') {
        const body = await readJsonBody<{ id?: string; auth?: unknown; events?: TransferEvent[] }>(req)
        const id = body.id ?? randomUUID()
        let session = createTransferSession({
          id,
          actor: caller.principal.username,
          now: new Date().toISOString(),
          auth: (body.auth as TransferSession['auth']) ?? {
            kind: 'ssh-key',
            host: 'cpanel-source.example.com',
            port: 22,
            user: 'root',
            keyId: randomUUID(),
            hostKeyFingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          },
        })
        for (const ev of body.events ?? []) {
          session = transition(session, ev, new Date().toISOString())
        }
        liveTransfers.set(session.id, session)
        return jsonResponse({ session }, 201)
      }
      if (method === 'PATCH') {
        const body = await readJsonBody<{ id?: string; event?: TransferEvent }>(req)
        const id = transferPatchMatch?.[1] ?? body.id ?? ''
        const existing = liveTransfers.get(id)
        if (!existing) return fail('NOT_FOUND', `transfer session "${id}" not found`)
        const updated = body.event ? transition(existing, body.event, new Date().toISOString()) : existing
        liveTransfers.set(updated.id, updated)
        const review =
          updated.state === 'reviewed' || updated.state === 'applying' ? buildReview(updated) : null
        const digest = review ? reviewDigest(review) : updated.reviewDigest
        return jsonResponse({ session: updated, review, digest })
      }
    }

    if (method === 'POST' && pathname === '/api/lifecycle/cpanel-import') {
      const caller = await helpers.requireCaller(req)
      await helpers.assertRoot(caller, 'lifecycle.cpanel_import')
      const body = await readJsonBody<{
        archiveName?: string
        username?: string
        primaryDomain?: string
        planId?: Id
        contactEmail?: string
        databases?: string[]
        mailboxes?: string[]
        password?: string
        passwordHash?: string
      }>(req)
      const username = (body.username ?? 'cpmoveuser').toLowerCase()
      const primaryDomain = validateDomainName(body.primaryDomain ?? `${username}.example.com`)
      let planId = body.planId
      if (!planId) {
        const plans = await helpers.store.listPlans()
        planId = plans[0]?.id
      }
      if (!planId) return fail('PRECONDITION_FAILED', 'at least one hosting plan must exist before importing cpmove archive')

      let account = await helpers.store.getAccountByUsername(username)
      if (!account) {
        account = await helpers.store.createAccount({
          username,
          passwordHash: await passwordHashFromInput(body),
          primaryDomain,
          planId,
          ownerId: null,
          contactEmail: body.contactEmail ?? `admin@${primaryDomain}`,
          ipv4:
            (await helpers.store.listServerIps()).find((ip) => ip.version === 4)?.address ??
            '203.0.113.10',
          shell: 'jailed',
          php: {
            version: '8.3',
            handler: 'fpm',
            fpm: {
              mode: 'ondemand',
              maxChildren: 4,
              startServers: 2,
              minSpareServers: 1,
              maxSpareServers: 3,
              maxRequests: 500,
              processIdleTimeoutSec: 10,
            },
            ini: {},
          },
        })
      }

      await helpers.emitAudit({
        actor: caller.principal.username,
        action: 'lifecycle.cpanel_import',
        target: `account:${account.username}`,
        detail: { archiveName: body.archiveName ?? `cpmove-${username}.tar.gz`, primaryDomain },
        outcome: 'ok',
        principalId: caller.principal.id,
      })
      return jsonResponse({
        ok: true,
        importedAccount: account,
        archiveName: body.archiveName ?? `cpmove-${username}.tar.gz`,
      }, 201)
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
          const rules: DirectoryPrivacyRule[] = await Promise.all((body.rules ?? []).map(async (r) => ({
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
    // 7. Databases Beyond MariaDB (PostgreSQL, Remote Hosts, Maintenance/Repair, Mongo, Cache)
    // =========================================================================
    const pgUserDeleteMatch = /^\/api\/databases\/postgres\/users\/([^/]+)$/.exec(pathname)
    if (pathname === '/api/databases/postgres/users' || pgUserDeleteMatch) {
      const caller = await helpers.requireCaller(req)
      const users = await ext.readOrDefault<PostgresUserRecord[]>('databases/postgres-users.json', [])
      if (method === 'GET' && !pgUserDeleteMatch) {
        const accountIdFilter = url.searchParams.get('accountId')
        if (accountIdFilter) {
          const targetAccount = await requireResolvedAccount(caller, accountIdFilter, 'database.postgres.user.list')
          return jsonResponse({
            users: users.filter((u) => u.accountId === targetAccount.id).map(publicPostgresUser),
          })
        }
        return jsonResponse({ users: (await scopedRecords(caller, users)).map(publicPostgresUser) })
      }
      if (method === 'POST' && !pgUserDeleteMatch) {
        const body = await readJsonBody<{
          accountId?: Id
          username?: string
          password?: string
          databaseIds?: Id[]
          privileges?: PostgresUserRecord['privileges']
        }>(req)
        const account = await requireResolvedAccount(caller, body.accountId, 'database.postgres.user.create')

        const databaseIds = body.databaseIds ?? []
        if (databaseIds.length > 0) {
          const dbs = await ext.readOrDefault<PostgresDatabaseRecord[]>('databases/postgres-dbs.json', [])
          for (const dbId of databaseIds) {
            const db = dbs.find((d) => (d.id === dbId || d.name === dbId) && d.accountId === account.id)
            if (!db) {
              return fail('NOT_FOUND', `PostgreSQL database "${dbId}" not found`)
            }
          }
        }

        const rawName = (body.username ?? 'app').replace(new RegExp(`^${account.username}_`), '')
        const pgRole = `${account.username}_${rawName}`
        if (typeof body.password !== 'string' || body.password.length < 8) return fail('VALIDATION', 'a PostgreSQL password of at least 8 characters is required')
        const scramHash = `SCRAM-SHA-256$4096:${createHash('sha256').update(body.password).digest('base64')}`
        const compiledSql = `CREATE ROLE "${pgRole}" WITH LOGIN PASSWORD '${scramHash}';`
        const record: PostgresUserRecord = {
          id: randomUUID(),
          accountId: account.id,
          username: pgRole,
          databaseIds,
          privileges: body.privileges ?? ['ALL'],
          scramHash,
          compiledSql,
          createdAt: new Date().toISOString(),
        }
        await helpers.assertCanAccessAccount(caller, account, 'database.postgres.user.create')
        users.push(record)
        await ext.write('databases/postgres-users.json', users)
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'database.postgres.user.created',
          target: `pg-user:${record.username}`,
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ user: publicPostgresUser(record) }, 201)
      }
      if (method === 'DELETE') {
        const body = await readJsonBody<{ id?: string }>(req)
        const targetId = pgUserDeleteMatch?.[1] ?? url.searchParams.get('id') ?? body.id
        const targetUser = users.find((u) => u.id === targetId || u.username === targetId)
        await assertRecordAccount(caller, targetUser, 'database.postgres.user.delete')
        const next = users.filter((u) => u.id !== targetId && u.username !== targetId)
        await ext.write('databases/postgres-users.json', next)
        return jsonResponse({ ok: true })
      }
    }

    const pgDeleteMatch = /^\/api\/databases\/postgres\/([^/]+)$/.exec(pathname)
    if (pathname === '/api/databases/postgres' || pgDeleteMatch) {
      const caller = await helpers.requireCaller(req)
      const dbs = await ext.readOrDefault<PostgresDatabaseRecord[]>('databases/postgres-dbs.json', [])
      if (method === 'GET') {
        const accountIdFilter = url.searchParams.get('accountId')
        if (accountIdFilter) {
          const targetAccount = await requireResolvedAccount(caller, accountIdFilter, 'database.postgres.list')
          return jsonResponse({ databases: dbs.filter((d) => d.accountId === targetAccount.id) })
        }
        return jsonResponse({ databases: await scopedRecords(caller, dbs) })
      }
      if (method === 'POST') {
        const body = await readJsonBody<{
          accountId?: Id
          name?: string
          encoding?: string
          locale?: string
          extensions?: string[]
        }>(req)
        const account = await requireResolvedAccount(caller, body.accountId, 'database.postgres.create')

        const suffix = (body.name ?? 'app').replace(new RegExp(`^${account.username}_`), '')
        const dbName = `${account.username}_${suffix}`
        const encoding = body.encoding ?? 'UTF8'
        const locale = body.locale ?? 'en_US.UTF-8'
        const extensions = body.extensions ?? ['pg_stat_statements', 'uuid-ossp']
        const compiledSql = [
          `CREATE DATABASE "${dbName}" ENCODING '${encoding}' LC_COLLATE '${locale}' LC_CTYPE '${locale}';`,
          ...extensions.map((extName) => `CREATE EXTENSION IF NOT EXISTS "${extName}";`),
        ].join('\n')
        const record: PostgresDatabaseRecord = {
          id: randomUUID(),
          accountId: account.id,
          name: dbName,
          encoding,
          locale,
          extensions,
          compiledSql,
          createdAt: new Date().toISOString(),
        }
        await helpers.assertCanAccessAccount(caller, account, 'database.postgres.create')
        dbs.push(record)
        await ext.write('databases/postgres-dbs.json', dbs)
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'database.postgres.created',
          target: `pg-db:${record.name}`,
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ database: record }, 201)
      }
      if (method === 'DELETE') {
        const body = await readJsonBody<{ id?: string }>(req)
        const targetId = pgDeleteMatch?.[1] ?? url.searchParams.get('id') ?? body.id
        await assertRecordAccount(caller, dbs.find(database => database.id === targetId || database.name === targetId), 'database.postgres.delete')
        const next = dbs.filter((d) => d.id !== targetId && d.name !== targetId)
        await ext.write('databases/postgres-dbs.json', next)
        return jsonResponse({ ok: true })
      }
    }

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

    const mongoDeleteMatch = /^\/api\/databases\/mongo\/([^/]+)$/.exec(pathname)
    if (pathname === '/api/databases/mongo' || mongoDeleteMatch) {
      const caller = await helpers.requireCaller(req)
      await helpers.assertRoot(caller, 'database.mongo')
      const dbs = await ext.readOrDefault<MongoDatabaseRecord[]>('databases/mongo-dbs.json', [])
      if (method === 'GET' && !mongoDeleteMatch) {
        const accountIdFilter = url.searchParams.get('accountId')
        if (accountIdFilter) {
          const targetAccount = await requireResolvedAccount(caller, accountIdFilter, 'database.mongo.list')
          return jsonResponse({ databases: dbs.filter((d) => d.accountId === targetAccount.id) })
        }
        return jsonResponse({ databases: await scopedRecords(caller, dbs) })
      }
      if (method === 'POST' && !mongoDeleteMatch) {
        const body = await readJsonBody<{
          accountId?: Id
          name?: string
          username?: string
          roles?: string[]
        }>(req)
        const account = await requireResolvedAccount(caller, body.accountId, 'database.mongo.create')
        const suffix = (body.name ?? 'app').replace(new RegExp(`^${account.username}_`), '')
        const dbName = `${account.username}_${suffix}`
        const dbUser = `${account.username}_${body.username ?? suffix}`
        const record: MongoDatabaseRecord = {
          id: randomUUID(),
          accountId: account.id,
          name: dbName,
          username: dbUser,
          roles: body.roles ?? ['readWrite', 'dbAdmin'],
          connectionUri: `mongodb://${dbUser}:***@127.0.0.1:27017/${dbName}?authSource=${dbName}`,
          createdAt: new Date().toISOString(),
        }
        await helpers.assertCanAccessAccount(caller, account, 'database.mongo.create')
        dbs.push(record)
        await ext.write('databases/mongo-dbs.json', dbs)
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'database.mongo.created',
          target: `mongo:${record.name}`,
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ database: record }, 201)
      }
      if (method === 'DELETE') {
        const body = await readJsonBody<{ id?: string }>(req)
        const targetId = mongoDeleteMatch?.[1] ?? url.searchParams.get('id') ?? body.id
        await assertRecordAccount(
          caller,
          dbs.find((d) => d.id === targetId || d.name === targetId),
          'database.mongo.delete',
        )
        const next = dbs.filter((d) => d.id !== targetId && d.name !== targetId)
        await ext.write('databases/mongo-dbs.json', next)
        return jsonResponse({ ok: true })
      }
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

      if (appListMatch && method === 'GET') {
        return jsonResponse({ apps })
      }
      if (appListMatch && method === 'POST') {
        const body = await readJsonBody<Partial<InstalledAppRecord>>(req)
        const appType: AppCatalogType = body.appType ?? 'wordpress'
        const domain = validateDomainName(body.domain ?? account.primaryDomain)
        if (domain !== account.primaryDomain) {
          await requireDomainAccount(helpers.store, caller, domain, 'apps.manage', account.id)
        }
        const appPath = body.path ?? '/'
        const now = new Date().toISOString()
        const app: InstalledAppRecord = {
          id: randomUUID(),
          accountId: account.id,
          appType,
          domain,
          path: appPath,
          docRoot: `${account.home}/domains/${domain}/public_html${appPath === '/' ? '' : appPath}`,
          title: body.title ?? `${account.username} ${appType}`,
          adminUser: body.adminUser ?? 'admin',
          adminEmail: body.adminEmail ?? account.contactEmail,
          version:
            body.version ??
            (appType === 'wordpress'
              ? '6.7.2'
              : appType === 'laravel'
                ? '11.40.0'
                : appType === 'nextcloud'
                  ? '30.0.4'
                  : '1.0.0'),
          databaseName: body.databaseName ?? `${account.username}_${appType.slice(0, 4)}`,
          environment: body.environment ?? 'production',
          parentAppId: null,
          createdAt: now,
          updatedAt: now,
        }
        await helpers.assertCanAccessAccount(caller, account, 'apps.manage')
        apps.push(app)
        await ext.write(fileKey, apps)
        await helpers.emitAudit({
          actor: caller.principal.username,
          action: 'app.installed',
          target: `account:${account.username}:app:${app.appType}`,
          detail: { domain: app.domain, version: app.version },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ app }, 201)
      }
      if (appStagingMatch && method === 'POST') {
        const appId = appStagingMatch[2]!
        const verb = appStagingMatch[3]!
        const targetApp = apps.find((a) => a.id === appId)
        if (!targetApp) return fail('NOT_FOUND', `installed app "${appId}" not found`)

        if (verb === 'staging-clone') {
          const body = await readJsonBody<{ stagingDomain?: string; stagingPath?: string }>(req)
          const stagingDomain = body.stagingDomain
            ? validateDomainName(body.stagingDomain)
            : `staging.${targetApp.domain}`
          if (body.stagingDomain && stagingDomain !== account.primaryDomain && stagingDomain !== `staging.${targetApp.domain}`) {
            await requireDomainAccount(helpers.store, caller, stagingDomain, 'apps.manage', account.id)
          }
          const now = new Date().toISOString()
          const stagingApp: InstalledAppRecord = {
            ...targetApp,
            id: randomUUID(),
            domain: stagingDomain,
            path: body.stagingPath ?? '/staging',
            docRoot: `${account.home}/domains/${stagingDomain}/public_html`,
            databaseName: `${targetApp.databaseName}_stg`,
            environment: 'staging',
            parentAppId: targetApp.id,
            createdAt: now,
            updatedAt: now,
          }
          await helpers.assertCanAccessAccount(caller, account, 'apps.manage')
          apps.push(stagingApp)
          await ext.write(fileKey, apps)
          await helpers.emitAudit({
            actor: caller.principal.username,
            action: 'app.staging.cloned',
            target: `account:${account.username}:app:${stagingApp.id}`,
            detail: { sourceAppId: targetApp.id, stagingDomain },
            outcome: 'ok',
            principalId: caller.principal.id,
          })
          return jsonResponse({ ok: true, sourceApp: targetApp, stagingApp }, 201)
        }

        if (verb === 'staging-push') {
          const prodApp =
            (targetApp.parentAppId ? apps.find((a) => a.id === targetApp.parentAppId) : null) ??
            apps.find((a) => a.environment === 'production') ??
            targetApp
          const pushedAt = new Date().toISOString()
          await helpers.assertCanAccessAccount(caller, account, 'apps.manage')
          prodApp.updatedAt = pushedAt
          prodApp.version = targetApp.version
          await ext.write(fileKey, apps)
          await helpers.emitAudit({
            actor: caller.principal.username,
            action: 'app.staging.pushed',
            target: `account:${account.username}:app:${prodApp.id}`,
            detail: { stagingAppId: targetApp.id, productionAppId: prodApp.id },
            outcome: 'ok',
            principalId: caller.principal.id,
          })
          return jsonResponse({
            ok: true,
            stagingApp: targetApp,
            productionApp: prodApp,
            pushedAt,
          })
        }
      }
      if (method === 'DELETE' && !appStagingMatch) {
        const body = await readJsonBody<{ id?: string }>(req)
        const targetId = appItemMatch?.[2] ?? url.searchParams.get('id') ?? body.id
        const existing = apps.find((a) => a.id === targetId)
        if (!existing) return fail('NOT_FOUND', `installed app "${targetId ?? ''}" not found`)
        await helpers.assertCanAccessAccount(caller, account, 'apps.manage')
        const next = apps.filter((a) => a.id !== targetId)
        await ext.write(fileKey, next)
        return jsonResponse({ ok: true })
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
