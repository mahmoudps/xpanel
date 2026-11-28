import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { assertProxyOptions, fail, MANAGEMENT_BACKEND_PORTS, MANAGEMENT_PUBLIC_PORTS, validateDomainName } from '@xpanel/core'
import type { Account, Domain, ProxyOptions, ServerSettings } from '@xpanel/core'
import { edge } from '@xpanel/render'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { assertAccountFeatures, isMailboxPrincipal } from './authorization.ts'
import { systemResolve } from './account-edge-workspace.ts'
import { proxyRuleTargetProblem } from './nginx-proxy-workspace.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { readRuntimeRegistry } from '../../agent/src/account-runtime.ts'
import { edgeRevision } from '../../agent/src/account-edge.ts'
import { PROXY_RULES_MAX, proxyRulesPath, readProxyRulesRecord } from '../../agent/src/proxy-rules.ts'
import type { ProxyRuleEntry, ProxyRulesRecord } from '../../agent/src/proxy-rules.ts'

export const ACCOUNT_PROXY_RULES_PATH = '/api/account/domains/proxy-rules'
export const ACCOUNT_PROXY_PROJECTS_PATH = '/api/account/proxy-projects'
export const PROXY_PROJECTS_STATE_DIR = 'extended/edge/proxy-projects'
export const PROXY_PROJECTS_MAX = 32
export const PROXY_PROJECT_RULES_MAX = 32

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DOMAIN_OR_ID_ROUTE = /^\/api\/account\/domains\/proxy-rules\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9.-]{1,253})$/
const PROJECT_ROUTE = /^\/api\/account\/proxy-projects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(rules))?$/
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
const unchanged = { stateChanged: false }

export interface ProxyProjectRule {
  id: string
  path: string
  target: string
  websocket: boolean
  hostHeader: 'client' | 'upstream'
  headers: { name: string; value: string }[]
}

export interface ProxyProjectRecord {
  id: string
  accountId: string
  name: string
  domains: string[]
  note: string
  ssl: { enabled: boolean; certificateId: string | null }
  cache: boolean
  gzip: boolean
  rules: ProxyProjectRule[]
  createdAt: string
  updatedAt: string
}

export interface ProxyProjectsFileRecord {
  rulesVersion: 1
  projects: ProxyProjectRecord[]
  updatedAt: string
}

export interface AccountProxyProjectsPorts extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'emitAudit' | 'triggerReconcile'> {
  store: Pick<StateStore, 'rootDir' | 'getWriterLock' | 'getAccount' | 'getAccountByUsername' | 'listAccounts' | 'getDomain' | 'listDomains' | 'getServerSettings' | 'listServerIps'>
  assertRoot: (caller: AuthenticatedCaller, action: string) => Promise<void>
  assertCanAccessAccount: (caller: AuthenticatedCaller, account: Account, action: string) => Promise<void>
  resolveHost?: (name: string) => Promise<string[]>
  listAccountRuntimePorts?: (accountId: string) => Promise<readonly number[]>
  verifyNginxConfig?: (caller: AuthenticatedCaller, proposal: unknown) => Promise<{ ok: boolean; error?: string }>
  now?: () => Date
}

const json = (status: number, value: unknown): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

const field = (message: string, name: string, code: string, reason?: string): never =>
  fail('VALIDATION', message, { ...unchanged, ...(reason ? { reason } : {}), fields: [{ field: name, code }] })

const revisionOf = (value: unknown): string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : field('the exact read revision is required', 'expectedRevision', 'revision')

const proxyProjectsPath = (accountId: string): string =>
  UUID.test(accountId) ? PROXY_PROJECTS_STATE_DIR + '/' + accountId + '.json' : fail('VALIDATION', 'account id is invalid', unchanged)

async function readBody(req: Request, maxBytes = 16 * 1024): Promise<Record<string, unknown>> {
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    return fail('VALIDATION', 'JSON is required', unchanged)
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw) > maxBytes) return fail('VALIDATION', 'request body is too large', unchanged)
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return fail('VALIDATION', 'valid JSON is required', unchanged) }
  return object(parsed) ? parsed : fail('VALIDATION', 'a JSON object is required', unchanged)
}

async function readRaw(store: Pick<StateStore, 'rootDir'>, path: string): Promise<unknown> {
  try { return await readJsonIfExists<unknown>(join(store.rootDir, path)) }
  catch { return fail('PRECONDITION_FAILED', 'saved proxy configuration is unreadable; review it before changing it', unchanged) }
}

const normalizeRulePath = (value: unknown): string => {
  if (typeof value !== 'string') return field('use / or a lowercase path without spaces', 'path', 'invalid')
  const trimmed = value.trim()
  const normalized = trimmed.length > 1 && trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
  if (!edge.PROXY_RULE_PATH.test(normalized)) return field('use / or a lowercase path without spaces', 'path', 'invalid')
  return normalized
}

const parseRuleOptions = (body: Record<string, unknown>): ProxyOptions => {
  try {
    return assertProxyOptions({
      websocket: body.websocket ?? true,
      hostHeader: body.hostHeader ?? 'client',
      headers: body.headers ?? [],
    })
  } catch {
    return field('choose valid WebSocket, Host header and extra header options', 'hostHeader', 'invalid')
  }
}

const TARGET_MESSAGES: Readonly<Record<string, string>> = {
  invalid: 'use http(s)://host[:port] without a path, credentials or query',
  loopback: 'loopback addresses are blocked unless targeting an owned application runtime port',
  private_address: 'private network addresses are not available',
  forbidden_range: 'link-local, multicast and mapped addresses are not available',
  panel_port: 'a proxy target cannot reach a panel, SSH or web backend port',
  resolver_unavailable: 'this server has no DNS resolver for named targets; use an IP address',
  own_address: 'a proxy target cannot reach this server through its own address',
  unresolved: 'the target host name could not be resolved',
  resolves_internal: 'the target host name resolves to a private, loopback or server address',
}

/**
 * SSRF & upstream validation for path-scoped rules and proxy projects.
 * Private, loopback, and metadata IPs are blocked for account owners unless the target is
 * 127.0.0.1 or [::1] on an unprivileged port owned by one of the account's own runtimes.
 */
export async function assessAccountProxyTarget(
  target: unknown,
  settings: ServerSettings,
  context: {
    isOwner: boolean
    ownAddresses: readonly string[]
    ownedRuntimePorts?: ReadonlySet<number>
    resolveHost?: (name: string) => Promise<string[]>
  },
): Promise<string | null> {
  let upstream: ReturnType<typeof edge.parseUpstream>
  try { upstream = edge.parseUpstream(target, 'proxy rule target') }
  catch { return 'invalid' }
  if (upstream.path) return 'invalid'
  if (upstream.addressClass === 'forbidden') return 'forbidden_range'
  const panelPorts = new Set([
    settings.panelPort,
    settings.backendPort,
    settings.backendTlsPort,
    settings.sshPort,
    ...MANAGEMENT_PUBLIC_PORTS,
    ...MANAGEMENT_BACKEND_PORTS,
  ])
  if (panelPorts.has(upstream.port)) return 'panel_port'

  if (upstream.addressClass === 'loopback') {
    const ownedPorts = context.ownedRuntimePorts ?? new Set<number>()
    if ((upstream.host === '127.0.0.1' || upstream.host === '::1') && upstream.port >= 1024 && ownedPorts.has(upstream.port)) {
      return null
    }
    return 'loopback'
  }

  if (upstream.hostKind === 'ip' && context.isOwner && upstream.addressClass === 'private') {
    return 'private_address'
  }

  let resolvedPrivate = false
  const resolve = context.resolveHost ?? systemResolve
  const problem = await proxyRuleTargetProblem(target, settings, context.ownAddresses, async name => {
    const addresses = await resolve(name)
    if (context.isOwner && addresses.some(address => edge.classifyIp(address) === 'private')) {
      resolvedPrivate = true
      return ['127.0.0.1']
    }
    return addresses
  })
  return resolvedPrivate ? 'resolves_internal' : problem
}

async function collectOwnedRuntimePorts(ports: AccountProxyProjectsPorts, accountId: string): Promise<Set<number>> {
  const result = new Set<number>()
  if (ports.listAccountRuntimePorts) {
    for (const port of await ports.listAccountRuntimePorts(accountId)) result.add(port)
  }
  try {
    const registry = await readRuntimeRegistry(ports.store.rootDir, accountId)
    for (const app of registry.apps) {
      if (app.enabled && app.project?.port) result.add(app.project.port)
    }
  } catch {
    // Absence or unreadable runtime registry leaves only explicitly supplied ports.
  }
  return result
}

async function collectOwnServerAddresses(store: AccountProxyProjectsPorts['store']): Promise<string[]> {
  const [serverIps, accounts] = await Promise.all([store.listServerIps(), store.listAccounts()])
  return [...serverIps.map(ip => ip.address), ...accounts.flatMap(item => [item.ipv4, item.ipv6 ?? null])]
    .filter((address): address is string => !!address && isIP(address) > 0)
}

function readProxyProjectsRecord(raw: unknown): ProxyProjectsFileRecord | null {
  if (!object(raw) || raw.rulesVersion !== 1 || !Array.isArray(raw.projects) || raw.projects.length > PROXY_PROJECTS_MAX
    || typeof raw.updatedAt !== 'string' || !Number.isFinite(Date.parse(raw.updatedAt))) return null
  for (const project of raw.projects) {
    if (!object(project) || typeof project.id !== 'string' || !UUID.test(project.id)
      || typeof project.accountId !== 'string' || !UUID.test(project.accountId)
      || typeof project.name !== 'string' || project.name.length < 1 || project.name.length > 64 || CONTROL_CHARS.test(project.name)
      || !Array.isArray(project.domains) || project.domains.length < 1 || project.domains.length > 16
      || typeof project.note !== 'string' || project.note.length > 256 || CONTROL_CHARS.test(project.note)
      || !object(project.ssl) || typeof project.ssl.enabled !== 'boolean' || !(project.ssl.certificateId === null || typeof project.ssl.certificateId === 'string')
      || typeof project.cache !== 'boolean' || typeof project.gzip !== 'boolean'
      || !Array.isArray(project.rules) || project.rules.length < 1 || project.rules.length > PROXY_PROJECT_RULES_MAX
      || typeof project.createdAt !== 'string' || typeof project.updatedAt !== 'string') return null
    for (const name of project.domains) {
      if (typeof name !== 'string') return null
      try { if (validateDomainName(name) !== name) return null } catch { return null }
    }
    for (const rule of project.rules) {
      if (!object(rule) || typeof rule.id !== 'string' || !UUID.test(rule.id)
        || typeof rule.path !== 'string' || !edge.PROXY_RULE_PATH.test(rule.path)
        || typeof rule.target !== 'string') return null
      try {
        edge.parseUpstream(rule.target, 'proxy rule target')
        assertProxyOptions({ websocket: rule.websocket, hostHeader: rule.hostHeader, headers: rule.headers })
      } catch { return null }
    }
  }
  return raw as unknown as ProxyProjectsFileRecord
}

async function resolveAccountScope(
  req: Request,
  url: URL,
  ports: AccountProxyProjectsPorts,
  action: string,
  allowAccountQuery: boolean,
  explicitDomainOrId?: string,
  bodyAccount?: unknown,
): Promise<{ caller: AuthenticatedCaller; account: Account; isOwner: boolean }> {
  const caller = await ports.requireCaller(req)
  if (isMailboxPrincipal(caller)) return fail('FORBIDDEN', 'hosting account owner or root access is required', unchanged)
  if (caller.principal.kind === 'user') {
    if (url.searchParams.has('accountId') || url.searchParams.has('account') || bodyAccount !== undefined) {
      return fail('FORBIDDEN', 'account selectors are not allowed for account owners', unchanged)
    }
    const account = await ports.store.getAccount(caller.principal.accountId)
    if (!account || account.id !== caller.principal.accountId || account.status !== 'active') {
      return fail('FORBIDDEN', 'active hosting account owner access is required', unchanged)
    }
    await ports.assertCanAccessAccount(caller, account, action)
    if (typeof (ports.store as Partial<StateStore>).getPlan === 'function') {
      await assertAccountFeatures(ports.store as StateStore, caller, account, ['domains'])
    }
    return { caller, account, isOwner: true }
  }
  if (caller.principal.kind === 'root') {
    await ports.assertRoot(caller, action)
    const requestedId = (allowAccountQuery ? url.searchParams.get('accountId') : null) ?? (typeof bodyAccount === 'string' && UUID.test(bodyAccount) ? bodyAccount : null)
    const requestedUsername = allowAccountQuery ? url.searchParams.get('account') : null
    if (requestedId) {
      const account = await ports.store.getAccount(requestedId)
      if (!account) return fail('NOT_FOUND', 'account not found', unchanged)
      return { caller, account, isOwner: false }
    }
    if (requestedUsername) {
      const account = await ports.store.getAccountByUsername(requestedUsername)
      if (!account) return fail('NOT_FOUND', 'account not found', unchanged)
      return { caller, account, isOwner: false }
    }
    if (explicitDomainOrId) {
      const domains = await ports.store.listDomains()
      const matched = UUID.test(explicitDomainOrId)
        ? domains.find(item => item.id === explicitDomainOrId)
        : domains.find(item => item.name === explicitDomainOrId)
      if (!matched) return fail('NOT_FOUND', 'domain not found', unchanged)
      const account = await ports.store.getAccount(matched.accountId)
      if (!account) return fail('NOT_FOUND', 'domain not found', unchanged)
      return { caller, account, isOwner: false }
    }
    return fail('VALIDATION', 'select an account with accountId or account', unchanged)
  }
  return fail('FORBIDDEN', 'hosting account owner or root access is required', unchanged)
}

async function commitWithNginxVerification<T>(
  ports: AccountProxyProjectsPorts,
  path: string,
  fresh: () => Promise<AuthenticatedCaller>,
  expectedRevision: string,
  buildNext: (raw: unknown) => Promise<T>,
  validateReadback: (raw: unknown) => T | null,
  assertTargetExists?: (raw: unknown) => void,
): Promise<{ record: T; reconcile: 'requested' | 'failed' | 'not_connected' | 'unknown' }> {
  const lease = await ports.store.getWriterLock().acquire()
  const filePath = join(ports.store.rootDir, path)
  let previousRaw: unknown = null
  let previousExisted = false
  let written = false
  try {
    const activeCaller = await fresh()
    previousRaw = await readRaw(ports.store, path)
    previousExisted = previousRaw !== null
    assertTargetExists?.(previousRaw)
    if (edgeRevision(previousRaw) !== expectedRevision) {
      return fail('CONFLICT', 'saved proxy configuration changed; read it again before saving', unchanged)
    }
    const nextRecord = await buildNext(previousRaw)
    if (ports.verifyNginxConfig) {
      const precheck = await ports.verifyNginxConfig(activeCaller, nextRecord)
      if (!precheck.ok) {
        return fail('CONFIG_TEST_FAILED', precheck.error ?? 'nginx configuration test failed', { ...unchanged, reason: 'nginx_config_test_failed' })
      }
    }
    await lease.assertFencingToken()
    written = true
    await atomicWriteJson(filePath, nextRecord, 0o640, async () => {
      await fresh()
      await lease.assertFencingToken()
    })
    const savedRaw = await readRaw(ports.store, path)
    if (JSON.stringify(savedRaw) !== JSON.stringify(nextRecord) || !validateReadback(savedRaw)) {
      throw new Error('readback_mismatch')
    }
    const afterCaller = await fresh()
    const reconcileResult = await ports.triggerReconcile(afterCaller)
    if (reconcileResult !== null && !reconcileResult.ok) {
      // Revert to the previous validated configuration if nginx -t / reconcile rejects the change.
      if (previousExisted) {
        await atomicWriteJson(filePath, previousRaw, 0o640)
      } else {
        const { rm } = await import('node:fs/promises')
        await rm(filePath, { force: true })
      }
      await ports.triggerReconcile(afterCaller).catch(() => undefined)
      const errMessage = typeof reconcileResult.body?.error === 'string' ? reconcileResult.body.error : 'nginx configuration test failed during reconcile'
      return fail('CONFIG_TEST_FAILED', errMessage, { ...unchanged, reason: 'nginx_config_test_failed' })
    }
    const reconcile = reconcileResult === null ? 'not_connected' : 'requested'
    return { record: nextRecord, reconcile }
  } catch (error) {
    if (written && !(error instanceof Error && 'code' in error && (error as { code?: string }).code === 'CONFIG_TEST_FAILED')) {
      return fail('SERVICE_UNAVAILABLE', 'the proxy configuration write could not be verified; review before retrying', {
        stateChanged: true, verificationRequired: true, unknownOutcome: true,
      })
    }
    throw error
  } finally {
    await lease.release()
  }
}

function projectDomainBlocked(domain: Domain): string | null {
  if (domain.kind === 'alias') return 'domain_alias'
  if (domain.redirect) return 'domain_redirect'
  return null
}

function siteProxyRulesView(
  account: Account,
  domains: readonly Domain[],
  raw: unknown,
  settings: ServerSettings | null,
  runtimePorts: ReadonlySet<number>,
  filterDomain?: Domain,
) {
  const ownedDomains = domains.filter(item => item.accountId === account.id)
  const record = raw === null ? null : readProxyRulesRecord(raw)
  const domainNames = new Set(ownedDomains.map(d => d.name))
  const allRules = (record?.rules ?? [])
    .filter(rule => domainNames.has(rule.domain) && (!filterDomain || rule.domain === filterDomain.name))
    .map(rule => ({
      domainId: ownedDomains.find(d => d.name === rule.domain)?.id ?? null,
      domain: rule.domain,
      path: rule.path,
      target: rule.target,
      websocket: rule.options.websocket,
      hostHeader: rule.options.hostHeader,
      headers: rule.options.headers,
      refusal: settings ? edge.proxyRuleRefusal(rule.target, settings) : null,
    }))
  return {
    context: { accountId: account.id, username: account.username },
    state: raw === null ? 'default' as const : record ? 'saved' as const : 'invalid' as const,
    revision: edgeRevision(raw),
    limit: PROXY_RULES_MAX,
    updatedAt: record?.updatedAt ?? null,
    runtimePorts: [...runtimePorts].sort((a, b) => a - b),
    domains: ownedDomains.map(d => ({ id: d.id, name: d.name, kind: d.kind, siteType: d.siteType, blocked: projectDomainBlocked(d) })),
    ...(filterDomain ? { domain: { id: filterDomain.id, name: filterDomain.name, kind: filterDomain.kind, siteType: filterDomain.siteType, blocked: projectDomainBlocked(filterDomain) } } : {}),
    rules: allRules,
  }
}

function proxyProjectsView(account: Account, raw: unknown, runtimePorts: ReadonlySet<number>) {
  const record = raw === null ? null : readProxyProjectsRecord(raw)
  const projects = (record?.projects ?? []).filter(item => item.accountId === account.id)
  return {
    context: { accountId: account.id, username: account.username },
    state: raw === null ? 'default' as const : record ? 'saved' as const : 'invalid' as const,
    revision: edgeRevision(raw),
    limit: PROXY_PROJECTS_MAX,
    updatedAt: record?.updatedAt ?? null,
    runtimePorts: [...runtimePorts].sort((a, b) => a - b),
    projects,
  }
}

/**
 * Account-owned & root-authorized REST routes for path-scoped site reverse-proxy rules
 * (`/api/account/domains/proxy-rules*`) and standalone proxy projects (`/api/account/proxy-projects*`).
 */
export async function handleAccountProxyProjectsRoute(
  req: Request,
  url: URL,
  method: string,
  ports: AccountProxyProjectsPorts,
): Promise<Response | null> {
  const rulesRoot = url.pathname === ACCOUNT_PROXY_RULES_PATH
  const rulesItemMatch = DOMAIN_OR_ID_ROUTE.exec(url.pathname)
  const projectsRoot = url.pathname === ACCOUNT_PROXY_PROJECTS_PATH
  const projectItemMatch = PROJECT_ROUTE.exec(url.pathname)
  if (!rulesRoot && !rulesItemMatch && !projectsRoot && !projectItemMatch) return null

  if (rulesRoot || rulesItemMatch) {
    const allowed = ['GET', 'POST', 'PUT', 'DELETE']
    if (!allowed.includes(method)) return new Response(null, { status: 405, headers: { allow: allowed.join(', ') } })
    for (const key of url.searchParams.keys()) {
      if (method !== 'GET' || !['accountId', 'account', 'domainId', 'domain'].includes(key)) {
        return fail('VALIDATION', 'unsupported query parameter on proxy rules route', unchanged)
      }
    }
    const body = method === 'GET' ? null : await readBody(req)
    const explicitDomainKey = rulesItemMatch?.[1] ?? (method === 'GET' ? (url.searchParams.get('domainId') ?? url.searchParams.get('domain') ?? undefined) : undefined)
    const action = method === 'GET' ? 'domain.read' : 'domain.modify'
    const scope = await resolveAccountScope(req, url, ports, action, method === 'GET', explicitDomainKey, body?.accountId)
    const { caller, account, isOwner } = scope
    const fresh = async (): Promise<AuthenticatedCaller> => {
      const check = await resolveAccountScope(req, url, ports, action, method === 'GET', explicitDomainKey, body?.accountId)
      if (check.caller.principal.id !== caller.principal.id || check.account.id !== account.id) {
        return fail('FORBIDDEN', 'proxy rule authority changed', unchanged)
      }
      return check.caller
    }
    const path = proxyRulesPath(account.id)
    const domains = await ports.store.listDomains()
    const resolveDomain = (key: unknown): Domain => {
      if (typeof key !== 'string' || !key) return field('choose an owned domain', 'domain', 'required')
      const matched = UUID.test(key)
        ? domains.find(item => item.id === key && item.accountId === account.id)
        : domains.find(item => item.name === key.toLowerCase() && item.accountId === account.id)
      if (!matched) return fail('NOT_FOUND', 'domain not found', unchanged)
      return matched
    }
    const runtimePorts = await collectOwnedRuntimePorts(ports, account.id)

    if (method === 'GET') {
      const settings = await ports.store.getServerSettings()
      const filterDomain = explicitDomainKey ? resolveDomain(explicitDomainKey) : undefined
      return json(200, siteProxyRulesView(account, domains, await readRaw(ports.store, path), settings, runtimePorts, filterDomain))
    }

    const expected = revisionOf(body!.expectedRevision)
    const targetDomain = resolveDomain(rulesItemMatch?.[1] ?? body!.domainId ?? body!.domain)
    const blockedReason = projectDomainBlocked(targetDomain)
    if (blockedReason) return fail('PRECONDITION_FAILED', 'this domain cannot carry proxy rules', { ...unchanged, reason: blockedReason })
    const settings = await ports.store.getServerSettings()
    if (!settings) return fail('PRECONDITION_FAILED', 'server settings are unavailable', { ...unchanged, reason: 'server_settings_unavailable' })
    const rulePath = normalizeRulePath(body!.path)
    const now = (ports.now ?? (() => new Date()))()

    if (method === 'DELETE') {
      const { record, reconcile } = await commitWithNginxVerification<ProxyRulesRecord>(
        ports, path, fresh, expected,
        async raw => {
          const current = raw === null ? [] : readProxyRulesRecord(raw)?.rules ?? fail('PRECONDITION_FAILED', 'saved rules require review before changing them', unchanged)
          if (!current.some(rule => rule.domain === targetDomain.name && rule.path === rulePath)) {
            return field('the path is not a saved rule', 'path', 'not_found')
          }
          return { version: 1, rules: current.filter(rule => rule.domain !== targetDomain.name || rule.path !== rulePath), updatedAt: now.toISOString() }
        },
        readProxyRulesRecord,
      )
      await ports.emitAudit({
        actor: caller.principal.username, action: 'account.proxy_rule.removed', target: 'domain:' + targetDomain.name,
        principalId: caller.principal.id, outcome: 'ok', detail: { domain: targetDomain.name, path: rulePath },
      })
      const view = siteProxyRulesView(account, domains, record, settings, runtimePorts, rulesItemMatch ? targetDomain : undefined)
      return json(200, { ...view, reconcile })
    }

    const options = parseRuleOptions(body!)
    const ownAddresses = await collectOwnServerAddresses(ports.store)
    const targetProblem = await assessAccountProxyTarget(body!.target, settings, {
      isOwner, ownAddresses, ownedRuntimePorts: runtimePorts, resolveHost: ports.resolveHost ?? systemResolve,
    })
    if (targetProblem) {
      return field(TARGET_MESSAGES[targetProblem] ?? TARGET_MESSAGES.invalid!, 'target', targetProblem, 'INVALID_TARGET')
    }
    const nextRule: ProxyRuleEntry = { domain: targetDomain.name, path: rulePath, target: body!.target as string, options }
    const isUpdate = method === 'PUT'
    const { record, reconcile } = await commitWithNginxVerification<ProxyRulesRecord>(
      ports, path, fresh, expected,
      async raw => {
        const current = raw === null ? [] : readProxyRulesRecord(raw)?.rules ?? fail('PRECONDITION_FAILED', 'saved rules require review before changing them', unchanged)
        const exists = current.some(rule => rule.domain === targetDomain.name && rule.path === rulePath)
        if (!isUpdate && exists) return field('this path already has a rule', 'path', 'duplicate')
        if (isUpdate && !exists) return field('the path is not a saved rule', 'path', 'not_found')
        if (!exists && current.length >= PROXY_RULES_MAX) return field(`an account keeps at most ${PROXY_RULES_MAX} rules`, 'path', 'too_many')
        const nextRules = exists
          ? current.map(rule => (rule.domain === targetDomain.name && rule.path === rulePath ? nextRule : rule))
          : [...current, nextRule]
        return { version: 1, rules: nextRules, updatedAt: now.toISOString() }
      },
      readProxyRulesRecord,
    )
    await ports.emitAudit({
      actor: caller.principal.username,
      action: isUpdate ? 'account.proxy_rule.updated' : 'account.proxy_rule.added',
      target: 'domain:' + targetDomain.name,
      principalId: caller.principal.id,
      outcome: 'ok',
      detail: { domain: targetDomain.name, path: rulePath, target: nextRule.target },
    })
    const view = siteProxyRulesView(account, domains, record, settings, runtimePorts, rulesItemMatch ? targetDomain : undefined)
    return json(isUpdate ? 200 : 201, { ...view, reconcile })
  }

  // Standalone proxy projects (/api/account/proxy-projects*)
  const projectId = projectItemMatch?.[1] ?? null
  const rulesSub = projectItemMatch?.[2] === 'rules'
  const allowedMethods = projectsRoot ? ['GET', 'POST'] : rulesSub ? ['POST', 'DELETE'] : ['GET', 'PUT', 'DELETE']
  if (!allowedMethods.includes(method)) return new Response(null, { status: 405, headers: { allow: allowedMethods.join(', ') } })
  for (const key of url.searchParams.keys()) {
    if (method !== 'GET' || !['accountId', 'account'].includes(key)) {
      return fail('VALIDATION', 'unsupported query parameter on proxy projects route', unchanged)
    }
  }
  const body = method === 'GET' ? null : await readBody(req)
  const action = method === 'GET' ? 'domain.read' : 'domain.modify'
  const scope = await resolveAccountScope(req, url, ports, action, method === 'GET', undefined, body?.accountId)
  const { caller, account, isOwner } = scope
  const fresh = async (): Promise<AuthenticatedCaller> => {
    const check = await resolveAccountScope(req, url, ports, action, method === 'GET', undefined, body?.accountId)
    if (check.caller.principal.id !== caller.principal.id || check.account.id !== account.id) {
      return fail('FORBIDDEN', 'proxy project authority changed', unchanged)
    }
    return check.caller
  }
  const path = proxyProjectsPath(account.id)
  const runtimePorts = await collectOwnedRuntimePorts(ports, account.id)

  if (method === 'GET') {
    const raw = await readRaw(ports.store, path)
    const view = proxyProjectsView(account, raw, runtimePorts)
    if (!projectId) return json(200, view)
    const found = view.projects.find(item => item.id === projectId && item.accountId === account.id)
    if (!found) return fail('NOT_FOUND', 'proxy project not found', unchanged)
    return json(200, { context: view.context, state: view.state, revision: view.revision, runtimePorts: view.runtimePorts, project: found })
  }

  const expected = revisionOf(body!.expectedRevision)
  const settings = await ports.store.getServerSettings()
  if (!settings) return fail('PRECONDITION_FAILED', 'server settings are unavailable', { ...unchanged, reason: 'server_settings_unavailable' })
  const now = (ports.now ?? (() => new Date()))()
  const ownAddresses = await collectOwnServerAddresses(ports.store)

  const validateDomains = async (rawDomains: unknown, excludeProjectId?: string): Promise<string[]> => {
    if (!Array.isArray(rawDomains) || rawDomains.length < 1 || rawDomains.length > 16) {
      return field('provide 1 to 16 canonical domain names', 'domains', 'invalid')
    }
    const normalized: string[] = []
    for (const item of rawDomains) {
      if (typeof item !== 'string') return field('each domain must be a valid domain name', 'domains', 'invalid')
      try { normalized.push(validateDomainName(item.trim().toLowerCase())) }
      catch { return field('each domain must be a valid domain name', 'domains', 'invalid') }
    }
    if (new Set(normalized).size !== normalized.length) return field('duplicate domains are not allowed', 'domains', 'duplicate')
    const allDomains = await ports.store.listDomains()
    for (const name of normalized) {
      const existing = allDomains.find(d => d.name === name)
      if (existing && existing.accountId !== account.id) {
        return fail('CONFLICT', 'one of the domains belongs to another account', { ...unchanged, fields: [{ field: 'domains', code: 'domain_taken' }] })
      }
    }
    const existingRaw = await readRaw(ports.store, path)
    const existingProjects = existingRaw ? (readProxyProjectsRecord(existingRaw)?.projects ?? []) : []
    for (const other of existingProjects) {
      if (other.id !== excludeProjectId && other.domains.some(name => normalized.includes(name))) {
        return fail('CONFLICT', 'one of the domains is already assigned to another proxy project', { ...unchanged, fields: [{ field: 'domains', code: 'duplicate' }] })
      }
    }
    return normalized
  }

  if (projectsRoot && method === 'POST') {
    const name = typeof body!.name === 'string' ? body!.name.trim() : ''
    if (name.length < 1 || name.length > 64 || CONTROL_CHARS.test(name)) {
      return field('project name must be 1 to 64 printable characters', 'name', 'invalid')
    }
    const domains = await validateDomains(body!.domains)
    const rulePath = normalizeRulePath(body!.path ?? '/')
    const options = parseRuleOptions(body!)
    const targetProblem = await assessAccountProxyTarget(body!.target, settings, {
      isOwner, ownAddresses, ownedRuntimePorts: runtimePorts, resolveHost: ports.resolveHost ?? systemResolve,
    })
    if (targetProblem) return field(TARGET_MESSAGES[targetProblem] ?? TARGET_MESSAGES.invalid!, 'target', targetProblem, 'INVALID_TARGET')
    const noteText = body!.note === undefined ? '' : typeof body!.note === 'string' && body!.note.length <= 256 && !CONTROL_CHARS.test(body!.note)
      ? body!.note.trim() : field('note must be plain text of at most 256 characters', 'note', 'invalid')
    const cache = body!.cache === undefined ? true : typeof body!.cache === 'boolean' ? body!.cache : field('cache must be a boolean', 'cache', 'invalid')
    const gzip = body!.gzip === undefined ? true : typeof body!.gzip === 'boolean' ? body!.gzip : field('gzip must be a boolean', 'gzip', 'invalid')
    const sslEnabled = body!.ssl === undefined ? false : object(body!.ssl) && typeof body!.ssl.enabled === 'boolean' ? body!.ssl.enabled : typeof body!.ssl === 'boolean' ? body!.ssl : field('ssl must be a boolean or { enabled }', 'ssl', 'invalid')
    const created: ProxyProjectRecord = {
      id: randomUUID(),
      accountId: account.id,
      name,
      domains,
      note: noteText,
      ssl: { enabled: sslEnabled, certificateId: null },
      cache,
      gzip,
      rules: [{ id: randomUUID(), path: rulePath, target: body!.target as string, websocket: options.websocket, hostHeader: options.hostHeader, headers: options.headers }],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }
    const { record, reconcile } = await commitWithNginxVerification<ProxyProjectsFileRecord>(
      ports, path, fresh, expected,
      async raw => {
        const current = raw === null ? [] : readProxyProjectsRecord(raw)?.projects ?? fail('PRECONDITION_FAILED', 'saved proxy projects require review before changing them', unchanged)
        if (current.length >= PROXY_PROJECTS_MAX) return field(`an account keeps at most ${PROXY_PROJECTS_MAX} proxy projects`, 'name', 'too_many')
        return { rulesVersion: 1, projects: [...current, created], updatedAt: now.toISOString() }
      },
      readProxyProjectsRecord,
    )
    await ports.emitAudit({
      actor: caller.principal.username, action: 'account.proxy_project.created', target: 'proxy-project:' + created.domains[0],
      principalId: caller.principal.id, outcome: 'ok', detail: { name: created.name, domains: created.domains, target: created.rules[0]!.target },
    })
    const view = proxyProjectsView(account, record, runtimePorts)
    return json(201, { ...view, project: created, reconcile })
  }

  const ensureProjectExists = (raw: unknown): ProxyProjectRecord => {
    const current = raw === null ? [] : readProxyProjectsRecord(raw)?.projects ?? fail('PRECONDITION_FAILED', 'saved proxy projects require review before changing them', unchanged)
    const existing = current.find(item => item.id === projectId && item.accountId === account.id)
    if (!existing) return fail('NOT_FOUND', 'proxy project not found', unchanged)
    return existing
  }

  if (projectId && !rulesSub && method === 'PUT') {
    const name = body!.name === undefined ? undefined : typeof body!.name === 'string' && body!.name.trim().length >= 1 && body!.name.trim().length <= 64 && !CONTROL_CHARS.test(body!.name)
      ? body!.name.trim() : field('project name must be 1 to 64 printable characters', 'name', 'invalid')
    const domains = body!.domains === undefined ? undefined : await validateDomains(body!.domains, projectId)
    const noteText = body!.note === undefined ? undefined : typeof body!.note === 'string' && body!.note.length <= 256 && !CONTROL_CHARS.test(body!.note)
      ? body!.note.trim() : field('note must be plain text of at most 256 characters', 'note', 'invalid')
    const cache = body!.cache === undefined ? undefined : typeof body!.cache === 'boolean' ? body!.cache : field('cache must be a boolean', 'cache', 'invalid')
    const gzip = body!.gzip === undefined ? undefined : typeof body!.gzip === 'boolean' ? body!.gzip : field('gzip must be a boolean', 'gzip', 'invalid')
    const sslEnabled = body!.ssl === undefined ? undefined : object(body!.ssl) && typeof body!.ssl.enabled === 'boolean' ? body!.ssl.enabled : typeof body!.ssl === 'boolean' ? body!.ssl : field('ssl must be a boolean or { enabled }', 'ssl', 'invalid')

    let updatedProject!: ProxyProjectRecord
    const { record, reconcile } = await commitWithNginxVerification<ProxyProjectsFileRecord>(
      ports, path, fresh, expected,
      async raw => {
        const current = readProxyProjectsRecord(raw)!.projects
        const existing = ensureProjectExists(raw)
        updatedProject = {
          ...existing,
          ...(name !== undefined ? { name } : {}),
          ...(domains !== undefined ? { domains } : {}),
          ...(noteText !== undefined ? { note: noteText } : {}),
          ...(cache !== undefined ? { cache } : {}),
          ...(gzip !== undefined ? { gzip } : {}),
          ...(sslEnabled !== undefined ? { ssl: { ...existing.ssl, enabled: sslEnabled } } : {}),
          updatedAt: now.toISOString(),
        }
        return { rulesVersion: 1, projects: current.map(item => (item.id === projectId ? updatedProject : item)), updatedAt: now.toISOString() }
      },
      readProxyProjectsRecord,
      ensureProjectExists,
    )
    await ports.emitAudit({
      actor: caller.principal.username, action: 'account.proxy_project.updated', target: 'proxy-project:' + updatedProject.domains[0],
      principalId: caller.principal.id, outcome: 'ok', detail: { name: updatedProject.name, domains: updatedProject.domains },
    })
    const view = proxyProjectsView(account, record, runtimePorts)
    return json(200, { ...view, project: updatedProject, reconcile })
  }

  if (projectId && !rulesSub && method === 'DELETE') {
    let removedProject!: ProxyProjectRecord
    const { record, reconcile } = await commitWithNginxVerification<ProxyProjectsFileRecord>(
      ports, path, fresh, expected,
      async raw => {
        const current = readProxyProjectsRecord(raw)!.projects
        removedProject = ensureProjectExists(raw)
        return { rulesVersion: 1, projects: current.filter(item => item.id !== projectId), updatedAt: now.toISOString() }
      },
      readProxyProjectsRecord,
      ensureProjectExists,
    )
    await ports.emitAudit({
      actor: caller.principal.username, action: 'account.proxy_project.deleted', target: 'proxy-project:' + removedProject.domains[0],
      principalId: caller.principal.id, outcome: 'ok', detail: { name: removedProject.name, domains: removedProject.domains },
    })
    const view = proxyProjectsView(account, record, runtimePorts)
    return json(200, { ...view, reconcile })
  }

  if (projectId && rulesSub && method === 'POST') {
    const rulePath = normalizeRulePath(body!.path)
    const options = parseRuleOptions(body!)
    const targetProblem = await assessAccountProxyTarget(body!.target, settings, {
      isOwner, ownAddresses, ownedRuntimePorts: runtimePorts, resolveHost: ports.resolveHost ?? systemResolve,
    })
    if (targetProblem) return field(TARGET_MESSAGES[targetProblem] ?? TARGET_MESSAGES.invalid!, 'target', targetProblem, 'INVALID_TARGET')

    let updatedProject!: ProxyProjectRecord
    const { record, reconcile } = await commitWithNginxVerification<ProxyProjectsFileRecord>(
      ports, path, fresh, expected,
      async raw => {
        const current = readProxyProjectsRecord(raw)!.projects
        const existing = ensureProjectExists(raw)
        if (existing.rules.some(rule => rule.path === rulePath)) return field('this path already has a rule', 'path', 'duplicate')
        if (existing.rules.length >= PROXY_PROJECT_RULES_MAX) return field(`a proxy project keeps at most ${PROXY_PROJECT_RULES_MAX} rules`, 'path', 'too_many')
        const rule: ProxyProjectRule = { id: randomUUID(), path: rulePath, target: body!.target as string, websocket: options.websocket, hostHeader: options.hostHeader, headers: options.headers }
        updatedProject = { ...existing, rules: [...existing.rules, rule], updatedAt: now.toISOString() }
        return { rulesVersion: 1, projects: current.map(item => (item.id === projectId ? updatedProject : item)), updatedAt: now.toISOString() }
      },
      readProxyProjectsRecord,
      ensureProjectExists,
    )
    await ports.emitAudit({
      actor: caller.principal.username, action: 'account.proxy_project.rule_added', target: 'proxy-project:' + updatedProject.domains[0],
      principalId: caller.principal.id, outcome: 'ok', detail: { path: rulePath, target: body!.target as string },
    })
    const view = proxyProjectsView(account, record, runtimePorts)
    return json(200, { ...view, project: updatedProject, reconcile })
  }

  if (projectId && rulesSub && method === 'DELETE') {
    const rulePath = normalizeRulePath(body!.path)
    let updatedProject!: ProxyProjectRecord
    const { record, reconcile } = await commitWithNginxVerification<ProxyProjectsFileRecord>(
      ports, path, fresh, expected,
      async raw => {
        const current = readProxyProjectsRecord(raw)!.projects
        const existing = ensureProjectExists(raw)
        if (!existing.rules.some(rule => rule.path === rulePath)) return field('the path is not a saved rule', 'path', 'not_found')
        if (existing.rules.length <= 1) {
          return fail('CONFLICT', 'a proxy project must keep at least one proxy rule', {
            ...unchanged, reason: 'LAST_PROXY_RULE', fields: [{ field: 'path', code: 'last_proxy_rule' }],
          })
        }
        updatedProject = { ...existing, rules: existing.rules.filter(rule => rule.path !== rulePath), updatedAt: now.toISOString() }
        return { rulesVersion: 1, projects: current.map(item => (item.id === projectId ? updatedProject : item)), updatedAt: now.toISOString() }
      },
      readProxyProjectsRecord,
      ensureProjectExists,
    )
    await ports.emitAudit({
      actor: caller.principal.username, action: 'account.proxy_project.rule_removed', target: 'proxy-project:' + updatedProject.domains[0],
      principalId: caller.principal.id, outcome: 'ok', detail: { path: rulePath },
    })
    const view = proxyProjectsView(account, record, runtimePorts)
    return json(200, { ...view, project: updatedProject, reconcile })
  }

  return null
}
