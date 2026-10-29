import { fail } from '@xpanel/core'
import type { Account, Domain } from '@xpanel/core'
import { sha256Hex } from './auth.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { authorizeAccountOwner } from './account-ssh-workspace.ts'
import type { AccountOwnerPorts } from './account-ssh-workspace.ts'
import { readReply } from './backup-file-restore-workspace.ts'

export interface StagingWorkspacePorts extends AccountOwnerPorts {
  /** ext.readOrDefault(`accounts/staging/${accountId}.json`, null) */
  readSaved(accountId: string): Promise<unknown>
  /** ext.write(`accounts/staging/${accountId}.json`, value) */
  writeSaved(accountId: string, value: unknown): Promise<unknown>
  /** Protected agent RPC; absent when the host agent is not connected. */
  callAgent?: (path: string, options: { caller: AuthenticatedCaller; method?: string; body?: unknown }) => Promise<Response>
  now?: () => Date
}
export type StagingState = 'ready' | 'incomplete' | 'unknown'
export interface StagingRecord { domainId: string; domain: string; state: StagingState; files: number; createdAt: string; createdBy: string; promotedAt: string | null }

export const STAGING_TOOL = 'site-staging'
const ROUTE = /^\/api\/account\/staging(?:\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(copy|review|promote|discard))?)?$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEX = /^[0-9a-f]{64}$/
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const unchanged = { stateChanged: false }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const keys = (value: Record<string, unknown>): string => Object.keys(value).sort().join()
const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const revisionOf = (raw: unknown): string => sha256Hex(JSON.stringify(raw ?? null))

/** Strict saved-file reader. null is "nothing saved"; anything unreadable returns null so no record is invented. */
export function readStagingRecords(raw: unknown): StagingRecord[] | null {
  if (raw === null) return []
  if (!Array.isArray(raw) || raw.length > 100) return null
  const records = raw.map(item => object(item) && keys(item) === 'createdAt,createdBy,domain,domainId,files,promotedAt,state' && typeof item.domainId === 'string' && UUID.test(item.domainId)
    && typeof item.domain === 'string' && /^[a-z0-9.-]{1,253}$/.test(item.domain) && ['ready', 'incomplete', 'unknown'].includes(item.state as string) && count(item.files)
    && typeof item.createdAt === 'string' && STAMP.test(item.createdAt) && typeof item.createdBy === 'string' && /^[a-z][a-z0-9]{0,15}$/.test(item.createdBy) && (item.promotedAt === null || typeof item.promotedAt === 'string' && STAMP.test(item.promotedAt)) ? item as unknown as StagingRecord : null)
  return records.every(record => record !== null) && new Set(records.map(record => record!.domainId)).size === records.length ? records as StagingRecord[] : null
}

/** Pure state transition of the saved record after a verified agent outcome. */
export function nextStagingRecords(records: readonly StagingRecord[], op: 'copy' | 'promote' | 'discard', domain: Pick<Domain, 'id' | 'name'>, outcome: string, files: number, actor: string, at: string): StagingRecord[] {
  const others = records.filter(record => record.domainId !== domain.id), current = records.find(record => record.domainId === domain.id)
  if (op === 'discard') return outcome === 'discarded' ? others : [...others, { ...(current ?? { domainId: domain.id, domain: domain.name, files: 0, createdAt: at, createdBy: actor, promotedAt: null }), state: 'unknown' }]
  if (op === 'copy') return [...others, { domainId: domain.id, domain: domain.name, state: outcome === 'copied' ? 'ready' : outcome === 'incomplete' ? 'incomplete' : 'unknown', files, createdAt: at, createdBy: actor, promotedAt: null }]
  return [...others, { ...current!, state: outcome === 'unknown' ? 'unknown' : current!.state, promotedAt: outcome === 'promoted' ? at : current!.promotedAt }]
}

/** The agent reply must stay bound to this account and domain and carry a known outcome. */
export function verifiedStagingReply(op: 'inspect' | 'copy' | 'review' | 'promote' | 'discard', value: unknown, account: Account, domain: Domain): boolean {
  if (!object(value) || !object(value.context) || value.context.accountId !== account.id || value.context.username !== account.username || value.context.domainId !== domain.id || value.context.domain !== domain.name) return false
  const side = (item: unknown): boolean => object(item) && typeof item.path === 'string' && count(item.files) && count(item.bytes) && count(item.links)
  if (op === 'inspect' || op === 'review') return side(value.live) && side(value.staging) && typeof (value.staging as Record<string, unknown>).exists === 'boolean'
    && (op === 'inspect' || typeof value.revision === 'string' && HEX.test(value.revision) && Array.isArray(value.rows) && value.rows.length <= 1000 && value.rows.every(row => object(row) && typeof row.path === 'string' && ['add', 'change', 'remove'].includes(row.change as string) && count(row.bytes)))
  if (typeof value.verificationRequired !== 'boolean') return false
  if (op === 'discard') return ['discarded', 'unknown'].includes(value.outcome as string) && (value.outcome === 'unknown') === value.verificationRequired
  if (op === 'copy') return ['copied', 'incomplete', 'unknown'].includes(value.outcome as string) && object(value.counts) && [value.counts.files, value.counts.copied, value.counts.failed, value.counts.notAttempted].every(count)
  return ['promoted', 'incomplete', 'unknown'].includes(value.outcome as string) && Array.isArray(value.results) && value.results.length <= 1000 && object(value.counts) && typeof value.revision === 'string' && HEX.test(value.revision)
}

const readBody = async (req: Request): Promise<Record<string, unknown>> => {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') ?? '')) return fail('VALIDATION', 'a JSON staging request is required', unchanged)
  const text = await req.text()
  if (Buffer.byteLength(text) > 4096) return fail('LIMIT_EXCEEDED', 'the staging request is too large', unchanged)
  let body: unknown
  try { body = JSON.parse(text) } catch { return fail('VALIDATION', 'the staging request must be valid JSON', unchanged) }
  return object(body) ? body : fail('VALIDATION', 'the staging request must be an object', unchanged)
}
const sameAuthority = (a: AuthenticatedCaller, b: AuthenticatedCaller): boolean => a.principal.id === b.principal.id && a.sessionId === b.sessionId && a.apiTokenId === b.apiTokenId

// shortcut: in-process serialization only; one API process owns these extended state files.
let queue: Promise<unknown> = Promise.resolve()
const serial = <T>(task: () => Promise<T>): Promise<T> => { const run = queue.then(task, task); queue = run.catch(() => undefined); return run }

/** /api/account/staging[/<domainId>[/copy|review|promote|discard]]: the signed-in account owner's staging copies. */
export async function handleStagingWorkspaceRoute(req: Request, url: URL, method: string, ports: StagingWorkspacePorts): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  const [, domainId, op] = match as unknown as [string, string | undefined, 'copy' | 'review' | 'promote' | 'discard' | undefined]
  if (method !== (op ? 'POST' : 'GET')) return new Response(null, { status: 405, headers: { allow: op ? 'POST' : 'GET' } })
  if (url.search) return fail('VALIDATION', 'staging requests do not accept selectors', unchanged)
  const first = await authorizeAccountOwner(ports, req, [STAGING_TOOL], 'staging sites')
  const eligible = (await ports.store.listDomains({ accountId: first.account.id })).filter(domain => domain.accountId === first.account.id && domain.kind !== 'alias' && domain.redirect === null && !domain.suspended)
  const readRecords = async (): Promise<{ raw: unknown; records: StagingRecord[] }> => {
    const raw = await ports.readSaved(first.account.id), records = readStagingRecords(raw)
    return records ? { raw, records } : fail('SERVICE_UNAVAILABLE', 'saved staging records could not be verified', unchanged)
  }
  if (!domainId) {
    const { raw, records } = await readRecords()
    return json({ context: { accountId: first.account.id, username: first.account.username }, domains: eligible.map(domain => ({ id: domain.id, name: domain.name, kind: domain.kind })).sort((a, b) => a.name.localeCompare(b.name)),
      records, revision: revisionOf(raw), capabilities: { agent: !!ports.callAgent } })
  }
  const domain = eligible.find(item => item.id === domainId)
  if (!domain) return fail('NOT_FOUND', 'domain not found or it cannot be staged', unchanged)
  const body = op ? await readBody(req) : {}
  const expected = op === 'promote' ? 'expectedRecordsRevision,expectedRevision' : op === 'copy' || op === 'discard' ? 'expectedRecordsRevision' : ''
  if (keys(body) !== expected || Object.values(body).some(value => typeof value !== 'string' || !HEX.test(value))) return fail('VALIDATION', expected ? 'this staging request takes only ' + expected.replace(',', ' and ') : 'this staging request takes no fields', unchanged)
  if (!ports.callAgent) return fail('PRECONDITION_FAILED', 'privileged host agent is not connected', unchanged)
  const callAgent = ports.callAgent, agentPath = '/accounts/' + first.account.username + '/staging/' + domain.id + (op ? '/' + op : '')
  if (!op || op === 'review') {
    const response = await callAgent(agentPath, { caller: first.caller, ...(op ? { method: 'POST', body: {} } : {}) })
    if (response.status !== 200) return response
    const value = await readReply(response)
    return verifiedStagingReply(op ?? 'inspect', value, first.account, domain) ? json(value) : fail('PRECONDITION_FAILED', 'the host staging response could not be verified', unchanged)
  }
  return serial(async () => {
    const { raw, records } = await readRecords()
    if (revisionOf(raw) !== body.expectedRecordsRevision) return fail('CONFLICT', 'staging records changed since they were read; reload before continuing', unchanged)
    const current = records.find(record => record.domainId === domain.id)
    if (op === 'copy' && current) return fail('CONFLICT', 'a staging copy is already recorded for this domain; discard it first', unchanged)
    if (op === 'promote' && current?.state !== 'ready') return fail('PRECONDITION_FAILED', 'only a complete, verified staging copy can be promoted', unchanged)
    // Fresh authority immediately before the host change; the agent re-checks again inside the account lease.
    const fresh = await authorizeAccountOwner(ports, req, [STAGING_TOOL], 'staging sites')
    if (!sameAuthority(fresh.caller, first.caller) || fresh.account.id !== first.account.id || fresh.account.username !== first.account.username) return fail('CONFLICT', 'the account binding changed before the staging change', unchanged)
    const response = await callAgent(agentPath, { caller: fresh.caller, method: 'POST', body: op === 'promote' ? { expectedRevision: body.expectedRevision } : {} })
    if (response.status !== 200) return response
    const value = await readReply(response), verified = verifiedStagingReply(op, value, fresh.account, domain)
    const outcome = verified ? String((value as Record<string, unknown>).outcome) : 'unknown'
    const files = verified && op === 'copy' ? ((value as { counts: { copied: number } }).counts.copied) : current?.files ?? 0
    const next = nextStagingRecords(records, op, domain, outcome, files, fresh.caller.principal.username, (ports.now?.() ?? new Date()).toISOString())
    await ports.writeSaved(first.account.id, next)
    const saved = await ports.readSaved(first.account.id)
    if (revisionOf(saved) !== revisionOf(next)) return fail('SERVICE_UNAVAILABLE', 'the staging record could not be verified', { stateChanged: true, verificationRequired: true })
    if (!verified) return fail('PRECONDITION_FAILED', 'the staging outcome requires review; inspect the site and the staging folder', { stateChanged: true, verificationRequired: true })
    return json({ ...(value as Record<string, unknown>), records: next, recordsRevision: revisionOf(saved) })
  })
}
