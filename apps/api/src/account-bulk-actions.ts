import { randomUUID } from 'node:crypto'
import { assertLine, fail, isUuid, isXpanelError } from '@xpanel/core'
import type { Account, Id } from '@xpanel/core'
import { acquireJobLease, completeJobWithLease, enqueueDurableJob, getDurableJob, renewJobLease, saveJobCheckpoint } from '@xpanel/db'
import type { Db, DurableJobRecord } from '@xpanel/db'
import type { AuthenticatedCaller } from './auth.ts'

/** One request changes at most this many accounts; the browser selection is held to the same bound. */
export const ACCOUNT_BULK_LIMIT = 25
const LEASE_MS = 600_000
const ROUTE = /^\/api\/accounts\/bulk-actions(?:\/(suspend|unsuspend|plan|owner))?$/
const REASON = /^[a-z][a-z0-9_]{0,63}$/
const REFUSALS = new Set(['VALIDATION', 'NOT_FOUND', 'FORBIDDEN', 'UNAUTHENTICATED', 'CONFLICT', 'LIMIT_EXCEEDED', 'OVERSELL_BLOCKED', 'SELF_LOCKOUT', 'PRECONDITION_FAILED'])
const unchanged = { stateChanged: false }

export type AccountBulkAction = 'suspend' | 'unsuspend' | 'change-plan' | 'change-owner' | 'terminate'
export type AccountBulkOutcome = 'applied' | 'refused' | 'review-required' | 'not-attempted'
export interface AccountBulkResult { accountId: Id; outcome: AccountBulkOutcome; code: string | null; reason: string | null }
interface Target { id: Id; confirmUsername?: string }
interface Params { reason?: string; planId?: Id; ownerId?: Id | null }

export interface AccountBulkPorts {
  db: Db
  requireCaller: (request: Request) => Promise<AuthenticatedCaller>
  readJsonBody: (request: Request) => Promise<Record<string, unknown>>
  getAccount: (id: Id) => Promise<Account | null>
  assertCanAccessAccount: (caller: AuthenticatedCaller, account: Account, action: string, opts: { allowUserSelf: false }) => Promise<void>
  /** The single-account use cases; each keeps its own authorization, reseller ACL, tenant and audit checks. */
  setSuspension: (caller: AuthenticatedCaller, account: Account, verb: 'suspend' | 'unsuspend', reason?: string) => Promise<unknown>
  update: (caller: AuthenticatedCaller, account: Account, patch: { planId?: Id; ownerId?: Id | null }) => Promise<unknown>
  terminate: (caller: AuthenticatedCaller, account: Account, confirmUsername: string) => Promise<unknown>
}

const ACCESS: Record<AccountBulkAction, string> = { suspend: 'account.suspend', unsuspend: 'account.unsuspend', 'change-plan': 'account.update', 'change-owner': 'account.update', terminate: 'account.delete' }
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const uuid = (value: unknown, name: string): Id => typeof value === 'string' && isUuid(value) && value === value.toLowerCase() ? value : fail('VALIDATION', `${name} must be a lowercase UUID`, unchanged)
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

function parse(action: AccountBulkAction, body: Record<string, unknown>): { operationId: Id; targets: Target[]; params: Params } {
  const required = ['operationId', 'accounts', ...(action === 'change-plan' ? ['planId'] : action === 'change-owner' ? ['ownerId'] : [])]
  const allowed = [...required, ...(action === 'suspend' ? ['reason'] : [])]
  if (required.some(key => !Object.hasOwn(body, key)) || Object.keys(body).some(key => !allowed.includes(key))) return fail('VALIDATION', 'unsupported or missing bulk account field', unchanged)
  if (!Array.isArray(body.accounts) || body.accounts.length < 1 || body.accounts.length > ACCOUNT_BULK_LIMIT) return fail('VALIDATION', `1..${ACCOUNT_BULK_LIMIT} accounts are required`, unchanged)
  const fields = action === 'terminate' ? ['id', 'confirmUsername'] : ['id']
  const targets = body.accounts.map((item: unknown): Target => {
    if (!record(item) || Object.keys(item).length !== fields.length || !fields.every(key => Object.hasOwn(item, key))) return fail('VALIDATION', action === 'terminate' ? 'each account needs its id and typed username confirmation' : 'each account needs exactly its id', unchanged)
    if (action !== 'terminate') return { id: uuid(item.id, 'account id') }
    return typeof item.confirmUsername === 'string' ? { id: uuid(item.id, 'account id'), confirmUsername: item.confirmUsername } : fail('VALIDATION', 'confirmUsername must be the typed account username', unchanged)
  })
  if (new Set(targets.map(target => target.id)).size !== targets.length) return fail('VALIDATION', 'each account may be listed once', unchanged)
  let params: Params = {}
  if (action === 'change-plan') params = { planId: uuid(body.planId, 'planId') }
  if (action === 'change-owner') params = { ownerId: body.ownerId === null ? null : uuid(body.ownerId, 'ownerId') }
  if (action === 'suspend' && body.reason !== undefined) {
    try { params = { reason: assertLine(body.reason, 512, 'suspend reason', { allowEmpty: false }) } }
    catch { return fail('VALIDATION', 'the suspension reason must be one line of at most 512 characters', unchanged) }
  }
  return { operationId: uuid(body.operationId, 'operationId'), targets, params }
}

/** A refusal changed nothing; anything else may have changed desired or host state and needs review. */
const classify = (accountId: Id, error: unknown): AccountBulkResult => {
  if (!isXpanelError(error)) {
    console.error('[xpanel-api] bulk account action failed unexpectedly', error)
    return { accountId, outcome: 'review-required', code: 'SERVICE_UNAVAILABLE', reason: 'unexpected_failure' }
  }
  const detail = error.detail, reason = typeof detail.reason === 'string' && REASON.test(detail.reason) ? detail.reason : null
  const refused = detail.stateChanged === false
    || detail.stateChanged !== true && detail.verificationRequired !== true && detail.unknownOutcome !== true && REFUSALS.has(error.code)
  return { accountId, outcome: refused ? 'refused' : 'review-required', code: error.code, reason }
}

async function runOne(ports: AccountBulkPorts, caller: AuthenticatedCaller, action: AccountBulkAction, target: Target, params: Params): Promise<AccountBulkResult> {
  try {
    const account = await ports.getAccount(target.id) ?? fail('NOT_FOUND', 'account not found', unchanged)
    await ports.assertCanAccessAccount(caller, account, ACCESS[action], { allowUserSelf: false })
    if (action === 'terminate') {
      // The same typed confirmation as DELETE /api/accounts/:id, checked against the current account.
      if (target.confirmUsername !== account.username) fail('VALIDATION', 'confirmation must match the account username', unchanged)
      await ports.terminate(caller, account, account.username)
    } else if (action === 'suspend' || action === 'unsuspend') await ports.setSuspension(caller, account, action, params.reason)
    else await ports.update(caller, account, action === 'change-plan' ? { planId: params.planId! } : { ownerId: params.ownerId ?? null })
    return { accountId: target.id, outcome: 'applied', code: null, reason: null }
  } catch (error) { return classify(target.id, error) }
}

const notAttempted = (accountId: Id, code: string | null = null, reason: string | null = null): AccountBulkResult => ({ accountId, outcome: 'not-attempted', code, reason })

function view(job: DurableJobRecord, operationId: Id, action: AccountBulkAction, targets: Target[], replay: boolean) {
  const final = job.detail.results, saved = Array.isArray(final) ? final : Array.isArray(job.checkpointData.results) ? job.checkpointData.results : []
  const attempting = job.checkpointData.attempting
  const status = job.detail.outcome === 'completed' || job.detail.outcome === 'stopped' ? job.detail.outcome : 'interrupted'
  // An interrupted run never resumes: the account in flight needs review and the rest were not attempted.
  const results = targets.map((target, index): AccountBulkResult => (saved[index] as AccountBulkResult | undefined)
    ?? (target.id === attempting ? { accountId: target.id, outcome: 'review-required', code: 'SERVICE_UNAVAILABLE', reason: 'operation_interrupted' } : notAttempted(target.id)))
  const count = (outcome: AccountBulkOutcome): number => results.filter(item => item.outcome === outcome).length
  return { operation: { id: operationId, reference: job.referenceCode, status, replay }, action, results,
    summary: { applied: count('applied'), refused: count('refused'), reviewRequired: count('review-required'), notAttempted: count('not-attempted') } }
}

/**
 * Bulk suspend, unsuspend, plan, owner and terminate for WHM. Each account runs the existing single-account
 * use case in turn under a fresh caller check; the durable job is the operation id's idempotency record.
 */
export async function handleAccountBulkActionsRoute(request: Request, url: URL, method: string, ports: AccountBulkPorts): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  const allow = match[1] ? 'POST' : 'DELETE'
  if (method !== allow) return new Response(null, { status: 405, headers: { allow } })
  const action: AccountBulkAction = match[1] === undefined ? 'terminate' : match[1] === 'plan' ? 'change-plan' : match[1] === 'owner' ? 'change-owner' : match[1] as 'suspend' | 'unsuspend'
  const caller = await ports.requireCaller(request)
  if (caller.principal.kind !== 'root' && caller.principal.kind !== 'reseller') return fail('FORBIDDEN', 'hosting administrator permission is required', unchanged)
  const { operationId, targets, params } = parse(action, await ports.readJsonBody(request))
  const detail = { action, targets, ...params }
  let job: DurableJobRecord
  try {
    job = await enqueueDurableJob(ports.db, { kind: 'account.bulk', actor: caller.principal.kind + ':' + caller.principal.username, summary: `Bulk account ${action}: ${targets.length}`,
      detail, idempotencyKey: `account.bulk:${caller.principal.id}:${operationId}`, maxAttempts: 1 })
  } catch (error) {
    if (isXpanelError(error) && error.code === 'CONFLICT') return fail('CONFLICT', 'this operation id was already used for a different bulk request', { ...unchanged, reason: 'operation_id_reused' })
    throw error
  }
  if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') return json(view(job, operationId, action, targets, true))
  const workerId = 'account-bulk-' + randomUUID()
  let lease: DurableJobRecord | null
  try { lease = await acquireJobLease(ports.db, { jobId: job.id, workerId, leaseDurationMs: LEASE_MS }) }
  catch (error) {
    if (isXpanelError(error) && error.code === 'CONFLICT') return fail('CONFLICT', 'this bulk operation is still running; read it again later', { ...unchanged, reason: 'operation_running', reference: job.referenceCode })
    // A lapsed lease marks the job failed for review; the interrupted run is reported, never repeated.
    if (isXpanelError(error) && error.code === 'PRECONDITION_FAILED') return json(view(await getDurableJob(ports.db, job.id) ?? job, operationId, action, targets, true))
    throw error
  }
  if (!lease) return fail('CONFLICT', 'this bulk operation is unavailable', unchanged)
  const held = { jobId: lease.id, workerId, fencingToken: lease.fencingToken }
  const journal = async (step: string, data: Record<string, unknown>): Promise<void> => {
    await renewJobLease(ports.db, { ...held, leaseDurationMs: LEASE_MS })
    await saveJobCheckpoint(ports.db, { ...held, step, data })
  }
  const results: AccountBulkResult[] = []
  let stopped = false, attempted = false
  try {
    // One account at a time: each change runs a host reconcile, and a 1 vCPU host gains nothing from overlap.
    for (const [index, target] of targets.entries()) {
      if (stopped) { results.push(notAttempted(target.id)); continue }
      let fresh: AuthenticatedCaller
      try {
        fresh = await ports.requireCaller(request)
        if (fresh.principal.id !== caller.principal.id) fail('FORBIDDEN', 'bulk account authority changed', unchanged)
      } catch (error) {
        stopped = true
        results.push(notAttempted(target.id, isXpanelError(error) ? error.code : 'FORBIDDEN', 'authority_changed'))
        continue
      }
      await journal('attempt-' + index, { attempting: target.id })
      attempted = true
      const result = await runOne(ports, fresh, action, target, params)
      results.push(result)
      await journal('result-' + index, { attempting: null, results })
      if (result.outcome === 'review-required') stopped = true
    }
    const changed = results.every(item => item.outcome === 'applied')
    const finished = await completeJobWithLease(ports.db, { ...held, status: changed ? 'succeeded' : 'failed',
      ...(changed ? {} : { error: `${results.filter(item => item.outcome !== 'applied').length} of ${targets.length} accounts were not changed` }),
      needsAttention: results.some(item => item.outcome === 'review-required'), detail: { ...detail, outcome: stopped ? 'stopped' : 'completed', results } })
    return json(view(finished, operationId, action, targets, false))
  } catch (error) {
    return fail('SERVICE_UNAVAILABLE', 'the bulk operation record could not be updated; review these accounts before retrying', {
      stateChanged: attempted, verificationRequired: true, reason: 'operation_journal_unavailable',
      results: targets.map((target, index) => results[index] ?? notAttempted(target.id)),
    })
  }
}
