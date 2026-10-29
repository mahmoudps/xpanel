import { createHash, randomUUID } from 'node:crypto'
import { fail, isXpanelError } from '@xpanel/core'
import type { WriterLease } from '@xpanel/state'
import type { ExtendedRouteHelpers, BackupDestination, BackupScheduleConfig, BackupSnapshot } from './extended-routes.ts'
import { assertBackupDestinationsReady, createBackupDestinationsWorkspaceRoutes, normalizeBackupDestinationMetadata } from './backup-destinations-workspace.ts'
import type { BackupDestinationHost, BackupLifecycleDestination } from './backup-destinations-workspace.ts'
import { backupDestinationTargetDigest } from '../../../packages/core/src/backup-destination.ts'

export type BackupWorkspaceStorageKey = 'backups/destinations.json' | 'backups/schedule.json' | 'backups/snapshots.json'
export interface WhmBackupWorkspacePorts extends Pick<ExtendedRouteHelpers, 'store' | 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  read: (key: BackupWorkspaceStorageKey) => Promise<unknown | null>
  publish: (key: Exclude<BackupWorkspaceStorageKey, 'backups/snapshots.json'>, value: unknown, lease: WriterLease) => Promise<void>
  destinationHost?: BackupDestinationHost
}
const application = { status: 'configuration_only', nativeApplied: false, remoteConnectionVerified: false, schedulerVerified: false } as const
const kinds = ['s3', 'sftp', 'rsync', 'backblaze', 'ftp', 'local'] as const
const invalid = (message: string): never => fail('VALIDATION', message, { stateChanged: false })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max: number, name: string, empty = false): string => {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || !value.isWellFormed() || /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u.test(value)) return invalid(name + ' must be bounded text without control characters')
  return value.trim()
}
const integer = (value: unknown, min: number, max: number, name: string): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid(name + ' is out of range')
const boolean = (value: unknown, name: string): boolean => typeof value === 'boolean' ? value : invalid(name + ' must be a boolean')
const id = (value: unknown): string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : invalid('invalid backup destination identity')
const date = (value: unknown): string => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : invalid('invalid saved backup timestamp')
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): void => { if (Object.keys(value).some(key => !allowed.includes(key))) invalid('unsupported backup field') }
const uniqueStrings = (value: unknown, max: number, field: string, validate: (item: unknown) => string): string[] => {
  if (!Array.isArray(value) || value.length > max) return invalid(field + ' must be a bounded array')
  const result = value.map(validate)
  if (new Set(result).size !== result.length) return invalid(field + ' may not repeat')
  return result
}
const safePath = (value: unknown, local: boolean): string => {
  const path = text(value, 1024, 'destination path')
  if (path.includes('\\') || path.split('/').some(part => part === '.' || part === '..') || local && !path.startsWith('/')) return invalid('destination path must be confined to a named absolute directory or object prefix')
  return path
}
const endpoint = (value: unknown, kind: BackupDestination['kind']): string => {
  const raw = text(value, 1024, 'destination endpoint')
  if (kind === 'local') return safePath(raw, true)
  let url: URL
  try { url = new URL(raw) } catch { return invalid('destination endpoint must be an absolute service URL') }
  const schemes = kind === 'sftp' ? ['sftp:'] : kind === 'rsync' ? ['rsync:', 'ssh:'] : kind === 'ftp' ? ['ftp:', 'ftps:'] : ['https:']
  if (!schemes.includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) return invalid('destination URL must match its service and must not contain credentials, query or fragment')
  return raw
}

export const validateBackupCron = (value: unknown): string => {
  const cron = text(value, 100, 'cron expression'), fields = cron.split(/\s+/)
  if (fields.length !== 5) return invalid('cron expression requires five UTC fields')
  const limits = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const
  fields.forEach((field, index) => {
    const [min, max] = limits[index]!
    for (const item of field.split(',')) {
      const parts = item.split('/')
      if (parts.length > 2 || parts[1] !== undefined && (!/^\d+$/.test(parts[1]) || Number(parts[1]) < 1 || Number(parts[1]) > max - min + 1)) return invalid('invalid cron step')
      if (parts[0] === '*') continue
      const range = parts[0]!.split('-')
      if (range.length > 2 || range.some(part => !/^\d+$/.test(part) || Number(part) < min || Number(part) > max) || range.length === 2 && Number(range[0]) > Number(range[1])) return invalid('invalid cron range')
    }
  })
  return fields.join(' ')
}

const destinationFields = ['name', 'kind', 'endpoint', 'bucket', 'region', 'pathPrefix', 'username', 'retentionDays', 'enabled', 'credentialRef'] as const
export function validateBackupDestination(value: unknown, saved?: Pick<BackupDestination, 'id' | 'createdAt'> & Partial<BackupLifecycleDestination>): BackupLifecycleDestination {
  if (!object(value)) return invalid('backup destination must be an object')
  onlyKeys(value, [...destinationFields, ...(saved ? ['id', 'createdAt', 'verification'] : [])])
  if (!kinds.includes(value.kind as BackupDestination['kind'])) return invalid('unsupported backup destination kind')
  const kind = value.kind as BackupDestination['kind']
  const nullable = (raw: unknown, name: string, max: number): string | null => raw === null || raw === undefined || raw === '' ? null : text(raw, max, name)
  const requestedEnabled = boolean(value.enabled ?? false, 'enabled')
  const destination: BackupLifecycleDestination = {
    id: saved?.id ?? randomUUID(), name: text(value.name, 120, 'destination name'), kind,
    endpoint: endpoint(value.endpoint ?? (kind === 's3' ? 'https://s3.us-east-1.amazonaws.com' : ''), kind),
    bucket: nullable(value.bucket, 'bucket', 255), region: nullable(value.region, 'region', 64),
    pathPrefix: safePath(value.pathPrefix ?? '/backups/daily', kind === 'local'),
    username: nullable(value.username, 'destination username', 128),
    retentionDays: integer(value.retentionDays ?? 30, 1, 3650, 'retentionDays'), enabled: saved ? requestedEnabled : false,
    createdAt: saved?.createdAt ?? new Date().toISOString(),
  }
  return normalizeBackupDestinationMetadata(value, destination, saved as BackupLifecycleDestination | undefined)
}

const scheduleFields = ['enabled', 'frequency', 'cron', 'retentionCount', 'retentionWeekly', 'retentionMonthly', 'compress', 'includeDatabases', 'includeMail', 'includeDns', 'includeControl', 'selectedAccounts', 'destinationIds'] as const
const defaults: BackupScheduleConfig = { enabled: false, frequency: 'daily', cron: '0 2 * * *', retentionCount: 7, retentionWeekly: 4, retentionMonthly: 0, compress: 'zstd', includeDatabases: true, includeMail: true, includeDns: true, includeControl: true, selectedAccounts: 'all', destinationIds: [], updatedAt: '' }
export function validateBackupSchedule(value: unknown, current: BackupScheduleConfig | null = null): BackupScheduleConfig {
  if (!object(value)) return invalid('backup schedule must be an object')
  onlyKeys(value, scheduleFields)
  const next = { ...(current ?? defaults), ...value }
  if (!['daily', 'weekly', 'monthly'].includes(next.frequency)) return invalid('invalid backup frequency')
  if (!['zstd', 'gzip'].includes(next.compress)) return invalid('invalid backup compression')
  return {
    enabled: boolean(next.enabled, 'enabled'), frequency: next.frequency, cron: validateBackupCron(next.cron),
    retentionCount: integer(next.retentionCount, 1, 3650, 'retentionCount'), retentionWeekly: integer(next.retentionWeekly, 0, 520, 'retentionWeekly'), retentionMonthly: integer(next.retentionMonthly, 0, 240, 'retentionMonthly'), compress: next.compress,
    includeDatabases: boolean(next.includeDatabases, 'includeDatabases'), includeMail: boolean(next.includeMail, 'includeMail'), includeDns: boolean(next.includeDns, 'includeDns'), includeControl: boolean(next.includeControl, 'includeControl'),
    selectedAccounts: next.selectedAccounts === 'all' ? 'all' : uniqueStrings(next.selectedAccounts, 10000, 'selectedAccounts', value => {
      const username = text(value, 64, 'account selector')
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(username) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(username)) return invalid('invalid selected account')
      return username
    }),
    destinationIds: uniqueStrings(next.destinationIds, 50, 'destinationIds', id), updatedAt: new Date().toISOString(),
  }
}

const stable = (value: unknown): string => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']' : object(value) ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}' : JSON.stringify(value) ?? 'null'
const revision = (destinations: readonly BackupDestination[], schedule: BackupScheduleConfig | null): string => createHash('sha256').update(stable({ destinations, schedule })).digest('hex')
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const readBody = async (request: Request): Promise<Record<string, unknown>> => {
  if (!request.body) return {}
  let body: unknown
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 1024 * 1024) { await reader.cancel(); return invalid('backup request exceeds the bounded JSON capacity') }; chunks.push(part.value) }
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch { return invalid('backup request must contain valid bounded JSON') }
  finally { reader.releaseLock() }
  if (!object(body)) return invalid('backup request must be an object')
  return body
}
const parseDestinations = (value: unknown): BackupLifecycleDestination[] => {
  if (value === null) return []
  if (!Array.isArray(value) || value.length > 50) return fail('PRECONDITION_FAILED', 'saved backup destination collection requires review', { stateChanged: false })
  const destinations = value.map(raw => {
    if (!object(raw)) return invalid('invalid saved destination')
    return validateBackupDestination(raw, { ...raw, id: id(raw.id), createdAt: date(raw.createdAt) } as BackupLifecycleDestination)
  })
  if (new Set(destinations.map(destination => destination.id)).size !== destinations.length || new Set(destinations.map(destination => destination.name.toLowerCase())).size !== destinations.length) return fail('PRECONDITION_FAILED', 'saved backup destinations are ambiguous', { stateChanged: false })
  return destinations
}
const parseSchedule = (value: unknown): BackupScheduleConfig | null => {
  if (value === null) return null
  if (!object(value)) return invalid('invalid saved backup schedule')
  onlyKeys(value, [...scheduleFields, 'updatedAt'])
  const { updatedAt, ...fields } = value
  return { ...validateBackupSchedule(fields), updatedAt: date(updatedAt) }
}
const snapshotMetadata = (value: unknown): unknown[] => {
  if (value === null) return []
  if (!Array.isArray(value) || value.length > 10000) return fail('PRECONDITION_FAILED', 'backup snapshot inventory requires review', { stateChanged: false })
  let totalFiles = 0, metadataBytes = 0
  return value.map(raw => {
    if (!object(raw) || !Array.isArray(raw.files) || raw.files.length > 10000 || !Array.isArray(raw.databases)) return invalid('invalid saved backup snapshot metadata')
    const snapshot = raw as unknown as BackupSnapshot
    return { id: id(snapshot.id), accountId: id(snapshot.accountId), username: text(snapshot.username, 32, 'snapshot account'), createdAt: date(snapshot.createdAt),
      sizeBytes: integer(snapshot.sizeBytes, 0, Number.MAX_SAFE_INTEGER, 'snapshot size'),
      files: snapshot.files.map(file => {
        if (!object(file)) return invalid('invalid saved snapshot file metadata')
        const path = text(file.path, 4096, 'snapshot path')
        totalFiles++; metadataBytes += Buffer.byteLength(path, 'utf8') + 64
        if (totalFiles > 25000 || metadataBytes > 4 * 1024 * 1024) return fail('PRECONDITION_FAILED', 'backup snapshot metadata exceeds the workspace read bound', { stateChanged: false })
        return { path, sizeBytes: integer(file.sizeBytes, 0, Number.MAX_SAFE_INTEGER, 'snapshot file size'), mode: integer(file.mode, 0, 0o7777, 'snapshot file mode') }
      }),
      databases: uniqueStrings(snapshot.databases, 10000, 'snapshot databases', value => text(value, 128, 'snapshot database')),
      application: { status: 'recorded_metadata', archiveVerified: false, restoreAvailable: false } }
  })
}

/** Config routes and their legacy grammar share the same writer lease and publication path. */
export function createWhmBackupWorkspaceRoutes(ports: WhmBackupWorkspacePorts) {
  const load = async () => {
    const destinations = parseDestinations(await ports.read('backups/destinations.json'))
    const schedule = parseSchedule(await ports.read('backups/schedule.json'))
    return { destinations, schedule, revision: revision(destinations, schedule) }
  }
  const lifecycle = createBackupDestinationsWorkspaceRoutes({ ...ports, load })
  return async (request: Request, url: URL, method: string): Promise<Response | null> => {
    const lifecycleResponse = await lifecycle(request, url, method)
    if (lifecycleResponse) return lifecycleResponse
    const path = url.pathname, workspace = path.startsWith('/api/backups/workspace')
    const destinationMatch = /^\/api\/backups\/(?:workspace\/)?destinations\/([^/]+)$/i.exec(path)
    const destinationsRoute = path === '/api/backups/destinations' || path === '/api/backups/workspace/destinations' || !!destinationMatch
    const scheduleRoute = path === '/api/backups/schedule' || path === '/api/backups/workspace/schedule'
    const readWorkspace = path === '/api/backups/workspace' && method === 'GET'
    if (!readWorkspace && !destinationsRoute && !scheduleRoute) return null
    let caller = await ports.requireCaller(request)
    await ports.assertRoot(caller, 'backups.configuration')
    if (workspace && url.search) return invalid('backup workspace does not accept selectors')
    if (method === 'GET') {
      const lease = await ports.store.getWriterLock().acquire()
      try {
        const fresh = await ports.requireCaller(request)
        await ports.assertRoot(fresh, 'backups.configuration')
        if (fresh.principal.id !== caller.principal.id || fresh.sessionId !== caller.sessionId || fresh.apiTokenId !== caller.apiTokenId) return fail('FORBIDDEN', 'backup authorization changed', { stateChanged: false })
        const current = await load()
        if (readWorkspace) return json({ ...current, snapshots: snapshotMetadata(await ports.read('backups/snapshots.json')), accounts: (await ports.store.listAccounts()).map(account => ({ id: account.id, username: account.username, primaryDomain: account.primaryDomain, status: account.status })), application })
        return json(destinationsRoute ? { destinations: current.destinations, revision: current.revision, application } : { schedule: current.schedule ?? defaults, persisted: current.schedule !== null, revision: current.revision, application })
      } finally { await lease.release() }
    }
    if (destinationsRoute && method !== 'POST' && method !== 'DELETE' && method !== 'PATCH' || scheduleRoute && method !== 'PUT') return json({ detail: 'method not allowed', code: 'METHOD_NOT_ALLOWED' }, 405)
    const body = await readBody(request), expected = body.expectedRevision
    if (workspace && expected === undefined) return fail('PRECONDITION_FAILED', 'expectedRevision is required', { stateChanged: false })
    if (expected !== undefined && (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected))) return invalid('expectedRevision must be a saved revision')
    const lease = await ports.store.getWriterLock().acquire()
    let writeAttempted = false
    let result: Record<string, unknown>, audit: { action: string; target: string }, status = 200
    try {
      const fresh = await ports.requireCaller(request)
      await ports.assertRoot(fresh, 'backups.configuration')
      if (fresh.principal.id !== caller.principal.id || fresh.sessionId !== caller.sessionId || fresh.apiTokenId !== caller.apiTokenId) return fail('FORBIDDEN', 'backup authorization changed', { stateChanged: false })
      caller = fresh
      const assertCurrentCaller = async (): Promise<void> => {
        const authorized = await ports.requireCaller(request)
        await ports.assertRoot(authorized, 'backups.configuration')
        if (authorized.principal.id !== caller.principal.id || authorized.sessionId !== caller.sessionId || authorized.apiTokenId !== caller.apiTokenId) return fail('FORBIDDEN', 'backup authorization changed', { stateChanged: false })
        await lease.assertFencingToken()
      }
      const current = await load()
      if (expected !== undefined && expected !== current.revision) return fail('CONFLICT', 'backup configuration changed; reload and review', { stateChanged: false })
      let destinations = current.destinations, schedule = current.schedule
      const { expectedRevision: _expected, ...draft } = body
      if (scheduleRoute) {
        schedule = validateBackupSchedule(draft, schedule)
        const accounts = await ports.store.listAccounts(), names = new Set(accounts.flatMap(account => [account.username, account.id])), destinationsById = new Map(destinations.map(destination => [destination.id, destination]))
        if (schedule.selectedAccounts !== 'all' && schedule.selectedAccounts.some(username => !names.has(username))) return invalid('selected account no longer exists')
        if (schedule.enabled && schedule.selectedAccounts !== 'all' && schedule.selectedAccounts.length === 0) return invalid('an enabled schedule requires selected accounts')
        if (schedule.destinationIds.some(identity => !destinationsById.has(identity))) return invalid('selected destination no longer exists')
        // No destinations keeps verified local archives only; every selected destination must be enabled and verified.
        if (schedule.enabled && schedule.destinationIds.some(identity => !destinationsById.get(identity)!.enabled)) return invalid('an enabled schedule requires enabled destinations')
        if (schedule.enabled && schedule.destinationIds.length) await assertBackupDestinationsReady(schedule.destinationIds.map(identity => destinationsById.get(identity)!), ports, caller)
        await assertCurrentCaller()
        await lease.assertFencingToken(); writeAttempted = true; await ports.publish('backups/schedule.json', schedule, lease)
        result = { schedule }; audit = { action: 'backup.schedule.updated', target: 'backup:schedule' }
      } else if (method === 'DELETE') {
        onlyKeys(draft, ['id'])
        const selectors = [destinationMatch?.[1], url.searchParams.get('id'), draft.id].filter(value => value !== undefined && value !== null).map(id)
        if (!selectors.length || new Set(selectors).size !== 1) return invalid('a single unambiguous destination is required')
        const target = selectors[0]!
        const found = destinations.find(destination => destination.id === target)
        if (!found) return fail('NOT_FOUND', 'backup destination not found', { stateChanged: false })
        if (schedule?.destinationIds.includes(target)) return fail('CONFLICT', 'backup destination is selected by the saved schedule', { stateChanged: false })
        destinations = destinations.filter(destination => destination.id !== target)
        await assertCurrentCaller()
        await lease.assertFencingToken(); writeAttempted = true; await ports.publish('backups/destinations.json', destinations, lease)
        result = { ok: true }; audit = { action: 'backup.destination.deleted', target: 'backup-destination:' + found.name }
      } else {
        onlyKeys(draft, destinationFields)
        const target = destinationMatch?.[1] ? id(destinationMatch[1]) : undefined
        if (method === 'PATCH' && !target) return invalid('destination selection is required')
        const previous = target ? destinations.find(destination => destination.id === target) : undefined
        if (target && !previous) return fail('NOT_FOUND', 'backup destination not found', { stateChanged: false })
        if (!previous && destinations.length >= 50) return fail('PRECONDITION_FAILED', 'backup destination capacity reached', { stateChanged: false })
        let destination = validateBackupDestination(previous ? { ...previous, ...draft } : draft, previous)
        if (previous && (backupDestinationTargetDigest(destination) !== backupDestinationTargetDigest(previous) || draft.enabled === false)) destination = { ...destination, enabled: false, verification: null }
        if (previous && destination.enabled) await assertBackupDestinationsReady([destination], ports, caller)
        if (destinations.some(item => item.id !== destination.id && item.name.toLowerCase() === destination.name.toLowerCase())) return fail('CONFLICT', 'backup destination name already exists', { stateChanged: false })
        if (!destination.enabled && schedule?.enabled && schedule.destinationIds.includes(destination.id)) return fail('CONFLICT', 'disable the saved schedule or deselect this destination first', { stateChanged: false })
        destinations = previous ? destinations.map(item => item.id === previous.id ? destination : item) : [...destinations, destination]
        await assertCurrentCaller()
        await lease.assertFencingToken(); writeAttempted = true; await ports.publish('backups/destinations.json', destinations, lease)
        result = { destination }; audit = { action: previous ? 'backup.destination.updated' : 'backup.destination.created', target: 'backup-destination:' + destination.name }; status = previous ? 200 : 201
      }
      await lease.assertFencingToken()
      result = { ...result, revision: revision(destinations, schedule), application }
    } catch (error) {
      if (writeAttempted) return fail('SERVICE_UNAVAILABLE', 'backup configuration write requires verification', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
      if (isXpanelError(error)) return fail(error.code, error.message, { ...error.detail, stateChanged: false })
      throw error
    } finally { await lease.release() }
    try { await ports.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, ...audit, outcome: 'ok' }) }
    catch { return fail('SERVICE_UNAVAILABLE', 'backup configuration audit requires verification', { stateChanged: true, verificationRequired: true, unknownOutcome: true }) }
    return json(result, status)
  }
}
