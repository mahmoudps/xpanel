import { assertLine, fail } from '@xpanel/core'
import type { Account, Id, Reseller } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

export const RESELLER_SUSPENSION_ROUTE = /^\/api\/resellers\/([0-9a-f-]{36})\/(suspend|unsuspend)$/i
export interface ResellerSuspensionPorts extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: Pick<StateStore, 'listResellers' | 'updateReseller' | 'listAccounts'>
  /** The single-account suspension path, with its hooks, session revocation and reconcile. */
  setSuspension: (caller: AuthenticatedCaller, account: Account, verb: 'suspend' | 'unsuspend', reason?: string) => Promise<unknown>
  /** Blocks or restores the reseller's own sign-in; disabling revokes its sessions. */
  setLoginDisabled: (id: Id, disabled: boolean) => Promise<void>
}

const unchanged = { stateChanged: false }
/** Marks the accounts this action suspended, so an unsuspend never lifts a suspension somebody else made. */
const suspensionReason = (reseller: Reseller): string => `Reseller ${reseller.username} is suspended`

/** WHM suspendreseller and unsuspendreseller: the reseller's sign-in and every account it owns. One failed account stops nothing. */
export async function handleResellerSuspensionRoute(request: Request, url: URL, method: string, ports: ResellerSuspensionPorts): Promise<Response | null> {
  const match = RESELLER_SUSPENSION_ROUTE.exec(url.pathname)
  if (!match) return null
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  const verb = match[2]!.toLowerCase() as 'suspend' | 'unsuspend', suspend = verb === 'suspend'
  const caller = await ports.requireCaller(request)
  await ports.assertRoot(caller, 'resellers.' + verb)
  const reseller = (await ports.store.listResellers()).find(item => item.id === match[1]!.toLowerCase())
  if (!reseller) return fail('NOT_FOUND', 'reseller not found', unchanged)
  if ((reseller.suspended === true) === suspend) return fail('CONFLICT', suspend ? 'the reseller is already suspended' : 'the reseller is not suspended', unchanged)
  const body = await request.json().catch(() => ({})) as Record<string, unknown>
  if (!body || typeof body !== 'object' || Object.keys(body).some(key => key !== 'reason') || !suspend && body.reason !== undefined) return fail('VALIDATION', 'only a suspension reason is accepted', unchanged)
  const note = body.reason === undefined ? '' : ': ' + assertLine(body.reason, 400, 'suspend reason', { allowEmpty: false })
  const reason = suspensionReason(reseller)
  await ports.setLoginDisabled(reseller.id, suspend)
  const updated = await ports.store.updateReseller(reseller.id, { suspended: suspend })
  const targets = (await ports.store.listAccounts()).filter(account => account.ownerId === reseller.id && (suspend ? account.status === 'active' : account.status === 'suspended' && account.suspendReason?.startsWith(reason)))
  const changed: string[] = [], failed: string[] = []
  for (const account of targets) {
    try { await ports.setSuspension(caller, account, verb, suspend ? reason + note : undefined); changed.push(account.username) }
    catch { failed.push(account.username) }
  }
  await ports.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action: suspend ? 'reseller.suspended' : 'reseller.unsuspended', target: `reseller:${reseller.username}`, detail: { changed, failed }, outcome: failed.length ? 'failed' : 'ok' })
  return new Response(JSON.stringify({ reseller: updated, changed, failed, stateChanged: true }), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}
