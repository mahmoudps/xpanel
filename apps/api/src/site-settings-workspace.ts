import { assertSiteOptions, fail, isXpanelError } from '@xpanel/core'
import type { Account, Domain, SiteOptions } from '@xpanel/core'
import type { DomainMutationOptions, DomainPatch, StateStore } from '@xpanel/state'
import { isMailboxPrincipal } from './authorization.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { classify } from './account-bulk-actions.ts'
import type { ReadAgent } from './account-ssh-workspace.ts'

export const SITE_SETTINGS_ROUTE = /^\/api\/domains\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/site-settings$/
export const DOMAIN_BULK_PATH = '/api/domains/bulk-actions'
/** One request changes at most this many sites; each runs its own apply, so a 1 vCPU host does them in turn. */
export const DOMAIN_BULK_LIMIT = 25

type Mutate = <T>(req: Request, caller: AuthenticatedCaller, account: Account, expected: unknown, action: string,
  mutate: (options: DomainMutationOptions) => Promise<T>) => Promise<{ value: T; reconcile: unknown; view: object }>

export interface SiteSettingsPorts {
  store: Pick<StateStore, 'getDomain' | 'getAccount' | 'getServerSettings' | 'updateDomain' | 'deleteDomain' | 'readDomainWorkspace'>
  requireCaller(req: Request): Promise<AuthenticatedCaller>
  assertCanAccessAccount(caller: AuthenticatedCaller, account: Account, action: string): Promise<void>
  assertFeatures(caller: AuthenticatedCaller, account: Account, features: readonly string[]): Promise<void>
  readJsonBody(req: Request): Promise<Record<string, unknown>>
  /** Protected agent transport; null without a connected host agent. */
  readAgent: ReadAgent | null
  /** server.ts mutateDomainWorkspace: revision, fresh authority under the writer lease, journaled projection, apply, audit. */
  mutateDomainWorkspace: Mutate
}

const unchanged = { stateChanged: false }
const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const refuse = (code: Parameters<typeof fail>[0], message: string, detail: Record<string, unknown> = {}): never => fail(code, message, { ...unchanged, ...detail })
const invalidField = (field: string, message: string): never => refuse('VALIDATION', message, { fields: [{ field, code: 'invalid' }] })

/** Settings the owner edits; the two kept keys belong to the stop path and the administrator. */
const OWNER_KEYS = ['runDirectory', 'isolated', 'visitorLogOff', 'denyRules', 'traffic', 'stoppedMessage', 'expiryReminder'] as const
const compact = (site: SiteOptions): SiteOptions | undefined => Object.keys(site).length ? site : undefined

const expiry = (value: unknown): string | null => {
  if (value === null) return null
  const at = typeof value === 'string' && value.length <= 32 ? new Date(value) : null
  return at && Number.isFinite(at.getTime()) ? at.toISOString() : invalidField('expiresAt', 'the expiry is a date, or empty for no expiry')
}
const pathQuota = (value: unknown): Domain['pathQuotaMb'] =>
  value === 'unlimited' || typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 1_073_741_824 ? value : invalidField('pathQuotaMb', 'the path quota is a size in MB, or unlimited')

const siteQuota = async (ports: SiteSettingsPorts, caller: AuthenticatedCaller, account: Account, domain: Domain): Promise<{ state: string; reason?: string }> =>
  ports.readAgent ? ports.readAgent<{ state: string; reason?: string }>(caller, `/accounts/${account.username}/site-quota?domain=${domain.id}`, undefined, false, 'GET') : { state: 'unsupported', reason: 'unread' }

function ownerPatch(domain: Domain, body: Record<string, unknown>, engine: string | undefined): DomainPatch {
  const patch: DomainPatch = {}
  if (Object.hasOwn(body, 'docRoot')) patch.docRoot = typeof body.docRoot === 'string' ? body.docRoot : invalidField('docRoot', 'the document root must be a path')
  if (Object.hasOwn(body, 'expiresAt')) patch.expiresAt = expiry(body.expiresAt)
  if (Object.hasOwn(body, 'pathQuotaMb')) patch.pathQuotaMb = pathQuota(body.pathQuotaMb)
  if (Object.hasOwn(body, 'site')) {
    const asked = body.site
    if (!asked || typeof asked !== 'object' || Object.keys(asked).some(key => !(OWNER_KEYS as readonly string[]).includes(key))) return invalidField('site', 'unsupported site option')
    const { stoppedByOwner, category } = domain.site ?? {}
    const site = assertSiteOptions({ ...asked, ...(stoppedByOwner && { stoppedByOwner }), ...(category !== undefined && { category }) })
    if (site.runDirectory && !['php', 'static'].includes(domain.siteType)) return invalidField('runDirectory', 'a run directory applies to sites that serve files')
    if (site.isolated && domain.siteType !== 'php') return invalidField('isolated', 'isolation applies to PHP sites')
    // OpenLiteSpeed sets open_basedir as a locked value that .user.ini cannot narrow.
    if (site.isolated && !domain.site?.isolated && engine !== 'apache') return refuse('PRECONDITION_FAILED', 'site isolation needs the Apache engine', { reason: 'isolation_engine' })
    patch.site = compact(site)
  }
  return patch
}

const samePatch = (domain: Domain, patch: DomainPatch): boolean =>
  (Object.keys(patch) as (keyof DomainPatch)[]).every(key => JSON.stringify(patch[key] ?? null) === JSON.stringify(domain[key] ?? null))

/** GET says whether the path quota can be enforced; PUT saves one owned site's settings, or stops or starts it. */
export async function handleSiteSettingsRoute(req: Request, url: URL, method: string, ports: SiteSettingsPorts): Promise<Response | null> {
  const match = SITE_SETTINGS_ROUTE.exec(url.pathname)
  if (!match) return null
  if (method !== 'GET' && method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'GET, PUT' } })
  const caller = await ports.requireCaller(req)
  if (caller.principal.kind !== 'user' || isMailboxPrincipal(caller)) return refuse('FORBIDDEN', 'hosting account owner access is required')
  if (url.search) return refuse('VALIDATION', 'site settings accept no query selectors')
  const domain = await ports.store.getDomain(match[1]!)
  // A neighbour's domain answers exactly like a missing one.
  if (!domain || domain.accountId !== caller.principal.accountId) return refuse('NOT_FOUND', 'domain not found')
  const account = await ports.store.getAccount(domain.accountId)
  if (!account) return refuse('NOT_FOUND', 'domain not found')
  await ports.assertCanAccessAccount(caller, account, 'domain.modify')
  await ports.assertFeatures(caller, account, ['domains', 'manage-domain'])
  if (method === 'GET') return json({ quota: await siteQuota(ports, caller, account, domain) })

  const body = await ports.readJsonBody(req)
  if (!Object.hasOwn(body, 'expectedRevision') || Object.keys(body).some(key => !['expectedRevision', 'suspended', 'docRoot', 'expiresAt', 'pathQuotaMb', 'site'].includes(key))) return refuse('VALIDATION', 'site settings take expectedRevision and the changed settings')
  let patch: DomainPatch, action = 'domain.updated'
  if (Object.hasOwn(body, 'suspended')) {
    if (typeof body.suspended !== 'boolean' || Object.keys(body).length !== 2) return refuse('VALIDATION', 'stopping or starting a site changes nothing else')
    if (domain.suspended === body.suspended) return invalidField('suspended', body.suspended ? 'the site is already stopped' : 'the site is already running')
    if (domain.suspended && !domain.site?.stoppedByOwner) return refuse('PRECONDITION_FAILED', 'the server administrator stopped this site', { reason: 'stopped_by_administrator' })
    const { stoppedByOwner: _old, ...rest } = domain.site ?? {}
    patch = { suspended: body.suspended, site: compact(body.suspended ? { ...rest, stoppedByOwner: true } : rest) }
    action = body.suspended ? 'domain.site_stopped' : 'domain.site_started'
  } else {
    if (domain.kind === 'alias') return refuse('VALIDATION', 'an alias follows the settings of the domain it points at')
    patch = ownerPatch(domain, body, (await ports.store.getServerSettings())?.engine)
    if (!Object.keys(patch).length || samePatch(domain, patch)) return invalidField('site', 'there is no change to save')
    if (typeof patch.pathQuotaMb === 'number' && patch.pathQuotaMb !== domain.pathQuotaMb) {
      const quota = await siteQuota(ports, caller, account, domain)
      if (quota.state !== 'ready') return refuse('VALIDATION', 'path quotas need an XFS filesystem mounted with project quota', { reason: 'QUOTA_UNSUPPORTED_FS', fields: [{ field: 'pathQuotaMb', code: quota.reason ?? 'unread' }] })
    }
  }
  const previous = Object.fromEntries((Object.keys(patch) as (keyof DomainPatch)[]).map(key => [key, domain[key]])) as DomainPatch
  try {
    const result = await ports.mutateDomainWorkspace(req, caller, account, body.expectedRevision, action, options => ports.store.updateDomain(domain.id, patch, options))
    return json({ domain: result.value, stateChanged: true, ...result.view, reconcile: result.reconcile })
  } catch (error) {
    if (!isXpanelError(error) || error.code !== 'CONFIG_TEST_FAILED' || error.detail.stateChanged !== true) throw error
    // A failed test left the previous configuration running; desired state goes back so no later apply repeats it.
    await ports.store.updateDomain(domain.id, previous)
    return fail('CONFIG_TEST_FAILED', 'the web server rejected this configuration and the site settings were rolled back', { ...unchanged, rolledBack: true })
  }
}

type BulkAction = 'stop' | 'start' | 'expiry' | 'php' | 'category' | 'backup' | 'delete'
const BULK_ACTIONS: readonly BulkAction[] = ['stop', 'start', 'expiry', 'php', 'category', 'backup', 'delete']
const PARAMS: Partial<Record<BulkAction, string>> = { expiry: 'expiresAt', php: 'version', category: 'category' }
const AUDIT: Record<BulkAction, string> = { stop: 'domain.site_stopped', start: 'domain.site_started', expiry: 'domain.updated', php: 'domain.updated', category: 'domain.updated', backup: 'domain.updated', delete: 'domain.deleted' }
interface BulkTarget { id: string; confirmName?: string }

const bulkTargets = (body: Record<string, unknown>, action: BulkAction): BulkTarget[] => {
  const raw = body.domains
  if (!Array.isArray(raw) || !raw.length || raw.length > DOMAIN_BULK_LIMIT) return refuse('VALIDATION', `1..${DOMAIN_BULK_LIMIT} sites are required`)
  const targets = raw.map((item: unknown): BulkTarget => {
    const value = item as Record<string, unknown> | null
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !/^[0-9a-f-]{36}$/.test(value.id)) return refuse('VALIDATION', 'each site needs its id')
    if (action === 'delete' && typeof value.confirmName !== 'string') return refuse('VALIDATION', 'each deleted site needs its typed name')
    return { id: value.id, ...(typeof value.confirmName === 'string' && { confirmName: value.confirmName }) }
  })
  return new Set(targets.map(target => target.id)).size === targets.length ? targets : refuse('VALIDATION', 'each site may be listed once')
}

const bulkPatch = (domain: Domain, action: BulkAction, body: Record<string, unknown>): DomainPatch => {
  if (action === 'stop' || action === 'start') {
    const { stoppedByOwner: _old, ...rest } = domain.site ?? {}
    return { suspended: action === 'stop', site: compact(rest) }
  }
  if (domain.kind === 'alias') return refuse('VALIDATION', 'an alias follows the settings of the domain it points at')
  if (action === 'expiry') return { expiresAt: expiry(body.expiresAt) }
  if (action === 'php') return { php: { ...domain.php, version: typeof body.version === 'string' ? body.version : invalidField('version', 'choose a PHP version') } }
  const { category: _old, ...rest } = domain.site ?? {}
  const category = body.category
  return { site: compact(assertSiteOptions(category === null ? rest : { ...rest, category })) }
}

/** Root applies one action to several sites through the single-site path; the reply reports every site. */
export async function handleDomainBulkRoute(req: Request, url: URL, method: string, ports: SiteSettingsPorts): Promise<Response | null> {
  if (url.pathname !== DOMAIN_BULK_PATH) return null
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  const caller = await ports.requireCaller(req)
  if (caller.principal.kind !== 'root') return refuse('FORBIDDEN', 'root role is required for this operation')
  const body = await ports.readJsonBody(req), action = body.action as BulkAction
  if (!BULK_ACTIONS.includes(action)) return refuse('VALIDATION', 'unknown bulk site action')
  const param = PARAMS[action]
  if (url.search || Object.keys(body).some(key => !['action', 'domains', ...(param ? [param] : [])].includes(key)) || param && !Object.hasOwn(body, param)) return refuse('VALIDATION', 'unsupported or missing bulk site field')
  const targets = bulkTargets(body, action)
  type Result = { domainId: string; name: string | null; outcome: 'applied' | 'refused' | 'review-required' | 'not-attempted'; code: string | null; reason: string | null }
  const results: Result[] = []
  let stopped = false
  // One site at a time: each change runs a host apply. Anything but a clean refusal stops the rest.
  for (const target of targets) {
    if (stopped) { results.push({ domainId: target.id, name: null, outcome: 'not-attempted', code: null, reason: null }); continue }
    let name: string | null = null
    try {
      const domain = await ports.store.getDomain(target.id) ?? fail('NOT_FOUND', 'domain not found', unchanged)
      const account = await ports.store.getAccount(domain.accountId) ?? fail('NOT_FOUND', 'domain not found', unchanged)
      name = domain.name
      if (action === 'backup') {
        if (!ports.readAgent) fail('PRECONDITION_FAILED', 'site backups need the protected host agent', { ...unchanged, reason: 'host_agent_unavailable' })
        await ports.readAgent!(caller, `/accounts/${account.username}/website-backups`, { op: 'create', domainId: domain.id, databases: [] }, true, 'POST')
      } else if (action === 'delete') {
        if (target.confirmName !== domain.name) fail('VALIDATION', 'confirm the exact domain name', unchanged)
        const dependency = (await ports.store.readDomainWorkspace(account.id)).source.dependencies.find(item => item.domainId === domain.id)
        // The single-site owner path refuses a site with dependents; a bulk request never cascades either.
        if (dependency?.childCount || dependency?.serviceUserCount) fail('PRECONDITION_FAILED', 'remove dependent domains and service users first', { ...unchanged, reason: 'domain_dependencies' })
        await ports.mutateDomainWorkspace(req, caller, account, undefined, AUDIT.delete, options => ports.store.deleteDomain(domain.id, options))
      } else {
        const patch = bulkPatch(domain, action, body)
        if (!samePatch(domain, patch)) await ports.mutateDomainWorkspace(req, caller, account, undefined, AUDIT[action], options => ports.store.updateDomain(domain.id, patch, options))
      }
      results.push({ domainId: target.id, name, outcome: 'applied', code: null, reason: null })
    } catch (error) {
      const { accountId: _unused, ...verdict } = classify(target.id, error)
      results.push({ domainId: target.id, name, outcome: verdict.outcome as Result['outcome'], code: verdict.code, reason: verdict.reason })
      stopped = verdict.outcome === 'review-required'
    }
  }
  const count = (outcome: Result['outcome']): number => results.filter(item => item.outcome === outcome).length
  return json({ action, results, summary: { applied: count('applied'), refused: count('refused'), reviewRequired: count('review-required'), notAttempted: count('not-attempted') } })
}
