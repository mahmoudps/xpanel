import { inflateRawSync } from 'node:zlib'
import { fail } from '@xpanel/core'
import { parseSafeYaml } from '@xpanel/lifecycle'
import type { VendorMetadata } from './svc-waf.ts'
import type { TarEntry } from './tar-entries.ts'

const unchanged = { stateChanged: false }
const refuse = (reason: string): never => fail('VALIDATION', 'the vendor metadata is not in the supported format', { ...unchanged, reason })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const plain = (value: unknown, max: number): string | null => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : null
const https = (value: unknown): string | null => typeof value === 'string' && value.length <= 512 && URL.canParse(value) && new URL(value).protocol === 'https:' ? value : null
const newerFirst = (a: string, b: string): number => {
  const left = a.split('.').map(Number), right = b.split('.').map(Number)
  for (let at = 0; at < Math.max(left.length, right.length); at++) if ((left[at] ?? 0) !== (right[at] ?? 0)) return (right[at] ?? 0) - (left[at] ?? 0)
  return 0
}

/**
 * A cPanel vendor file, meta_<vendor_id>.yaml: attributes plus one release per ModSecurity version, each with its .zip
 * URL, MD5 and SHA512. The newest listed release is read, because the rule checks and the web server test decide
 * whether its rules load here. SHA512 is required: MD5 is no pin, and FIPS hosts refuse to compute it.
 */
export function parseCpanelVendorMetadata(text: string, url: string): VendorMetadata {
  const directory = /\/meta_([A-Za-z0-9_-]{1,64})\.yaml$/.exec(new URL(url).pathname)?.[1]
  if (!directory) return refuse('vendor_metadata_name')
  let raw: unknown
  try { raw = parseSafeYaml(text) } catch { return refuse('vendor_metadata_yaml') }
  if (!object(raw) || !object(raw.attributes)) return refuse('vendor_metadata_format')
  const version = Object.keys(raw).filter(key => /^\d{1,6}(?:\.\d{1,6}){0,3}$/.test(key)).sort(newerFirst)[0], release = version === undefined ? null : raw[version]
  const name = plain(raw.attributes.name, 128), description = plain(raw.attributes.description ?? '', 512), docsUrl = https(raw.attributes.vendor_url)
  if (!object(release) || !name?.trim() || description === null) return refuse('vendor_metadata_format')
  const archiveUrl = https(release.url), digest = release.SHA512
  if (!archiveUrl || !new URL(archiveUrl).pathname.endsWith('.zip')) return refuse('vendor_metadata_format')
  if (typeof digest !== 'string' || !/^[0-9a-fA-F]{128}$/.test(digest)) return refuse('vendor_digest_missing')
  return { id: directory.toLowerCase(), name, description, docsUrl, version: plain(release.distribution, 32)?.trim() || version!, archiveUrl, archiveSha256: null, archiveSha512: digest.toLowerCase(), archiveDirectory: directory }
}

const END = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50
/** The entries of an in-memory zip, in the shape of a tar walk. A symbolic link arrives as type 2, so no caller writes it; zip64 and multi-disk archives are refused. */
export function* zipEntries(zip: Buffer, maxBytes: number, stop: (reason: string) => never): Generator<TarEntry> {
  let end = -1
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 65_557) && end < 0; at--) if (zip.readUInt32LE(at) === END) end = at
  if (end < 0 || zip.readUInt16LE(end + 4) !== 0 || zip.readUInt16LE(end + 10) === 0xffff) return stop('archive_unreadable')
  let at = zip.readUInt32LE(end + 16), total = 0
  for (let index = zip.readUInt16LE(end + 10); index > 0; index--) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== CENTRAL) return stop('archive_truncated')
    const flags = zip.readUInt16LE(at + 8), method = zip.readUInt16LE(at + 10), packed = zip.readUInt32LE(at + 20), size = zip.readUInt32LE(at + 24)
    const nameBytes = zip.readUInt16LE(at + 28), extra = zip.readUInt16LE(at + 30), comment = zip.readUInt16LE(at + 32), mode = zip.readUInt32LE(at + 38) >>> 16, local = zip.readUInt32LE(at + 42)
    if (at + 46 + nameBytes > zip.length) return stop('archive_truncated')
    const path = zip.toString('utf8', at + 46, at + 46 + nameBytes)
    at += 46 + nameBytes + extra + comment
    if (path.split(/[/\\]/).includes('..') || path.startsWith('/')) return stop('archive_path_refused')
    if (path.endsWith('/')) { yield { path, type: '5', data: Buffer.alloc(0) }; continue }
    if ((mode & 0o170000) === 0o120000) { yield { path, type: '2', data: Buffer.alloc(0) }; continue }
    if (flags & 1) return stop('archive_encrypted')
    if (method !== 0 && method !== 8) return stop('archive_method')
    if ((total += size) > maxBytes) return stop('archive_too_large')
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== LOCAL) return stop('archive_truncated')
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28), body = zip.subarray(start, start + packed)
    if (body.length !== packed) return stop('archive_truncated')
    let data: Buffer
    try { data = method === 0 ? body : inflateRawSync(body, { maxOutputLength: size }) } catch { return stop('archive_unreadable') }
    if (data.length !== size) return stop('archive_truncated')
    yield { path, type: '0', data }
  }
}
