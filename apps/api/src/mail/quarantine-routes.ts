import { fail } from '@xpanel/core'
import type { Id } from '@xpanel/core'
import type { AuthenticatedCaller } from '../auth.ts'
import type { ExtendedRouteHelpers } from '../extended-routes.ts'
import { assertAccountFeatures, isMailboxPrincipal } from '../authorization.ts'
import { parseQuarantineMutation, quarantineIdentity } from '../../../../packages/core/src/mail-quarantine.ts'
import type { QuarantineScope, QuarantineReadResult, QuarantineMutation, QuarantineActionResult, QuarantineExpiryResult } from '../../../../packages/core/src/mail-quarantine.ts'

export interface QuarantineGateway {
  list: (caller: AuthenticatedCaller, scope: QuarantineScope, options: { beforeUid?: number }) => Promise<QuarantineReadResult>
  release: (caller: AuthenticatedCaller, scope: QuarantineScope, input: QuarantineMutation) => Promise<QuarantineActionResult>
  delete: (caller: AuthenticatedCaller, scope: QuarantineScope, input: QuarantineMutation) => Promise<QuarantineActionResult>
  expire: (caller: AuthenticatedCaller, scope: QuarantineScope, revision: string, beforeUid?: number) => Promise<QuarantineExpiryResult>
}
export interface QuarantineRoutePorts extends Pick<ExtendedRouteHelpers, 'store' | 'requireCaller' | 'emitAudit'> {
  requireAccountId: (caller: AuthenticatedCaller, requested: Id | null | undefined, action: string) => Promise<Id>
  gateway?: QuarantineGateway
}
const object = quarantineIdentity.object
const address = (value: unknown): string => quarantineIdentity.address(value)
  ? value : fail('VALIDATION', 'mailbox must be a canonical address', { stateChanged: false })
const revision = (value: unknown): string => quarantineIdentity.hash(value)
  ? value : fail('VALIDATION', 'saved quarantine revision is required', { stateChanged: false })
const beforeUid = (value: unknown): number | undefined => {
  if (value === undefined || value === null) return undefined
  const number = quarantineIdentity.uidText(value) ? Number(value) : value
  return quarantineIdentity.integer(number, 1)
    ? number : fail('VALIDATION', 'beforeUid must be a positive UID', { stateChanged: false })
}
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const readBody = async (request: Request): Promise<Record<string, unknown>> => {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return fail('VALIDATION', 'application/json is required', { stateChanged: false })
  const chunks: Uint8Array[] = [], reader = request.body?.getReader()
  let length = 0
  if (reader) try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > 16384) {
        await reader.cancel().catch(() => {})
        return fail('VALIDATION', 'quarantine request exceeds the bounded body size', { stateChanged: false })
      }
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  let raw: string
  try { raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) }
  catch { return fail('VALIDATION', 'quarantine request must contain valid UTF-8 JSON', { stateChanged: false }) }
  let value: unknown
  try { value = JSON.parse(raw) } catch { return fail('VALIDATION', 'request body must be valid JSON', { stateChanged: false }) }
  return object(value) ? value : fail('VALIDATION', 'quarantine request must be an object', { stateChanged: false })
}
const assertScope = (actual: QuarantineScope, expected: QuarantineScope, changed: boolean): void => {
  if (!actual || actual.accountId !== expected.accountId || actual.mailbox !== expected.mailbox) fail('PRECONDITION_FAILED', 'quarantine result scope could not be verified', { stateChanged: changed, verificationRequired: changed, unknownOutcome: changed })
}
const assertAction = (result: QuarantineActionResult, scope: QuarantineScope, input: QuarantineMutation, action: 'release' | 'delete'): void => {
  assertScope(result?.scope, scope, true)
  if (!result || !quarantineIdentity.locator(result.locator) || !quarantineIdentity.sameLocator(result.locator, input.locator) || result.sourceRevision !== input.expectedRevision
    || !['released', 'deleted', 'partial', 'unknown'].includes(result.state) || typeof result.stateChanged !== 'boolean' || typeof result.verificationRequired !== 'boolean'
    || result.state === 'released' && (action !== 'release' || result.correction !== 'applied' || result.deliveredToInbox !== true || result.sourcePresent !== false || result.verificationRequired)
    || result.state === 'deleted' && (action !== 'delete' || result.deleted !== true || result.sourcePresent !== false || result.verificationRequired)) {
    fail('PRECONDITION_FAILED', 'quarantine outcome requires review', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
  }
}

/** Native quarantine routes. No JSON-store message simulation or implicit success is used. */
export function createQuarantineRoutes(ports: QuarantineRoutePorts) {
  const resolve = async (request: Request, url: URL, mailboxValue: unknown, action: string) => {
    const caller = await ports.requireCaller(request)
    if (isMailboxPrincipal(caller)) return fail('FORBIDDEN', 'hosting account authorization is required for quarantine', { stateChanged: false })
    const accountId = await ports.requireAccountId(caller, url.searchParams.get('accountId'), action)
    const account = await ports.store.getAccount(accountId)
    if (!account || account.status !== 'active') return fail('NOT_FOUND', 'account is unavailable', { stateChanged: false })
    await assertAccountFeatures(ports.store, caller, account, ['spam-quarantine', 'email-accounts'])
    const users = await ports.store.listServiceUsers(accountId)
    const mailboxes = users.filter(user => user.accountId === accountId && user.services.email).map(user => address(user.login)).sort()
    if (mailboxes.length > 1000) return fail('LIMIT_EXCEEDED', 'quarantine mailbox collection exceeds the supported bound', { stateChanged: false })
    const mailbox = mailboxValue === undefined || mailboxValue === null ? mailboxes[0] ?? null : address(mailboxValue)
    if (mailbox !== null && !mailboxes.includes(mailbox)) return fail('NOT_FOUND', 'mailbox not found', { stateChanged: false })
    return { caller, context: { accountId, mailbox, mailboxes }, scope: mailbox === null ? null : { accountId, mailbox } }
  }
  const audit = (caller: AuthenticatedCaller, scope: QuarantineScope, action: string, result: { state: string; correction?: string; deliveredToInbox?: boolean | null; deleted?: boolean | null; removed?: number }): Promise<unknown> => ports.emitAudit({
    actor: caller.principal.username, principalId: caller.principal.id, action: 'mail.quarantine.' + action,
    target: 'mailbox:' + scope.mailbox, outcome: ['released', 'deleted', 'expired'].includes(result.state) ? 'ok' : 'failed',
    detail: { state: result.state, ...(result.correction === undefined ? {} : { correction: result.correction }), ...(result.deliveredToInbox === undefined ? {} : { deliveredToInbox: result.deliveredToInbox }), ...(result.deleted === undefined ? {} : { deleted: result.deleted }), ...(result.removed === undefined ? {} : { removed: result.removed }) },
  }, { accountId: scope.accountId })
  const nativeOutcome = async <T>(caller: AuthenticatedCaller, scope: QuarantineScope, action: string, execute: () => Promise<T>, verify: (result: T) => void): Promise<T> => {
    try { const result = await execute(); verify(result); return result }
    catch (error) {
      const details = object(error) ? object(error.detail) ? error.detail : object(error.details) ? error.details : {} : {}
      await audit(caller, scope, action, { state: details.stateChanged === false && details.verificationRequired !== true && details.unknownOutcome !== true ? 'refused' : 'unknown' })
      throw error
    }
  }
  return async (request: Request, url: URL, method: string): Promise<Response | null> => {
    const path = url.pathname
    if (path !== '/api/mail/quarantine' && !['/api/mail/quarantine/release', '/api/mail/quarantine/delete', '/api/mail/quarantine/expire'].includes(path)) return null
    await ports.requireCaller(request)
    const allowed = path === '/api/mail/quarantine' ? 'GET' : 'POST'
    if (method !== allowed) return new Response(null, { status: 405, headers: { allow: allowed } })
    for (const key of url.searchParams.keys()) if (!['accountId', 'mailbox', 'beforeUid'].includes(key) || url.searchParams.getAll(key).length !== 1) return fail('VALIDATION', 'unsupported quarantine selector', { stateChanged: false })
    if (method === 'GET') {
      const selected = await resolve(request, url, url.searchParams.get('mailbox'), 'mail.quarantine.read')
      if (!selected.scope) return json({ context: selected.context, quarantine: { state: 'unavailable', reason: 'no_mailboxes' } })
      const cursor = beforeUid(url.searchParams.get('beforeUid'))
      const quarantine = ports.gateway ? await ports.gateway.list(selected.caller, selected.scope, cursor === undefined ? {} : { beforeUid: cursor }) : { state: 'unavailable', scope: selected.scope, reason: 'native_profile_unavailable' } as const
      assertScope(quarantine.scope, selected.scope, false)
      return json({ context: selected.context, quarantine })
    }
    const body = await readBody(request), expiry = path.endsWith('/expire')
    const fields = expiry ? ['mailbox', 'expectedRevision', 'beforeUid'] : ['mailbox', 'locator', 'expectedRevision']
    if (Object.keys(body).some(key => !fields.includes(key)) || body.mailbox === undefined) return fail('VALIDATION', 'unsupported quarantine mutation field or missing mailbox', { stateChanged: false })
    if (url.searchParams.has('mailbox') || url.searchParams.has('beforeUid')) return fail('VALIDATION', 'quarantine mutation selectors belong in its body', { stateChanged: false })
    const action = expiry ? 'expire' : path.endsWith('/release') ? 'release' : 'delete'
    const selected = await resolve(request, url, body.mailbox, 'mail.quarantine.' + action)
    if (!selected.scope || !ports.gateway) return fail('PRECONDITION_FAILED', 'native quarantine is unavailable', { stateChanged: false })
    if (expiry) {
      const expected = revision(body.expectedRevision), cursor = beforeUid(body.beforeUid), scope = selected.scope, gateway = ports.gateway
      const result = await nativeOutcome(selected.caller, scope, 'expire', () => gateway.expire(selected.caller, scope, expected, cursor), result => {
        assertScope(result.scope, scope, true)
        if (!['expired', 'partial'].includes(result.state) || !Number.isSafeInteger(result.considered) || result.considered < 0 || result.considered > 100 || !Array.isArray(result.results) || result.results.length > result.considered || result.removed !== result.results.filter(item => item.state === 'deleted' && item.deleted === true && item.sourcePresent === false).length || result.state === 'expired' && result.results.some(item => item.state !== 'deleted')) return fail('PRECONDITION_FAILED', 'quarantine expiry readback requires review', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
        if (new Set(result.results.map(item => JSON.stringify(item.locator))).size !== result.results.length) return fail('PRECONDITION_FAILED', 'quarantine expiry targets could not be verified', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
        for (const item of result.results) assertScope(item.scope, scope, true)
      })
      await audit(selected.caller, selected.scope, 'expire', result)
      return json({ context: selected.context, result })
    }
    const input = parseQuarantineMutation({ locator: body.locator, expectedRevision: body.expectedRevision })
    const mutationAction = action === 'release' ? 'release' : 'delete'
    const scope = selected.scope, gateway = ports.gateway
    const result = await nativeOutcome(selected.caller, scope, mutationAction, () => gateway[mutationAction](selected.caller, scope, input), result => assertAction(result, scope, input, mutationAction))
    await audit(selected.caller, selected.scope, mutationAction, result)
    return json({ context: selected.context, result })
  }
}
