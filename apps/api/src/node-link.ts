import { createHash, createHmac, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import { fail } from '@xpanel/core'
import { createApiToken, revokeApiToken } from '@xpanel/db'
import type { Db } from '@xpanel/db'
import { parseSemver, parseTransferAuth } from '@xpanel/lifecycle'
import type { TransferAuth } from '@xpanel/lifecycle'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import { httpsTransferSourceTransport } from './acct-transfer-discovery.ts'
import type { TransferSourceTransport } from './acct-transfer-discovery.ts'
import { sha256Hex } from './auth.ts'
import type { AuthenticatedCaller } from './auth.ts'

/**
 * Two xPanel servers linked to each other. Each side issues the other a narrow root API token, and each side pins the
 * other's management certificate, so every call proves both ends: the pin proves the callee, the token the caller.
 * Tokens are never shown: each one crosses once over the pinned channel. The only value root ever sees is the link
 * code, a short-lived token that can do nothing but start one link.
 */
export type NodeRole = 'web' | 'dns' | 'mail' | 'db' | 'all'
export type NodeEnrollment = 'verified' | 'unreachable'
export interface ManagedNode {
  /** the peer's own node id */
  id: string
  label: string
  hostname: string
  port: number
  /** SHA-256 of the peer's management certificate, lowercase hex */
  fingerprint: string
  role: NodeRole
  version: string
  linkedAt: string
  /** the API token this server issued to the peer; a call with it identifies the peer */
  inboundTokenId: string
}
export interface NodeConfig { nodes: ManagedNode[] }
export interface NodeIdentity { id: string; hostname: string; port: number; fingerprint: string; version: string }
export interface NodeInvitation { tokenId: string; expiresAt: string }
interface NodeSecrets { version: 1; tokens: Record<string, string>; invitations: NodeInvitation[]; announced: string | null }

export const MAX_NODES = 64
export const NODE_MAX_INVITATIONS = 8
export const NODE_PEER_PREFIX = '/api/server/nodes/peer'
export const NODE_IDENTITY_PATH = NODE_PEER_PREFIX + '/identity'
export const NODE_JOIN_PATH = NODE_PEER_PREFIX + '/join'
export const NODE_PIN_PATH = NODE_PEER_PREFIX + '/pin'
export const NODE_UNLINK_PATH = NODE_PEER_PREFIX + '/unlink'
/** A link token reaches the peer routes and reads the account packages of a transfer, and nothing else. */
export const NODE_LINK_SCOPES = ['nodes:read', 'nodes:write', 'lifecycle:read'] as const
export const NODE_INVITATION_SCOPES = ['nodes:read', 'nodes:write'] as const
export const NODE_INVITATION_TTL_MS = 30 * 60_000
export const NODE_LINK_TOKEN_MS = 365 * 86_400_000
/** How often a renewed management certificate is looked for; one TLS handshake to this server. */
export const NODE_PIN_WATCH_MS = 6 * 60 * 60_000
const PEER_TIMEOUT_MS = 30_000
const PEER_MAX_BYTES = 4 * 1024 * 1024
const CODE_PREFIX = 'xpn1.'
const NODE_ID = /^node_[0-9a-f]{16}$/
const HOSTNAME = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(?:\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+$/
const LABEL = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const FINGERPRINT = /^[a-f0-9]{64}$/
const TOKEN = /^xp_[A-Za-z0-9_-]{43}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,40})?$/
const REASON = /^[a-z_]{1,64}$/
const ROLES = ['web', 'dns', 'mail', 'db', 'all']
const NODE_KEYS = 'fingerprint,hostname,id,inboundTokenId,label,linkedAt,port,role,version'
const unchanged = { stateChanged: false }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>): string => Object.keys(value).sort().join()
const refuse = (reason: string, message: string, extra: Record<string, unknown> = {}): never => fail('PRECONDITION_FAILED', message, { ...unchanged, reason, ...extra })
const isPort = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535

export const isNodeId = (value: unknown): value is string => typeof value === 'string' && NODE_ID.test(value)
export const isNodeLabel = (value: unknown): value is string => typeof value === 'string' && LABEL.test(value)
export const isNodeRole = (value: unknown): value is NodeRole => ROLES.includes(String(value))
export const isNodeFingerprint = (value: unknown): value is string => typeof value === 'string' && FINGERPRINT.test(value)
export const isNodeToken = (value: unknown): value is string => typeof value === 'string' && TOKEN.test(value)
/** Node reports fingerprint256 as upper-case colon-separated hex, the form the transfer channel compares. */
export const colonFingerprint = (hex: string): string => hex.toUpperCase().replace(/(..)(?=.)/g, '$1:')
export const nodeOrigin = (node: Pick<ManagedNode, 'hostname' | 'port'>): string => 'https://' + node.hostname + ':' + node.port

export function parseNodeConfig(value: unknown): NodeConfig {
  if (!object(value) || Object.keys(value).join() !== 'nodes' || !Array.isArray(value.nodes) || value.nodes.length > MAX_NODES) return fail('VALIDATION', 'a bounded list of nodes is required', unchanged)
  const ids = new Set<string>(), hosts = new Set<string>()
  const nodes = value.nodes.map((raw): ManagedNode => {
    if (!object(raw) || keys(raw) !== NODE_KEYS || !isNodeId(raw.id) || ids.has(raw.id) || !isNodeLabel(raw.label) || typeof raw.hostname !== 'string' || raw.hostname.length > 253 || !HOSTNAME.test(raw.hostname) || hosts.has(raw.hostname)
      || !isPort(raw.port) || !isNodeFingerprint(raw.fingerprint) || !isNodeRole(raw.role) || typeof raw.version !== 'string' || !VERSION.test(raw.version)
      || typeof raw.linkedAt !== 'string' || !STAMP.test(raw.linkedAt) || typeof raw.inboundTokenId !== 'string' || !UUID.test(raw.inboundTokenId)) return fail('VALIDATION', 'each node needs a label, hostname, port, certificate fingerprint, role, version and link record', unchanged)
    ids.add(raw.id); hosts.add(raw.hostname)
    return { id: raw.id, label: raw.label, hostname: raw.hostname, port: raw.port, fingerprint: raw.fingerprint, role: raw.role, version: raw.version, linkedAt: raw.linkedAt, inboundTokenId: raw.inboundTokenId }
  })
  return { nodes }
}
export const savedNodeConfigRevision = (raw: unknown): string => createHash('sha256').update(JSON.stringify(raw ?? null)).digest('hex')

export const parseNodeIdentity = (value: unknown): NodeIdentity => {
  if (!object(value) || keys(value) !== 'fingerprint,hostname,id,port,version' || !isNodeId(value.id) || typeof value.hostname !== 'string' || value.hostname.length > 253 || !HOSTNAME.test(value.hostname) || !isPort(value.port)
    || !isNodeFingerprint(value.fingerprint) || typeof value.version !== 'string' || !VERSION.test(value.version)) return refuse('identity_mismatch', 'the node did not return a valid identity')
  return { id: value.id, hostname: value.hostname, port: value.port, fingerprint: value.fingerprint, version: value.version }
}
export const assertSameMajor = (local: string, remote: string): void => {
  const a = parseSemver(local), b = parseSemver(remote)
  if (!a || !b || a.major !== b.major) refuse('version_mismatch', 'both servers must run the same major xPanel version', { local, remote })
}

/** Code shown once on the invited server: where it is, the certificate to pin and the invitation token. */
export const encodeLinkCode = (input: { hostname: string; port: number; fingerprint: string; token: string }): string =>
  CODE_PREFIX + Buffer.from(JSON.stringify([input.hostname, input.port, input.fingerprint, input.token])).toString('base64url')
export const parseLinkCode = (value: unknown): { hostname: string; port: number; fingerprint: string; token: string } => {
  const invalid = (): never => fail('VALIDATION', 'paste the complete link code from the other server', { ...unchanged, reason: 'link_code_invalid' })
  if (typeof value !== 'string' || !value.startsWith(CODE_PREFIX) || value.length > 512) return invalid()
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.from(value.slice(CODE_PREFIX.length), 'base64url').toString('utf8')) } catch { return invalid() }
  if (!Array.isArray(parsed) || parsed.length !== 4) return invalid()
  const [hostname, port, fingerprint, token] = parsed as unknown[]
  if (typeof hostname !== 'string' || hostname.length > 253 || !HOSTNAME.test(hostname) || !isPort(port) || !isNodeFingerprint(fingerprint) || !isNodeToken(token)) return invalid()
  return { hostname, port, fingerprint, token }
}

/** Reads the certificate a peer presents without sending anything; comparing it with a pin is the caller's job. */
export const observeTlsFingerprint = (host: string, port: number): Promise<string> => new Promise((resolve, reject) => {
  const socket = tlsConnect({ host, port, ...(isIP(host) ? {} : { servername: host }), rejectUnauthorized: false, timeout: 10_000 })
  socket.once('secureConnect', () => {
    const fingerprint = socket.getPeerCertificate()?.fingerprint256
    socket.destroy()
    if (typeof fingerprint === 'string') resolve(fingerprint.replaceAll(':', '').toLowerCase()); else reject(new Error('no_certificate'))
  })
  socket.once('timeout', () => { socket.destroy(); reject(new Error('tls_timeout')) })
  socket.once('error', reject)
})

/** Mints a token the way the API tokens page does; admit re-checks the caller at writer admission. */
export async function mintNodeToken(db: Db, input: { principalId: string; name: string; scopes: readonly string[]; expiresAt: string }, admit: (tx: Db) => Promise<void> = async () => undefined): Promise<{ id: string; secret: string }> {
  return db.transaction(async tx => {
    await admit(tx)
    const secret = 'xp_' + randomBytes(32).toString('base64url')
    const created = await createApiToken(tx, { principalId: input.principalId, name: input.name, tokenHash: sha256Hex(secret), scopes: input.scopes, allowedIps: [], expiresAt: input.expiresAt })
    await admit(tx)
    return { id: created.id, secret }
  })
}

const secretsPath = (store: { readonly rootDir: string }): string => join(store.rootDir, 'extended', 'server', 'node-credentials.json')
const configPath = (store: { readonly rootDir: string }): string => join(store.rootDir, 'extended', 'server', 'managed-nodes.json')
const readSecrets = async (store: { readonly rootDir: string }): Promise<NodeSecrets> => {
  const raw = await readJsonIfExists<unknown>(secretsPath(store))
  if (raw === null) return { version: 1, tokens: {}, invitations: [], announced: null }
  const ok = object(raw) && keys(raw) === 'announced,invitations,tokens,version' && raw.version === 1 && object(raw.tokens) && Object.entries(raw.tokens).every(([id, token]) => isNodeId(id) && isNodeToken(token))
    && Array.isArray(raw.invitations) && raw.invitations.every(item => object(item) && keys(item) === 'expiresAt,tokenId' && typeof item.tokenId === 'string' && UUID.test(item.tokenId) && typeof item.expiresAt === 'string' && STAMP.test(item.expiresAt))
    && (raw.announced === null || isNodeFingerprint(raw.announced))
  return ok ? raw as unknown as NodeSecrets : fail('PRECONDITION_FAILED', 'stored node credentials require inspection', unchanged)
}
const readConfig = async (store: { readonly rootDir: string }): Promise<{ raw: unknown; config: NodeConfig | null }> => {
  const raw = await readJsonIfExists<unknown>(configPath(store))
  if (raw === null) return { raw, config: { nodes: [] } }
  try { return { raw, config: parseNodeConfig(raw) } } catch { return { raw, config: null } }
}
/** Trusted-reference lookup, as readTransferCredentialToken; null when the link no longer exists. */
export const readNodeToken = async (store: { readonly rootDir: string }, id: string): Promise<string | null> => (await readSecrets(store)).tokens[id] ?? null

export interface NodeLinkDeps {
  store: Pick<StateStore, 'rootDir' | 'getWriterLock'>
  db: Db
  serverSecret: string
  /** exact xWHM origin of this server; null where no peer can reach it */
  publicOrigin: string | null
  version: () => Promise<string>
  transport?: TransferSourceTransport
  observeTls?: (host: string, port: number) => Promise<string>
  /** Work no request started, such as announcing a renewed certificate. */
  audit?: (action: string, target: string, detail: Record<string, unknown>, outcome: 'ok' | 'failed') => Promise<unknown>
  now?: () => Date
}
export interface NodePeerCall { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number; token?: string; maxBytes?: number }
type Reachable = Pick<ManagedNode, 'hostname' | 'port' | 'fingerprint'> & { id?: string }

const peerReason = (parsed: unknown, fallback: string): string => object(parsed) && object(parsed.details) && typeof parsed.details.reason === 'string' && REASON.test(parsed.details.reason) ? parsed.details.reason : fallback

/** The one seam every node feature crosses: identity, saved links, and the pinned, authenticated peer call. */
export function createNodeLink(deps: NodeLinkDeps) {
  const transport = deps.transport ?? httpsTransferSourceTransport, observe = deps.observeTls ?? observeTlsFingerprint
  const now = (): Date => deps.now?.() ?? new Date()
  const selfId = 'node_' + createHmac('sha256', deps.serverSecret).update('xpanel-node-id').digest('hex').slice(0, 16)
  const availability = (): { available: boolean; reason: string | null } => deps.publicOrigin ? { available: true, reason: null } : { available: false, reason: 'public_origin_required' }

  /** What a peer needs to reach and pin this server; a host without management TLS cannot be linked. */
  const identity = async (): Promise<NodeIdentity> => {
    if (!deps.publicOrigin) return refuse('public_origin_required', 'linking needs the public xWHM address of this server')
    const origin = new URL(deps.publicOrigin), hostname = origin.hostname, port = Number(origin.port || 443)
    let fingerprint: string
    try { fingerprint = await observe(hostname, port) } catch { return refuse('management_tls_unavailable', 'the management certificate of this server could not be read') }
    return { id: selfId, hostname, port, fingerprint, version: await deps.version() }
  }

  /** One read-modify-write of the links and their tokens; secrets go first, so a crash leaves no link without its token. */
  const update = async <T>(change: (state: { config: NodeConfig; secrets: NodeSecrets }) => Promise<T> | T): Promise<T> => {
    const lease = await deps.store.getWriterLock().acquire()
    let written = false
    try {
      const saved = await readConfig(deps.store)
      if (!saved.config) return fail('PRECONDITION_FAILED', 'the saved node links require inspection', unchanged)
      const state = { config: saved.config, secrets: await readSecrets(deps.store) }
      const result = await change(state)
      await lease.assertFencingToken()
      written = true
      await atomicWriteJson(secretsPath(deps.store), state.secrets, 0o600, () => lease.assertFencingToken())
      await atomicWriteJson(configPath(deps.store), state.config, 0o640, () => lease.assertFencingToken())
      await lease.commitAuthority()
      return result
    } catch (error) {
      if (written) return fail('SERVICE_UNAVAILABLE', 'the node link write outcome requires inspection', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
      throw error
    } finally { await lease.release() }
  }

  const nodes = async (): Promise<ManagedNode[]> => (await readConfig(deps.store)).config?.nodes ?? fail('PRECONDITION_FAILED', 'the saved node links require inspection', unchanged)
  const node = async (id: string): Promise<ManagedNode> => (await nodes()).find(item => item.id === id) ?? fail('NOT_FOUND', 'the node is not linked', { ...unchanged, reason: 'node_not_linked' })

  /** Bounded peer call: nothing is sent on a pin mismatch; a refusal keeps the peer's stable reason and bounded message. */
  const call = async (target: Reachable, path: string, init: NodePeerCall = {}): Promise<Record<string, unknown>> => {
    const token = init.token ?? (target.id ? await readNodeToken(deps.store, target.id) : null)
    if (!token) return refuse('node_credential_missing', 'the stored link credential no longer exists')
    let reply
    try {
      reply = await transport({ url: nodeOrigin(target) + path, token, tlsFingerprint: colonFingerprint(target.fingerprint), timeoutMs: init.timeoutMs ?? PEER_TIMEOUT_MS, maxBytes: init.maxBytes ?? PEER_MAX_BYTES, method: init.method ?? 'GET',
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) })
    } catch (error) {
      return (error as Error)?.message === 'tls_pin_mismatch' ? refuse('fingerprint_mismatch', 'the node certificate does not match the pinned fingerprint') : refuse('node_unreachable', 'the node could not be reached')
    }
    let parsed: unknown = null
    try { parsed = JSON.parse(reply.body) } catch { /* a proxy page is not a reply */ }
    if (reply.status === 401 || reply.status === 403) return refuse(peerReason(parsed, 'auth_refused'), 'the node refused this server')
    if (reply.status < 200 || reply.status > 299) {
      const reason = peerReason(parsed, 'peer_refused'), message = object(parsed) && typeof parsed.detail === 'string' ? parsed.detail.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) : 'the node refused the request'
      return reply.status === 409 ? fail('CONFLICT', message, { ...unchanged, reason }) : refuse(reason, message)
    }
    return object(parsed) ? parsed : refuse('peer_refused', 'the node returned an invalid reply')
  }

  /** The node a peer call came from: only the token this server issued to it identifies it. */
  const peerOf = async (caller: AuthenticatedCaller): Promise<ManagedNode> =>
    (await nodes()).find(item => caller.apiTokenId !== null && item.inboundTokenId === caller.apiTokenId) ?? fail('FORBIDDEN', 'this call needs a linked node credential', { ...unchanged, reason: 'node_not_linked' })

  return {
    selfId, availability, identity, update, nodes, node, call, peerOf, now, observe,
    readSaved: () => readConfig(deps.store),
    readSecrets: () => readSecrets(deps.store),
    /** Source reference for a transfer: resolved through readNodeToken, never holding the token itself. */
    transferAuth: async (id: string): Promise<TransferAuth> => {
      const target = await node(id)
      return parseTransferAuth({ kind: 'api-token', url: nodeOrigin(target), tokenId: target.id, tlsFingerprint: colonFingerprint(target.fingerprint) })
    },
    revoke: (tokenId: string): Promise<void> => revokeApiToken(deps.db, tokenId),
    /**
     * A renewed management certificate breaks every peer's pin, so it is announced over each peer's own pinned channel,
     * which still holds. A peer that cannot be told keeps refusing until root re-pins it.
     */
    announcePin: async (): Promise<void> => {
      const links = await nodes()
      if (!links.length) return
      const own = await identity()
      if ((await readSecrets(deps.store)).announced === own.fingerprint) return
      const told = await Promise.allSettled(links.map(item => call(item, NODE_PIN_PATH, { method: 'POST', body: { fingerprint: own.fingerprint } })))
      const missed = links.filter((_item, index) => told[index]!.status === 'rejected').map(item => item.hostname)
      await deps.audit?.('server.nodes.pin_announced', 'server:nodes', { nodes: links.length, missed }, missed.length ? 'failed' : 'ok').catch(() => undefined)
      if (!missed.length) await update(state => { state.secrets.announced = own.fingerprint })
    },
  }
}
export type NodeLink = ReturnType<typeof createNodeLink>

export const liveInvitations = (invitations: readonly NodeInvitation[], at: Date): NodeInvitation[] => invitations.filter(item => Date.parse(item.expiresAt) > at.getTime())
/** The installed release version, read as the transfer source reads it. */
export const nodePackageVersion = async (): Promise<string> => {
  const raw: unknown = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  return object(raw) && typeof raw.version === 'string' ? raw.version : refuse('version_unreadable', 'the installed release version could not be read')
}
