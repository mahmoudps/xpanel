import { Resolver } from 'node:dns/promises'
import { fail } from '@xpanel/core'
import type { Account, Certificate, Domain, ServerSettings } from '@xpanel/core'
import { SUPPORTED_PHP_VERSIONS } from '@xpanel/os'
import { edge } from '@xpanel/render'
import { authorizeAccountOwner, workspaceJson } from './account-ssh-workspace.ts'
import type { AccountOwnerPorts } from './account-ssh-workspace.ts'
import { deriveHtaccessTarget } from '../../agent/src/htaccess-workspace.ts'
import type { HtaccessTarget } from '../../agent/src/htaccess-workspace.ts'

export const SITE_HEALTH_PATH = '/api/account/site-health'
export const SITE_HEALTH_MAX_DOMAINS = 20
export const CERTIFICATE_WARNING_DAYS = 14
const CONCURRENCY = 5, DNS_TIMEOUT_MS = 2500
export type HealthState = 'ok' | 'problem' | 'unavailable'
export type HealthCheckId = 'dns' | 'http' | 'certificate' | 'php'
/** Page that fixes each check; shown as the finding's action. */
export const HEALTH_FIX_ROUTES: Readonly<Record<HealthCheckId, string>> = { dns: '/domains/zone-editor', http: '/metrics/logs', certificate: '/security/ssl', php: '/software/php' }
export interface HealthCheck { id: HealthCheckId; state: HealthState; cause: string; fix: string; detail: Record<string, unknown> }
export interface SiteHealthDomain { domainId: string; name: string; kind: Domain['kind']; checks: HealthCheck[] }
export interface SiteHealthView { context: { accountId: string }; checkedAt: string; domains: SiteHealthDomain[]; total: number; truncated: boolean; scope: { dns: 'system-resolver'; http: 'local-backend'; certificate: 'saved-store'; php: 'saved-settings' } }
export interface SiteHealthDns { resolve4(name: string): Promise<string[]>; resolve6(name: string): Promise<string[]> }
export interface SiteHealthPorts extends AccountOwnerPorts { dns: SiteHealthDns; probe(target: HtaccessTarget): Promise<number>; now?: () => Date }

/** node:dns/promises with a bounded per-query timeout and a single try per server. */
export const systemSiteHealthDns = (): SiteHealthDns => {
  const resolver = new Resolver({ timeout: 2000, tries: 1 })
  return { resolve4: name => resolver.resolve4(name), resolve6: name => resolver.resolve6(name) }
}
const ipv6 = (address: string): string => { try { return new URL('http://[' + address + ']').hostname.slice(1, -1) } catch { return address } }
type Lookup = { state: 'records'; addresses: string[] } | { state: 'none'; nxdomain: boolean } | { state: 'failed' }
const lookup = async (query: () => Promise<string[]>, normalize: (value: string) => string): Promise<Lookup> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const addresses = await Promise.race([query(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), DNS_TIMEOUT_MS) })])
    if (!Array.isArray(addresses) || addresses.length > 64 || addresses.some(item => typeof item !== 'string')) return { state: 'failed' }
    return addresses.length ? { state: 'records', addresses: [...new Set(addresses.map(normalize))].sort() } : { state: 'none', nxdomain: false }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null
    // c-ares: ENODATA = no records of this type, ENOTFOUND = the name does not exist.
    return code === 'ENODATA' ? { state: 'none', nxdomain: false } : code === 'ENOTFOUND' ? { state: 'none', nxdomain: true } : { state: 'failed' }
  } finally { clearTimeout(timer) }
}
const check = (id: HealthCheckId, state: HealthState, cause: string, detail: Record<string, unknown> = {}): HealthCheck => ({ id, state, cause, fix: HEALTH_FIX_ROUTES[id], detail })

async function dnsCheck(ports: SiteHealthPorts, domain: Domain, expected4: string, expected6: string | null): Promise<HealthCheck> {
  const [v4, v6] = await Promise.all([lookup(() => ports.dns.resolve4(domain.name), value => value), lookup(() => ports.dns.resolve6(domain.name), ipv6)])
  const found = { ipv4: v4.state === 'records' ? v4.addresses : [], ipv6: v6.state === 'records' ? v6.addresses : [] }, detail = { expected: { ipv4: expected4, ipv6: expected6 }, found }
  if (v4.state === 'failed' || v6.state === 'failed') return check('dns', 'unavailable', 'lookup_failed', detail)
  if (v4.state === 'none' && v6.state === 'none') return check('dns', 'problem', v4.nxdomain || v6.nxdomain ? 'name_not_found' : 'no_address', detail)
  if (!found.ipv4.includes(expected4)) return check('dns', 'problem', found.ipv4.length ? 'points_elsewhere' : 'no_ipv4', detail)
  if (expected6 === null ? found.ipv6.length > 0 : !found.ipv6.includes(expected6)) return check('dns', 'problem', expected6 === null ? 'ipv6_unexpected' : found.ipv6.length ? 'ipv6_points_elsewhere' : 'no_ipv6', detail)
  if (found.ipv4.length > 1 || found.ipv6.length > 1) return check('dns', 'problem', 'extra_addresses', detail)
  return check('dns', 'ok', 'matches', detail)
}
async function httpCheck(ports: SiteHealthPorts, account: Account, domain: Domain, serving: Domain | undefined, settings: ServerSettings | null): Promise<HealthCheck> {
  if (domain.redirect || serving?.redirect) return check('http', 'unavailable', 'redirect_site')
  let target: HtaccessTarget
  try { target = deriveHtaccessTarget(account, domain, settings, serving) } catch { return check('http', 'unavailable', 'site_unresolved') }
  if (!target.active) return check('http', 'unavailable', 'inactive_site')
  if (target.engine !== 'apache') return check('http', 'unavailable', 'engine', { engine: target.engine })
  let status: number
  try { status = await ports.probe(target) } catch { return check('http', 'unavailable', 'probe_failed') }
  if (!Number.isInteger(status) || status < 100 || status > 599) return check('http', 'unavailable', 'probe_failed')
  return check('http', status < 400 ? 'ok' : 'problem', status < 400 ? 'reachable' : status < 500 ? 'client_error' : 'server_error', { status })
}
function certificateCheck(domain: Domain, serving: Domain, certificates: Certificate[], now: Date): HealthCheck {
  const certificate = edge.certForName(domain.name, domain, serving, certificates)
  if (!certificate) return check('certificate', 'problem', 'missing')
  const notAfter = Date.parse(certificate.notAfter)
  if (!Number.isFinite(notAfter)) return check('certificate', 'unavailable', 'invalid_record')
  const daysLeft = Math.floor((notAfter - now.getTime()) / 86_400_000), detail = { notAfter: new Date(notAfter).toISOString(), daysLeft, autoRenew: certificate.autoRenew === true, source: certificate.source }
  if (notAfter <= now.getTime()) return check('certificate', 'problem', 'expired', detail)
  return check('certificate', daysLeft < CERTIFICATE_WARNING_DAYS ? 'problem' : 'ok', daysLeft < CERTIFICATE_WARNING_DAYS ? 'expiring' : 'valid', detail)
}
function phpCheck(serving: Domain): HealthCheck {
  if (serving.siteType !== 'php') return check('php', 'ok', 'not_php', { siteType: serving.siteType })
  const version = serving.php?.version, supported = (SUPPORTED_PHP_VERSIONS as readonly string[]).includes(version as string)
  return check('php', supported ? 'ok' : 'problem', supported ? 'supported' : 'unsupported', { version: typeof version === 'string' ? version.slice(0, 16) : null, supported: [...SUPPORTED_PHP_VERSIONS] })
}

/** Each owned domain is checked from saved state and bounded local probes; nothing is changed. */
export async function readSiteHealth(ports: SiteHealthPorts, account: Account): Promise<SiteHealthView> {
  const now = ports.now?.() ?? new Date()
  const domains = (await ports.store.listDomains({ accountId: account.id })).filter(domain => domain.accountId === account.id).sort((a, b) => (a.kind === 'primary' ? 0 : 1) - (b.kind === 'primary' ? 0 : 1) || a.name.localeCompare(b.name))
  const settings = await ports.store.getServerSettings(), certificates = await ports.store.listCertificates(account.id)
  const selected = domains.slice(0, SITE_HEALTH_MAX_DOMAINS), results: SiteHealthDomain[] = new Array(selected.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (let index = next++; index < selected.length; index = next++) {
      const domain = selected[index]!, serving = domain.kind === 'alias' ? domains.find(item => item.id === domain.parentId) : domain
      const expected4 = domain.ipv4 ?? serving?.ipv4 ?? account.ipv4, expected6 = domain.ipv6 ?? serving?.ipv6 ?? account.ipv6 ?? null
      const [dns, http] = await Promise.all([dnsCheck(ports, domain, expected4, expected6 ? ipv6(expected6) : null), httpCheck(ports, account, domain, serving, settings)])
      const known = serving ?? domain
      results[index] = { domainId: domain.id, name: domain.name, kind: domain.kind, checks: [dns, http, certificateCheck(domain, known, certificates, now), serving ? phpCheck(serving) : check('php', 'unavailable', 'site_unresolved')] }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, selected.length) }, worker))
  return { context: { accountId: account.id }, checkedAt: now.toISOString(), domains: results, total: domains.length, truncated: domains.length > selected.length,
    scope: { dns: 'system-resolver', http: 'local-backend', certificate: 'saved-store', php: 'saved-settings' } }
}

export async function handleSiteHealthRoute(req: Request, url: URL, method: string, ports: SiteHealthPorts): Promise<Response | null> {
  if (url.pathname !== SITE_HEALTH_PATH) return null
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (url.search) return fail('VALIDATION', 'site health does not accept selectors', { stateChanged: false })
  const { caller, account } = await authorizeAccountOwner(ports, req, ['account-health-overview'], 'Site health')
  const view = await readSiteHealth(ports, account)
  // Fresh authority after the probes: a revoked owner does not receive the findings.
  const fresh = await authorizeAccountOwner(ports, req, ['account-health-overview'], 'Site health')
  if (fresh.caller.principal.id !== caller.principal.id || fresh.account.id !== account.id) return fail('FORBIDDEN', 'site health authority changed', { stateChanged: false })
  return workspaceJson(view)
}
