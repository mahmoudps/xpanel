import { fail } from '@xpanel/core'
import type { Account, Plan } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import type { TerminalExecution } from './ops-terminal-workspace.ts'
import type { TerminalRegistry, TerminalTickets } from './terminal-sessions.ts'

export const ACCOUNT_TERMINAL_PATH = '/api/account/terminal'

export interface AccountTerminalHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller'> {
  store: { getAccount(id: string): Promise<Account | null>; getPlan(id: string): Promise<Plan | null> }
  readExecution: (caller: AuthenticatedCaller) => Promise<TerminalExecution>
  tickets: TerminalTickets
  registry: TerminalRegistry
}

const unchanged = { stateChanged: false }
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

/**
 * The account owner's jailed shell. Only the owner's own interactive session, never a team member, a handed-off
 * session or an API token; the account comes from the session, never from the request. The shell itself runs as
 * the account user in its slice and jail (agent terminal-sessions.ts).
 */
export async function handleAccountTerminalRoute(request: Request, url: URL, method: string, helpers: AccountTerminalHelpers): Promise<Response | null> {
  if (url.pathname !== ACCOUNT_TERMINAL_PATH) return null
  if (url.search) return fail('VALIDATION', 'the account terminal accepts no selectors', unchanged)
  const caller = await helpers.requireCaller(request)
  if (caller.principal.kind !== 'user' || !caller.principal.accountId) return fail('FORBIDDEN', 'the account terminal is opened by the account owner', unchanged)
  if (caller.sessionId === null || caller.apiTokenId !== null || caller.team || caller.impersonator) return fail('FORBIDDEN', 'the account terminal requires the owner\'s signed-in interactive session', unchanged)
  const account = await helpers.store.getAccount(caller.principal.accountId)
  if (!account) return fail('FORBIDDEN', 'the account is not available', unchanged)
  const plan = await helpers.store.getPlan(account.planId)
  const shell = plan?.shell === 'jailed' && account.shell === 'jailed' && account.status === 'active' ? 'jailed' : 'disabled'

  if (method === 'GET') {
    if (request.body) return fail('VALIDATION', 'the capability read accepts no body', unchanged)
    return json(200, {
      account: { username: account.username, uid: account.uid, home: account.home, slice: `xpanel-${account.uid}.slice` },
      shell, audit: 'enabled',
      execution: await helpers.readExecution(caller),
      session: { open: helpers.registry.has(caller.principal.id) },
    })
  }
  if (method === 'DELETE') return json(200, { closed: helpers.registry.close(caller.principal.id) })
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST, DELETE' } })
  const text = await request.text()
  if (text && text !== '{}') return fail('VALIDATION', 'opening the account terminal accepts no fields', unchanged)
  const origin = request.headers.get('origin')
  if (!origin) return fail('FORBIDDEN', 'the terminal request must come from the panel page', unchanged)
  if (shell !== 'jailed') return fail('FORBIDDEN', 'shell access is disabled for this account', unchanged)
  const execution = await helpers.readExecution(caller)
  if (execution.state !== 'available') return fail('PRECONDITION_FAILED', 'terminal sessions are unavailable on this server', { ...unchanged, reason: execution.reason })
  if (helpers.registry.has(caller.principal.id)) return fail('CONFLICT', 'a terminal session is already open; close it first', unchanged)
  const ticket = helpers.tickets.issue({ kind: 'account', principalId: caller.principal.id, actor: caller.principal.username, panelSessionId: caller.sessionId, origin, accountId: account.id, accountUsername: account.username })
  return json(201, { ticket, execution })
}
