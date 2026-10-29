import { createHash } from 'node:crypto'
import { cidrContains, formatCidr, parseCidr, parseIp } from './rules/firewall.ts'
import { canonicalIp } from './rules/ip-pool.ts'
import { fail } from './errors.ts'
import type { Cidr } from './rules/firewall.ts'

export const TRUSTED_PROXY_STATE_PATH = 'extended/server/trusted-proxies.json'
export const TRUSTED_PROXY_MAX_CIDRS = 32
export interface TrustedProxyPolicy { cidrs: string[]; header: 'X-Forwarded-For' }
export interface TrustedProxyRecord { version: 1; policy: TrustedProxyPolicy; updatedAt: string }
export interface TrustedProxyActive { state: 'read'; policy: TrustedProxyPolicy; revision: string }
export interface TrustedProxyObservation { state: 'read' | 'unavailable'; active: TrustedProxyActive | null; activation: 'available' | 'unavailable'; reason: string | null }
export interface ProtectedProxyIngress {
  /** Native provider evidence, never body fields, headers, a UI checkbox or an API token scope. */
  kind: 'protected-dedicated-ingress-v1'
  localAddresses: readonly string[]
  managementClient: string
  /** Exact networks independently admitted by the protected ingress provider. */
  dedicatedCidrs: readonly string[]
}
const unchanged = { stateChanged: false }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const invalid = (message: string): never => fail('VALIDATION', message, unchanged)
const blocked = (message: string): never => fail('PRECONDITION_FAILED', message, unchanged)
const FORBIDDEN = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/4', '240.0.0.0/4', '::/128', '::1/128', '64:ff9b::/96', '100::/64', 'fc00::/7', 'fe80::/10', 'ff00::/8'].map(value => parseCidr(value)!)
const overlap = (left: Cidr, right: Cidr): boolean => left.version === right.version && (cidrContains(left, right) || cidrContains(right, left))
export function parseTrustedProxyPolicy(value: unknown, localAddresses: readonly string[] = []): TrustedProxyPolicy {
  if (!object(value) || Object.keys(value).sort().join() !== 'cidrs,header' || value.header !== 'X-Forwarded-For' || !Array.isArray(value.cidrs) || value.cidrs.length > TRUSTED_PROXY_MAX_CIDRS) return invalid('exactly cidrs (at most 32) and header X-Forwarded-For are required')
  const nets = value.cidrs.map(raw => {
    if (typeof raw !== 'string' || raw.length > 64 || !raw.includes('/') || raw.trim() !== raw) return invalid('each proxy must be an explicit canonical CIDR')
    const parsed = parseCidr(raw)
    if (!parsed || formatCidr(parsed) !== raw) return invalid('each proxy must be an explicit canonical CIDR with zero host bits')
    if ((parsed.version === 4 && parsed.prefix < 16) || (parsed.version === 6 && (parsed.prefix < 32 || !cidrContains(parseCidr('2000::/3')!, parsed))) || FORBIDDEN.some(net => overlap(parsed, net))) return invalid('local, private, shared, multicast and overly broad networks cannot be trusted')
    return parsed
  })
  const locals = localAddresses.map(raw => parseIp(raw) ?? blocked('local interface inventory could not be verified'))
  if (nets.some(net => locals.some(local => cidrContains(net, local)))) return invalid('a trusted proxy range cannot include a local interface')
  if (nets.some((net, index) => nets.some((other, otherIndex) => otherIndex < index && overlap(net, other)))) return invalid('trusted proxy ranges must be distinct and non-overlapping')
  return { cidrs: nets.map(formatCidr).sort(), header: 'X-Forwarded-For' }
}
export function readTrustedProxyRecord(value: unknown): TrustedProxyRecord | null {
  try {
    if (!object(value) || Object.keys(value).sort().join() !== 'policy,updatedAt,version' || value.version !== 1 || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)) || new Date(value.updatedAt).toISOString() !== value.updatedAt) return null
    const policy = parseTrustedProxyPolicy(value.policy)
    if (JSON.stringify(policy) !== JSON.stringify(value.policy)) return null
    return { version: 1, policy, updatedAt: value.updatedAt }
  } catch { return null }
}
export const trustedProxyRevision = (value: unknown): string => createHash('sha256').update(JSON.stringify({ namespace: 'trusted-proxies:v1', value })).digest('hex')
export const trustedProxyPolicyRevision = (policy: TrustedProxyPolicy): string => createHash('sha256').update(JSON.stringify(parseTrustedProxyPolicy(policy))).digest('hex')

/** nginx.org ngx_http_realip_module: trust TCP peers explicitly and take a single replacement address; recursion stays off. */
export function renderTrustedProxyRealIp(policy: TrustedProxyPolicy): string {
  const checked = parseTrustedProxyPolicy(policy)
  return checked.cidrs.length ? [...checked.cidrs.map(cidr => `set_real_ip_from ${cidr};`), 'real_ip_header X-Forwarded-For;', 'real_ip_recursive off;', ''].join('\n') : '# real client IP: TCP peer (no trusted proxies configured)\n'
}
export const readTrustedProxyActive = (value: unknown): TrustedProxyActive => {
  if (!object(value) || Object.keys(value).sort().join() !== 'policy,revision,state' || value.state !== 'read') return blocked('active ingress policy could not be verified')
  const policy = parseTrustedProxyPolicy(value.policy)
  if (value.revision !== trustedProxyPolicyRevision(policy)) return blocked('active ingress policy could not be verified')
  return { state: 'read', policy, revision: value.revision as string }
}
export const assertTrustedProxyAdmission = (policy: TrustedProxyPolicy, proof: ProtectedProxyIngress): void => {
  if (proof?.kind !== 'protected-dedicated-ingress-v1' || !Array.isArray(proof.localAddresses) || proof.localAddresses.length < 1 || proof.localAddresses.length > 256 || !Array.isArray(proof.dedicatedCidrs)) return blocked('a protected dedicated ingress provider is required')
  const checked = parseTrustedProxyPolicy(policy, proof.localAddresses), approved = parseTrustedProxyPolicy({ cidrs: [...proof.dedicatedCidrs], header: 'X-Forwarded-For' }, proof.localAddresses)
  const client = parseIp(proof.managementClient)
  if (!client || checked.cidrs.some(cidr => cidrContains(parseCidr(cidr)!, client))) return blocked('the current management client cannot become a trusted proxy')
  if (checked.cidrs.some(cidr => !approved.cidrs.includes(cidr))) return blocked('the dedicated ingress provider has not admitted every proxy range')
}
/** A future CIDR listener adapter must receive this authority from protected startup, never a request. */
export function resolveTrustedProxyClient(policy: TrustedProxyPolicy, peer: string, headers: { get(name: string): string | null }, proof: ProtectedProxyIngress): { clientIp: string; trusted: boolean; forwardedHttps: boolean } {
  assertTrustedProxyAdmission(policy, proof)
  const current = parseIp(peer)
  if (!current) return fail('UNAUTHENTICATED', 'invalid socket peer')
  const canonical = canonicalIp(peer).address
  if (!policy.cidrs.some(cidr => cidrContains(parseCidr(cidr)!, current))) return { clientIp: canonical, trusted: false, forwardedHttps: false }
  const raw = headers.get('x-forwarded-for'), proto = headers.get('x-forwarded-proto')
  if (raw === null || raw.includes(',') || !parseIp(raw) || raw !== raw.trim() || (proto !== 'http' && proto !== 'https')) return fail('UNAUTHENTICATED', 'trusted ingress must overwrite a single client address and protocol')
  return { clientIp: canonicalIp(raw).address, trusted: true, forwardedHttps: proto === 'https' }
}

export interface TrustedProxyRenderAuthority { readonly kind: 'trusted-proxy-render-authority' }
const renderAuthorities = new WeakMap<object, TrustedProxyPolicy>()
/** A saved JSON record cannot carry this process-local authority; only protected provider evidence admits rendering. */
export function admitTrustedProxyRenderPolicy(policy: TrustedProxyPolicy, proof: ProtectedProxyIngress): TrustedProxyRenderAuthority {
  assertTrustedProxyAdmission(policy, proof)
  const authority = Object.freeze({ kind: 'trusted-proxy-render-authority' as const })
  renderAuthorities.set(authority, parseTrustedProxyPolicy(policy, proof.localAddresses))
  return authority
}
export function readAdmittedTrustedProxyPolicy(authority: TrustedProxyRenderAuthority): TrustedProxyPolicy {
  const policy = authority && renderAuthorities.get(authority)
  return policy ? { cidrs: [...policy.cidrs], header: policy.header } : blocked('a protected process-local render authority is required')
}