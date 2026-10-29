import { createHash } from 'node:crypto'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

/** Additional managed servers registered over an authenticated channel. The registry is configuration; a node is
 * usable only after the authenticated channel to it is verified. A single-node install shows an honest empty state. */
export type NodeRole = 'web' | 'dns' | 'mail' | 'db' | 'all'
export type NodeEnrollment = 'pending' | 'verified' | 'unreachable'
export interface ManagedNode { id: string; label: string; hostname: string; port: number; fingerprint: string; role: NodeRole }
export interface NodeConfig { nodes: ManagedNode[] }

export const MAX_NODES = 64
const NODE_ID = /^node_[0-9a-f]{16}$/
const HOSTNAME = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(?:\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+$/
const LABEL = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u
const ROLES = ['web', 'dns', 'mail', 'db', 'all']
const unchanged = { stateChanged: false }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

export function parseNodeConfig(value: unknown): NodeConfig {
  if (!object(value) || Object.keys(value).join() !== 'nodes' || !Array.isArray(value.nodes) || value.nodes.length > MAX_NODES) return fail('VALIDATION', 'a bounded list of nodes is required', unchanged)
  const ids = new Set<string>(), hosts = new Set<string>(), prints = new Set<string>()
  const nodes = value.nodes.map(raw => {
    if (!object(raw) || Object.keys(raw).sort().join() !== 'fingerprint,hostname,id,label,port,role' || typeof raw.id !== 'string' || !NODE_ID.test(raw.id) || ids.has(raw.id)
      || typeof raw.label !== 'string' || !LABEL.test(raw.label) || typeof raw.hostname !== 'string' || raw.hostname.length > 253 || !HOSTNAME.test(raw.hostname) || hosts.has(raw.hostname)
      || typeof raw.port !== 'number' || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535
      || typeof raw.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(raw.fingerprint) || prints.has(raw.fingerprint) || !ROLES.includes(String(raw.role))) return fail('VALIDATION', 'each node needs a label, FQDN, port, SHA-256 key fingerprint and role', unchanged)
    ids.add(raw.id); hosts.add(raw.hostname); prints.add(raw.fingerprint)
    return { id: raw.id, label: raw.label, hostname: raw.hostname, port: raw.port, fingerprint: raw.fingerprint, role: raw.role as NodeRole }
  })
  return { nodes }
}
export const nodeConfigRevision = (config: NodeConfig): string =>
  createHash('sha256').update(JSON.stringify([...config.nodes].map(node => [node.hostname, node.port, node.fingerprint, node.role, node.label]).sort((a, b) => (a[0] as string) < (b[0] as string) ? -1 : 1))).digest('hex')
export const savedNodeConfigRevision = (raw: unknown): string => createHash('sha256').update(JSON.stringify(raw ?? null)).digest('hex')

export interface NodesWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  readSaved: () => Promise<unknown>
  writeSaved: (value: unknown) => Promise<unknown>
  /** This server's configured hostname, or null when it has not been set. */
  readHostname: () => Promise<string | null>
  /** Authenticated channel handshake to a node, pinned to its fingerprint. Null until a real channel is qualified. */
  verifyChannel?: (node: ManagedNode) => Promise<{ reachable: boolean; fingerprintMatched: boolean }>
  now?: () => Date
}

const ROUTE = '/api/server/nodes', VERIFY = '/api/server/nodes/verify'

export async function handleNodesWorkspaceRoute(request: Request, url: URL, method: string, helpers: NodesWorkspaceHelpers): Promise<Response | null> {
  const verify = url.pathname === VERIFY
  if (!verify && url.pathname !== ROUTE) return null
  const action = verify ? 'server.nodes.verify' : method === 'PUT' ? 'server.nodes.save' : 'server.nodes.read'
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  if (url.search) return fail('VALIDATION', 'node routes accept no selectors', unchanged)
  const fresh = async (): Promise<AuthenticatedCaller> => { const current = await helpers.requireCaller(request); await helpers.assertRoot(current, action); if (current.principal.id !== caller.principal.id || current.sessionId !== caller.sessionId || current.apiTokenId !== caller.apiTokenId) return fail('FORBIDDEN', 'node authority changed', unchanged); return current }

  if (verify) {
    if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
    const body = await readJson(request, 1024)
    if (!object(body) || Object.keys(body).join() !== 'id' || typeof body.id !== 'string' || !NODE_ID.test(body.id)) return fail('VALIDATION', 'a node id is required', unchanged)
    const config = parseNodeConfig(await helpers.readSaved())
    const node = config.nodes.find(item => item.id === body.id)
    if (!node) return fail('NOT_FOUND', 'the node is not registered', unchanged)
    const actor = await fresh()
    if (!helpers.verifyChannel) {
      await helpers.emitAudit({ actor: actor.principal.username, principalId: actor.principal.id, action: 'server.nodes.verify_attempted', target: 'node:' + node.hostname, detail: { result: 'channel_unavailable' }, outcome: 'ok' })
      return json(200, { id: node.id, enrollment: 'pending', reason: 'authenticated_channel_unavailable' })
    }
    let result: { reachable: boolean; fingerprintMatched: boolean }
    try { result = await helpers.verifyChannel(node) } catch { return fail('SERVICE_UNAVAILABLE', 'the node channel could not be verified', unchanged) }
    const enrollment: NodeEnrollment = result.reachable && result.fingerprintMatched ? 'verified' : 'unreachable'
    await helpers.emitAudit({ actor: actor.principal.username, principalId: actor.principal.id, action: 'server.nodes.verified', target: 'node:' + node.hostname, detail: { enrollment }, outcome: enrollment === 'verified' ? 'ok' : 'failed' })
    return json(200, { id: node.id, enrollment, reason: enrollment === 'verified' ? null : result.reachable ? 'fingerprint_mismatch' : 'node_unreachable' })
  }

  if (method === 'GET') {
    const raw = await helpers.readSaved()
    let invalid = false
    if (raw !== null && raw !== undefined) try { parseNodeConfig(raw) } catch { invalid = true }
    const config = invalid ? { nodes: [] } : parseNodeConfig(raw ?? { nodes: [] })
    const hostname = await helpers.readHostname()
    await fresh()
    return json(200, { config, savedRevision: savedNodeConfigRevision(raw), activeRevision: nodeConfigRevision(config), invalid, thisServer: { hostname }, singleNode: config.nodes.length === 0, channel: { verification: helpers.verifyChannel ? 'available' : 'unavailable' } })
  }
  if (method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'GET, PUT' } })

  const body = await readJson(request, 64 * 1024)
  if (!object(body) || Object.keys(body).sort().join() !== 'config,expectedSavedRevision' || typeof body.expectedSavedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedSavedRevision)) return fail('VALIDATION', 'a config and the observed saved revision are required', unchanged)
  const config = parseNodeConfig(body.config)
  const actor = await fresh()
  if (savedNodeConfigRevision(await helpers.readSaved()) !== body.expectedSavedRevision) return fail('CONFLICT', 'the node registry changed since it was read; reload before saving', unchanged)
  await helpers.writeSaved(config)
  const after = await helpers.readSaved()
  let verified: NodeConfig
  try { verified = parseNodeConfig(after) } catch { return fail('SERVICE_UNAVAILABLE', 'the saved node registry could not be verified', { stateChanged: true, verificationRequired: true }) }
  if (nodeConfigRevision(verified) !== nodeConfigRevision(config)) return fail('SERVICE_UNAVAILABLE', 'the saved node registry could not be verified', { stateChanged: true, verificationRequired: true })
  await helpers.emitAudit({ actor: actor.principal.username, principalId: actor.principal.id, action: 'server.nodes.saved', target: 'server:nodes', detail: { nodes: config.nodes.length }, outcome: 'ok' })
  return json(200, { config: verified, savedRevision: savedNodeConfigRevision(after), activeRevision: nodeConfigRevision(verified) })
}

async function readJson(request: Request, max: number): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', unchanged)
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > max) return fail('VALIDATION', 'the request body is too large', unchanged)
  try { return JSON.parse(text) } catch { return fail('VALIDATION', 'request body is not valid JSON', unchanged) }
}
