import { createHash, createHmac, randomBytes } from 'node:crypto'
import { isXpanelError, suspensionEffects } from '@xpanel/core'
import type { Account, ServiceUser } from '@xpanel/core'
import { checkLockout, findPrincipalByUsername } from '@xpanel/db'
import type { Db } from '@xpanel/db'
import { system } from '@xpanel/render'
import type { StateStore } from '@xpanel/state'
import { DUMMY_PASSWORD_HASH, verifyPasswordArgon2id, verifyServicePassword } from './auth.ts'
import { assertAccountPlanFeatures } from './authorization.ts'

/**
 * The nginx edge asks this route before every Web Disk and calendar request (docs/decisions/2026-11-07-dav-servers.md).
 * It runs only behind the management ingress credential, which sets the service and the account of the requested
 * name; the client supplies nothing but its Basic credentials. A success names the instance or principal nginx
 * forwards to; there is no session and no cookie.
 */
export const DAV_AUTHORIZE_PATH = '/api/dav/authorize'
export type DavService = 'webdisk' | 'caldav'

const REALMS: Readonly<Record<DavService, string>> = { webdisk: 'Web Disk', caldav: 'Calendars and Contacts' }
const TOOL: Readonly<Record<DavService, string>> = { webdisk: 'web-disk', caldav: 'calendars-contacts-config' }
const SUBSYSTEM: Readonly<Record<DavService, 'webdisk-login' | 'mail-login'>> = { webdisk: 'webdisk-login', caldav: 'mail-login' }
const ACCOUNT_RE = /^[a-z][a-z0-9]{0,15}$/
const CACHE_TTL_MS = 5 * 60_000
const CACHE_MAX = 512

export interface DavAuthorizeDeps {
  getAccountByUsername(username: string): Promise<Account | null>
  getServiceUserByLogin(login: string): Promise<ServiceUser | null>
  /** scheme-tagged stored hash of a service user */
  getServiceUserHash(id: string): Promise<string | null>
  /** the panel principal of an account owner */
  findPrincipal(username: string): Promise<{ kind: string; accountId: string | null; disabled: boolean; passwordHash: string } | null>
  /** throws FORBIDDEN when the account plan disables the tool */
  assertFeature(account: Account, toolId: string): Promise<void>
  /** an active lockout of this login or address */
  isLockedOut(login: string, ip: string): Promise<boolean>
  /** counts a failure toward the shared sign-in lockout */
  recordFailure(login: string, ip: string): Promise<void>
  /** Argon2id verification; verifyPasswordArgon2id when omitted */
  verify?: (password: string, hash: string) => Promise<boolean>
  now?: () => number
}

interface Subject { kind: 'main' | 'user'; id: string; principal: string; login: string; hash: string | null; readOnly: boolean; dir: string }

const empty = (status: number, headers: Record<string, string> = {}): Response =>
  new Response(null, { status, headers: { 'cache-control': 'no-store', ...headers } })

/** RFC 7617 Basic credentials; null when absent or malformed. */
export const parseBasicCredentials = (header: string | null): { login: string; password: string } | null => {
  const m = /^Basic\s+([A-Za-z0-9+/]{4,1400}={0,2})\s*$/i.exec(header ?? '')
  if (!m) return null
  const text = Buffer.from(m[1]!, 'base64').toString('utf8')
  const colon = text.indexOf(':')
  const login = text.slice(0, Math.max(colon, 0)).trim().toLowerCase()
  // the sign-in lockout records logins of at most 128 characters
  if (colon <= 0 || !login || login.length > 128 || /[\u0000-\u001f\u007f]/.test(login)) return null
  return { login, password: text.slice(colon + 1) }
}

export const createDavAuthorizer = (deps: DavAuthorizeDeps) => {
  const key = randomBytes(32)
  // Bound to the stored hash, so a password change or reset ends a cached verification at once.
  const verified = new Map<string, number>()
  const now = deps.now ?? Date.now
  const verify = deps.verify ?? ((password: string, hash: string) =>
    hash.startsWith('{SHA512-CRYPT}') ? verifyServicePassword(password, hash) : verifyPasswordArgon2id(password, hash))
  const cacheKey = (service: DavService, account: string, login: string, password: string, hash: string): string =>
    createHmac('sha256', key).update([service, account, login, password, createHash('sha256').update(hash).digest('hex')].join('\0')).digest('hex')

  const subjectOf = async (service: DavService, account: Account, login: string): Promise<Subject | null> => {
    if (login === account.username) {
      const principal = await deps.findPrincipal(login)
      const usable = principal && principal.kind === 'user' && principal.accountId === account.id && !principal.disabled
      return { kind: 'main', id: 'main', principal: system.CALDAV_MAIN_PRINCIPAL, login, hash: usable ? principal.passwordHash : null, readOnly: false, dir: '' }
    }
    const user = login.includes('@') ? await deps.getServiceUserByLogin(login) : null
    if (!user || user.accountId !== account.id || !(service === 'webdisk' ? user.services.webdisk : user.services.email)) return null
    const stored = await deps.getServiceUserHash(user.id)
    const hash = stored?.startsWith('{ARGON2ID}') ? stored.slice('{ARGON2ID}'.length) : stored?.startsWith('{SHA512-CRYPT}') ? stored : null
    return { kind: 'user', id: user.id, principal: user.id, login: user.login.toLowerCase(), hash, readOnly: user.webdiskReadOnly === true, dir: user.ftpDir }
  }

  return async (req: Request, clientIp: string): Promise<Response> => {
    const service = req.headers.get('x-xpanel-dav-service')
    const username = req.headers.get('x-xpanel-dav-account') ?? ''
    if ((service !== 'webdisk' && service !== 'caldav') || !ACCOUNT_RE.test(username)) return empty(400)
    const challenge = { 'www-authenticate': `Basic realm="${REALMS[service]}", charset="UTF-8"` }
    const credentials = parseBasicCredentials(req.headers.get('authorization'))
    if (!credentials) return empty(401, challenge)
    if (await deps.isLockedOut(credentials.login, clientIp)) return empty(403)
    const account = await deps.getAccountByUsername(username)
    const subject = account ? await subjectOf(service, account, credentials.login) : null
    const hash = subject?.hash ?? null
    const entry = hash ? cacheKey(service, username, credentials.login, credentials.password, hash) : null
    const cached = entry !== null && (verified.get(entry) ?? 0) > now()
    if (!cached) {
      const matches = await verify(credentials.password, hash ?? DUMMY_PASSWORD_HASH)
      if (!matches || !account || !subject || !hash || !entry) {
        try {
          await deps.recordFailure(credentials.login, clientIp)
        } catch (error) {
          if (isXpanelError(error) && error.code === 'FORBIDDEN') return empty(403)
          throw error
        }
        return empty(401, challenge)
      }
      if (verified.size >= CACHE_MAX) verified.delete(verified.keys().next().value!)
      verified.set(entry, now() + CACHE_TTL_MS)
    }
    // Password checked first, so a refusal here never tells a guesser whether the account exists or is suspended.
    if (suspensionEffects(account!).some(effect => effect.subsystem === SUBSYSTEM[service] && effect.state === 'denied')) return empty(403)
    try {
      await deps.assertFeature(account!, TOOL[service])
    } catch (error) {
      if (isXpanelError(error) && error.code === 'FORBIDDEN') return empty(403)
      throw error
    }
    // The store is keyed by identity, not address: whoever recreates an address never reaches the old collections.
    if (service === 'caldav') return empty(204, { 'x-xpanel-dav-user': subject!.principal })
    const instance = system.webDiskInstance({ subject: subject!.id, dir: subject!.dir, readOnly: subject!.readOnly })
    return empty(204, { 'x-xpanel-dav-instance': instance })
  }
}

/** The route over the panel's own store, database and sign-in lockout (server.ts recordFailedLoginAndMaybeLock). */
export const createDavAuthorizeRoute = (deps: { store: StateStore; db: Db; recordFailure: (login: string, ip: string) => Promise<void> }) => createDavAuthorizer({
  getAccountByUsername: username => deps.store.getAccountByUsername(username),
  getServiceUserByLogin: login => deps.store.getServiceUserByLogin(login),
  getServiceUserHash: id => deps.store.getServiceUserHash(id),
  findPrincipal: username => findPrincipalByUsername(deps.db, username),
  assertFeature: (account, toolId) => assertAccountPlanFeatures(deps.store, account, [toolId]),
  isLockedOut: async (login, ip) => (await checkLockout(deps.db, { username: login, ip })) !== null,
  recordFailure: deps.recordFailure,
})
