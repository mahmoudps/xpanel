import { assertAcl, assertCanManagePlan, effectivePlan, fail, isUuid, isXpanelError, PLAN_CAP_RULES, RESOURCE_RULES, validateAccountLimits } from '@xpanel/core'
import type { Account, AccountLimits, Id, Limit, Plan, Principal, Reseller } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { projectDisk } from './monitoring-workspace.ts'

const LIMITS_ROUTE = /^\/api\/accounts\/([^/]+)\/limits$/
/** WHM Quota Modification table; '-' keeps the path apart from every account username. */
export const DISK_QUOTAS_PATH = '/api/accounts/disk-quotas'
const QUOTA_SORTS = ['username', 'domain', 'owner', 'used', 'limit'] as const
const QUOTA_PAGE_SIZES = [10, 25, 50, 100] as const
export type QuotaSort = typeof QUOTA_SORTS[number]
export interface DiskQuotaRow {
  accountId: Id; username: string; domain: string; ownerId: Id | null; owner: string | null
  /** filesystem usage from the quota report; null when it is not read */
  usedMb: number | null
  /** the limit in force; null when the package is not readable */
  limitMb: Limit | null; source: 'package' | 'account'; packageLimitMb: Limit | null; planName: string | null
}
export interface DiskQuotaPage {
  rows: DiskQuotaRow[]; total: number; page: number; pageSize: number; sort: QuotaSort; dir: 'asc' | 'desc'
  usage: { state: 'read' | 'unavailable'; observedAt: string | null; reason: string | null }
}
const BANDWIDTH_ROUTE = /^\/api\/accounts\/bandwidth\/(custom|reset|relief)$/
const unchanged = { stateChanged: false }

type Scope = { accountId: Id | null; resellerId: Id | null }
export interface AccountLimitsPorts {
  store: StateStore
  requireCaller: (request: Request) => Promise<AuthenticatedCaller>
  readJsonBody: (request: Request) => Promise<Record<string, unknown>>
  resolveAccountParam: (idOrUsername: string) => Promise<Account>
  assertCanAccessAccount: (caller: AuthenticatedCaller, account: Account, action: string, opts: { allowUserSelf: false }) => Promise<void>
  assertRoot: (caller: AuthenticatedCaller, action: string) => Promise<void>
  resolveReseller: (caller: AuthenticatedCaller) => Promise<Reseller | null>
  /** The writer-locked capture of server.ts updateAccountAs: authority, not terminating, and the revision to write on. */
  captureAccountMutation: (caller: AuthenticatedCaller, targetId: Id, action: string) => Promise<{ account: Account; expectedRevision: number }>
  /** Refuses before any state change when no protected host agent is connected (server.ts requireAccountHostAgent). */
  requireHostAgent: () => void
  /** One verified host reconcile of the saved state (server.ts applyAccountConfiguration). */
  applyAccountConfiguration: (caller: AuthenticatedCaller, account: Account, action: string, expectedRevision: number) => Promise<unknown>
  /** Agent /host/monitoring/disk (repquota per account); root only, so a reseller's table reports usage unavailable. */
  readDisk?: (caller: AuthenticatedCaller) => Promise<unknown>
  emitAudit: (entry: { actor: string; action: string; target: string; detail: Record<string, unknown>; outcome: 'ok'; principalId: Id }, scope: Scope) => Promise<unknown>
  execution: () => unknown
  now?: () => Date
}

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const effective = (plan: Plan, account: Account) => { const { resources, caps } = effectivePlan(plan, account); return { resources, caps } }

/** A PATCH body of override fields; null returns a field to the package value. */
export function parseAccountLimitsPatch(body: unknown): AccountLimits {
  if (!record(body) || Object.keys(body).length === 0) return fail('VALIDATION', 'send resources and/or caps with the fields to change', unchanged)
  // Validation only: the patch keeps its nulls, which return fields to the package value.
  validateAccountLimits(body)
  const fields = [...Object.values((body.resources ?? {}) as object), ...Object.values((body.caps ?? {}) as object)]
  if (fields.length === 0) return fail('VALIDATION', 'send at least one limit field', unchanged)
  return body as AccountLimits
}

export type AccountLimitWritePorts = Pick<AccountLimitsPorts, 'store' | 'resolveReseller' | 'captureAccountMutation' | 'requireHostAgent' | 'applyAccountConfiguration' | 'emitAudit' | 'execution'>
/** The one writer of account overrides: authority and revision captured under the writer lock, then a verified host reconcile. */
export async function saveAccountLimits(caller: AuthenticatedCaller, target: Account, patch: AccountLimits, ports: AccountLimitWritePorts): Promise<unknown> {
  const unlimited = [...Object.values(patch.resources ?? {}), ...Object.values(patch.caps ?? {})].some((value: Limit | null | undefined) => value === 'unlimited')
  if (caller.principal.kind === 'reseller' && unlimited) assertAcl(caller.principal, await ports.resolveReseller(caller), 'allow-unlimited-plans')
  ports.requireHostAgent()
  const captured = await ports.captureAccountMutation(caller, target.id, 'account.limits')
  const updated = await ports.store.setAccountLimits(captured.account.id, patch, { expectedRevision: captured.expectedRevision })
  const plan = await ports.store.getPlan(updated.planId) ?? fail('NOT_FOUND', 'plan not found', unchanged)
  // Quotas, slices and PHP limits follow the effective limits only through the host reconcile.
  const reconcile = await ports.applyAccountConfiguration(caller, updated, 'limits', captured.expectedRevision + 1)
  await ports.emitAudit({ actor: caller.principal.username, action: 'account.limits.updated', target: 'account:' + updated.username,
    detail: { limits: updated.limits ?? null }, outcome: 'ok', principalId: caller.principal.id }, { accountId: updated.id, resellerId: updated.ownerId })
  return { account: updated, effective: effective(plan, updated), reconcile, execution: ports.execution() }
}

const accountIds = (body: Record<string, unknown>): Id[] => {
  if (Object.keys(body).some(key => key !== 'accounts') || !Array.isArray(body.accounts) || body.accounts.length < 1 || body.accounts.length > 100
    || body.accounts.some(id => typeof id !== 'string' || !isUuid(id) || id !== id.toLowerCase()) || new Set(body.accounts).size !== body.accounts.length) {
    return fail('VALIDATION', 'accounts must list 1 to 100 distinct lowercase account UUIDs', unchanged)
  }
  return body.accounts as Id[]
}

/** Query of the disk quota table; unknown or repeated selectors are refused. */
export function parseDiskQuotaQuery(params: URLSearchParams): { q: string; owner: string | null; sort: QuotaSort; dir: 'asc' | 'desc'; page: number; pageSize: number } {
  const allowed = ['q', 'owner', 'sort', 'dir', 'page', 'pageSize']
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) return fail('VALIDATION', 'unknown or repeated disk quota selector', unchanged)
  const q = (params.get('q') ?? '').trim().toLowerCase(), owner = params.get('owner'), sort = params.get('sort') ?? 'username', dir = params.get('dir') ?? 'asc'
  const page = Number(params.get('page') ?? '1'), pageSize = Number(params.get('pageSize') ?? '25')
  if (q.length > 64 || /[\u0000-\u001f]/.test(q) || owner !== null && owner !== 'root' && !(isUuid(owner) && owner === owner.toLowerCase()) || !(QUOTA_SORTS as readonly string[]).includes(sort) || dir !== 'asc' && dir !== 'desc'
    || !Number.isSafeInteger(page) || page < 1 || page > 100_000 || !(QUOTA_PAGE_SIZES as readonly number[]).includes(pageSize)) return fail('VALIDATION', 'invalid disk quota selector', unchanged)
  return { q, owner, sort: sort as QuotaSort, dir, page, pageSize }
}

const limitRank = (value: Limit | null): number => value === null ? -1 : value === 'unlimited' ? Number.MAX_SAFE_INTEGER : value

/** Filters, sorts and pages the visible rows on the server; unmeasured usage sorts below every measured value. */
export function pageDiskQuotas(rows: readonly DiskQuotaRow[], query: ReturnType<typeof parseDiskQuotaQuery>): { rows: DiskQuotaRow[]; total: number; page: number } {
  const matched = rows.filter(row => (!query.q || row.username.includes(query.q) || row.domain.includes(query.q)) && (query.owner === null || (query.owner === 'root' ? row.ownerId === null : row.ownerId === query.owner)))
  const key = (row: DiskQuotaRow): string | number => query.sort === 'used' ? row.usedMb ?? -1 : query.sort === 'limit' ? limitRank(row.limitMb) : query.sort === 'owner' ? row.owner ?? '' : row[query.sort]
  const sign = query.dir === 'asc' ? 1 : -1
  const sorted = [...matched].sort((a, b) => { const x = key(a), y = key(b); return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * sign || a.username.localeCompare(b.username) })
  const pages = Math.max(1, Math.ceil(sorted.length / query.pageSize)), page = Math.min(query.page, pages)
  return { rows: sorted.slice((page - 1) * query.pageSize, page * query.pageSize), total: sorted.length, page }
}

/**
 * PATCH /api/accounts/:id/limits (WHM Modify Account, Quota Modification, Limit Bandwidth Usage) for root and resellers within
 * their capacity; GET /api/accounts/bandwidth/custom, POST .../reset (Reset Account Bandwidth Limit) and POST .../relief
 * (Unsuspend Bandwidth Exceeders) for root.
 */
export async function handleAccountLimitsRoute(req: Request, url: URL, method: string, ports: AccountLimitsPorts): Promise<Response | null> {
  const limits = LIMITS_ROUTE.exec(url.pathname), bandwidth = limits ? null : BANDWIDTH_ROUTE.exec(url.pathname)
  if (url.pathname === DISK_QUOTAS_PATH) return diskQuotas(req, url, method, ports)
  if (!limits && !bandwidth) return null
  if (limits && limits[1] === 'bandwidth') return null
  if (url.search) return fail('VALIDATION', 'account limit routes accept no query selectors', unchanged)
  const caller = await ports.requireCaller(req)
  if (limits) {
    if (method !== 'PATCH') return new Response(null, { status: 405, headers: { allow: 'PATCH' } })
    const target = await ports.resolveAccountParam(limits[1]!)
    await ports.assertCanAccessAccount(caller, target, 'account.limits', { allowUserSelf: false })
    return json(await saveAccountLimits(caller, target, parseAccountLimitsPatch(await ports.readJsonBody(req)), ports))
  }
  const action = bandwidth![1] as 'custom' | 'reset' | 'relief'
  await ports.assertRoot(caller, action === 'custom' ? 'account.bandwidth.read' : 'account.bandwidth.' + action)
  if (action === 'custom') {
    if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
    const snapshot = await ports.store.readSnapshot(), plans = new Map(snapshot.plans.map(plan => [plan.id, plan]))
    const accounts = snapshot.accounts.filter(account => account.limits?.resources?.bandwidthMbMonth !== undefined && account.status !== 'terminating').map(account => {
      const plan = plans.get(account.planId)
      return { accountId: account.id, username: account.username, domain: account.primaryDomain, ownerId: account.ownerId, planId: account.planId, planName: plan?.name ?? null,
        packageLimitMb: plan?.resources.bandwidthMbMonth ?? null, customLimitMb: account.limits!.resources!.bandwidthMbMonth! }
    })
    return json({ accounts, revision: snapshot.revision })
  }
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  const ids = accountIds(await ports.readJsonBody(req))
  const revision = await ports.store.getRevision()
  if (action === 'reset') {
    const reset = await ports.store.resetBandwidthLimits(ids, { expectedRevision: revision })
    for (const account of reset) await ports.emitAudit({ actor: caller.principal.username, action: 'account.bandwidth.reset', target: 'account:' + account.username, detail: {}, outcome: 'ok', principalId: caller.principal.id }, { accountId: account.id, resellerId: account.ownerId })
    // The bandwidth limit renders no host configuration: the agent compares usage with it on its next collection.
    return json({ accounts: reset, enforcement: 'next_collection' })
  }
  const day = (ports.now?.() ?? new Date()).toISOString().slice(0, 10)
  ports.requireHostAgent()
  const relieved = await ports.store.relieveBandwidthLimits(ids, day, { expectedRevision: revision })
  // The edge stops serving the limit page only through the host reconcile of the saved state.
  const reconcile = await ports.applyAccountConfiguration(caller, relieved[0]!, 'bandwidth_relief', revision + 1)
  for (const account of relieved) await ports.emitAudit({ actor: caller.principal.username, action: 'account.bandwidth.relieved', target: 'account:' + account.username, detail: { reliefThrough: day }, outcome: 'ok', principalId: caller.principal.id }, { accountId: account.id, resellerId: account.ownerId })
  return json({ accounts: relieved, reliefThrough: day, reconcile, execution: ports.execution() })
}

/** GET /api/accounts/disk-quotas: the accounts this caller may see, each with its disk limit in force and where it comes from. */
async function diskQuotas(req: Request, url: URL, method: string, ports: AccountLimitsPorts): Promise<Response> {
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  const query = parseDiskQuotaQuery(url.searchParams)
  const caller = await ports.requireCaller(req)
  const kind = caller.principal.kind
  if (kind !== 'root' && kind !== 'reseller') return fail('FORBIDDEN', 'disk quotas are managed by root and resellers', unchanged)
  const snapshot = await ports.store.readSnapshot(), plans = new Map(snapshot.plans.map(plan => [plan.id, plan])), resellers = new Map(snapshot.resellers.map(reseller => [reseller.id, reseller.username]))
  const visible = snapshot.accounts.filter(account => account.status !== 'terminating' && (kind === 'root' || account.ownerId === caller.principal.id))
  let usage: DiskQuotaPage['usage'] = { state: 'unavailable', observedAt: null, reason: kind === 'root' ? 'quota_report_unavailable' : 'usage_root_only' }
  const used = new Map<string, number | null>()
  if (kind === 'root' && ports.readDisk) {
    try {
      const disk = projectDisk(await ports.readDisk(caller))
      if (disk.accounts.state === 'read') { usage = { state: 'read', observedAt: disk.observedAt, reason: null }; for (const item of disk.accounts.items) used.set(item.username, item.usedBytes === null ? null : Math.ceil(item.usedBytes / 1048576)) }
      else usage = { state: 'unavailable', observedAt: disk.observedAt, reason: disk.accounts.reason ?? 'quota_report_unavailable' }
    } catch (error) { if (isXpanelError(error) && ['FORBIDDEN', 'UNAUTHENTICATED'].includes(error.code)) throw error }
  }
  const rows = visible.map((account): DiskQuotaRow => {
    const plan = plans.get(account.planId), custom = account.limits?.resources?.diskMb
    return { accountId: account.id, username: account.username, domain: account.primaryDomain, ownerId: account.ownerId, owner: account.ownerId === null ? 'root' : resellers.get(account.ownerId) ?? null,
      usedMb: used.get(account.username) ?? null, limitMb: custom ?? plan?.resources.diskMb ?? null, source: custom === undefined ? 'package' : 'account', packageLimitMb: plan?.resources.diskMb ?? null, planName: plan?.name ?? null }
  })
  const paged = pageDiskQuotas(rows, query)
  const body: DiskQuotaPage = { rows: paged.rows, total: paged.total, page: paged.page, pageSize: query.pageSize, sort: query.sort, dir: query.dir, usage }
  return json(body)
}

export const PACKAGE_RESOLUTIONS = ['switch', 'create', 'update', 'detach', 'keep'] as const
/** WHM modifyacct names; every package limit is also accepted under its own name. */
const WHM_LIMIT_NAMES: Readonly<Record<string, string>> = { maxaddon: 'addonDomains', maxpark: 'aliasDomains', maxsub: 'subdomains', maxpop: 'mailboxes', maxlst: 'mailingLists', maxftp: 'ftpAccounts', maxsql: 'databases', quota: 'diskMb', bwlimit: 'bandwidthMbMonth' }
const limitGroup = (key: string): 'resources' | 'caps' | null => { const field = WHM_LIMIT_NAMES[key] ?? key; return Object.hasOwn(RESOURCE_RULES, field) ? 'resources' : Object.hasOwn(PLAN_CAP_RULES, field) ? 'caps' : null }
export const isPackageLimitPatch = (body: object): boolean => Object.keys(body).some(key => limitGroup(key) !== null)

export interface PackageChangePorts {
  store: Pick<StateStore, 'getPlan' | 'listPlans' | 'createPlan' | 'updatePlan'>
  principal: Principal
  changePlan: (planId: string) => Promise<unknown>
  /** saveAccountLimits for this caller and account. */
  saveLimits: (patch: AccountLimits) => Promise<unknown>
  /** A package edit reaches every account on the package, so this reconcile has no account scope. */
  reconcileAll: () => Promise<unknown>
  /** Refuses a reseller without allow-unlimited-plans. */
  assertUnlimitedAllowed: () => Promise<void>
  audit: (action: string, plan: Plan) => Promise<unknown>
}
const samePackageValues = (left: Record<string, Limit>, right: Record<string, Limit>): boolean => Object.keys(left).every(key => left[key] === right[key])

/** PATCH /api/accounts/:id with limit fields (WHM Modify Account): a value off the package needs an explicit resolution. */
export async function changeAccountPackageLimit(account: Account, raw: Record<string, unknown>, ports: PackageChangePorts): Promise<unknown> {
  const resources: Record<string, Limit> = {}, caps: Record<string, Limit> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'resolution') continue
    const group = limitGroup(key)
    if (!group) return fail('VALIDATION', 'a package limit change takes limit fields and resolution only', unchanged)
    if (typeof value !== 'number' && value !== 'unlimited') return fail('VALIDATION', key + " must be a number or 'unlimited'", unchanged)
    ;(group === 'caps' ? caps : resources)[WHM_LIMIT_NAMES[key] ?? key] = value
  }
  const patch = parseAccountLimitsPatch({ ...(Object.keys(resources).length && { resources }), ...(Object.keys(caps).length && { caps }) })
  if (Object.values({ ...resources, ...caps }).includes('unlimited')) await ports.assertUnlimitedAllowed()
  const plan = await ports.store.getPlan(account.planId) ?? fail('NOT_FOUND', 'plan not found', unchanged)
  const current = effectivePlan(plan, account)
  if (samePackageValues(resources, current.resources as unknown as Record<string, Limit>) && samePackageValues(caps, current.caps as unknown as Record<string, Limit>)) return { account, stateChanged: false }
  // A value back on the package drops the account's own override; nothing diverges, so no resolution is due.
  if (samePackageValues(resources, plan.resources as unknown as Record<string, Limit>) && samePackageValues(caps, plan.caps as unknown as Record<string, Limit>)) {
    const clear = (group: Record<string, Limit>) => Object.fromEntries(Object.keys(group).map(key => [key, null]))
    return ports.saveLimits({ ...(patch.resources && { resources: clear(resources) }), ...(patch.caps && { caps: clear(caps) }) } as AccountLimits)
  }
  if (raw.resolution === undefined) return fail('CONFLICT', 'these values differ from the assigned package; choose a resolution', { ...unchanged, reason: 'package_conflict', resolutions: PACKAGE_RESOLUTIONS })
  const wanted = { resources: { ...current.resources, ...resources }, caps: { ...current.caps, ...caps } }
  if (raw.resolution === 'switch') {
    const same = (await ports.store.listPlans()).find(item => item.id !== plan.id && item.ownerId === plan.ownerId && samePackageValues(wanted.caps, item.caps as unknown as Record<string, Limit>) && samePackageValues(wanted.resources, item.resources as unknown as Record<string, Limit>))
    return same ? ports.changePlan(same.id) : fail('CONFLICT', 'no package matches these values', { ...unchanged, reason: 'no_matching_package' })
  }
  if (raw.resolution === 'create' || raw.resolution === 'update') assertCanManagePlan(ports.principal, plan)
  if (raw.resolution === 'create') {
    const { id: _id, ...fields } = plan
    const created = await ports.store.createPlan({ ...fields, name: `${plan.name}_${account.username}`, ...wanted })
    await ports.audit('plan.created', created)
    return ports.changePlan(created.id)
  }
  if (raw.resolution === 'update') {
    // This account's other overrides stay its own: only the changed fields reach the shared package.
    const updated = await ports.store.updatePlan(plan.id, { ...(patch.resources && { resources: { ...plan.resources, ...resources } }), ...(patch.caps && { caps: { ...plan.caps, ...caps } }) })
    const reconcile = await ports.reconcileAll()
    await ports.audit('plan.updated', updated)
    return { plan: updated, reconcile }
  }
  if (raw.resolution === 'keep') return ports.saveLimits(patch)
  // Every account keeps a package here: see docs/decisions/qualification-codes.md.
  return raw.resolution === 'detach' ? fail('PRECONDITION_FAILED', 'every account keeps a package; use create for its own package or keep to hold its own limit', { ...unchanged, reason: 'package_required' })
    : fail('VALIDATION', 'unknown resolution', { ...unchanged, resolutions: PACKAGE_RESOLUTIONS })
}
