import { fail, isAccountHome, validateDocRoot } from '@xpanel/core'
import type { Account, Domain } from '@xpanel/core'
import { SUPPORTED_PHP_VERSIONS } from '@xpanel/os'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { readSiteSoftwareHost, siteSoftwareFile } from './site-software-catalog.ts'
import { phpModuleComponents, SOFTWARE_CENTER_CATALOG } from '../../agent/src/software-center-catalog.ts'
import { isApplicationDigest, isApplicationId, isApplicationVersion, readApplicationPath } from '../../../packages/os/src/application-artifact.ts'

export const WHM_DISTRO_PACKAGES_PATH = '/api/server/software/distro-packages'
export const WHM_ONE_CLICK_PATH = '/api/server/software/one-click'
export const WHM_APP_INSTALLER_PATH = '/api/server/software/app-installer'

export interface WhmAppInstallerHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: Pick<StateStore, 'rootDir' | 'getWriterLock' | 'listAccounts' | 'listDomains' | 'getAccount' | 'getDomain'>
  callHost?: (caller: AuthenticatedCaller, path: string, input?: unknown, mutation?: boolean) => Promise<unknown>
  now?: () => Date
}

const ROUTES = new Set([
  WHM_DISTRO_PACKAGES_PATH,
  WHM_DISTRO_PACKAGES_PATH + '/preview',
  WHM_DISTRO_PACKAGES_PATH + '/apply',
  WHM_ONE_CLICK_PATH,
  WHM_ONE_CLICK_PATH + '/deploy',
  WHM_APP_INSTALLER_PATH,
  WHM_APP_INSTALLER_PATH + '/install',
  WHM_APP_INSTALLER_PATH + '/remove',
])

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA256 = /^[0-9a-f]{64}$/
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const COMPONENT_ID = /^[a-z][a-z0-9-]{1,48}$/
const QUERY_TERM = /^[A-Za-z0-9.+_-]{0,64}$/
const USERNAME = /^[a-z][a-z0-9]{0,15}$/
const PAGES = ['catalog', 'module', 'runtime'] as const
const unchanged = { stateChanged: false }

const REVIEWED_COMPONENT_IDS = new Set([
  ...SOFTWARE_CENTER_CATALOG.map(item => item.id),
  ...phpModuleComponents(SUPPORTED_PHP_VERSIONS).map(item => item.id),
])

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const hash = (value: unknown): value is string => typeof value === 'string' && SHA256.test(value)
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

const unverified = (mutation: boolean): never =>
  fail(
    mutation ? 'SERVICE_UNAVAILABLE' : 'PRECONDITION_FAILED',
    'the protected host response could not be verified',
    mutation ? { stateChanged: true, unknownOutcome: true, verificationRequired: true } : unchanged,
  )

async function readJsonBody(request: Request, maxBytes = 16 * 1024): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    return fail('VALIDATION', 'JSON is required', unchanged)
  }
  const text = await request.text()
  if (Buffer.byteLength(text) > maxBytes) return fail('VALIDATION', 'request body is too large', unchanged)
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return fail('VALIDATION', 'request body is not valid JSON', unchanged) }
  return object(parsed) ? parsed : fail('VALIDATION', 'a JSON object is required', unchanged)
}

function validateComponentIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16 || new Set(value).size !== value.length
    || !value.every(id => typeof id === 'string' && COMPONENT_ID.test(id))) {
    return fail('VALIDATION', '1 to 16 distinct reviewed component ids are required', unchanged)
  }
  for (const id of value) {
    if (!REVIEWED_COMPONENT_IDS.has(id)) {
      return fail('NOT_FOUND', 'the component is not in the reviewed software center catalog', { ...unchanged, reason: 'unknown_component' })
    }
  }
  return value
}

function parseDistroPackageMutationBody(body: Record<string, unknown>, apply: boolean) {
  const allowed = apply ? ['action', 'componentIds', 'expectedRevision', 'acceptExtraRemovals'] : ['action', 'componentIds', 'expectedRevision']
  if (Object.keys(body).some(key => !allowed.includes(key))
    || (body.action !== 'install' && body.action !== 'remove')
    || !hash(body.expectedRevision)
    || (body.acceptExtraRemovals !== undefined && !hash(body.acceptExtraRemovals))) {
    return fail('VALIDATION', 'an action, 1 to 16 catalog component ids and the observed revision are required', unchanged)
  }
  const componentIds = validateComponentIds(body.componentIds)
  return {
    action: body.action as 'install' | 'remove',
    componentIds,
    expectedRevision: body.expectedRevision,
    ...(body.acceptExtraRemovals === undefined ? {} : { acceptExtraRemovals: body.acceptExtraRemovals }),
  }
}

async function resolveTargetDomain(
  store: WhmAppInstallerHelpers['store'],
  domainId: unknown,
): Promise<{ account: Account; domain: Domain }> {
  if (typeof domainId !== 'string' || !UUID.test(domainId)) {
    return fail('VALIDATION', 'a valid domainId is required', unchanged)
  }
  const domain = await store.getDomain(domainId)
  if (!domain) return fail('NOT_FOUND', 'domain not found', unchanged)
  if (domain.kind === 'alias' || domain.suspended) {
    return fail('PRECONDITION_FAILED', 'aliases and suspended domains cannot host deployed applications', { ...unchanged, reason: 'domain_ineligible' })
  }
  const account = await store.getAccount(domain.accountId)
  if (!account || account.status !== 'active') {
    return fail('PRECONDITION_FAILED', 'an active account is required to deploy applications', { ...unchanged, reason: 'account_inactive' })
  }
  if (!isAccountHome(account.home, account.username)) {
    return fail('PRECONDITION_FAILED', 'account home is invalid', { ...unchanged, reason: 'application_root_unsupported' })
  }
  try {
    validateDocRoot(account.home, domain.docRoot)
  } catch {
    return fail('PRECONDITION_FAILED', 'domain document root cannot host an application', { ...unchanged, reason: 'application_root_unsupported' })
  }
  return { account, domain }
}

function listEligibleTargets(accounts: readonly Account[], domains: readonly Domain[]) {
  const byAccount = new Map(accounts.filter(item => item.status === 'active').map(item => [item.id, item]))
  return domains
    .filter(domain => domain.kind !== 'alias' && !domain.suspended && byAccount.has(domain.accountId))
    .map(domain => {
      const account = byAccount.get(domain.accountId)!
      return {
        accountId: account.id,
        username: account.username,
        domainId: domain.id,
        domain: domain.name,
        docRoot: domain.docRoot,
        siteType: domain.siteType,
      }
    })
    .sort((a, b) => a.domain.localeCompare(b.domain, 'en'))
}

function parseDeployBody(body: Record<string, unknown>) {
  const allowed = ['domainId', 'appId', 'version', 'path', 'expectedRevision', 'expectedCatalogRevision']
  if (Object.keys(body).some(key => !allowed.includes(key))
    || typeof body.domainId !== 'string' || !UUID.test(body.domainId)
    || !isApplicationId(body.appId)
    || !isApplicationVersion(body.version)
    || !isApplicationDigest(body.expectedRevision)
    || !isApplicationDigest(body.expectedCatalogRevision)) {
    return fail('VALIDATION', 'domainId, appId, version, expectedRevision and expectedCatalogRevision are required', unchanged)
  }
  const path = readApplicationPath(body.path)
  return {
    domainId: body.domainId,
    appId: body.appId,
    version: body.version,
    path,
    expectedRevision: body.expectedRevision,
    expectedCatalogRevision: body.expectedCatalogRevision,
  }
}

function parseRemoveBody(body: Record<string, unknown>) {
  const allowed = ['username', 'domainId', 'path', 'expectedRecord']
  if (Object.keys(body).some(key => !allowed.includes(key))
    || typeof body.username !== 'string' || !USERNAME.test(body.username)
    || typeof body.domainId !== 'string' || !UUID.test(body.domainId)
    || !isApplicationDigest(body.expectedRecord)) {
    return fail('VALIDATION', 'username, domainId and expectedRecord are required', unchanged)
  }
  const path = readApplicationPath(body.path)
  return {
    username: body.username,
    domainId: body.domainId,
    path,
    expectedRecord: body.expectedRecord,
  }
}

/** Root-only reviewed endpoints bridging software-center, site-software, and sw-applications. */
export async function handleWhmAppInstallerRoute(
  request: Request,
  url: URL,
  method: string,
  helpers: WhmAppInstallerHelpers,
): Promise<Response | null> {
  if (!ROUTES.has(url.pathname)) return null

  const isGet = url.pathname === WHM_DISTRO_PACKAGES_PATH || url.pathname === WHM_ONE_CLICK_PATH || url.pathname === WHM_APP_INSTALLER_PATH
  const expectedMethod = isGet ? 'GET' : 'POST'
  if (method !== expectedMethod) return new Response(null, { status: 405, headers: { allow: expectedMethod } })

  const actionLabel = url.pathname.startsWith(WHM_DISTRO_PACKAGES_PATH)
    ? 'server.distro_packages.' + (isGet ? 'read' : url.pathname.endsWith('/preview') ? 'preview' : 'apply')
    : url.pathname.startsWith(WHM_ONE_CLICK_PATH)
      ? 'server.one_click.' + (isGet ? 'read' : 'deploy')
      : 'server.app_installer.' + (isGet ? 'read' : url.pathname.endsWith('/remove') ? 'remove' : 'install')

  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, actionLabel)

  const fresh = async (mutation: boolean): Promise<AuthenticatedCaller> => {
    const current = await helpers.requireCaller(request)
    await helpers.assertRoot(current, actionLabel)
    if (current.principal.id !== caller.principal.id) {
      return fail('FORBIDDEN', 'software installer authority changed', mutation ? { stateChanged: true, verificationRequired: true } : unchanged)
    }
    return current
  }

  // 1. Distro packages workflow (/api/server/software/distro-packages*)
  if (url.pathname.startsWith(WHM_DISTRO_PACKAGES_PATH)) {
    if (isGet) {
      const keys = [...url.searchParams.keys()]
      if (keys.some(k => k !== 'page' && k !== 'q')) {
        return fail('VALIDATION', 'distro packages accept only page and q selectors', unchanged)
      }
      const pageParam = url.searchParams.get('page')
      if (pageParam !== null && !PAGES.includes(pageParam as typeof PAGES[number])) {
        return fail('VALIDATION', 'page must be catalog, module or runtime', unchanged)
      }
      const queryParam = url.searchParams.get('q') ?? ''
      if (!QUERY_TERM.test(queryParam)) {
        return fail('VALIDATION', 'search query contains unsupported characters', unchanged)
      }
      const term = queryParam.trim().toLowerCase()
      if (!helpers.callHost) {
        const filtered = SOFTWARE_CENTER_CATALOG.filter(item =>
          (!pageParam || item.page === pageParam)
          && (!term || item.id.includes(term) || item.name.toLowerCase().includes(term)
            || item.packages.debian.some(pkg => pkg.toLowerCase().includes(term))
            || (item.packages.rhel ?? []).some(pkg => pkg.toLowerCase().includes(term))),
        ).map(item => ({
          id: item.id,
          page: item.page,
          category: item.category,
          name: item.name,
          description: item.description,
          packages: item.packages.debian,
          state: 'unavailable' as const,
          needsReview: false,
          installed: [],
          candidates: null,
          services: item.services ?? [],
          requires: item.requires ?? [],
          conflicts: item.conflicts ?? [],
          requiredBy: [],
          estimate: item.estimate,
        }))
        await fresh(false)
        return json(200, {
          state: 'unavailable',
          reason: 'host_agent_unavailable',
          family: null,
          observedAt: null,
          revision: null,
          page: pageParam ?? 'all',
          query: queryParam,
          components: filtered,
          sources: [
            { id: 'shipped', state: 'trusted', trust: 'release-code' },
            { id: 'external', state: 'unavailable', reason: 'signed-external-catalogs-not-supported' },
          ],
          actions: { manage: false },
        })
      }

      const pagesToRead = pageParam ? [pageParam as typeof PAGES[number]] : [...PAGES]
      const views = await Promise.all(pagesToRead.map(p => helpers.callHost!(caller, '/host/software-center?page=' + p)))
      const first = views[0]
      if (!object(first) || !['read', 'unavailable'].includes(String(first.state)) || !Array.isArray(first.components)
        || (first.revision !== null && !hash(first.revision))) {
        return unverified(false)
      }
      const combined: Record<string, unknown>[] = []
      const seenIds = new Set<string>()
      for (const view of views) {
        if (!object(view) || !Array.isArray(view.components)) return unverified(false)
        for (const component of view.components) {
          if (!object(component) || typeof component.id !== 'string' || seenIds.has(component.id)) continue
          seenIds.add(component.id)
          const matchesTerm = !term
            || component.id.toLowerCase().includes(term)
            || String(component.name ?? '').toLowerCase().includes(term)
            || (Array.isArray(component.packages) && component.packages.some(pkg => String(pkg).toLowerCase().includes(term)))
          if (matchesTerm) combined.push(component)
        }
      }
      await fresh(false)
      return json(200, {
        state: first.state,
        reason: first.reason ?? null,
        family: first.family ?? null,
        observedAt: first.observedAt ?? null,
        revision: first.revision ?? null,
        phpVersions: first.phpVersions ?? [],
        candidates: first.candidates ?? 'not-read',
        page: pageParam ?? 'all',
        query: queryParam,
        components: combined,
        sources: first.sources ?? [],
        actions: first.actions ?? { manage: false },
      })
    }

    if (url.search) return fail('VALIDATION', 'distro package changes do not accept query selectors', unchanged)
    const isApply = url.pathname.endsWith('/apply')
    const parsed = parseDistroPackageMutationBody(await readJsonBody(request), isApply)
    if (!helpers.callHost) {
      return fail('PRECONDITION_FAILED', 'distro package operations require the host agent', { ...unchanged, reason: 'host_agent_unavailable' })
    }
    if (!isApply) {
      const result = await helpers.callHost(caller, '/host/software-center/preview', parsed)
      if (!object(result) || !object(result.preview) || !['ready', 'refused', 'unavailable'].includes(String(result.preview.state))
        || result.preview.revision !== parsed.expectedRevision) {
        return unverified(false)
      }
      await fresh(false)
      return json(200, result)
    }

    const target = 'distro-packages:' + parsed.componentIds.join(',')
    await helpers.emitAudit({
      actor: caller.principal.username,
      action: 'server.distro_packages.change_requested',
      target,
      detail: { action: parsed.action, componentIds: parsed.componentIds, extraRemovalsAccepted: parsed.acceptExtraRemovals !== undefined },
      outcome: 'ok',
      principalId: caller.principal.id,
    })
    const submitter = await fresh(false)
    const result = await helpers.callHost(submitter, '/host/software-center/apply', parsed, true)
    if (!object(result) || !object(result.job) || typeof result.job.id !== 'string' || !JOB_ID.test(result.job.id)
      || result.job.kind !== 'software.component.' + parsed.action) {
      return unverified(true)
    }
    const after = await fresh(true)
    try {
      await helpers.emitAudit({
        actor: after.principal.username,
        action: 'server.distro_packages.job_submitted',
        target,
        detail: { action: parsed.action, jobId: result.job.id },
        outcome: 'ok',
        principalId: after.principal.id,
      })
    } catch {
      return fail('SERVICE_UNAVAILABLE', 'package job submission requires audit review', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
    }
    return json(202, { job: result.job })
  }

  // 2. Shared catalog + instances + target domains helper for one-click & app-installer
  const readCatalogAndTargets = async (activeCaller: AuthenticatedCaller) => {
    const [accounts, domains, offerState] = await Promise.all([
      helpers.store.listAccounts(),
      helpers.store.listDomains(),
      siteSoftwareFile(helpers.store).read(),
    ])
    const targets = listEligibleTargets(accounts, domains)
    const offered = offerState.value ?? []
    if (!helpers.callHost) {
      return {
        state: 'unavailable' as const,
        reason: 'host_agent_unavailable',
        host: null,
        offered,
        instances: [],
        targets,
      }
    }
    const rawHost = await helpers.callHost(activeCaller, '/host/site-software').catch(() => null)
    const host = readSiteSoftwareHost(rawHost)
    const rawInstances = await helpers.callHost(activeCaller, '/host/site-software/instances').catch(() => null)
    const instances = object(rawInstances) && Array.isArray(rawInstances.instances) ? rawInstances.instances : []
    return {
      state: host ? 'read' as const : 'unavailable' as const,
      reason: host ? null : 'application_catalog_unavailable',
      host,
      offered,
      instances,
      targets,
    }
  }

  if (isGet) {
    if (!url.search) {
      const data = await readCatalogAndTargets(caller)
      await fresh(false)
      return json(200, data)
    }
    const keys = [...url.searchParams.keys()]
    if (keys.some(k => k !== 'domainId' && k !== 'path') || new Set(keys).size !== keys.length || !url.searchParams.has('domainId')) {
      return fail('VALIDATION', 'installer target lookup accepts domainId and optional path only', unchanged)
    }
    const { account, domain } = await resolveTargetDomain(helpers.store, url.searchParams.get('domainId'))
    const path = readApplicationPath(url.searchParams.get('path') ?? undefined)
    if (!helpers.callHost) {
      await fresh(false)
      return json(200, {
        target: {
          domainId: domain.id,
          path,
          state: 'unavailable',
          reason: 'host_agent_unavailable',
          revision: null,
          catalogRevision: null,
          installation: null,
          writesAvailable: false,
        },
      })
    }
    const targetQuery = '/host/site-software/target?username=' + encodeURIComponent(account.username)
      + '&domainId=' + encodeURIComponent(domain.id)
      + (path ? '&path=' + encodeURIComponent(path) : '')
    const rawTarget = await helpers.callHost(caller, targetQuery)
    if (!object(rawTarget) || !['read', 'unavailable'].includes(String(rawTarget.state))
      || (rawTarget.revision !== null && !isApplicationDigest(rawTarget.revision))
      || (rawTarget.catalogRevision !== null && rawTarget.catalogRevision !== undefined && !isApplicationDigest(rawTarget.catalogRevision))
      || typeof rawTarget.writesAvailable !== 'boolean'
      || (rawTarget.state === 'read') !== (rawTarget.revision !== null)) {
      return unverified(false)
    }
    await fresh(false)
    return json(200, {
      target: {
        domainId: domain.id,
        path,
        state: rawTarget.state,
        reason: rawTarget.reason ?? null,
        revision: rawTarget.revision,
        catalogRevision: rawTarget.catalogRevision ?? null,
        installation: object(rawTarget.installation) ? rawTarget.installation : null,
        writesAvailable: rawTarget.writesAvailable,
      },
    })
  }

  if (url.search) return fail('VALIDATION', 'installer changes accept no query selectors', unchanged)
  if (!helpers.callHost) {
    return fail('PRECONDITION_FAILED', 'installer operations require the host agent', { ...unchanged, reason: 'host_agent_unavailable' })
  }

  if (url.pathname === WHM_APP_INSTALLER_PATH + '/remove') {
    const parsed = parseRemoveBody(await readJsonBody(request))
    const { account, domain } = await resolveTargetDomain(helpers.store, parsed.domainId)
    if (account.username !== parsed.username) {
      return fail('NOT_FOUND', 'the installation target does not match the account', unchanged)
    }
    const target = `app:${account.username}:${domain.name}`
    await helpers.emitAudit({
      actor: caller.principal.username,
      action: 'server.app_installer.remove_requested',
      target,
      detail: { domain: domain.name, path: parsed.path },
      outcome: 'ok',
      principalId: caller.principal.id,
    })
    const submitter = await fresh(false)
    const result = await helpers.callHost(submitter, '/host/site-software/instances/jobs', {
      username: account.username,
      domainId: domain.id,
      path: parsed.path,
      action: 'remove',
      expectedRecord: parsed.expectedRecord,
    }, true)
    if (!object(result) || !object(result.job) || typeof result.job.id !== 'string' || !JOB_ID.test(result.job.id)
      || result.job.kind !== 'application.remove') {
      return unverified(true)
    }
    const after = await fresh(true)
    try {
      await helpers.emitAudit({
        actor: after.principal.username,
        action: 'server.app_installer.job_submitted',
        target,
        detail: { action: 'remove', jobId: result.job.id, domain: domain.name, path: parsed.path },
        outcome: 'ok',
        principalId: after.principal.id,
      })
    } catch {
      return fail('SERVICE_UNAVAILABLE', 'application removal job requires audit review', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
    }
    return json(202, { job: result.job })
  }

  // One-click deploy or App installer install onto an owned domain docRoot.
  const isOneClick = url.pathname === WHM_ONE_CLICK_PATH + '/deploy'
  const parsed = parseDeployBody(await readJsonBody(request))
  const { account, domain } = await resolveTargetDomain(helpers.store, parsed.domainId)
  const host = readSiteSoftwareHost(await helpers.callHost(caller, '/host/site-software'))
  if (!host || host.catalog.state !== 'read') {
    return fail('PRECONDITION_FAILED', 'no verified signed application catalog is available', { ...unchanged, reason: 'application_catalog_unavailable' })
  }
  if (host.catalog.revision !== parsed.expectedCatalogRevision) {
    return fail('CONFLICT', 'the signed application catalog changed; read again before deploying', unchanged)
  }
  const app = host.catalog.applications.find(item => item.id === parsed.appId)
  if (!app || !app.versions.includes(parsed.version)) {
    return fail('NOT_FOUND', 'the requested application version is not in the signed catalog', { ...unchanged, reason: 'application_not_in_catalog' })
  }
  const offered = (await siteSoftwareFile(helpers.store).read()).value ?? []
  if (!offered.includes(parsed.appId)) {
    return fail('NOT_FOUND', 'the application is not offered on this server', { ...unchanged, reason: 'application_not_offered' })
  }

  const target = `app:${account.username}:${domain.name}`
  const requestAudit = isOneClick ? 'server.one_click.deploy_requested' : 'server.app_installer.install_requested'
  const submitAudit = isOneClick ? 'server.one_click.job_submitted' : 'server.app_installer.job_submitted'
  const hostPath = isOneClick ? '/host/software/one-click/deploy' : '/host/software/app-installer/install'

  await helpers.emitAudit({
    actor: caller.principal.username,
    action: requestAudit,
    target,
    detail: { appId: parsed.appId, version: parsed.version, domain: domain.name, docRoot: domain.docRoot, path: parsed.path },
    outcome: 'ok',
    principalId: caller.principal.id,
  })
  const submitter = await fresh(false)
  const result = await helpers.callHost(submitter, hostPath, {
    accountId: account.id,
    username: account.username,
    domainId: domain.id,
    docRoot: domain.docRoot,
    path: parsed.path,
    appId: parsed.appId,
    version: parsed.version,
    expectedRevision: parsed.expectedRevision,
    expectedCatalogRevision: parsed.expectedCatalogRevision,
  }, true)
  if (!object(result) || !object(result.job) || typeof result.job.id !== 'string' || !JOB_ID.test(result.job.id)
    || result.job.kind !== 'application.install') {
    return unverified(true)
  }
  const after = await fresh(true)
  try {
    await helpers.emitAudit({
      actor: after.principal.username,
      action: submitAudit,
      target,
      detail: { action: 'install', appId: parsed.appId, version: parsed.version, jobId: result.job.id },
      outcome: 'ok',
      principalId: after.principal.id,
    })
  } catch {
    return fail('SERVICE_UNAVAILABLE', 'application deploy job requires audit review', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  }
  return json(202, { job: result.job })
}
