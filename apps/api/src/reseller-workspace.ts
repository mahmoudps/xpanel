import { fail, isUuid } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { EmailSender } from './alert-delivery.ts'
import { DeliveryFailure } from './alert-delivery.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

/** Root reseller tools: saved privilege lists, Reset Resellers (apply a list to many) and Email All Resellers. */
export interface ResellerWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: Pick<StateStore, 'listResellers' | 'listAclLists' | 'saveAclList' | 'deleteAclList' | 'applyAclList'>
  /** The local MTA sender of system mail. */
  email: EmailSender
  /** Re-indexes resellers after their privileges changed. */
  reindex: () => Promise<void>
}

const LIST_ROUTE = /^\/api\/resellers\/acl-lists\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})(\/apply)?$/
const SUBJECT_MAX = 200, BODY_MAX = 20_000
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const body = async (request: Request, keys: readonly string[]): Promise<Record<string, unknown>> => {
  let value: unknown
  try { value = await request.json() } catch { return fail('VALIDATION', 'a JSON object body is required', { stateChanged: false }) }
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) return fail('VALIDATION', `accepted fields: ${keys.join(', ')}`, { stateChanged: false })
  return value
}

export async function handleResellerWorkspaceRoute(request: Request, url: URL, method: string, helpers: ResellerWorkspaceHelpers): Promise<Response | null> {
  const path = url.pathname, listMatch = LIST_ROUTE.exec(path)
  if (path !== '/api/resellers/acl-lists' && path !== '/api/resellers/email' && !listMatch) return null
  const caller = await helpers.requireCaller(request)
  const audit = (entry: { action: string; target: string; detail: Record<string, unknown> }) => helpers.emitAudit({ actor: caller.principal.username, ...entry, outcome: 'ok', principalId: caller.principal.id })

  if (path === '/api/resellers/acl-lists') {
    await helpers.assertRoot(caller, 'resellers.acl_lists.read')
    if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
    return json({ lists: await helpers.store.listAclLists() })
  }

  if (listMatch) {
    const name = listMatch[1]!
    if (listMatch[2]) {
      await helpers.assertRoot(caller, 'resellers.acl_lists.apply')
      if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
      const input = await body(request, ['resellerIds'])
      if (!Array.isArray(input.resellerIds) || !input.resellerIds.every(id => typeof id === 'string' && isUuid(id))) return fail('VALIDATION', 'resellerIds must list reseller ids', { stateChanged: false })
      const resellers = await helpers.store.applyAclList(name, input.resellerIds as string[])
      await helpers.reindex()
      await audit({ action: 'reseller.acl_list.applied', target: `acl-list:${name}`, detail: { resellers: resellers.map(reseller => reseller.username) } })
      return json({ resellers })
    }
    await helpers.assertRoot(caller, 'resellers.acl_lists.save')
    if (method === 'PUT') {
      const input = await body(request, ['acl'])
      const list = await helpers.store.saveAclList({ name, acl: input.acl })
      await audit({ action: 'reseller.acl_list.saved', target: `acl-list:${name}`, detail: { acl: list.acl } })
      return json({ list })
    }
    if (method === 'DELETE') {
      if (!await helpers.store.deleteAclList(name)) return fail('NOT_FOUND', 'privilege list not found', { stateChanged: false })
      await audit({ action: 'reseller.acl_list.deleted', target: `acl-list:${name}`, detail: {} })
      return json({ ok: true })
    }
    return new Response(null, { status: 405, headers: { allow: 'PUT, DELETE' } })
  }

  await helpers.assertRoot(caller, 'resellers.email')
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  const input = await body(request, ['subject', 'body'])
  const subject = typeof input.subject === 'string' ? input.subject.trim() : ''
  if (!subject || subject.length > SUBJECT_MAX || /[\r\n\0]/.test(subject)) return fail('VALIDATION', `subject must be one line of 1-${SUBJECT_MAX} characters`, { stateChanged: false })
  if (typeof input.body !== 'string' || !input.body.trim() || input.body.length > BODY_MAX || input.body.includes('\0')) return fail('VALIDATION', `body must be 1-${BODY_MAX} characters`, { stateChanged: false })
  const resellers = await helpers.store.listResellers()
  const recipients = resellers.filter(reseller => reseller.contactEmail)
  const withoutContact = resellers.filter(reseller => !reseller.contactEmail).map(reseller => reseller.username)
  if (!recipients.length) return fail('PRECONDITION_FAILED', 'no reseller has a contact email address', { reason: 'reseller_contact_unavailable', withoutContact, stateChanged: false })
  // One message per reseller, so no reseller learns another one's address.
  const sent: string[] = [], failed: { username: string; error: string }[] = []
  for (const reseller of recipients) {
    try { await helpers.email({ to: [reseller.contactEmail!], subject, text: input.body }); sent.push(reseller.username) }
    catch (error) { failed.push({ username: reseller.username, error: error instanceof DeliveryFailure ? error.code : 'unreachable' }) }
  }
  await audit({ action: 'reseller.email.sent', target: 'resellers:all', detail: { subject, sent, failed: failed.map(item => item.username), withoutContact } })
  return json({ sent, failed, withoutContact }, failed.length && !sent.length ? 503 : 200)
}
