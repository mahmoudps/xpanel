import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fail, isUuid, isXpanelError } from '@xpanel/core'
import { atomicWriteJson, isStateDirectoryDurabilityError, readJsonIfExists } from '@xpanel/state'
import {
  buildReview, countActiveTransfers, createTransferSession, parseTransferAuth, readCpanelArchive, reviewDigest, transition,
} from '@xpanel/lifecycle'
import type { ImportPlan, TransferAuth, TransferEvent, TransferReview, TransferSession } from '@xpanel/lifecycle'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import type { AuthenticatedCaller } from './auth.ts'

type Helpers = Pick<ExtendedRouteHelpers, 'store' | 'requireCaller' | 'assertRoot' | 'emitAudit'>
type LocalInventory = NonNullable<TransferSession['local']>
type EventEnvelope = { at: string; event: TransferEvent }
export type TransferProgressEvent = Extract<TransferEvent, { type: 'progress' }>
export interface StoredTransferWorkspace {
  id: string
  actor: string
  createdAt: string
  auth: TransferAuth
  events: EventEnvelope[]
}
export interface CpanelArchiveReview {
  id: string
  filename: string
  archiveSha256: string
  reviewedAt: string
  actor: string
  plan: Omit<ImportPlan, 'certificates' | 'databases'> & {
    databases: Array<{ sourceName: string; name: string }>
    certificates: Array<{ names: string[]; notAfter: string }>
  }
  conflicts: Array<{ kind: 'username' | 'domain'; value: string }>
  archiveRetained: false
  nativeApplied: false
}
interface WorkspaceDocument { version: 1; sessions: StoredTransferWorkspace[]; archiveReviews: CpanelArchiveReview[] }
export interface TransferWorkspacePorts {
  /** Trusted server adapter; source identity/inventory must follow pinned authenticated discovery. */
  discover?: (caller: AuthenticatedCaller, auth: TransferAuth) => Promise<{
    source: { hostname: string; version: string }
    accounts: NonNullable<TransferSession['inventory']>['accounts']
    plans: NonNullable<TransferSession['inventory']>['plans']
  }>
  /** Admission must enforce the existing signed/native lifecycle policy before execution. */
  execution?: {
    admit: (caller: AuthenticatedCaller, session: TransferSession, review: TransferReview) => Promise<void>
    /** Runs every reviewed account; each per-account progress event is journaled through emit before the next stage starts. */
    run: (caller: AuthenticatedCaller, session: TransferSession, review: TransferReview, emit: (event: TransferProgressEvent) => Promise<void>) => Promise<void>
  }
}

const MAX_SESSIONS = 500
const MAX_EVENTS = 5000
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024
export const TRANSFER_ARCHIVE_REVIEW_MAX_BYTES = 512 * 1024
export const TRANSFER_ARCHIVE_REVIEW_UNPACKED_MAX_BYTES = 16 * 1024 * 1024
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
  const value = await readJsonIfExists<WorkspaceDocument>(path)
  if (value === null) return { version: 1, sessions: [], archiveReviews: [] }
  if (!object(value) || value.version !== 1 || !Array.isArray(value.sessions) || value.sessions.length > MAX_SESSIONS || !Array.isArray(value.archiveReviews) || value.archiveReviews.length > 100 || Buffer.byteLength(JSON.stringify(value)) > MAX_DOCUMENT_BYTES) {
    return fail('PRECONDITION_FAILED', 'stored transfer workspace requires inspection', { stateChanged: false })
  }
  const ids = new Set<string>()
  for (const record of value.sessions) { replay(record); if (ids.has(record.id)) return fail('PRECONDITION_FAILED', 'stored transfer session identity repeats', { stateChanged: false }); ids.add(record.id) }
  return value
}
const workspacePath = (store: { readonly rootDir: string }): string => join(store.rootDir, 'extended', 'transfers', 'workspace.json')

/** Read the same durable reducer state for upgrade admission; corruption must never become zero. */
export const countPersistedActiveTransfers = async (store: { readonly rootDir: string }): Promise<number> => {
  const document = await readDocument(workspacePath(store))
  return countActiveTransfers(document.sessions.map(replay))
}

const inventory = async (helpers: Helpers): Promise<LocalInventory> => {
  const [accounts, domains, plans] = await Promise.all([helpers.store.listAccounts(), helpers.store.listDomains(), helpers.store.listPlans()])
  return { usernames: accounts.map(account => account.username).sort(), domains: domains.map(domain => domain.name).sort(), uids: accounts.map(account => account.uid).sort((left, right) => left - right), plans: plans.map(plan => plan.name).sort() }
}
const project = (record: StoredTransferWorkspace) => {
  const session = replay(record)
  const review = session.state === 'reviewed' || session.state === 'applying' || session.state === 'completed' ? buildReview(session) : null
  return { session, revision: digest(record), review, digest: review ? reviewDigest(review) : null, nativeApplied: false }
}
const expected = (body: Record<string, unknown>): string => {
  if (typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedRevision)) return fail('VALIDATION', 'a saved transfer revision is required', { stateChanged: false })
  return body.expectedRevision
}
const stringList = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > 5000 || value.some(item => typeof item !== 'string') || new Set(value).size !== value.length) return fail('VALIDATION', 'transfer selection must be a bounded list of unique names', { stateChanged: false })
  return value as string[]
}

/** Durable transfer metadata over the existing reducer; native facts never come from UI events. */
export function createTransferWorkspaceRoutes(helpers: Helpers, ports: TransferWorkspacePorts = {}) {
  const path = workspacePath(helpers.store)
  const capabilities = { discover: !!ports.discover, execute: !!ports.execution, archiveReview: true, archiveMaxBytes: TRANSFER_ARCHIVE_REVIEW_MAX_BYTES, nativeQualification: 'unchanged' }
  const authorize = async (req: Request): Promise<AuthenticatedCaller> => {
    const caller = await helpers.requireCaller(req)
    await helpers.assertRoot(caller, 'transfers.sessions')
    return caller
  }
  const mutate = async <T>(req: Request, fn: (document: WorkspaceDocument, caller: AuthenticatedCaller) => Promise<T>): Promise<T> => {
    const lease = await helpers.store.getWriterLock().acquire()
    let changed = false
    try {
      const caller = await helpers.requireCaller(req)
      if (caller.principal.kind !== 'root') return fail('FORBIDDEN', 'root access is required', { stateChanged: false })
      const document = await readDocument(path), result = await fn(document, caller)
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
  const update = async (req: Request, id: string, revision: string, change: (record: StoredTransferWorkspace, caller: AuthenticatedCaller) => Promise<StoredTransferWorkspace>): Promise<ReturnType<typeof project>> => mutate(req, async (document, caller) => {
    const index = document.sessions.findIndex(session => session.id === id)
    if (index < 0) return fail('NOT_FOUND', 'transfer session not found', { stateChanged: false })
    const record = document.sessions[index]!
    if (digest(record) !== revision) return fail('CONFLICT', 'transfer session changed; read and review it again', { stateChanged: false })
    const next = await change(record, caller)
    document.sessions[index] = next
    return project(next)
  })
  const audit = async (caller: AuthenticatedCaller, action: string): Promise<void> => {
    await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action, target: 'transfer-workspace', outcome: 'ok' })
  }

  return async (req: Request, url: URL, method: string): Promise<Response | null> => {
    const match = /^\/api\/transfers\/sessions\/([0-9a-f-]{36})$/i.exec(url.pathname)
    const archiveRoute = url.pathname === '/api/transfers/cpanel-review'
    if (url.pathname !== '/api/transfers/sessions' && !match && !archiveRoute) return null
    const caller = await authorize(req)
    if (method === 'GET') {
      const document = await readDocument(path)
      if (match) {
        const record = document.sessions.find(session => session.id === match[1]!.toLowerCase())
        if (!record) return fail('NOT_FOUND', 'transfer session not found', { stateChanged: false })
        return json({ ...project(record), capabilities })
      }
      return json({ sessions: document.sessions.map(project), archiveReviews: document.archiveReviews, capabilities })
    }
    if (method === 'POST' && archiveRoute) {
      const body = exact(await requestBody(req), ['filename', 'archiveBase64', 'targetUsername', 'expectedSourceUsername'])
      if (typeof body.filename !== 'string' || !body.filename || body.filename.length > 255 || /[\u0000-\u001f\u007f/\\]/.test(body.filename)) return fail('VALIDATION', 'a bounded archive filename is required', { stateChanged: false })
      if (typeof body.archiveBase64 !== 'string' || body.archiveBase64.length > Math.ceil(TRANSFER_ARCHIVE_REVIEW_MAX_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.archiveBase64)) return fail('VALIDATION', 'archive review upload is invalid or too large', { stateChanged: false })
      const bytes = Buffer.from(body.archiveBase64, 'base64')
      if (!bytes.length || bytes.length > TRANSFER_ARCHIVE_REVIEW_MAX_BYTES || bytes.toString('base64') !== body.archiveBase64) return fail('VALIDATION', 'archive review upload is invalid or too large', { stateChanged: false })
      if (body.targetUsername !== undefined && typeof body.targetUsername !== 'string' || body.expectedSourceUsername !== undefined && typeof body.expectedSourceUsername !== 'string') return fail('VALIDATION', 'archive account names must be text', { stateChanged: false })
      let parsed: ImportPlan
      try { parsed = await readCpanelArchive((async function* () { yield bytes })(), { ...(body.targetUsername ? { targetUsername: body.targetUsername as string } : {}), limits: { maxEntries: 10000, maxTotalBytes: TRANSFER_ARCHIVE_REVIEW_UNPACKED_MAX_BYTES }, now: new Date() }) }
      catch (error) {
        if (isXpanelError(error) && error.code !== 'LIMIT_EXCEEDED') throw error
        return fail('VALIDATION', 'archive could not be parsed within the review limits', { stateChanged: false })
      }
      if (body.expectedSourceUsername !== undefined && body.expectedSourceUsername !== parsed.sourceUsername) return fail('VALIDATION', 'the archive belongs to another source account', { stateChanged: false })
      const { certificates, databases, ...safe } = parsed
      const publicPlan: CpanelArchiveReview['plan'] = { ...safe, databases: databases.map(database => ({ sourceName: database.sourceName, name: database.name })), certificates: certificates.map(certificate => ({ names: certificate.names, notAfter: certificate.notAfter })) }
      const result = await mutate(req, async document => {
        const local = await inventory(helpers)
        const review: CpanelArchiveReview = { id: randomUUID(), filename: body.filename as string, archiveSha256: createHash('sha256').update(bytes).digest('hex'), reviewedAt: new Date().toISOString(), actor: caller.principal.username,
          plan: publicPlan, conflicts: [...(local.usernames.includes(parsed.account.username) ? [{ kind: 'username' as const, value: parsed.account.username }] : []), ...parsed.domains.filter(domain => local.domains.includes(domain.name)).map(domain => ({ kind: 'domain' as const, value: domain.name }))], archiveRetained: false, nativeApplied: false }
        if (document.archiveReviews.length >= 100) return fail('VALIDATION', 'archive review capacity reached', { stateChanged: false })
        document.archiveReviews.push(review)
        return review
      })
      await audit(caller, 'transfer.archive.reviewed')
      return json({ archiveReview: result, capabilities }, 201)
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
      if (!['discover', 'select', 'resolve', 'review', 'cancel', 'run'].includes(String(body.action))) return fail('VALIDATION', 'unsupported transfer workspace action', { stateChanged: false })
      const actionFields: Record<string, string[]> = { discover: [], select: ['accounts', 'plans'], resolve: ['conflictId', 'resolution'], review: [], cancel: [], run: ['digest'] }
      exact(body, ['expectedRevision', 'action', ...actionFields[String(body.action)]!])
      if (body.action === 'discover') {
        if (!ports.discover) return fail('PRECONDITION_FAILED', 'authenticated pinned source discovery is unavailable', { stateChanged: false })
        const record = (await readDocument(path)).sessions.find(session => session.id === id)
        if (!record) return fail('NOT_FOUND', 'transfer session not found', { stateChanged: false })
        if (digest(record) !== revision || replay(record).state !== 'created') return fail('CONFLICT', 'transfer session changed; read it again', { stateChanged: false })
        const found = await ports.discover(caller, structuredClone(record.auth))
        const result = await update(req, id, revision, async current => append(append(current, { type: 'connected', source: found.source }), { type: 'inventory', accounts: found.accounts, plans: found.plans }))
        await audit(caller, 'transfer.source.discovered')
        return json({ ...result, capabilities })
      }
      if (body.action === 'run') {
        if (!ports.execution) return fail('PRECONDITION_FAILED', 'native transfer execution requires qualified lifecycle admission and a trusted executor', { stateChanged: false })
        const execution = ports.execution
        const candidate = (await readDocument(path)).sessions.find(session => session.id === id)
        if (!candidate) return fail('NOT_FOUND', 'transfer session not found', { stateChanged: false })
        if (digest(candidate) !== revision) return fail('CONFLICT', 'transfer session changed; read it again', { stateChanged: false })
        const candidateSession = replay(candidate)
        const candidateReview = buildReview(candidateSession)
        if (candidateSession.state !== 'reviewed' || candidateSession.reviewDigest !== body.digest || reviewDigest(candidateReview) !== body.digest) return fail('CONFLICT', 'a current reviewed transfer is required', { stateChanged: false })
        await execution.admit(caller, candidateSession, candidateReview)
        const prepared = await update(req, id, revision, async current => {
          const session = replay(current), review = buildReview(session), local = await inventory(helpers)
          if (digest(local) !== digest(session.local)) return fail('CONFLICT', 'local inventory changed; select and review again', { stateChanged: false })
          if (reviewDigest(review) !== body.digest) return fail('CONFLICT', 'the transfer review changed', { stateChanged: false })
          return append(current, { type: 'confirm', digest: typeof body.digest === 'string' ? body.digest : '' })
        })
        await audit(caller, 'transfer.execution.requested')
        let journaled = prepared.revision
        const emit = async (event: TransferProgressEvent): Promise<void> => {
          if (!object(event) || event.type !== 'progress') return fail('PRECONDITION_FAILED', 'transfer executor returned an invalid outcome', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
          journaled = (await update(req, id, journaled, async current => append(current, event))).revision
        }
        const unknown = () => fail('PRECONDITION_FAILED', 'transfer execution outcome requires inspection', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
        try { await execution.run(caller, prepared.session, prepared.review!, emit) }
        catch { return unknown() }
        let result: ReturnType<typeof project>
        try { result = await update(req, id, journaled, async current => append(current, { type: 'complete' })) }
        catch { return unknown() }
        await audit(caller, 'transfer.execution.observed')
        return json({ ...result, capabilities })
      }
      const result = await update(req, id, revision, async current => {
        if (body.action === 'cancel') {
          if (replay(current).state === 'applying') return fail('PRECONDITION_FAILED', 'a running native transfer must stop through its trusted executor', { stateChanged: false })
          return append(current, { type: 'cancel' })
        }
        if (body.action === 'select') return append(current, { type: 'select', accounts: stringList(body.accounts), plans: stringList(body.plans), local: await inventory(helpers) })
        if (body.action === 'resolve') {
          if (typeof body.conflictId !== 'string' || !object(body.resolution)) return fail('VALIDATION', 'a conflict and resolution are required', { stateChanged: false })
          return append(current, { type: 'resolve', conflictId: body.conflictId, resolution: body.resolution as unknown as Extract<TransferEvent, { type: 'resolve' }>['resolution'] })
        }
        if (digest(await inventory(helpers)) !== digest(replay(current).local)) return fail('CONFLICT', 'local inventory changed; select and review again', { stateChanged: false })
        return append(current, { type: 'review' })
      })
      await audit(caller, 'transfer.session.' + String(body.action))
      return json({ ...result, capabilities })
    }
    return json({ error: 'method_not_allowed' }, 405)
  }
}
