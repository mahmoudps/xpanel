import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { assertId, fail, parseServiceLogin } from '@xpanel/core'
import type { Account, TeamPrincipal } from '@xpanel/core'
import { checkLockout, clearLockout, findPrincipalByUsername, recordLoginAttempt } from '@xpanel/db'
import type { Db } from '@xpanel/db'
import { readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import { DUMMY_PASSWORD_HASH, deriveCsrfToken, formatSessionCookie, passwordHashFromInput, sha256Hex, verifyPasswordArgon2id } from './auth.ts'
import type { TeamMemberResolver } from './auth.ts'
import { readSavedTeam, teamMemberPhase } from './acct-team-workspace.ts'
import type { TeamMember } from './acct-team-workspace.ts'
import { ENTRY_POINTS, sessionTokenHash } from './entry-points.ts'
import type { EntryPoint } from './entry-points.ts'
import { consumeTeamPasswordLink, createTeamSession, findTeamPasswordLink, getTeamCredential } from './team-store.ts'

export const TEAM_PASSWORD_ROUTE = '/api/auth/team/password'
const SESSION_TTL_MS = 24 * 3600_000
const LINK_SECRET = /^[A-Za-z0-9_-]{43}$/
const MAX_BODY_BYTES = 4 * 1024
type Audit = (entry: { actor: string; action: string; target: string; detail?: Record<string, unknown>; outcome: 'ok' | 'denied' | 'failed'; principalId?: string | null; ip?: string | null }, scope?: { accountId: string | null; resellerId: string | null }) => Promise<unknown>
const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } })

/** Team sign-in name: member@primary-domain, as the team page shows it. Anything else is not a team login. */
export function parseTeamLogin(login: unknown): { member: string; domain: string } | null {
  if (typeof login !== 'string' || login.length > 128 || login !== login.toLowerCase()) return null
  try {
    const { local, domain } = parseServiceLogin(login)
    return local.length <= 32 && `${local}@${domain}` === login ? { member: local, domain } : null
  } catch { return null }
}

/** accounts/team/<account>.json under the state root, the file handleTeamRoute writes through ExtendedFeaturesStore. */
export const teamFileReader = (stateRootDir: string) => (accountId: string): Promise<unknown> =>
  readJsonIfExists<unknown>(join(stateRootDir, 'extended', 'accounts', 'team', `${assertId(accountId, 'accountId')}.json`))

/** authenticateRequest's view of the team file: only an existing, active (not suspended, not expired) member resolves. */
export const teamMemberResolver = (readTeam: (accountId: string) => Promise<unknown>, now: () => number = Date.now): TeamMemberResolver => async (accountId, memberId) => {
  const list = readSavedTeam(await readTeam(accountId))
  if (!list) return fail('PRECONDITION_FAILED', 'the saved team file requires review')
  const member = list.find(item => item.id === memberId)
  return member && teamMemberPhase(member, now()) === 'active' ? { username: member.username, roles: [...member.roles] } : null
}

export interface TeamSignInPorts {
  db: Db
  serverSecret: string
  store: Pick<StateStore, 'listAccounts'>
  readTeam: (accountId: string) => Promise<unknown>
  emitAudit: Audit
  /** server.ts recordFailedLoginAndMaybeLock for this login and address: it throws once the existing lockout engages. */
  recordFailure: (reason: string) => Promise<void>
  now?: () => Date
}
export interface TeamSignInInput { login: string; password: string; ip: string; userAgent: string; entryPoint?: EntryPoint; secure: boolean; mfaMode: string }

/**
 * POST /api/auth/login for a member@primary-domain name on xPanel. server.ts has already refused an active lockout
 * for this name and address. The password is verified exactly once, against a dummy hash when any part is unknown.
 */
export async function signInTeamMember(ports: TeamSignInPorts, input: TeamSignInInput): Promise<Response> {
  const now = ports.now?.() ?? new Date(), login = input.login
  if (input.entryPoint !== undefined && input.entryPoint !== 'xpanel') return fail('UNAUTHENTICATED', 'invalid username or password')
  const parsed = parseTeamLogin(login)
  const account = parsed ? (await ports.store.listAccounts()).find(item => item.primaryDomain === parsed.domain) ?? null : null
  const member = account ? readSavedTeam(await ports.readTeam(account.id))?.find(item => item.username === parsed!.member) ?? null : null
  const credential = member ? await getTeamCredential(ports.db, member.id) : null
  const hash = credential && credential.accountId === account!.id ? credential.passwordHash : null
  const matches = await verifyPasswordArgon2id(input.password, hash ?? DUMMY_PASSWORD_HASH)
  if (!account || !member || hash === null || !matches) {
    await ports.emitAudit({ actor: login, action: 'auth.login_failed', target: `team:${login}`, detail: { reason: 'invalid_credentials' }, outcome: 'denied', ip: input.ip })
    await ports.recordFailure('invalid_credentials')
    return fail('UNAUTHENTICATED', 'invalid username or password')
  }
  // The password is right from here on, so the refusal is named, as the account owner sign-in does.
  const refuse = async (reason: string, message: string): Promise<never> => {
    await ports.emitAudit({ actor: login, action: 'auth.login_denied_team', target: `team:${login}`, detail: { reason }, outcome: 'denied', ip: input.ip }, { accountId: account.id, resellerId: account.ownerId })
    return fail('FORBIDDEN', message, { reason })
  }
  const phase = teamMemberPhase(member, now.getTime())
  if (phase !== 'active') return refuse(phase, phase === 'suspended' ? 'this team member is suspended' : 'this team member has expired')
  if (account.status !== 'active') return refuse('account_' + account.status, `account "${account.username}" is ${account.status}`)
  const owner = await findPrincipalByUsername(ports.db, account.username)
  if (!owner || owner.kind !== 'user' || owner.accountId !== account.id || owner.disabled) return refuse('owner_unavailable', 'the account owner sign-in is unavailable')
  if (owner.forcePasswordChange) return refuse('owner_password_change', 'the account owner must change their password before team members can sign in')
  const rawToken = randomBytes(32).toString('hex')
  const session = await createTeamSession(ports.db, { memberId: member.id, accountId: account.id, ownerPrincipalId: owner.id, login, tokenHash: sessionTokenHash(rawToken, input.entryPoint),
    expectedPasswordHash: hash, ip: input.ip, userAgent: input.userAgent, now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) })
  if (!session) return fail('UNAUTHENTICATED', 'credentials changed; authenticate again')
  await clearLockout(ports.db, { username: login })
  await recordLoginAttempt(ports.db, { surface: 'panel', username: login, ip: input.ip, success: true })
  const principal: TeamPrincipal = { kind: 'team', id: member.id, username: member.username, login, accountId: account.id, roles: [...member.roles] }
  await ports.emitAudit({ actor: login, action: 'auth.login', target: `team:${login}`, detail: { sessionId: session.id, team: true, roles: member.roles }, outcome: 'ok', principalId: owner.id, ip: input.ip },
    { accountId: account.id, resellerId: account.ownerId })
  return json(200, {
    principal, ...(input.entryPoint ? { entryPoint: input.entryPoint, home: ENTRY_POINTS[input.entryPoint].home } : {}),
    session: { id: session.id, expiresAt: session.expiresAt, mfaVerified: false }, csrfToken: deriveCsrfToken(rawToken, ports.serverSecret, input.entryPoint),
    totpEnabled: false, mfaMode: input.mfaMode, passwordChangeRequired: false, mfaEnrollmentRequired: false,
  }, { 'set-cookie': formatSessionCookie(rawToken, { ...(input.entryPoint ? { entryPoint: input.entryPoint } : {}), secure: input.secure, maxAgeSec: SESSION_TTL_MS / 1000 }) })
}

export interface TeamPasswordPorts {
  db: Db
  store: Pick<StateStore, 'getAccount'>
  readTeam: (accountId: string) => Promise<unknown>
  emitAudit: Audit
  entryPoint?: EntryPoint
  /** server.ts isOriginPermitted and requireOriginHeader, applied as the sign-in route applies them. */
  originPermitted: (origin: string, request: Request) => boolean
  requireOriginHeader: boolean
  clientIp: (request: Request) => string
  now?: () => Date
}
const unusable = (): never => fail('NOT_FOUND', 'this password link is invalid, already used or expired', { stateChanged: false })

/** POST /api/auth/team/password {token, password}: the member sets a password through a single-use link. No session is opened. */
export async function handleTeamPasswordRoute(request: Request, method: string, ports: TeamPasswordPorts): Promise<Response> {
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (ports.entryPoint !== undefined && ports.entryPoint !== 'xpanel') return fail('NOT_FOUND', 'team password links are used on xPanel')
  const ip = ports.clientIp(request), origin = request.headers.get('origin')?.trim() ?? null, site = request.headers.get('sec-fetch-site')?.trim().toLowerCase() ?? null
  if (origin !== null ? !ports.originPermitted(origin, request) : site === 'cross-site' || ports.requireOriginHeader) {
    await ports.emitAudit({ actor: 'anonymous', action: 'auth.origin_rejected', target: TEAM_PASSWORD_ROUTE, detail: { origin, secFetchSite: site }, outcome: 'denied', ip })
    return fail('FORBIDDEN', 'cross-origin password request rejected')
  }
  if (new URL(request.url).search) return fail('VALIDATION', 'the password route does not accept selectors', { stateChanged: false })
  const lockout = await checkLockout(ports.db, { ip })
  if (lockout) return fail('FORBIDDEN', 'too many failed authentication attempts', { lockedOut: true, lockedUntil: lockout.lockedUntil })
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  const text = await request.text()
  let body: unknown
  try { body = Buffer.byteLength(text, 'utf8') <= MAX_BODY_BYTES ? JSON.parse(text) : null } catch { body = null }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join() !== 'password,token') return fail('VALIDATION', 'exactly password and token are required', { stateChanged: false })
  const { token, password } = body as Record<string, unknown>
  if (typeof token !== 'string' || !LINK_SECRET.test(token)) return unusable()
  const now = ports.now?.() ?? new Date(), linkHash = sha256Hex(token)
  const link = await findTeamPasswordLink(ports.db, linkHash, now)
  if (!link) return unusable()
  const account: Account | null = await ports.store.getAccount(link.accountId)
  const member: TeamMember | undefined = account ? readSavedTeam(await ports.readTeam(account.id))?.find(item => item.id === link.memberId) : undefined
  if (!account || !member) return unusable()
  if (account.status !== 'active' || teamMemberPhase(member, now.getTime()) !== 'active') return fail('FORBIDDEN', 'this team member cannot set a password now', { stateChanged: false })
  const passwordHash = await passwordHashFromInput({ password })
  if (!await consumeTeamPasswordLink(ports.db, { memberId: member.id, linkHash, passwordHash, now })) return unusable()
  const login = `${member.username}@${account.primaryDomain}`
  await ports.emitAudit({ actor: login, action: 'account.team.password_set', target: `team-member:${account.username}/${member.username}`, detail: { via: 'password-link' }, outcome: 'ok', ip },
    { accountId: account.id, resellerId: account.ownerId })
  return json(200, { ok: true, login })
}
