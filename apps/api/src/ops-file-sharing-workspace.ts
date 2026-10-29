import { fail, isXpanelError } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { parseShareConfig, savedShareConfigRevision, shareConfigRevision } from '../../agent/src/ops-file-sharing.ts'
import type { ShareConfig, ShareObservation } from '../../agent/src/ops-file-sharing.ts'

export interface FileSharingWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  /** ext.readOrDefault('file-sharing/shares.json', null) */
  readSaved: () => Promise<unknown>
  /** ext.write('file-sharing/shares.json', value) */
  writeSaved: (value: unknown) => Promise<unknown>
  /** Protected agent transport; a body sends the apply POST. */
  callHost: (caller: AuthenticatedCaller, path: '/host/file-sharing' | '/host/file-sharing/apply', body?: Record<string, unknown>) => Promise<unknown>
}

const ROUTE = '/api/server/file-sharing', APPLY = '/api/server/file-sharing/apply'
const MAX_BODY = 256 * 1024
const unchanged = { stateChanged: false }
const invalid = (message: string): never => fail('VALIDATION', message, unchanged)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const unverified = (): never => fail('PRECONDITION_FAILED', 'the host export observation could not be verified', unchanged)

const EXPORT_STATES = ['exported', 'not-exported', 'conflict']
const SHARE_PATH = /^\/(?:home|srv\/shares)\//
// Reject control, bidi-override and BOM code points without a regex literal (a literal U+2028 would break the source line).
const UNSAFE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069\\ufeff]', 'u')
const safe = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && value.isWellFormed() && !UNSAFE.test(value)

/** Whitelists the agent observation: nothing outside the reviewed share/export shape crosses the boundary. */
export function projectShareObservation(value: unknown): ShareObservation {
  if (!object(value) || !['read', 'unavailable'].includes(String(value.state)) || !Array.isArray(value.shares) || value.shares.length > 200 || !Array.isArray(value.foreignExports) || value.foreignExports.length > 1000
    || typeof value.managedPresent !== 'boolean' || (value.reason !== null && !(safe(value.reason, 64) && /^[a-z][a-z0-9_]{0,63}$/.test(value.reason)))) return unverified()
  const shares = value.shares.map(raw => {
    if (!object(raw) || !safe(raw.id, 32) || !/^shr_[0-9a-z]{16}$/.test(raw.id) || !safe(raw.path, 1024) || !SHARE_PATH.test(raw.path) || !EXPORT_STATES.includes(String(raw.exportState)) || !Array.isArray(raw.clients) || raw.clients.length > 64) return unverified()
    const clients = raw.clients.map(client => object(client) && safe(client.host, 255) && (client.permission === 'ro' || client.permission === 'rw') && typeof client.squashRoot === 'boolean' && typeof client.subtreeCheck === 'boolean'
      ? { host: client.host, permission: client.permission as 'ro' | 'rw', squashRoot: client.squashRoot, subtreeCheck: client.subtreeCheck } : unverified())
    return { id: raw.id, path: raw.path, clients, exportState: raw.exportState as ShareObservation['shares'][number]['exportState'] }
  })
  const foreignExports = value.foreignExports.map(path => safe(path, 1024) && path.startsWith('/') ? path : unverified())
  return { state: value.state as ShareObservation['state'], managedPresent: value.managedPresent, shares, foreignExports, reason: value.reason as string | null }
}

export async function handleFileSharingWorkspaceRoute(request: Request, url: URL, method: string, helpers: FileSharingWorkspaceHelpers): Promise<Response | null> {
  const apply = url.pathname === APPLY
  if (!apply && url.pathname !== ROUTE) return null
  const action = apply ? 'server.file-sharing.apply' : method === 'PUT' ? 'server.file-sharing.save' : 'server.file-sharing.read'
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  if (url.search) return invalid('file sharing routes accept no selectors')
  const fresh = async (stateChanged = false): Promise<AuthenticatedCaller> => {
    const current = await helpers.requireCaller(request)
    await helpers.assertRoot(current, action)
    if (current.principal.id !== caller.principal.id || current.sessionId !== caller.sessionId || current.apiTokenId !== caller.apiTokenId) return fail('FORBIDDEN', 'file sharing authority changed', stateChanged ? { stateChanged: true, unknownOutcome: true, verificationRequired: true } : unchanged)
    return current
  }

  if (apply) {
    if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
    const body = await readApplyBody(request)
    const actor = await fresh()
    await helpers.emitAudit({ actor: actor.principal.username, principalId: actor.principal.id, action: 'server.file-sharing.apply_requested', target: 'file-sharing', detail: {}, outcome: 'ok' })
    let result: unknown
    try { result = await helpers.callHost(await fresh(), '/host/file-sharing/apply', body) }
    catch (error) { if (isXpanelError(error) && error.detail.stateChanged === false) throw error; return fail('SERVICE_UNAVAILABLE', 'the export change outcome could not be verified', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
    if (!object(result) || !object(result.active)) return fail('SERVICE_UNAVAILABLE', 'the applied export state could not be verified', { stateChanged: true, verificationRequired: true })
    await fresh(true)
    return json(200, { active: projectShareObservation(result.active), appliedRevision: typeof result.appliedRevision === 'string' && /^[0-9a-f]{64}$/.test(result.appliedRevision) ? result.appliedRevision : unverified() })
  }

  if (method === 'GET') {
    const observation = await helpers.callHost(caller, '/host/file-sharing')
    await fresh()
    if (!object(observation) || !object(observation.saved)) return unverified()
    const saved = observation.saved
    if (typeof saved.savedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(saved.savedRevision) || typeof saved.revision !== 'string' || !/^[0-9a-f]{64}$/.test(saved.revision) || typeof saved.invalid !== 'boolean') return unverified()
    let config: ShareConfig
    try { config = parseShareConfig(saved.config) } catch { return unverified() }
    if (shareConfigRevision(config) !== saved.revision) return unverified()
    return json(200, { config, savedRevision: saved.savedRevision, activeRevision: saved.revision, invalid: saved.invalid, observed: projectShareObservation(observation.observed) })
  }
  if (method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'GET, PUT' } })

  // PUT saves desired shares as configuration; it never touches active exports until apply is called.
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return invalid('JSON is required')
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY) return invalid('the request body is too large')
  let body: unknown
  try { body = JSON.parse(text) } catch { return invalid('request body is not valid JSON') }
  if (!object(body) || Object.keys(body).sort().join() !== 'config,expectedSavedRevision' || typeof body.expectedSavedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedSavedRevision)) return invalid('a config and the observed saved revision are required')
  const config = parseShareConfig(body.config)
  const actor = await fresh()
  if (savedShareConfigRevision(await helpers.readSaved()) !== body.expectedSavedRevision) return fail('CONFLICT', 'saved shares changed since they were read; reload before saving', unchanged)
  await helpers.writeSaved(config)
  const after = await helpers.readSaved()
  let verified: ShareConfig
  try { verified = parseShareConfig(after) } catch { return fail('SERVICE_UNAVAILABLE', 'the saved shares could not be verified', { stateChanged: true, verificationRequired: true }) }
  if (shareConfigRevision(verified) !== shareConfigRevision(config)) return fail('SERVICE_UNAVAILABLE', 'the saved shares could not be verified', { stateChanged: true, verificationRequired: true })
  await helpers.emitAudit({ actor: actor.principal.username, principalId: actor.principal.id, action: 'server.file-sharing.saved', target: 'file-sharing', detail: { shares: config.shares.length }, outcome: 'ok' })
  return json(200, { config: verified, savedRevision: savedShareConfigRevision(after), activeRevision: shareConfigRevision(verified) })
}

async function readApplyBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return invalid('JSON is required')
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > 1024) return invalid('the request body is too large')
  let body: unknown
  try { body = JSON.parse(text) } catch { return invalid('request body is not valid JSON') }
  if (!object(body) || Object.keys(body).sort().join() !== 'expectedActiveRevision,expectedRevision' || [body.expectedRevision, body.expectedActiveRevision].some(value => typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))) return invalid('exact observed revisions are required')
  return { expectedRevision: body.expectedRevision, expectedActiveRevision: body.expectedActiveRevision }
}
