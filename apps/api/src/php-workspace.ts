import { createHash } from 'node:crypto'
import { disabledFunctions, fail, validatePhpFunctionExceptions } from '@xpanel/core'
import type { Account, Domain, PhpFunctionException, PhpSettings, ServerSettings } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'

export interface PhpWorkspaceHelpers {
  requireCaller: (request: Request) => Promise<AuthenticatedCaller>
  assertRoot: (caller: AuthenticatedCaller, action: string) => Promise<void>
  /** The authenticated agent owns inventory. No caller-selected command or path is accepted. */
  readInventory: (caller: AuthenticatedCaller) => Promise<Response>
  listDomains: () => Promise<Domain[]>
  listAccounts: () => Promise<Account[]>
}
/** Root-only server PHP writes. Package and php.ini changes are agent jobs; the default and assignments are desired state. */
export interface PhpManageHelpers {
  requireCaller: (request: Request) => Promise<AuthenticatedCaller>
  assertRoot: (caller: AuthenticatedCaller, action: string) => Promise<void>
  /** Agent /host/php/manage{,/preview,/apply}; no body for the read. */
  agent: (caller: AuthenticatedCaller, path: '/host/php/manage' | '/host/php/manage/preview' | '/host/php/manage/apply', body?: Record<string, unknown>) => Promise<Response>
  listDomains: () => Promise<Domain[]>
  listAccounts: () => Promise<Account[]>
  getServerSettings: () => Promise<ServerSettings | null>
  saveServerSettings: (settings: ServerSettings) => Promise<ServerSettings>
  /** Stores one domain's PHP settings; reconcile applies the batch once. */
  updateDomainPhp: (caller: AuthenticatedCaller, domain: Domain, php: PhpSettings) => Promise<void>
  reconcile: (caller: AuthenticatedCaller) => Promise<{ ok: boolean; body: Record<string, unknown> } | null>
  audit: (caller: AuthenticatedCaller, action: string, target: string, detail: Record<string, unknown>, outcome?: 'ok' | 'failed') => Promise<void>
  now?: () => Date
}

/** php.net supported-versions dates: security support ends at the second date. */
export const PHP_LIFECYCLE: Readonly<Record<string, { activeUntil: string; securityUntil: string }>> = {
  '7.4': { activeUntil: '2021-11-28', securityUntil: '2022-11-28' },
  '8.0': { activeUntil: '2022-11-26', securityUntil: '2023-11-26' },
  '8.1': { activeUntil: '2023-11-25', securityUntil: '2025-12-31' },
  '8.2': { activeUntil: '2024-12-31', securityUntil: '2026-12-31' },
  '8.3': { activeUntil: '2025-12-31', securityUntil: '2027-12-31' },
  '8.4': { activeUntil: '2026-12-31', securityUntil: '2028-12-31' },
}
export const phpLifecycle = (version: string, now: Date): { state: 'active' | 'security' | 'end-of-life' | 'unknown'; activeUntil: string | null; securityUntil: string | null } => {
  const dates = PHP_LIFECYCLE[version]
  if (!dates) return { state: 'unknown', activeUntil: null, securityUntil: null }
  const day = now.toISOString().slice(0, 10)
  return { state: day <= dates.activeUntil ? 'active' : day <= dates.securityUntil ? 'security' : 'end-of-life', ...dates }
}

const PHP_MANAGE_PATHS = ['/api/server/php/manage', '/api/server/php/manage/preview', '/api/server/php/manage/apply', '/api/server/php/default', '/api/server/php/assign', '/api/server/php/exceptions']
const EXCEPTION_ROUTE = /^\/api\/server\/php\/exceptions\/([a-z][a-z0-9]{0,15})$/
/** Content identity of the saved exceptions; grants and revokes are bound to the list the caller read. */
export const exceptionsRevision = (list: readonly PhpFunctionException[]): string => createHash('sha256').update(JSON.stringify(list)).digest('hex')
const RELEASE_DEFAULT = '8.3'

async function readJson(request: Request, fields: readonly string[]): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  let value: unknown
  try { value = JSON.parse(await request.text()) } catch { return fail('VALIDATION', 'request body must be valid JSON', { stateChanged: false }) }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) return fail('VALIDATION', 'unsupported PHP field', { stateChanged: false })
  return value as Record<string, unknown>
}

type ManageView = { state: string; revision: string | null; versions: { version: string; fpmInstalled: boolean }[]; installable?: string[] }

export async function handlePhpManageRoute(request: Request, url: URL, method: string, h: PhpManageHelpers): Promise<Response | null> {
  const revokeMatch = EXCEPTION_ROUTE.exec(url.pathname)
  if (!PHP_MANAGE_PATHS.includes(url.pathname) && !revokeMatch) return null
  const caller = await h.requireCaller(request)
  const read = url.pathname === '/api/server/php/manage'
  await h.assertRoot(caller, read ? 'server.php.read' : 'server.php.modify')
  const expected = read ? 'GET' : url.pathname === '/api/server/php/default' ? 'PUT' : revokeMatch ? 'DELETE' : 'POST'
  if (method !== expected) return new Response(null, { status: 405, headers: { allow: expected } })
  if ([...url.searchParams.keys()].length !== 0) return fail('VALIDATION', 'PHP management does not accept selectors', { stateChanged: false })
  const now = h.now?.() ?? new Date()
  const observe = async (): Promise<{ response: Response; body: ManageView }> => {
    const response = await h.agent(caller, '/host/php/manage')
    return { response, body: response.ok ? await response.clone().json() as ManageView : { state: 'unavailable', revision: null, versions: [] } }
  }
  const installed = (view: ManageView, version: string): boolean => view.state === 'read' && view.versions.some(item => item.version === version && item.fpmInstalled)
  const bound = (view: ManageView, revision: unknown): void => {
    if (typeof revision !== 'string' || revision !== view.revision) fail('CONFLICT', 'PHP on this host changed since it was reviewed; reload before saving', { stateChanged: false, currentRevision: view.revision })
  }
  const [domains, accounts, settings] = await Promise.all([h.listDomains(), h.listAccounts(), h.getServerSettings()])
  const defaultVersion = settings?.defaultPhpVersion ?? RELEASE_DEFAULT
  const usage = projectPhpDesiredUsage(domains, accounts)
  const counted = (version: string) => usage.find(entry => entry.version === version)

  if (read) {
    const { response, body } = await observe()
    if (!response.ok) return response
    const versions = body.versions.map(item => ({ ...item, lifecycle: phpLifecycle(item.version, now), domainCount: counted(item.version)?.domainCount ?? 0, accountCount: counted(item.version)?.accountCount ?? 0 }))
    return Response.json({ ...body, versions, installableLifecycle: Object.fromEntries((body.installable ?? []).map(version => [version, phpLifecycle(version, now)])), defaultVersion, usage, exceptions: settings?.phpFunctionExceptions ?? [], exceptionsRevision: exceptionsRevision(settings?.phpFunctionExceptions ?? []) }, { headers: { 'cache-control': 'no-store' } })
  }

  if (url.pathname === '/api/server/php/default') {
    const input = await readJson(request, ['version', 'expectedRevision'])
    const { response, body } = await observe()
    if (!response.ok) return response
    bound(body, input.expectedRevision)
    const version = String(input.version)
    if (!installed(body, version)) return fail('PRECONDITION_FAILED', 'install PHP-FPM for this version before making it the default', { stateChanged: false })
    if (phpLifecycle(version, now).state === 'end-of-life') return fail('PRECONDITION_FAILED', 'an end-of-life PHP version cannot be the default for new domains', { stateChanged: false })
    if (!settings) return fail('PRECONDITION_FAILED', 'server settings have not been set up', { stateChanged: false })
    await h.saveServerSettings({ ...settings, defaultPhpVersion: version })
    await h.audit(caller, 'server.php.default.changed', 'php:' + version, { from: defaultVersion, to: version })
    return Response.json({ defaultVersion: version, stateChanged: true, scope: 'new-domains-only' }, { headers: { 'cache-control': 'no-store' } })
  }

  if (url.pathname === '/api/server/php/exceptions' || revokeMatch) {
    // desired state: saved in server settings, rendered into every pool, CGI wrapper and lsphp app, then tested by the reconciler
    if (!settings) return fail('PRECONDITION_FAILED', 'server settings have not been set up', { stateChanged: false })
    const input = await readJson(request, revokeMatch ? ['expectedRevision'] : ['account', 'functions', 'reason', 'expectedRevision', 'dryRun'])
    const current = settings.phpFunctionExceptions ?? []
    if (input.expectedRevision !== exceptionsRevision(current)) return fail('CONFLICT', 'the function exceptions changed since they were read; reload before saving', { stateChanged: false, currentRevision: exceptionsRevision(current) })
    const username = revokeMatch ? revokeMatch[1]! : String(input.account)
    const account = accounts.find(item => item.username === username) ?? (revokeMatch ? null : fail('NOT_FOUND', 'account not found', { stateChanged: false }))
    const rest = current.filter(item => item.account !== username)
    if (revokeMatch && rest.length === current.length) return fail('NOT_FOUND', 'this account has no function exception', { stateChanged: false })
    const next = revokeMatch ? rest : validatePhpFunctionExceptions([...rest, { account: username, functions: input.functions, reason: input.reason, grantedAt: now.toISOString(), grantedBy: caller.principal.username }])
    const granted = next.find(item => item.account === username)
    // the preview is the exact disable_functions value every pool of the account will carry
    const preview = { account: username, allowed: granted?.functions ?? [], disableFunctions: disabledFunctions(granted?.functions ?? []).join(',') }
    if (input.dryRun === true) return Response.json({ dryRun: true, ...preview }, { headers: { 'cache-control': 'no-store' } })
    const action = revokeMatch ? 'server.php.exception.revoked' : 'server.php.exception.granted'
    await h.saveServerSettings({ ...settings, phpFunctionExceptions: next })
    const reconcile = account ? await h.reconcile(caller) : null
    if (reconcile && !reconcile.ok) {
      // the pools failed php-fpm --test or did not reload: put the previous exceptions back and re-apply
      await h.saveServerSettings({ ...settings, phpFunctionExceptions: current })
      await h.reconcile(caller)
      await h.audit(caller, action, 'account:' + username, { ...preview, applied: false, reverted: true }, 'failed')
      return fail('SERVICE_UNAVAILABLE', 'the account pools refused the change; the previous exceptions were restored', { stateChanged: false, reverted: true, reconcile: reconcile.body })
    }
    await h.audit(caller, action, 'account:' + username, { ...preview, ...(granted ? { reason: granted.reason } : {}) })
    return Response.json({ ...preview, exceptions: next, exceptionsRevision: exceptionsRevision(next), stateChanged: true, reconcile: reconcile?.body ?? null }, { headers: { 'cache-control': 'no-store' } })
  }

  if (url.pathname === '/api/server/php/assign') {
    const input = await readJson(request, ['account', 'version', 'expectedRevision'])
    const { response, body } = await observe()
    if (!response.ok) return response
    bound(body, input.expectedRevision)
    const version = String(input.version)
    if (!installed(body, version)) return fail('PRECONDITION_FAILED', 'install PHP-FPM for this version before assigning it', { stateChanged: false })
    const account = accounts.find(item => item.username === input.account || item.id === input.account) ?? fail('NOT_FOUND', 'account not found', { stateChanged: false })
    const targets = domains.filter(domain => domain.accountId === account.id && domain.siteType === 'php' && domain.php.version !== version)
    const changed: string[] = []
    let reconcile: Awaited<ReturnType<PhpManageHelpers['reconcile']>> = null
    try { for (const domain of targets) { await h.updateDomainPhp(caller, domain, { ...domain.php, version }); changed.push(domain.name) } }
    finally { if (changed.length) reconcile = await h.reconcile(caller); await h.audit(caller, 'server.php.account.assigned', 'account:' + account.username, { version, domains: changed, requested: targets.length }, changed.length === targets.length ? 'ok' : 'failed') }
    return Response.json({ account: account.username, version, changed, stateChanged: changed.length > 0, reconcile: reconcile?.body ?? null }, { headers: { 'cache-control': 'no-store' } })
  }

  // preview and apply: the agent owns the host observation, the revision binding and the job
  const input = await readJson(request, ['operation', 'version', 'extension', 'enabled', 'ini', 'expectedRevision'])
  if (input.operation === 'remove-version') {
    const users = counted(String(input.version))
    if (users && users.domainCount > 0) return fail('CONFLICT', `PHP ${String(input.version)} is used by ${users.domainCount} domains. Move them first.`, { stateChanged: false, domains: users.domainCount })
    if (input.version === defaultVersion) return fail('CONFLICT', 'the default version cannot be removed', { stateChanged: false })
  }
  const apply = url.pathname === '/api/server/php/manage/apply'
  const response = await h.agent(caller, apply ? '/host/php/manage/apply' : '/host/php/manage/preview', input)
  if (apply) {
    const result = response.ok ? await response.clone().json() as { job?: { id?: string } } : null
    await h.audit(caller, 'server.php.' + String(input.operation) + (response.ok ? '.submitted' : '.refused'), 'php:' + String(input.version),
      { operation: input.operation, ...(input.extension === undefined ? {} : { extension: input.extension, enabled: input.enabled }), ...(input.ini === undefined ? {} : { ini: input.ini }), job: result?.job?.id ?? null, status: response.status }, response.ok ? 'ok' : 'failed')
  }
  return response
}

export interface PhpDesiredVersionUsage {
  version: string
  domainCount: number
  accountCount: number
  handlers: { handler: string; count: number }[]
  domains: { name: string; account: string | null; handler: string }[]
}

/** In-use desired configuration is kept separate from installed package/runtime evidence. */
export function projectPhpDesiredUsage(domains: readonly Domain[], accounts: readonly Account[]): PhpDesiredVersionUsage[] {
  if (domains.length > 10000 || accounts.length > 10000) return fail('PRECONDITION_FAILED', 'PHP usage inventory exceeds the bounded workspace capacity')
  const owners = new Map(accounts.map(account => [account.id, account.username]))
  const groups = new Map<string, Domain[]>()
  for (const domain of domains) {
    const current = groups.get(domain.php.version) ?? []
    current.push(domain); groups.set(domain.php.version, current)
  }
  return [...groups].sort(([left], [right]) => left.localeCompare(right, 'en', { numeric: true })).map(([version, entries]) => {
    const handlers = new Map<string, number>()
    for (const domain of entries) handlers.set(domain.php.handler, (handlers.get(domain.php.handler) ?? 0) + 1)
    return {
      version, domainCount: entries.length, accountCount: new Set(entries.map(domain => domain.accountId)).size,
      handlers: [...handlers].sort(([left], [right]) => left.localeCompare(right)).map(([handler, count]) => ({ handler, count })),
      domains: entries.sort((left, right) => left.name.localeCompare(right.name)).map(domain => ({ name: domain.name, account: owners.get(domain.accountId) ?? null, handler: domain.php.handler })),
    }
  })
}

export async function handlePhpWorkspaceRoute(request: Request, url: URL, method: string, helpers: PhpWorkspaceHelpers): Promise<Response | null> {
  if (!['/api/server/php/inventory', '/api/server/php/usage'].includes(url.pathname)) return null
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, 'server.php.read')
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if ([...url.searchParams.keys()].length !== 0) return fail('VALIDATION', 'PHP workspace reads do not accept caller-selected versions, accounts, commands or paths')
  if (url.pathname === '/api/server/php/inventory') return helpers.readInventory(caller)
  const [domains, accounts] = await Promise.all([helpers.listDomains(), helpers.listAccounts()])
  return Response.json({ scope: 'saved-domain-configuration', observedRuntime: false, usage: projectPhpDesiredUsage(domains, accounts) }, { headers: { 'cache-control': 'no-store' } })
}
