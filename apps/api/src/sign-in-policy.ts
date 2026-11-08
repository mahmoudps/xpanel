import { cidrContains, fail, formatCidr, parseCidr, parseIp, SESSION_ABSOLUTE_TIMEOUT_MS, SESSION_IDLE_TIMEOUT_MS } from '@xpanel/core'
import { clearLockout, listLockouts } from '@xpanel/db'
import type { Db } from '@xpanel/db'
import type { StateStore } from '@xpanel/state'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { assertExpectedRevision, exactKeys, panelConfigFile, panelConfigRevision, panelJson, readPanelConfigBody } from './panel-config-file.ts'
import type { PanelConfigFile } from './panel-config-file.ts'
import { defaultPasswordStrength, PASSWORD_SERVICES, type PasswordStrengthPolicy } from './password-policy.ts'

/** Failed sign-ins counted within a fixed window before the username or the address is locked. */
export interface FailureLimit { attempts: number; windowMin: number; durationMin: number }

/** cPHulk-style brute force protection, password strength per service and session lifetimes (`extended/panel/sign-in-policy.json`). */
export interface SignInPolicy {
  lockout: {
    username: FailureLimit
    ip: FailureLimit
    /** never counted or locked (cPHulk allowlist) */
    ipAllow: string[]
    /** always refused at sign-in, unless also allowed */
    ipDeny: string[]
  }
  passwordStrength: PasswordStrengthPolicy
  /** stricter than the product ceilings of 30 minutes idle and 24 hours absolute */
  session: { idleMin: number; absoluteHours: number }
}
interface SignInPolicyRecord extends SignInPolicy { version: 1; updatedAt: string }
export interface SignInPolicyView { state: 'default' | 'saved' | 'invalid'; policy: SignInPolicy | null; updatedAt: string | null; revision: string; client: { address: string | null } }

export const SIGN_IN_POLICY_FILE = 'sign-in-policy.json'
const ROUTE = '/api/server/sec/sign-in'
const NAMESPACE = 'sign-in-policy:v1'
const LIST_LIMIT = 256
const LOCKOUT_LIST_LIMIT = 500
export const SESSION_LIMITS = { idleMin: SESSION_IDLE_TIMEOUT_MS / 60_000, absoluteHours: SESSION_ABSOLUTE_TIMEOUT_MS / 3_600_000 } as const
const unchanged = { stateChanged: false }
const invalid = (field: string, message: string): never => fail('VALIDATION', message, { ...unchanged, fields: [{ field, code: 'invalid' }] })

export const defaultSignInPolicy = (): SignInPolicy => ({
  lockout: { username: { attempts: 5, windowMin: 15, durationMin: 15 }, ip: { attempts: 5, windowMin: 15, durationMin: 15 }, ipAllow: [], ipDeny: [] },
  passwordStrength: defaultPasswordStrength(),
  session: { idleMin: SESSION_LIMITS.idleMin, absoluteHours: SESSION_LIMITS.absoluteHours },
})

const object = (value: unknown, field: string, keys: readonly string[]): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) && exactKeys(value as Record<string, unknown>, keys) ? value as Record<string, unknown> : invalid(field, `${field} must be { ${keys.join(', ')} }`)
const integer = (value: unknown, field: string, min: number, max: number): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid(field, `${field} must be a whole number from ${min} to ${max}`)
const limit = (value: unknown, field: string): FailureLimit => {
  const o = object(value, field, ['attempts', 'windowMin', 'durationMin'])
  return { attempts: integer(o.attempts, `${field}.attempts`, 1, 1000), windowMin: integer(o.windowMin, `${field}.windowMin`, 1, 1440), durationMin: integer(o.durationMin, `${field}.durationMin`, 1, 10_080) }
}
const cidrs = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || value.length > LIST_LIMIT) return invalid(field, `${field} holds at most ${LIST_LIMIT} addresses or ranges`)
  const list = value.map(entry => { const cidr = parseCidr(typeof entry === 'string' ? entry.trim() : entry); return cidr ? formatCidr(cidr) : invalid(field, `${field} entries are IP addresses or CIDR ranges`) })
  return new Set(list).size === list.length ? list : invalid(field, `${field} lists each address once`)
}
// cPanel rounds a minimum strength up to the next multiple of 5.
const strength = (value: unknown, field: string): number => Math.ceil(integer(value, field, 0, 100) / 5) * 5

export function parseSignInPolicy(value: unknown): SignInPolicy {
  const o = object(value, 'policy', ['lockout', 'passwordStrength', 'session'])
  const lockout = object(o.lockout, 'lockout', ['username', 'ip', 'ipAllow', 'ipDeny'])
  const ipAllow = cidrs(lockout.ipAllow, 'lockout.ipAllow'), ipDeny = cidrs(lockout.ipDeny, 'lockout.ipDeny')
  if (ipDeny.some(entry => ipAllow.includes(entry))) invalid('lockout.ipDeny', 'an address cannot be both allowed and denied')
  const passwords = object(o.passwordStrength, 'passwordStrength', ['default', 'perService'])
  const perService = object(passwords.perService, 'passwordStrength.perService', PASSWORD_SERVICES)
  const session = object(o.session, 'session', ['idleMin', 'absoluteHours'])
  return {
    lockout: { username: limit(lockout.username, 'lockout.username'), ip: limit(lockout.ip, 'lockout.ip'), ipAllow, ipDeny },
    passwordStrength: {
      default: strength(passwords.default, 'passwordStrength.default'),
      perService: Object.fromEntries(PASSWORD_SERVICES.map(service => [service, perService[service] === null ? null : strength(perService[service], `passwordStrength.perService.${service}`)])) as PasswordStrengthPolicy['perService'],
    },
    session: { idleMin: integer(session.idleMin, 'session.idleMin', 1, SESSION_LIMITS.idleMin), absoluteHours: integer(session.absoluteHours, 'session.absoluteHours', 1, SESSION_LIMITS.absoluteHours) },
  }
}

const parseRecord = (raw: unknown): SignInPolicy | null => {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const record = raw as Record<string, unknown>
    if (!exactKeys(record, ['lockout', 'passwordStrength', 'session', 'version', 'updatedAt']) || record.version !== 1 || typeof record.updatedAt !== 'string'
      || !Number.isFinite(Date.parse(record.updatedAt)) || new Date(record.updatedAt).toISOString() !== record.updatedAt) return null
    return parseSignInPolicy({ lockout: record.lockout, passwordStrength: record.passwordStrength, session: record.session })
  } catch { return null }
}

export const signInPolicyFile = (store: Pick<StateStore, 'rootDir' | 'getWriterLock'>): PanelConfigFile<SignInPolicy> =>
  panelConfigFile(store, SIGN_IN_POLICY_FILE, NAMESPACE, parseRecord, defaultSignInPolicy)

const listed = (list: readonly string[], address: string | null): boolean => {
  const ip = parseIp(address)
  return ip !== null && list.some(entry => cidrContains(parseCidr(entry)!, ip))
}
/** How sign-in treats an address: allowed addresses are never counted or locked; denied ones are refused. */
export const signInAddressRule = (policy: SignInPolicy, address: string | null): 'allowed' | 'denied' | 'counted' =>
  listed(policy.lockout.ipAllow, address) ? 'allowed' : listed(policy.lockout.ipDeny, address) ? 'denied' : 'counted'

export const lockoutLimits = (policy: SignInPolicy) => {
  const ms = (l: FailureLimit) => ({ threshold: l.attempts, windowMs: l.windowMin * 60_000, lockoutDurationMs: l.durationMin * 60_000 })
  return { ...ms(policy.lockout.username), ipLimits: ms(policy.lockout.ip) }
}

export const sessionLimits = (policy: SignInPolicy) => ({ idleMs: policy.session.idleMin * 60_000, absoluteMs: policy.session.absoluteHours * 3_600_000 })

const viewOf = (raw: unknown, value: SignInPolicy | null, address: string | null): SignInPolicyView => ({
  state: raw === null ? 'default' : value ? 'saved' : 'invalid',
  policy: value,
  updatedAt: value && raw !== null ? (raw as { updatedAt: string }).updatedAt : null,
  revision: panelConfigRevision(NAMESPACE, raw),
  client: { address: parseIp(address) ? address : null },
})

export interface SignInPolicyHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: Pick<StateStore, 'rootDir' | 'getWriterLock'>
  db: Db
  clientIp: (request: Request) => string | null
  /** Installs a saved policy in the running API (password strength). */
  applied: (policy: SignInPolicy) => void
  now?: () => Date
}

/**
 * WHM cPHulk Brute Force Protection, Password Strength Configuration and session lifetimes: root reads and saves the policy
 * (revision-bound, read back), lists the active locks and lifts one by username or address.
 */
export async function handleSignInPolicyRoute(request: Request, url: URL, method: string, helpers: SignInPolicyHelpers): Promise<Response | null> {
  if (url.pathname !== ROUTE && !url.pathname.startsWith(ROUTE + '/')) return null
  const sub = url.pathname.slice(ROUTE.length)
  if (!['', '/lockouts', '/unlock'].includes(sub)) return null
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, 'security.sign-in')
  const allowed = sub === '' ? ['GET', 'PUT'] : sub === '/lockouts' ? ['GET'] : ['POST']
  if (!allowed.includes(method)) return new Response(null, { status: 405, headers: { allow: allowed.join(', ') } })
  if (url.search) return fail('VALIDATION', 'the sign-in policy accepts no query selectors', unchanged)
  const now = (helpers.now ?? (() => new Date()))()
  if (sub === '/lockouts') {
    const all = await listLockouts(helpers.db, now.toISOString())
    return panelJson({ at: now.toISOString(), truncated: all.length > LOCKOUT_LIST_LIMIT,
      lockouts: all.slice(0, LOCKOUT_LIST_LIMIT).map(lock => ({ id: lock.id, username: lock.username, ip: lock.ip, failures: lock.failures, lockedUntil: lock.lockedUntil, createdAt: lock.createdAt })) })
  }
  const body = method === 'GET' ? {} : await readPanelConfigBody(request)
  if (sub === '/unlock') {
    const keys = Object.keys(body)
    if (keys.length !== 1 || (keys[0] !== 'username' && keys[0] !== 'ip')) return fail('VALIDATION', 'unlock takes exactly one username or ip', unchanged)
    const username = typeof body.username === 'string' && /^[a-z0-9][a-z0-9._@-]{0,127}$/.test(body.username) ? body.username : undefined
    const ip = typeof body.ip === 'string' && parseIp(body.ip) ? formatCidr(parseCidr(body.ip)!) : undefined
    if (!username && !ip) return invalid(keys[0]!, keys[0] === 'ip' ? 'ip must be an IP address' : 'username must be a sign-in name')
    const fresh = await helpers.requireCaller(request)
    await helpers.assertRoot(fresh, 'security.sign-in')
    const cleared = await clearLockout(helpers.db, username ? { username } : { ip: ip! })
    await helpers.emitAudit({ actor: caller.principal.username, action: 'security.lockout.cleared', target: username ? `principal:${username}` : `address:${ip}`, detail: { cleared }, outcome: 'ok', principalId: caller.principal.id })
    return panelJson({ cleared })
  }
  // The address sign-in itself sees for this request (it falls back to loopback without a peer address).
  const file = signInPolicyFile(helpers.store), address = helpers.clientIp(request) ?? '127.0.0.1'
  if (method === 'GET') { const { raw, value } = await file.read(); return panelJson(viewOf(raw, value, address)) }
  if (!exactKeys(body, ['policy', 'expectedRevision'])) return fail('VALIDATION', 'exactly policy and expectedRevision are required', unchanged)
  const expected = assertExpectedRevision(body.expectedRevision)
  const policy = parseSignInPolicy(body.policy)
  if (signInAddressRule(policy, address) === 'denied') return fail('SELF_LOCKOUT', 'the denied addresses include the address of this session', { ...unchanged, reason: 'self_lockout' })
  const next: SignInPolicyRecord = { version: 1, ...policy, updatedAt: now.toISOString() }
  const saved = await file.write(next, expected, async () => { await helpers.assertRoot(await helpers.requireCaller(request), 'security.sign-in') })
  helpers.applied(saved.value)
  try {
    await helpers.emitAudit({ actor: caller.principal.username, action: 'security.sign_in_policy.updated', target: 'sign-in-policy', outcome: 'ok', principalId: caller.principal.id,
      detail: { username: policy.lockout.username, ip: policy.lockout.ip, allowed: policy.lockout.ipAllow.length, denied: policy.lockout.ipDeny.length, passwordStrength: policy.passwordStrength.default, session: policy.session } })
  } catch { return fail('SERVICE_UNAVAILABLE', 'the policy was saved but its audit record requires review; reload before retrying', { stateChanged: true, verificationRequired: true }) }
  return panelJson(viewOf(saved.raw, saved.value, address))
}
