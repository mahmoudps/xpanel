import type { IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { RequestOptions } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import type { ConnectionOptions, TLSSocket } from 'node:tls'
import { fail } from '@xpanel/core'
import type { SourceAccount, SourcePlan, TransferAuth } from '@xpanel/lifecycle'
import type { TransferWorkspacePorts } from './transfer-workspace.ts'

/** Path of the source-side reply built by apps/api/src/acct-transfer-source.ts on the source xPanel server. */
export const TRANSFER_SOURCE_INVENTORY_PATH = '/api/transfers/source/inventory'
export const TRANSFER_SOURCE_TIMEOUT_MS = 15_000
export const TRANSFER_SOURCE_MAX_BYTES = 8 * 1024 * 1024
const MAX_ACCOUNTS = 5000
export interface TransferSourceReply { status: number; contentType: string | null; body: string }
export interface TransferSourceRequest { url: string; token: string; tlsFingerprint: string | null; timeoutMs: number; maxBytes: number; method?: 'GET' | 'POST'; body?: string }
/** One bounded HTTPS request; the token travels only in the Authorization header and only after the peer is authenticated. */
export type TransferSourceTransport = (input: TransferSourceRequest) => Promise<TransferSourceReply>
export interface TransferSourceStream { status: number; contentType: string | null; body: AsyncIterable<Uint8Array> }
/** Same channel for an archive download: the body is streamed and stops with an error past maxBytes. */
export type TransferSourceStreamTransport = (input: TransferSourceRequest) => Promise<TransferSourceStream>
export interface TransferSourceInventory { source: { hostname: string; version: string }; accounts: SourceAccount[]; plans: SourcePlan[] }

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>): string => Object.keys(value).sort().join()
const bad = (): never => fail('PRECONDITION_FAILED', 'the source returned an invalid inventory reply', { stateChanged: false })
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const strings = (value: unknown, max: number, itemMax: number): value is string[] => Array.isArray(value) && value.length <= max && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= itemMax)
const ACCOUNT_KEYS = 'databases,diskBytes,domains,mailboxes,phpVersions,plan,primaryDomain,uid,username'

/** Shape and bounds only; the transfer reducer (packages/lifecycle/src/transfer/session.ts) applies the naming and domain rules. */
export function parseTransferSourceInventory(raw: unknown): TransferSourceInventory {
  if (!object(raw) || keys(raw) !== 'accounts,plans,source' || !object(raw.source) || keys(raw.source) !== 'hostname,version'
    || typeof raw.source.hostname !== 'string' || raw.source.hostname.length > 253 || typeof raw.source.version !== 'string' || raw.source.version.length > 64
    || !Array.isArray(raw.accounts) || raw.accounts.length > MAX_ACCOUNTS || !Array.isArray(raw.plans) || raw.plans.length > MAX_ACCOUNTS) return bad()
  const accounts = raw.accounts.map((item): SourceAccount => {
    if (!object(item) || keys(item) !== ACCOUNT_KEYS || typeof item.username !== 'string' || item.username.length > 32 || !count(item.uid) || typeof item.primaryDomain !== 'string' || item.primaryDomain.length > 253
      || !strings(item.domains, 5000, 253) || typeof item.plan !== 'string' || item.plan.length > 128 || !count(item.diskBytes) || !strings(item.databases, 10_000, 128) || !count(item.mailboxes) || !strings(item.phpVersions, 32, 8)) return bad()
    return { username: item.username, uid: item.uid, primaryDomain: item.primaryDomain, domains: [...item.domains], plan: item.plan, diskBytes: item.diskBytes, databases: [...item.databases], mailboxes: item.mailboxes, phpVersions: [...item.phpVersions] }
  })
  const plans = raw.plans.map((item): SourcePlan => object(item) && keys(item) === 'name' && typeof item.name === 'string' && item.name.length <= 128 ? { name: item.name } : bad())
  return { source: { hostname: raw.source.hostname, version: raw.source.version }, accounts, plans }
}

/** Node reports fingerprint256 as upper-case colon-separated hex, the same form TransferAuth pins. */
export const peerMatchesPin = (socket: Pick<TLSSocket, 'getPeerCertificate'>, pin: string): boolean => {
  const fingerprint = socket.getPeerCertificate()?.fingerprint256
  return typeof fingerprint === 'string' && fingerprint === pin
}

/**
 * Production channel. With a pin, the certificate is accepted only by its SHA-256 fingerprint (it may be
 * self-signed); without one, the system CA store and hostname verification apply. Redirects are never followed.
 */
const openSourceRequest = ({ url, token, tlsFingerprint, timeoutMs, method = 'GET', body }: TransferSourceRequest, accept: string): Promise<IncomingMessage> => new Promise((resolve, reject) => {
  const target = new URL(url)
  if (target.protocol !== 'https:') { reject(new Error('https_required')); return }
  const pinned = tlsFingerprint !== null
  const req = httpsRequest(target, {
    method, agent: false, timeout: timeoutMs, headers: { accept, authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }) },
    ...(pinned ? {
      // Hand the socket to the request only after the pin matched, so no header is written to another peer.
      createConnection: (options: { signal?: AbortSignal }, done: (error: Error | null, socket?: TLSSocket) => void) => {
        const socket = tlsConnect({ host: target.hostname.replace(/^\[|\]$/g, ''), port: Number(target.port || 443), ...(/^[\d.]+$|:/.test(target.hostname) ? {} : { servername: target.hostname }), rejectUnauthorized: false, ...(options.signal ? { signal: options.signal } : {}) } as ConnectionOptions)
        socket.once('secureConnect', () => { if (peerMatchesPin(socket, tlsFingerprint)) done(null, socket); else { socket.destroy(); done(new Error('tls_pin_mismatch')) } })
        socket.once('error', error => done(error))
        return undefined
      },
    } : {}),
  } as RequestOptions, resolve)
  req.on('timeout', () => req.destroy(new Error('source_timeout')))
  req.on('error', reject)
  req.end(body)
})

export const httpsTransferSourceTransport: TransferSourceTransport = async input => {
  const response = await openSourceRequest(input, 'application/json')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of response as AsyncIterable<Buffer>) {
    size += chunk.byteLength
    if (size > input.maxBytes) { response.destroy(); throw new Error('reply_too_large') }
    chunks.push(chunk)
  }
  return { status: response.statusCode ?? 0, contentType: response.headers['content-type'] ?? null, body: Buffer.concat(chunks).toString('utf8') }
}

export const httpsTransferSourceStreamTransport: TransferSourceStreamTransport = async input => {
  const response = await openSourceRequest(input, 'application/gzip')
  async function* body(): AsyncGenerator<Uint8Array> {
    let size = 0
    try {
      for await (const chunk of response as AsyncIterable<Buffer>) {
        size += chunk.byteLength
        if (size > input.maxBytes) throw new Error('reply_too_large')
        yield chunk
      }
    } finally { response.destroy() }
  }
  return { status: response.statusCode ?? 0, contentType: response.headers['content-type'] ?? null, body: body() }
}

/** TransferWorkspacePorts.discover over the source server's API with a stored token reference. */
export function createTransferSourceDiscovery(deps: { readToken: (id: string) => Promise<string | null>; transport?: TransferSourceTransport }): NonNullable<TransferWorkspacePorts['discover']> {
  const transport = deps.transport ?? httpsTransferSourceTransport
  return async (_caller, auth: TransferAuth) => {
    if (auth.kind !== 'api-token') return fail('PRECONDITION_FAILED', 'SSH source discovery is unavailable; save an API token credential for the source and connect with it', { stateChanged: false })
    const token = await deps.readToken(auth.tokenId)
    if (!token) return fail('PRECONDITION_FAILED', 'the stored source credential no longer exists', { stateChanged: false })
    let reply: TransferSourceReply
    try { reply = await transport({ url: auth.url + TRANSFER_SOURCE_INVENTORY_PATH, token, tlsFingerprint: auth.tlsFingerprint, timeoutMs: TRANSFER_SOURCE_TIMEOUT_MS, maxBytes: TRANSFER_SOURCE_MAX_BYTES }) }
    catch { return fail('PRECONDITION_FAILED', 'the source could not be reached over an authenticated HTTPS channel', { stateChanged: false }) }
    if (reply.status === 401 || reply.status === 403) return fail('PRECONDITION_FAILED', 'the source refused the stored credential; it needs a root API token with lifecycle read access', { stateChanged: false })
    if (reply.status !== 200 || reply.contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return fail('PRECONDITION_FAILED', 'the source did not return an inventory', { stateChanged: false, sourceStatus: reply.status })
    let raw: unknown
    try { raw = JSON.parse(reply.body) } catch { return bad() }
    return parseTransferSourceInventory(raw)
  }
}
