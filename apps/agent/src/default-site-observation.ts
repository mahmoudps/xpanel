import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isIP } from 'node:net'
import { dirname } from 'node:path'
import { fail } from '@xpanel/core'
import { XP_PATHS } from '../../../packages/render/src/edge/paths.ts'

export const DEFAULT_SITE_LOG_BYTES = 256 * 1024
export const DEFAULT_SITE_LOG_LIMIT = 100
const LOG_PATH = XP_PATHS.nginxLogDir + '/default.access.log'
const unsafe = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/
export interface DefaultSiteRequest { at: string; host: string; address: string; status: number }
export interface DefaultSiteObservation {
  state: 'read' | 'partial' | 'unavailable'
  observedAt: string
  source: 'nginx-default-access-log'
  items: DefaultSiteRequest[]
  limit: 100
  truncated: boolean
  malformedRecords: number
  reason?: 'default_log_unavailable'
}
export interface DefaultSiteLogTail { bytes: Uint8Array; partialStart: boolean }

/** Native fixed-path read: no request can select a file, command, offset or byte count. */
export async function readNativeDefaultSiteLogTail(): Promise<DefaultSiteLogTail> {
  if (process.platform !== 'linux') return fail('PRECONDITION_FAILED', 'default-site observations require the Linux host provider')
  let directory = dirname(LOG_PATH)
  while (true) {
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) return fail('PRECONDITION_FAILED', 'default-site log path is not trusted')
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  const file = await open(LOG_PATH, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.uid !== 0 || (before.mode & 0o022) !== 0 || !Number.isSafeInteger(before.size) || before.size < 0) return fail('PRECONDITION_FAILED', 'default-site log is not a trusted regular file')
    const size = Math.min(before.size, DEFAULT_SITE_LOG_BYTES), start = before.size - size, buffer = Buffer.alloc(size)
    const { bytesRead } = await file.read(buffer, 0, size, start)
    const after = await file.stat()
    if (bytesRead !== size || !after.isFile() || after.uid !== 0 || (after.mode & 0o022) !== 0 || before.ino !== after.ino || before.dev !== after.dev || after.size < before.size) return fail('PRECONDITION_FAILED', 'default-site log changed during observation')
    return { bytes: buffer, partialStart: start > 0 }
  } finally { await file.close() }
}

/** Whitelists only the four approved table columns; URLs, agents and referrers never escape. */
export function parseDefaultSiteLogTail(tail: DefaultSiteLogTail, observedAt = new Date().toISOString()): DefaultSiteObservation {
  if (!(tail.bytes instanceof Uint8Array) || tail.bytes.byteLength > DEFAULT_SITE_LOG_BYTES || typeof tail.partialStart !== 'boolean') return fail('PRECONDITION_FAILED', 'default-site log observation exceeds its bound')
  const at = new Date(observedAt)
  if (!Number.isFinite(at.getTime())) return fail('VALIDATION', 'invalid default-site observation time')
  let bytes = tail.bytes, truncated = tail.partialStart, malformedRecords = 0
  if (tail.partialStart) {
    const boundary = bytes.indexOf(10)
    bytes = boundary === -1 ? bytes.subarray(bytes.length) : bytes.subarray(boundary + 1)
  }
  if (bytes.length && bytes[bytes.length - 1] !== 10) {
    const boundary = bytes.lastIndexOf(10)
    bytes = boundary === -1 ? bytes.subarray(bytes.length) : bytes.subarray(0, boundary + 1)
    malformedRecords++
  }
  const entries: DefaultSiteRequest[] = []
  const lines = Buffer.from(bytes).toString('binary').split('\n')
  for (const line of lines) {
    if (!line) continue
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(line, 'binary'))
      const raw = JSON.parse(decoded) as Record<string, unknown>
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.time !== 'string' || raw.time.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(raw.time)
        || typeof raw.host !== 'string' || !raw.host || raw.host.length > 1024 || !raw.host.isWellFormed() || unsafe.test(raw.host)
        || typeof raw.ip !== 'string' || !isIP(raw.ip) || !Number.isInteger(raw.status) || Number(raw.status) < 100 || Number(raw.status) > 599) throw new Error('invalid_record')
      const when = new Date(raw.time)
      if (!Number.isFinite(when.getTime())) throw new Error('invalid_time')
      entries.push({ at: when.toISOString(), host: raw.host, address: raw.ip, status: Number(raw.status) })
    } catch { malformedRecords++ }
  }
  entries.sort((left, right) => right.at.localeCompare(left.at))
  if (entries.length > DEFAULT_SITE_LOG_LIMIT) truncated = true
  return { state: malformedRecords ? 'partial' : 'read', observedAt: at.toISOString(), source: 'nginx-default-access-log', items: entries.slice(0, DEFAULT_SITE_LOG_LIMIT), limit: 100, truncated, malformedRecords }
}

/** The default port is the native provider; injected tails are only trusted test/service ports. */
export async function readDefaultSiteRequests(ports: { readTail?: () => Promise<DefaultSiteLogTail>; now?: () => Date } = {}): Promise<DefaultSiteObservation> {
  const observedAt = (ports.now?.() ?? new Date()).toISOString()
  try { return parseDefaultSiteLogTail(await (ports.readTail ?? readNativeDefaultSiteLogTail)(), observedAt) }
  catch { return { state: 'unavailable', observedAt, source: 'nginx-default-access-log', items: [], limit: 100, truncated: false, malformedRecords: 0, reason: 'default_log_unavailable' } }
}
