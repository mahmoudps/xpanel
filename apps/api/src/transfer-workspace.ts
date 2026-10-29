import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fail, isUuid, isXpanelError } from '@xpanel/core'
import { atomicWriteJson, isStateDirectoryDurabilityError, readJsonIfExists } from '@xpanel/state'
import { buildReview, countActiveTransfers, createTransferSession, parseTransferAuth, reviewDigest, transition } from '@xpanel/lifecycle'
import type { AccountProgress, ImportWarning, TransferAuth, TransferEvent, TransferReview, TransferSession } from '@xpanel/lifecycle'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import type { AuthenticatedCaller } from './auth.ts'

type Helpers = Pick<ExtendedRouteHelpers, 'store' | 'requireCaller' | 'assertRoot' | 'emitAudit'>
type LocalInventory = NonNullable<TransferSession['local']>
type EventEnvelope = { at: string; event: TransferEvent }
export type TransferProgressEvent = Extract<TransferEvent, { type: 'progress' }>
/** What one account brought here, or how its failure was handled; shown per account on the run step. */
export interface TransferAccountResult {
  domains: string[]
  droppedDomains: string[]
  databases: string[]
  databaseUsers: number
  mailboxes: number
  zones: string[]
  cronJobs: number
  php: string[]
  plan: string
  home: { bytes: number; compared: boolean }
  certificates: number
  rolledBack: boolean
  rollbackFailed?: boolean
  /** Set once this run created the account here; restart recovery removes only this identity. */
  createdAccountId?: string
}
export interface StoredTransferWorkspace {
  id: string
  actor: string
  createdAt: string
  auth: TransferAuth
  events: EventEnvelope[]
  /** principal that started the run; background work and restart recovery act as this root user */
  runBy?: string
  stopRequestedAt?: string | null
  results?: Record<string, Partial<TransferAccountResult>>
}
export type CpanelImportState = 'uploading' | 'fetching' | 'inspecting' | 'review' | 'importing' | 'imported' | 'failed'
/** One item the import does not carry over as-is: Skipped (not imported), Partial, Paused (imported, inactive) or Reset (owner must set a new password). */
export interface CpanelUnmappedItem { tag: 'skipped' | 'partial' | 'paused' | 'reset'; code: string; message: string; path?: string }
export interface CpanelImportRecord {
  id: string
  origin: 'upload' | 'ssh'
  filename: string
  source: string | null
  actor: string
  createdAt: string
  updatedAt: string
  state: CpanelImportState
  task: string | null
  targetUsername: string | null
  bytes: number | null
  /** bytes of an upload stored so far; the file on disk is the authority, this is what the last chunk reported */
  received?: number
  sha256: string | null
  plan: Record<string, unknown> | null
  conflicts: Array<{ kind: 'username' | 'domain'; value: string }>
  unmapped: CpanelUnmappedItem[]
  result: Record<string, unknown> | null
  error: string | null
  /** The account this import created; a rollback removes only this identity, never an account that merely shares the username. */
  createdAccountId?: string | null
}
interface WorkspaceDocument { version: 1; sessions: StoredTransferWorkspace[]; cpanelImports: CpanelImportRecord[] }
export interface CpanelImportPorts {
  /** <state root>/extended/transfers/cpanel: uploads land here; the host reads them from the same path */
  uploadDir: string
  maxBytes: number
  startTask: (caller: AuthenticatedCaller, body: Record<string, unknown>) => Promise<string>
  readTask: (caller: AuthenticatedCaller, id: string) => Promise<{ state: string; result: Record<string, unknown> | null; error: string | null }>
  /** Builds the account from the reviewed plan and restores its data; a failure removes the partial account and rethrows. */
  apply: (caller: AuthenticatedCaller, record: CpanelImportRecord, input: { planId: string; onCreated?: (accountId: string) => Promise<void> }) => Promise<Record<string, unknown>>
  /** Removes the partial account (its recorded createdAccountId) left by an import the API stopped during. */
  recover: (caller: AuthenticatedCaller, record: CpanelImportRecord) => Promise<boolean>
  discard: (caller: AuthenticatedCaller, record: CpanelImportRecord) => Promise<void>
  sshKey: (caller: AuthenticatedCaller) => Promise<{ publicKey: string; fingerprint: string }>
}
export interface TransferWorkspacePorts {
  /** Trusted server adapter; source identity/inventory must follow pinned authenticated discovery. */
  discover?: (caller: AuthenticatedCaller, auth: TransferAuth) => Promise<{
    source: { hostname: string; version: string }
    accounts: NonNullable<TransferSession['inventory']>['accounts']
    plans: NonNullable<TransferSession['inventory']>['plans']
  }>
  /** Native transfer execution: per account it reports each phase through emit before the next one starts. */
  execution?: {
    admit: (caller: AuthenticatedCaller, session: TransferSession, review: TransferReview) => Promise<void>
    run: (caller: AuthenticatedCaller, session: TransferSession, review: TransferReview, emit: (event: TransferProgressEvent, result?: Partial<TransferAccountResult>) => Promise<void>, shouldStop: () => Promise<boolean>) => Promise<void>
    /** Rolls back the account this run created (result.createdAccountId) when the API stopped mid-account; true when it was removed. */
    recover: (caller: AuthenticatedCaller, progress: AccountProgress, result: Partial<TransferAccountResult> | undefined) => Promise<boolean>
  }
  /** Root principal by id, for background work after the request that started it has ended. */
  callerFor?: (principalId: string) => Promise<AuthenticatedCaller | null>
  cpanel?: CpanelImportPorts
}

const MAX_SESSIONS = 500
const MAX_IMPORTS = 100
const MAX_EVENTS = 5000
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024
/** One upload chunk (raw bytes; base64 in JSON stays under the 8 MiB body limit of its route) for a slow link within the request timeout. */
export const CPANEL_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024
const IN_FLIGHT: ReadonlySet<AccountProgress['phase']> = new Set(['exporting', 'copying', 'importing', 'reconciling'])
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const exact = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) return fail('VALIDATION', 'unsupported transfer workspace fields', { stateChanged: false })
  return value
}
const json = (value: unknown, status = 200): Response => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
const requestBody = async (req: Request): Promise<Record<string, unknown>> => {
  if (req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON transfer workspace body is required', { stateChanged: false })
  try { const body: unknown = await req.json(); if (!object(body)) return fail('VALIDATION', 'transfer workspace body must be an object', { stateChanged: false }); return body }
  catch (error) { if (error instanceof SyntaxError) return fail('VALIDATION', 'invalid transfer workspace JSON', { stateChanged: false }); throw error }
}
const replay = (record: StoredTransferWorkspace): TransferSession => {
  if (!object(record) || !Array.isArray(record.events) || record.events.length > MAX_EVENTS) return fail('PRECONDITION_FAILED', 'stored transfer event log requires inspection', { stateChanged: false })
  let session = createTransferSession({ id: record.id, actor: record.actor, now: record.createdAt, auth: record.auth })
  for (const envelope of record.events) {
    if (!object(envelope) || typeof envelope.at !== 'string' || !object(envelope.event)) return fail('PRECONDITION_FAILED', 'stored transfer event log requires inspection', { stateChanged: false })
    session = transition(session, envelope.event as TransferEvent, envelope.at)
  }
  return session
}
const append = (record: StoredTransferWorkspace, event: TransferEvent): StoredTransferWorkspace => {
  if (record.events.length >= MAX_EVENTS) return fail('PRECONDITION_FAILED', 'transfer event capacity reached', { stateChanged: false })
  const next = { ...record, events: [...record.events, { at: new Date().toISOString(), event: structuredClone(event) }] }
  replay(next)
  return next
}
const readDocument = async (path: string): Promise<WorkspaceDocument> => {
  const value = await readJsonIfExists<Record<string, unknown>>(path)
  if (value === null) return { version: 1, sessions: [], cpanelImports: [] }
  const imports = value.cpanelImports ?? []
  if (!object(value) || value.version !== 1 || !Array.isArray(value.sessions) || value.sessions.length > MAX_SESSIONS || !Array.isArray(imports) || imports.length > MAX_IMPORTS || Buffer.byteLength(JSON.stringify(value)) > MAX_DOCUMENT_BYTES) {
    return fail('PRECONDITION_FAILED', 'stored transfer workspace requires inspection', { stateChanged: false })
  }
  const ids = new Set<string>()
  for (const record of value.sessions as StoredTransferWorkspace[]) { replay(record); if (ids.has(record.id)) return fail('PRECONDITION_FAILED', 'stored transfer session identity repeats', { stateChanged: false }); ids.add(record.id) }
  // the earlier review-only archive list is not carried over (clean cutover)
  return { version: 1, sessions: value.sessions as StoredTransferWorkspace[], cpanelImports: imports as CpanelImportRecord[] }
}
const workspacePath = (store: { readonly rootDir: string }): string => join(store.rootDir, 'extended', 'transfers', 'workspace.json')

/** Read the same durable reducer state for upgrade admission; corruption must never become zero. */
export const countPersistedActiveTransfers = async (store: { readonly rootDir: string }): Promise<number> => {
  const document = await readDocument(workspacePath(store))
  return countActiveTransfers(document.sessions.map(replay)) + document.cpanelImports.filter(item => item.state === 'importing').length
}

const inventory = async (helpers: Helpers): Promise<LocalInventory> => {
  const [accounts, domains, plans] = await Promise.all([helpers.store.listAccounts(), helpers.store.listDomains(), helpers.store.listPlans()])
  return { usernames: accounts.map(account => account.username).sort(), domains: domains.map(domain => domain.name).sort(), uids: accounts.map(account => account.uid).sort((left, right) => left - right), plans: plans.map(plan => plan.name).sort() }
}
const expected = (body: Record<string, unknown>): string => {
  if (typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedRevision)) return fail('VALIDATION', 'a saved transfer revision is required', { stateChanged: false })
  return body.expectedRevision
}
const stringList = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > 5000 || value.some(item => typeof item !== 'string') || new Set(value).size !== value.length) return fail('VALIDATION', 'transfer selection must be a bounded list of unique names', { stateChanged: false })
  return value as string[]
}
const plainError = (error: unknown, fallback: string): string => isXpanelError(error) && error.message.length <= 400 ? error.message : fallback

const UNMAPPED_TAG: Record<string, CpanelUnmappedItem['tag']> = { 'cron-paused': 'paused', 'password-not-kept': 'reset', 'main-inbox-not-imported': 'partial', 'filters-not-imported': 'partial' }
/** Every archive warning, tagged for the review list; forwarders are listed because this release does not write them. */
export const cpanelUnmapped = (plan: Record<string, unknown>): CpanelUnmappedItem[] => {
  const warnings = Array.isArray(plan.warnings) ? plan.warnings.filter(object) as unknown as ImportWarning[] : []
  const forwarders = Array.isArray(plan.mail) ? plan.mail.filter(object).reduce((sum, domain) => sum + (Array.isArray(domain.forwarders) ? domain.forwarders.length : 0), 0) : 0
  return [...warnings.map(warning => ({ tag: UNMAPPED_TAG[warning.code] ?? 'skipped' as const, code: warning.code, message: warning.message, ...(warning.path ? { path: warning.path } : {}) })),
    ...(forwarders ? [{ tag: 'skipped' as const, code: 'forwarders-not-imported', message: forwarders + ' forwarders are listed in the review but not written; recreate them after the import', path: 'va/' }] : [])]
}

/** Durable transfer metadata over the existing reducer; native facts never come from UI events. */
export function createTransferWorkspaceRoutes(helpers: Helpers, ports: TransferWorkspacePorts = {}) {
  const path = workspacePath(helpers.store)
  const capabilities = { discover: !!ports.discover, execute: !!ports.execution && !!ports.callerFor, cpanelImport: !!ports.cpanel && !!ports.callerFor, cpanelUploadMaxBytes: ports.cpanel?.maxBytes ?? 0, nativeQualification: 'unchanged' }
  /** Sessions and imports this process is working on right now. */
  const running = new Set<string>()
  let recovered: Promise<void> | null = null
  const authorize = async (req: Request): Promise<AuthenticatedCaller> => {
    const caller = await helpers.requireCaller(req)
    await helpers.assertRoot(caller, 'transfers.sessions')
    return caller
  }
  /** One writer-lease read-modify-write of the whole document; an unverifiable write reports unknown outcome. */
  const withDocument = async <T>(fn: (document: WorkspaceDocument) => Promise<T>): Promise<T> => {
    const lease = await helpers.store.getWriterLock().acquire()
    let changed = false
    try {
      const document = await readDocument(path), result = await fn(document)
      if (Buffer.byteLength(JSON.stringify(document)) > MAX_DOCUMENT_BYTES) return fail('VALIDATION', 'transfer workspace capacity exceeded', { stateChanged: false })
      await atomicWriteJson(path, document, 0o600, () => lease.assertFencingToken())
      changed = true
      await lease.commitAuthority()
      return result
    } catch (error) {
      if (changed || isStateDirectoryDurabilityError(error)) return fail('PRECONDITION_FAILED', 'transfer write outcome requires inspection', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
      throw error
    } finally { await lease.release() }
  }
  const mutate = async <T>(req: Request, fn: (document: WorkspaceDocument, caller: AuthenticatedCaller) => Promise<T>): Promise<T> => withDocument(async document => {
    const caller = await helpers.requireCaller(req)
    if (caller.principal.kind !== 'root') return fail('FORBIDDEN', 'root access is required', { stateChanged: false })
    return fn(document, caller)
  })
  const project = (record: StoredTransferWorkspace) => {
    const session = replay(record)
    const review = session.state === 'reviewed' || session.state === 'applying' || session.state === 'completed' || session.state === 'cancelled' && session.reviewDigest ? buildReview(session) : null
    return { session, revision: digest(record), review, digest: review ? reviewDigest(review) : null, results: record.results ?? {}, stopRequested: !!record.stopRequestedAt, running: running.has(record.id) }
  }
  const projectImport = (record: CpanelImportRecord) => ({ ...record, revision: digest(record), running: running.has(record.id) })
  const updateSession = async (id: string, revision: string | null, change: (record: StoredTransferWorkspace) => Promise<StoredTransferWorkspace>) => withDocument(async document => {
    const index = document.sessions.findIndex(session => session.id === id)
    if (index < 0) return fail('NOT_FOUND', 'transfer session not found', { stateChanged: false })
    const record = document.sessions[index]!
    if (revision !== null && digest(record) !== revision) return fail('CONFLICT', 'transfer session changed; read and review it again', { stateChanged: false })
    const next = await change(record)
    document.sessions[index] = next
    return project(next)
  })
  const updateImport = async (id: string, revision: string | null, change: (record: CpanelImportRecord) => Promise<CpanelImportRecord> | CpanelImportRecord) => withDocument(async document => {
    const index = document.cpanelImports.findIndex(item => item.id === id)
    if (index < 0) return fail('NOT_FOUND', 'cPanel import not found', { stateChanged: false })
    const record = document.cpanelImports[index]!
    if (revision !== null && digest(record) !== revision) return fail('CONFLICT', 'the cPanel import changed; read it again', { stateChanged: false })
    const next = { ...await change(structuredClone(record)), updatedAt: new Date().toISOString() }
    document.cpanelImports[index] = next
    return projectImport(next)
  })
  const audit = async (caller: Pick<AuthenticatedCaller, 'principal'>, action: string, target = 'transfer-workspace', detail?: Record<string, unknown>, outcome: 'ok' | 'failed' = 'ok'): Promise<void> => {
    await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action, target, ...(detail ? { detail } : {}), outcome }).catch(() => undefined)
  }

  /** The reviewed accounts one after another; a stop request ends the run after the current account. */
  const runSession = (id: string, caller: AuthenticatedCaller): void => {
    const execution = ports.execution!
    running.add(id)
    void (async () => {
      try {
        const session = replay((await readDocument(path)).sessions.find(item => item.id === id)!)
        // while a session applies, only this job appends to it (stop sets a flag the reducer ignores)
        const emit = async (event: TransferProgressEvent, result?: Partial<TransferAccountResult>): Promise<void> => {
          if (!object(event) || event.type !== 'progress') fail('PRECONDITION_FAILED', 'transfer executor returned an invalid outcome')
          await updateSession(id, null, async current => ({ ...append(current, event), ...(result ? { results: { ...current.results, [event.account]: result } } : {}) }))
        }
        const shouldStop = async (): Promise<boolean> => !!(await readDocument(path)).sessions.find(item => item.id === id)?.stopRequestedAt
        await execution.run(caller, session, buildReview(session), emit, shouldStop)
        const stopped = await shouldStop()
        await updateSession(id, null, async current => append(current, stopped ? { type: 'cancel' } : { type: 'complete' }))
        await audit(caller, stopped ? 'transfer.execution.stopped' : 'transfer.execution.completed', 'transfer:' + id)
      } catch (error) {
        await updateSession(id, null, async current => replay(current).state === 'applying' ? append(current, { type: 'fail', reason: plainError(error, 'the transfer stopped unexpectedly; review the accounts it reached') }) : current).catch(() => undefined)
        await audit(caller, 'transfer.execution.failed', 'transfer:' + id, undefined, 'failed')
      } finally { running.delete(id) }
    })()
  }

  /** After a restart: in-flight accounts are rolled back and failed, the rest of the run continues; in-flight imports are rolled back. */
  const recover = (): Promise<void> => {
    recovered ??= (async () => {
      const document = await readDocument(path)
      for (const record of document.sessions) {
        const session = replay(record)
        if (session.state !== 'applying' || running.has(record.id)) continue
        const caller = record.runBy && ports.callerFor ? await ports.callerFor(record.runBy) : null
        if (!caller || !ports.execution) {
          await updateSession(record.id, null, async current => append(current, { type: 'fail', reason: 'the transfer was interrupted and cannot resume here; review the accounts it reached' })).catch(() => undefined)
          continue
        }
        for (const [source, progress] of Object.entries(session.progress)) {
          if (!IN_FLIGHT.has(progress.phase)) continue
          let removed = false, failed = false
          try { removed = await ports.execution.recover(caller, progress, record.results?.[source]) } catch { failed = true }
          const error = failed ? 'Interrupted by a restart; the partial account could not be removed. Review ' + progress.targetUsername + ' before retrying.' : removed ? 'Interrupted by a restart; the partial account was removed.' : 'Interrupted by a restart before anything was created here.'
          await updateSession(record.id, null, async current => ({ ...append(current, { type: 'progress', account: source, phase: 'failed', error }), results: { ...current.results, [source]: { rolledBack: removed, rollbackFailed: failed } } }))
          await audit(caller, removed ? 'transfer.account.rolled_back' : 'transfer.account.failed', 'account:' + progress.targetUsername, { interrupted: true }, 'failed')
        }
        runSession(record.id, caller)
      }
      for (const item of document.cpanelImports) {
        if (item.state !== 'importing' || running.has(item.id)) continue
        const caller = ports.cpanel && ports.callerFor ? await ports.callerFor(item.actor) : null
        let removed = false
        try { removed = caller ? await ports.cpanel!.recover(caller, item) : false } catch { removed = false }
        await updateImport(item.id, null, current => ({ ...current, state: 'failed', task: null, error: removed ? 'Interrupted by a restart; the partial account was removed.' : 'Interrupted by a restart; review the target account before retrying.' })).catch(() => undefined)
      }
    })().catch(() => undefined)
    return recovered
  }

  /** Advances fetch and inspect tasks the host finished since the last read. */
  const refreshImports = async (caller: AuthenticatedCaller): Promise<void> => {
    const cpanel = ports.cpanel
    if (!cpanel) return
    for (const item of (await readDocument(path)).cpanelImports) {
      if ((item.state !== 'fetching' && item.state !== 'inspecting') || !item.task) continue
      const task = await cpanel.readTask(caller, item.task).catch(() => null)
      if (!task || task.state === 'queued' || task.state === 'running') continue
      if (task.state !== 'succeeded' || !task.result) { await updateImport(item.id, null, current => ({ ...current, state: 'failed', task: null, error: task.error ?? 'the host task failed' })); continue }
      if (item.state === 'fetching') {
        const inspect = await cpanel.startTask(caller, { kind: 'cpanel-inspect', archive: item.id, ...(item.targetUsername ? { targetUsername: item.targetUsername } : {}) })
        await updateImport(item.id, null, current => ({ ...current, state: 'inspecting', task: inspect, bytes: task.result!.bytes as number, sha256: task.result!.sha256 as string }))
        continue
      }
      const plan = object(task.result.plan) ? task.result.plan : {}
      const local = await inventory(helpers)
      const account = object(plan.account) ? plan.account : {}
      const domains = Array.isArray(plan.domains) ? plan.domains.filter(object).map(domain => String(domain.name)) : []
      await updateImport(item.id, null, current => ({ ...current, state: 'review', task: null, plan, bytes: task.result!.bytes as number, sha256: task.result!.sha256 as string, unmapped: cpanelUnmapped(plan),
        conflicts: [...(local.usernames.includes(String(account.username)) ? [{ kind: 'username' as const, value: String(account.username) }] : []), ...domains.filter(name => local.domains.includes(name)).map(value => ({ kind: 'domain' as const, value }))] }))
    }
  }

  const runImport = (id: string, caller: AuthenticatedCaller, planId: string): void => {
    running.add(id)
    void (async () => {
      const record = (await readDocument(path)).cpanelImports.find(item => item.id === id)!
      try {
        const result = await ports.cpanel!.apply(caller, record, { planId, onCreated: async accountId => { await updateImport(id, null, current => ({ ...current, createdAccountId: accountId })) } })
        await updateImport(id, null, current => ({ ...current, state: 'imported', result, error: null }))
        await audit(caller, 'transfer.cpanel.imported', 'account:' + String(result.username ?? ''), { archive: id, sha256: record.sha256 })
      } catch (error) {
        await updateImport(id, null, current => ({ ...current, state: 'failed', error: plainError(error, 'the import failed; the partial account was removed') })).catch(() => undefined)
        await audit(caller, 'transfer.cpanel.failed', 'transfer-import:' + id, undefined, 'failed')
      } finally { running.delete(id) }
    })()
  }

  /**
   * Appends one chunk at its declared offset to <uploadDir>/<id>.part (the file size must equal the offset, so a
   * repeated or reordered chunk is refused); the last chunk digests the whole file and publishes <id>.tar.gz.
   */
  const storeChunk = async (req: Request, record: CpanelImportRecord, cpanel: CpanelImportPorts): Promise<{ received: number; sha256: string | null }> => {
    // the panel's session transport carries JSON only, so a chunk travels as base64
    const body = exact(await requestBody(req), ['offset', 'data'])
    const offset = Number(body.offset)
    if (typeof body.data !== 'string' || body.data.length > Math.ceil(CPANEL_UPLOAD_CHUNK_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) return fail('VALIDATION', 'the chunk must be base64', { stateChanged: false })
    const chunk = Buffer.from(body.data, 'base64')
    if (!Number.isSafeInteger(offset) || offset < 0 || !chunk.length || chunk.length > CPANEL_UPLOAD_CHUNK_BYTES || offset + chunk.length > (record.bytes ?? 0)) return fail('VALIDATION', 'the chunk does not fit the declared archive size', { stateChanged: false })
    await mkdir(cpanel.uploadDir, { recursive: true, mode: 0o750 })
    const partial = join(cpanel.uploadDir, record.id + '.part')
    const output = await open(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o640)
    try {
      const size = (await output.stat()).size
      if (size !== offset) return fail('CONFLICT', 'the upload continues at ' + size + ' bytes', { stateChanged: false, received: size })
      let written = 0
      while (written < chunk.length) written += (await output.write(chunk.subarray(written))).bytesWritten
      await output.sync()
    } finally { await output.close() }
    const received = offset + chunk.length
    if (received < (record.bytes ?? 0)) return { received, sha256: null }
    const hash = createHash('sha256'), input = await open(partial, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { for await (const piece of input.createReadStream({ autoClose: false })) hash.update(piece as Buffer) } finally { await input.close() }
    await rename(partial, join(cpanel.uploadDir, record.id + '.tar.gz'))
    return { received, sha256: hash.digest('hex') }
  }
  const uploading = new Set<string>()

  const handleImports = async (req: Request, url: URL, method: string, caller: AuthenticatedCaller): Promise<Response> => {
    const cpanel = ports.cpanel
    if (!cpanel || !ports.callerFor) return fail('PRECONDITION_FAILED', 'cPanel import needs the host agent', { stateChanged: false })
    if (url.pathname === '/api/transfers/ssh-key') {
      if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405)
      return json(await cpanel.sshKey(caller))
    }
    const item = /^\/api\/transfers\/cpanel-imports\/([0-9a-f-]{36})$/i.exec(url.pathname)
    if (url.pathname === '/api/transfers/cpanel-imports' && method === 'POST') {
      const body = exact(await requestBody(req), ['filename', 'bytes', 'targetUsername'])
      const filename = body.filename
      if (typeof filename !== 'string' || !filename || filename.length > 255 || /[\u0000-\u001f\u007f/\\]/.test(filename)) return fail('VALIDATION', 'a bounded archive filename is required', { stateChanged: false })
      if (!Number.isSafeInteger(body.bytes) || (body.bytes as number) <= 0) return fail('VALIDATION', 'the archive size is required', { stateChanged: false })
      if ((body.bytes as number) > cpanel.maxBytes) return fail('LIMIT_EXCEEDED', 'the archive is larger than the import limit', { stateChanged: false })
      if (body.targetUsername !== undefined && (typeof body.targetUsername !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(body.targetUsername))) return fail('VALIDATION', 'the destination username is invalid', { stateChanged: false })
      const record = await mutate(req, async document => {
        if (document.cpanelImports.length >= MAX_IMPORTS) return fail('VALIDATION', 'cPanel import capacity reached; discard old imports first', { stateChanged: false })
        const now = new Date().toISOString()
        const value: CpanelImportRecord = { id: randomUUID(), origin: 'upload', filename, source: null, actor: caller.principal.id, createdAt: now, updatedAt: now, state: 'uploading', task: null, targetUsername: (body.targetUsername as string | undefined) ?? null,
          bytes: body.bytes as number, received: 0, sha256: null, plan: null, conflicts: [], unmapped: [], result: null, error: null }
        document.cpanelImports.push(value)
        return value
      })
      await audit(caller, 'transfer.cpanel.upload_started', 'transfer-import:' + record.id, { bytes: record.bytes })
      return json({ cpanelImport: projectImport(record), chunkBytes: CPANEL_UPLOAD_CHUNK_BYTES, capabilities }, 201)
    }
    if (item && method === 'PUT') {
      const id = item[1]!.toLowerCase()
      const record = (await readDocument(path)).cpanelImports.find(entry => entry.id === id) ?? fail('NOT_FOUND', 'cPanel import not found', { stateChanged: false })
      if (record.state !== 'uploading' || record.origin !== 'upload') return fail('CONFLICT', 'this import is not receiving an upload', { stateChanged: false })
      if (uploading.has(id)) return fail('CONFLICT', 'another chunk of this upload is being written', { stateChanged: false })
      uploading.add(id)
      try {
        const stored = await storeChunk(req, record, cpanel)
        if (!stored.sha256) return json({ received: stored.received })
        let task: string
        try { task = await cpanel.startTask(caller, { kind: 'cpanel-inspect', archive: id, ...(record.targetUsername ? { targetUsername: record.targetUsername } : {}) }) }
        catch (error) { await updateImport(id, null, current => ({ ...current, state: 'failed', received: stored.received, sha256: stored.sha256, error: plainError(error, 'the host could not inspect the archive') })); throw error }
        const updated = await updateImport(id, null, current => ({ ...current, state: 'inspecting', task, received: stored.received, sha256: stored.sha256 }))
        await audit(caller, 'transfer.cpanel.uploaded', 'transfer-import:' + id, { bytes: stored.received, sha256: stored.sha256 })
        return json({ received: stored.received, cpanelImport: updated, capabilities })
      } finally { uploading.delete(id) }
    }
    if (url.pathname === '/api/transfers/cpanel-imports/ssh' && method === 'POST') {
      const body = exact(await requestBody(req), ['host', 'port', 'hostKeyFingerprint', 'cpanelUser', 'targetUsername'])
      if (typeof body.cpanelUser !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(body.cpanelUser)) return fail('VALIDATION', 'the cPanel username is invalid', { stateChanged: false })
      if (body.targetUsername !== undefined && (typeof body.targetUsername !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(body.targetUsername))) return fail('VALIDATION', 'the destination username is invalid', { stateChanged: false })
      const task = await cpanel.startTask(caller, { kind: 'cpanel-fetch', username: body.cpanelUser, host: body.host, port: body.port, hostKeyFingerprint: body.hostKeyFingerprint })
      const record = await mutate(req, async document => {
        if (document.cpanelImports.length >= MAX_IMPORTS) return fail('VALIDATION', 'cPanel import capacity reached; discard old imports first', { stateChanged: false })
        const now = new Date().toISOString()
        // the host stores the fetched archive under the fetch task id
        const value: CpanelImportRecord = { id: task, origin: 'ssh', filename: 'cpmove-' + String(body.cpanelUser) + '.tar.gz', source: String(body.host), actor: caller.principal.id, createdAt: now, updatedAt: now, state: 'fetching', task,
          targetUsername: (body.targetUsername as string | undefined) ?? null, bytes: null, sha256: null, plan: null, conflicts: [], unmapped: [], result: null, error: null }
        document.cpanelImports.push(value)
        return value
      })
      await audit(caller, 'transfer.cpanel.fetch_requested', 'transfer-import:' + task, { source: body.host })
      return json({ cpanelImport: projectImport(record), capabilities }, 201)
    }
    if (item && method === 'PATCH') {
      const id = item[1]!.toLowerCase()
      const body = exact(await requestBody(req), ['expectedRevision', 'action', 'planId'])
      const revision = expected(body)
      if (body.action === 'discard') {
        const current = (await readDocument(path)).cpanelImports.find(entry => entry.id === id) ?? fail('NOT_FOUND', 'cPanel import not found', { stateChanged: false })
        if (digest(current) !== revision) return fail('CONFLICT', 'the cPanel import changed; read it again', { stateChanged: false })
        if (current.state === 'importing' || current.state === 'fetching' || current.state === 'inspecting' || uploading.has(id)) return fail('CONFLICT', 'the archive is still in use', { stateChanged: false })
        await cpanel.discard(caller, current)
        await mutate(req, async document => { document.cpanelImports = document.cpanelImports.filter(entry => entry.id !== id) })
        await audit(caller, 'transfer.cpanel.discarded', 'transfer-import:' + id)
        return json({ discarded: id, capabilities })
      }
      if (body.action !== 'import' || typeof body.planId !== 'string' || !isUuid(body.planId)) return fail('VALIDATION', 'import needs a plan on this server', { stateChanged: false })
      if (running.size) return fail('CONFLICT', 'another transfer or import is running; wait for it to finish', { stateChanged: false })
      const local = await inventory(helpers)
      const updated = await updateImport(id, revision, current => {
        if (current.state !== 'review' || !current.plan) return fail('CONFLICT', 'only a reviewed archive can be imported', { stateChanged: false })
        const account = object(current.plan.account) ? current.plan.account : {}
        if (local.usernames.includes(String(account.username))) return fail('CONFLICT', 'an account named ' + String(account.username) + ' exists here; inspect the archive again with another destination username', { stateChanged: false })
        const taken = (Array.isArray(current.plan.domains) ? current.plan.domains.filter(object) : []).map(domain => String(domain.name)).filter(name => local.domains.includes(name))
        if (taken.length) return fail('CONFLICT', 'these domains exist here: ' + taken.join(', '), { stateChanged: false })
        return { ...current, state: 'importing', error: null }
      })
      await audit(caller, 'transfer.cpanel.import_requested', 'transfer-import:' + id)
      runImport(id, caller, body.planId)
      return json({ cpanelImport: updated, capabilities }, 202)
    }
    return json({ error: 'method_not_allowed' }, 405)
  }

  // after a restart, interrupted work is rolled back and resumed without waiting for someone to open the page
  if (ports.callerFor && (ports.execution || ports.cpanel)) setTimeout(() => { void recover() }, 5000).unref()

  return async (req: Request, url: URL, method: string): Promise<Response | null> => {
    const match = /^\/api\/transfers\/sessions\/([0-9a-f-]{36})$/i.exec(url.pathname)
    const importRoute = /^\/api\/transfers\/(?:cpanel-imports(?:\/[^/]+)?|ssh-key)$/.test(url.pathname)
    if (url.pathname !== '/api/transfers/sessions' && !match && !importRoute) return null
    const caller = await authorize(req)
    await recover()
    if (importRoute) return handleImports(req, url, method, caller)
    if (method === 'GET') {
      await refreshImports(caller).catch(() => undefined)
      const document = await readDocument(path)
      if (match) {
        const record = document.sessions.find(session => session.id === match[1]!.toLowerCase())
        if (!record) return fail('NOT_FOUND', 'transfer session not found', { stateChanged: false })
        return json({ ...project(record), capabilities })
      }
      return json({ sessions: document.sessions.map(project), cpanelImports: document.cpanelImports.map(projectImport), capabilities })
    }
    if (method === 'POST' && !match) {
      const body = exact(await requestBody(req), ['auth'])
      const auth = parseTransferAuth(body.auth)
      const result = await mutate(req, async (document, fresh) => {
        if (document.sessions.length >= MAX_SESSIONS) return fail('VALIDATION', 'transfer session capacity reached', { stateChanged: false })
        const record: StoredTransferWorkspace = { id: randomUUID(), actor: fresh.principal.username, createdAt: new Date().toISOString(), auth, events: [] }
        const value = project(record); document.sessions.push(record); return value
      })
      await audit(caller, 'transfer.session.created')
      return json({ ...result, capabilities }, 201)
    }
    if (method === 'PATCH' && match) {
      const id = match[1]!.toLowerCase()
      if (!isUuid(id)) return fail('NOT_FOUND', 'transfer session not found', { stateChanged: false })
      const body = exact(await requestBody(req), ['expectedRevision', 'action', 'accounts', 'plans', 'conflictId', 'resolution', 'digest'])
      const revision = expected(body)
      if (!['discover', 'select', 'resolve', 'review', 'cancel', 'run', 'stop'].includes(String(body.action))) return fail('VALIDATION', 'unsupported transfer workspace action', { stateChanged: false })
      const actionFields: Record<string, string[]> = { discover: [], select: ['accounts', 'plans'], resolve: ['conflictId', 'resolution'], review: [], cancel: [], run: ['digest'], stop: [] }
      exact(body, ['expectedRevision', 'action', ...actionFields[String(body.action)]!])
      const owned = async (): Promise<StoredTransferWorkspace> => {
        const record = (await readDocument(path)).sessions.find(session => session.id === id)
        if (!record) return fail('NOT_FOUND', 'transfer session not found', { stateChanged: false })
        if (digest(record) !== revision) return fail('CONFLICT', 'transfer session changed; read it again', { stateChanged: false })
        return record
      }
      if (body.action === 'discover') {
        if (!ports.discover) return fail('PRECONDITION_FAILED', 'authenticated pinned source discovery is unavailable', { stateChanged: false })
        const record = await owned()
        if (replay(record).state !== 'created') return fail('CONFLICT', 'transfer session changed; read it again', { stateChanged: false })
        const found = await ports.discover(caller, structuredClone(record.auth))
        const result = await mutate(req, async document => {
          const index = document.sessions.findIndex(session => session.id === id)
          if (index < 0 || digest(document.sessions[index]) !== revision) return fail('CONFLICT', 'transfer session changed; read it again', { stateChanged: false })
          document.sessions[index] = append(append(document.sessions[index]!, { type: 'connected', source: found.source }), { type: 'inventory', accounts: found.accounts, plans: found.plans })
          return project(document.sessions[index]!)
        })
        await audit(caller, 'transfer.source.discovered')
        return json({ ...result, capabilities })
      }
      if (body.action === 'run') {
        if (!ports.execution || !ports.callerFor) return fail('PRECONDITION_FAILED', 'native transfer execution requires the host agent', { stateChanged: false })
        if (running.size) return fail('CONFLICT', 'another transfer or import is running; wait for it to finish', { stateChanged: false })
        const candidate = await owned()
        const candidateSession = replay(candidate)
        const candidateReview = buildReview(candidateSession)
        if (candidateSession.state !== 'reviewed' || candidateSession.reviewDigest !== body.digest || reviewDigest(candidateReview) !== body.digest) return fail('CONFLICT', 'a current reviewed transfer is required', { stateChanged: false })
        await ports.execution.admit(caller, candidateSession, candidateReview)
        const prepared = await mutate(req, async (document, fresh) => {
          const index = document.sessions.findIndex(session => session.id === id)
          const current = document.sessions[index]
          if (!current || digest(current) !== revision) return fail('CONFLICT', 'transfer session changed; read it again', { stateChanged: false })
          const session = replay(current), review = buildReview(session), local = await inventory(helpers)
          if (digest(local) !== digest(session.local)) return fail('CONFLICT', 'local inventory changed; select and review again', { stateChanged: false })
          if (reviewDigest(review) !== body.digest) return fail('CONFLICT', 'the transfer review changed', { stateChanged: false })
          document.sessions[index] = { ...append(current, { type: 'confirm', digest: body.digest as string }), runBy: fresh.principal.id, stopRequestedAt: null, results: {} }
          return project(document.sessions[index]!)
        })
        await audit(caller, 'transfer.execution.started', 'transfer:' + id, { accounts: prepared.review?.accounts.map(account => account.source + '->' + account.target) ?? [] })
        runSession(id, caller)
        return json({ ...prepared, running: true, capabilities }, 202)
      }
      if (body.action === 'stop') {
        const result = await mutate(req, async document => {
          const index = document.sessions.findIndex(session => session.id === id)
          const current = document.sessions[index]
          if (!current || digest(current) !== revision) return fail('CONFLICT', 'transfer session changed; read it again', { stateChanged: false })
          if (replay(current).state !== 'applying') return fail('CONFLICT', 'only a running transfer can be stopped', { stateChanged: false })
          document.sessions[index] = { ...current, stopRequestedAt: new Date().toISOString() }
          return project(document.sessions[index]!)
        })
        await audit(caller, 'transfer.execution.stop_requested', 'transfer:' + id)
        return json({ ...result, capabilities })
      }
      const result = await mutate(req, async document => {
        const index = document.sessions.findIndex(session => session.id === id)
        const current = document.sessions[index]
        if (!current) return fail('NOT_FOUND', 'transfer session not found', { stateChanged: false })
        if (digest(current) !== revision) return fail('CONFLICT', 'transfer session changed; read and review it again', { stateChanged: false })
        let next: StoredTransferWorkspace
        if (body.action === 'cancel') {
          if (replay(current).state === 'applying') return fail('PRECONDITION_FAILED', 'a running transfer stops after its current account; use stop', { stateChanged: false })
          next = append(current, { type: 'cancel' })
        } else if (body.action === 'select') next = append(current, { type: 'select', accounts: stringList(body.accounts), plans: stringList(body.plans), local: await inventory(helpers) })
        else if (body.action === 'resolve') {
          if (typeof body.conflictId !== 'string' || !object(body.resolution)) return fail('VALIDATION', 'a conflict and resolution are required', { stateChanged: false })
          next = append(current, { type: 'resolve', conflictId: body.conflictId, resolution: body.resolution as unknown as Extract<TransferEvent, { type: 'resolve' }>['resolution'] })
        } else {
          if (digest(await inventory(helpers)) !== digest(replay(current).local)) return fail('CONFLICT', 'local inventory changed; select and review again', { stateChanged: false })
          next = append(current, { type: 'review' })
        }
        document.sessions[index] = next
        return project(next)
      })
      await audit(caller, 'transfer.session.' + String(body.action))
      return json({ ...result, capabilities })
    }
    return json({ error: 'method_not_allowed' }, 405)
  }
}
