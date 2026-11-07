import { request } from 'node:http'
import { fail, isXpanelError } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { system } from '@xpanel/render'

/**
 * One request to an account's Radicale for xMail, which keeps its calendars and contacts in that store. The API
 * cannot reach the root-owned socket; this route can, and it names the identity the way nginx does for a device.
 * The API has decided the caller may act as that principal; here the principal must belong to the account.
 */
export interface DavExchangeBody {
  principal: string
  method: string
  path: string
  body?: string
  contentType?: string
  ifMatch?: string
  ifNoneMatch?: boolean
}
export interface DavExchangePorts {
  account: Account
  /** the account's service users, whose ids are its principals */
  listServiceUsers(accountId: string): Promise<readonly { id: string; services: { email: boolean } }[]>
  /** the account's socket; a test passes its own */
  socketPath?: string
}

const METHODS: ReadonlySet<string> = new Set(['GET', 'PUT', 'DELETE', 'PROPPATCH', 'MKCALENDAR', 'MKCOL'])
const SEGMENT = /^[A-Za-z0-9._~%@+!$&'()*,;=:-]{1,255}$/
const CONTENT_TYPES: ReadonlySet<string> = new Set(['text/calendar', 'text/vcard', 'application/xml'])
const ETAG = /^(?:W\/)?"[\x21\x23-\x7e]{1,128}"$/
const STORE_PAGE = /^\?after=[0-9a-f]{2,2400}$/
const MAX_REPLY_BYTES = 7 * 1024 * 1024
const TIMEOUT_MS = 30_000
const unchanged = { stateChanged: false }
const unavailable = (): never => fail('SERVICE_UNAVAILABLE', 'the calendar store is not available', { ...unchanged, reason: 'dav_store_unavailable' })

const safeSegment = (segment: string): boolean => {
  if (!SEGMENT.test(segment)) return false
  try {
    const decoded = decodeURIComponent(segment)
    return decoded !== '.' && decoded !== '..' && !decoded.includes('/') && !decoded.includes('\0')
  } catch { return false }
}

/** The store read, or a path inside the principal's own tree; never another principal's. */
export const davExchangePathAllowed = (principal: string, method: string, path: string): boolean => {
  if (path.split('?')[0] === system.CALDAV_STORE_PATH) return method === 'GET' && (path === system.CALDAV_STORE_PATH || STORE_PAGE.test(path.slice(system.CALDAV_STORE_PATH.length)))
  const parts = path.split('/')
  if (parts[0] !== '' || parts[1] !== principal || parts.length < 4 || parts.length > 5) return false
  const collection = parts[2]!, item = parts[3]!, tail = parts[4]
  if (!safeSegment(collection)) return false
  return parts.length === 4 ? item === '' || safeSegment(item) : tail === '' && safeSegment(item)
}

export const parseDavExchange = (raw: unknown): DavExchangeBody => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('VALIDATION', 'a store request is required', unchanged)
  const value = raw as Record<string, unknown>
  if (Object.keys(value).some(key => !['principal', 'method', 'path', 'body', 'contentType', 'ifMatch', 'ifNoneMatch'].includes(key))) return fail('VALIDATION', 'unsupported store request field', unchanged)
  if (typeof value.principal !== 'string' || !system.CALDAV_PRINCIPAL_RE.test(value.principal) || typeof value.method !== 'string' || !METHODS.has(value.method)
    || typeof value.path !== 'string' || !davExchangePathAllowed(value.principal, value.method, value.path)) return fail('VALIDATION', 'the store request is not allowed', unchanged)
  if (value.body !== undefined && typeof value.body !== 'string') return fail('VALIDATION', 'the store request body must be text', unchanged)
  if (value.contentType !== undefined && !CONTENT_TYPES.has(String(value.contentType))) return fail('VALIDATION', 'unsupported store content type', unchanged)
  if (value.ifMatch !== undefined && !ETAG.test(String(value.ifMatch))) return fail('VALIDATION', 'invalid store precondition', unchanged)
  if (value.ifNoneMatch !== undefined && value.ifNoneMatch !== true) return fail('VALIDATION', 'invalid store precondition', unchanged)
  return value as unknown as DavExchangeBody
}

const exchange = (socketPath: string, input: DavExchangeBody): Promise<{ status: number; etag: string; body: Buffer }> => new Promise((resolve, reject) => {
  const payload = input.body === undefined ? null : Buffer.from(input.body, 'utf8')
  const outgoing = request({
    socketPath, method: input.method, path: input.path, timeout: TIMEOUT_MS,
    headers: {
      host: 'localhost', 'x-remote-user': input.principal,
      ...(payload ? { 'content-length': payload.byteLength, 'content-type': input.contentType ?? 'application/octet-stream' } : {}),
      ...(input.ifMatch ? { 'if-match': input.ifMatch } : {}), ...(input.ifNoneMatch ? { 'if-none-match': '*' } : {}),
    },
  }, response => {
    const chunks: Buffer[] = []
    let size = 0
    response.on('data', (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > MAX_REPLY_BYTES) { response.destroy(); outgoing.destroy(new Error('dav_reply_too_large')); return }
      chunks.push(chunk)
    })
    response.on('end', () => resolve({ status: response.statusCode ?? 502, etag: String(response.headers.etag ?? ''), body: Buffer.concat(chunks) }))
    response.on('error', reject)
  })
  outgoing.on('timeout', () => outgoing.destroy(new Error('dav_timeout')))
  outgoing.on('error', reject)
  outgoing.end(payload ?? undefined)
})

/** POST /accounts/:username/dav-exchange. The store's status and ETag travel in headers, its body unchanged. */
export const handleDavExchange = async (req: Request, ports: DavExchangePorts): Promise<Response> => {
  let raw: unknown
  try { raw = await req.json() } catch { return fail('VALIDATION', 'a JSON store request is required', unchanged) }
  const input = parseDavExchange(raw)
  if (input.principal !== system.CALDAV_MAIN_PRINCIPAL) {
    const owner = (await ports.listServiceUsers(ports.account.id)).find(user => user.id === input.principal)
    if (!owner?.services.email) return fail('NOT_FOUND', 'mailbox not found', unchanged)
  }
  try {
    const reply = await exchange(ports.socketPath ?? system.calDavPaths(ports.account).socket, input)
    return new Response(new Uint8Array(reply.body), { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-xpanel-dav-status': String(reply.status), ...(ETAG.test(reply.etag) ? { 'x-xpanel-dav-etag': reply.etag } : {}) } })
  } catch (error) {
    if (isXpanelError(error)) throw error
    return unavailable()
  }
}
