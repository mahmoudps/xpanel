import { fail } from '@xpanel/core'
import { releaseNotes } from '@xpanel/catalog'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { projectSecWafObservation, projectSvcObservation, readSecRaw, reconcileSecOutcome, secBody, secRevisionOf, writeSecRecord } from './sec-workspace.ts'
import type { SecWorkspaceHelpers } from './sec-workspace.ts'
import { readSecRecord, secRevision } from '../../agent/src/sec-policy.ts'
import type { SvcWafRulesPolicy, SvcWafVendorsPolicy } from '../../agent/src/svc-policy.ts'

export interface SvcWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit' | 'triggerReconcile'> {
  store: StateStore
  callHost?: (caller: AuthenticatedCaller, path: string, body?: Record<string, unknown>) => Promise<unknown>
}
const unchanged = { stateChanged: false }
const ROUTES: Readonly<Record<string, { method: 'GET' | 'POST'; action: string; host?: string }>> = {
  '/api/server/services/web-status': { method: 'GET', action: 'server.services.read', host: '/host/svc/web-status' },
  '/api/server/services/process-log': { method: 'GET', action: 'server.services.read', host: '/host/svc/process-log' },
  '/api/server/services/package-check': { method: 'GET', action: 'server.services.read', host: '/host/svc/package-check' },
  '/api/server/services/source-builds': { method: 'GET', action: 'server.services.read', host: '/host/svc/source-builds' },
  '/api/server/services/pear': { method: 'GET', action: 'server.services.read', host: '/host/svc/pear' },
  '/api/server/services/change-log': { method: 'GET', action: 'server.services.read' },
  '/api/server/services/pear/search': { method: 'POST', action: 'server.services.read', host: '/host/svc/pear/search' },
  '/api/server/services/pear/change': { method: 'POST', action: 'server.services.pear', host: '/host/svc/pear/change' },
  '/api/server/sec/process-killer/run': { method: 'POST', action: 'server.services.process_killer', host: '/host/svc/process-killer/run' },
  '/api/server/sec/waf-rules/deploy': { method: 'POST', action: 'server.sec.waf-rules.apply' },
  '/api/server/sec/waf-rules/discard': { method: 'POST', action: 'server.sec.waf-rules.update' },
  '/api/server/sec/waf-vendors/preview': { method: 'POST', action: 'server.sec.waf-vendors.update', host: '/host/svc/waf-vendors/preview' },
  '/api/server/sec/waf-vendors/install': { method: 'POST', action: 'server.sec.waf-vendors.update', host: '/host/svc/waf-vendors/install' },
  '/api/server/sec/waf-vendors/remove': { method: 'POST', action: 'server.sec.waf-vendors.update', host: '/host/svc/waf-vendors/remove' },
}
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const uncertain = (message: string): never => fail('SERVICE_UNAVAILABLE', message, { stateChanged: true, verificationRequired: true, unknownOutcome: true })

/** Root-only reads and actions of the services and security centre. Saved policies live in the sec workspace routes. */
export async function handleSvcWorkspaceRoute(request: Request, url: URL, method: string, helpers: SvcWorkspaceHelpers): Promise<Response | null> {
  const route = Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname]! : null
  if (!route) return null
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, route.action)
  if (method !== route.method) return new Response(null, { status: 405, headers: { allow: route.method } })
  const fresh = async (): Promise<AuthenticatedCaller> => {
    const current = await helpers.requireCaller(request)
    await helpers.assertRoot(current, route.action)
    return current.principal.id === caller.principal.id ? current : fail('FORBIDDEN', 'root authority changed', unchanged)
  }
  const host = helpers.callHost ?? (() => fail('PRECONDITION_FAILED', 'this tool needs the host agent', { ...unchanged, reason: 'host_agent_unavailable' }))
  const audit = (action: string, target: string, detail: Record<string, unknown>, outcome: 'ok' | 'failed' = 'ok') => helpers.emitAudit({ actor: caller.principal.username, action, target, principalId: caller.principal.id, outcome, detail })

  if (url.pathname === '/api/server/services/change-log') {
    if (url.search) return fail('VALIDATION', 'the change log accepts no selectors', unchanged)
    let installed: string | null = null
    try { const raw = await host(caller, '/host/upgrade') as { current?: { version?: unknown } }; installed = typeof raw.current?.version === 'string' ? raw.current.version : null } catch { installed = null }
    return json({ installed, entries: releaseNotes.map(entry => ({ ...entry, installed: entry.version === installed })) })
  }
  if (route.method === 'GET') {
    const query = [...url.searchParams]
    const allowed = url.pathname.endsWith('/process-log') ? 'day' : url.pathname.endsWith('/pear') ? 'version' : null
    if (query.length > 1 || query.some(([key]) => key !== allowed)) return fail('VALIDATION', 'unsupported selector', unchanged)
    return json(projectSvcObservation(await host(caller, route.host! + url.search)))
  }

  if (url.pathname === '/api/server/services/pear/search') {
    const body = await secBody(request, 512)
    return json(projectSvcObservation(await host(await fresh(), route.host!, body)))
  }
  if (url.pathname === '/api/server/services/pear/change') {
    const body = await secBody(request, 512), actor = await fresh()
    const result = projectSvcObservation(await host(actor, route.host!, body)) as { job?: { id?: string } }
    // The first package of a version adds its library to the account pools.
    const reconcile = await reconcileSecOutcome(helpers, actor)
    await audit('server.services.pear_change', 'php:' + String(body.version), { name: body.name, operation: body.operation, job: result.job?.id ?? null })
    return json({ ...result, reconcile }, 202)
  }
  if (url.pathname === '/api/server/sec/process-killer/run') {
    const result = projectSvcObservation(await host(await fresh(), route.host!, {})) as { state?: string; killed?: unknown[] }
    await audit('server.services.process_killer_run', 'server:process-killer', { killed: result.killed?.length ?? null }, result.state === 'completed' ? 'ok' : 'failed')
    return json(result)
  }

  if (url.pathname.startsWith('/api/server/sec/waf-rules/')) {
    const body = await secBody(request, 512)
    if (Object.keys(body).join() !== 'expectedRevision') return fail('VALIDATION', 'only expectedRevision is accepted', unchanged)
    const expected = secRevisionOf(body.expectedRevision), deploy = url.pathname.endsWith('/deploy')
    const raw = await readSecRaw(helpers.store, 'waf-rules'), saved = readSecRecord('waf-rules', raw)?.policy
    if (!saved) return fail('PRECONDITION_FAILED', 'there are no saved rules', unchanged)
    if (deploy && saved.staged.some(rule => rule.enabled)) {
      const live = helpers.callHost ? projectSecWafObservation(await helpers.callHost(caller, '/host/sec/waf')) as { active?: { modsecurity?: unknown } } : null
      if (live?.active?.modsecurity !== true) return fail('PRECONDITION_FAILED', 'ModSecurity is not active on this server, so these rules would protect nothing', { ...unchanged, reason: 'waf_connector_unavailable' })
    }
    const next: SvcWafRulesPolicy = deploy ? { ...saved, deployed: saved.staged, deployedEngine: saved.engine } : { ...saved, staged: saved.deployed, engine: saved.deployedEngine }
    const written = await writeSecRecord(helpers, 'waf-rules', expected, () => next, fresh)
    if (!deploy) { await audit('server.sec.waf-rules.discarded', 'server:sec:waf-rules', {}); return json({ revision: secRevision('waf-rules', written), policy: next }) }
    const actor = await fresh()
    const outcome = await helpers.triggerReconcile(actor).catch(() => null)
    if (outcome && !outcome.ok) {
      // nginx -t refused the rules: the previous generation still runs, so the file must say so too.
      await writeSecRecord(helpers, 'waf-rules', secRevision('waf-rules', written), () => saved, fresh)
      await audit('server.sec.waf-rules.deployed', 'server:sec:waf-rules', { rules: next.deployed.length, rolledBack: true }, 'failed')
      return fail('CONFIG_TEST_FAILED', 'the web server refused these rules; the previous rules stay active', { stateChanged: false, rolledBack: true, reason: 'waf_rules_refused' })
    }
    await audit('server.sec.waf-rules.deployed', 'server:sec:waf-rules', { rules: next.deployed.length, engine: next.deployedEngine })
    return json({ revision: secRevision('waf-rules', written), policy: next, reconcile: outcome === null ? 'not_connected' : 'requested' })
  }

  const body = await secBody(request, 1024)
  if (url.pathname.endsWith('/preview')) return json(projectSvcObservation(await host(await fresh(), route.host!, body)))
  const expected = secRevisionOf(body.expectedRevision), { expectedRevision: _ignored, ...hostBody } = body
  const raw = await readSecRaw(helpers.store, 'waf-vendors')
  if (secRevision('waf-vendors', raw) !== expected) return fail('CONFLICT', 'saved vendors changed; reload before saving', unchanged)
  const current: SvcWafVendorsPolicy = raw === null ? { crsDisabledFiles: [], vendors: [] } : readSecRecord('waf-vendors', raw)?.policy ?? fail('PRECONDITION_FAILED', 'saved vendors require review', unchanged)
  const actor = await fresh()
  if (url.pathname.endsWith('/remove')) {
    const next = { ...current, vendors: current.vendors.filter(vendor => vendor.id !== hostBody.id) }
    if (next.vendors.length === current.vendors.length) return fail('NOT_FOUND', 'vendor not found', unchanged)
    await writeSecRecord(helpers, 'waf-vendors', expected, () => next, fresh)
    const reconcile = await reconcileSecOutcome(helpers, actor)
    // Files leave only after the web server no longer includes them.
    if (reconcile === 'requested') await host(actor, route.host!, hostBody).catch(() => uncertain('the vendor was removed from the configuration, but its files need review'))
    await audit('server.sec.waf-vendors.removed', 'waf-vendor:' + String(hostBody.id), { reconcile })
    return json({ reconcile })
  }
  const installed = projectSvcObservation(await host(actor, route.host!, hostBody)) as { vendor: SvcWafVendorsPolicy['vendors'][number]; files: string[] }
  const prior = current.vendors.find(vendor => vendor.id === installed.vendor.id)
  const vendor = { ...installed.vendor, enabled: prior?.enabled ?? true, autoUpdate: prior?.autoUpdate ?? false, disabledFiles: (prior?.disabledFiles ?? []).filter(name => installed.files.includes(name)) }
  await writeSecRecord(helpers, 'waf-vendors', expected, () => ({ ...current, vendors: [...current.vendors.filter(item => item.id !== vendor.id), vendor].sort((a, b) => a.id.localeCompare(b.id)) }), fresh)
  const reconcile = await reconcileSecOutcome(helpers, actor)
  await audit('server.sec.waf-vendors.installed', 'waf-vendor:' + vendor.id, { version: vendor.version, files: installed.files.length, reconcile })
  return json({ vendor, files: installed.files, reconcile })
}
