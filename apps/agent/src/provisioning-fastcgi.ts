import { fail } from '@xpanel/core'
import { timingSafeEqual } from 'node:crypto'
import { ACCOUNT_PROBE_ROUTE } from '../../../packages/render/src/system/account-probe.ts'

export const FASTCGI = Object.freeze({ begin: 1, abort: 2, end: 3, params: 4, stdin: 5, stdout: 6, stderr: 7 })
export const CANARY_PHP_ADMIN_VALUE = 'auto_prepend_file=\nauto_append_file=\nuser_ini.filename=\nopcache.enable=0\noutput_buffering=0\nzlib.output_compression=0'
export interface FastCgiRecord { readonly type: number; readonly requestId: number; readonly content: Buffer }
const invalid: () => never = () => fail('PRECONDITION_FAILED', 'the bounded canary FastCGI protocol was not verified', { verificationRequired: true })

/** One private connection, bounded records and no multiplexed/unbounded stream. */
export class FastCgiDecoder {
  private pending: Buffer = Buffer.alloc(0)
  private total = 0
  push(chunk: Uint8Array): FastCgiRecord[] {
    this.total += chunk.byteLength
    if (this.total > 32768 || this.pending.length + chunk.byteLength > 32768) return invalid()
    this.pending = Buffer.concat([this.pending, chunk])
    const records: FastCgiRecord[] = []
    while (this.pending.length >= 8) {
      const version = this.pending[0], type = this.pending[1], requestId = this.pending.readUInt16BE(2)
      const length = this.pending.readUInt16BE(4), padding = this.pending[6], reserved = this.pending[7]
      if (version !== 1 || type === undefined || padding === undefined || reserved !== 0 || requestId < 1 || length > 16384) return invalid()
      const size = 8 + length + padding
      if (this.pending.length < size) break
      records.push({ type, requestId, content: Buffer.from(this.pending.subarray(8, 8 + length)) })
      this.pending = this.pending.subarray(size)
      if (records.length > 32) return invalid()
    }
    return records
  }
  finish(): void { if (this.pending.length !== 0) invalid() }
}

export function fastCgiRecord(type: number, requestId: number, content: Uint8Array = Buffer.alloc(0)): Buffer {
  if (!Number.isSafeInteger(type) || type < 1 || type > 255 || !Number.isSafeInteger(requestId) || requestId < 1 || requestId > 65535 || content.byteLength > 16384) return invalid()
  const header = Buffer.alloc(8)
  header[0] = 1; header[1] = type; header.writeUInt16BE(requestId, 2); header.writeUInt16BE(content.byteLength, 4)
  return Buffer.concat([header, content])
}
const lengthBytes = (length: number): Buffer => {
  if (!Number.isSafeInteger(length) || length < 0 || length > 8192) return invalid()
  if (length < 128) return Buffer.from([length])
  const encoded = Buffer.alloc(4); encoded.writeUInt32BE((length | 0x80000000) >>> 0); return encoded
}
export function fastCgiParams(values: Readonly<Record<string, string>>): Buffer {
  const fields: Buffer[] = []
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || (/[\u0000\r\n]/.test(value)
      && !(key === 'PHP_ADMIN_VALUE' && value === CANARY_PHP_ADMIN_VALUE))) return invalid()
    const name = Buffer.from(key), data = Buffer.from(value)
    fields.push(lengthBytes(name.length), lengthBytes(data.length), name, data)
  }
  const encoded = Buffer.concat(fields)
  if (encoded.length > 8192) return invalid()
  return encoded
}
export function parseFastCgiParams(content: Buffer): ReadonlyMap<string, string> {
  if (content.length > 8192) return invalid()
  let position = 0
  const length = (): number => {
    const first = content[position]
    if (first === undefined) return invalid()
    if (first < 128) { position++; return first }
    if (position + 4 > content.length) return invalid()
    const value = content.readUInt32BE(position) & 0x7fffffff; position += 4
    if (value > 8192) return invalid()
    return value
  }
  const values = new Map<string, string>(), utf8 = new TextDecoder('utf8', { fatal: true })
  while (position < content.length) {
    const nameLength = length(), valueLength = length()
    if (nameLength < 1 || nameLength > 64 || position + nameLength + valueLength > content.length) return invalid()
    let key: string, value: string
    try {
      key = utf8.decode(content.subarray(position, position + nameLength)); position += nameLength
      value = utf8.decode(content.subarray(position, position + valueLength)); position += valueLength
    } catch { return invalid() }
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || /[\u0000\r\n]/.test(value) || values.has(key)) return invalid()
    values.set(key, value)
    if (values.size > 32) return invalid()
  }
  return values
}
export const matchesCanaryAdmission = (value: string | undefined, expected: string): boolean => typeof value === 'string'
  && /^[a-f0-9]{64}$/.test(value) && /^[a-f0-9]{64}$/.test(expected) && timingSafeEqual(Buffer.from(value, 'hex'), Buffer.from(expected, 'hex'))
export function assertCanaryIngress(values: ReadonlyMap<string, string>, domain: string): void {
  if (values.size !== 7 || values.get('REQUEST_METHOD') !== 'GET' || values.get('SCRIPT_NAME') !== ACCOUNT_PROBE_ROUTE
    || values.get('REQUEST_URI') !== ACCOUNT_PROBE_ROUTE || values.get('SERVER_NAME') !== domain
    || values.get('HTTP_HOST') !== domain || !['', '0'].includes(values.get('CONTENT_LENGTH') ?? 'invalid')
    || !/^[a-f0-9]{64}$/.test(values.get('HTTP_X_XPANEL_PROBE_ADMISSION') ?? '')) invalid()
}
/** The immutable producer emits one exact ASCII frame; no reported PID, alternate JSON or extra field is accepted. */
export function matchesCanaryCallback(bytes: Buffer, challenge: string, binding: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(challenge) || !/^[a-f0-9]{64}$/.test(binding)) return false
  const expected = Buffer.from(JSON.stringify({ schemaVersion: 1, challenge, binding }) + '\n')
  return bytes.length === expected.length && timingSafeEqual(bytes, expected)
}
export function fastCgiCanaryRequest(script: string, route: string, domain: string, challenge: string, binding: string): Buffer {
  if (!/^[a-f0-9]{64}$/.test(challenge) || !/^[a-f0-9]{64}$/.test(binding) || !script.startsWith('/') || !route.startsWith('/')) return invalid()
  const begin = Buffer.from([0, 1, 0, 0, 0, 0, 0, 0])
  // Only fixed canary parameters cross this boundary; incoming PHP/admin settings never do.
  const params = fastCgiParams({ REQUEST_METHOD: 'GET', SCRIPT_FILENAME: script, SCRIPT_NAME: route, REQUEST_URI: route,
    DOCUMENT_ROOT: script.slice(0, script.lastIndexOf('/')), SERVER_NAME: domain, SERVER_PORT: '80', SERVER_PROTOCOL: 'HTTP/1.1',
    GATEWAY_INTERFACE: 'CGI/1.1', REDIRECT_STATUS: '200', CONTENT_LENGTH: '0', QUERY_STRING: '',
    XPANEL_PROBE_CHALLENGE: challenge, XPANEL_PROBE_BINDING: binding, PHP_ADMIN_VALUE: CANARY_PHP_ADMIN_VALUE })
  return Buffer.concat([fastCgiRecord(FASTCGI.begin, 1, begin), fastCgiRecord(FASTCGI.params, 1, params), fastCgiRecord(FASTCGI.params, 1), fastCgiRecord(FASTCGI.stdin, 1)])
}
