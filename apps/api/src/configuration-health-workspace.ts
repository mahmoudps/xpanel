import { fail, isXpanelError } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { parseConfigurationHealthIntent } from '../../agent/src/configuration-health.ts'
import { readConfigurationHealthRepair, readConfigurationHealthView } from '../../agent/src/configuration-health-contract.ts'

export interface ConfigurationHealthWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  callHost: (caller: AuthenticatedCaller, path: '/host/configuration-health' | '/host/configuration-health/repair', input?: unknown, mutation?: boolean) => Promise<unknown>
}
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
export async function handleConfigurationHealthWorkspaceRoute(req: Request, url: URL, method: string, h: ConfigurationHealthWorkspaceHelpers): Promise<Response | null> {
  const mutation = url.pathname === '/api/server/configuration-health/repair'
  if (!mutation && url.pathname !== '/api/server/configuration-health') return null
  const action = 'server.configuration-health.' + (mutation ? 'repair' : 'read'), initial = await h.requireCaller(req)
  await h.assertRoot(initial, action)
  const fresh = async () => { const current = await h.requireCaller(req); await h.assertRoot(current, action); if (current.principal.id !== initial.principal.id) return fail('FORBIDDEN', 'configuration health authority changed', { stateChanged: false }); return current }
  if (method !== (mutation ? 'POST' : 'GET')) return new Response(null, { status: 405, headers: { allow: mutation ? 'POST' : 'GET' } })
  if (url.search) return fail('VALIDATION', 'configuration health does not accept selectors', { stateChanged: false })
  if (!mutation) {
    const value = await h.callHost(initial, '/host/configuration-health'); await fresh()
    try { return json(readConfigurationHealthView(value)) } catch { return fail('PRECONDITION_FAILED', 'configuration observations could not be verified', { stateChanged: false }) }
  }
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  const text = await req.text()
  if (text.length > 2048) return fail('VALIDATION', 'configuration repair request is too large', { stateChanged: false })
  let body: unknown
  try { body = JSON.parse(text) } catch { return fail('VALIDATION', 'valid JSON is required', { stateChanged: false }) }
  const intent = parseConfigurationHealthIntent(body)
  await fresh(); await h.emitAudit({ actor: initial.principal.username, principalId: initial.principal.id, action: 'configuration.health.repair.requested', target: 'configuration', detail: { generationId: intent.expectedGenerationId }, outcome: 'ok' })
  const caller = await fresh()
  let acknowledged = false
  try {
    const value = await h.callHost(caller, '/host/configuration-health/repair', intent, true)
    acknowledged = true
    const view = readConfigurationHealthRepair(value, intent.target, { id: intent.expectedGenerationId, checksum: intent.expectedGenerationChecksum })
    await fresh()
    return json({ outcome: 'verified', target: intent.target, generation: view.generation, recoveryVerified: true, verificationRequired: false, view })
  } catch (error) {
    if (!acknowledged && isXpanelError(error) && error.detail.stateChanged === false) throw error
    return fail('SERVICE_UNAVAILABLE', 'configuration repair outcome requires readback and recovery review', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  }
}
