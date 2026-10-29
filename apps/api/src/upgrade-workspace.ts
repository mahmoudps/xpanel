import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'

export interface UpgradeWorkspaceHelpers {
  requireCaller: (request: Request) => Promise<AuthenticatedCaller>
  assertRoot: (caller: AuthenticatedCaller, action: string) => Promise<void>
  emitAudit: (input: { actor: string; action: string; target: string; detail?: Record<string, unknown>; outcome: 'ok' | 'denied' | 'failed'; principalId?: string | null }) => Promise<unknown>
  /** Authenticated agent RPC; no caller-selected host path or command is accepted. */
  callAgent: (path: string, opts: { caller: AuthenticatedCaller; method?: string; body?: unknown }) => Promise<Response>
}

const ROUTES: Readonly<Record<string, { method: 'GET' | 'POST'; agent: string; action: string }>> = {
  '/api/server/upgrade': { method: 'GET', agent: '/host/upgrade', action: 'server.upgrade.read' },
  '/api/server/upgrade/status': { method: 'GET', agent: '/host/upgrade/status', action: 'server.upgrade.read' },
  '/api/server/upgrade/preflight': { method: 'POST', agent: '/host/upgrade/preflight', action: 'server.upgrade.preflight' },
  '/api/server/upgrade/start': { method: 'POST', agent: '/host/upgrade/start', action: 'server.upgrade.start' },
}
const EXACT_VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/
const REVISION = /^[0-9a-f]{64}$/

/** Same grammar as the agent: preflight facts are host observations, never request fields. */
export const parseUpgradeWorkspaceBody = async (request: Request, start: boolean): Promise<Record<string, string>> => {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  const text = await request.text()
  if (text.length > 4096) return fail('VALIDATION', 'upgrade request is too large', { stateChanged: false })
  let body: unknown
  try { body = JSON.parse(text) } catch { return fail('VALIDATION', 'request body is not valid JSON', { stateChanged: false }) }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('VALIDATION', 'request body must be an object', { stateChanged: false })
  const value = body as Record<string, unknown>
  const allowed = start ? ['targetVersion', 'expectedRevision', 'confirm'] : ['targetVersion', 'expectedRevision']
  const unsupported = Object.keys(value).filter(key => !allowed.includes(key))
  if (unsupported.length) return fail('VALIDATION', 'unsupported upgrade field; preflight inputs come only from host observations', { fields: unsupported.slice(0, 16), stateChanged: false })
  if (typeof value.targetVersion !== 'string' || !EXACT_VERSION.test(value.targetVersion) || typeof value.expectedRevision !== 'string' || !REVISION.test(value.expectedRevision)) return fail('VALIDATION', 'an exact staged release version and the observed revision are required', { stateChanged: false })
  if (start && value.confirm !== `upgrade ${value.targetVersion}`) return fail('VALIDATION', 'type the exact confirmation to start the upgrade', { reason: 'confirmation-mismatch', stateChanged: false })
  return start ? { targetVersion: value.targetVersion, expectedRevision: value.expectedRevision, confirm: value.confirm as string } : { targetVersion: value.targetVersion, expectedRevision: value.expectedRevision }
}

const readAgentJson = async (response: Response, start: boolean): Promise<unknown> => {
  const unknown = { stateChanged: start, ...(start ? { unknownOutcome: true, verificationRequired: true } : {}) }
  if (!response.body) return fail('SERVICE_UNAVAILABLE', 'protected host response is missing', unknown)
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > 1024 * 1024) { await reader.cancel(); throw new Error('host_response_limit') }
      chunks.push(next.value)
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  } catch { return fail('SERVICE_UNAVAILABLE', 'protected host response could not be verified', unknown) }
  finally { reader.releaseLock() }
}

/** Root-only panel self-upgrade workspace; the agent observes the host and hands off to the upgrade machine. */
export async function handleUpgradeWorkspaceRoute(request: Request, url: URL, method: string, helpers: UpgradeWorkspaceHelpers): Promise<Response | null> {
  const route = ROUTES[url.pathname]
  if (!route) return null
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, route.action)
  if (method !== route.method) return new Response(null, { status: 405, headers: { allow: route.method } })
  if (url.search) return fail('VALIDATION', 'upgrade workspace routes do not accept selectors', { stateChanged: false })
  const start = url.pathname === '/api/server/upgrade/start'
  const fresh = async (): Promise<AuthenticatedCaller> => {
    const current = await helpers.requireCaller(request)
    if (current.principal.id !== caller.principal.id) return fail('FORBIDDEN', 'upgrade authority changed', { stateChanged: false })
    await helpers.assertRoot(current, route.action)
    return current
  }
  const body = route.method === 'POST' ? await parseUpgradeWorkspaceBody(request, start) : undefined
  if (start) {
    await helpers.emitAudit({ actor: caller.principal.username, action: 'upgrade.start_requested', target: `release:${body!.targetVersion}`, detail: {}, outcome: 'ok', principalId: caller.principal.id })
    await fresh()
  }
  const response = await helpers.callAgent(route.agent, { caller, ...(body ? { method: 'POST', body } : {}) })
  const value = await readAgentJson(response, start && response.status !== 409 && response.status !== 412 && response.status !== 422)
  if (route.method === 'POST') {
    try { await fresh() }
    catch { return fail('FORBIDDEN', 'upgrade authority changed during the host request', { stateChanged: start && response.status === 202, ...(start && response.status === 202 ? { verificationRequired: true } : {}) }) }
  }
  if (start && response.status === 202) {
    const accepted = value as Record<string, unknown>
    try { await helpers.emitAudit({ actor: caller.principal.username, action: 'upgrade.start_accepted', target: `release:${body!.targetVersion}`, detail: { handoffId: typeof accepted?.handoffId === 'string' ? accepted.handoffId : null, upgradeId: typeof accepted?.upgradeId === 'string' ? accepted.upgradeId : null }, outcome: 'ok', principalId: caller.principal.id }) }
    catch { return fail('SERVICE_UNAVAILABLE', 'upgrade handoff requires audit review', { stateChanged: true, verificationRequired: true }) }
  }
  return new Response(JSON.stringify(value), { status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}
