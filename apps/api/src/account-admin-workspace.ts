import { fail, validateUsername } from '@xpanel/core'
import type { Account, Id, Plan } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'

const VIEW_ROUTE = '/api/accounts/admin'
const REARRANGE_ROUTE = /^\/api\/accounts\/([0-9a-f-]{36})\/rearrange$/
const PASSWORD_ROUTE = '/api/accounts/admin/password-change'
const MAX_USERS = 5000
const unchanged = { stateChanged: false }
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

export interface AccountAdminPorts {
  requireCaller: (request: Request) => Promise<AuthenticatedCaller>
  readJsonBody: (request: Request) => Promise<Record<string, unknown>>
  /** The accounts this caller administers. */
  listAccounts: (caller: AuthenticatedCaller) => Promise<Account[]>
  getPlan: (id: Id) => Promise<Plan | null>
  assertCanModify: (caller: AuthenticatedCaller, account: Account) => Promise<void>
  /** null when the account has no panel identity. */
  readForcedPassword: (account: Account) => Promise<boolean | null>
  setForcedPassword: (account: Account, forced: boolean) => Promise<void>
  audit: (caller: AuthenticatedCaller, account: Account, forced: boolean) => Promise<void>
  /** Rearrange an Account on the host; the reply carries the host job. */
  rearrange: (caller: AuthenticatedCaller, account: Account, root: string) => Promise<unknown>
  /** Settles a move whose job died: finished or back in the old home, by what is on disk. */
  recoverRearrange: (caller: AuthenticatedCaller, account: Account) => Promise<unknown>
}

export interface AccountAdminRow {
  id: Id; username: string; primaryDomain: string; status: Account['status']; home: string
  shell: Account['shell']; planShell: Plan['shell'] | null; shellSource: 'package' | 'override'; forcedPassword: boolean | null; homeMove: string | null
}

export const accountAdminRow = (account: Account, plan: Plan | null, forcedPassword: boolean | null): AccountAdminRow => ({
  id: account.id, username: account.username, primaryDomain: account.primaryDomain, status: account.status, home: account.home, shell: account.shell,
  planShell: plan?.shell ?? null, shellSource: plan && plan.shell === account.shell ? 'package' : 'override', forcedPassword, homeMove: account.homeMove?.to ?? null,
})

/** cPanel's map of users to a flag: exact usernames, each once, at most MAX_USERS. */
export function parseForcedPasswords(body: Record<string, unknown>): { users: Map<string, boolean>; stopOnFailure: boolean } {
  if (Object.keys(body).some(key => key !== 'users' && key !== 'stopOnFailure')) return fail('VALIDATION', 'exactly users and stopOnFailure are accepted', unchanged)
  const raw = body.users, stopOnFailure = body.stopOnFailure ?? false
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof stopOnFailure !== 'boolean') return fail('VALIDATION', 'users must map usernames to true or false', unchanged)
  const entries = Object.entries(raw)
  if (!entries.length || entries.length > MAX_USERS || entries.some(([, value]) => typeof value !== 'boolean')) return fail('VALIDATION', `users must map 1 to ${MAX_USERS} usernames to true or false`, unchanged)
  return { users: new Map(entries.map(([name, value]) => [validateUsername(name), value as boolean])), stopOnFailure }
}

/** GET /api/accounts/admin: the account administration rows. PUT .../password-change: WHM Force Password Change. */
export async function handleAccountAdminRoute(request: Request, url: URL, method: string, ports: AccountAdminPorts, extras: (caller: AuthenticatedCaller) => Promise<Record<string, unknown>> = async () => ({})): Promise<Response | null> {
  const rearrange = REARRANGE_ROUTE.exec(url.pathname)
  if (url.pathname !== VIEW_ROUTE && url.pathname !== PASSWORD_ROUTE && !rearrange) return null
  const caller = await ports.requireCaller(request)
  if (rearrange) {
    if (caller.principal.kind !== 'root') return fail('FORBIDDEN', 'root access is required', unchanged)
    if (method !== 'POST' && method !== 'DELETE') return new Response(null, { status: 405, headers: { allow: 'POST, DELETE' } })
    const account = (await ports.listAccounts(caller)).find(item => item.id === rearrange[1]) ?? fail('NOT_FOUND', 'account not found', unchanged)
    if (method === 'DELETE') return json(await ports.recoverRearrange(caller, account))
    const body = await ports.readJsonBody(request)
    if (Object.keys(body).join() !== 'root' || typeof body.root !== 'string') return fail('VALIDATION', 'exactly root is required', unchanged)
    return json(await ports.rearrange(caller, account, body.root))
  }
  if (caller.principal.kind !== 'root' && caller.principal.kind !== 'reseller') return fail('FORBIDDEN', 'hosting administrator permission is required', unchanged)
  if (url.search) return fail('VALIDATION', 'account administration takes no selectors', unchanged)
  if (url.pathname === VIEW_ROUTE) {
    if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
    const rows: AccountAdminRow[] = []
    for (const account of await ports.listAccounts(caller)) rows.push(accountAdminRow(account, await ports.getPlan(account.planId), await ports.readForcedPassword(account)))
    return json({ accounts: rows, ...await extras(caller) })
  }
  if (method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'PUT' } })
  const { users, stopOnFailure } = parseForcedPasswords(await ports.readJsonBody(request))
  const visible = new Map((await ports.listAccounts(caller)).map(account => [account.username, account]))
  const updated: { username: string; forced: boolean }[] = [], failed: { username: string; reason: string }[] = []
  let stopped = false
  for (const [username, forced] of users) {
    if (stopped) { failed.push({ username, reason: 'not_attempted' }); continue }
    try {
      const account = visible.get(username) ?? fail('NOT_FOUND', 'account not found', { ...unchanged, reason: 'account_not_found' })
      await ports.assertCanModify(caller, account)
      if (await ports.readForcedPassword(account) === null) fail('PRECONDITION_FAILED', 'the account has no panel identity', { ...unchanged, reason: 'identity_unavailable' })
      await ports.setForcedPassword(account, forced)
      await ports.audit(caller, account, forced)
      updated.push({ username, forced })
    } catch (error) {
      const detail = (error as { detail?: { reason?: unknown } }).detail
      failed.push({ username, reason: typeof detail?.reason === 'string' ? detail.reason : 'refused' })
      stopped = stopOnFailure
    }
  }
  return json({ updated, failed })
}
