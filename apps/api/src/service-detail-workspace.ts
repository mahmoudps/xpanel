import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { isServiceDetailZone } from '../../../packages/os/src/service-detail-command.ts'
import type { CertificateEndpoint, CertificatesServiceDetail, DnsServiceDetail, DnsZoneCheck, DnsZoneRow, FtpServiceDetail, FtpSettingRow, ServiceCertificate } from '../../agent/src/service-detail.ts'
import type { HostServiceStatus } from '../../agent/src/host-services.ts'

export interface ServiceDetailWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot'> {
  /** The authenticated agent owns host reads; absent when no protected host agent is connected. */
  readDetail?: (caller: AuthenticatedCaller, path: string) => Promise<unknown>
}

const ROUTE = /^\/api\/server\/services\/(dns|ftp|certificates|dns\/zone-check)$/
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const iso = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value))
const count = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max
const path = (value: unknown): value is string => typeof value === 'string' && value.length <= 256 && /^\/[A-Za-z0-9._/-]+$/.test(value) && !value.includes('..')
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T => typeof value === 'string' && (allowed as readonly string[]).includes(value)
const orNull = <T>(value: unknown, check: (item: unknown) => item is T): value is T | null => value === null || check(value)
const bad = (): never => fail('PRECONDITION_FAILED', 'the service observation could not be verified', { stateChanged: false, verificationRequired: true })
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const SERVICE_STATES = ['active', 'inactive', 'failed', 'not-installed', 'unchecked'] as const

function service(value: unknown, id: string): HostServiceStatus | null {
  if (value === null) return null
  if (!object(value) || value.id !== id || !bounded(value.label, 64) || value.unit !== null && !(typeof value.unit === 'string' && /^[A-Za-z0-9@._-]{1,128}\.service$/.test(value.unit))
    || !oneOf(value.state, SERVICE_STATES) || (value.unit === null) !== ['not-installed', 'unchecked'].includes(value.state)) return bad()
  return { id, label: value.label, unit: value.unit as string | null, state: value.state }
}

/** Whitelist the host boundary: only typed observation facts, never file contents. */
export function projectDnsDetail(value: unknown): DnsServiceDetail {
  if (!object(value) || value.kind !== 'dns' || !iso(value.observedAt) || !object(value.control) || value.zoneDir !== '/var/lib/powerdns/zones' || !oneOf(value.directory, ['read', 'missing', 'unavailable'] as const)
    || !oneOf(value.savedState, ['read', 'unavailable'] as const) || !count(value.otherEntries, 5000) || typeof value.truncated !== 'boolean' || !Array.isArray(value.zones) || value.zones.length > 2000) return bad()
  const control = value.control, directory = value.directory, savedState = value.savedState
  if (!oneOf(control.state, ['reachable', 'unreachable', 'unavailable'] as const) || !orNull(control.version, (item): item is string => typeof item === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}[0-9A-Za-z.+~-]{0,48}$/.test(item))
    || control.state !== 'reachable' && control.version !== null) return bad()
  const seen = new Set<string>()
  const zones: DnsZoneRow[] = value.zones.map(raw => {
    if (!object(raw) || !isServiceDetailZone(raw.zone) || seen.has(raw.zone) || !orNull(raw.desired, (item): item is boolean => typeof item === 'boolean') || (raw.desired === null) !== (savedState === 'unavailable')
      || !orNull(raw.stateSerial, (item): item is number => count(item, 4294967295)) || raw.stateSerial !== null && raw.desired !== true
      || !oneOf(raw.file, ['parsed', 'missing', 'malformed', 'too-large', 'not-regular', 'unreadable', 'not-read'] as const) || !orNull(raw.fileSerial, (item): item is number => count(item, 4294967295))
      || (raw.fileSerial !== null) !== (raw.file === 'parsed') || !orNull(raw.sizeBytes, (item): item is number => count(item))
      || directory === 'unavailable' && raw.file !== 'not-read' || directory === 'missing' && raw.file !== 'missing') return bad()
    seen.add(raw.zone)
    return { zone: raw.zone, desired: raw.desired, stateSerial: raw.stateSerial, file: raw.file, fileSerial: raw.fileSerial, sizeBytes: raw.sizeBytes }
  })
  return { kind: 'dns', observedAt: value.observedAt, service: service(value.service, 'pdns'), control: { state: control.state, version: control.version }, zoneDir: value.zoneDir,
    directory, savedState, otherEntries: value.otherEntries, truncated: value.truncated, zones }
}

export function projectZoneCheck(value: unknown, zone: string): DnsZoneCheck {
  if (!object(value) || value.zone !== zone || !iso(value.observedAt) || !oneOf(value.state, ['passed', 'failed', 'unavailable'] as const) || !Array.isArray(value.messages) || value.messages.length > 50
    || !value.messages.every(item => bounded(item, 300))) return bad()
  const numbers = [value.records, value.errors, value.warnings]
  if (value.state === 'unavailable' ? numbers.some(item => item !== null) : !numbers.every(item => count(item)) || (value.state === 'passed') !== (value.errors === 0)) return bad()
  return { zone, observedAt: value.observedAt, state: value.state, records: value.records as number | null, errors: value.errors as number | null, warnings: value.warnings as number | null, messages: value.messages as string[] }
}

export function projectFtpDetail(value: unknown): FtpServiceDetail {
  if (!object(value) || value.kind !== 'ftp' || !iso(value.observedAt) || value.confDir !== '/etc/pure-ftpd/conf' || !Array.isArray(value.settings) || value.settings.length > 32
    || !orNull(value.ftpAccounts, (item): item is number => count(item))) return bad()
  const seen = new Set<string>()
  const settings: FtpSettingRow[] = value.settings.map(raw => {
    if (!object(raw) || typeof raw.name !== 'string' || !/^[A-Za-z]{1,64}$/.test(raw.name) || seen.has(raw.name) || !bounded(raw.desired, 256) || !orNull(raw.observed, (item): item is string => bounded(item, 256))
      || !oneOf(raw.state, ['match', 'drift', 'missing', 'unreadable'] as const)
      || (raw.state === 'match' ? raw.observed !== raw.desired : raw.state === 'drift' ? raw.observed === null || raw.observed === raw.desired : raw.observed !== null)) return bad()
    seen.add(raw.name)
    return { name: raw.name, desired: raw.desired, observed: raw.observed, state: raw.state }
  })
  return { kind: 'ftp', observedAt: value.observedAt, service: service(value.service, 'pure-ftpd'), confDir: value.confDir, settings, ftpAccounts: value.ftpAccounts }
}

const ENDPOINTS = ['panel', 'postfix', 'dovecot', 'pure-ftpd'] as const
const REASONS = ['config_missing', 'listener_not_found', 'inconsistent_render', 'unexpected_path', 'certificate_missing', 'too_large', 'not_pem', 'unparsable', 'unreadable'] as const
const WARNINGS = ['expired', 'expiring', 'not-yet-valid', 'hostname-not-covered', 'key-missing'] as const

function certificate(value: unknown): ServiceCertificate {
  if (!object(value) || !bounded(value.subject, 512) || !bounded(value.issuer, 512) || !Array.isArray(value.names) || value.names.length > 100 || !value.names.every(item => typeof item === 'string' && item.length > 0 && item.length <= 253)
    || !iso(value.notBefore) || !iso(value.notAfter) || typeof value.daysLeft !== 'number' || !Number.isSafeInteger(value.daysLeft) || typeof value.fingerprint256 !== 'string' || !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(value.fingerprint256)
    || !count(value.chainLength, 32) || value.chainLength < 1 || !orNull(value.coversHostname, (item): item is boolean => typeof item === 'boolean')) return bad()
  return { subject: value.subject, issuer: value.issuer, names: value.names as string[], notBefore: value.notBefore, notAfter: value.notAfter, daysLeft: value.daysLeft, fingerprint256: value.fingerprint256, chainLength: value.chainLength, coversHostname: value.coversHostname }
}

export function projectCertificatesDetail(value: unknown): CertificatesServiceDetail {
  if (!object(value) || value.kind !== 'certificates' || !iso(value.observedAt) || !orNull(value.hostname, (item): item is string => typeof item === 'string' && /^[a-z0-9.-]{1,253}$/.test(item))
    || !Array.isArray(value.endpoints) || value.endpoints.length > ENDPOINTS.length) return bad()
  const seen = new Set<string>()
  const endpoints: CertificateEndpoint[] = value.endpoints.map(raw => {
    if (!object(raw) || !oneOf(raw.id, ENDPOINTS) || seen.has(raw.id) || !Array.isArray(raw.ports) || raw.ports.length > 8 || !raw.ports.every(port => count(port, 65535) && port > 0)
      || !orNull(raw.configPath, path) || !oneOf(raw.state, ['observed', 'not-rendered', 'missing', 'unavailable'] as const) || !orNull(raw.reason, (item): item is string => oneOf(item, REASONS))
      || !orNull(raw.certPath, path) || !orNull(raw.keyPath, path) || !orNull(raw.keyPresent, (item): item is boolean => typeof item === 'boolean')
      || !Array.isArray(raw.warnings) || new Set(raw.warnings).size !== raw.warnings.length || !raw.warnings.every(item => oneOf(item, WARNINGS))) return bad()
    const rendered = raw.state !== 'not-rendered'
    if ((raw.state === 'observed') !== (raw.certificate !== null) || (raw.reason === null) !== (raw.state === 'observed' || !rendered)
      || !rendered && (raw.ports.length || raw.configPath !== null || raw.certPath !== null || raw.keyPath !== null || raw.keyPresent !== null || raw.warnings.length)
      || (raw.certPath === null) !== (raw.keyPath === null) || raw.certPath === null && raw.keyPresent !== null) return bad()
    seen.add(raw.id)
    return { id: raw.id, ports: raw.ports as number[], configPath: raw.configPath, state: raw.state, reason: raw.reason as CertificateEndpoint['reason'], certPath: raw.certPath, keyPath: raw.keyPath,
      keyPresent: raw.keyPresent, certificate: raw.certificate === null ? null : certificate(raw.certificate), warnings: raw.warnings as CertificateEndpoint['warnings'] }
  })
  return { kind: 'certificates', observedAt: value.observedAt, hostname: value.hostname, endpoints }
}

export async function handleServiceDetailWorkspaceRoute(request: Request, url: URL, method: string, helpers: ServiceDetailWorkspaceHelpers): Promise<Response | null> {
  const kind = ROUTE.exec(url.pathname)?.[1]
  if (!kind) return null
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, kind === 'dns/zone-check' ? 'server.services.dns.check' : 'server.services.detail')
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  const keys = [...url.searchParams.keys()], zone = url.searchParams.get('zone')
  if (kind === 'dns/zone-check' ? keys.length !== 1 || keys[0] !== 'zone' || !isServiceDetailZone(zone) : url.search) return fail('VALIDATION', kind === 'dns/zone-check' ? 'exactly one canonical zone is required' : 'service detail routes do not accept selectors', { stateChanged: false })
  if (!helpers.readDetail) return fail('PRECONDITION_FAILED', 'service detail requires a connected host agent', { stateChanged: false })
  const value = await helpers.readDetail(caller, '/host/services/detail/' + kind + (kind === 'dns/zone-check' ? '?zone=' + zone : ''))
  return json(kind === 'dns' ? projectDnsDetail(value) : kind === 'ftp' ? projectFtpDetail(value) : kind === 'certificates' ? projectCertificatesDetail(value) : projectZoneCheck(value, zone!))
}
