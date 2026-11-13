import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIN_ARGON2_MEMORY_KIB, fail } from '@xpanel/core'
import { createSession } from '@xpanel/db'
import { computeTotpCode, deriveCsrfToken, hashPasswordArgon2id, verifyPasswordArgon2id } from './auth.ts'
import { sessionCookieName, sessionTokenHash, type EntryPoint } from './entry-points.ts'
import type { MailboxTransport } from './mail/inbox.ts'
import { createApiApp, type ApiApp } from './server.ts'
import { createTeamFixture, type TeamFixture } from './team-test-fixture.ts'

// HTTP sign-in on the xMail listener for an enrolled mailbox (owner decision D5: the factor guards xMail sign-in only).
const SECRET = 'mailbox-sign-in-fixture-server-secret-32-bytes'
const ORIGIN = { xpanel: 'https://panel.example.test:2083', xwhm: 'https://whm.example.test:2087', xmail: 'https://mail.example.test:2096' } as const
const HANDOFF = { xwhm: { targetOrigin: ORIGIN.xpanel }, xpanel: { targetOrigin: ORIGIN.xmail, issuerOrigin: ORIGIN.xwhm }, xmail: { issuerOrigin: ORIGIN.xpanel } } as const
const MAILBOX = 'inbox@alice.example.test', PASSWORD = 'MailboxFixture!2026'
type Auth = { cookie: string; csrf: string }
type Problem = { code?: string; details?: Record<string, unknown> }

let f: TeamFixture
let apps: Record<EntryPoint, ApiApp>
let secret = '', recoveryCodes: string[] = []
beforeAll(async () => {
  f = await createTeamFixture()
  const hash = await hashPasswordArgon2id(PASSWORD, { memoryKiB: MIN_ARGON2_MEMORY_KIB, timeCost: 1, parallelism: 1 })
  await f.state.store.createServiceUser({ accountId: f.alice.id, login: MAILBOX, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html', passwordHash: hash })
  const verifiedHashes = new Map<string, boolean>()
  const transport: MailboxTransport = {
    async verify(login, password) {
      const user = await f.state.store.getServiceUserByLogin(login)
      const stored = user ? await f.state.store.getServiceUserHash(user.id) : null
      const value = stored?.startsWith('{ARGON2ID}') ? stored.slice('{ARGON2ID}'.length) : stored
      if (!user?.services.email || typeof value !== 'string') return fail('UNAUTHENTICATED', 'invalid mailbox credentials')
      const cacheKey = `${value}\0${password}`
      let ok = verifiedHashes.get(cacheKey)
      if (ok === undefined) {
        ok = await verifyPasswordArgon2id(password, value)
        verifiedHashes.set(cacheKey, ok)
      }
      if (!ok) fail('UNAUTHENTICATED', 'invalid mailbox credentials')
    },
    async list() { return [] }, async read() { return fail('NOT_FOUND', 'message not found') }, async remove() {}, async send() { return { messageId: '<fixture@example.test>' } },
  }
  apps = Object.fromEntries((['xpanel', 'xwhm', 'xmail'] as const).map(entryPoint => [entryPoint, createApiApp({
    db: f.database.db, store: f.state.store, serverSecret: SECRET, entryPoint, publicOrigin: ORIGIN[entryPoint], allowedOrigins: [ORIGIN[entryPoint]],
    secureCookies: true, requireOriginHeader: true, handoff: HANDOFF[entryPoint], ...(entryPoint === 'xmail' ? { mailboxTransport: transport } : {}),
  })])) as Record<EntryPoint, ApiApp>
  // Enroll the mailbox authenticator through its own routes from a password sign-in.
  const auth = await signedIn(await login())
  const setup = await (await send('xmail', '/api/webmail/security/2fa/setup', { auth, body: { password: PASSWORD } })).json() as { secret: string; recoveryCodes: string[] }
  secret = setup.secret; recoveryCodes = setup.recoveryCodes
  expect((await send('xmail', '/api/webmail/security/2fa/enable', { auth, body: { code: computeTotpCode(secret) } })).status).toBe(200)
}, 60_000)
afterAll(async () => { await f.close() })

const send = (entryPoint: EntryPoint, path: string, init: { auth?: Auth; body?: unknown } = {}) => apps[entryPoint].fetch(new Request(ORIGIN[entryPoint] + path, {
  method: init.body === undefined ? 'GET' : 'POST',
  headers: { origin: ORIGIN[entryPoint], ...(init.auth ? { cookie: init.auth.cookie, 'x-csrf-token': init.auth.csrf } : {}), ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
  ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
}))
const login = (extra: Record<string, string> = {}, password = PASSWORD) => send('xmail', '/api/auth/login', { body: { username: MAILBOX, password, ...extra } })
async function signedIn(response: Response): Promise<Auth> {
  expect(response.status).toBe(200)
  const body = await response.json() as { csrfToken: string }
  return { cookie: (response.headers.get('set-cookie') ?? '').split(';')[0]!, csrf: body.csrfToken }
}
const problem = async (response: Response): Promise<Problem & { status: number }> => ({ status: response.status, ...await response.json() as Problem })
// A second factor is checked after the mail server accepted the password; a later step always moves a fresh code past the enrollment step.
const nextCode = (steps: number) => computeTotpCode(secret, Date.now() + steps * 30_000)

describe('xMail sign-in for a mailbox with an authenticator', { tags: ['feature'] }, () => {
  it('asks for the factor after the password without counting a failure, and refuses a wrong code with its stable reason', async () => {
    const missing = await problem(await login())
    expect(missing).toMatchObject({ status: 401, code: 'UNAUTHENTICATED', details: { mfaRequired: true } })
    const wrongPassword = await problem(await login({ totpCode: nextCode(1) }, 'not-the-password'))
    expect(wrongPassword.status).toBe(401)
    expect(wrongPassword.details?.mfaRequired).toBeUndefined()
    expect(await problem(await login({ totpCode: '000000' }))).toMatchObject({ status: 401, code: 'UNAUTHENTICATED', details: { reason: 'invalid_totp' } })
    const accepted = await login({ totpCode: nextCode(1) })
    expect(((await accepted.clone().json()) as { session: { mfaVerified: boolean } }).session.mfaVerified).toBe(true)
    expect((await send('xmail', '/api/auth/me', { auth: await signedIn(accepted) })).status).toBe(200)
  })

  it('consumes a recovery code once', async () => {
    expect((await login({ recoveryCode: recoveryCodes[0]! })).status).toBe(200)
    expect(await problem(await login({ recoveryCode: recoveryCodes[0]! }))).toMatchObject({ status: 401, details: { reason: 'invalid_recovery_code' } })
  })

  it('lets the account owner open the mailbox through a handoff, which cannot change its credentials', async () => {
    const raw = randomBytes(32).toString('hex')
    await createSession(f.database.db, { principalId: f.aliceOwner.id, tokenHash: sessionTokenHash(raw, 'xpanel'), mfaVerified: true, expiresAt: new Date(Date.now() + 3600_000).toISOString() })
    const owner = { cookie: `${sessionCookieName('xpanel', true)}=${raw}`, csrf: deriveCsrfToken(raw, SECRET, 'xpanel') }
    const grant = await (await send('xpanel', '/api/handoff/xmail', { auth: owner, body: { mailbox: MAILBOX } })).json() as { token: string }
    const landed = await apps.xmail.fetch(new Request(ORIGIN.xmail + '/login/handoff', { method: 'POST', headers: { origin: ORIGIN.xpanel, 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=' + grant.token }))
    const cookie = (landed.headers.get('set-cookie') ?? '').split(';')[0]!
    const me = await send('xmail', '/api/auth/me', { auth: { cookie, csrf: '' } })
    expect(me.status).toBe(200)
    const auth = { cookie, csrf: ((await me.json()) as { csrfToken: string }).csrfToken }
    expect(await problem(await send('xmail', '/api/webmail/security/password', { auth, body: { currentPassword: PASSWORD, newPassword: 'Replacement!2026' } }))).toMatchObject({ status: 403, details: { reason: 'handoff_session' } })
  })

  // Last in the file: the lockout also counts this client address.
  it('counts wrong codes toward the sign-in lockout, after which even a right code is refused', async () => {
    let locked: Problem & { status: number } | null = null
    for (let attempt = 0; attempt < 10 && !locked; attempt++) {
      const answer = await problem(await login({ totpCode: '000000' }))
      if (answer.details?.lockedOut === true) locked = answer
      else expect(answer).toMatchObject({ status: 401, details: { reason: 'invalid_totp' } })
    }
    expect(locked).toMatchObject({ code: 'LOCKED_OUT', details: { lockedOut: true } })
    const after = await problem(await login({ totpCode: nextCode(1) }))
    expect(after.details?.lockedOut).toBe(true)
    expect([403, 429]).toContain(after.status)
  })
})
