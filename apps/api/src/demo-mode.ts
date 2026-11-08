import { fail } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { assertExpectedRevision, exactKeys, panelConfigFile, panelConfigRevision, panelJson, readPanelConfigBody } from './panel-config-file.ts'
import type { PanelConfigFile } from './panel-config-file.ts'

/**
 * WHM Manage Demo Mode: the listed accounts keep working for reading, but none of their users (owner, team
 * members, mailboxes, API tokens or the command-line API) can change anything. Enforced for every API write in
 * assertRequestAuthorized, never only in the pages. State: extended/panel/demo-mode.json.
 */
export interface DemoModeFields { accountIds: string[] }
export interface DemoModeRecord extends DemoModeFields { version: 1; updatedAt: string }
export interface DemoModeAccount { id: string; username: string; primaryDomain: string; status: string }
export interface DemoModeView { state: 'default' | 'saved' | 'invalid'; accountIds: string[] | null; updatedAt: string | null; revision: string; accounts: DemoModeAccount[] }
export interface DemoModeHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: Pick<StateStore, 'rootDir' | 'getWriterLock' | 'listAccounts'>
  now?: () => Date
}

const ROUTE = '/api/server/demo-mode'
const NAMESPACE = 'demo-mode:v1'
export const DEMO_MODE_MAX_ACCOUNTS = 5000
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const unchanged = { stateChanged: false }

const ids = (value: unknown): string[] | null => Array.isArray(value) && value.length <= DEMO_MODE_MAX_ACCOUNTS && value.every(id => typeof id === 'string' && ID.test(id))
  && new Set(value).size === value.length ? [...value as string[]].sort() : null
const parseRecord = (raw: unknown): DemoModeFields | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>, accountIds = ids(record.accountIds)
  if (!exactKeys(record, ['version', 'accountIds', 'updatedAt']) || record.version !== 1 || typeof record.updatedAt !== 'string' || !STAMP.test(record.updatedAt)
    || !accountIds || accountIds.join() !== (record.accountIds as string[]).join()) return null
  return { accountIds }
}
export const demoModeFile = (store: Pick<StateStore, 'rootDir' | 'getWriterLock'>): PanelConfigFile<DemoModeFields> =>
  panelConfigFile(store, 'demo-mode.json', NAMESPACE, parseRecord, () => ({ accountIds: [] }))

/** Called for every non-read API request after its route policy decided `read`; sign-out stays open. */
export async function assertDemoModeAdmits(store: Pick<StateStore, 'rootDir' | 'getWriterLock'>, caller: AuthenticatedCaller, pathname: string): Promise<void> {
  if (caller.principal.kind !== 'user' || pathname === '/api/auth/logout') return
  let value: DemoModeFields | null
  try { value = (await demoModeFile(store).read()).value } catch { value = null }
  // A showcase account usually has published credentials, so an unverifiable list refuses instead of admitting.
  if (value === null) return fail('FORBIDDEN', 'the demo mode list cannot be verified; changes are refused until root reviews it', { reason: 'demo_mode_unverified', stateChanged: false })
  if (value.accountIds.includes(caller.principal.accountId)) return fail('FORBIDDEN', 'this account is in demo mode: it can be viewed but not changed', { reason: 'demo_mode_readonly', stateChanged: false })
}

const accountsOf = async (store: DemoModeHelpers['store']): Promise<DemoModeAccount[]> => (await store.listAccounts())
  .filter(account => account.status !== 'terminating')
  .map(account => ({ id: account.id, username: account.username, primaryDomain: account.primaryDomain, status: account.status }))
  .sort((left, right) => left.username.localeCompare(right.username)).slice(0, DEMO_MODE_MAX_ACCOUNTS)
const viewOf = (raw: unknown, value: DemoModeFields | null, accounts: DemoModeAccount[]): DemoModeView => ({
  state: raw === null ? 'default' : value ? 'saved' : 'invalid', accountIds: value ? value.accountIds : null,
  updatedAt: value && raw !== null ? (raw as DemoModeRecord).updatedAt : null, revision: panelConfigRevision(NAMESPACE, raw), accounts,
})

/** Root reads and replaces the demo account list; every id must name a current account. */
export async function handleDemoModeRoute(request: Request, url: URL, method: string, helpers: DemoModeHelpers): Promise<Response | null> {
  if (url.pathname !== ROUTE) return null
  const action = method === 'GET' ? 'server.demo_mode.read' : 'server.demo_mode.update'
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  if (method !== 'GET' && method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'GET, PUT' } })
  if (url.search) return fail('VALIDATION', 'demo mode accepts no query selectors', unchanged)
  const file = demoModeFile(helpers.store)
  if (method === 'GET') { const { raw, value } = await file.read(); return panelJson(viewOf(raw, value, await accountsOf(helpers.store))) }
  const body = await readPanelConfigBody(request, 256 * 1024)
  if (!exactKeys(body, ['accountIds', 'expectedRevision'])) return fail('VALIDATION', 'exactly accountIds and expectedRevision are required', unchanged)
  const expected = assertExpectedRevision(body.expectedRevision)
  const accountIds = ids(body.accountIds)
  if (!accountIds) return fail('VALIDATION', `accountIds must list at most ${DEMO_MODE_MAX_ACCOUNTS} distinct account ids`, unchanged)
  const accounts = await accountsOf(helpers.store), known = new Map(accounts.map(account => [account.id, account.username]))
  if (accountIds.some(id => !known.has(id))) return fail('VALIDATION', 'every demo account must be a current account', { ...unchanged, reason: 'unknown_account' })
  const before = (await file.read()).value?.accountIds ?? []
  const next: DemoModeRecord = { version: 1, accountIds, updatedAt: (helpers.now ?? (() => new Date()))().toISOString() }
  const saved = await file.write(next, expected, async () => { await helpers.assertRoot(await helpers.requireCaller(request), action) })
  const enabled = accountIds.filter(id => !before.includes(id)).map(id => known.get(id)!), disabled = before.filter(id => !accountIds.includes(id)).map(id => known.get(id) ?? id)
  try {
    await helpers.emitAudit({ actor: caller.principal.username, action: 'server.demo_mode.updated', target: 'demo-mode', outcome: 'ok', principalId: caller.principal.id,
      detail: { enabled: enabled.slice(0, 50), disabled: disabled.slice(0, 50), demoAccounts: accountIds.length } })
  } catch { return fail('SERVICE_UNAVAILABLE', 'demo mode was saved but its audit record requires review; reload before retrying', { stateChanged: true, verificationRequired: true }) }
  return panelJson(viewOf(saved.raw, saved.value, accounts))
}
