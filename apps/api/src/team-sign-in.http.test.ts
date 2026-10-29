import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApiApp } from './server.ts'
import type { ApiApp } from './server.ts'
import { MEMBER_PASSWORD, OWNER_PASSWORD, createTeamFixture } from './team-test-fixture.ts'
import type { TeamFixture } from './team-test-fixture.ts'
import type { TeamRole } from '@xpanel/core'

// Team sign-in through the real login, authentication and authorization path of the API server.
let f: TeamFixture
let app: ApiApp
beforeEach(async () => { f = await createTeamFixture(); app = createApiApp({ db: f.database.db, store: f.state.store, serverSecret: 'team-http-synthetic-server-secret' }) })
afterEach(async () => { await f.close() })

interface Session { cookie: string; csrf: string }
const send = (path: string, options: { method?: string; session?: Session; body?: unknown } = {}) => app.fetch(new Request('http://localhost' + path, {
  method: options.method ?? 'GET',
  headers: { ...(options.session ? { cookie: options.session.cookie, 'x-csrf-token': options.session.csrf } : {}), ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}) },
  ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
}))
const login = async (username: string, password: string): Promise<Response> => send('/api/auth/login', { method: 'POST', body: { username, password } })
const session = async (username: string, password: string): Promise<Session> => {
  const response = await login(username, password)
  expect(response.status, username).toBe(200)
  return { cookie: (response.headers.get('set-cookie') ?? '').split(';')[0]!, csrf: ((await response.json()) as { csrfToken: string }).csrfToken }
}
const member = async (roles: TeamRole[]): Promise<Session> => {
  await f.seed(f.alice.id, [f.member({ roles })])
  return session('sam@alice.example.test', MEMBER_PASSWORD)
}

describe('team sign-in over HTTP', () => {
  it('signs in through the xPanel login and reports the team identity', async () => {
    const team = await member(['email'])
    const me = await send('/api/auth/me', { session: team })
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ principal: { kind: 'team', username: 'sam', login: 'sam@alice.example.test', accountId: f.alice.id, roles: ['email'] }, totpEnabled: false, passwordChangeRequired: false })
  })
  it('never reaches root, reseller or account administration routes', async () => {
    const team = await member(['administrator', 'database', 'email', 'web'])
    for (const [method, path] of [['GET', '/api/server/settings'], ['GET', '/api/resellers'], ['GET', '/api/plans'], ['GET', '/api/accounts'], ['GET', `/api/accounts/${f.alice.id}`],
      ['GET', `/api/accounts/${f.bob.id}`], ['GET', '/api/audit'], ['GET', '/api/jobs'], ['GET', '/api/ips'], ['GET', '/api/account/team'], ['GET', '/api/auth/sessions']] as const) {
      const response = await send(path, { method, session: team })
      expect(response.status, `${method} ${path}`).toBe(403)
    }
    const changed = await send('/api/auth/change-password', { method: 'POST', session: team, body: { currentPassword: MEMBER_PASSWORD, newPassword: 'Changed!2026x' } })
    expect(changed.status).toBe(403)
    expect((await session('alice', OWNER_PASSWORD)).cookie).toBeTruthy()
  })
  it('reaches only the tools of its roles, and only on the owning account', async () => {
    const email = await member(['email'])
    expect((await send('/api/domains', { session: email })).status).toBe(403)
    expect((await send('/api/databases', { session: email })).status).toBe(403)
    const web = await member(['web'])
    const domains = await send('/api/domains', { session: web })
    expect(domains.status).toBe(200)
    expect(JSON.stringify(await domains.json())).not.toContain('bob.example.test')
    const foreign = await send(`/api/accounts/${f.bob.username}/files`, { method: 'POST', session: web, body: { op: 'list', path: '/' } })
    expect([403, 404]).toContain(foreign.status)
  })
  it('enforces the existing lockout on team sign-in names', async () => {
    await f.seed(f.alice.id, [f.member()])
    for (let attempt = 1; attempt <= 4; attempt++) expect((await login('sam@alice.example.test', 'wrong-' + attempt)).status).toBe(401)
    const locked = await login('sam@alice.example.test', 'wrong-5')
    expect(locked.status).toBe(429)
    const refused = await login('sam@alice.example.test', MEMBER_PASSWORD)
    expect(refused.status).toBe(429)
    expect(JSON.stringify(await refused.json())).toContain('lockedUntil')
  })
  it('ends the session on sign-out and when the owner suspends the member', async () => {
    const first = await member(['email'])
    expect((await send('/api/auth/logout', { method: 'POST', session: first })).status).toBe(200)
    expect((await send('/api/auth/me', { session: first })).status).toBe(401)
    const second = await session('sam@alice.example.test', MEMBER_PASSWORD)
    expect((await send('/api/auth/me', { session: second })).status).toBe(200)
    const owner = await session('alice', OWNER_PASSWORD)
    const view = await (await send('/api/account/team', { session: owner })).json() as { revision: string; signIn: { available: boolean } }
    expect(view.signIn.available).toBe(true)
    const suspended = await send(`/api/account/team/${f.member().id}/suspend`, { method: 'POST', session: owner, body: { expectedRevision: view.revision, reason: 'On leave' } })
    expect(suspended.status).toBe(200)
    expect((await send('/api/auth/me', { session: second })).status).toBe(401)
    expect((await login('sam@alice.example.test', MEMBER_PASSWORD)).status).toBe(403)
  })
})
