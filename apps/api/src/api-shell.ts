import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { authorizeAccountOwner, workspaceJson } from './account-ssh-workspace.ts'
import { CLI_API_FUNCTIONS } from './cli-api/functions.ts'
import type { CliApiFunction, CliApiMethod } from './cli-api/functions.ts'
import type { DeveloperWorkspaceHelpers } from './developer-workspace.ts'

/**
 * API shell and explorer: pick any listed function, send it through the normal dispatcher with the caller's own session,
 * and shape the result. Nothing here grants anything: the selected route repeats its own authentication, permissions
 * and validation, so an invalid body is refused exactly as a direct call is. The list comes from the CLI catalog, which
 * a test keeps equal to the route matrix.
 */
type ShellSurface = 'account' | 'administrator'
const ROUTE = /^\/api\/(?:(account)\/developer|server\/panel\/developer)\/(functions|call|openapi)$/
const unchanged = { stateChanged: false }
const MAX_BODY = 64 * 1024, MAX_REPLY = 256 * 1024, MAX_PARAMS = 64, MAX_RULES = 8
// Shell calls are made from a live session; these modules move that session or re-enter the shell itself.
const HIDDEN = (fn: CliApiFunction): boolean => fn[3].startsWith('/api/auth/') && fn[1] !== 'me' || fn[3].includes('/developer')
const REPLY_HEADERS = new Set(['content-type', 'cache-control', 'allow', 'retry-after', 'x-request-id'])
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const invalid = (message: string): never => fail('VALIDATION', message, unchanged)
const catalog = (surface: ShellSurface): readonly CliApiFunction[] => CLI_API_FUNCTIONS[surface === 'account' ? 'xuapi' : 'xwhmapi'].filter(fn => !HIDDEN(fn))
const pathParams = (path: string): string[] => [...path.matchAll(/\{([a-zA-Z]+)\}/g)].map(match => match[1]!)

export interface ShellShape {
  start: number; limit: number
  filters: { column: string; type: 'contains' | 'begins' | 'equals' | 'gt' | 'lt'; value: string }[]
  sorts: { column: string; method: 'text' | 'numeric' | 'numeric_zero_max' | 'ipv4'; reverse: boolean }[]
  columns: string[]
}
const NO_SHAPE: ShellShape = { start: 0, limit: 0, filters: [], sorts: [], columns: [] }
const column = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value)
export function parseShellShape(value: unknown): ShellShape {
  if (value === undefined) return NO_SHAPE
  if (!object(value)) return invalid('shape must be an object')
  const { start = 0, limit = 0, filters = [], sorts = [], columns = [] } = value
  if (!Number.isSafeInteger(start) || (start as number) < 0 || !Number.isSafeInteger(limit) || (limit as number) < 0 || !Array.isArray(filters) || filters.length > MAX_RULES || !Array.isArray(sorts) || sorts.length > MAX_RULES || !Array.isArray(columns) || columns.length > 64 || !columns.every(column)) return invalid('the result shape is invalid')
  for (const rule of filters) if (!object(rule) || !column(rule.column) || !['contains', 'begins', 'equals', 'gt', 'lt'].includes(String(rule.type)) || typeof rule.value !== 'string' || rule.value.length > 256) return invalid('a filter is invalid')
  for (const rule of sorts) if (!object(rule) || !column(rule.column) || !['text', 'numeric', 'numeric_zero_max', 'ipv4'].includes(String(rule.method)) || typeof rule.reverse !== 'boolean') return invalid('a sort is invalid')
  return { start: start as number, limit: limit as number, filters: filters as ShellShape['filters'], sorts: sorts as ShellShape['sorts'], columns: columns as string[] }
}
const ipNumber = (value: string): number => value.split('.').reduce((sum, part) => sum * 256 + (Number(part) || 0), 0)
const sortKey = (value: unknown, method: ShellShape['sorts'][number]['method']): number | string => method === 'text' ? String(value ?? '') : method === 'ipv4' ? ipNumber(String(value ?? '')) : Number(value) === 0 && method === 'numeric_zero_max' ? Infinity : Number(value) || 0
/** The first array in the reply is the record list; pagination counts what the filters kept. */
export function shapeRecords(body: unknown, shape: ShellShape): { body: unknown; pagination: { start: number; limit: number; total: number; returned: number } | null } {
  const key = Array.isArray(body) ? null : object(body) ? Object.keys(body).find(name => Array.isArray(body[name])) : undefined
  if (key === undefined) return { body, pagination: null }
  let rows = (key === null ? body : (body as Record<string, unknown>)[key]) as unknown[]
  const cell = (row: unknown, name: string): unknown => object(row) ? row[name] : undefined
  for (const rule of shape.filters) rows = rows.filter(row => {
    const text = String(cell(row, rule.column) ?? '')
    return rule.type === 'contains' ? text.includes(rule.value) : rule.type === 'begins' ? text.startsWith(rule.value) : rule.type === 'equals' ? text === rule.value : rule.type === 'gt' ? Number(text) > Number(rule.value) : Number(text) < Number(rule.value)
  })
  for (const rule of [...shape.sorts].reverse()) rows = [...rows].sort((a, b) => {
    const left = sortKey(cell(a, rule.column), rule.method), right = sortKey(cell(b, rule.column), rule.method)
    return (left < right ? -1 : left > right ? 1 : 0) * (rule.reverse ? -1 : 1)
  })
  const total = rows.length
  rows = rows.slice(shape.start, shape.limit === 0 ? undefined : shape.start + shape.limit)
  if (shape.columns.length) rows = rows.map(row => object(row) ? Object.fromEntries(shape.columns.filter(name => Object.hasOwn(row, name)).map(name => [name, row[name]])) : row)
  return { body: key === null ? rows : { ...(body as Record<string, unknown>), [key]: rows }, pagination: { start: shape.start, limit: shape.limit, total, returned: rows.length } }
}

/** Path and body of one call. A value for a path parameter cannot leave its segment. */
export function buildShellRequest(fn: CliApiFunction, params: Record<string, string>): { method: CliApiMethod; path: string; query: string; body: Record<string, string> | null } {
  const rest = { ...params }
  const path = fn[3].replace(/\{([a-zA-Z]+)\}/g, (_, name: string) => {
    const value = rest[name]
    if (value === undefined) return invalid('parameter ' + name + ' is required')
    if (value === '' || value === '.' || value === '..') return invalid('parameter ' + name + ' is invalid')
    delete rest[name]
    return encodeURIComponent(value)
  })
  const inQuery = fn[2] === 'GET' || fn[2] === 'DELETE', query = inQuery ? new URLSearchParams(rest).toString() : ''
  return { method: fn[2], path, query, body: inQuery || !Object.keys(rest).length ? null : rest }
}

export function openApiDocument(surface: ShellSurface, version: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {}, command = surface === 'account' ? 'xuapi' : 'xwhmapi'
  for (const fn of catalog(surface)) {
    const [module, name, method, path] = fn
    ;(paths[path] ??= {})[method.toLowerCase()] = {
      operationId: module + '_' + name, tags: [module], summary: command + ' ' + module + ' ' + name, 'x-xpanel-cli': command + ' ' + module + ' ' + name,
      parameters: pathParams(path).map(param => ({ name: param, in: 'path', required: true, schema: { type: 'string' } })),
      ...(method === 'GET' || method === 'DELETE' ? {} : { requestBody: { required: false, content: { 'application/json': { schema: { type: 'object' } } } } }),
      responses: { 200: { description: 'Success', content: { 'application/json': { schema: { type: 'object' } } } }, default: { description: 'RFC 9457 problem', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } } },
    }
  }
  return {
    openapi: '3.1.0', info: { title: surface === 'account' ? 'xPanel account API' : 'xWHM API', version }, security: [{ bearer: [] }, { session: [] }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' }, session: { type: 'apiKey', in: 'cookie', name: 'xpanel_session' } }, schemas: { Problem: { type: 'object', required: ['title', 'status', 'code'], properties: { type: { type: 'string' }, title: { type: 'string' }, status: { type: 'integer' }, detail: { type: 'string' }, code: { type: 'string' }, details: { type: 'object' } } } } },
    paths,
  }
}

export async function handleApiShellRoute(req: Request, url: URL, method: string, helpers: DeveloperWorkspaceHelpers & { version?: string }): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  const surface: ShellSurface = match[1] ? 'account' : 'administrator', route = match[2]!
  const authorize = async (): Promise<AuthenticatedCaller> => {
    const caller = surface === 'account' ? (await authorizeAccountOwner(helpers, req, ['api-shell'], 'API shell')).caller : await helpers.requireCaller(req)
    if (surface === 'administrator') await helpers.assertRoot(caller, 'developer.shell')
    if (caller.sessionId === null || caller.apiTokenId !== null) return fail('FORBIDDEN', 'the API shell requires the signed-in interactive session', unchanged)
    if (!await helpers.apiShellEnabled()) return fail('FORBIDDEN', 'the API shell is turned off on this server', { ...unchanged, reason: 'api_shell_disabled' })
    return caller
  }
  const caller = await authorize()
  if (url.search) return invalid('the API shell accepts no query selectors')
  if (route !== 'call') {
    if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
    if (route === 'openapi') return workspaceJson(openApiDocument(surface, helpers.version ?? '0.0.0'))
    return workspaceJson({ surface, command: surface === 'account' ? 'xuapi' : 'xwhmapi', available: typeof helpers.dispatchRead === 'function', functions: catalog(surface).map(([module, fn, verb, path]) => ({ module, fn, method: verb, path, params: pathParams(path) })) })
  }
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return invalid('JSON is required')
  const text = await req.text()
  if (Buffer.byteLength(text) > MAX_BODY) return invalid('the request is too large')
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return invalid('the request must be valid JSON') }
  if (!object(raw) || typeof raw.module !== 'string' || typeof raw.fn !== 'string' || !object(raw.params) || Object.keys(raw.params).length > MAX_PARAMS || !Object.values(raw.params).every(value => typeof value === 'string' && value.length <= 4096)) return invalid('a function and text parameters are required')
  const selected = catalog(surface).find(fn => fn[0] === raw.module && fn[1] === raw.fn)
  if (!selected) return fail('NOT_FOUND', 'this function is not listed on this surface', unchanged)
  const shape = parseShellShape(raw.shape), target = buildShellRequest(selected, raw.params as Record<string, string>)
  if (!helpers.dispatchRead) return fail('PRECONDITION_FAILED', 'the API dispatcher is unavailable', unchanged)
  const next = new URL(req.url); next.pathname = target.path; next.search = target.query; next.hash = ''
  const headers = new Headers(req.headers)
  headers.delete('content-length')
  // A session-bound POST carries its CSRF proof; the selected verb keeps that proof while the method changes.
  const inner = new Request(next, { method: target.method, headers, redirect: 'error', signal: req.signal, ...(target.body ? { body: JSON.stringify(target.body) } : {}) })
  let reply: Response
  try { reply = await helpers.dispatchRead(inner) } catch (error) { return fail('SERVICE_UNAVAILABLE', 'the selected call did not complete', { stateChanged: target.method !== 'GET', verificationRequired: target.method !== 'GET', reason: (error as { code?: string }).code ?? 'dispatch_failed' }) }
  const reader = reply.body?.getReader(), parts: Uint8Array[] = []
  let size = 0, truncated = false
  if (reader) for (;;) {
    const part = await reader.read()
    if (part.done) break
    size += part.value.byteLength
    if (size > MAX_REPLY) { truncated = true; await reader.cancel(); break }
    parts.push(part.value)
  }
  const body = Buffer.concat(parts).toString('utf8')
  let parsed: unknown = null, pagination: ReturnType<typeof shapeRecords>['pagination'] = null
  if (!truncated && /json/.test(reply.headers.get('content-type') ?? '')) try { const shaped = shapeRecords(JSON.parse(body), shape); parsed = shaped.body; pagination = shaped.pagination } catch { parsed = null }
  await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action: 'developer.shell.call', target: target.method + ' ' + selected[3], detail: { function: selected[0] + '.' + selected[1], status: reply.status, parameters: Object.keys(raw.params).length }, outcome: reply.ok ? 'ok' : 'denied' })
  return workspaceJson({
    request: { method: target.method, path: target.path, query: target.query, body: target.body }, status: reply.status, truncated, pagination,
    headers: [...reply.headers].filter(([name]) => REPLY_HEADERS.has(name.toLowerCase())), json: parsed, raw: parsed === null ? body.slice(0, MAX_REPLY) : JSON.stringify(parsed, null, 2),
  })
}
