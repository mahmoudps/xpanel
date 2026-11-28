import { fail } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { isApplicationDigest, isApplicationId, isApplicationVersion, readApplicationPath } from '../../../packages/os/src/application-artifact.ts'
import { applicationInstallProviderAvailable, readApplicationInstallation } from './application-install.ts'
import type { ApplicationArtifactProvider, ApplicationDatabasePort, ApplicationInstallCoordinator } from './application-install.ts'
import { APPLICATION_ARTIFACT_CHUNK_BYTES, ownedApplications } from './application-provider.ts'
import type { ApplicationInstanceRecord, StoredApplicationArtifacts } from './application-provider.ts'
import type { HostJobPlan, HostJobView } from './host-job-contract.ts'
import type { SwApplicationCatalogSource } from './sw-application-catalog-store.ts'
import { applicationDeps, submitApplicationJob } from './sw-applications.ts'
import type { ApplicationScope } from './sw-applications.ts'

/**
 * WHM Installed Site Software: every account's installed applications, read from each account's own records, with root
 * update and uninstall through the same coordinator the owner uses. Also receives signed releases into the artifact store.
 */
export interface SiteSoftwareInstanceView { username: string; accountId: string; domainId: string; domain: string; path: string; appId: string; version: string; previousVersion: string | null; database: string | null; updatedAt: string; revision: string; accountStatus: string }
export interface SiteSoftwareInstancesContext {
  /** Fresh caller identity on every call; root only. */
  authenticate(): Promise<{ actor: string; role: string; principalId: string }>
  store: ApplicationScope['store'] & { listAccounts(): Promise<Account[]> }
  source: SwApplicationCatalogSource | null
  provider: ApplicationArtifactProvider | null
  database: ApplicationDatabasePort | null
  coordinator: ApplicationInstallCoordinator | null
  artifacts: StoredApplicationArtifacts | null
  instances(account: Account): Promise<ApplicationInstanceRecord[]>
  submitJob: ((plan: HostJobPlan, actor: string) => Promise<HostJobView>) | null
  audit(entry: { action: string; target: string; outcome: 'ok' | 'failed'; detail: Record<string, unknown> }): Promise<unknown>
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const USERNAME_RE = /^[a-z][a-z0-9]{0,15}$/
const unchanged = { stateChanged: false }
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, fields: readonly string[]): boolean => Object.keys(value).sort().join() === [...fields].sort().join()
const readBody = async (req: Request, limit: number): Promise<Record<string, unknown>> => {
  const text = await req.text()
  let body: unknown
  try { body = text.length <= limit ? JSON.parse(text) : null } catch { body = null }
  return object(body) ? body : fail('VALIDATION', 'a JSON object within the size limit is required', unchanged)
}

export async function handleSiteSoftwareInstancesRoute(req: Request, url: URL, method: string, ctx: SiteSoftwareInstancesContext): Promise<Response | null> {
  const paths = {
    '/host/site-software/instances': 'GET',
    '/host/site-software/target': 'GET',
    '/host/site-software/instances/jobs': 'POST',
    '/host/site-software/artifacts': 'POST',
    '/host/software/one-click/deploy': 'POST',
    '/host/software/app-installer/install': 'POST',
  } as Record<string, string>
  const expected = Object.hasOwn(paths, url.pathname) ? paths[url.pathname]! : null
  if (!expected) return null
  if (method !== expected) return new Response(null, { status: 405, headers: { allow: expected } })
  if (url.search && url.pathname !== '/host/site-software/target') return fail('VALIDATION', 'site software routes accept no query selectors', unchanged)
  const caller = await ctx.authenticate()
  if (caller.role !== 'root') return fail('FORBIDDEN', 'root role is required for site software', unchanged)
  if (url.pathname === '/host/site-software/artifacts') return receiveArtifact(req, ctx)
  if (url.pathname === '/host/site-software/target') return readInstallTarget(url, caller, ctx)
  if (expected === 'GET') return json(200, { instances: await listInstances(ctx) })
  if (url.pathname === '/host/software/one-click/deploy' || url.pathname === '/host/software/app-installer/install') {
    return submitRootInstallJob(req, url.pathname === '/host/software/one-click/deploy', caller, ctx)
  }
  const body = await readBody(req, 2048)
  if (!exact(body, ['username', 'domainId', 'path', 'action', 'expectedRecord', ...(body.action === 'update' ? ['version'] : [])]) || typeof body.username !== 'string' || typeof body.domainId !== 'string' || !isApplicationDigest(body.expectedRecord)
    || !['update', 'remove'].includes(String(body.action)) || body.action === 'update' && !isApplicationVersion(body.version)) return fail('VALIDATION', 'choose one listed installation and an update or removal', unchanged)
  if (!ctx.source) return fail('PRECONDITION_FAILED', 'no signed application catalog is configured on this server', { ...unchanged, reason: 'application_catalog_unavailable' })
  if (!applicationInstallProviderAvailable(ctx.provider) || !ctx.submitJob || !ctx.coordinator) return fail('PRECONDITION_FAILED', 'application writes require an admitted descriptor-confined account artifact provider', { ...unchanged, reason: 'application_provider_unavailable' })
  const path = readApplicationPath(body.path), account = await ctx.store.getAccountByUsername(body.username) ?? fail('NOT_FOUND', 'the account does not exist', unchanged)
  const record = ownedApplications(account, await ctx.store.listDomains(), await ctx.instances(account)).find(item => item.domainId === body.domainId && item.path === path)
  if (!record) return fail('NOT_FOUND', 'the installation no longer exists', unchanged)
  if (record.revision !== body.expectedRecord) return fail('CONFLICT', 'the installation changed; read the list again', unchanged)
  const assertAuthority = async (): Promise<void> => { const fresh = await ctx.authenticate(); if (fresh.role !== 'root' || fresh.principalId !== caller.principalId) fail('FORBIDDEN', 'root authority changed', unchanged) }
  const deps = applicationDeps({ store: ctx.store, source: ctx.source, provider: ctx.provider, database: ctx.database, account, domainId: record.domainId, path, holdToPlan: false, assertAuthority })
  const read = await readApplicationInstallation(deps, body.action === 'remove' ? 'remove' : 'read')
  const request = { action: body.action, appId: record.appId, expectedRevision: read.observation!.revision, expectedCatalogRevision: read.catalog.revision, ...(body.action === 'update' ? { version: body.version } : {}) }
  const job = await submitApplicationJob(ctx.coordinator, ctx.submitJob, request, deps, caller.actor, account.id, assertAuthority, submitted =>
    ctx.audit({ action: 'server.site_software.instance_job_submitted', target: 'account:' + account.username, outcome: 'ok', detail: { domain: record.domain, path, appId: record.appId, kind: submitted.kind, jobId: submitted.id } }))
  return json(202, { job })
}

async function readInstallTarget(
  url: URL,
  caller: { actor: string; role: string; principalId: string },
  ctx: SiteSoftwareInstancesContext,
): Promise<Response> {
  const keys = [...url.searchParams.keys()]
  if (keys.some(k => k !== 'username' && k !== 'domainId' && k !== 'path') || new Set(keys).size !== keys.length) {
    return fail('VALIDATION', 'application target lookup accepts username, domainId and optional path only', unchanged)
  }
  const username = url.searchParams.get('username') ?? ''
  const domainId = url.searchParams.get('domainId') ?? ''
  if (!USERNAME_RE.test(username) || !UUID.test(domainId)) {
    return fail('VALIDATION', 'choose an active account site to inspect', unchanged)
  }
  const path = readApplicationPath(url.searchParams.get('path') ?? undefined)
  const account = await ctx.store.getAccountByUsername(username)
  if (!account || account.status !== 'active') {
    return fail('NOT_FOUND', 'the target account does not exist or is inactive', unchanged)
  }
  const domain = (await ctx.store.listDomains()).find(item => item.id === domainId && item.accountId === account.id && !item.suspended)
  if (!domain) {
    return fail('NOT_FOUND', 'the target domain is not an active site of this account', unchanged)
  }
  if (!ctx.source || !applicationInstallProviderAvailable(ctx.provider)) {
    return json(200, {
      state: 'unavailable',
      reason: !ctx.source ? 'application_catalog_unavailable' : 'application_provider_unavailable',
      revision: null,
      catalogRevision: null,
      installation: null,
      writesAvailable: false,
    })
  }
  const assertAuthority = async (): Promise<void> => {
    const fresh = await ctx.authenticate()
    if (fresh.role !== 'root' || fresh.principalId !== caller.principalId) fail('FORBIDDEN', 'root authority changed', unchanged)
  }
  const deps = applicationDeps({ store: ctx.store, source: ctx.source, provider: ctx.provider, database: ctx.database, account, domainId: domain.id, path, holdToPlan: false, assertAuthority })
  const read = await readApplicationInstallation(deps, 'read')
  return json(200, {
    state: read.observation ? 'read' : 'unavailable',
    reason: read.observation ? null : (read.reason ?? 'application_provider_unavailable'),
    revision: read.observation?.revision ?? null,
    catalogRevision: read.catalog.revision,
    installation: read.observation?.installation ? { appId: read.observation.installation.appId, version: read.observation.installation.version } : null,
    writesAvailable: Boolean(read.observation && read.writesAvailable && ctx.submitJob && ctx.coordinator),
  })
}

async function submitRootInstallJob(
  req: Request,
  isOneClick: boolean,
  caller: { actor: string; role: string; principalId: string },
  ctx: SiteSoftwareInstancesContext,
): Promise<Response> {
  const body = await readBody(req, 4096)
  if (!exact(body, ['accountId', 'username', 'domainId', 'docRoot', 'path', 'appId', 'version', 'expectedRevision', 'expectedCatalogRevision'])
    || typeof body.accountId !== 'string' || !UUID.test(body.accountId)
    || typeof body.username !== 'string' || !USERNAME_RE.test(body.username)
    || typeof body.domainId !== 'string' || !UUID.test(body.domainId)
    || typeof body.docRoot !== 'string' || !body.docRoot
    || !isApplicationId(body.appId) || !isApplicationVersion(body.version)
    || !isApplicationDigest(body.expectedRevision) || !isApplicationDigest(body.expectedCatalogRevision)) {
    return fail('VALIDATION', 'choose an active account site and reviewed application version to install', unchanged)
  }
  const path = readApplicationPath(body.path)
  if (!ctx.source) return fail('PRECONDITION_FAILED', 'no signed application catalog is configured on this server', { ...unchanged, reason: 'application_catalog_unavailable' })
  if (!applicationInstallProviderAvailable(ctx.provider) || !ctx.submitJob || !ctx.coordinator) return fail('PRECONDITION_FAILED', 'application writes require an admitted descriptor-confined account artifact provider', { ...unchanged, reason: 'application_provider_unavailable' })
  const account = await ctx.store.getAccountByUsername(body.username)
  if (!account || account.id !== body.accountId || account.status !== 'active') return fail('NOT_FOUND', 'the target account does not exist or is inactive', unchanged)
  const domain = (await ctx.store.listDomains()).find(item => item.id === body.domainId && item.accountId === account.id && !item.suspended && item.docRoot === body.docRoot)
  if (!domain) return fail('NOT_FOUND', 'the target domain is not an active site of this account', unchanged)
  const assertAuthority = async (): Promise<void> => {
    const fresh = await ctx.authenticate()
    if (fresh.role !== 'root' || fresh.principalId !== caller.principalId) fail('FORBIDDEN', 'root authority changed', unchanged)
  }
  const deps = applicationDeps({ store: ctx.store, source: ctx.source, provider: ctx.provider, database: ctx.database, account, domainId: domain.id, path, holdToPlan: false, assertAuthority })
  const request = { action: 'install', appId: body.appId, version: body.version, expectedRevision: body.expectedRevision, expectedCatalogRevision: body.expectedCatalogRevision }
  const job = await submitApplicationJob(ctx.coordinator, ctx.submitJob, request, deps, caller.actor, account.id, assertAuthority, submitted =>
    ctx.audit({
      action: isOneClick ? 'server.one_click.job_submitted' : 'server.app_installer.job_submitted',
      target: 'account:' + account.username,
      outcome: 'ok',
      detail: { domain: domain.name, path, appId: body.appId, version: body.version, kind: submitted.kind, jobId: submitted.id },
    }))
  return json(202, { job })
}

async function listInstances(ctx: SiteSoftwareInstancesContext): Promise<SiteSoftwareInstanceView[]> {
  const accounts = (await ctx.store.listAccounts()).sort((a, b) => a.username.localeCompare(b.username, 'en')), domains = await ctx.store.listDomains(), views: SiteSoftwareInstanceView[] = []
  for (const account of accounts) {
    for (const { domainId, domain, path, appId, version, previousVersion, database, updatedAt, revision } of ownedApplications(account, domains, await ctx.instances(account))) {
      views.push({ username: account.username, accountId: account.id, domainId, domain, path, appId, version, previousVersion, database: database?.name ?? null, updatedAt, revision, accountStatus: account.status })
    }
  }
  return views
}

async function receiveArtifact(req: Request, ctx: SiteSoftwareInstancesContext): Promise<Response> {
  const body = await readBody(req, Math.ceil(APPLICATION_ARTIFACT_CHUNK_BYTES / 3) * 4 + 512)
  if (!exact(body, ['appId', 'version', 'offset', 'contentBase64']) || !isApplicationId(body.appId) || !isApplicationVersion(body.version) || !Number.isSafeInteger(body.offset) || Number(body.offset) < 0 || typeof body.contentBase64 !== 'string') return fail('VALIDATION', 'one application release, offset and chunk are required', unchanged)
  if (!ctx.source || !ctx.artifacts) return fail('PRECONDITION_FAILED', 'application releases need an installed release of the panel', { ...unchanged, reason: 'application_provider_unavailable' })
  const chunk = Buffer.from(body.contentBase64, 'base64')
  if (chunk.toString('base64') !== body.contentBase64 || chunk.length === 0) return fail('VALIDATION', 'the chunk is not canonical base64', unchanged)
  const catalog = await ctx.source.catalog()
  const descriptor = catalog.applications.find(app => app.id === body.appId)?.releases.find(release => release.version === body.version)?.artifact
  if (!descriptor) return fail('NOT_FOUND', 'the application release is not in the signed catalog', { ...unchanged, reason: 'application_not_in_catalog' })
  const result = await ctx.artifacts.append(descriptor, body.appId, body.version as string, Number(body.offset), chunk)
  if (result.complete) await ctx.audit({ action: 'server.site_software.artifact_stored', target: 'site-software:' + body.appId, outcome: 'ok', detail: { version: body.version, sha256: descriptor.sha256, bytes: descriptor.bytes } })
  return json(200, { ...result, bytes: descriptor.bytes })
}
