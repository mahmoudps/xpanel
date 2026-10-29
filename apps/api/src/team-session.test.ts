import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkLockout, recordLoginFailure } from '@xpanel/db'
import { authenticateRequest, sha256Hex } from './auth.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { handleTeamRoute } from './acct-team-workspace.ts'
import type { TeamHelpers } from './acct-team-workspace.ts'
import { handleTeamPasswordRoute, parseTeamLogin, signInTeamMember, teamMemberResolver } from './team-session.ts'
import type { TeamPasswordPorts, TeamSignInPorts } from './team-session.ts'
import { atomicWriteJson } from '@xpanel/state'
import { join } from 'node:path'
import { MEMBER_PASSWORD, createTeamFixture } from './team-test-fixture.ts'
import type { TeamFixture } from './team-test-fixture.ts'

const SECRET = 'team-session-synthetic-server-secret'
const IP = '198.51.100.20'
let f: TeamFixture
beforeEach(async () => { f = await createTeamFixture() })
afterEach(async () => { await f.close() })

const audits: Record<string, unknown>[] = []
const emitAudit = vi.fn(async (entry: Record<string, unknown>) => { audits.push(entry) })
const signInPorts = (overrides: Partial<TeamSignInPorts> = {}): TeamSignInPorts => ({
  db: f.database.db, serverSecret: SECRET, store: f.state.store, readTeam: f.readTeam, emitAudit,
  recordFailure: async reason => { await recordLoginFailure(f.database.db, { username: 'sam@alice.example.test', ip: IP, reason, threshold: 3, windowMs: 60_000, lockoutDurationMs: 60_000 }) },
  ...overrides,
})
const signIn = (password = MEMBER_PASSWORD, login = 'sam@alice.example.test', ports = signInPorts()) =>
  signInTeamMember(ports, { login, password, ip: IP, userAgent: 'team-test', secure: false, mfaMode: 'disabled' })
const cookieOf = (response: Response): string => (response.headers.get('set-cookie') ?? '').split(';')[0]!
const authenticate = (cookie: string, path = '/api/mail/forwarders', method = 'GET', resolver = teamMemberResolver(f.readTeam)) =>
  authenticateRequest(f.database.db, new Request('http://localhost' + path, { method, headers: { cookie } }), { serverSecret: SECRET, teamMember: resolver })
const owner = (): AuthenticatedCaller => ({ principal: { kind: 'user', id: f.aliceOwner.id, username: 'alice', accountId: f.alice.id }, principalRecord: f.aliceOwner, sessionId: 'owner-session', sessionToken: 'x', apiTokenId: null, scopes: ['*'], csrfValid: true, mfaVerified: true })
const teamRoute = (method: string, path: string, body?: unknown, now?: () => Date) => {
  const url = new URL('http://localhost' + path)
  const helpers = { store: f.state.store, requireCaller: async () => owner(), emitAudit, readTeam: f.readTeam, db: f.database.db, ...(now ? { now } : {}),
    writeTeam: (accountId: string, value: unknown) => atomicWriteJson(join(f.state.store.rootDir, 'extended', 'accounts', 'team', `${accountId}.json`), value) } as unknown as TeamHelpers
  return handleTeamRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), url, method, helpers)
}
const revision = async (): Promise<string> => ((await (await teamRoute('GET', '/api/account/team'))!.json()) as { revision: string }).revision
const passwordPorts = (now?: () => Date): TeamPasswordPorts => ({ db: f.database.db, store: f.state.store, readTeam: f.readTeam, emitAudit, originPermitted: () => true, requireOriginHeader: false, clientIp: () => IP, ...(now ? { now } : {}) })
const setPassword = (body: unknown, now?: () => Date) => handleTeamPasswordRoute(new Request('http://localhost/api/auth/team/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), 'POST', passwordPorts(now))
const secretOf = (path: string): string => path.split('#team-password=')[1]!

describe('team login names', () => {
  it('accepts member@primary-domain only', () => {
    expect(parseTeamLogin('sam@alice.example.test')).toEqual({ member: 'sam', domain: 'alice.example.test' })
    for (const bad of ['Sam@alice.example.test', 'sam', '@alice.example.test', 'sam@', 'a@b@c.test', 'x'.repeat(33) + '@alice.example.test', 'sam@alice..test', 7]) expect(parseTeamLogin(bad)).toBeNull()
  })
})

describe('team password links', () => {
  it('lets the owner issue a single-use link; the member sets the password and the link stops working', async () => {
    await f.seed(f.alice.id, [f.member()], false)
    const issued = await teamRoute('POST', `/api/account/team/${f.member().id}/password-link`, { expectedRevision: await revision() })
    const body = await issued!.json() as { passwordLink: { path: string; expiresAt: string }; members: { signIn: { password: string; linkExpiresAt: string | null } }[]; signIn: { available: boolean } }
    expect(body.signIn.available).toBe(true)
    expect(body.passwordLink.path).toMatch(/^\/login\?target=xpanel#team-password=[A-Za-z0-9_-]{43}$/)
    expect(body.members[0]!.signIn).toMatchObject({ password: 'not-set', linkExpiresAt: body.passwordLink.expiresAt })
    const secret = secretOf(body.passwordLink.path)
    const stored = await f.database.db.query<{ link_hash: string }>('SELECT link_hash FROM team_credentials')
    expect(stored[0]!.link_hash).toBe(sha256Hex(secret))
    expect(JSON.stringify(audits)).not.toContain(secret)
    const used = await setPassword({ token: secret, password: MEMBER_PASSWORD })
    expect(await used.json()).toEqual({ ok: true, login: 'sam@alice.example.test' })
    await expect(setPassword({ token: secret, password: 'AnotherPassword!2026' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await signIn()).status).toBe(200)
  })
  it('refuses expired links, unknown keys, suspended members and links for inactive members', async () => {
    await f.seed(f.alice.id, [f.member()], false)
    const body = await (await teamRoute('POST', `/api/account/team/${f.member().id}/password-link`, { expectedRevision: await revision() }))!.json() as { passwordLink: { path: string } }
    const secret = secretOf(body.passwordLink.path)
    await expect(setPassword({ token: secret, password: MEMBER_PASSWORD, extra: 1 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(setPassword({ token: secret, password: MEMBER_PASSWORD }, () => new Date(Date.now() + 73 * 3600_000))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await teamRoute('POST', `/api/account/team/${f.member().id}/suspend`, { expectedRevision: await revision(), reason: 'On leave' })
    await expect(setPassword({ token: secret, password: MEMBER_PASSWORD })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(teamRoute('POST', `/api/account/team/${f.member().id}/password-link`, { expectedRevision: await revision() })).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('team sign-in', () => {
  it('signs an active member in as a team caller bound to the owning account', async () => {
    await f.seed(f.alice.id, [f.member()])
    const response = await signIn()
    expect(response.status).toBe(200)
    const body = await response.json() as { principal: Record<string, unknown>; csrfToken: string }
    expect(body.principal).toEqual({ kind: 'team', id: f.member().id, username: 'sam', login: 'sam@alice.example.test', accountId: f.alice.id, roles: ['email'] })
    const caller = await authenticate(cookieOf(response))
    expect(caller?.principal).toEqual({ kind: 'user', id: f.aliceOwner.id, username: 'alice', accountId: f.alice.id })
    expect(caller?.team).toMatchObject({ kind: 'team', roles: ['email'], accountId: f.alice.id })
    expect(caller?.mfaVerified).toBe(true)
    await expect(authenticate(cookieOf(response), '/api/databases')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(authenticate(cookieOf(response), '/api/server/settings')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    // Without a team resolver (an unwired listener) a team session never authenticates.
    expect(await authenticateRequest(f.database.db, new Request('http://localhost/api/mail/forwarders', { headers: { cookie: cookieOf(response) } }), { serverSecret: SECRET })).toBeNull()
  })
  it('refuses wrong, unknown, suspended, expired and deleted members', async () => {
    await f.seed(f.alice.id, [f.member(), f.member({ id: '77777777-7777-4777-8777-000000000002', username: 'ana', status: 'suspended', suspendReason: 'Leave' }),
      f.member({ id: '77777777-7777-4777-8777-000000000003', username: 'old', expiresAt: '2020-01-01T00:00:00.000Z' })])
    await expect(signIn('wrong-password')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    await expect(signIn(MEMBER_PASSWORD, 'nobody@alice.example.test')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    await expect(signIn(MEMBER_PASSWORD, 'sam@bob.example.test')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    await expect(signIn(MEMBER_PASSWORD, 'ana@alice.example.test')).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { reason: 'suspended' } })
    await expect(signIn(MEMBER_PASSWORD, 'old@alice.example.test')).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { reason: 'expired' } })
    await teamRoute('DELETE', `/api/account/team/${f.member().id}`, { expectedRevision: await revision(), confirmUsername: 'sam' })
    await expect(signIn()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    expect(await f.database.db.query('SELECT member_id FROM team_credentials WHERE member_id = $1', [f.member().id])).toEqual([])
  })
  it('enforces the existing lockout through the shared failure counter', async () => {
    await f.seed(f.alice.id, [f.member()])
    await expect(signIn('wrong-1')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    await expect(signIn('wrong-2')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    await signIn('wrong-3').catch(() => undefined)
    expect(await checkLockout(f.database.db, { username: 'sam@alice.example.test', ip: IP })).not.toBeNull()
  })
})

describe('team session revocation', () => {
  const signedIn = async (roles: ('email' | 'web' | 'database' | 'administrator')[] = ['email', 'web']) => {
    await f.seed(f.alice.id, [f.member({ roles })])
    return cookieOf(await signIn())
  }
  const active = async () => (await f.database.db.query<{ c: number }>('SELECT count(*) AS c FROM team_sessions WHERE revoked_at IS NULL'))[0]!.c
  it('ends sessions on suspension and keeps them ended after reinstatement', async () => {
    const cookie = await signedIn()
    expect(await authenticate(cookie)).not.toBeNull()
    await teamRoute('POST', `/api/account/team/${f.member().id}/suspend`, { expectedRevision: await revision(), reason: 'On leave' })
    expect(await active()).toBe(0)
    expect(await authenticate(cookie)).toBeNull()
    await teamRoute('POST', `/api/account/team/${f.member().id}/reinstate`, { expectedRevision: await revision() })
    expect(await authenticate(cookie)).toBeNull()
  })
  it('ends sessions when a role is removed, not when one is added', async () => {
    const cookie = await signedIn(['email'])
    const update = async (roles: string[]) => teamRoute('PUT', `/api/account/team/${f.member().id}`, { expectedRevision: await revision(), roles, contactEmail: 'sam@alice.example.test', notes: '', expiresAt: null, expiryReason: null })
    await update(['email', 'web'])
    expect(await authenticate(cookie, '/api/domains')).not.toBeNull()
    await update(['web'])
    expect(await active()).toBe(0)
    expect(await authenticate(cookie, '/api/domains')).toBeNull()
  })
  it('applies the current team file on every request even before revocation', async () => {
    const cookie = await signedIn(['email', 'web'])
    expect(await authenticate(cookie, '/api/domains')).not.toBeNull()
    await f.roles(f.alice.id, f.member().id, ['email'])
    await expect(authenticate(cookie, '/api/domains')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await atomicWriteJson(join(f.state.store.rootDir, 'extended', 'accounts', 'team', `${f.alice.id}.json`), [])
    expect(await authenticate(cookie)).toBeNull()
    expect(await active()).toBe(0)
  })
  it('ends sessions when the member is deleted, and a failed team read never revokes', async () => {
    const cookie = await signedIn()
    expect(await authenticate(cookie, '/api/mail/forwarders', 'GET', async () => { throw new Error('read failed') })).toBeNull()
    expect(await active()).toBe(1)
    await teamRoute('DELETE', `/api/account/team/${f.member().id}`, { expectedRevision: await revision(), confirmUsername: 'sam' })
    expect(await f.database.db.query('SELECT id FROM team_sessions')).toEqual([])
    expect(await authenticate(cookie)).toBeNull()
  })
})
