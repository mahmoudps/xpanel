import { X509Certificate } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { dirname, join } from 'node:path'
import { fail } from '@xpanel/core'
import { services } from '@xpanel/render'
import { readHostServices } from './host-services.ts'
import type { HostServiceStatus } from './host-services.ts'
import { withPinnedHostTargetParent } from './host-target-parent.ts'
import { DEFAULT_DNS_ZONE_DIR } from './services/dns.ts'
import { DEFAULT_PURE_FTPD_CONF_DIR, renderPureFtpdDaemonConfigs } from './services/ftp.ts'
import { PDNS_RPING_ARGV, PDNS_VERSION_ARGV, isServiceDetailZone, pdnsCheckZoneArgv } from '../../../packages/os/src/service-detail-command.ts'

export interface ServiceDetailCommandResult { ok: boolean; code: number; stdout: string; stderr: string }
export type ServiceDetailRun = (argv: string[]) => Promise<ServiceDetailCommandResult>
export type HostPathKind = 'file' | 'symlink' | 'directory' | 'other' | 'missing'
export interface HostPathInfo { kind: HostPathKind; sizeBytes: number }
export interface DirectoryListing { state: 'read' | 'missing'; entries: ({ name: string } & HostPathInfo)[]; truncated: boolean }
export interface ServiceDetailHost {
  run: ServiceDetailRun
  /** The executor's reviewed reader: regular files only, never through a symlink. */
  readFile: (path: string) => Promise<string | null>
  stat: (path: string) => Promise<HostPathInfo>
  listDirectory: (dir: string, maxEntries: number) => Promise<DirectoryListing>
}
export interface ServiceDetailState {
  zones: readonly { name: string; serial: number }[]
  serviceUsers: readonly { services: { ftp: boolean } }[]
  server: { settings: { hostname: string } } | null
}

export type ZoneFileState = 'parsed' | 'missing' | 'malformed' | 'too-large' | 'not-regular' | 'unreadable' | 'not-read'
export interface DnsZoneRow { zone: string; desired: boolean | null; stateSerial: number | null; file: ZoneFileState; fileSerial: number | null; sizeBytes: number | null }
export interface DnsServiceDetail {
  kind: 'dns'
  observedAt: string
  service: HostServiceStatus | null
  control: { state: 'reachable' | 'unreachable' | 'unavailable'; version: string | null }
  zoneDir: string
  directory: 'read' | 'missing' | 'unavailable'
  savedState: 'read' | 'unavailable'
  otherEntries: number
  truncated: boolean
  zones: DnsZoneRow[]
}
export interface DnsZoneCheck { zone: string; observedAt: string; state: 'passed' | 'failed' | 'unavailable'; records: number | null; errors: number | null; warnings: number | null; messages: string[] }
export interface FtpSettingRow { name: string; desired: string; observed: string | null; state: 'match' | 'drift' | 'missing' | 'unreadable' }
export interface FtpServiceDetail { kind: 'ftp'; observedAt: string; service: HostServiceStatus | null; confDir: string; settings: FtpSettingRow[]; ftpAccounts: number | null }
export type CertificateEndpointId = 'panel' | 'postfix' | 'dovecot' | 'pure-ftpd'
export type CertificateReason = 'config_missing' | 'listener_not_found' | 'inconsistent_render' | 'unexpected_path' | 'certificate_missing' | 'too_large' | 'not_pem' | 'unparsable' | 'unreadable'
export type CertificateWarning = 'expired' | 'expiring' | 'not-yet-valid' | 'hostname-not-covered' | 'key-missing'
export interface ServiceCertificate { subject: string; issuer: string; names: string[]; notBefore: string; notAfter: string; daysLeft: number; fingerprint256: string; chainLength: number; coversHostname: boolean | null }
export interface CertificateEndpoint {
  id: CertificateEndpointId
  ports: number[]
  configPath: string | null
  state: 'observed' | 'not-rendered' | 'missing' | 'unavailable'
  reason: CertificateReason | null
  certPath: string | null
  keyPath: string | null
  /** Presence only; key material is never opened. */
  keyPresent: boolean | null
  certificate: ServiceCertificate | null
  warnings: CertificateWarning[]
}
export interface CertificatesServiceDetail { kind: 'certificates'; observedAt: string; hostname: string | null; endpoints: CertificateEndpoint[] }

export const MAX_ZONE_ENTRIES = 5000
export const MAX_ZONE_ROWS = 2000
export const MAX_ZONE_FILE_BYTES = 1024 * 1024
const MAX_ZONE_READ_BYTES = 16 * 1024 * 1024
export const MAX_CERTIFICATE_BYTES = 64 * 1024
const EXPIRY_WARNING_DAYS = 30
/** scripts/management-tls.mjs renders the panel, xWHM and xMail listeners here. */
export const MANAGEMENT_INGRESS_CONF = '/etc/nginx/conf.d/xpanel-management.conf'
const MANAGEMENT_PORTS = [443, 2083, 2087, 2096]
const MANAGEMENT_CERT = /^\/etc\/xpanel\/management-certificates\/([a-f0-9]{64})\/fullchain\.pem$/
const MANAGEMENT_KEY = /^\/etc\/xpanel\/management-certificates\/([a-f0-9]{64})\/privkey\.pem$/
const text = (value: string, max: number): string => value.replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/g, ' ').trim().slice(0, max).toWellFormed()
const missing = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException)?.code))
const kindOf = (info: Stats): HostPathKind => info.isSymbolicLink() ? 'symlink' : info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other'
const serviceRow = (run: ServiceDetailRun, id: string): Promise<HostServiceStatus | null> => readHostServices(run).then(rows => rows.find(row => row.id === id) ?? null, () => null)

/** Lists one directory through a retained descriptor; entries are lstat'ed and never followed. */
export async function listPinnedDirectory(dir: string, maxEntries: number): Promise<DirectoryListing> {
  try {
    return await withPinnedHostTargetParent(join(dir, '.xpanel-listing'), async pinned => {
      const base = dirname(pinned), names = (await readdir(base)).sort(), entries: DirectoryListing['entries'] = []
      for (const name of names.slice(0, maxEntries)) {
        let info: Stats
        try { info = await lstat(join(base, name)) } catch (error) { if (missing(error)) continue; throw error }
        entries.push({ name, kind: kindOf(info), sizeBytes: info.size })
      }
      return { state: 'read' as const, entries, truncated: names.length > maxEntries }
    })
  } catch (error) { if (missing(error)) return { state: 'missing', entries: [], truncated: false }; throw error }
}

/** Production listing: only the configured PowerDNS zone directory. */
export async function listHostDirectory(dir: string, maxEntries: number): Promise<DirectoryListing> {
  return dir === DEFAULT_DNS_ZONE_DIR ? listPinnedDirectory(dir, maxEntries) : fail('FORBIDDEN', 'service detail listing path is not reviewed', { stateChanged: false })
}

/** Production stat: only the management certificate and key file names the TLS lifecycle renders. */
export async function statHostPath(path: string): Promise<HostPathInfo> {
  if (!MANAGEMENT_CERT.test(path) && !MANAGEMENT_KEY.test(path)) return fail('FORBIDDEN', 'service detail stat path is not reviewed', { stateChanged: false })
  try { return await withPinnedHostTargetParent(path, async anchored => { const info = await lstat(anchored); return { kind: kindOf(info), sizeBytes: info.size } }) }
  catch (error) { if (missing(error)) return { kind: 'missing', sizeBytes: 0 }; throw error }
}

/** SOA serial of one zone file through the shared BIND parser; anything it cannot read is null. */
export function zoneFileSerial(content: string, zone: string): number | null {
  try {
    const soa = services.parseBindZone(content, { origin: zone }).records.find(record => record.type === 'SOA' && record.name === '@')
    const serial = Number(soa?.content.split(' ')[2])
    return soa && Number.isSafeInteger(serial) && serial >= 0 && serial <= 4294967295 ? serial : null
  } catch { return null }
}

async function readControl(run: ServiceDetailRun): Promise<DnsServiceDetail['control']> {
  let rping: ServiceDetailCommandResult
  try { rping = await run([...PDNS_RPING_ARGV]) } catch { return { state: 'unavailable', version: null } }
  if (!rping.ok) return { state: 'unreachable', version: null }
  if (rping.stdout.trim() !== 'PONG') return { state: 'unavailable', version: null }
  const version = await run([...PDNS_VERSION_ARGV]).catch(() => null), value = version?.ok ? version.stdout.trim() : ''
  return { state: 'reachable', version: /^\d{1,4}\.\d{1,4}\.\d{1,4}[0-9A-Za-z.+~-]{0,48}$/.test(value) ? value : null }
}

export async function readDnsServiceDetail(input: { host: ServiceDetailHost; readState: () => Promise<ServiceDetailState>; now?: () => Date; zoneDir?: string }): Promise<DnsServiceDetail> {
  const { host } = input, zoneDir = input.zoneDir ?? DEFAULT_DNS_ZONE_DIR, observedAt = (input.now?.() ?? new Date()).toISOString()
  const service = await serviceRow(host.run, 'pdns'), control = await readControl(host.run)
  let desired: Map<string, number> | null = null
  try { desired = new Map((await input.readState()).zones.filter(zone => isServiceDetailZone(zone.name)).map(zone => [zone.name, zone.serial])) } catch { desired = null }
  let listing: DirectoryListing | null = null
  try { listing = await host.listDirectory(zoneDir, MAX_ZONE_ENTRIES) } catch { listing = null }
  const files = new Map<string, DirectoryListing['entries'][number]>()
  let otherEntries = 0
  for (const entry of listing?.entries ?? []) {
    const zone = entry.name.endsWith('.zone') ? entry.name.slice(0, -5) : ''
    if (isServiceDetailZone(zone)) files.set(zone, entry); else otherEntries += 1
  }
  const names = [...new Set([...(desired?.keys() ?? []), ...files.keys()])].sort()
  const zones: DnsZoneRow[] = []
  let budget = MAX_ZONE_READ_BYTES
  for (const zone of names.slice(0, MAX_ZONE_ROWS)) {
    const entry = files.get(zone)
    const row: DnsZoneRow = { zone, desired: desired ? desired.has(zone) : null, stateSerial: desired?.get(zone) ?? null, file: listing ? 'missing' : 'not-read', fileSerial: null, sizeBytes: entry?.sizeBytes ?? null }
    if (entry) {
      if (entry.kind !== 'file') row.file = 'not-regular'
      else if (entry.sizeBytes > MAX_ZONE_FILE_BYTES) row.file = 'too-large'
      else if (entry.sizeBytes > budget) row.file = 'not-read'
      else {
        budget -= entry.sizeBytes
        let content: string | null | undefined
        try { content = await host.readFile(zoneDir + '/' + entry.name) } catch { content = undefined }
        if (content === undefined) row.file = 'unreadable'
        else if (content === null) row.file = 'missing'
        else if (Buffer.byteLength(content) > MAX_ZONE_FILE_BYTES) row.file = 'too-large'
        else { row.fileSerial = zoneFileSerial(content, zone); row.file = row.fileSerial === null ? 'malformed' : 'parsed' }
      }
    }
    zones.push(row)
  }
  return { kind: 'dns', observedAt, service, control, zoneDir, directory: listing ? listing.state : 'unavailable', savedState: desired ? 'read' : 'unavailable',
    otherEntries, truncated: (listing?.truncated ?? false) || names.length > MAX_ZONE_ROWS, zones }
}

// pdnsutil(1) check-zone ends with "Checked N records of 'ZONE', E errors, W warnings." and exits non-zero when errors were found.
const CHECK_SUMMARY = /^Checked (\d{1,9}) records of '([^'\n]{1,254})', (\d{1,9}) errors, (\d{1,9}) warnings\.$/m

export async function checkDnsZone(input: { run: ServiceDetailRun; zone: string; now?: () => Date }): Promise<DnsZoneCheck> {
  const { zone } = input, observedAt = (input.now?.() ?? new Date()).toISOString()
  let result: ServiceDetailCommandResult | null
  try { result = await input.run(pdnsCheckZoneArgv(zone)) } catch { result = null }
  const output = result ? `${result.stdout}\n${result.stderr}` : '', summary = CHECK_SUMMARY.exec(output)
  const messages = output.split('\n').filter(line => /^\[(?:Error|Warning)\]/.test(line)).slice(0, 50).map(line => text(line, 300))
  if (!result || !summary || summary[2]!.replace(/\.$/, '') !== zone) return { zone, observedAt, state: 'unavailable', records: null, errors: null, warnings: null, messages }
  const [records, errors, warnings] = [summary[1], summary[3], summary[4]].map(Number) as [number, number, number]
  const state = result.ok && errors === 0 ? 'passed' : !result.ok && errors > 0 ? 'failed' : 'unavailable'
  return state === 'unavailable' ? { zone, observedAt, state, records: null, errors: null, warnings: null, messages } : { zone, observedAt, state, records, errors, warnings, messages }
}

export async function readFtpServiceDetail(input: { host: ServiceDetailHost; readState: () => Promise<ServiceDetailState>; now?: () => Date }): Promise<FtpServiceDetail> {
  const { host } = input, observedAt = (input.now?.() ?? new Date()).toISOString()
  const service = await serviceRow(host.run, 'pure-ftpd'), settings: FtpSettingRow[] = []
  for (const file of renderPureFtpdDaemonConfigs({})) {
    const name = file.path.slice(file.path.lastIndexOf('/') + 1), desired = file.content.trim()
    let content: string | null | undefined
    try { content = await host.readFile(file.path) } catch { content = undefined }
    const observed = typeof content === 'string' ? text(content, 256) : null
    settings.push({ name, desired, observed, state: content === undefined ? 'unreadable' : observed === null ? 'missing' : observed === desired ? 'match' : 'drift' })
  }
  let ftpAccounts: number | null = null
  try { ftpAccounts = (await input.readState()).serviceUsers.filter(user => user.services.ftp === true).length } catch { ftpAccounts = null }
  return { kind: 'ftp', observedAt, service, confDir: DEFAULT_PURE_FTPD_CONF_DIR, settings, ftpAccounts }
}

/** nginx server blocks that listen on `port`, with their ssl_certificate and ssl_certificate_key paths. */
export function listenerTlsPaths(config: string, port: number): { cert: string | null; key: string | null }[] {
  const found: { cert: string | null; key: string | null }[] = [], opener = /\bserver\s*\{/g, listen = new RegExp(`\\blisten\\s+[^;]*\\b${port}\\b[^;]*;`, 'i')
  for (let match = opener.exec(config); match; match = opener.exec(config)) {
    let depth = 1, index = match.index + match[0].length
    const start = index
    while (index < config.length && depth > 0) { const char = config[index]; if (char === '{') depth += 1; else if (char === '}') depth -= 1; index += 1 }
    const block = config.slice(start, index - 1)
    opener.lastIndex = index
    if (!listen.test(block)) continue
    const path = (name: string): string | null => new RegExp(`(?:^|[^\\w-])${name}\\s+(['"]?)([^'";\\s]+)\\1\\s*;`).exec(block)?.[2] ?? null
    found.push({ cert: path('ssl_certificate'), key: path('ssl_certificate_key') })
  }
  return found
}

/** Leaf certificate facts only; the PEM itself is not returned. */
export function parseServiceCertificate(pem: string, hostname: string | null, now: Date): ServiceCertificate | null {
  let chain: string
  try { chain = services.assertFullchainPem(pem) } catch { return null }
  const blocks = chain.split(/(?<=-----END CERTIFICATE-----)\r?\n?/).filter(block => block.trim() !== '')
  let leaf: X509Certificate
  try { leaf = new X509Certificate(blocks[0]!) } catch { return null }
  const notBefore = Date.parse(leaf.validFrom), notAfter = Date.parse(leaf.validTo)
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter)) return null
  const names = (leaf.subjectAltName ?? '').split(',').map(part => part.trim()).flatMap(part => part.startsWith('DNS:') ? [part.slice(4)] : part.startsWith('IP Address:') ? [part.slice(11)] : [])
    .map(name => text(name, 253)).filter(Boolean).slice(0, 100)
  return { subject: text(leaf.subject.replace(/\n/g, ', '), 512), issuer: text(leaf.issuer.replace(/\n/g, ', '), 512), names,
    notBefore: new Date(notBefore).toISOString(), notAfter: new Date(notAfter).toISOString(), daysLeft: Math.floor((notAfter - now.getTime()) / 86_400_000),
    fingerprint256: leaf.fingerprint256, chainLength: blocks.length, coversHostname: hostname ? services.coversHost(names, hostname) : null }
}

const warningsFor = (certificate: ServiceCertificate | null, keyPresent: boolean | null, now: Date): CertificateWarning[] => {
  if (!certificate) return keyPresent === false ? ['key-missing'] : []
  const warnings: CertificateWarning[] = []
  if (now.getTime() > Date.parse(certificate.notAfter)) warnings.push('expired')
  else if (certificate.daysLeft <= EXPIRY_WARNING_DAYS) warnings.push('expiring')
  if (now.getTime() < Date.parse(certificate.notBefore)) warnings.push('not-yet-valid')
  if (certificate.coversHostname === false) warnings.push('hostname-not-covered')
  if (keyPresent === false) warnings.push('key-missing')
  return warnings
}

async function readPanelEndpoint(host: ServiceDetailHost, hostname: string | null, now: Date): Promise<CertificateEndpoint> {
  const endpoint = (state: CertificateEndpoint['state'], reason: CertificateReason | null, extra: Partial<CertificateEndpoint> = {}): CertificateEndpoint =>
    ({ id: 'panel', ports: [], configPath: MANAGEMENT_INGRESS_CONF, state, reason, certPath: null, keyPath: null, keyPresent: null, certificate: null, warnings: [], ...extra })
  let read: string | null
  try { read = await host.readFile(MANAGEMENT_INGRESS_CONF) } catch { return endpoint('unavailable', 'unreadable') }
  if (read === null) return endpoint('missing', 'config_missing')
  if (read.length > 256 * 1024) return endpoint('unavailable', 'too_large')
  const config = read
  const ports = MANAGEMENT_PORTS.filter(port => listenerTlsPaths(config, port).some(found => found.cert))
  const pairs = new Set(MANAGEMENT_PORTS.flatMap(port => listenerTlsPaths(config, port)).filter(found => found.cert).map(found => `${found.cert}\n${found.key}`))
  if (pairs.size === 0) return endpoint('unavailable', 'listener_not_found')
  if (pairs.size > 1) return endpoint('unavailable', 'inconsistent_render', { ports })
  const [certPath, keyPath] = [...pairs][0]!.split('\n') as [string, string]
  const generation = MANAGEMENT_CERT.exec(certPath)?.[1]
  if (!generation || MANAGEMENT_KEY.exec(keyPath)?.[1] !== generation) return endpoint('unavailable', 'unexpected_path', { ports })
  let keyPresent: boolean | null = null
  try { const key = await host.stat(keyPath); keyPresent = key.kind === 'file' ? true : key.kind === 'missing' ? false : null } catch { keyPresent = null }
  const located = { ports, certPath, keyPath, keyPresent }
  let pem: string | null
  try {
    const info = await host.stat(certPath)
    if (info.kind === 'missing') return endpoint('missing', 'certificate_missing', { ...located, warnings: warningsFor(null, keyPresent, now) })
    if (info.kind !== 'file') return endpoint('unavailable', 'unreadable', located)
    if (info.sizeBytes > MAX_CERTIFICATE_BYTES) return endpoint('unavailable', 'too_large', located)
    pem = await host.readFile(certPath)
  } catch { return endpoint('unavailable', 'unreadable', located) }
  if (pem === null) return endpoint('missing', 'certificate_missing', { ...located, warnings: warningsFor(null, keyPresent, now) })
  // shortcut: the size is checked by lstat before the executor reads the whole file; a file grown in between is refused here.
  if (Buffer.byteLength(pem) > MAX_CERTIFICATE_BYTES) return endpoint('unavailable', 'too_large', located)
  if (/PRIVATE KEY/.test(pem)) return endpoint('unavailable', 'not_pem', located)
  const certificate = parseServiceCertificate(pem, hostname, now)
  if (!certificate) return endpoint('unavailable', /^\s*-----BEGIN CERTIFICATE-----/.test(pem) ? 'unparsable' : 'not_pem', located)
  return endpoint('observed', null, { ...located, certificate, warnings: warningsFor(certificate, keyPresent, now) })
}

/** xPanel renders TLS only for the management listeners. Mail and FTP daemons keep their distribution settings, which are not read here. */
export async function readCertificatesServiceDetail(input: { host: ServiceDetailHost; readState: () => Promise<ServiceDetailState>; now?: () => Date }): Promise<CertificatesServiceDetail> {
  const now = input.now?.() ?? new Date()
  let hostname: string | null = null
  try { hostname = (await input.readState()).server?.settings.hostname ?? null } catch { hostname = null }
  const notRendered = (id: CertificateEndpointId): CertificateEndpoint => ({ id, ports: [], configPath: null, state: 'not-rendered', reason: null, certPath: null, keyPath: null, keyPresent: null, certificate: null, warnings: [] })
  return { kind: 'certificates', observedAt: now.toISOString(), hostname,
    endpoints: [await readPanelEndpoint(input.host, hostname, now), notRendered('postfix'), notRendered('dovecot'), notRendered('pure-ftpd')] }
}
