import { fail } from './errors.ts'
import { isUuid } from './schemas.ts'
import { cidrContains, parseCidr, parseIp } from './rules/firewall.ts'
import { SESSION_ABSOLUTE_TIMEOUT_MS, SESSION_IDLE_TIMEOUT_MS } from './session-policy.ts'
import type { MfaRuntimePolicy } from './mfa-runtime-policy.ts'
import type { Principal } from './types.ts'
import { canonicalProvisioningIdentity } from './account-provisioning-contract.ts'

/** References are read from a protected completed preparation, never from HTTP fields. */
export type ProvisioningAuthorizationReference =
  | { readonly kind: 'session'; readonly principalId: string; readonly sessionId: string; readonly tokenHash: string; readonly entryPoint: 'xwhm' | null }
  | { readonly kind: 'api-token'; readonly principalId: string; readonly tokenId: string; readonly tokenHash: string; readonly clientIp: string | null; readonly scope: 'accounts:write' }
  | { readonly kind: 'whmcs'; readonly principalId: string; readonly apiIdentifier: string; readonly tokenSha256: string; readonly recordIdentity: string; readonly clientIp: string; readonly package: string; readonly planId: string }

const HEX = /^[0-9a-f]{64}$/
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const denied = (): never => fail('FORBIDDEN', 'the original credential no longer holds authority', { stateChanged: false })
const keys = (value: Record<string, unknown>, expected: string[]): boolean => Object.keys(value).sort().join(',') === expected.sort().join(',')
const hash = (value: unknown): value is string => typeof value === 'string' && HEX.test(value)

export function parseProvisioningAuthorizationReference(value: unknown): ProvisioningAuthorizationReference {
  if (!object(value) || !isUuid(value.principalId)) return denied()
  if (value.kind === 'session' && keys(value, ['kind', 'principalId', 'sessionId', 'tokenHash', 'entryPoint'])
    && isUuid(value.sessionId) && hash(value.tokenHash) && (value.entryPoint === null || value.entryPoint === 'xwhm')) return value as ProvisioningAuthorizationReference
  if (value.kind === 'api-token' && keys(value, ['kind', 'principalId', 'tokenId', 'tokenHash', 'clientIp', 'scope'])
    && isUuid(value.tokenId) && hash(value.tokenHash) && (value.clientIp === null || typeof value.clientIp === 'string' && !!parseIp(value.clientIp))
    && value.scope === 'accounts:write') return value as ProvisioningAuthorizationReference
  if (value.kind === 'whmcs' && keys(value, ['kind', 'principalId', 'apiIdentifier', 'tokenSha256', 'recordIdentity', 'clientIp', 'package', 'planId'])
    && typeof value.apiIdentifier === 'string' && value.apiIdentifier.length > 0 && value.apiIdentifier.length <= 256 && !/[\x00-\x1f\x7f]/.test(value.apiIdentifier)
    && hash(value.tokenSha256) && hash(value.recordIdentity) && typeof value.clientIp === 'string' && !!parseIp(value.clientIp)
    && typeof value.package === 'string' && value.package.length > 0 && value.package.length <= 128 && !/[\x00-\x1f\x7f]/.test(value.package)
    && isUuid(value.planId)) return value as ProvisioningAuthorizationReference
  return denied()
}

export interface ProvisioningPrincipalAuthorizationView {
  readonly id: string
  readonly kind: string
  readonly username: string
  readonly disabled: boolean
  readonly forcePasswordChange: boolean
  readonly totpEnabled: boolean
  readonly totpSecretEnc: Uint8Array | null
}
export interface ProvisioningSessionAuthorizationView {
  readonly id: string
  readonly principalId: string
  readonly createdAt: string
  readonly lastSeenAt: string
  readonly expiresAt: string
  readonly revokedAt: string | null
  readonly mfaVerified: boolean
  readonly impersonatorPrincipalId: string | null
  readonly impersonatorTeamMemberId: string | null
}
export interface ProvisioningApiTokenAuthorizationView {
  readonly id: string
  readonly principalId: string
  readonly expiresAt: string
  readonly revokedAt: string | null
  readonly scopes: readonly string[]
  readonly allowedIps: readonly string[]
}
export interface ProvisioningAuthorizationReadPorts {
  principal(id: string): Promise<ProvisioningPrincipalAuthorizationView | null>
  session(tokenHash: string): Promise<ProvisioningSessionAuthorizationView | null>
  apiToken(tokenHash: string): Promise<ProvisioningApiTokenAuthorizationView | null>
  whmcs(): Promise<unknown>
}

const ipAllowed = (allowed: readonly string[], clientIp: string | null): boolean => {
  if (!allowed.length) return true
  const ip = parseIp(clientIp)
  return !!ip && allowed.some(entry => { const cidr = parseCidr(entry); return !!cidr && cidrContains(cidr, ip) })
}

const currentPrivilegedPrincipal = async (principalId: string, actor: Principal,
  ports: Pick<ProvisioningAuthorizationReadPorts, 'principal'>): Promise<ProvisioningPrincipalAuthorizationView> => {
  const principal = await ports.principal(principalId)
  if (!principal || principal.id !== actor.id || principalId !== actor.id || principal.kind !== actor.kind
    || principal.username !== actor.username || principal.disabled || principal.forcePasswordChange || !['root', 'reseller'].includes(principal.kind)) return denied()
  return principal
}

/** Re-read the original interactive credential using admitted transaction-bound ports, without extending it. */
export async function assertPrivilegedSessionAuthorization(input: {
  readonly reference: unknown
  readonly actor: Principal
  readonly ports: Pick<ProvisioningAuthorizationReadPorts, 'principal' | 'session'>
  readonly policy: Pick<MfaRuntimePolicy, 'mode'>
}): Promise<void> {
  const ref = parseProvisioningAuthorizationReference(input.reference)
  if (ref.kind !== 'session') return denied()
  const principal = await currentPrivilegedPrincipal(ref.principalId, input.actor, input.ports)
  const session = await input.ports.session(ref.tokenHash)
  if (!session || session.id !== ref.sessionId || session.principalId !== principal.id || session.impersonatorPrincipalId !== null || session.impersonatorTeamMemberId !== null) return denied()
  const now = Date.now(), created = Date.parse(session.createdAt), seen = Date.parse(session.lastSeenAt), expires = Date.parse(session.expiresAt)
  if (!Number.isFinite(created) || !Number.isFinite(seen) || !Number.isFinite(expires) || expires <= now || session.revokedAt !== null
    || now - created >= SESSION_ABSOLUTE_TIMEOUT_MS || now - seen >= SESSION_IDLE_TIMEOUT_MS
    || !(input.policy.mode === 'disabled' || !principal.totpEnabled || principal.totpSecretEnc !== null && session.mfaVerified)) return denied()
}

/** Same persisted authentication semantics as the API, without touching or extending credentials. */
export async function assertProvisioningAuthorization(input: {
  readonly reference: unknown
  readonly actor: Principal
  readonly planId: string
  readonly ports: ProvisioningAuthorizationReadPorts
  readonly policy: Pick<MfaRuntimePolicy, 'mode'>
}): Promise<void> {
  const ref = parseProvisioningAuthorizationReference(input.reference)
  if (ref.kind === 'session') {
    return assertPrivilegedSessionAuthorization({ reference: ref, actor: input.actor, ports: input.ports, policy: input.policy })
  }
  const principal = await currentPrivilegedPrincipal(ref.principalId, input.actor, input.ports)
  if (ref.kind === 'api-token') {
    const token = await input.ports.apiToken(ref.tokenHash)
    if (!token || token.id !== ref.tokenId || token.principalId !== principal.id || token.revokedAt !== null
      || !Number.isFinite(Date.parse(token.expiresAt)) || Date.parse(token.expiresAt) <= Date.now()
      || !token.scopes.some(scope => scope === '*' || scope === 'accounts:*' || scope === 'accounts:write') || !ipAllowed(token.allowedIps, ref.clientIp)) return denied()
    return
  }
  const saved = await input.ports.whmcs()
  if (principal.kind !== 'root' || !object(saved) || !keys(saved, ['version', 'apiIdentifier', 'enabled', 'autoCreate', 'allowedAddresses', 'planMap', 'ssoTarget', 'token', 'updatedAt', 'whmcsUrl'])
    || saved.version !== 1 || saved.enabled !== true || saved.autoCreate !== true || saved.apiIdentifier !== ref.apiIdentifier
    || canonicalProvisioningIdentity(saved) !== ref.recordIdentity || !object(saved.token)
    || !keys(saved.token, ['sha256', 'hint', 'createdAt', 'issuedBy']) || saved.token.sha256 !== ref.tokenSha256 || saved.token.issuedBy !== principal.id
    || !Array.isArray(saved.allowedAddresses) || !saved.allowedAddresses.length || saved.allowedAddresses.some(entry => typeof entry !== 'string' || !parseCidr(entry))
    || !ipAllowed(saved.allowedAddresses as string[], ref.clientIp) || !Array.isArray(saved.planMap) || saved.planMap.length > 64
    || saved.planMap.some(row => !object(row) || !keys(row, ['package', 'planId']) || typeof row.package !== 'string' || !isUuid(row.planId))
    || !saved.planMap.some(row => object(row) && row.package === ref.package && row.planId === ref.planId) || ref.planId !== input.planId) return denied()
}

