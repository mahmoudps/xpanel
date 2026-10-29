import { fail, isXpanelError } from '@xpanel/core'
import type { Account, Domain, FeatureList, Plan } from '@xpanel/core'
import { applicationDigest } from '../../../packages/os/src/application-artifact.ts'
import { ApplicationInstallCoordinator, applicationInstallProviderAvailable, readApplicationInstallation } from './application-install.ts'
import type { ApplicationArtifactProvider, ApplicationInstallDeps, ApplicationTarget } from './application-install.ts'
import type { SwApplicationCatalogSource } from './sw-application-catalog-store.ts'
import type { HostJobPlan, HostJobView } from './host-job-contract.ts'
import type { AgentCallerIdentity } from './server.ts'

/**
 * Account route for signed-catalog applications on an owned domain. Every read and write goes through the
 * existing ApplicationInstallCoordinator; without an admitted descriptor-confined provider it reports the
 * unavailable state and refuses writes before any job exists (no JSON-only success is possible).
 * shortcut: the coordinator is per request while no provider is admitted; admitting one requires a process
 * coordinator registered as the host-job runner's APPLICATION_TRANSACTION_COMMAND dispatcher.
 */
export const APPLICATIONS_FEATURE = 'application-manager'
export interface SwApplicationsContext {
  caller: AgentCallerIdentity
  store: { getAccountByUsername(username: string): Promise<Account | null>; listDomains(): Promise<Domain[]>; getPlan(id: string): Promise<Plan | null>; getFeatureList(id: string): Promise<FeatureList | null>; withAccountLifecycleLease<T>(id: string, operation: (account: Account) => Promise<T>): Promise<T> }
  currentPrincipal(): Promise<{ kind: string; id: string; username: string; accountId: string | null; disabled: boolean } | null>
  catalog: SwApplicationCatalogSource | null
  provider: ApplicationArtifactProvider | null
  submitJob: ((plan: HostJobPlan, actor: string) => Promise<HostJobView>) | null
  audit(entry: { actor: string; action: string; target: string; detail: Record<string, unknown>; outcome: 'ok' | 'failed'; principalId: string }): Promise<unknown>
}
export interface SwApplicationsView {
  context: { accountId: string; username: string }
  catalog: { state: 'read' | 'unavailable'; reason: null | 'not-configured' | 'not-verified'; revision: string | null; sequence: number | null; expiresAt: string | null; applications: { id: string; name: string; versions: string[] }[] }
  domains: { id: string; name: string }[]
  selected: null | { domainId: string; state: 'read' | 'unavailable'; reason: null | 'application_provider_unavailable' | 'application_catalog_unavailable'; revision: string | null; installation: null | { appId: string; version: string; previousVersion: string | null }; recoveryRequired: boolean | null; writesAvailable: boolean }
}
const unchanged = { stateChanged: false }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const isSite = (account: Account, domain: Domain): boolean => domain.accountId === account.id && !domain.suspended && UUID.test(domain.id) && UUID.test(account.id)

export async function handleSwApplicationsRoute(req: Request, url: URL, method: string, ctx: SwApplicationsContext): Promise<Response | null> {
  const match = /^\/accounts\/([a-z][a-z0-9]{0,15})\/applications(\/jobs)?$/.exec(url.pathname)
  if (!match) return null
  const jobs = match[2] === '/jobs', expected = jobs ? 'POST' : 'GET'
  if (method !== expected) return new Response(null, { status: 405, headers: { allow: expected } })
  const caller = ctx.caller
  if (caller.role !== 'user' || !caller.accountId) return fail('FORBIDDEN', 'applications require the signed-in account owner', unchanged)
  let domainId: string | null = null, body: Record<string, unknown> | null = null
  if (jobs) {
    if (url.search) return fail('VALIDATION', 'application jobs do not accept selectors', unchanged)
    const text = await req.text()
    let raw: unknown
    try { raw = text.length <= 2048 ? JSON.parse(text) : null } catch { raw = null }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof (raw as Record<string, unknown>).domainId !== 'string') return fail('VALIDATION', 'choose an owned domain and a reviewed application change', unchanged)
    body = raw as Record<string, unknown>; domainId = body.domainId as string
  } else {
    const keys = [...url.searchParams.keys()]
    domainId = url.searchParams.get('domainId')
    if (keys.length > 1 || keys.length === 1 && keys[0] !== 'domainId') return fail('VALIDATION', 'select one owned domain; paths are not accepted', unchanged)
  }
  if (domainId !== null && !UUID.test(domainId)) return fail('VALIDATION', 'select one owned domain; paths are not accepted', unchanged)
  const target = await ctx.store.getAccountByUsername(match[1]!)
  if (!target || target.id !== caller.accountId) return fail('FORBIDDEN', 'the account does not match the current owner', unchanged)
  const assertAuthority = async (): Promise<void> => {
    const principal = await ctx.currentPrincipal()
    if (!principal || principal.disabled || principal.kind !== 'user' || principal.id !== caller.principalId || principal.accountId !== target.id || principal.username !== target.username) return fail('FORBIDDEN', 'current account owner is not authorized for applications', unchanged)
  }
  const targetFor = async (account: Account): Promise<ApplicationTarget> => {
    const plan = await ctx.store.getPlan(account.planId), features = plan ? await ctx.store.getFeatureList(plan.featureListId) : null
    if (account.id !== target.id || account.status !== 'active' || !features || features.disabled.includes(APPLICATIONS_FEATURE)) return fail('FORBIDDEN', 'this account is not active or its plan does not allow applications', unchanged)
    const domain = (await ctx.store.listDomains()).find(item => item.id === domainId)
    if (!domain || !isSite(account, domain)) return fail('NOT_FOUND', 'the domain is not an active site of this account', unchanged)
    return { accountId: account.id, domainId: domain.id, uid: account.uid, gid: account.gid, identity: applicationDigest(JSON.stringify([account.id, account.uid, account.gid, account.home, domain.id, domain.docRoot])) }
  }
  const deps = (source: SwApplicationCatalogSource): ApplicationInstallDeps => ({
    provider: ctx.provider, catalog: () => source.catalog(), policy: () => source.policy(), assertAuthority,
    assertFresh: async () => { await assertAuthority(); const account = await ctx.store.getAccountByUsername(target.username); if (!account) return fail('FORBIDDEN', 'the account changed', unchanged); return targetFor(account) },
    withAccountLease: (lease, operation) => ctx.store.withAccountLifecycleLease(lease.accountId, async account => operation(await targetFor(account))),
  })
  if (jobs) {
    if (!ctx.catalog) return fail('PRECONDITION_FAILED', 'no signed application catalog is configured on this server', { ...unchanged, reason: 'application_catalog_unavailable' })
    if (!applicationInstallProviderAvailable(ctx.provider) || !ctx.submitJob) return fail('PRECONDITION_FAILED', 'application writes require an admitted descriptor-confined account artifact provider', { ...unchanged, reason: 'application_provider_unavailable' })
    const { domainId: _domain, ...request } = body!
    const prepared = await new ApplicationInstallCoordinator(deps(ctx.catalog)).prepare(request)
    await assertAuthority()
    let job: HostJobView
    try { job = await ctx.submitJob(prepared.plan, caller.actor) }
    catch (error) {
      if (isXpanelError(error) && error.detail?.stateChanged === false && prepared.discardUnstarted()) throw error
      return fail('SERVICE_UNAVAILABLE', 'application job submission requires review', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
    }
    if (!job || typeof job.id !== 'string' || job.kind !== prepared.plan.kind || job.accountId !== target.id) return fail('SERVICE_UNAVAILABLE', 'application job submission requires review', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
    await ctx.audit({ actor: caller.actor, principalId: caller.principalId, action: 'account.application.job_submitted', target: 'account:' + target.username, outcome: 'ok', detail: { kind: job.kind, jobId: job.id } }).catch(() => {})
    return json(202, { job })
  }
  await assertAuthority()
  const owned = await ctx.store.withAccountLifecycleLease(target.id, async account => {
    const plan = await ctx.store.getPlan(account.planId), features = plan ? await ctx.store.getFeatureList(plan.featureListId) : null
    if (account.status !== 'active' || !features || features.disabled.includes(APPLICATIONS_FEATURE)) return fail('FORBIDDEN', 'this account is not active or its plan does not allow applications', unchanged)
    return (await ctx.store.listDomains()).filter(domain => isSite(account, domain)).sort((a, b) => a.name.localeCompare(b.name, 'en')).slice(0, 1000).map(domain => ({ id: domain.id, name: domain.name }))
  })
  if (domainId !== null && !owned.some(item => item.id === domainId)) return fail('NOT_FOUND', 'the domain is not an active site of this account', unchanged)
  const view: SwApplicationsView = { context: { accountId: target.id, username: target.username }, catalog: { state: 'unavailable', reason: 'not-configured', revision: null, sequence: null, expiresAt: null, applications: [] }, domains: owned, selected: null }
  let catalogReady = false
  if (ctx.catalog) {
    try {
      const catalog = await ctx.catalog.catalog()
      view.catalog = { state: 'read', reason: null, revision: catalog.revision, sequence: catalog.sequence, expiresAt: catalog.expiresAt, applications: catalog.applications.map(app => ({ id: app.id, name: app.name, versions: app.releases.map(release => release.version) })) }
      catalogReady = true
    } catch (error) { if (!isXpanelError(error)) throw error; view.catalog.reason = error.detail?.reason === 'application_catalog_unavailable' ? 'not-configured' : 'not-verified' }
  }
  if (domainId !== null) {
    if (!catalogReady) view.selected = { domainId, state: 'unavailable', reason: 'application_catalog_unavailable', revision: null, installation: null, recoveryRequired: null, writesAvailable: false }
    else {
      const read = await readApplicationInstallation(deps(ctx.catalog!))
      const o = read.observation, current = o?.installation ?? null
      view.selected = { domainId, state: o ? 'read' : 'unavailable', reason: read.reason, revision: o?.revision ?? null, recoveryRequired: o ? o.recoveryRequired : null, writesAvailable: read.writesAvailable && ctx.submitJob !== null,
        installation: current ? { appId: current.appId, version: current.version, previousVersion: current.previous?.version ?? null } : null }
    }
  }
  await assertAuthority()
  return json(200, view)
}
