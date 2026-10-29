import { fail } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { authorizeAccountOwner, workspaceJson } from './account-ssh-workspace.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

export type DeveloperOperation = 'identity' | 'preferences' | 'tokens'
export type DeveloperSurface = 'account' | 'administrator' | 'integrations'
export interface DeveloperWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: StateStore
  /** Re-enter the normal API dispatcher with its ORIGINAL trusted transport context. Never a network fetch or a privileged synthetic caller. */
  dispatchRead?: (request: Request) => Promise<Response>
  now?: () => Date
}
export interface DeveloperReadDescriptor { operation: DeveloperOperation; method: 'GET'; path: string }
export interface DeveloperManifest { surface: DeveloperSurface; available: boolean; operations: DeveloperReadDescriptor[]; writes: false; rawResponses: false }
export interface DeveloperReadResult {
  operation: DeveloperOperation
  request: { method: 'GET'; path: string }
  state: 'read' | 'refused'
  status: number
  observedAt: string
  fields: { key: string; value: string | null }[]
  tokens: { name: string; scopes: string[]; expiresAt: string; state: 'active' | 'expired' | 'revoked' }[]
}
const MAX_BODY = 1024, MAX_REPLY = 256 * 1024, MAX_TOKENS = 200
const unchanged = { stateChanged: false }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const invalid = (message: string): never => fail('VALIDATION', message, unchanged)
const unavailable = (): never => fail('SERVICE_UNAVAILABLE', 'the selected API read could not be verified', unchanged)
const safe = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && v.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/u.test(v)
const time = (v: unknown): v is string => typeof v === 'string' && v.length <= 32 && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v
const same = (a: AuthenticatedCaller, b: AuthenticatedCaller): boolean => a.principal.kind === b.principal.kind && a.principal.id === b.principal.id && a.principal.username === b.principal.username
  && (a.principal.kind !== 'user' || b.principal.kind === 'user' && a.principal.accountId === b.principal.accountId) && a.sessionId === b.sessionId && a.apiTokenId === b.apiTokenId

/** No path, URL, headers, body, credentials, principal or account selector is accepted. */
export function parseDeveloperOperation(value: unknown): DeveloperOperation {
  if (!object(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'operation') || typeof value.operation !== 'string' || !['identity', 'preferences', 'tokens'].includes(value.operation)) return invalid('exactly one supported operation is required')
  return value.operation as DeveloperOperation
}
export function developerReadDescriptors(surface: DeveloperSurface): DeveloperReadDescriptor[] {
  if (surface === 'integrations') return [{ operation: 'tokens', method: 'GET', path: '/api/server/panel/api-tokens' }]
  return [{ operation: 'identity', method: 'GET', path: '/api/auth/me' }, { operation: 'preferences', method: 'GET', path: surface === 'account' ? '/api/account/preferences' : '/api/admin/preferences' },
    ...(surface === 'administrator' ? [{ operation: 'tokens' as const, method: 'GET' as const, path: '/api/server/panel/api-tokens' }] : [])]
}
const readJson = async (request: Request | Response, max: number): Promise<unknown> => {
  if (!request.body) return invalid('a JSON body is required')
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > max) { await reader.cancel(); return invalid('the JSON body exceeds its bound') }; chunks.push(part.value) }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown
  } catch { return invalid('a bounded valid JSON body is required') } finally { reader.releaseLock() }
}

/** Explicit projection only: /auth/me also returns CSRF and principal IDs, which never enter this result. */
export function projectDeveloperRead(operation: DeveloperOperation, raw: unknown, caller: AuthenticatedCaller): Pick<DeveloperReadResult, 'fields' | 'tokens'> {
  if (!object(raw)) return unavailable()
  if (operation === 'identity') {
    if (!object(raw.principal) || raw.principal.id !== caller.principal.id || raw.principal.kind !== caller.principal.kind || raw.principal.username !== caller.principal.username
      || !safe(raw.principal.username, 64) || caller.principal.kind === 'user' && raw.principal.accountId !== caller.principal.accountId) return unavailable()
    return { fields: [{ key: 'username', value: raw.principal.username }, { key: 'role', value: caller.principal.kind }], tokens: [] }
  }
  if (operation === 'preferences') {
    if (caller.principal.kind === 'user') {
      if (!object(raw.context) || raw.context.accountId !== caller.principal.accountId || !object(raw.preferences) || !safe(raw.preferences.contactEmail, 254)) return unavailable()
      return { fields: [{ key: 'contactEmail', value: raw.preferences.contactEmail }], tokens: [] }
    }
    if (!['default', 'saved', 'invalid'].includes(String(raw.state)) || raw.preferences !== null && !object(raw.preferences)) return unavailable()
    const p = raw.preferences
    if (raw.state === 'invalid' ? p !== null : !object(p) || !['en', 'ar'].includes(String(p.language)) || !['light', 'dark'].includes(String(p.theme)) || !['comfortable', 'compact'].includes(String(p.density))) return unavailable()
    return { fields: [{ key: 'preferenceState', value: String(raw.state) }, { key: 'language', value: object(p) ? String(p.language) : null }, { key: 'theme', value: object(p) ? String(p.theme) : null }, { key: 'density', value: object(p) ? String(p.density) : null }], tokens: [] }
  }
  if (caller.principal.kind !== 'root' || !Array.isArray(raw.tokens) || raw.tokens.length > MAX_TOKENS) return unavailable()
  const tokens = raw.tokens.map(t => {
    if (!object(t) || !safe(t.name, 64) || !/^[a-z0-9][a-z0-9-]*$/.test(t.name) || !Array.isArray(t.scopes) || t.scopes.length > 128 || new Set(t.scopes).size !== t.scopes.length
      || !t.scopes.every(s => typeof s === 'string' && /^(?:\*|[a-z][a-z0-9-]{0,63}:(?:read|write|\*))$/.test(s)) || !time(t.expiresAt) || !['active', 'expired', 'revoked'].includes(String(t.state))) return unavailable()
    return { name: t.name, scopes: t.scopes as string[], expiresAt: t.expiresAt, state: t.state as 'active' | 'expired' | 'revoked' }
  })
  return { fields: [{ key: 'tokenCount', value: String(tokens.length) }], tokens }
}

/** Shared implementation for the developer console and root's own credential integration inspection. */
export async function handleDeveloperRequest(req: Request, url: URL, method: string, surface: DeveloperSurface, helpers: DeveloperWorkspaceHelpers): Promise<Response> {
  const authorize = async (): Promise<AuthenticatedCaller> => {
    const caller = surface === 'account' ? (await authorizeAccountOwner(helpers, req, ['api-shell'], 'API explorer')).caller : await helpers.requireCaller(req)
    if (surface !== 'account') await helpers.assertRoot(caller, 'developer.explorer.read')
    if (caller.sessionId === null || caller.apiTokenId !== null) return fail('FORBIDDEN', 'the API explorer requires the signed-in interactive session', unchanged)
    return caller
  }
  const first = await authorize()
  if (url.search) return invalid('the API explorer accepts no query selectors')
  if (!['GET', 'POST'].includes(method)) return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
  const descriptors = developerReadDescriptors(surface)
  const fresh = async (): Promise<AuthenticatedCaller> => { const current = await authorize(); if (!same(first, current)) return fail('FORBIDDEN', 'the explorer session authority changed', unchanged); return current }
  if (method === 'GET') {
    if (req.body) return invalid('the explorer manifest accepts no body')
    await fresh()
    const manifest: DeveloperManifest = { surface, available: typeof helpers.dispatchRead === 'function', operations: descriptors, writes: false, rawResponses: false }
    return workspaceJson(manifest)
  }
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return invalid('JSON is required')
  const operation = parseDeveloperOperation(await readJson(req, MAX_BODY)), descriptor = descriptors.find(d => d.operation === operation)
  if (!descriptor) return fail('FORBIDDEN', 'this operation is outside the current explorer surface', unchanged)
  if (!helpers.dispatchRead) return fail('PRECONDITION_FAILED', 'the guarded API read provider is unavailable', unchanged)
  const caller = await fresh()
  const selectedUrl = new URL(req.url); selectedUrl.pathname = descriptor.path; selectedUrl.search = ''; selectedUrl.hash = ''
  const selected = new Request(selectedUrl, { method: 'GET', headers: new Headers(req.headers), redirect: 'error', signal: req.signal })
  let reply: Response
  try { reply = await helpers.dispatchRead(selected) } catch { return unavailable() }
  await fresh()
  const freshSelected = async (): Promise<void> => {
    // The normal dispatcher has attached the original trusted transport context to selected.
    // Repeat its target policy too: a target feature can be revoked independently of api-shell.
    const targetCaller = await helpers.requireCaller(selected)
    if (!same(first, targetCaller)) return fail('FORBIDDEN', 'the selected read session authority changed', unchanged)
    await fresh()
  }
  const refused = !reply.ok
  if (!Number.isSafeInteger(reply.status) || reply.status < 200 || reply.status > 599 || reply.status >= 300 && reply.status < 400) return unavailable()
  let projected: Pick<DeveloperReadResult, 'fields' | 'tokens'> = { fields: [], tokens: [] }
  if (!refused) {
    if (reply.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return unavailable()
    let raw: unknown
    try { raw = await readJson(reply, MAX_REPLY) } catch { return unavailable() }
    projected = projectDeveloperRead(operation, raw, caller)
    await freshSelected()
  } else { await reply.body?.cancel().catch(() => undefined) }
  await fresh()
  // Only operation/state are audited. No response content, token material, contact email or session identity is copied into audit detail.
  await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action: 'developer.explorer.read', target: descriptor.path, detail: { operation, status: reply.status, state: refused ? 'refused' : 'read' }, outcome: refused ? 'denied' : 'ok' })
  if (!refused) await freshSelected()
  else await fresh()
  const now = (helpers.now ?? (() => new Date()))().toISOString()
  const result: DeveloperReadResult = { operation, request: { method: 'GET', path: descriptor.path }, state: refused ? 'refused' : 'read', status: reply.status, observedAt: now, ...projected }
  return workspaceJson(result)
}

export async function handleDeveloperWorkspaceRoute(req: Request, url: URL, method: string, helpers: DeveloperWorkspaceHelpers): Promise<Response | null> {
  if (url.pathname !== '/api/account/developer' && url.pathname !== '/api/server/panel/developer') return null
  return handleDeveloperRequest(req, url, method, url.pathname === '/api/account/developer' ? 'account' : 'administrator', helpers)
}
