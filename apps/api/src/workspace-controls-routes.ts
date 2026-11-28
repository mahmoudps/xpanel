import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, rename, unlink } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import {
  assertRedirectTarget,
  canRenamePrimary,
  fail,
  isUuid,
  isXpanelError,
  sanitizePhpIni,
  validateDomainName,
} from '@xpanel/core'
import type { Account, Domain, Id, PhpSettings } from '@xpanel/core'
import { edge, system } from '@xpanel/render'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import { isAccountUsername } from '../../../packages/os/src/security-tools-command.ts'
import { SW_ADDON_SERVICES, swAddonService } from '../../../packages/os/src/sw-addon-command.ts'
import type { SwAddonServiceId } from '../../../packages/os/src/sw-addon-command.ts'
import { isHomeRelativePath } from './account-virus-scan-workspace.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { assertAccountFeatures, isMailboxPrincipal } from './authorization.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { httpsCovered } from './domain-force-https.ts'
import {
  assertExpectedRevision,
  exactKeys,
  panelConfigRevision,
  panelJson,
  readPanelConfigBody,
  stateConfigFile,
} from './panel-config-file.ts'
import type { PanelConfigFile } from './panel-config-file.ts'

export const PHP_INI_CONTROL_FIELDS = [
  'memory_limit',
  'upload_max_filesize',
  'post_max_size',
  'max_execution_time',
  'max_input_vars',
  'display_errors',
] as const

export const ACCOUNT_PHP_INI_EXTENDED_FIELDS = [
  ...PHP_INI_CONTROL_FIELDS,
  'date.timezone',
] as const

export const ALLOWED_DB_CHARSETS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  utf8mb4: Object.freeze(['utf8mb4_unicode_ci', 'utf8mb4_unicode_520_ci', 'utf8mb4_general_ci']),
  utf8mb3: Object.freeze(['utf8mb3_unicode_ci', 'utf8mb3_general_ci']),
  latin1: Object.freeze(['latin1_swedish_ci', 'latin1_general_ci']),
})

export const MONITORING_RING_CAPACITY = 60

const SERVER_PHP_INI_STATE = 'extended/server/php-ini-overrides.json'
const MONITORING_RING_STATE = 'extended/server/monitoring-history-ring.json'
const ADDON_CONFIG_STATE = 'extended/server/addon-services-config.json'
const AV_QUARANTINE_STATE = 'extended/server/antivirus-quarantine.json'

const SERVER_PHP_INI_NAMESPACE = 'server-php-ini:controls'
const CRON_MAILTO_NAMESPACE = 'account-cron-mailto:controls'
const DB_CHARSET_NAMESPACE = 'account-db-charset:controls'
const ADDON_CONFIG_NAMESPACE = 'addon-services-config:controls'

const MAX_FOLDER_SCAN_ENTRIES = 2000
const MAX_FOLDER_SCAN_DEPTH = 2
const MAX_FOLDER_ROWS = 12
const MAX_QUARANTINE_RECORDS = 500
const unchanged = { stateChanged: false }
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/u

export type CronDeliveryMode = 'failures' | 'always' | 'never'
export type MonitoringKind = 'traffic' | 'io'
export type AddonBindAddress = '127.0.0.1' | '::1' | '0.0.0.0'

export interface MonitoringRingSample {
  observedAt: string
  rxBps?: number | null
  txBps?: number | null
  readBps?: number | null
  writeBps?: number | null
  iops?: number | null
  summary: string
}

export interface AddonDropInConfig {
  serviceId: SwAddonServiceId
  memoryLimitMb: number
  bindAddress: AddonBindAddress
  maxConnections: number | null
}

export interface WorkspaceControlsHelpers
  extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: Pick<
    StateStore,
    | 'rootDir'
    | 'getWriterLock'
    | 'getAccount'
    | 'getAccountByUsername'
    | 'listAccounts'
    | 'getDomain'
    | 'listDomains'
    | 'updateDomain'
    | 'setDomainsForceHttps'
    | 'renameDomain'
    | 'createDomain'
    | 'listCertificates'
    | 'getDatabase'
    | 'listDatabases'
    | 'listDatabaseUsers'
    | 'getPlan'
    | 'getFeatureList'
    | 'getServerSettings'
  >
  homeBaseDir?: string
  triggerReconcile?: ExtendedRouteHelpers['triggerReconcile']
  applyServerPhpIni?: (
    caller: AuthenticatedCaller,
    version: string | null,
    ini: Record<string, string>,
  ) => Promise<Record<string, unknown>>
  readAccountFolders?: (
    caller: AuthenticatedCaller,
    account: Account,
  ) => Promise<{
    state: 'read' | 'unavailable'
    totalBytes: number | null
    truncated: boolean
    folders: Array<{ path: string; sizeBytes: number; sharePercent: number; itemCount: number }>
  }>
  readAccountDbInsights?: (
    caller: AuthenticatedCaller,
    account: Account,
  ) => Promise<{
    databases: Array<{
      name: string
      tables: number | null
      dataBytes: number | null
      indexBytes: number | null
      characterSet?: string | null
      collation?: string | null
    }>
  } | null>
  applyDatabaseCharset?: (
    caller: AuthenticatedCaller,
    account: Account,
    databaseName: string,
    charset: string,
    collation: string,
  ) => Promise<void>
  sampleMonitoring?: (caller: AuthenticatedCaller, kind: MonitoringKind) => Promise<MonitoringRingSample | null>
  applyAddonServiceConfig?: (
    caller: AuthenticatedCaller,
    serviceId: SwAddonServiceId,
    config: AddonDropInConfig,
    dropInText: string,
  ) => Promise<Record<string, unknown>>
  remediateAntivirus?: (
    caller: AuthenticatedCaller,
    action: 'quarantine' | 'delete',
    account: Account,
    relPath: string,
  ) => Promise<{ quarantinedPath?: string | null }>
  now?: () => Date
}

interface ServerPhpIniState {
  schemaVersion: 1
  version: string | null
  ini: Record<string, string>
  updatedAt: string | null
}

interface CronMailtoState {
  schemaVersion: 1
  mailto: string | null
  mode: CronDeliveryMode
  updatedAt: string | null
}

interface DbCharsetMapState {
  schemaVersion: 1
  entries: Record<string, { charset: string; collation: string; updatedAt: string }>
}

interface MonitoringRingFileState {
  schemaVersion: 1
  traffic: MonitoringRingSample[]
  io: MonitoringRingSample[]
}

interface AddonConfigMapState {
  schemaVersion: 1
  configs: Record<SwAddonServiceId, AddonDropInConfig & { updatedAt: string | null }>
}

interface QuarantineRecord {
  id: string
  account: string
  originalPath: string
  quarantinedPath: string
  quarantinedAt: string
  actor: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const sameCaller = (left: AuthenticatedCaller, right: AuthenticatedCaller): boolean =>
  left.principal.id === right.principal.id && left.sessionId === right.sessionId && left.apiTokenId === right.apiTokenId

const normalizeHome = (account: Account, homeBaseDir?: string): string => {
  if (homeBaseDir && isAccountUsername(account.username)) {
    return join(homeBaseDir, account.username)
  }
  return account.home
}

async function authorizeActiveUser(
  helpers: WorkspaceControlsHelpers,
  request: Request,
  label: string,
  toolIds: readonly string[] = [],
): Promise<{ caller: AuthenticatedCaller; account: Account }> {
  const caller = await helpers.requireCaller(request)
  if (caller.principal.kind !== 'user' || isMailboxPrincipal(caller)) {
    return fail('FORBIDDEN', `${label} requires the signed-in account owner`, unchanged)
  }
  const account = await helpers.store.getAccount(caller.principal.accountId)
  if (!account || account.id !== caller.principal.accountId || account.username !== caller.principal.username) {
    return fail('NOT_FOUND', 'account not found', unchanged)
  }
  if (account.status !== 'active') {
    return fail('FORBIDDEN', `${label} requires an active account`, unchanged)
  }
  if (toolIds.length > 0 && typeof helpers.store.getFeatureList === 'function') {
    await assertAccountFeatures(helpers.store as StateStore, caller, account, toolIds)
  }
  return { caller, account }
}

async function reconcileState(
  helpers: Pick<WorkspaceControlsHelpers, 'triggerReconcile'>,
  caller: AuthenticatedCaller,
): Promise<'requested' | 'failed' | 'not_connected' | 'unknown'> {
  if (!helpers.triggerReconcile) return 'not_connected'
  try {
    const result = await helpers.triggerReconcile(caller)
    return result === null ? 'not_connected' : result.ok ? 'requested' : 'failed'
  } catch {
    return 'unknown'
  }
}

async function resolveAccountWorkerDomain(
  helpers: WorkspaceControlsHelpers,
  account: Account,
  domainIdRaw: unknown,
): Promise<Domain> {
  const domains = await helpers.store.listDomains({ accountId: account.id })
  const owned = domains.filter(domain => domain.accountId === account.id)
  if (domainIdRaw === undefined || domainIdRaw === null || domainIdRaw === '') {
    const primary = owned.find(domain => domain.kind === 'primary') ?? owned[0]
    if (!primary) return fail('NOT_FOUND', 'no domain found for this account', unchanged)
    return primary
  }
  if (!isUuid(domainIdRaw)) return fail('VALIDATION', 'domainId must be a valid UUID', unchanged)
  const target = owned.find(domain => domain.id === domainIdRaw)
  if (!target) return fail('NOT_FOUND', 'domain not found', unchanged)
  return target
}

function parsePhpIniSubset(raw: unknown, allowedKeys: readonly string[]): Record<string, string> {
  if (!isRecord(raw)) return fail('VALIDATION', 'ini must be a JSON object', unchanged)
  const keys = Object.keys(raw)
  if (keys.length > allowedKeys.length) {
    return fail('VALIDATION', 'too many INI directives supplied', unchanged)
  }
  const cleanInput: Record<string, string> = {}
  for (const key of keys) {
    if (!allowedKeys.includes(key)) {
      return fail('VALIDATION', `INI directive ${key} is not in the workspace allowlist`, unchanged)
    }
    const val = raw[key]
    if (val === null || val === '') continue
    if (typeof val !== 'string' || val.length > 128 || UNSAFE_TEXT.test(val)) {
      return fail('VALIDATION', `${key} must be a single-line string value`, unchanged)
    }
    cleanInput[key] = val.trim()
  }
  return Object.keys(cleanInput).length > 0 ? sanitizePhpIni(cleanInput) : {}
}

function renderPhpIniSnippet(
  sectionHeader: string,
  ini: Record<string, string>,
  version: string | null,
): string {
  const lines = [
    `; xPanel managed PHP configuration${version ? ` (PHP ${version})` : ''}`,
    `[${sectionHeader}]`,
  ]
  for (const key of Object.keys(ini).sort()) {
    lines.push(`${key} = ${ini[key]}`)
  }
  if (Object.keys(ini).length === 0) {
    lines.push('; Inherit default runtime INI directives (all overrides cleared)')
  }
  return lines.join('\n')
}

function serverPhpIniFile(store: WorkspaceControlsHelpers['store']): PanelConfigFile<ServerPhpIniState> {
  return stateConfigFile(
    store,
    SERVER_PHP_INI_STATE,
    SERVER_PHP_INI_NAMESPACE,
    (raw): ServerPhpIniState | null => {
      if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.ini)) return null
      if (raw.version !== null && (typeof raw.version !== 'string' || !/^(?:7\.4|8\.[0-4])$/.test(raw.version))) return null
      try {
        const cleaned = parsePhpIniSubset(raw.ini, PHP_INI_CONTROL_FIELDS)
        const updatedAt = raw.updatedAt === null || (typeof raw.updatedAt === 'string' && Number.isFinite(Date.parse(raw.updatedAt)))
          ? (raw.updatedAt as string | null)
          : null
        return { schemaVersion: 1, version: raw.version as string | null, ini: cleaned, updatedAt }
      } catch {
        return null
      }
    },
    () => ({ schemaVersion: 1, version: '8.3', ini: {}, updatedAt: null }),
  )
}

function cronMailtoFile(store: WorkspaceControlsHelpers['store'], accountId: Id): PanelConfigFile<CronMailtoState> {
  return stateConfigFile(
    store,
    `extended/account/${accountId}/cron-mailto.json`,
    CRON_MAILTO_NAMESPACE,
    (raw): CronMailtoState | null => {
      if (!isRecord(raw) || raw.schemaVersion !== 1) return null
      if (!['failures', 'always', 'never'].includes(String(raw.mode))) return null
      if (raw.mailto !== null && (typeof raw.mailto !== 'string' || raw.mailto.length > 254)) return null
      const updatedAt = raw.updatedAt === null || (typeof raw.updatedAt === 'string' && Number.isFinite(Date.parse(raw.updatedAt)))
        ? (raw.updatedAt as string | null)
        : null
      return {
        schemaVersion: 1,
        mailto: raw.mailto as string | null,
        mode: raw.mode as CronDeliveryMode,
        updatedAt,
      }
    },
    () => ({ schemaVersion: 1, mailto: null, mode: 'never', updatedAt: null }),
  )
}

function dbCharsetFile(store: WorkspaceControlsHelpers['store'], accountId: Id): PanelConfigFile<DbCharsetMapState> {
  return stateConfigFile(
    store,
    `extended/account/${accountId}/db-collations.json`,
    DB_CHARSET_NAMESPACE,
    (raw): DbCharsetMapState | null => {
      if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.entries)) return null
      const entries: DbCharsetMapState['entries'] = {}
      for (const [dbId, entry] of Object.entries(raw.entries)) {
        if (!isUuid(dbId) || !isRecord(entry)) return null
        const charset = String(entry.charset ?? '')
        const collation = String(entry.collation ?? '')
        const allowed = ALLOWED_DB_CHARSETS[charset]
        if (!allowed || !allowed.includes(collation)) return null
        if (typeof entry.updatedAt !== 'string' || !Number.isFinite(Date.parse(entry.updatedAt))) return null
        entries[dbId] = { charset, collation, updatedAt: entry.updatedAt }
      }
      return { schemaVersion: 1, entries }
    },
    () => ({ schemaVersion: 1, entries: {} }),
  )
}

const DEFAULT_ADDON_CONFIGS = (): AddonConfigMapState => ({
  schemaVersion: 1,
  configs: {
    memcached: { serviceId: 'memcached', memoryLimitMb: 256, bindAddress: '127.0.0.1', maxConnections: 1024, updatedAt: null },
    rabbitmq: { serviceId: 'rabbitmq', memoryLimitMb: 512, bindAddress: '127.0.0.1', maxConnections: null, updatedAt: null },
    elasticsearch: { serviceId: 'elasticsearch', memoryLimitMb: 1024, bindAddress: '127.0.0.1', maxConnections: null, updatedAt: null },
    opensearch: { serviceId: 'opensearch', memoryLimitMb: 1024, bindAddress: '127.0.0.1', maxConnections: null, updatedAt: null },
  },
})

function addonConfigFile(store: WorkspaceControlsHelpers['store']): PanelConfigFile<AddonConfigMapState> {
  return stateConfigFile(
    store,
    ADDON_CONFIG_STATE,
    ADDON_CONFIG_NAMESPACE,
    (raw): AddonConfigMapState | null => {
      if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.configs)) return null
      const defaults = DEFAULT_ADDON_CONFIGS()
      const configs = { ...defaults.configs }
      for (const svc of SW_ADDON_SERVICES) {
        const entry = raw.configs[svc.id]
        if (!entry) continue
        if (!isRecord(entry)) return null
        const mem = entry.memoryLimitMb
        const bind = entry.bindAddress
        const maxConn = entry.maxConnections ?? null
        if (typeof mem !== 'number' || !Number.isSafeInteger(mem) || mem < 64 || mem > 65536) return null
        if (bind !== '127.0.0.1' && bind !== '::1' && bind !== '0.0.0.0') return null
        if (maxConn !== null && (typeof maxConn !== 'number' || !Number.isSafeInteger(maxConn) || maxConn < 16 || maxConn > 65535)) {
          return null
        }
        const updatedAt = entry.updatedAt === null || (typeof entry.updatedAt === 'string' && Number.isFinite(Date.parse(entry.updatedAt)))
          ? (entry.updatedAt as string | null)
          : null
        configs[svc.id] = {
          serviceId: svc.id,
          memoryLimitMb: mem,
          bindAddress: bind,
          maxConnections: maxConn,
          updatedAt,
        }
      }
      return { schemaVersion: 1, configs }
    },
    DEFAULT_ADDON_CONFIGS,
  )
}

function renderAddonDropIn(unit: string, cfg: AddonDropInConfig): { dropInPath: string; previewText: string } {
  const dropInPath = `/etc/systemd/system/${unit}.d/xpanel-limits.conf`
  const lines = [
    `# Managed drop-in for ${unit}`,
    '[Service]',
    `MemoryMax=${cfg.memoryLimitMb}M`,
    `Environment="XPANEL_BIND=${cfg.bindAddress}"`,
  ]
  if (cfg.maxConnections !== null) {
    lines.push(`Environment="XPANEL_MAX_CONN=${cfg.maxConnections}"`)
  }
  return { dropInPath, previewText: lines.join('\n') }
}

const CRON_MACROS: Readonly<Record<string, string>> = {
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
}

function parseCronField(expr: string, min: number, max: number, normalizeSevenToZero = false): Set<number> {
  const out = new Set<number>()
  for (const part of expr.split(',')) {
    if (!part) throw new Error('empty_cron_part')
    const slashParts = part.split('/')
    if (slashParts.length > 2) throw new Error('invalid_cron_step')
    const base = slashParts[0]!
    let step = 1
    if (slashParts.length === 2) {
      if (!/^[1-9][0-9]*$/.test(slashParts[1]!)) throw new Error('invalid_cron_step_value')
      step = Number(slashParts[1]!)
      if (step < 1 || step > max - min + 1) throw new Error('step_out_of_range')
    }
    let start = min
    let end = max
    if (base !== '*') {
      const dashParts = base.split('-')
      if (dashParts.length === 1) {
        if (!/^[0-9]+$/.test(dashParts[0]!)) throw new Error('invalid_cron_number')
        start = Number(dashParts[0]!)
        end = slashParts.length === 2 ? max : start
      } else if (dashParts.length === 2) {
        if (!/^[0-9]+$/.test(dashParts[0]!) || !/^[0-9]+$/.test(dashParts[1]!)) throw new Error('invalid_cron_range')
        start = Number(dashParts[0]!)
        end = Number(dashParts[1]!)
      } else {
        throw new Error('invalid_cron_range')
      }
    }
    const maxBound = normalizeSevenToZero ? 7 : max
    if (start < min || end > maxBound || start > end) throw new Error('cron_value_out_of_bounds')
    for (let val = start; val <= end; val += step) {
      out.add(normalizeSevenToZero && val === 7 ? 0 : val)
    }
  }
  if (out.size === 0) throw new Error('empty_cron_field')
  return out
}

/**
 * Validates a 5-field UTC cron schedule (or standard macro) and computes up to `count` upcoming UTC timestamps.
 */
export function computeCronNextRuns(scheduleRaw: string, fromDate: Date, count = 5): {
  expandedSchedule: string
  onCalendar: string[]
  nextRuns: string[]
} {
  if (typeof scheduleRaw !== 'string' || scheduleRaw.length > 128 || UNSAFE_TEXT.test(scheduleRaw)) {
    return fail('VALIDATION', 'schedule must be a bounded 5-field cron expression', unchanged)
  }
  const trimmed = scheduleRaw.trim().replace(/[ \t]+/g, ' ')
  const expandedSchedule = CRON_MACROS[trimmed.toLowerCase()] ?? trimmed
  const parts = expandedSchedule.split(' ')
  if (parts.length !== 5 || parts.some(p => !/^[0-9*,/\-]+$/.test(p))) {
    return fail('VALIDATION', 'schedule must contain 5 standard numeric cron fields (minute hour day month weekday)', unchanged)
  }

  let onCalendar: string[]
  try {
    onCalendar = system.cronToOnCalendar(expandedSchedule)
  } catch {
    return fail('VALIDATION', 'schedule cannot be translated to a valid host timer calendar', unchanged)
  }

  let minutes: Set<number>, hours: Set<number>, days: Set<number>, months: Set<number>, weekdays: Set<number>
  try {
    minutes = parseCronField(parts[0]!, 0, 59)
    hours = parseCronField(parts[1]!, 0, 23)
    days = parseCronField(parts[2]!, 1, 31)
    months = parseCronField(parts[3]!, 1, 12)
    weekdays = parseCronField(parts[4]!, 0, 6, true)
  } catch {
    return fail('VALIDATION', 'cron schedule values are out of range', unchanged)
  }

  const domWild = parts[2] === '*'
  const dowWild = parts[4] === '*'
  const targetCount = Math.min(Math.max(1, count), 10)
  const results: string[] = []
  // Step forward starting on the next whole UTC minute.
  const cursor = new Date(Math.floor(fromDate.getTime() / 60_000) * 60_000 + 60_000)
  const limitMs = cursor.getTime() + 366 * 24 * 60 * 60_000

  while (cursor.getTime() <= limitMs && results.length < targetCount) {
    const mon = cursor.getUTCMonth() + 1
    if (!months.has(mon)) {
      cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1)
      cursor.setUTCHours(0, 0, 0, 0)
      continue
    }
    const dom = cursor.getUTCDate()
    const dow = cursor.getUTCDay()
    const dayMatch = domWild && dowWild
      ? true
      : domWild
        ? weekdays.has(dow)
        : dowWild
          ? days.has(dom)
          : days.has(dom) || weekdays.has(dow)
    if (!dayMatch) {
      cursor.setUTCDate(dom + 1)
      cursor.setUTCHours(0, 0, 0, 0)
      continue
    }
    const hr = cursor.getUTCHours()
    if (!hours.has(hr)) {
      cursor.setUTCHours(hr + 1, 0, 0, 0)
      continue
    }
    const min = cursor.getUTCMinutes()
    if (minutes.has(min)) {
      results.push(cursor.toISOString())
    }
    cursor.setUTCMinutes(min + 1, 0, 0)
  }

  return { expandedSchedule, onCalendar, nextRuns: results }
}

function validateMailtoAddress(raw: unknown): string | null {
  if (raw === null || raw === '') return null
  if (typeof raw !== 'string') return fail('VALIDATION', 'mailto must be an email address or null', unchanged)
  const value = raw.trim()
  if (value === '') return null
  if (value.length > 254 || UNSAFE_TEXT.test(value) || /\s/.test(value)) {
    return fail('VALIDATION', 'mailto must be a valid single-line email address', unchanged)
  }
  const atIndex = value.indexOf('@')
  if (atIndex <= 0 || atIndex !== value.lastIndexOf('@') || atIndex >= value.length - 1) {
    return fail('VALIDATION', 'mailto must be a valid email address', unchanged)
  }
  const local = value.slice(0, atIndex)
  const domain = value.slice(atIndex + 1)
  if (local.length > 64 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    return fail('VALIDATION', 'mailto local part is invalid', unchanged)
  }
  try {
    validateDomainName(domain)
  } catch {
    return fail('VALIDATION', 'mailto domain is invalid', unchanged)
  }
  if (!domain.includes('.')) {
    return fail('VALIDATION', 'mailto domain must include a top-level label', unchanged)
  }
  return `${local}@${domain.toLowerCase()}`
}

async function scanAccountFolderUsage(homeDir: string): Promise<{
  state: 'read' | 'unavailable'
  totalBytes: number | null
  truncated: boolean
  folders: Array<{ path: string; sizeBytes: number; sharePercent: number; itemCount: number }>
}> {
  let homeStat
  try {
    homeStat = await lstat(homeDir)
  } catch {
    return { state: 'unavailable', totalBytes: null, truncated: false, folders: [] }
  }
  if (homeStat.isSymbolicLink() || !homeStat.isDirectory()) {
    return { state: 'unavailable', totalBytes: null, truncated: false, folders: [] }
  }

  let visited = 0
  let truncated = false
  let rootFilesBytes = 0
  let rootFilesCount = 0
  let totalBytes = 0
  const buckets = new Map<string, { sizeBytes: number; itemCount: number }>()

  async function walk(currentDir: string, topFolder: string | null, depth: number): Promise<void> {
    if (visited >= MAX_FOLDER_SCAN_ENTRIES) {
      truncated = true
      return
    }
    let entries
    try {
      entries = await readdir(currentDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (visited >= MAX_FOLDER_SCAN_ENTRIES) {
        truncated = true
        return
      }
      visited++
      const fullPath = join(currentDir, entry.name)
      let st
      try {
        st = await lstat(fullPath)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) continue
      if (topFolder === null) {
        if (st.isFile()) {
          rootFilesBytes += st.size
          rootFilesCount++
          totalBytes += st.size
        } else if (st.isDirectory()) {
          if (!buckets.has(entry.name)) buckets.set(entry.name, { sizeBytes: 0, itemCount: 0 })
          if (depth < MAX_FOLDER_SCAN_DEPTH) {
            await walk(fullPath, entry.name, depth + 1)
          }
        }
      } else {
        const bucket = buckets.get(topFolder)!
        if (st.isFile()) {
          bucket.sizeBytes += st.size
          bucket.itemCount++
          totalBytes += st.size
        } else if (st.isDirectory()) {
          bucket.itemCount++
          if (depth < MAX_FOLDER_SCAN_DEPTH) {
            await walk(fullPath, topFolder, depth + 1)
          }
        }
      }
    }
  }

  await walk(homeDir, null, 0)

  const list = [...buckets.entries()].map(([name, info]) => ({
    path: `~/${name}`,
    sizeBytes: info.sizeBytes,
    itemCount: info.itemCount,
  }))
  if (rootFilesCount > 0) {
    list.push({ path: '~/(root files)', sizeBytes: rootFilesBytes, itemCount: rootFilesCount })
  }
  list.sort((a, b) => b.sizeBytes - a.sizeBytes || a.path.localeCompare(b.path))
  const capped = list.slice(0, MAX_FOLDER_ROWS).map(item => ({
    ...item,
    sharePercent: totalBytes > 0 ? Math.round((item.sizeBytes / totalBytes) * 1000) / 10 : 0,
  }))
  return { state: 'read', totalBytes, truncated, folders: capped }
}

function normalizeDatabaseNameAndSql(
  account: Account,
  kind: 'create-database' | 'create-user' | 'alter-charset',
  body: Record<string, unknown>,
): { sqlPreview: string; connectionSnippet: string } {
  const prefix = `${account.username}_`
  const safeDbIdent = (raw: unknown): string => {
    if (typeof raw !== 'string' || raw.length > 64 || !raw.startsWith(prefix)) {
      return fail('VALIDATION', `databaseName must start with ${prefix} and use lowercase letters, digits, or underscores`, unchanged)
    }
    const suffix = raw.slice(prefix.length)
    if (!/^[a-z0-9][a-z0-9_]*$/.test(suffix)) {
      return fail('VALIDATION', 'databaseName contains unsupported characters', unchanged)
    }
    return raw
  }
  const safeUserIdent = (raw: unknown): string => {
    const db = safeDbIdent(raw)
    if (db.length > 32) {
      return fail('VALIDATION', 'database user names are limited to 32 characters', unchanged)
    }
    return db
  }
  const charsetRaw = body.charset === undefined ? 'utf8mb4' : String(body.charset)
  const allowedCollations = ALLOWED_DB_CHARSETS[charsetRaw]
  if (!allowedCollations) {
    return fail('VALIDATION', 'charset is not in the MariaDB workspace allowlist', unchanged)
  }
  const collationRaw = body.collation === undefined ? allowedCollations[0]! : String(body.collation)
  if (!allowedCollations.includes(collationRaw)) {
    return fail('VALIDATION', `collation ${collationRaw} is incompatible with charset ${charsetRaw}`, unchanged)
  }

  if (kind === 'create-user') {
    const user = safeUserIdent(body.username)
    const db = body.databaseName ? safeDbIdent(body.databaseName) : `${prefix}app`
    const sqlPreview = [
      `CREATE USER '${user}'@'localhost' IDENTIFIED BY '***';`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON \`${db}\`.* TO '${user}'@'localhost';`,
    ].join('\n')
    const connectionSnippet = `$pdo = new PDO('mysql:host=localhost;port=3306;dbname=${db};charset=${charsetRaw}', '${user}', $password);`
    return { sqlPreview, connectionSnippet }
  }

  const dbName = safeDbIdent(body.databaseName)
  if (kind === 'create-database') {
    return {
      sqlPreview: `CREATE DATABASE \`${dbName}\` CHARACTER SET ${charsetRaw} COLLATE ${collationRaw};`,
      connectionSnippet: `mariadb -h localhost -P 3306 -u ${account.username}_user -p ${dbName}`,
    }
  }
  return {
    sqlPreview: `ALTER DATABASE \`${dbName}\` CHARACTER SET = ${charsetRaw} COLLATE = ${collationRaw};`,
    connectionSnippet: `mariadb -h localhost -P 3306 -u ${account.username}_user -p ${dbName}`,
  }
}

async function readRingState(store: Pick<StateStore, 'rootDir'>): Promise<MonitoringRingFileState> {
  const path = join(store.rootDir, MONITORING_RING_STATE)
  const raw = await readJsonIfExists<unknown>(path).catch(() => null)
  const sanitize = (list: unknown): MonitoringRingSample[] => {
    if (!Array.isArray(list)) return []
    const out: MonitoringRingSample[] = []
    for (const item of list) {
      if (!isRecord(item) || typeof item.observedAt !== 'string' || !Number.isFinite(Date.parse(item.observedAt))) continue
      const summary = typeof item.summary === 'string' && !UNSAFE_TEXT.test(item.summary) ? item.summary.slice(0, 160) : 'sample'
      const numOrNull = (val: unknown): number | null =>
        val === undefined || val === null ? null : typeof val === 'number' && Number.isFinite(val) && val >= 0 ? val : null
      out.push({
        observedAt: item.observedAt,
        ...(item.rxBps !== undefined ? { rxBps: numOrNull(item.rxBps) } : {}),
        ...(item.txBps !== undefined ? { txBps: numOrNull(item.txBps) } : {}),
        ...(item.readBps !== undefined ? { readBps: numOrNull(item.readBps) } : {}),
        ...(item.writeBps !== undefined ? { writeBps: numOrNull(item.writeBps) } : {}),
        ...(item.iops !== undefined ? { iops: numOrNull(item.iops) } : {}),
        summary,
      })
    }
    return out.slice(-MONITORING_RING_CAPACITY)
  }
  if (!isRecord(raw) || raw.schemaVersion !== 1) {
    return { schemaVersion: 1, traffic: [], io: [] }
  }
  return {
    schemaVersion: 1,
    traffic: sanitize(raw.traffic),
    io: sanitize(raw.io),
  }
}

/** Appends a bounded sample (max 60 entries) to the server monitoring ring buffer under the writer lock. */
export async function recordMonitoringSample(
  store: Pick<StateStore, 'rootDir' | 'getWriterLock'>,
  kind: MonitoringKind,
  sample: MonitoringRingSample,
): Promise<MonitoringRingSample[]> {
  const lease = await store.getWriterLock().acquire()
  try {
    const state = await readRingState(store)
    const bucket = [...state[kind], sample].slice(-MONITORING_RING_CAPACITY)
    const next: MonitoringRingFileState = {
      schemaVersion: 1,
      traffic: kind === 'traffic' ? bucket : state.traffic,
      io: kind === 'io' ? bucket : state.io,
    }
    await lease.assertFencingToken()
    await atomicWriteJson(join(store.rootDir, MONITORING_RING_STATE), next, 0o640, async () => {
      await lease.assertFencingToken()
    })
    return bucket
  } finally {
    await lease.release()
  }
}

function normalizeTargetPath(account: Account, rawPath: unknown, homeBaseDir?: string): string {
  if (typeof rawPath !== 'string' || !rawPath.trim() || rawPath.length > 1024 || UNSAFE_TEXT.test(rawPath)) {
    return fail('VALIDATION', 'path must be a bounded file path inside the account home directory', unchanged)
  }
  const homeDir = resolve(normalizeHome(account, homeBaseDir))
  const trimmed = rawPath.trim()
  let rel = trimmed
  if (trimmed.startsWith('/')) {
    const candidate = trimmed.replaceAll('\\', '/')
    const resolvedPrefix = homeDir.replaceAll('\\', '/').replace(/\/$/, '') + '/'
    const declaredPrefix = account.home.replaceAll('\\', '/').replace(/\/$/, '') + '/'
    if (candidate.startsWith(resolvedPrefix)) {
      rel = candidate.slice(resolvedPrefix.length)
    } else if (candidate.startsWith(declaredPrefix)) {
      rel = candidate.slice(declaredPrefix.length)
    } else {
      return fail('VALIDATION', 'path must stay inside the account home directory', unchanged)
    }
  }
  if (!isHomeRelativePath(rel) || rel === '.') {
    return fail('VALIDATION', 'path must refer to a regular file below the account home directory', unchanged)
  }
  return rel
}

async function moveFileToQuarantine(
  storeRoot: string,
  account: Account,
  relPath: string,
  homeBaseDir?: string,
): Promise<string> {
  const homeDir = resolve(normalizeHome(account, homeBaseDir))
  const target = resolve(homeDir, relPath)
  if (!target.startsWith(homeDir + sep)) {
    return fail('VALIDATION', 'resolved path escaped account home', unchanged)
  }
  let st
  try {
    st = await lstat(target)
  } catch {
    return fail('NOT_FOUND', 'infected file not found on disk', unchanged)
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    return fail('PRECONDITION_FAILED', 'target must be a non-symlink regular file', unchanged)
  }
  const quarantineDir = join(storeRoot, 'extended', 'quarantine', account.username)
  await mkdir(quarantineDir, { recursive: true, mode: 0o700 })
  const safeBase = basename(relPath).replace(/[^A-Za-z0-9._-]/g, '_')
  const dest = join(quarantineDir, `${randomUUID()}-${safeBase}`)
  try {
    await rename(target, dest)
  } catch {
    await copyFile(target, dest, constants.COPYFILE_EXCL)
    await unlink(target)
  }
  return dest
}

async function deleteInfectedFile(
  account: Account,
  relPath: string,
  homeBaseDir?: string,
): Promise<void> {
  const homeDir = resolve(normalizeHome(account, homeBaseDir))
  const target = resolve(homeDir, relPath)
  if (!target.startsWith(homeDir + sep)) {
    return fail('VALIDATION', 'resolved path escaped account home', unchanged)
  }
  let st
  try {
    st = await lstat(target)
  } catch {
    return fail('NOT_FOUND', 'infected file not found on disk', unchanged)
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    return fail('PRECONDITION_FAILED', 'target must be a non-symlink regular file', unchanged)
  }
  await unlink(target)
}

/**
 * Handles bounded workspace control endpoints for PHP INI preview/apply, resource folder breakdown,
 * cron preview/mailto, domain TLS/Force-HTTPS/redirect/primary rename, MariaDB charset/SQL preview,
 * monitoring history ring buffer, add-on service drop-in configuration, and antivirus remediation.
 */
export async function handleWorkspaceControlsRoute(
  request: Request,
  url: URL,
  method: string,
  helpers: WorkspaceControlsHelpers,
): Promise<Response | null> {
  const now = helpers.now?.() ?? new Date()
  const p = url.pathname

  // ---------------------------------------------------------------------------
  // 1a. Host PHP INI read / preview / apply (root-only)
  // ---------------------------------------------------------------------------
  if (p === '/api/server/php/ini' || p === '/api/server/php/ini/preview' || p === '/api/server/php/ini/apply') {
    const isRead = p === '/api/server/php/ini'
    const expectedMethod = isRead ? 'GET' : 'POST'
    const caller = await helpers.requireCaller(request)
    await helpers.assertRoot(caller, isRead ? 'server.php.read' : 'server.php.modify')
    if (method !== expectedMethod) return new Response(null, { status: 405, headers: { allow: expectedMethod } })
    if (url.search) return fail('VALIDATION', 'server PHP INI endpoint accepts no query selectors', unchanged)

    const file = serverPhpIniFile(helpers.store)
    if (isRead) {
      const { raw, value } = await file.read()
      const current = value ?? { schemaVersion: 1 as const, version: '8.3', ini: {}, updatedAt: null }
      return panelJson({
        version: current.version,
        ini: current.ini,
        previewText: renderPhpIniSnippet('PHP', current.ini, current.version),
        revision: panelConfigRevision(file.namespace, raw),
        updatedAt: current.updatedAt,
      })
    }

    const body = await readPanelConfigBody(request)
    if (!isRecord(body)) return fail('VALIDATION', 'request body must be a JSON object', unchanged)
    for (const key of Object.keys(body)) {
      if (!['version', 'ini', 'expectedRevision'].includes(key)) {
        return fail('VALIDATION', `unsupported field: ${key}`, unchanged)
      }
    }
    let version: string | null = '8.3'
    if (body.version !== undefined && body.version !== null) {
      if (typeof body.version !== 'string' || !/^(?:7\.4|8\.[0-4])$/.test(body.version)) {
        return fail('VALIDATION', 'version must be a supported PHP minor version (7.4 or 8.0-8.4)', unchanged)
      }
      version = body.version
    }
    const cleanIni = parsePhpIniSubset(body.ini, PHP_INI_CONTROL_FIELDS)
    const previewText = renderPhpIniSnippet('PHP', cleanIni, version)

    if (p === '/api/server/php/ini/preview') {
      const { raw } = await file.read()
      return panelJson({
        version,
        ini: cleanIni,
        previewText,
        revision: panelConfigRevision(file.namespace, raw),
        stateChanged: false,
      })
    }

    if (typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedRevision)) {
      return fail('VALIDATION', 'expectedRevision must be the current 64-char hex revision', unchanged)
    }
    const saved = await file.write(
      { schemaVersion: 1, version, ini: cleanIni, updatedAt: now.toISOString() },
      body.expectedRevision,
      async () => {
        const fresh = await helpers.requireCaller(request)
        await helpers.assertRoot(fresh, 'server.php.modify')
        if (!sameCaller(caller, fresh)) {
          return fail('FORBIDDEN', 'authority changed during server PHP INI update', unchanged)
        }
      },
    )
    let hostApply: Record<string, unknown> | null = null
    if (helpers.applyServerPhpIni) {
      hostApply = await helpers.applyServerPhpIni(caller, version, cleanIni)
    }
    const reconcile = await reconcileState(helpers, caller)
    await helpers.emitAudit({
      actor: caller.principal.username,
      action: 'server.php.ini.updated',
      target: `php:${version ?? 'default'}`,
      detail: { directives: Object.keys(cleanIni).sort(), reconcile },
      outcome: 'ok',
      principalId: caller.principal.id,
    })
    return panelJson({
      version: saved.value.version,
      ini: saved.value.ini,
      previewText,
      revision: panelConfigRevision(file.namespace, saved.raw),
      updatedAt: saved.value.updatedAt,
      stateChanged: true,
      reconcile,
      ...(hostApply ? { hostApply } : {}),
    })
  }

  // ---------------------------------------------------------------------------
  // 1b. Account PHP INI read / preview / apply (account owner)
  // ---------------------------------------------------------------------------
  if (p === '/api/account/php/ini' || p === '/api/account/php/ini/preview' || p === '/api/account/php/ini/apply') {
    const isRead = p === '/api/account/php/ini'
    const expectedMethod = isRead ? 'GET' : 'POST'
    if (method !== expectedMethod) return new Response(null, { status: 405, headers: { allow: expectedMethod } })
    const { caller, account } = await authorizeActiveUser(helpers, request, 'PHP INI configuration', ['multiphp-ini-editor'])
    if (isRead) {
      const domainIdParam = url.searchParams.get('domainId')
      for (const key of url.searchParams.keys()) {
        if (key !== 'domainId') return fail('VALIDATION', 'only optional domainId is accepted', unchanged)
      }
      const domain = await resolveAccountWorkerDomain(helpers, account, domainIdParam)
      return panelJson({
        domainId: domain.id,
        domainName: domain.name,
        version: domain.php.version,
        ini: domain.php.ini,
        previewText: renderPhpIniSnippet('PHP', domain.php.ini, domain.php.version),
      })
    }
    if (url.search) return fail('VALIDATION', 'account PHP INI mutations accept no query selectors', unchanged)
    const body = await readPanelConfigBody(request)
    if (!isRecord(body)) return fail('VALIDATION', 'request body must be a JSON object', unchanged)
    for (const key of Object.keys(body)) {
      if (!['domainId', 'ini'].includes(key)) return fail('VALIDATION', `unsupported field: ${key}`, unchanged)
    }
    const domain = await resolveAccountWorkerDomain(helpers, account, body.domainId)
    const plan = await helpers.store.getPlan(account.planId)
    const cleanSubset = parsePhpIniSubset(body.ini, ACCOUNT_PHP_INI_EXTENDED_FIELDS)
    const mergedIni: Record<string, string> = { ...domain.php.ini }
    const rawIni = body.ini as Record<string, unknown>
    for (const key of Object.keys(rawIni)) {
      if (rawIni[key] === '' || rawIni[key] === null) delete mergedIni[key]
      else if (Object.hasOwn(cleanSubset, key)) mergedIni[key] = cleanSubset[key]!
    }
    const validatedAll = Object.keys(mergedIni).length > 0
      ? sanitizePhpIni(mergedIni, plan ? { maxMemoryMb: plan.resources.memoryMb } : {})
      : {}
    const previewText = renderPhpIniSnippet('PHP', validatedAll, domain.php.version)

    if (p === '/api/account/php/ini/preview') {
      return panelJson({
        domainId: domain.id,
        domainName: domain.name,
        version: domain.php.version,
        ini: validatedAll,
        previewText,
        stateChanged: false,
      })
    }

    const nextPhp: PhpSettings = { ...domain.php, ini: validatedAll }
    await helpers.store.updateDomain(domain.id, { php: nextPhp })
    const reconcile = await reconcileState(helpers, caller)
    await helpers.emitAudit({
      actor: caller.principal.username,
      action: 'account.php.ini.updated',
      target: `domain:${domain.name}`,
      detail: { domainId: domain.id, directives: Object.keys(validatedAll).sort(), reconcile },
      outcome: 'ok',
      principalId: caller.principal.id,
    })
    return panelJson({
      domainId: domain.id,
      domainName: domain.name,
      version: domain.php.version,
      ini: validatedAll,
      previewText,
      stateChanged: true,
      reconcile,
    })
  }

  // ---------------------------------------------------------------------------
  // 2. Account folder usage breakdown (bounded tenant-isolated directory scan)
  // ---------------------------------------------------------------------------
  if (p === '/api/account/resources/folders') {
    if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
    if (url.search) return fail('VALIDATION', 'folder usage does not accept path or account selectors', unchanged)
    const { caller, account } = await authorizeActiveUser(helpers, request, 'Resource folder breakdown', ['resource-usage'])
    const breakdown = helpers.readAccountFolders
      ? await helpers.readAccountFolders(caller, account)
      : await scanAccountFolderUsage(normalizeHome(account, helpers.homeBaseDir))
    return panelJson({
      observedAt: now.toISOString(),
      account: { username: account.username },
      state: breakdown.state,
      totalBytes: breakdown.totalBytes,
      truncated: breakdown.truncated,
      folders: breakdown.folders,
    })
  }

  // ---------------------------------------------------------------------------
  // 3. Cron next-runs preview & MAILTO save/clear
  // ---------------------------------------------------------------------------
  if (p === '/api/account/cron/preview') {
    if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
    if (url.search) return fail('VALIDATION', 'cron preview accepts no query selectors', unchanged)
    await authorizeActiveUser(helpers, request, 'Cron schedule preview', ['cron-jobs'])
    const body = await readPanelConfigBody(request)
    if (!isRecord(body)) return fail('VALIDATION', 'request body must be a JSON object', unchanged)
    for (const key of Object.keys(body)) {
      if (!['schedule', 'count'].includes(key)) return fail('VALIDATION', `unsupported field: ${key}`, unchanged)
    }
    const count = body.count === undefined
      ? 5
      : typeof body.count === 'number' && Number.isSafeInteger(body.count) && body.count >= 1 && body.count <= 10
        ? body.count
        : fail('VALIDATION', 'count must be a whole number from 1 to 10', unchanged)
    const computed = computeCronNextRuns(String(body.schedule ?? ''), now, count)
    return panelJson({
      schedule: String(body.schedule ?? '').trim(),
      ...computed,
      timezone: 'UTC',
      stateChanged: false,
    })
  }

  if (p === '/api/account/cron/mailto') {
    if (method !== 'GET' && method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'GET, PUT' } })
    if (url.search) return fail('VALIDATION', 'cron mailto accepts no query selectors', unchanged)
    const { caller, account } = await authorizeActiveUser(helpers, request, 'Cron output email', ['cron-jobs'])
    const file = cronMailtoFile(helpers.store, account.id)
    if (method === 'GET') {
      const { raw, value } = await file.read()
      const current = value ?? { schemaVersion: 1 as const, mailto: null, mode: 'never' as const, updatedAt: null }
      return panelJson({
        mailto: current.mailto,
        mode: current.mode,
        updatedAt: current.updatedAt,
        revision: panelConfigRevision(file.namespace, raw),
      })
    }
    const body = await readPanelConfigBody(request)
    if (!isRecord(body)) return fail('VALIDATION', 'request body must be a JSON object', unchanged)
    for (const key of Object.keys(body)) {
      if (!['mailto', 'mode', 'expectedRevision'].includes(key)) return fail('VALIDATION', `unsupported field: ${key}`, unchanged)
    }
    const mailto = validateMailtoAddress(body.mailto ?? null)
    const { raw: currentRaw, value: currentVal } = await file.read()
    const currentRevision = panelConfigRevision(file.namespace, currentRaw)
    if (body.expectedRevision !== undefined) {
      if (assertExpectedRevision(body.expectedRevision) !== currentRevision) {
      return fail('CONFLICT', 'the configuration changed; reload before saving', unchanged)
    }
    }
    const mode: CronDeliveryMode = body.mode === undefined
      ? (mailto === null ? 'never' : currentVal?.mode === 'always' ? 'always' : 'failures')
      : ['failures', 'always', 'never'].includes(String(body.mode))
        ? (body.mode as CronDeliveryMode)
        : fail('VALIDATION', 'mode must be failures, always, or never', unchanged)
    if (mailto !== null && mode === 'never' && body.mode === 'never') {
      // Saving an address with explicit 'never' clears active delivery intent cleanly
    }
    const nextState: CronMailtoState = {
      schemaVersion: 1,
      mailto,
      mode: mailto === null ? 'never' : mode,
      updatedAt: now.toISOString(),
    }
    const saved = await file.write(nextState, currentRevision, async () => {
      const fresh = await authorizeActiveUser(helpers, request, 'Cron output email', ['cron-jobs'])
      if (fresh.account.id !== account.id || !sameCaller(caller, fresh.caller)) {
        return fail('FORBIDDEN', 'account authority changed before saving cron mailto', unchanged)
      }
    })
    const reconcile = await reconcileState(helpers, caller)
    await helpers.emitAudit({
      actor: caller.principal.username,
      action: mailto ? 'account.cron.mailto_updated' : 'account.cron.mailto_cleared',
      target: `account:${account.username}`,
      detail: { mode: saved.value.mode, hasAddress: mailto !== null, reconcile },
      outcome: 'ok',
      principalId: caller.principal.id,
    })
    return panelJson({
      mailto: saved.value.mailto,
      mode: saved.value.mode,
      updatedAt: saved.value.updatedAt,
      revision: panelConfigRevision(file.namespace, saved.raw),
      stateChanged: true,
      reconcile,
    })
  }

  // ---------------------------------------------------------------------------
  // 4. Domain TLS certificate inspect, Force-HTTPS, redirect, & primary rename
  // ---------------------------------------------------------------------------
  const domainMatch = /^\/api\/account\/domains\/([0-9a-f-]{36})\/(certificate|force-https|redirect)$/.exec(p)
  if (domainMatch) {
    const [, domainId, op] = domainMatch
    const expectedMethod = op === 'certificate' ? 'GET' : op === 'force-https' ? 'POST' : 'PUT'
    if (method !== expectedMethod) return new Response(null, { status: 405, headers: { allow: expectedMethod } })
    if (url.search) return fail('VALIDATION', 'domain action accepts no query selectors', unchanged)
    const { caller, account } = await authorizeActiveUser(helpers, request, 'Domain management', ['domains'])
    const domain = await helpers.store.getDomain(domainId!)
    if (!domain || domain.accountId !== account.id) {
      return fail('NOT_FOUND', 'domain not found', unchanged)
    }

    if (op === 'certificate') {
      const certificates = await helpers.store.listCertificates(account.id)
      const matched = edge.certForName(domain.name, domain, domain, certificates)
      const cert = matched ? certificates.find(c => c.id === matched.id) ?? null : null
      const covered = !!cert && Date.parse(cert.notAfter) > now.getTime()
      const issuerLabel = cert
        ? cert.source === 'acme'
          ? 'ACME'
          : cert.source === 'upload'
            ? 'Uploaded certificate'
            : 'Self-signed'
        : null
      return panelJson({
        domainId: domain.id,
        domainName: domain.name,
        forceHttps: domain.forceHttps === true,
        covered,
        certificate: cert
          ? {
              id: cert.id,
              source: cert.source,
              issuer: issuerLabel,
              names: cert.names,
              notBefore: cert.notBefore,
              notAfter: cert.notAfter,
            }
          : null,
      })
    }

    const body = await readPanelConfigBody(request)
    if (!isRecord(body)) return fail('VALIDATION', 'request body must be a JSON object', unchanged)

    if (op === 'force-https') {
      if (!exactKeys(body, ['enabled']) || typeof body.enabled !== 'boolean') {
        return fail('VALIDATION', 'request body must be { enabled: boolean }', unchanged)
      }
      if (domain.kind === 'alias') {
        return fail('VALIDATION', 'an alias follows the domain it points at', unchanged)
      }
      if (body.enabled) {
        const certs = await helpers.store.listCertificates(account.id)
        if (!httpsCovered(domain, certs, now)) {
          return fail('PRECONDITION_FAILED', 'a valid certificate must cover the domain first', {
            ...unchanged,
            reason: 'cert_required',
          })
        }
      }
      await helpers.store.setDomainsForceHttps(account.id, [domain.id], body.enabled)
      const reconcile = await reconcileState(helpers, caller)
      await helpers.emitAudit({
        actor: caller.principal.username,
        action: 'account.domain.force_https_updated',
        target: `domain:${domain.name}`,
        detail: { domainId: domain.id, enabled: body.enabled, reconcile },
        outcome: 'ok',
        principalId: caller.principal.id,
      })
      return panelJson({
        domainId: domain.id,
        domainName: domain.name,
        forceHttps: body.enabled,
        stateChanged: true,
        reconcile,
      })
    }

    // op === 'redirect'
    for (const key of Object.keys(body)) {
      if (!['to', 'code'].includes(key)) return fail('VALIDATION', `unsupported field: ${key}`, unchanged)
    }
    if (domain.kind === 'alias') {
      return fail('PRECONDITION_FAILED', 'aliases inherit redirect configuration from their parent domain', unchanged)
    }
    let redirect: Domain['redirect'] = null
    if (body.to !== null && body.to !== '' && body.to !== undefined) {
      const target = assertRedirectTarget(body.to)
      const code = body.code === undefined ? 301 : body.code
      if (code !== 301 && code !== 302) {
        return fail('VALIDATION', 'redirect code must be 301 or 302', unchanged)
      }
      redirect = { to: target, code }
    }
    await helpers.store.updateDomain(domain.id, { redirect })
    const reconcile = await reconcileState(helpers, caller)
    await helpers.emitAudit({
      actor: caller.principal.username,
      action: 'account.domain.redirect_updated',
      target: `domain:${domain.name}`,
      detail: { domainId: domain.id, redirect, reconcile },
      outcome: 'ok',
      principalId: caller.principal.id,
    })
    return panelJson({
      domainId: domain.id,
      domainName: domain.name,
      redirect,
      stateChanged: true,
      reconcile,
    })
  }

  if (p === '/api/account/domains/rename-primary') {
    if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
    if (url.search) return fail('VALIDATION', 'primary domain rename accepts no query selectors', unchanged)
    const { caller, account } = await authorizeActiveUser(helpers, request, 'Primary domain rename', ['domains'])
    const body = await readPanelConfigBody(request)
    if (!isRecord(body)) return fail('VALIDATION', 'request body must be a JSON object', unchanged)
    for (const key of Object.keys(body)) {
      if (!['newDomain', 'confirmCurrentDomain', 'keepOldAsAlias'].includes(key)) {
        return fail('VALIDATION', `unsupported field: ${key}`, unchanged)
      }
    }
    const newRaw = typeof body.newDomain === 'string' ? body.newDomain.trim().toLowerCase() : ''
    const confirmRaw = typeof body.confirmCurrentDomain === 'string' ? body.confirmCurrentDomain.trim().toLowerCase() : ''
    if (!newRaw || !confirmRaw) {
      return fail('VALIDATION', 'newDomain and confirmCurrentDomain are required', unchanged)
    }
    if (confirmRaw !== account.primaryDomain.toLowerCase()) {
      return fail('VALIDATION', 'confirmCurrentDomain must match your current primary domain', unchanged)
    }
    const allDomains = await helpers.store.listDomains({})
    const primary = allDomains.find(d => d.accountId === account.id && d.kind === 'primary')
    if (!primary) return fail('NOT_FOUND', 'primary domain record not found', unchanged)
    const planCheck = canRenamePrimary(account, newRaw, allDomains)
    if (!planCheck.ok || !planCheck.name) {
      return fail('CONFLICT', `cannot rename primary domain: ${planCheck.reasons.join('; ')}`, {
        ...unchanged,
        reasons: planCheck.reasons,
      })
    }
    const previousPrimary = account.primaryDomain
    const renamed = await helpers.store.renameDomain(primary.id, planCheck.name)
    let aliasCreated: Domain | null = null
    if (body.keepOldAsAlias === true) {
      try {
        aliasCreated = await helpers.store.createDomain({
          accountId: account.id,
          name: previousPrimary,
          kind: 'alias',
          parentId: renamed.id,
          docRoot: primary.docRoot,
          siteType: primary.siteType,
          upstream: null,
          redirect: null,
          php: primary.php,
          wildcard: false,
          certificateId: null,
          suspended: false,
          expiresAt: null,
          pathQuotaMb: primary.pathQuotaMb,
        })
      } catch (error) {
        if (isXpanelError(error)) {
          // Primary already renamed; return truthful partial detail without hiding alias error
          const reconcile = await reconcileState(helpers, caller)
          await helpers.emitAudit({
            actor: caller.principal.username,
            action: 'account.domain.primary_renamed',
            target: `account:${account.username}`,
            detail: { from: previousPrimary, to: renamed.name, aliasCreated: false, aliasError: error.message, reconcile },
            outcome: 'ok',
            principalId: caller.principal.id,
          })
          return panelJson({
            previousDomain: previousPrimary,
            primaryDomain: renamed.name,
            subdomainRenames: planCheck.subdomainRenames,
            aliasCreated: null,
            aliasWarning: error.message,
            stateChanged: true,
            reconcile,
          })
        }
        throw error
      }
    }
    const reconcile = await reconcileState(helpers, caller)
    await helpers.emitAudit({
      actor: caller.principal.username,
      action: 'account.domain.primary_renamed',
      target: `account:${account.username}`,
      detail: { from: previousPrimary, to: renamed.name, aliasCreated: !!aliasCreated, reconcile },
      outcome: 'ok',
      principalId: caller.principal.id,
    })
    return panelJson({
      previousDomain: previousPrimary,
      primaryDomain: renamed.name,
      subdomainRenames: planCheck.subdomainRenames,
      aliasCreated: aliasCreated ? { id: aliasCreated.id, name: aliasCreated.name } : null,
      stateChanged: true,
      reconcile,
    })
  }

  // ---------------------------------------------------------------------------
  // 5. MariaDB charset/collation, bounded inspect, & SQL preview
  // ---------------------------------------------------------------------------
  if (p === '/api/account/databases/inspect') {
    if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
    if (url.search) return fail('VALIDATION', 'database inspect accepts no query selectors', unchanged)
    const { caller, account } = await authorizeActiveUser(helpers, request, 'Database inspection', ['mysql-databases'])
    const [dbs, users, charsetState, insights] = await Promise.all([
      helpers.store.listDatabases(account.id, { includeTrashed: false }),
      helpers.store.listDatabaseUsers(account.id),
      dbCharsetFile(helpers.store, account.id).read(),
      helpers.readAccountDbInsights ? helpers.readAccountDbInsights(caller, account).catch(() => null) : Promise.resolve(null),
    ])
    const savedMap = charsetState.value?.entries ?? {}
    const insightByName = new Map((insights?.databases ?? []).map(item => [item.name, item]))
    const rows = dbs
      .filter(db => db.accountId === account.id && db.trashedAt === null)
      .map(db => {
        const saved = savedMap[db.id]
        const live = insightByName.get(db.name)
        const grantCount = users.filter(u => u.grants.some(g => g.databaseId === db.id)).length
        const sizeBytes = live && live.dataBytes !== null && live.indexBytes !== null
          ? live.dataBytes + live.indexBytes
          : null
        return {
          id: db.id,
          name: db.name,
          charset: saved?.charset ?? live?.characterSet ?? 'utf8mb4',
          collation: saved?.collation ?? live?.collation ?? 'utf8mb4_unicode_ci',
          tableCount: live?.tables ?? null,
          sizeBytes,
          grantCount,
        }
      })
    return panelJson({
      observedAt: now.toISOString(),
      prefix: `${account.username}_`,
      connectionHost: 'localhost:3306',
      allowedCharsets: ALLOWED_DB_CHARSETS,
      databases: rows,
    })
  }

  if (p === '/api/account/databases/sql-preview') {
    if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
    if (url.search) return fail('VALIDATION', 'SQL preview accepts no query selectors', unchanged)
    const { account } = await authorizeActiveUser(helpers, request, 'Database SQL preview', ['mysql-databases'])
    const body = await readPanelConfigBody(request)
    if (!isRecord(body)) return fail('VALIDATION', 'request body must be a JSON object', unchanged)
    for (const key of Object.keys(body)) {
      if (!['kind', 'databaseName', 'username', 'charset', 'collation'].includes(key)) {
        return fail('VALIDATION', `unsupported field: ${key}`, unchanged)
      }
    }
    const kind = body.kind
    if (kind !== 'create-database' && kind !== 'create-user' && kind !== 'alter-charset') {
      return fail('VALIDATION', 'kind must be create-database, create-user, or alter-charset', unchanged)
    }
    const preview = normalizeDatabaseNameAndSql(account, kind, body)
    return panelJson({
      kind,
      ...preview,
      stateChanged: false,
    })
  }

  const dbCharsetMatch = /^\/api\/account\/databases\/([0-9a-f-]{36})\/charset$/.exec(p)
  if (dbCharsetMatch) {
    if (method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'PUT' } })
    if (url.search) return fail('VALIDATION', 'database charset update accepts no query selectors', unchanged)
    const { caller, account } = await authorizeActiveUser(helpers, request, 'Database charset update', ['mysql-databases'])
    const db = await helpers.store.getDatabase(dbCharsetMatch[1]!)
    if (!db || db.accountId !== account.id || db.trashedAt !== null) {
      return fail('NOT_FOUND', 'database not found', unchanged)
    }
    const body = await readPanelConfigBody(request)
    if (!isRecord(body) || !exactKeys(body, ['charset', 'collation'])) {
      return fail('VALIDATION', 'request body must be { charset, collation }', unchanged)
    }
    const charset = typeof body.charset === 'string' ? body.charset.trim() : ''
    const collation = typeof body.collation === 'string' ? body.collation.trim() : ''
    const allowed = ALLOWED_DB_CHARSETS[charset]
    if (!allowed || !allowed.includes(collation)) {
      return fail('VALIDATION', 'charset and collation must be a valid pair from the allowlist', unchanged)
    }
    const file = dbCharsetFile(helpers.store, account.id)
    const { raw, value } = await file.read()
    const currentEntries = value?.entries ?? {}
    const nextState: DbCharsetMapState = {
      schemaVersion: 1,
      entries: {
        ...currentEntries,
        [db.id]: { charset, collation, updatedAt: now.toISOString() },
      },
    }
    await file.write(nextState, panelConfigRevision(file.namespace, raw), async () => {
      const fresh = await authorizeActiveUser(helpers, request, 'Database charset update', ['mysql-databases'])
      if (fresh.account.id !== account.id || !sameCaller(caller, fresh.caller)) {
        return fail('FORBIDDEN', 'account authority changed during database charset update', unchanged)
      }
    })
    if (helpers.applyDatabaseCharset) {
      await helpers.applyDatabaseCharset(caller, account, db.name, charset, collation)
    }
    const reconcile = await reconcileState(helpers, caller)
    const sqlPreview = `ALTER DATABASE \`${db.name}\` CHARACTER SET = ${charset} COLLATE = ${collation};`
    await helpers.emitAudit({
      actor: caller.principal.username,
      action: 'account.database.charset_updated',
      target: `database:${db.name}`,
      detail: { databaseId: db.id, charset, collation, reconcile },
      outcome: 'ok',
      principalId: caller.principal.id,
    })
    return panelJson({
      databaseId: db.id,
      name: db.name,
      charset,
      collation,
      sqlPreview,
      stateChanged: true,
      reconcile,
    })
  }

  // ---------------------------------------------------------------------------
  // 6. Server monitoring bounded ring-buffer history (traffic | io)
  // ---------------------------------------------------------------------------
  if (p === '/api/server/monitoring/history') {
    const caller = await helpers.requireCaller(request)
    await helpers.assertRoot(caller, 'server.monitoring.read')
    if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
    const kindParam = url.searchParams.get('kind')
    for (const key of url.searchParams.keys()) {
      if (key !== 'kind') return fail('VALIDATION', 'only kind=traffic|io is accepted', unchanged)
    }
    if (kindParam !== 'traffic' && kindParam !== 'io') {
      return fail('VALIDATION', 'kind query parameter must be traffic or io', unchanged)
    }
    if (helpers.sampleMonitoring) {
      const sampled = await helpers.sampleMonitoring(caller, kindParam).catch(() => null)
      if (sampled) {
        const samples = await recordMonitoringSample(helpers.store, kindParam, sampled)
        return panelJson({
          kind: kindParam,
          capacity: MONITORING_RING_CAPACITY,
          count: samples.length,
          observedAt: now.toISOString(),
          samples,
        })
      }
    }
    const ring = await readRingState(helpers.store)
    const samples = ring[kindParam]
    return panelJson({
      kind: kindParam,
      capacity: MONITORING_RING_CAPACITY,
      count: samples.length,
      observedAt: now.toISOString(),
      samples,
    })
  }

  // ---------------------------------------------------------------------------
  // 7. Add-on services reviewed drop-in configuration preview & apply
  // ---------------------------------------------------------------------------
  if (p === '/api/server/software/addon-services/config') {
    const caller = await helpers.requireCaller(request)
    const isRead = method === 'GET'
    await helpers.assertRoot(caller, isRead ? 'server.addon_services.read' : 'server.addon_services.configure')
    if (method !== 'GET' && method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
    if (url.search) return fail('VALIDATION', 'add-on service configuration accepts no query selectors', unchanged)

    const file = addonConfigFile(helpers.store)
    if (isRead) {
      const { raw, value } = await file.read()
      const current = value ?? DEFAULT_ADDON_CONFIGS()
      const services = SW_ADDON_SERVICES.map(svc => {
        const cfg = current.configs[svc.id]
        const rendered = renderAddonDropIn(svc.unit, cfg)
        return {
          serviceId: svc.id,
          name: svc.name,
          unit: svc.unit,
          memoryLimitMb: cfg.memoryLimitMb,
          bindAddress: cfg.bindAddress,
          maxConnections: cfg.maxConnections,
          updatedAt: cfg.updatedAt ?? null,
          dropInPath: rendered.dropInPath,
          previewText: rendered.previewText,
        }
      })
      return panelJson({
        revision: panelConfigRevision(file.namespace, raw),
        services,
      })
    }

    const body = await readPanelConfigBody(request)
    if (!isRecord(body)) return fail('VALIDATION', 'request body must be a JSON object', unchanged)
    for (const key of Object.keys(body)) {
      if (!['mode', 'serviceId', 'memoryLimitMb', 'bindAddress', 'maxConnections', 'expectedRevision'].includes(key)) {
        return fail('VALIDATION', `unsupported field: ${key}`, unchanged)
      }
    }
    const opMode = body.mode
    if (opMode !== 'preview' && opMode !== 'apply') {
      return fail('VALIDATION', 'mode must be preview or apply', unchanged)
    }
    const service = swAddonService(body.serviceId)
    if (!service) return fail('VALIDATION', 'serviceId must be a listed add-on service', unchanged)
    const memoryLimitMb = body.memoryLimitMb
    if (typeof memoryLimitMb !== 'number' || !Number.isSafeInteger(memoryLimitMb) || memoryLimitMb < 64 || memoryLimitMb > 65536) {
      return fail('VALIDATION', 'memoryLimitMb must be an integer from 64 to 65536', unchanged)
    }
    const bindAddress = body.bindAddress
    if (bindAddress !== '127.0.0.1' && bindAddress !== '::1' && bindAddress !== '0.0.0.0') {
      return fail('VALIDATION', 'bindAddress must be 127.0.0.1, ::1, or 0.0.0.0', unchanged)
    }
    let maxConnections: number | null = null
    if (body.maxConnections !== undefined && body.maxConnections !== null && body.maxConnections !== '') {
      if (typeof body.maxConnections !== 'number' || !Number.isSafeInteger(body.maxConnections) || body.maxConnections < 16 || body.maxConnections > 65535) {
        return fail('VALIDATION', 'maxConnections must be null or an integer from 16 to 65535', unchanged)
      }
      maxConnections = body.maxConnections
    }
    const nextCfg: AddonDropInConfig = {
      serviceId: service.id,
      memoryLimitMb,
      bindAddress,
      maxConnections,
    }
    const { dropInPath, previewText } = renderAddonDropIn(service.unit, nextCfg)

    if (opMode === 'preview') {
      const { raw } = await file.read()
      return panelJson({
        mode: 'preview',
        serviceId: service.id,
        unit: service.unit,
        dropInPath,
        previewText,
        config: nextCfg,
        revision: panelConfigRevision(file.namespace, raw),
        stateChanged: false,
      })
    }

    const { raw: currentRaw, value: currentValue } = await file.read()
    const currentRevision = panelConfigRevision(file.namespace, currentRaw)
    if (assertExpectedRevision(body.expectedRevision) !== currentRevision) {
      return fail('CONFLICT', 'the configuration changed; reload before saving', unchanged)
    }
    const baseState = currentValue ?? DEFAULT_ADDON_CONFIGS()
    const nextMap: AddonConfigMapState = {
      schemaVersion: 1,
      configs: {
        ...baseState.configs,
        [service.id]: { ...nextCfg, updatedAt: now.toISOString() },
      },
    }
    const saved = await file.write(nextMap, currentRevision, async () => {
      const fresh = await helpers.requireCaller(request)
      await helpers.assertRoot(fresh, 'server.addon_services.configure')
      if (!sameCaller(caller, fresh)) {
        return fail('FORBIDDEN', 'authority changed during add-on service configuration save', unchanged)
      }
    })
    let hostApply: Record<string, unknown> | null = null
    if (helpers.applyAddonServiceConfig) {
      hostApply = await helpers.applyAddonServiceConfig(caller, service.id, nextCfg, previewText)
    }
    const reconcile = await reconcileState(helpers, caller)
    await helpers.emitAudit({
      actor: caller.principal.username,
      action: 'server.addon_service.config_updated',
      target: service.unit,
      detail: { serviceId: service.id, memoryLimitMb, bindAddress, maxConnections, reconcile },
      outcome: 'ok',
      principalId: caller.principal.id,
    })
    return panelJson({
      mode: 'apply',
      serviceId: service.id,
      unit: service.unit,
      dropInPath,
      previewText,
      config: saved.value.configs[service.id],
      revision: panelConfigRevision(file.namespace, saved.raw),
      stateChanged: true,
      reconcile,
      ...(hostApply ? { hostApply } : {}),
    })
  }

  // ---------------------------------------------------------------------------
  // 8. Antivirus quarantine & delete remediation (root-only)
  // ---------------------------------------------------------------------------
  if (p === '/api/server/security-tools/antivirus/quarantine' || p === '/api/server/security-tools/antivirus/delete') {
    const action = p.endsWith('/quarantine') ? 'quarantine' : 'delete'
    const caller = await helpers.requireCaller(request)
    await helpers.assertRoot(caller, 'server.security_tools.antivirus_remediate')
    if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
    if (url.search) return fail('VALIDATION', 'antivirus remediation accepts no query selectors', unchanged)

    const body = await readPanelConfigBody(request)
    if (!isRecord(body)) return fail('VALIDATION', 'request body must be a JSON object', unchanged)
    for (const key of Object.keys(body)) {
      if (!['account', 'path'].includes(key)) return fail('VALIDATION', `unsupported field: ${key}`, unchanged)
    }
    if (!isAccountUsername(body.account)) {
      return fail('VALIDATION', 'account must be a valid account username', unchanged)
    }
    const account = await helpers.store.getAccountByUsername(body.account)
    if (!account) return fail('NOT_FOUND', 'account not found', unchanged)
    const relPath = normalizeTargetPath(account, body.path, helpers.homeBaseDir)

    let quarantinedPath: string | null = null
    if (helpers.remediateAntivirus) {
      const res = await helpers.remediateAntivirus(caller, action, account, relPath)
      quarantinedPath = res.quarantinedPath ?? null
    } else if (action === 'quarantine') {
      quarantinedPath = await moveFileToQuarantine(helpers.store.rootDir, account, relPath, helpers.homeBaseDir)
    } else {
      await deleteInfectedFile(account, relPath, helpers.homeBaseDir)
    }

    if (action === 'quarantine' && quarantinedPath) {
      const lease = await helpers.store.getWriterLock().acquire()
      try {
        const qPath = join(helpers.store.rootDir, AV_QUARANTINE_STATE)
        const existing = await readJsonIfExists<unknown>(qPath).catch(() => [])
        const list = Array.isArray(existing) ? existing : []
        const entry: QuarantineRecord = {
          id: randomUUID(),
          account: account.username,
          originalPath: relPath,
          quarantinedPath,
          quarantinedAt: now.toISOString(),
          actor: caller.principal.username,
        }
        const nextList = [...list, entry].slice(-MAX_QUARANTINE_RECORDS)
        await lease.assertFencingToken()
        await atomicWriteJson(qPath, nextList, 0o600, async () => {
          await lease.assertFencingToken()
        })
      } finally {
        await lease.release()
      }
    }

    await helpers.emitAudit({
      actor: caller.principal.username,
      action: action === 'quarantine'
        ? 'server.security_tools.antivirus_quarantined'
        : 'server.security_tools.antivirus_deleted',
      target: `account:${account.username}`,
      detail: {
        account: account.username,
        path: relPath,
        ...(quarantinedPath ? { quarantinedPath } : {}),
      },
      outcome: 'ok',
      principalId: caller.principal.id,
    })

    return panelJson({
      action,
      account: account.username,
      path: relPath,
      ...(quarantinedPath ? { quarantinedPath } : {}),
      observedAt: now.toISOString(),
      stateChanged: true,
    })
  }

  return null
}
