import { randomBytes } from 'node:crypto'
import { fail } from '@xpanel/core'
import { listAudit } from '@xpanel/db'
import type { Db } from '@xpanel/db'
import { BASIC_USERNAME, parsePanelBinding, parsePanelGatePolicy } from '../../agent/src/panel-gate-policy.ts'
import type { PanelGatePolicy } from '../../agent/src/panel-gate-policy.ts'
import { readSecRecord, SEC_DEFAULTS, secRevision } from '../../agent/src/sec-policy.ts'
import { workspaceJson } from './account-ssh-workspace.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { passwordHashFromInput } from './auth.ts'
import { passwordAllowed } from './password-policy.ts'
import { issueGateCookie } from './panel-gate.ts'
import { issueTemporaryLogin, listTemporaryLogins, parseTemporaryRequest, revokeTemporaryLogin, temporaryActor, temporaryLoginView } from './panel-temporary-login.ts'
import { readSecRaw, reconcileSecOutcome, secBody, secRevisionOf, writeSecRecord } from './sec-workspace.ts'
import type { SecWorkspaceHelpers } from './sec-workspace.ts'

export interface PanelAccessHelpers extends SecWorkspaceHelpers {
  db: Db
  serverSecret: string
  /** This request's public origin, so a new link names the listener that issued it. */
  publicOrigin?: string
  secureCookies: (request: Request) => boolean
  /** Refusals keep their stable reason: the page explains PORT_IN_USE by name. */
  callHostRelay?: (caller: AuthenticatedCaller, path: string, body?: Record<string, unknown>) => Promise<unknown>
}

const BASE = '/api/server/panel-access'
const unchanged = { stateChanged: false }
const invalid = (message: string): never => fail('VALIDATION', message, unchanged)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** The stored password hash never leaves the server. */
export const gateView = (policy: PanelGatePolicy): Record<string, unknown> => ({ entrance: policy.entrance, response: policy.response, stopped: policy.stopped, basicAuth: policy.basicAuth ? { username: policy.basicAuth.username, listeners: policy.basicAuth.listeners } : null })

const savedGate = (raw: unknown): PanelGatePolicy => raw === null ? structuredClone(SEC_DEFAULTS['panel-gate']) : readSecRecord('panel-gate', raw)?.policy ?? fail('PRECONDITION_FAILED', 'the saved panel gate requires review; repair it with xpanel panel-access reset', unchanged)

/** A new password is hashed once; an empty password keeps the saved one. */
async function basicAuthFrom(input: unknown, saved: PanelGatePolicy['basicAuth']): Promise<PanelGatePolicy['basicAuth']> {
  if (input === null) return null
  if (!object(input) || Object.keys(input).sort().join() !== 'listeners,password,username' || typeof input.username !== 'string' || !BASIC_USERNAME.test(input.username)) return invalid('basic authentication needs a username, a password and entry points')
  if (input.password === null || input.password === '') {
    if (!saved || saved.username !== input.username) return invalid('enter a password for this basic authentication username')
    return { username: input.username, passwordHash: saved.passwordHash, listeners: input.listeners as never }
  }
  if (typeof input.password !== 'string' || Buffer.byteLength(input.password) > 1024 || /[\r\n]/.test(input.password) || !passwordAllowed(input.password, 'panel')) return invalid('the basic authentication password is too weak')
  return { username: input.username, passwordHash: await passwordHashFromInput({ password: input.password }), listeners: input.listeners as never }
}

export async function handlePanelAccessRoute(request: Request, url: URL, method: string, helpers: PanelAccessHelpers): Promise<Response | null> {
  const { pathname } = url
  if (pathname !== BASE && !pathname.startsWith(`${BASE}/`)) return null
  if (url.search) return invalid('panel access accepts no query selectors')
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, 'server.panel_access')
  const fresh = async (): Promise<AuthenticatedCaller> => {
    const again = await helpers.requireCaller(request)
    await helpers.assertRoot(again, 'server.panel_access')
    return again.principal.id === caller.principal.id && again.sessionId === caller.sessionId ? again : fail('FORBIDDEN', 'session authorization changed', unchanged)
  }
  const ip = helpers.readClient(request).address
  const audit = (action: string, target: string, detail: Record<string, unknown>) => helpers.emitAudit({ actor: caller.principal.username, action, target, principalId: caller.principal.id, outcome: 'ok', detail, ip })
  const host = helpers.callHostRelay
  const requireHost = (): NonNullable<typeof host> => host ?? fail('PRECONDITION_FAILED', 'this change needs the host agent', { ...unchanged, reason: 'host_agent_unavailable' })
  const view = async (): Promise<Record<string, unknown>> => {
    const raw = await readSecRaw(helpers.store, 'panel-gate'), record = raw === null ? null : readSecRecord('panel-gate', raw)
    let hostView: unknown = null
    if (host) try { hostView = await host(caller, '/host/panel-access') } catch { hostView = null }
    const client = helpers.readClient(request)
    return { state: raw === null ? 'default' : record ? 'saved' : 'invalid', gate: raw === null ? gateView(SEC_DEFAULTS['panel-gate']) : record ? gateView(record.policy) : null, updatedAt: record?.updatedAt ?? null, revision: secRevision('panel-gate', raw),
      temporaryLogins: await listTemporaryLogins(helpers.store, Date.now()), host: hostView, client: { listener: client.listener }, publicOrigin: helpers.publicOrigin ?? null }
  }

  if (pathname === BASE) {
    if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
    const body = await view()
    await fresh()
    return workspaceJson(body)
  }
  if (method === 'GET') {
    const activity = /^\/api\/server\/panel-access\/temporary-logins\/([0-9a-f]{16})\/activity$/.exec(pathname)?.[1]
    if (!activity) return new Response(null, { status: 404 })
    const rows = await listAudit(helpers.db, { actor: temporaryActor(activity), limit: 200 })
    await fresh()
    return workspaceJson({ rows: rows.map(row => ({ at: row.at, action: row.action, target: row.target, outcome: row.outcome })) })
  }

  if (pathname === `${BASE}/gate` && method === 'PUT') {
    const body = await secBody(request, 8 * 1024)
    if (Object.keys(body).sort().join() !== 'basicAuth,entrance,expectedRevision,response,stopped') return invalid('only entrance, response, basicAuth, stopped and expectedRevision are accepted')
    const expectedRevision = secRevisionOf(body.expectedRevision), current = savedGate(await readSecRaw(helpers.store, 'panel-gate'))
    const policy = parsePanelGatePolicy({ entrance: body.entrance, response: body.response, basicAuth: await basicAuthFrom(body.basicAuth, current.basicAuth), stopped: body.stopped })
    const saved = await writeSecRecord(helpers, 'panel-gate', expectedRevision, () => policy, fresh)
    await audit('server.panel_access.gate_saved', 'server:panel-access', { revision: secRevision('panel-gate', saved), entrance: policy.entrance?.listeners ?? [], response: policy.response.kind, basicAuth: policy.basicAuth?.listeners ?? [], stopped: policy.stopped })
    const response = workspaceJson(await view()), client = helpers.readClient(request).listener
    // The person who saved keeps working: this browser gets the pass the new policy would ask of it.
    if (client) response.headers.append('set-cookie', issueGateCookie({ secret: helpers.serverSecret, listener: client, policy, flags: 'be', secure: helpers.secureCookies(request) }))
    return response
  }
  if (pathname === `${BASE}/entrance` && method === 'POST') return workspaceJson({ path: `${randomBytes(9).toString('base64url').replaceAll(/[-_]/g, 'x')}${randomBytes(1)[0]! % 10}` })

  if (pathname === `${BASE}/binding` && method === 'PUT') {
    const body = await secBody(request, 2 * 1024)
    if (Object.keys(body).sort().join() !== 'hosts,ports') return invalid('only ports and hosts are accepted')
    const settings = await helpers.store.getServerSettings()
    const binding = parsePanelBinding(body, settings ? [settings.sshPort, settings.backendPort, settings.backendTlsPort] : [])
    const agent = requireHost()
    const actor = await fresh()
    await agent(actor, '/host/panel-access/check', { binding })
    await agent(actor, '/host/panel-access/open', { binding })
    // The new port is open before anything moves; a firewall that refuses it leaves the panel where it is.
    if (await reconcileSecOutcome(helpers, actor) !== 'requested') {
      await agent(actor, '/host/panel-access/close', {}).catch(() => {})
      return fail('SERVICE_UNAVAILABLE', 'the firewall could not open the new port, so nothing moved', { ...unchanged, reason: 'firewall_not_applied' })
    }
    const applied = await agent(await fresh(), '/host/panel-access/apply', { binding })
    await audit('server.panel_access.binding_applied', 'server:panel-access', { ports: binding.ports, hosts: binding.hosts })
    return workspaceJson(applied, 202)
  }
  if ((pathname === `${BASE}/binding/confirm` || pathname === `${BASE}/binding/revert`) && method === 'POST') {
    const body = await secBody(request, 64), confirm = pathname.endsWith('/confirm')
    if (Object.keys(body).length) return invalid('no fields are accepted')
    const actor = await fresh(), acknowledged = await requireHost()(actor, `/host/panel-access/${confirm ? 'confirm' : 'revert'}`, {})
    await audit(confirm ? 'server.panel_access.binding_confirmed' : 'server.panel_access.binding_reverted', 'server:panel-access', {})
    return workspaceJson({ ...acknowledged as object, reconcile: confirm ? await reconcileSecOutcome(helpers, actor) : null })
  }
  if (pathname === `${BASE}/service` && method === 'POST') {
    const body = await secBody(request, 128)
    if (Object.keys(body).join() !== 'action' || (body.action !== 'reload' && body.action !== 'restart')) return invalid('the action must be reload or restart')
    const result = await requireHost()(await fresh(), '/host/panel-access/service', { action: body.action })
    await audit('server.panel_access.service_requested', 'server:panel-access', { action: body.action })
    return workspaceJson(result)
  }

  if (pathname === `${BASE}/temporary-logins` && method === 'POST') {
    const input = parseTemporaryRequest(await secBody(request, 512)), actor = await fresh()
    // A helper's session never issues more of itself, and neither does any other borrowed session.
    if (actor.sessionId === null || actor.impersonator) return fail('FORBIDDEN', 'an interactive signed-in session is required', unchanged)
    const { token, link } = await issueTemporaryLogin(helpers.store, actor, input, fresh)
    await audit('temporary_login.created', 'temporary-login:' + link.id, { expiresAt: link.expiresAt })
    return workspaceJson({ ...temporaryLoginView(link, Date.now()), url: `${helpers.publicOrigin ?? ''}/login/temporary/${token}` }, 201)
  }
  const revoke = /^\/api\/server\/panel-access\/temporary-logins\/([0-9a-f]{16})$/.exec(pathname)?.[1]
  if (revoke && method === 'DELETE') {
    const link = await revokeTemporaryLogin(helpers.store, revoke, fresh)
    await audit('temporary_login.revoked', 'temporary-login:' + link.id, {})
    return workspaceJson(temporaryLoginView(link, Date.now()))
  }
  return new Response(null, { status: 404 })
}
