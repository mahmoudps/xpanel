import { createHash, randomBytes } from 'node:crypto'
import { fail, isXpanelError } from '@xpanel/core'
import { createRootPrincipal, createTestDb, findActiveApiTokenByHash } from '@xpanel/db'
import type { PrincipalRecord } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import type { TransferSourceRequest, TransferSourceTransport } from './acct-transfer-discovery.ts'
import { sha256Hex } from './auth.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { hasApiScope, policyForRequest } from './authorization.ts'
import { colonFingerprint, createNodeLink } from './node-link.ts'
import type { NodeLink } from './node-link.ts'
import { handleNodesWorkspaceRoute } from './ops-nodes-workspace.ts'

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
export type Route = (request: Request, url: URL, method: string) => Promise<Response | null>

export interface FakeServer {
  hostname: string
  fingerprint: string
  version: string
  reachable: boolean
  store: StateStore
  link: NodeLink
  caller: AuthenticatedCaller
  audits: Record<string, unknown>[]
  routes: Route[]
  /** the only way in: a pinned TLS peer with a bearer token, as the real listener and policy check would admit */
  serve(request: Request): Promise<Response>
  /** root working in this server's own page */
  root(method: string, path: string, body?: unknown): Promise<Response>
  guards: Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'>
}

export interface FakeNetwork { servers: Map<string, FakeServer>; requests: TransferSourceRequest[]; transport: TransferSourceTransport; closers: Array<() => Promise<unknown>>; close(): Promise<void> }

const problem = (error: unknown): Response => {
  if (!isXpanelError(error)) throw error
  return new Response(JSON.stringify({ code: error.code, detail: error.message, details: error.detail }), { status: error.status, headers: { 'content-type': 'application/problem+json' } })
}

/**
 * Whole servers without a socket: real routes, tokens, files and link state on both ends. Only TLS is modelled: a request
 * reaches a peer when the pin it carries equals that peer's certificate, which is what the real transport enforces.
 */
export const createFakeNetwork = (): FakeNetwork => {
  const servers = new Map<string, FakeServer>(), requests: TransferSourceRequest[] = []
  const transport: TransferSourceTransport = async input => {
    requests.push(input)
    const url = new URL(input.url), peer = servers.get(url.hostname)
    if (!peer || !peer.reachable) throw new Error('connect_failed')
    if (input.tlsFingerprint !== colonFingerprint(peer.fingerprint)) throw new Error('tls_pin_mismatch')
    const response = await peer.serve(new Request(input.url, { method: input.method ?? 'GET', headers: { authorization: 'Bearer ' + input.token, ...(input.body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(input.body === undefined ? {} : { body: input.body }) }))
    return { status: response.status, contentType: response.headers.get('content-type'), body: await response.text() }
  }
  const closers: Array<() => Promise<unknown>> = []
  return { servers, requests, transport, closers, close: async () => { for (const close of closers.splice(0)) await close() } }
}

export const addFakeServer = async (network: FakeNetwork, name: string, options: { version?: string; routes?: (server: FakeServer) => Route[] } = {}): Promise<FakeServer> => {
  const state = await createTestStateStore(), database = await createTestDb()
  network.closers.push(() => state.close(), () => database.close())
  const principal: PrincipalRecord = await createRootPrincipal(database.db, { username: 'root', passwordHash: HASH } as never)
  const session: AuthenticatedCaller = { principal: { kind: 'root', id: principal.id, username: 'root' }, principalRecord: principal, sessionId: 'session-' + name, sessionToken: 'x', apiTokenId: null, scopes: ['*'], csrfValid: true, mfaVerified: true } as AuthenticatedCaller
  const hostname = 'whm.' + name + '.example.com'
  const audits: Record<string, unknown>[] = []
  const server = { hostname, fingerprint: randomBytes(32).toString('hex'), version: options.version ?? '1.4.0', reachable: true, store: state.store, caller: session, audits, routes: [] as Route[] } as FakeServer
  server.link = createNodeLink({ store: state.store, db: database.db, serverSecret: createHash('sha256').update(name).digest('hex'), publicOrigin: 'https://' + hostname + ':2087', version: async () => server.version, transport: network.transport, observeTls: async host => { const peer = network.servers.get(host); if (!peer?.reachable) throw new Error('connect_failed'); return peer.fingerprint } })
  const requireCaller = async (request: Request): Promise<AuthenticatedCaller> => {
    const bearer = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1]
    if (!bearer) return session
    const token = await findActiveApiTokenByHash(database.db, sha256Hex(bearer))
    if (!token) return fail('UNAUTHENTICATED', 'invalid token')
    return { ...session, sessionId: null, sessionToken: null, apiTokenId: token.id, scopes: [...token.scopes] } as AuthenticatedCaller
  }
  server.guards = { requireCaller, assertRoot: async () => undefined, emitAudit: async (entry: Record<string, unknown>) => { audits.push(entry) } } as never
  const nodes: Route = (request, url, method) => handleNodesWorkspaceRoute(request, url, method, { ...server.guards, db: database.db, link: server.link, readHostname: async () => hostname, authorizeIssuance: async () => undefined })
  server.routes = [nodes, ...options.routes?.(server) ?? []]
  const route = async (request: Request): Promise<Response> => {
    const url = new URL(request.url), caller = await requireCaller(request.clone())
    if (caller.apiTokenId !== null) {
      const policy = policyForRequest(url.pathname, request.method)
      if (!policy || !hasApiScope(caller, policy.resource + ':' + (request.method === 'GET' || policy.scopeAccess === 'read' ? 'read' : 'write'))) return fail('FORBIDDEN', 'API token does not grant this operation')
    }
    for (const handle of server.routes) { const response = await handle(request, url, request.method); if (response) return response }
    return new Response(null, { status: 404 })
  }
  server.serve = request => route(request).catch(problem)
  server.root = (method, path, body) => server.serve(new Request('https://' + hostname + ':2087' + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }))
  network.servers.set(hostname, server)
  return server
}

/** Root on `invited` makes a code, root on `linker` pastes it. */
export const linkServers = async (linker: FakeServer, invited: FakeServer, input: { label?: string; role?: string } = {}): Promise<Response> => {
  const code = (await (await invited.root('POST', '/api/server/nodes/invitations', {})).json() as { code: string }).code
  return linker.root('POST', '/api/server/nodes/link', { code, label: input.label ?? 'Second', role: input.role ?? 'all' })
}
