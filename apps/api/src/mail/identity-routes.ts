import { randomUUID } from 'node:crypto'
import { fail, isXpanelError, type MailboxMetadataAuthority } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from '../auth.ts'
import type { ExtendedRouteHelpers, WebmailIdentity } from '../extended-routes.ts'
import { assertAccountFeatures, isMailboxPrincipal, requireMailbox, requireMailboxPrincipalAccess } from '../authorization.ts'
import { assertMailboxMetadataAuthority, boundMailboxIdentityRecords, captureMailboxMetadataAuthority, MAILBOX_METADATA_REVIEW_REQUIRED } from './metadata-authority.ts'

type IdentityLease = Awaited<ReturnType<ReturnType<StateStore['getWriterLock']>['acquire']>>
export interface IdentityMetadataRoutesDependencies {
  helpers: Pick<ExtendedRouteHelpers, 'store' | 'requireCaller' | 'assertCanAccessAccount' | 'emitAudit'>
  readRecords: () => Promise<WebmailIdentity[]>
  publishRecords: (records: WebmailIdentity[], lease: IdentityLease) => Promise<void>
}

const text = (value: unknown, field: string, maximum: number): string => {
  if (typeof value !== 'string' || !value.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value) || Buffer.byteLength(value, 'utf8') > maximum) {
    return fail('VALIDATION', `${field} must be bounded text of at most ${maximum} bytes`, { stateChanged: false })
  }
  return value
}
const email = (value: unknown, field: string): string => {
  const result = text(value, field, 254).trim().toLowerCase()
  if (!/^[^\s@/\\]+@[^\s@/\\]+$/.test(result)) return fail('VALIDATION', `${field} must be a valid email address`, { stateChanged: false })
  return result
}
const displayName = (value: unknown, fallback: string): string => {
  if (value === undefined) return fallback
  const result = text(value, 'displayName', 200)
  if (/[\t\n\r]/.test(result)) return fail('VALIDATION', 'displayName must be a single line of bounded text', { stateChanged: false })
  return result.trim() || fallback
}
const bodyOf = async (req: Request): Promise<Record<string, unknown>> => {
  if (req.body === null) return {}
  let value: unknown
  try { value = await req.json() } catch { return fail('VALIDATION', 'identity request must be JSON', { stateChanged: false }) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('VALIDATION', 'identity request must be an object', { stateChanged: false })
  return value as Record<string, unknown>
}
const keys = (body: Record<string, unknown>, allowed: readonly string[]) => {
  if (Object.keys(body).some(key => !allowed.includes(key))) fail('VALIDATION', 'unsupported identity request field', { stateChanged: false })
}
const rows = (records: WebmailIdentity[]): WebmailIdentity[] => {
  if (!Array.isArray(records) || records.length > 10000 || records.some(record => !record || typeof record !== 'object' || typeof record.id !== 'string' || typeof record.mailbox !== 'string') || new Set(records.map(record => record.id)).size !== records.length) {
    return fail('PRECONDITION_FAILED', 'identity collection requires review', { stateChanged: false })
  }
  return records
}
export const projectMailboxIdentity = (record: WebmailIdentity) => ({
  id: record.id, mailbox: record.mailbox, displayName: record.displayName, email: record.email, replyTo: record.replyTo,
  textSignature: record.textSignature, htmlSignature: record.htmlSignature, isDefault: record.isDefault, createdAt: record.createdAt,
})
const sameCaller = (a: AuthenticatedCaller, b: AuthenticatedCaller) => a.principal.id === b.principal.id && a.principal.kind === b.principal.kind && a.sessionId === b.sessionId && a.apiTokenId === b.apiTokenId
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })

export const createIdentityMetadataRoutes = (deps: IdentityMetadataRoutesDependencies) => async (req: Request): Promise<Response | null> => {
  const url = new URL(req.url), method = req.method.toUpperCase()
  const item = /^\/api\/webmail\/identities\/([^/]+)$/.exec(url.pathname)
  if (url.pathname !== '/api/webmail/identities' && !item) return null
  if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method) || method === 'POST' && item) return null
  const caller = await deps.helpers.requireCaller(req)

  const mutate = async (mailbox: string, action: string, operation: (records: WebmailIdentity[], authority: MailboxMetadataAuthority) => { records: WebmailIdentity[]; identity: WebmailIdentity }): Promise<WebmailIdentity> => {
    const selected = await captureMailboxMetadataAuthority(deps.helpers.store, mailbox)
    const lease = await deps.helpers.store.getWriterLock().acquire()
    let writeAttempted = false
    let saved: WebmailIdentity | undefined
    let auditCaller = caller
    let auditResellerId: string | null = null
    try {
      const fresh = await deps.helpers.requireCaller(req)
      if (!sameCaller(caller, fresh)) return fail('FORBIDDEN', 'identity authorization changed', { stateChanged: false })
      const authority = await captureMailboxMetadataAuthority(deps.helpers.store, mailbox)
      assertMailboxMetadataAuthority(mailbox, selected, authority)
      if (isMailboxPrincipal(fresh)) {
        const bound = await requireMailboxPrincipalAccess(deps.helpers.store, fresh)
        if (bound.mailbox !== mailbox || bound.serviceUserId !== authority.serviceUserId || bound.account.id !== authority.accountId) return fail('NOT_FOUND', 'mailbox not found')
      } else {
        const account = await deps.helpers.store.getAccount(authority.accountId)
        if (!account || account.status !== 'active') return fail('NOT_FOUND', 'mailbox not found')
        await deps.helpers.assertCanAccessAccount(fresh, account, 'mailbox.access')
        await assertAccountFeatures(deps.helpers.store, fresh, account, ['email-accounts'])
      }
      const result = operation(rows(await deps.readRecords()), authority)
      await lease.assertFencingToken()
      writeAttempted = true
      await deps.publishRecords(result.records, lease)
      await lease.assertFencingToken()
      const account = await deps.helpers.store.getAccount(authority.accountId)
      saved = result.identity
      auditCaller = fresh
      auditResellerId = account?.ownerId ?? null
    } catch (error) {
      if (writeAttempted) return fail('SERVICE_UNAVAILABLE', 'identity write requires verification', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
      if (isXpanelError(error)) return fail(error.code, error.message, { ...error.detail, stateChanged: false })
      throw error
    } finally { await lease.release() }
    if (!saved) return fail('SERVICE_UNAVAILABLE', 'identity write requires verification', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    try {
      await deps.helpers.emitAudit({ actor: auditCaller.principal.username, action, target: `identity:${saved.email}`, outcome: 'ok', principalId: auditCaller.principal.id },
        { accountId: selected.accountId, resellerId: auditResellerId })
    } catch { return fail('SERVICE_UNAVAILABLE', 'identity audit requires verification', { stateChanged: true, verificationRequired: true, unknownOutcome: true }) }
    return saved
  }

  if (method === 'GET') {
    const mailbox = await requireMailbox(deps.helpers.store, caller, url.searchParams.get('mailbox'))
    const authority = await captureMailboxMetadataAuthority(deps.helpers.store, mailbox)
    const visible = boundMailboxIdentityRecords(rows(await deps.readRecords()), authority)
    if (item) {
      const target = visible.find(record => record.id === item[1])
      if (!target) return fail('NOT_FOUND', 'identity not found')
      return json({ identity: projectMailboxIdentity(target), metadataReview: MAILBOX_METADATA_REVIEW_REQUIRED })
    }
    return json({ identities: visible.map(projectMailboxIdentity), metadataReview: MAILBOX_METADATA_REVIEW_REQUIRED })
  }

  const body = await bodyOf(req)
  if (method === 'POST') {
    keys(body, ['mailbox', 'displayName', 'email', 'replyTo', 'textSignature', 'htmlSignature', 'isDefault'])
    if (body.mailbox !== undefined && typeof body.mailbox !== 'string') return fail('VALIDATION', 'mailbox must be an email address', { stateChanged: false })
    const address = email(body.email, 'email')
    const mailbox = await requireMailbox(deps.helpers.store, caller, (isMailboxPrincipal(caller) ? body.mailbox : body.mailbox ?? address) as string | undefined)
    if (address !== mailbox) return fail('FORBIDDEN', 'identity email must match its authorized mailbox')
    if (body.isDefault !== undefined && typeof body.isDefault !== 'boolean') return fail('VALIDATION', 'isDefault must be a boolean', { stateChanged: false })
    const fields = { displayName: displayName(body.displayName, mailbox), email: address,
      replyTo: body.replyTo === undefined ? address : email(body.replyTo, 'replyTo'),
      textSignature: body.textSignature === undefined ? '' : text(body.textSignature, 'textSignature', 20000),
      htmlSignature: body.htmlSignature === undefined ? '' : text(body.htmlSignature, 'htmlSignature', 20000) }
    const identity = await mutate(mailbox, 'webmail.identity.created', (records, authority) => {
      const scoped = boundMailboxIdentityRecords(records, authority)
      if (scoped.length >= 50 || records.length >= 10000) return fail('LIMIT_EXCEEDED', 'identity capacity requires review', { stateChanged: false })
      const isDefault = (body.isDefault as boolean | undefined) ?? scoped.length === 0
      const identity: WebmailIdentity = { id: randomUUID(), mailbox, ownerAuthority: authority, ...fields, isDefault, createdAt: new Date().toISOString() }
      const scopedIds = new Set(scoped.map(record => record.id))
      return { identity, records: [...records.map(record => isDefault && scopedIds.has(record.id) ? { ...record, isDefault: false } : record), identity] }
    })
    return json({ identity: projectMailboxIdentity(identity), metadataReview: MAILBOX_METADATA_REVIEW_REQUIRED }, 201)
  }

  keys(body, method === 'DELETE' ? ['id'] : ['id', 'mailbox', 'displayName', 'email', 'replyTo', 'textSignature', 'htmlSignature', 'isDefault'])
  const targetId = item?.[1] ?? url.searchParams.get('id') ?? body.id
  if (typeof targetId !== 'string' || body.id !== undefined && body.id !== targetId) return fail('VALIDATION', 'identity target must be unambiguous', { stateChanged: false })
  const selected = rows(await deps.readRecords()).find(record => record.id === targetId)
  if (!selected) return fail('NOT_FOUND', 'identity not found')
  const mailbox = await requireMailbox(deps.helpers.store, caller, selected.mailbox)
  const identity = await mutate(mailbox, method === 'DELETE' ? 'webmail.identity.deleted' : 'webmail.identity.updated', (records, authority) => {
    const target = records.find(record => record.id === targetId)
    if (!target) return fail('NOT_FOUND', 'identity not found')
    assertMailboxMetadataAuthority(target.mailbox, target.ownerAuthority, authority)
    const scoped = boundMailboxIdentityRecords(records, authority)
    const scopedIds = new Set(scoped.map(record => record.id))
    if (method === 'DELETE') {
      let promoted = false
      return { identity: target, records: records.filter(record => record.id !== target.id).map(record => {
        if (target.isDefault && !promoted && scopedIds.has(record.id)) { promoted = true; return { ...record, isDefault: true } }
        return record
      }) }
    }
    if (body.mailbox !== undefined && (typeof body.mailbox !== 'string' || body.mailbox.toLowerCase() !== mailbox)) return fail('FORBIDDEN', 'identity mailbox cannot be changed')
    if (body.email !== undefined && email(body.email, 'email') !== mailbox) return fail('FORBIDDEN', 'identity email must match its authorized mailbox')
    if (body.isDefault !== undefined && typeof body.isDefault !== 'boolean') return fail('VALIDATION', 'isDefault must be a boolean', { stateChanged: false })
    if (body.isDefault === false && target.isDefault && !scoped.some(record => record.id !== target.id && record.isDefault)) return fail('VALIDATION', 'at least one default identity is required', { stateChanged: false })
    const updated = { ...target,
      ...(body.displayName === undefined || body.displayName === null ? {} : { displayName: displayName(body.displayName, target.displayName) }),
      ...(body.replyTo === undefined ? {} : { replyTo: email(body.replyTo, 'replyTo') }),
      ...(body.textSignature === undefined ? {} : { textSignature: text(body.textSignature, 'textSignature', 20000) }),
      ...(body.htmlSignature === undefined ? {} : { htmlSignature: text(body.htmlSignature, 'htmlSignature', 20000) }),
      ...(body.isDefault === undefined ? {} : { isDefault: body.isDefault as boolean }),
    }
    return { identity: updated, records: records.map(record => record.id === target.id ? updated : body.isDefault === true && scopedIds.has(record.id) ? { ...record, isDefault: false } : record) }
  })
  return method === 'DELETE' ? json({ ok: true, metadataReview: MAILBOX_METADATA_REVIEW_REQUIRED }) : json({ identity: projectMailboxIdentity(identity), metadataReview: MAILBOX_METADATA_REVIEW_REQUIRED })
}
