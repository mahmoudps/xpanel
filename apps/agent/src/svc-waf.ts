import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { readdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { fail } from '@xpanel/core'
import { edge } from '@xpanel/render'
import { isPublicAddress } from '../../../packages/os/src/network-tools-command.ts'
import { isVendorId } from './svc-policy.ts'
import { parseCpanelVendorMetadata, zipEntries } from './svc-waf-cpanel.ts'
import { tarEntries } from './tar-entries.ts'
import type { TarEntry } from './tar-entries.ts'
import type { SvcWafRulesPolicy, SvcWafVendor, SvcWafVendorsPolicy } from './svc-policy.ts'

const unchanged = { stateChanged: false }
const METADATA_BYTES = 64 * 1024
const ARCHIVE_BYTES = 32 * 1024 * 1024
const UNPACKED_BYTES = 128 * 1024 * 1024
const VENDOR_FILES = 512
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const HITS_WINDOW = 512 * 1024
const HITS_KEPT = 200

export interface WafHit { at: string | null; clientIp: string | null; host: string | null; method: string | null; uri: string | null; ruleId: number | null; message: string | null; severity: string | null; disruptive: boolean }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const textOf = (value: unknown, max: number): string | null => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : null

/** Serial JSON audit log, one transaction per line; the most relevant message of each stands for the request. A torn first line is skipped. */
export function parseModsecAuditLog(text: string): WafHit[] {
  const hits: WafHit[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    let entry: unknown
    try { entry = JSON.parse(line) } catch { continue }
    const transaction = object(entry) && object(entry.transaction) ? entry.transaction : null
    const messages = transaction && Array.isArray(transaction.messages) ? transaction.messages.filter(object) : []
    if (!transaction || !messages.length) continue
    const details = messages.map(item => object(item.details) ? item.details : {})
    // libmodsecurity severities count down from 0 (emergency); the lowest number is the most relevant.
    const best = details.reduce((left, right) => Number(right.severity ?? 9) < Number(left.severity ?? 9) ? right : left, details[0]!)
    const request = object(transaction.request) ? transaction.request : {}
    const headers = object(request.headers) ? request.headers : {}
    const id = typeof best.ruleId === 'string' && /^\d{1,9}$/.test(best.ruleId) ? Number(best.ruleId) : null
    hits.push({ at: textOf(transaction.time_stamp, 64), clientIp: textOf(transaction.client_ip, 45), host: textOf(headers.Host ?? headers.host, 253), method: textOf(request.method, 16), uri: textOf(request.uri, 512), ruleId: id, message: textOf(messages[details.indexOf(best)]?.message, 512),
      severity: textOf(best.severity, 8), disruptive: object(transaction.response) && Number(transaction.response.http_code) >= 400 })
  }
  return hits.slice(-HITS_KEPT).reverse()
}

export async function readModsecHits(path = edge.MODSEC_AUDIT_LOG): Promise<{ state: 'read' | 'empty'; hits: WafHit[] }> {
  let handle
  try { handle = await open(path, 'r') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'empty', hits: [] }; throw error }
  try {
    const { size } = await handle.stat(), length = Math.min(size, HITS_WINDOW), buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    return { state: 'read', hits: parseModsecAuditLog(buffer.toString('utf8')) }
  } finally { await handle.close() }
}

export type ListRuleFiles = (directory: string) => Promise<string[]>
export const listRuleFiles: ListRuleFiles = async directory => {
  try { return (await readdir(directory)).filter(name => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.conf$/.test(name)).sort() } catch { return [] }
}

/** Reconcile input for renderModsecurityMain: deployed rules, vendor includes and the CRS file selection. */
export async function svcWafInput(rules: SvcWafRulesPolicy, vendors: SvcWafVendorsPolicy, crsDir: string | null, list: ListRuleFiles = listRuleFiles): Promise<Pick<edge.ModsecuritySettings, 'ruleEngine' | 'crsFiles' | 'vendorFiles' | 'customRules'>> {
  const crsFiles = crsDir && vendors.crsDisabledFiles.length ? (await list(join(crsDir, 'rules'))).filter(name => !vendors.crsDisabledFiles.includes(name)) : null
  const vendorFiles: { vendor: string; file: string }[] = []
  for (const vendor of vendors.vendors) if (vendor.enabled) vendorFiles.push(...(await list(`${edge.modsecVendorDir}/${vendor.id}`)).filter(name => !vendor.disabledFiles.includes(name)).map(file => ({ vendor: vendor.id, file })))
  const customRules = rules.deployed.filter(rule => rule.enabled).map(rule => rule.text)
  return { ...(rules.deployedEngine === 'inherit' ? {} : { ruleEngine: rules.deployedEngine }), ...(crsFiles ? { crsFiles } : {}), ...(vendorFiles.length ? { vendorFiles } : {}), ...(customRules.length ? { customRules } : {}) }
}

/** One of the two digests pins the archive. archiveDirectory is the single top directory a cPanel archive must hold. */
export interface VendorMetadata { id: string; name: string; description: string; docsUrl: string | null; version: string; archiveUrl: string; archiveSha256: string | null; archiveSha512: string | null; archiveDirectory: string | null }
const https = (value: unknown): string | null => typeof value === 'string' && value.length <= 512 && URL.canParse(value) && new URL(value).protocol === 'https:' ? value : null

/** The vendor metadata document this panel reads: JSON naming one pinned archive. */
export function parseVendorMetadata(raw: unknown): VendorMetadata {
  const bad = (): never => fail('VALIDATION', 'the vendor metadata is not in the supported format', unchanged)
  if (!object(raw) || raw.format !== 'xpanel-waf-vendor/1' || !isVendorId(raw.id)) return bad()
  const name = textOf(raw.name, 128), description = textOf(raw.description ?? '', 512), version = textOf(raw.version, 32), archiveUrl = https(raw.archiveUrl)
  if (!name || description === null || !version || !archiveUrl || typeof raw.archiveSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(raw.archiveSha256) || !(raw.docsUrl === null || raw.docsUrl === undefined || https(raw.docsUrl))) return bad()
  return { id: raw.id, name, description, docsUrl: https(raw.docsUrl), version, archiveUrl, archiveSha256: raw.archiveSha256, archiveSha512: null, archiveDirectory: null }
}

export type VendorFetch = (url: string, maxBytes: number) => Promise<Buffer>
/** HTTPS only, no redirects, public addresses only: this request runs as root on behalf of a saved URL. */
export const vendorFetch: VendorFetch = async (url, maxBytes) => {
  const target = https(url) ? new URL(url) : fail('VALIDATION', 'an https URL is required', unchanged)
  const addresses = await lookup(target.hostname, { all: true }).catch(() => [])
  if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) return fail('PRECONDITION_FAILED', 'the vendor address is not a public address', { ...unchanged, reason: 'vendor_address_refused' })
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) }).catch(() => fail('SERVICE_UNAVAILABLE', 'the vendor could not be reached', { ...unchanged, reason: 'vendor_unreachable' }))
  if (!response.ok || !response.body) return fail('SERVICE_UNAVAILABLE', 'the vendor refused the download', { ...unchanged, reason: 'vendor_refused' })
  const chunks: Uint8Array[] = []; let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.byteLength
    if (bytes > maxBytes) return fail('VALIDATION', 'the vendor file is too large', { ...unchanged, reason: 'vendor_too_large' })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** A cPanel meta_<vendor>.yaml file or the panel's JSON document, told apart by the metadata path. */
export const fetchVendorMetadata = async (url: string, get: VendorFetch = vendorFetch): Promise<VendorMetadata> => {
  const text = (await get(url, METADATA_BYTES)).toString('utf8')
  if (new URL(url).pathname.endsWith('.yaml')) return parseCpanelVendorMetadata(text, url)
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return fail('VALIDATION', 'the vendor metadata is not valid JSON', unchanged) }
  return parseVendorMetadata(raw)
}

/** Regular files of a gzip tar or zip; links, devices and traversal never reach the host, and only rule and data files are kept, flattened by name. */
export function extractVendorArchive(archive: Buffer, directory: string | null = null): Map<string, Buffer> {
  const refuse = (reason: string): never => fail('VALIDATION', 'the vendor archive cannot be used', { ...unchanged, reason })
  const entries = (): Generator<TarEntry> => {
    if (archive.subarray(0, 4).equals(ZIP)) return zipEntries(archive, UNPACKED_BYTES, refuse)
    try { return tarEntries(gunzipSync(archive, { maxOutputLength: UNPACKED_BYTES }), refuse) } catch { return refuse('archive_unreadable') }
  }
  const files = new Map<string, Buffer>()
  for (const { path, type, data } of entries()) {
    if (directory !== null && !path.startsWith(directory + '/')) return refuse('archive_layout')
    const base = path.split('/').pop() ?? ''
    if ((type === '0' || type === '\0') && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:conf|data)$/.test(base)) {
      if (files.has(base)) return refuse('archive_duplicate_file')
      if (files.size >= VENDOR_FILES) return refuse('archive_too_many_files')
      files.set(base, Buffer.from(data))
    }
  }
  if (![...files.keys()].some(name => name.endsWith('.conf'))) return refuse('archive_has_no_rules')
  for (const [name, bytes] of files) if (name.endsWith('.conf')) {
    const problem = edge.modsecRuleProblem(bytes.toString('utf8'))
    if (problem) return fail('VALIDATION', 'a vendor rule file cannot be loaded', { ...unchanged, reason: problem, file: name })
  }
  return files
}

export interface VendorHost { writeFile: (file: { path: string; content: string; mode: number; owner: string; group: string }) => Promise<void>; removePath: (path: string) => Promise<void> }
export interface InstalledVendor { vendor: Omit<SvcWafVendor, 'enabled' | 'autoUpdate' | 'disabledFiles'>; archiveSha512: string; files: string[] }
/** Download, check the pinned digest, validate every rule file, then write. Nothing is written until the whole archive passed. */
export async function installVendor(url: string, host: VendorHost, get: VendorFetch = vendorFetch): Promise<InstalledVendor> {
  const metadata = await fetchVendorMetadata(url, get)
  const archive = await get(metadata.archiveUrl, ARCHIVE_BYTES)
  const archiveSha256 = createHash('sha256').update(archive).digest('hex'), archiveSha512 = createHash('sha512').update(archive).digest('hex')
  if (metadata.archiveSha256 !== null ? archiveSha256 !== metadata.archiveSha256 : archiveSha512 !== metadata.archiveSha512) return fail('VALIDATION', 'the vendor archive does not match its pinned digest', { ...unchanged, reason: 'archive_digest_mismatch' })
  const files = extractVendorArchive(archive, metadata.archiveDirectory), directory = `${edge.modsecVendorDir}/${metadata.id}`
  await host.removePath(directory).catch(() => {})
  for (const [name, bytes] of files) await host.writeFile({ path: `${directory}/${name}`, content: bytes.toString('utf8'), mode: 0o644, owner: 'root', group: 'root' })
  return { vendor: { id: metadata.id, name: metadata.name, description: metadata.description, docsUrl: metadata.docsUrl, metadataUrl: url, archiveSha256, version: metadata.version }, archiveSha512, files: [...files.keys()].filter(name => name.endsWith('.conf')).sort() }
}

/** What is on disk per vendor, kept by the agent: nightly updates change it without touching the policy file the API owns. */
export const WAF_VENDOR_INSTALLED_PATH = '/var/lib/xpanel/svc/waf-vendors-installed.json'
export type InstalledVendors = Record<string, { version: string; archiveSha256: string; archiveSha512?: string }>
/** The metadata still pins what is on disk: the nightly update downloads nothing then. */
export const vendorUnchanged = (metadata: VendorMetadata, installed: { archiveSha256: string; archiveSha512?: string }): boolean => metadata.archiveSha256 !== null ? metadata.archiveSha256 === installed.archiveSha256 : metadata.archiveSha512 === installed.archiveSha512
export const parseInstalledVendors = (raw: unknown): InstalledVendors => Object.fromEntries(Object.entries(object(raw) ? raw : {}).filter(([id, item]) => isVendorId(id) && object(item) && typeof item.version === 'string' && typeof item.archiveSha256 === 'string')) as InstalledVendors
export async function recordInstalledVendor(item: InstalledVendor, store: { read: () => Promise<unknown>; write: (value: InstalledVendors) => Promise<void> }): Promise<void> {
  await store.write({ ...parseInstalledVendors(await store.read()), [item.vendor.id]: { version: item.vendor.version, archiveSha256: item.vendor.archiveSha256, archiveSha512: item.archiveSha512 } })
}
