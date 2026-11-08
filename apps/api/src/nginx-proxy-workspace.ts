import { BlockList, isIP } from 'node:net'
import { join } from 'node:path'
import { assertProxyOptions, fail } from '@xpanel/core'
import type { Account, Domain, ServerSettings } from '@xpanel/core'
import { edge } from '@xpanel/render'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { workspaceJson } from './account-ssh-workspace.ts'
import { nextEdgeCacheRecord, readEdgeBody, reconcileOutcome, systemResolve } from './account-edge-workspace.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { edgeRevision, edgeStatePath, readEdgeCacheRecord } from '../../agent/src/account-edge.ts'
import { PROXY_RULES_MAX, proxyRulesPath, readProxyRulesRecord } from '../../agent/src/proxy-rules.ts'
import type { ProxyRuleEntry, ProxyRulesRecord } from '../../agent/src/proxy-rules.ts'

export const NGINX_PROXY_PATH = '/api/server/nginx-proxy'
const DOMAIN_ROUTE = /^\/api\/server\/nginx-proxy\/domains\/([a-z0-9.-]{1,253})$/
const CACHE_ROUTE = NGINX_PROXY_PATH + '/cache'
const BULK_MAX = 500
export interface NginxProxyPorts extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'emitAudit' | 'triggerReconcile'> {
  store: StateStore
  assertRoot(caller: AuthenticatedCaller, action: string): Promise<void>
  /** Host name to addresses; the default asks the system resolver with a bound. */
  resolveHost?: (name: string) => Promise<string[]>
  now?: () => Date
}
const unchanged = { stateChanged: false }
const field = (message: string, name: string, code: string): never => fail('VALIDATION', message, { ...unchanged, fields: [{ field: name, code }] })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const revisionOf = (value: unknown): string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : field('the exact read revision is required', 'expectedRevision', 'revision')
const readRaw = async (store: Pick<StateStore, 'rootDir'>, path: string): Promise<unknown> => {
  try { return await readJsonIfExists<unknown>(join(store.rootDir, path)) } catch { return fail('PRECONDITION_FAILED', 'saved edge configuration is unreadable; review it before changing it', unchanged) }
}
const TARGET_MESSAGE: Record<string, string> = {
  invalid: 'use http(s)://host[:port] without a path, credentials or query', loopback: 'a rule cannot reach this server through loopback',
  forbidden_range: 'link-local, multicast and mapped addresses are not available', panel_port: 'a rule cannot reach a panel or web backend port',
  resolver_unavailable: 'this server has no DNS resolver for named targets; use the IP address', own_address: 'a rule cannot reach this server through its own address',
  unresolved: 'the target host name could not be resolved', resolves_internal: 'the target host name resolves to this server or to an address that is not available',
}

/** Rule target policy, including what only the API can see: this server's own addresses and the name's current addresses. */
export async function proxyRuleTargetProblem(target: unknown, settings: ServerSettings, own: readonly string[], resolve: (name: string) => Promise<string[]>): Promise<string | null> {
  const refusal = edge.proxyRuleRefusal(target, settings)
  if (refusal) return refusal
  const { host } = edge.parseUpstream(target, 'proxy rule target')
  // BlockList compares parsed addresses, so another spelling of an IPv6 address still matches.
  const family = (address: string): 'ipv4' | 'ipv6' => isIP(address) === 6 ? 'ipv6' : 'ipv4', ownList = new BlockList()
  for (const address of own) ownList.addAddress(address, family(address))
  if (isIP(host)) return ownList.check(host, family(host)) ? 'own_address' : null
  let addresses: string[]
  try { addresses = await resolve(host) } catch { return 'unresolved' }
  if (!addresses.length) return 'unresolved'
  // shortcut: DNS is checked at save time only; nginx resolves per request, so a later answer can differ. The port stays refused either way.
  return addresses.some(address => !['public', 'private'].includes(edge.classifyIp(address)) || ownList.check(address, family(address))) ? 'resolves_internal' : null
}

const ruleRow = (rule: ProxyRuleEntry, settings: ServerSettings) => ({ path: rule.path, target: rule.target, websocket: rule.options.websocket, hostHeader: rule.options.hostHeader, refusal: edge.proxyRuleRefusal(rule.target, settings) })
const domainView = (domain: Domain, account: Account, raw: unknown, settings: ServerSettings) => {
  const record = raw === null ? null : readProxyRulesRecord(raw)
  return { domain: { name: domain.name, account: account.username, siteType: domain.siteType }, state: raw === null ? 'default' as const : record ? 'saved' as const : 'invalid' as const,
    revision: edgeRevision(raw), limit: PROXY_RULES_MAX, updatedAt: record?.updatedAt ?? null, rules: (record?.rules ?? []).filter(rule => rule.domain === domain.name).map(rule => ruleRow(rule, settings)) }
}
const cacheRow = (raw: unknown) => {
  const record = raw === null ? null : readEdgeCacheRecord(raw)
  return { state: raw === null ? 'default' as const : record ? 'saved' as const : 'invalid' as const, revision: edgeRevision(raw), enabled: raw === null ? true : record?.enabled ?? null, purgedAt: record?.purgedAt ?? null }
}

async function overview(store: StateStore) {
  const [accounts, domains] = await Promise.all([store.listAccounts(), store.listDomains()])
  const rows = []
  for (const account of accounts.toSorted((a, b) => a.username.localeCompare(b.username))) {
    const raw = await readRaw(store, proxyRulesPath(account.id)), rules = raw === null ? null : readProxyRulesRecord(raw)
    rows.push({ id: account.id, username: account.username, primaryDomain: account.primaryDomain, rules: rules?.rules.length ?? null, cache: cacheRow(await readRaw(store, edgeStatePath('cache', account.id))) })
  }
  const username = new Map(accounts.map(account => [account.id, account.username]))
  return { accounts: rows, domains: domains.filter(domain => domain.kind !== 'alias' && username.has(domain.accountId)).map(domain => ({ name: domain.name, account: username.get(domain.accountId)! })).toSorted((a, b) => a.name.localeCompare(b.name)) }
}

interface Save { path: string; record: unknown }
async function commit(ports: NginxProxyPorts, fresh: () => Promise<void>, plan: () => Promise<Save[]>): Promise<void> {
  const lease = await ports.store.getWriterLock().acquire()
  let attempted = false
  try {
    await fresh()
    const saves = await plan()
    await lease.assertFencingToken()
    for (const save of saves) {
      attempted = true
      await atomicWriteJson(join(ports.store.rootDir, save.path), save.record, 0o640, async () => { await fresh(); await lease.assertFencingToken() })
      if (JSON.stringify(await readRaw(ports.store, save.path)) !== JSON.stringify(save.record)) throw new Error('readback_mismatch')
    }
  } catch (error) {
    if (attempted) return fail('SERVICE_UNAVAILABLE', 'the saved edge settings could not be verified; review before retrying', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    throw error
  } finally { await lease.release() }
}

/** WHM NGINX Reverse Proxy Manager: per-domain rules at the edge and each account's response cache; root only. */
export async function handleNginxProxyRoute(req: Request, url: URL, method: string, ports: NginxProxyPorts): Promise<Response | null> {
  const domainMatch = DOMAIN_ROUTE.exec(url.pathname), cacheRoute = url.pathname === CACHE_ROUTE
  if (url.pathname !== NGINX_PROXY_PATH && !domainMatch && !cacheRoute) return null
  const allowed = cacheRoute ? 'POST' : domainMatch ? 'GET, POST' : 'GET'
  if (!allowed.split(', ').includes(method)) return new Response(null, { status: 405, headers: { allow: allowed } })
  if (url.search) return fail('VALIDATION', 'the reverse proxy manager accepts no query selectors', unchanged)
  const first = await ports.requireCaller(req)
  await ports.assertRoot(first, 'server.nginx_proxy')
  const { store } = ports
  if (url.pathname === NGINX_PROXY_PATH) return workspaceJson(await overview(store))
  const fresh = async (): Promise<void> => {
    const again = await ports.requireCaller(req)
    await ports.assertRoot(again, 'server.nginx_proxy')
    if (again.principal.id !== first.principal.id || again.sessionId !== first.sessionId || again.apiTokenId !== first.apiTokenId) fail('FORBIDDEN', 'reverse proxy manager authority changed', unchanged)
  }
  const now = (ports.now ?? (() => new Date()))()
  const done = async (action: string, target: string, detail: Record<string, unknown>): Promise<'requested' | 'failed' | 'not_connected' | 'unknown'> => {
    try { await ports.emitAudit({ actor: first.principal.username, action, target, principalId: first.principal.id, outcome: 'ok', detail }) }
    catch { return fail('SERVICE_UNAVAILABLE', 'the change was saved but its audit record requires review', { stateChanged: true, verificationRequired: true }) }
    return await fresh().then(() => reconcileOutcome(ports, first)).catch(() => 'unknown' as const)
  }
  if (cacheRoute) {
    const body = await readEdgeBody(req, 64 * 1024)
    if (Object.keys(body).sort().join() !== 'accounts,op' || !['purge', 'enable', 'disable'].includes(body.op as string) || !Array.isArray(body.accounts) || !body.accounts.length || body.accounts.length > BULK_MAX
      || !body.accounts.every(item => object(item) && Object.keys(item).sort().join() === 'expectedRevision,username' && typeof item.username === 'string')) return fail('VALIDATION', `a change takes op purge, enable or disable and 1 to ${BULK_MAX} accounts with their read revisions`, unchanged)
    const op = body.op as 'purge' | 'enable' | 'disable', asked = body.accounts as { username: string; expectedRevision: unknown }[]
    if (new Set(asked.map(item => item.username)).size !== asked.length) return fail('VALIDATION', 'an account is listed twice', unchanged)
    const known = new Map((await store.listAccounts()).map(account => [account.username, account]))
    let changed: string[] = []
    await commit(ports, fresh, async () => {
      const saves: Save[] = []
      for (const item of asked) {
        const account = known.get(item.username) ?? fail('NOT_FOUND', 'account not found', unchanged), path = edgeStatePath('cache', account.id), raw = await readRaw(store, path)
        if (edgeRevision(raw) !== revisionOf(item.expectedRevision)) return fail('CONFLICT', 'saved cache settings changed; read them before saving', unchanged)
        const record = nextEdgeCacheRecord(raw, op, now)
        if (record) saves.push({ path, record })
        if (record) changed = [...changed, account.username]
      }
      return saves
    })
    const reconcile = changed.length ? await done('server.nginx_proxy.cache_' + (op === 'purge' ? 'purged' : op === 'enable' ? 'enabled' : 'disabled'), 'server', { accounts: changed.length }) : null
    return workspaceJson({ ...await overview(store), changed: changed.length, reconcile })
  }
  const name = domainMatch![1]!
  const domain = (await store.listDomains()).find(item => item.name === name) ?? fail('NOT_FOUND', 'domain not found', unchanged)
  const account = await store.getAccount(domain.accountId) ?? fail('NOT_FOUND', 'domain not found', unchanged)
  const settings = await store.getServerSettings() ?? fail('PRECONDITION_FAILED', 'server settings are unavailable', { ...unchanged, reason: 'server_settings_unavailable' })
  const path = proxyRulesPath(account.id)
  if (method === 'GET') return workspaceJson(domainView(domain, account, await readRaw(store, path), settings))
  const body = await readEdgeBody(req)
  const expected = revisionOf(body.expectedRevision), keys = Object.keys(body).sort().join()
  if (keys !== 'add,expectedRevision' && keys !== 'expectedRevision,remove') return fail('VALIDATION', 'a change takes expectedRevision and exactly one of add or remove', unchanged)
  if (domain.kind === 'alias') return fail('PRECONDITION_FAILED', 'an alias follows the site of the domain it points at', { ...unchanged, reason: 'domain_alias' })
  let change: (rules: ProxyRuleEntry[]) => ProxyRuleEntry[], action: string, detail: Record<string, unknown>
  if (keys === 'expectedRevision,remove') {
    const remove = body.remove
    if (typeof remove !== 'string') return field('the path is not a saved rule', 'remove', 'not_found')
    action = 'server.nginx_proxy.rule_removed'; detail = { domain: name, path: remove }
    change = rules => rules.some(rule => rule.domain === name && rule.path === remove) ? rules.filter(rule => rule.domain !== name || rule.path !== remove) : field('the path is not a saved rule', 'remove', 'not_found')
  } else {
    if (domain.redirect) return fail('PRECONDITION_FAILED', 'this domain redirects; its redirect takes precedence over a proxy rule', { ...unchanged, reason: 'domain_redirect' })
    const add = body.add
    if (!object(add) || Object.keys(add).sort().join() !== 'hostHeader,path,target,websocket') return fail('VALIDATION', 'a rule takes path, target, websocket and hostHeader', unchanged)
    if (typeof add.path !== 'string' || !edge.PROXY_RULE_PATH.test(add.path)) return field('use / or a lowercase path without a trailing slash', 'path', 'invalid')
    let options: ReturnType<typeof assertProxyOptions>
    try { options = assertProxyOptions({ websocket: add.websocket, hostHeader: add.hostHeader, headers: [] }) } catch { return field('choose the WebSocket and Host header options', 'hostHeader', 'invalid') }
    const own = [...(await store.listServerIps()).map(ip => ip.address), ...(await store.listAccounts()).flatMap(item => [item.ipv4, item.ipv6 ?? null])].filter((address): address is string => !!address && isIP(address) > 0)
    const problem = await proxyRuleTargetProblem(add.target, settings, own, ports.resolveHost ?? systemResolve)
    if (problem) return field(TARGET_MESSAGE[problem]!, 'target', problem)
    const rule = { domain: name, path: add.path, target: add.target as string, options }
    action = 'server.nginx_proxy.rule_added'; detail = { domain: name, path: add.path, target: rule.target }
    change = rules => rules.some(item => item.domain === name && item.path === rule.path) ? field('this path already has a rule', 'path', 'duplicate')
      : rules.length >= PROXY_RULES_MAX ? field(`an account keeps at most ${PROXY_RULES_MAX} rules`, 'path', 'too_many') : [...rules, rule]
  }
  await commit(ports, fresh, async () => {
    const raw = await readRaw(store, path)
    if (edgeRevision(raw) !== expected) return fail('CONFLICT', 'saved rules changed; read them before saving', unchanged)
    const current = raw === null ? [] : readProxyRulesRecord(raw)?.rules ?? fail('PRECONDITION_FAILED', 'saved rules require review before changing them', unchanged)
    const record: ProxyRulesRecord = { version: 1, rules: change(current), updatedAt: now.toISOString() }
    return [{ path, record }]
  })
  const reconcile = await done(action, 'domain:' + name, detail)
  return workspaceJson({ ...domainView(domain, account, await readRaw(store, path), settings), reconcile })
}
