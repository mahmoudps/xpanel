import { fail, isXpanelError } from '@xpanel/core'
import type { Account, Domain, FeatureList, Plan } from '@xpanel/core'
import { applicationDigest, readApplicationPath } from '../../../packages/os/src/application-artifact.ts'
import { applicationInstallProviderAvailable, readApplicationInstallation, recoverApplicationInstallations } from './application-install.ts'
import type { ApplicationArtifactProvider, ApplicationDatabasePort, ApplicationInstallCoordinator, ApplicationInstallDeps, ApplicationTarget } from './application-install.ts'
import { applicationRoot, ownedApplications } from './application-provider.ts'
import type { ApplicationInstanceRecord } from './application-provider.ts'
import type { SwApplicationCatalogSource } from './sw-application-catalog-store.ts'
import type { HostJobPlan, HostJobView } from './host-job-contract.ts'
import type { AgentCallerIdentity } from './server.ts'

/**
 * Account route for signed-catalog applications on an owned domain or a directory under it. Every read and write goes
 * through the process ApplicationInstallCoordinator; without an admitted provider it reports the unavailable state and
 * refuses writes before any job exists (no JSON-only success is possible).
 */
export const APPLICATIONS_FEATURE = 'application-manager'
type ApplicationStore = { getAccountByUsername(username: string): Promise<Account | null>; listDomains(): Promise<Domain[]>; getPlan(id: string): Promise<Plan | null>; getFeatureList(id: string): Promise<FeatureList | null>; withAccountLifecycleLease<T>(id: string, operation: (account: Account) => Promise<T>): Promise<T> }
export interface SwApplicationsContext {
  caller: AgentCallerIdentity
  store: ApplicationStore
  currentPrincipal(): Promise<{ kind: string; id: string; username: string; accountId: string | null; disabled: boolean } | null>
  catalog: SwApplicationCatalogSource | null
  /** Application ids root offers on this server (site-software.ts); null when the saved offer cannot be verified. */
  offered(): Promise<readonly string[] | null>
  provider: ApplicationArtifactProvider | null
  database: ApplicationDatabasePort | null
  coordinator: ApplicationInstallCoordinator | null
  instances(account: Account): Promise<ApplicationInstanceRecord[]>
  submitJob: ((plan: HostJobPlan, actor: string) => Promise<HostJobView>) | null
  audit(entry: { actor: string; action: string; target: string; detail: Record<string, unknown>; outcome: 'ok' | 'failed'; principalId: string }): Promise<unknown>
}
export interface SwApplicationInstanceView { domainId: string; domain: string; path: string; appId: string; version: string; previousVersion: string | null; database: string | null; updatedAt: string }
export interface SwApplicationsView {
  context: { accountId: string; username: string }
  catalog: { state: 'read' | 'unavailable'; reason: null | 'not-configured' | 'not-verified' | 'expired'; revision: string | null; sequence: number | null; expiresAt: string | null; applications: { id: string; name: string; versions: string[] }[] }
  domains: { id: string; name: string }[]
  instances: SwApplicationInstanceView[]
  selected: null | { domainId: string; path: string; state: 'read' | 'unavailable'; reason: string | null; revision: string | null; installation: null | { appId: string; version: string; previousVersion: string | null }; recoveryRequired: boolean | null; modified: boolean | null; writesAvailable: boolean }
}
const unchanged = { stateChanged: false }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
export const isApplicationSite = (account: Account, domain: Domain): boolean => domain.accountId === account.id && !domain.suspended && UUID.test(domain.id) && UUID.test(account.id)

export interface ApplicationScope {
  store: ApplicationStore
  source: SwApplicationCatalogSource
  provider: ApplicationArtifactProvider | null
  database: ApplicationDatabasePort | null
  account: Pick<Account, 'id' | 'username'>
  domainId: string
  path: string
  /** Root keeps removal and update of what an account's plan no longer allows; the owner is held to the plan. */
  holdToPlan: boolean
  assertAuthority(): Promise<void>
}
/** The one definition of an application target: fresh account, owned active site, and only then the validated path. */
export function applicationDeps(scope: ApplicationScope): ApplicationInstallDeps {
  const { store } = scope
  const targetFor = async (account: Account): Promise<ApplicationTarget> => {
    const plan = await store.getPlan(account.planId), features = plan ? await store.getFeatureList(plan.featureListId) : null
    if (account.id !== scope.account.id || account.status !== 'active' || scope.holdToPlan && (!features || features.disabled.includes(APPLICATIONS_FEATURE))) return fail('FORBIDDEN', 'this account is not active or its plan does not allow applications', unchanged)
    const domain = (await store.listDomains()).find(item => item.id === scope.domainId)
    if (!domain || !isApplicationSite(account, domain)) return fail('NOT_FOUND', 'the domain is not an active site of this account', unchanged)
    return { accountId: account.id, domainId: domain.id, domain: domain.name, username: account.username, home: account.home, root: applicationRoot(account, domain, scope.path), path: scope.path, uid: account.uid, gid: account.gid,
      identity: applicationDigest(JSON.stringify([account.id, account.uid, account.gid, account.home, domain.id, domain.docRoot, scope.path])) }
  }
  return {
    provider: scope.provider, database: scope.database, catalog: () => scope.source.catalog(), removalCatalog: () => scope.source.removalCatalog(), policy: () => scope.source.policy(), assertAuthority: scope.assertAuthority,
    assertFresh: async () => { await scope.assertAuthority(); const account = await store.getAccountByUsername(scope.account.username); if (!account) return fail('FORBIDDEN', 'the account changed', unchanged); return targetFor(account) },
    withAccountLease: (lease, operation) => store.withAccountLifecycleLease(lease.accountId, async account => operation(await targetFor(account))),
  }
}

export async function handleSwApplicationsRoute(req: Request, url: URL, method: string, ctx: SwApplicationsContext): Promise<Response | null> {
  const match = /^\/accounts\/([a-z][a-z0-9]{0,15})\/applications(\/jobs|\/recover)?$/.exec(url.pathname)
  if (!match) return null
  const jobs = match[2] === '/jobs', recovering = match[2] === '/recover', expected = jobs || recovering ? 'POST' : 'GET'
  if (method !== expected) return new Response(null, { status: 405, headers: { allow: expected } })
  const caller = ctx.caller
  if (caller.role !== 'user' || !caller.accountId) return fail('FORBIDDEN', 'applications require the signed-in account owner', unchanged)
  let domainId: string | null = null, body: Record<string, unknown> | null = null, rawPath: unknown = undefined
  if (expected === 'POST') {
    if (url.search) return fail('VALIDATION', 'application jobs do not accept selectors', unchanged)
    const text = await req.text()
    let raw: unknown
    try { raw = text.length <= 2048 ? JSON.parse(text) : null } catch { raw = null }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof (raw as Record<string, unknown>).domainId !== 'string') return fail('VALIDATION', 'choose an owned domain and a reviewed application change', unchanged)
    body = raw as Record<string, unknown>; domainId = body.domainId as string; rawPath = body.path
  } else {
    const keys = [...url.searchParams.keys()]
    domainId = url.searchParams.get('domainId'); rawPath = url.searchParams.get('path') ?? undefined
    if (keys.length > 2 || keys.some(key => key !== 'domainId' && key !== 'path') || new Set(keys).size !== keys.length || rawPath !== undefined && domainId === null) return fail('VALIDATION', 'select one owned domain and an optional directory under it', unchanged)
  }
  if (domainId !== null && !UUID.test(domainId)) return fail('VALIDATION', 'select one owned domain and an optional directory under it', unchanged)
  const path = readApplicationPath(rawPath)
  const target = await ctx.store.getAccountByUsername(match[1]!)
  if (!target || target.id !== caller.accountId) return fail('FORBIDDEN', 'the account does not match the current owner', unchanged)
  const assertAuthority = async (): Promise<void> => {
    const principal = await ctx.currentPrincipal()
    if (!principal || principal.disabled || principal.kind !== 'user' || principal.id !== caller.principalId || principal.accountId !== target.id || principal.username !== target.username) return fail('FORBIDDEN', 'current account owner is not authorized for applications', unchanged)
  }
  const deps = (source: SwApplicationCatalogSource): ApplicationInstallDeps => applicationDeps({ store: ctx.store, source, provider: ctx.provider, database: ctx.database, account: target, domainId: domainId!, path, holdToPlan: true, assertAuthority })
  if (recovering) {
    if (!ctx.catalog) return fail('PRECONDITION_FAILED', 'no signed application catalog is configured on this server', { ...unchanged, reason: 'application_catalog_unavailable' })
    const results = await recoverApplicationInstallations(deps(ctx.catalog))
    await ctx.audit({ actor: caller.actor, principalId: caller.principalId, action: 'account.application.recovered', target: 'account:' + target.username, outcome: results.every(item => item.verified) ? 'ok' : 'failed', detail: { domainId, path, states: results.map(item => item.state) } }).catch(() => {})
    return json(200, { results })
  }
  if (jobs) {
    if (!ctx.catalog) return fail('PRECONDITION_FAILED', 'no signed application catalog is configured on this server', { ...unchanged, reason: 'application_catalog_unavailable' })
    // Removing or rolling back stays possible after root withdraws an application from the offer.
    if ((body!.action === 'install' || body!.action === 'update') && !(await ctx.offered() ?? []).includes(String(body!.appId))) return fail('NOT_FOUND', 'the application is not offered on this server', { ...unchanged, reason: 'application_not_offered' })
    if (!applicationInstallProviderAvailable(ctx.provider) || !ctx.submitJob || !ctx.coordinator) return fail('PRECONDITION_FAILED', 'application writes require an admitted descriptor-confined account artifact provider', { ...unchanged, reason: 'application_provider_unavailable' })
    const { domainId: _domain, path: _path, ...request } = body!
    return json(202, { job: await submitApplicationJob(ctx.coordinator, ctx.submitJob, request, deps(ctx.catalog), caller.actor, target.id, assertAuthority, job => ctx.audit({ actor: caller.actor, principalId: caller.principalId, action: 'account.application.job_submitted', target: 'account:' + target.username, outcome: 'ok', detail: { kind: job.kind, jobId: job.id } })) })
  }
  await assertAuthority()
  const owned = await ctx.store.withAccountLifecycleLease(target.id, async account => {
    const plan = await ctx.store.getPlan(account.planId), features = plan ? await ctx.store.getFeatureList(plan.featureListId) : null
    if (account.status !== 'active' || !features || features.disabled.includes(APPLICATIONS_FEATURE)) return fail('FORBIDDEN', 'this account is not active or its plan does not allow applications', unchanged)
    return (await ctx.store.listDomains()).filter(domain => isApplicationSite(account, domain)).sort((a, b) => a.name.localeCompare(b.name, 'en')).slice(0, 1000)
  })
  if (domainId !== null && !owned.some(item => item.id === domainId)) return fail('NOT_FOUND', 'the domain is not an active site of this account', unchanged)
  const instances = ownedApplications(target, owned, await ctx.instances(target)).map(({ domainId: id, domain, path: where, appId, version, previousVersion, database, updatedAt }): SwApplicationInstanceView => ({ domainId: id, domain, path: where, appId, version, previousVersion, database: database?.name ?? null, updatedAt }))
  const view: SwApplicationsView = { context: { accountId: target.id, username: target.username }, catalog: { state: 'unavailable', reason: 'not-configured', revision: null, sequence: null, expiresAt: null, applications: [] }, domains: owned.map(domain => ({ id: domain.id, name: domain.name })), instances, selected: null }
  let catalogReady = false, removable = false
  if (ctx.catalog) {
    try {
      const catalog = await ctx.catalog.catalog(), offered = await ctx.offered() ?? []
      view.catalog = { state: 'read', reason: null, revision: catalog.revision, sequence: catalog.sequence, expiresAt: catalog.expiresAt,
        applications: catalog.applications.filter(app => offered.includes(app.id)).map(app => ({ id: app.id, name: app.name, versions: app.releases.map(release => release.version) })) }
      catalogReady = true
    } catch (error) {
      if (!isXpanelError(error)) throw error
      view.catalog.reason = error.detail?.reason === 'application_catalog_unavailable' ? 'not-configured' : 'not-verified'
      // Only a date stands between the owner and removal: the revision below is what the remove job binds to.
      const held = view.catalog.reason === 'not-verified' ? await ctx.catalog.removalCatalog().catch(() => null) : null
      if (held) { view.catalog = { ...view.catalog, reason: 'expired', revision: held.revision, sequence: held.sequence, expiresAt: held.expiresAt }; removable = true }
    }
  }
  if (domainId !== null) {
    const unavailable = (reason: string): SwApplicationsView['selected'] => ({ domainId: domainId!, path, state: 'unavailable', reason, revision: null, installation: null, recoveryRequired: null, modified: null, writesAvailable: false })
    if (!catalogReady && !removable) view.selected = unavailable('application_catalog_unavailable')
    else try {
      const read = await readApplicationInstallation(deps(ctx.catalog!), removable ? 'remove' : 'read')
      const o = read.observation, current = o?.installation ?? null
      view.selected = !o ? unavailable(read.reason ?? 'application_provider_unavailable') : { domainId, path, state: 'read', reason: null, revision: o.revision, recoveryRequired: o.recoveryRequired, modified: !o.managedClean, writesAvailable: read.writesAvailable && ctx.submitJob !== null,
        installation: current ? { appId: current.appId, version: current.version, previousVersion: current.previous?.version ?? null } : null }
    } catch (error) { if (!isXpanelError(error) || typeof error.detail?.reason !== 'string') throw error; view.selected = unavailable(error.detail.reason) }
  }
  await assertAuthority()
  return json(200, view)
}

/** Prepares under the coordinator and submits; a job whose submission cannot be proven is reported as unknown, never as refused. */
export async function submitApplicationJob(coordinator: ApplicationInstallCoordinator, submitJob: (plan: HostJobPlan, actor: string) => Promise<HostJobView>, request: Record<string, unknown>, deps: ApplicationInstallDeps, actor: string, accountId: string,
  assertAuthority: () => Promise<void>, audit: (job: HostJobView) => Promise<unknown>): Promise<HostJobView> {
  const prepared = await coordinator.prepare(request, deps)
  await assertAuthority()
  let job: HostJobView
  try { job = await submitJob(prepared.plan, actor) }
  catch (error) {
    if (isXpanelError(error) && error.detail?.stateChanged === false && prepared.discardUnstarted()) throw error
    return fail('SERVICE_UNAVAILABLE', 'application job submission requires review', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  }
  if (!job || typeof job.id !== 'string' || job.kind !== prepared.plan.kind || job.accountId !== accountId) return fail('SERVICE_UNAVAILABLE', 'application job submission requires review', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  await audit(job).catch(() => {})
  return job
}
