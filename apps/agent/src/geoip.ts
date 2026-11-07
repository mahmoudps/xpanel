import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { isIPv4, isIPv6 } from 'node:net'
import { posix } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { readJsonIfExists } from '@xpanel/state'

// DB-IP "IP to Country Lite": CC BY 4.0, monthly, MaxMind DB format (docs/decisions/2026-11-07-web-statistics.md).
export const GEOIP_SOURCE = 'DB-IP IP to Country Lite'
export const geoipUrl = (month: string): string => `https://download.db-ip.com/free/dbip-country-lite-${month}.mmdb.gz`
export const GEOIP_MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024
export const GEOIP_MAX_DATABASE_BYTES = 48 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 120_000
const METADATA_MARKER = Buffer.from([0xab, 0xcd, 0xef, ...Buffer.from('MaxMind.com')])

export interface GeoipStatus { installed: boolean; month: string | null; sha256: string | null; installedAt: string | null }
export interface GeoipMetadata { databaseType: string; ipVersion: number; recordSize: number; nodeCount: number; buildEpoch: number }

/** MaxMind DB data-section decoder. Metadata uses no pointers, so `data` is null there and a pointer is refused. */
const decode = (buf: Buffer, at: number, data: number | null, depth = 0): [unknown, number] => {
  if (depth > 8 || at >= buf.length) throw new Error('truncated')
  const control = buf[at++]!
  let type = control >> 5
  if (type === 1) {
    if (data === null) throw new Error('unsupported metadata type')
    const bytes = ((control >> 3) & 3) + 1, low = control & 7, value = buf.readUIntBE(at, bytes)
    const offset = bytes === 1 ? low * 256 + value : bytes === 2 ? 2048 + low * 65536 + value : bytes === 3 ? 526336 + low * 16777216 + value : value
    return [decode(buf, data + offset, data, depth + 1)[0], at + bytes]
  }
  if (type === 0) type = 7 + buf[at++]!
  let size = control & 0x1f
  if (size === 29) size = 29 + buf[at++]!
  else if (size === 30) { size = 285 + buf.readUInt16BE(at); at += 2 }
  else if (size === 31) { size = 65821 + buf.readUIntBE(at, 3); at += 3 }
  const uint = (): [number, number] => { if (size > 8) throw new Error('integer too large'); let n = 0; for (let i = 0; i < size; i++) n = n * 256 + buf[at + i]!; return [n, at + size] }
  switch (type) {
    case 2: return [buf.toString('utf8', at, at + size), at + size]
    case 3: return [buf.readDoubleBE(at), at + 8]
    case 4: return [buf.subarray(at, at + size), at + size]
    case 5: case 6: case 9: case 10: return uint()
    case 8: return [size ? buf.readIntBE(at, size) : 0, at + size]
    case 14: return [size !== 0, at]
    case 15: return [buf.readFloatBE(at), at + 4]
    case 7: { const map: Record<string, unknown> = {}; for (let i = 0; i < size; i++) { const [k, a] = decode(buf, at, data, depth + 1); const [v, b] = decode(buf, a, data, depth + 1); map[String(k)] = v; at = b } return [map, at] }
    case 11: { const list: unknown[] = []; for (let i = 0; i < size; i++) { const [v, a] = decode(buf, at, data, depth + 1); list.push(v); at = a } return [list, at] }
    default: throw new Error('unsupported metadata type')
  }
}

/** Checks a downloaded database is a complete MaxMind DB country database before it replaces the installed one. */
export function readGeoipMetadata(db: Buffer): GeoipMetadata {
  const marker = db.lastIndexOf(METADATA_MARKER)
  if (marker < 0 || db.length - marker > 128 * 1024) throw new Error('metadata marker missing')
  const [raw] = decode(db, marker + METADATA_MARKER.length, null)
  const m = raw as Record<string, unknown>
  const databaseType = m.database_type, ipVersion = m.ip_version, recordSize = m.record_size, nodeCount = m.node_count, buildEpoch = m.build_epoch
  if (typeof databaseType !== 'string' || !/country/i.test(databaseType) || (ipVersion !== 4 && ipVersion !== 6) || ![24, 28, 32].includes(recordSize as number)
    || typeof nodeCount !== 'number' || !Number.isSafeInteger(nodeCount) || nodeCount < 1 || typeof buildEpoch !== 'number' || buildEpoch < 1) throw new Error('metadata is not a country database')
  // Search tree, then a 16-byte zero separator, then the data section before the metadata.
  if (nodeCount * (recordSize as number) / 4 + 16 > marker) throw new Error('search tree is truncated')
  return { databaseType, ipVersion, recordSize: recordSize as number, nodeCount, buildEpoch }
}

const addressBytes = (ip: string): number[] | null => {
  if (isIPv4(ip)) return ip.split('.').map(Number)
  if (!isIPv6(ip)) return null
  const words = (part: string | undefined): number[] => part ? part.split(':').flatMap(word => { if (!word.includes('.')) return [parseInt(word, 16)]; const [a, b, c, d] = word.split('.').map(Number); return [a! * 256 + b!, c! * 256 + d!] }) : []
  const [head, tail] = ip.split('%')[0]!.split('::'), start = words(head), end = words(tail)
  return [...start, ...Array<number>(8 - start.length - end.length).fill(0), ...end].flatMap(word => [word >> 8, word & 255])
}

/** ISO country of one address in a MaxMind DB country database; null when the database has no entry for it. */
export function lookupGeoipCountry(db: Buffer, ip: string): string | null {
  const bytes = addressBytes(ip)
  if (!bytes) return null
  const { ipVersion, recordSize, nodeCount } = readGeoipMetadata(db), treeBytes = nodeCount * recordSize / 4
  const record = (node: number, right: number): number => {
    const base = node * recordSize / 4
    if (recordSize === 24) return db.readUIntBE(base + right * 3, 3)
    if (recordSize === 32) return db.readUInt32BE(base + right * 4)
    // 28 bits: the middle byte carries the high nibble of each record.
    const middle = db[base + 3]!
    return (right ? middle & 15 : middle >> 4) * 16777216 + db.readUIntBE(base + right * 4, 3)
  }
  if (ipVersion === 4 && bytes.length === 16) return null
  let node = 0
  // An IPv4 address sits under 96 zero bits of an IPv6 tree.
  if (ipVersion === 6 && bytes.length === 4) for (let i = 0; i < 96 && node < nodeCount; i++) node = record(node, 0)
  for (let bit = 0; bit < bytes.length * 8 && node < nodeCount; bit++) node = record(node, (bytes[bit >> 3]! >> (7 - (bit & 7))) & 1)
  if (node <= nodeCount) return null
  const data = treeBytes + 16, [value] = decode(db, data + node - nodeCount - 16, data)
  const country = (value as Record<string, unknown> | null)?.country as Record<string, unknown> | undefined
  return typeof country?.iso_code === 'string' && /^[A-Z]{2}$/.test(country.iso_code) ? country.iso_code : null
}

export interface GeoipOptions {
  dir: string
  fetch?: typeof fetch
  admit?: <T>(work: () => Promise<T>) => Promise<T>
}

/** Installed database path and its monthly refresh from the publisher; a failed refresh keeps the installed copy. */
export function createGeoipSource(options: GeoipOptions) {
  const database = posix.join(options.dir, 'dbip-country-lite.mmdb'), meta = posix.join(options.dir, 'source.json')
  const admit = options.admit ?? (<T>(work: () => Promise<T>) => work())
  const status = async (): Promise<GeoipStatus> => {
    const raw = await readJsonIfExists<Record<string, unknown>>(meta).catch(() => null)
    return raw && typeof raw.month === 'string' && /^\d{4}-\d{2}$/.test(raw.month) && typeof raw.sha256 === 'string' && typeof raw.installedAt === 'string'
      ? { installed: true, month: raw.month, sha256: raw.sha256, installedAt: raw.installedAt } : { installed: false, month: null, sha256: null, installedAt: null }
  }
  const download = async (month: string): Promise<Buffer | null> => {
    const response = await (options.fetch ?? fetch)(geoipUrl(month), { redirect: 'error', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    if (response.status === 404) return null
    if (!response.ok || !response.body) throw new Error('download failed with HTTP ' + response.status)
    const parts: Buffer[] = []
    let total = 0
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength
      if (total > GEOIP_MAX_DOWNLOAD_BYTES) throw new Error('download exceeds its size limit')
      parts.push(Buffer.from(chunk))
    }
    return gunzipSync(Buffer.concat(parts), { maxOutputLength: GEOIP_MAX_DATABASE_BYTES })
  }
  return {
    path: database,
    status,
    read: () => readFile(database).catch(() => null),
    lookup: lookupGeoipCountry,
    metadata: readGeoipMetadata,
    /** ISO country per address; the file is read for this call only, so nothing stays in memory between views. */
    async countries(ips: readonly string[]): Promise<Map<string, string>> {
      const db = await readFile(database).catch(() => null), found = new Map<string, string>()
      if (db) for (const ip of ips) { const country = lookupGeoipCountry(db, ip); if (country) found.set(ip, country) }
      return found
    },
    /** Installs this month's release (or last month's before it is published) unless it is already installed. */
    async refresh(now: Date): Promise<GeoipStatus> {
      const current = await status()
      const month = now.toISOString().slice(0, 7), previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7)
      if (current.month === month) return current
      let chosen = month, db = await download(month)
      if (!db && current.month !== previous) { chosen = previous; db = await download(previous) }
      if (!db) return current
      readGeoipMetadata(db)
      const sha256 = createHash('sha256').update(db).digest('hex')
      await admit(async () => {
        await mkdir(options.dir, { recursive: true, mode: 0o755 })
        const temporary = database + '.tmp'
        await rm(temporary, { force: true })
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644)
        try { await handle.writeFile(db); await handle.sync() } finally { await handle.close() }
        await rename(temporary, database)
        const metaTemporary = meta + '.tmp'
        await rm(metaTemporary, { force: true })
        const metaHandle = await open(metaTemporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644)
        try { await metaHandle.writeFile(JSON.stringify({ source: GEOIP_SOURCE, url: geoipUrl(chosen), month: chosen, sha256, installedAt: now.toISOString() })); await metaHandle.sync() } finally { await metaHandle.close() }
        await rename(metaTemporary, meta)
      })
      return { installed: true, month: chosen, sha256, installedAt: now.toISOString() }
    },
  }
}
export type GeoipSource = ReturnType<typeof createGeoipSource>
