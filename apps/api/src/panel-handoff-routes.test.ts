import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PhpSettings } from '@xpanel/core'
import { createResellerPrincipal, createRootPrincipal, createSession, createUserPrincipal } from '@xpanel/db'
import { deriveCsrfToken } from './auth.ts'
import { sessionCookieName, sessionTokenHash, type EntryPoint } from './entry-points.ts'
import { handoffTokenHash } from './panel-handoff-protocol.ts'
import { createDefaultWebRenderer } from './main.ts'
import { createApiApp, type ApiApp } from './server.ts'
import { createTeamFixture, MEMBER_PASSWORD, OWNER_PASSWORD, type TeamFixture } from './team-test-fixture.ts'

const SECRET = 'handoff-feature-fixture-server-secret-32-bytes'
const ORIGIN = { xpanel: 'https://panel.example.test:2083', xwhm: 'https://whm.example.test:2087', xmail: 'https://mail.example.test:2096' } as const
const HANDOFF = { xwhm: { targetOrigin: ORIGIN.xpanel }, xpanel: { targetOrigin: ORIGIN.xmail, issuerOrigin: ORIGIN.xwhm }, xmail: { issuerOrigin: ORIGIN.xpanel } } as const
const FAILED = '/login?handoff=failed'
// Public independent libargon2 vector; these identities exist only in this test.
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const PHP: PhpSettings = { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} }
type Auth = { cookie: string; csrf: string }

// One fixture for the file; a test that changes shared state restores it before it ends.
let f: TeamFixture
let apps: Record<EntryPoint, ApiApp>
let ids: { root: string; reseller: string; plainReseller: string; carol: string; dave: string; featureList: string }
beforeAll(async () => {
  f = await createTeamFixture()
  apps = Object.fromEntries((['xpanel', 'xwhm', 'xmail'] as const).map(entryPoint => [entryPoint, createApiApp({
    db: f.database.db, store: f.state.store, serverSecret: SECRET, entryPoint, publicOrigin: ORIGIN[entryPoint], allowedOrigins: [ORIGIN[entryPoint]],
    secureCookies: true, requireOriginHeader: true, handoff: HANDOFF[entryPoint],
  })])) as Record<EntryPoint, ApiApp>
  const root = await createRootPrincipal(f.database.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })
  const base = { passwordHash: HASH, maxAccounts: 10, totalDiskMb: 100000, totalBandwidthMb: 'unlimited' as const, oversell: false, nameservers: [], delegatedIps: ['192.0.2.10'] }
  const reseller = await f.state.store.createReseller({ ...base, username: 'resellerone', acl: ['list-accounts', 'edit-account'] })
  const plain = await f.state.store.createReseller({ ...base, username: 'resellertwo', acl: ['list-accounts'] })
  for (const item of [reseller, plain]) await createResellerPrincipal(f.database.db, { id: item.id, username: item.username, passwordHash: HASH })
  const accountInput = { passwordHash: HASH, planId: f.alice.planId, contactEmail: 'owner@example.test', ipv4: '192.0.2.10', shell: 'jailed' as const, php: PHP }
  const carol = await f.state.store.createAccount({ ...accountInput, username: 'carol', primaryDomain: 'carol.example.test', ownerId: reseller.id })
  const dave = await f.state.store.createAccount({ ...accountInput, username: 'davey', primaryDomain: 'dave.example.test', ownerId: plain.id })
  for (const account of [carol, dave]) await createUserPrincipal(f.database.db, { username: account.username, accountId: account.id, passwordHash: HASH })
  for (const [accountId, login, email] of [[f.alice.id, 'inbox@alice.example.test', true], [f.alice.id, 'files@alice.example.test', false], [f.bob.id, 'inbox@bob.example.test', true]] as const) {
    await f.state.store.createServiceUser({ accountId, login, services: { email, ftp: !email, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html', passwordHash: HASH })
  }
  await f.seed(f.alice.id, [f.member({ roles: ['email'] })])
  ids = { root: root.id, reseller: reseller.id, plainReseller: plain.id, carol: carol.id, dave: dave.id, featureList: (await f.state.store.getPlan(f.alice.planId))!.featureListId }
}, 60_000)
afterAll(async () => { await f.close() })

const session = async (principalId: string, entryPoint: EntryPoint): Promise<Auth> => {
  const raw = randomBytes(32).toString('hex')
  await createSession(f.database.db, { principalId, tokenHash: sessionTokenHash(raw, entryPoint), mfaVerified: true, expiresAt: new Date(Date.now() + 3600_000).toISOString() })
  return { cookie: `${sessionCookieName(entryPoint, true)}=${raw}`, csrf: deriveCsrfToken(raw, SECRET, entryPoint) }
}
const send = (entryPoint: EntryPoint, path: string, init: { method?: string; auth?: Auth; body?: unknown } = {}) => apps[entryPoint].fetch(new Request(ORIGIN[entryPoint] + path, {
  method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
  headers: { origin: ORIGIN[entryPoint], ...(init.auth ? { cookie: init.auth.cookie, 'x-csrf-token': init.auth.csrf } : {}), ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
  ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
}))
const issue = async (entryPoint: 'xwhm' | 'xpanel', auth: Auth, body: Record<string, unknown>) => {
  const response = await send(entryPoint, entryPoint === 'xwhm' ? '/api/handoff/xpanel' : '/api/handoff/xmail', { auth, body })
  return { response, grant: response.status === 201 ? await response.json() as { action: string; token: string; expiresAt: string } : null }
}
const consume = (entryPoint: 'xpanel' | 'xmail', token: string, origin: string = HANDOFF[entryPoint].issuerOrigin, body = `token=${token}`, type = 'application/x-www-form-urlencoded') =>
  apps[entryPoint].fetch(new Request(ORIGIN[entryPoint] + '/login/handoff', { method: 'POST', headers: { origin, 'content-type': type }, body }))
const landedAuth = async (entryPoint: 'xpanel' | 'xmail', response: Response): Promise<Auth> => {
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0]!
  const me = await send(entryPoint, '/api/auth/me', { auth: { cookie, csrf: '' } })
  return { cookie, csrf: me.ok ? ((await me.json()) as { csrfToken: string }).csrfToken : '' }
}
const teamLogin = async (): Promise<Auth> => {
  const response = await send('xpanel', '/api/auth/login', { body: { username: 'sam@alice.example.test', password: MEMBER_PASSWORD } })
  expect(response.status).toBe(200)
  return { cookie: (response.headers.get('set-cookie') ?? '').split(';')[0]!, csrf: ((await response.json()) as { csrfToken: string }).csrfToken }
}
const lastAuditId = async (): Promise<number> => (await f.database.db.query<{ id: number | null }>('SELECT max(id) AS id FROM audit_log'))[0]?.id ?? 0
const audits = async (action: string, after: number) => (await f.database.db.query<{ principal_id: string | null; target: string; detail: string }>(
  'SELECT principal_id, target, detail FROM audit_log WHERE action = $1 AND id > $2 ORDER BY id', [action, after])).map(row => ({ principalId: row.principal_id, target: row.target, detail: JSON.parse(row.detail) as Record<string, unknown> }))

describe('handoff issuance authorization', () => {
  it('lets root open any account and a reseller only its own accounts with edit-account', async () => {
    const root = await session(ids.root, 'xwhm')
    for (const accountId of [f.alice.id, ids.carol, ids.dave]) expect((await issue('xwhm', root, { accountId })).response.status).toBe(201)
    const reseller = await session(ids.reseller, 'xwhm')
    expect((await issue('xwhm', reseller, { accountId: ids.carol })).response.status).toBe(201)
    for (const accountId of [f.alice.id, ids.dave]) expect([403, 404]).toContain((await issue('xwhm', reseller, { accountId })).response.status)
    expect((await issue('xwhm', await session(ids.plainReseller, 'xwhm'), { accountId: ids.dave })).response.status).toBe(403)
    expect((await issue('xwhm', root, { accountId: f.alice.id, next: '/whm' })).response.status).toBe(422)
    expect((await send('xpanel', '/api/handoff/xpanel', { auth: await session(f.aliceOwner.id, 'xpanel'), body: { accountId: f.alice.id } })).status).toBe(404)
    expect((await issue('xwhm', await session(f.aliceOwner.id, 'xwhm'), { accountId: f.alice.id })).response.status).toBe(401)
  })

  it('answers with the configured target action, a 60 s expiry and no cacheable or referrable response', async () => {
    const mark = await lastAuditId()
    const { response, grant } = await issue('xwhm', await session(ids.root, 'xwhm'), { accountId: f.alice.id })
    expect(grant!.action).toBe(`${ORIGIN.xpanel}/login/handoff`)
    expect(grant!.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Date.parse(grant!.expiresAt) - Date.now()).toBeLessThanOrEqual(60_000)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    const rows = await f.database.db.query<Record<string, unknown>>('SELECT * FROM panel_handoffs WHERE token_hash = $1', [handoffTokenHash(grant!.token)])
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(await f.database.db.query('SELECT * FROM panel_handoffs'))).not.toContain(grant!.token)
    const issued = await audits('handoff.issued', mark)
    expect(issued).toMatchObject([{ principalId: ids.root, target: 'account:alice', detail: { audience: 'xpanel', targetPrincipalId: f.aliceOwner.id } }])
    expect(JSON.stringify(issued)).not.toContain(grant!.token)
  })

  it('lets the owner and an email team member open only an existing email mailbox of the same account', async () => {
    const owner = await session(f.aliceOwner.id, 'xpanel')
    expect((await issue('xpanel', owner, { mailbox: 'Inbox@Alice.Example.Test' })).response.status).toBe(201)
    for (const mailbox of ['inbox@bob.example.test', 'files@alice.example.test', 'missing@alice.example.test']) expect((await issue('xpanel', owner, { mailbox })).response.status, mailbox).toBe(404)
    expect((await issue('xpanel', owner, { mailbox: 'inbox@alice.example.test', landing: 'https://evil.example.test' })).response.status).toBe(422)
    const team = await teamLogin()
    expect((await issue('xpanel', team, { mailbox: 'inbox@alice.example.test', landing: 'calendar' })).response.status).toBe(201)
    try {
      await f.roles(f.alice.id, f.member().id, ['database'])
      expect((await issue('xpanel', team, { mailbox: 'inbox@alice.example.test' })).response.status).toBe(403)
    } finally { await f.roles(f.alice.id, f.member().id, ['email']) }
    try {
      await f.state.store.updateFeatureList(ids.featureList, { disabled: ['email-accounts'] })
      expect((await issue('xpanel', owner, { mailbox: 'inbox@alice.example.test' })).response.status).toBe(403)
    } finally { await f.state.store.updateFeatureList(ids.featureList, { disabled: [] }) }
  })
})

describe('handoff consumption on the target listener', () => {
  it('creates one impersonated session bound to xPanel only, then refuses replay', async () => {
    const mark = await lastAuditId()
    const { grant } = await issue('xwhm', await session(ids.root, 'xwhm'), { accountId: f.alice.id })
    const landed = await consume('xpanel', grant!.token)
    expect(landed.status).toBe(303)
    expect(landed.headers.get('location')).toBe('/panel')
    expect(landed.headers.get('cache-control')).toBe('no-store')
    expect(landed.headers.get('referrer-policy')).toBe('no-referrer')
    expect(landed.headers.get('set-cookie')).toMatch(/^__Host-xpanel_session=[0-9A-Za-z_-]+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=3600; Secure$/)
    const auth = await landedAuth('xpanel', landed)
    const me = await send('xpanel', '/api/auth/me', { auth })
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ principal: { kind: 'user', username: 'alice' } })
    const raw = auth.cookie.slice(auth.cookie.indexOf('=') + 1)
    for (const other of ['xwhm', 'xmail'] as const) expect((await send(other, '/api/auth/me', { auth: { cookie: `${sessionCookieName(other, true)}=${raw}`, csrf: '' } })).status).toBe(401)
    const [stored] = await f.database.db.query<{ impersonator_principal_id: string; impersonator_login: string; expires_at: string; created_at: string }>(
      'SELECT impersonator_principal_id, impersonator_login, expires_at, created_at FROM sessions WHERE token_hash = $1', [sessionTokenHash(raw, 'xpanel')])
    expect(stored).toMatchObject({ impersonator_principal_id: ids.root, impersonator_login: 'root' })
    expect(Date.parse(stored!.expires_at) - Date.parse(stored!.created_at)).toBeLessThanOrEqual(3600_000)
    expect((await consume('xpanel', grant!.token)).headers.get('location')).toBe(FAILED)
    expect(await audits('handoff.consumed', mark)).toMatchObject([{ principalId: f.aliceOwner.id, target: 'principal:alice', detail: { impersonator: { principalId: ids.root, login: 'root' }, audience: 'xpanel' } }])
    expect((await audits('handoff.refused', mark)).map(entry => entry.detail.reason)).toEqual(['consumed'])
  })

  it('refuses a wrong Origin, the wrong audience, a malformed body and an expired link without opening a session', async () => {
    const root = await session(ids.root, 'xwhm')
    const { grant } = await issue('xwhm', root, { accountId: f.alice.id })
    const mark = await lastAuditId()
    const sessions = async () => (await f.database.db.query<{ n: number }>('SELECT count(*) AS n FROM sessions WHERE impersonator_principal_id IS NOT NULL'))[0]!.n
    const before = await sessions()
    for (const attempt of [
      () => consume('xpanel', grant!.token, ORIGIN.xpanel), () => consume('xpanel', grant!.token, 'https://evil.example.test'),
      () => consume('xmail', grant!.token), () => consume('xpanel', grant!.token, ORIGIN.xwhm, `token=${grant!.token}&next=/whm`),
      () => consume('xpanel', grant!.token, ORIGIN.xwhm, JSON.stringify({ token: grant!.token }), 'application/json'),
    ]) {
      const response = await attempt()
      expect(response.status).toBe(303)
      expect(response.headers.get('location')).toBe(FAILED)
      expect(response.headers.get('set-cookie')).toBeNull()
    }
    expect(await sessions()).toBe(before)
    // None of those refusals spent the link: the issuing panel's own post still opens it once.
    expect((await consume('xpanel', grant!.token)).headers.get('location')).toBe('/panel')
    const late = (await issue('xwhm', root, { accountId: f.alice.id })).grant!
    await f.database.db.query('UPDATE panel_handoffs SET created_at = $1, expires_at = $2 WHERE token_hash = $3', [new Date(Date.now() - 120_000).toISOString(), new Date(Date.now() - 60_000).toISOString(), handoffTokenHash(late.token)])
    expect((await consume('xpanel', late.token)).headers.get('location')).toBe(FAILED)
    expect((await audits('handoff.refused', mark)).map(entry => entry.detail.reason).sort()).toEqual(['audience', 'expired', 'malformed', 'malformed', 'origin', 'origin'])
  })

  it('refuses a link whose target account was suspended or whose reseller lost the right after issuance', async () => {
    const mark = await lastAuditId()
    const { grant } = await issue('xwhm', await session(ids.root, 'xwhm'), { accountId: f.alice.id })
    try {
      await f.state.store.suspendAccount(f.alice.id, 'handoff fixture')
      expect((await consume('xpanel', grant!.token)).headers.get('location')).toBe(FAILED)
    } finally { await f.state.store.unsuspendAccount(f.alice.id) }
    const resold = await issue('xwhm', await session(ids.reseller, 'xwhm'), { accountId: ids.carol })
    try {
      await f.state.store.updateReseller(ids.reseller, { acl: ['list-accounts'] })
      expect((await consume('xpanel', resold.grant!.token)).headers.get('location')).toBe(FAILED)
    } finally { await f.state.store.updateReseller(ids.reseller, { acl: ['list-accounts', 'edit-account'] }) }
    expect((await audits('handoff.refused', mark)).map(entry => entry.detail.reason)).toEqual(['target', 'issuer'])
  })

  it('opens a credential-free mailbox session on xMail at the requested landing and keeps IMAP reads unavailable', async () => {
    const mark = await lastAuditId()
    const { grant } = await issue('xpanel', await session(f.aliceOwner.id, 'xpanel'), { mailbox: 'inbox@alice.example.test', landing: 'calendar' })
    expect(grant!.action).toBe(`${ORIGIN.xmail}/login/handoff`)
    const landed = await consume('xmail', grant!.token)
    expect(landed.headers.get('location')).toBe('/mail/calendar')
    const auth = await landedAuth('xmail', landed)
    expect(auth.cookie.startsWith('__Host-xmail_session=')).toBe(true)
    expect((await send('xmail', '/api/auth/me', { auth })).status).toBe(200)
    const inbox = await send('xmail', '/api/webmail/inbox', { auth })
    expect(inbox.status).toBe(503)
    expect(JSON.stringify(await inbox.json())).toContain('mailboxCredential')
    expect(await audits('handoff.consumed', mark)).toMatchObject([{ target: 'mailbox:inbox@alice.example.test', detail: { audience: 'xmail', impersonator: { principalId: f.aliceOwner.id, login: 'alice' } } }])
  })
})

describe('mid-session revocation of a handed-off session', () => {
  const me = async (entryPoint: 'xpanel' | 'xmail', auth: Auth) => (await send(entryPoint, '/api/auth/me', { auth })).status
  const revokedAt = async (entryPoint: 'xpanel' | 'xmail', auth: Auth) => (await f.database.db.query<{ revoked_at: string | null }>(
    'SELECT revoked_at FROM sessions WHERE token_hash = $1', [sessionTokenHash(auth.cookie.slice(auth.cookie.indexOf('=') + 1), entryPoint)]))[0]?.revoked_at ?? null
  const openXpanel = async (issuer: Auth, accountId: string) => landedAuth('xpanel', await consume('xpanel', (await issue('xwhm', issuer, { accountId })).grant!.token))
  const openXmail = async (issuer: Auth, mailbox: string) => landedAuth('xmail', await consume('xmail', (await issue('xpanel', issuer, { mailbox })).grant!.token))

  it('ends only its own session when the reseller loses edit-account, and stays ended after the right returns', async () => {
    const reseller = await session(ids.reseller, 'xwhm')
    const handed = await openXpanel(reseller, ids.carol)
    const other = await openXpanel(await session(ids.root, 'xwhm'), f.alice.id)
    expect(await me('xpanel', handed)).toBe(200)
    try {
      await f.state.store.updateReseller(ids.reseller, { acl: ['list-accounts'] })
      expect(await me('xpanel', handed)).toBe(401)
      expect(await revokedAt('xpanel', handed)).not.toBeNull()
    } finally { await f.state.store.updateReseller(ids.reseller, { acl: ['list-accounts', 'edit-account'] }) }
    expect(await me('xpanel', handed)).toBe(401)
    expect(await me('xpanel', other)).toBe(200)
    expect((await send('xwhm', '/api/auth/me', { auth: reseller })).status).toBe(200)
  })

  it('ends the session when the reseller no longer owns the account', async () => {
    const handed = await openXpanel(await session(ids.reseller, 'xwhm'), ids.carol)
    expect(await me('xpanel', handed)).toBe(200)
    try {
      await f.state.store.changeOwner(ids.carol, null)
      expect(await me('xpanel', handed)).toBe(401)
    } finally { await f.state.store.changeOwner(ids.carol, ids.reseller) }
    expect(await revokedAt('xpanel', handed)).not.toBeNull()
  })

  it('ends the session and sends documents to this panel sign-in when the target account is suspended', async () => {
    const handed = await openXpanel(await session(ids.root, 'xwhm'), f.alice.id)
    expect(await me('xpanel', handed)).toBe(200)
    const render = await createDefaultWebRenderer({ store: f.state.store, db: f.database.db, serverSecret: SECRET, entryPoint: 'xpanel', publicOrigin: ORIGIN.xpanel })
    try {
      await f.state.store.suspendAccount(f.alice.id, 'handoff mid-session fixture')
      const page = await render(new Request(ORIGIN.xpanel + '/panel', { headers: { cookie: handed.cookie } }))
      expect(page.status).toBe(303)
      expect(page.headers.get('location')).toBe('/login')
      expect(await revokedAt('xpanel', handed)).not.toBeNull()
    } finally { await f.state.store.unsuspendAccount(f.alice.id) }
    expect(await me('xpanel', handed)).toBe(401)
  })

  it('ends an xMail session when the issuing team member loses the email role', async () => {
    const handed = await openXmail(await teamLogin(), 'inbox@alice.example.test')
    expect(await me('xmail', handed)).toBe(200)
    try {
      await f.roles(f.alice.id, f.member().id, ['database'])
      expect(await me('xmail', handed)).toBe(401)
      expect(await revokedAt('xmail', handed)).not.toBeNull()
    } finally { await f.roles(f.alice.id, f.member().id, ['email']) }
    expect(await me('xmail', handed)).toBe(401)
  })

  it('ends an xMail session when its mailbox is deleted', async () => {
    const mailbox = await f.state.store.createServiceUser({ accountId: f.alice.id, login: 'temporary@alice.example.test', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html', passwordHash: HASH })
    const handed = await openXmail(await session(f.aliceOwner.id, 'xpanel'), mailbox.login)
    expect(await me('xmail', handed)).toBe(200)
    await f.state.store.deleteServiceUser(mailbox.id)
    expect(await me('xmail', handed)).toBe(401)
    expect(await revokedAt('xmail', handed)).not.toBeNull()
  })
})

describe('impersonated sessions and xMail confinement', () => {
  it('cannot change the target sign-in identity or open another panel, and audits both principals', async () => {
    const { grant } = await issue('xwhm', await session(ids.root, 'xwhm'), { accountId: f.alice.id })
    const auth = await landedAuth('xpanel', await consume('xpanel', grant!.token))
    const mark = await lastAuditId()
    for (const [method, path, body] of [
      ['POST', '/api/auth/change-password', { currentPassword: OWNER_PASSWORD, newPassword: 'Another-password-2026' }], ['POST', '/api/auth/2fa/setup', { password: OWNER_PASSWORD }],
      ['PATCH', '/api/account/preferences', { contactEmail: 'new@alice.example.test', expectedRevision: 'a'.repeat(64) }], ['POST', '/api/account/team', {}],
      ['POST', '/api/handoff/xmail', { mailbox: 'inbox@alice.example.test' }],
    ] as const) {
      expect((await send('xpanel', path, { method, auth, body })).status, `${method} ${path}`).toBe(403)
    }
    expect((await send('xpanel', '/api/auth/logout', { method: 'POST', auth, body: {} })).status).toBe(200)
    expect(await audits('auth.logout', mark)).toMatchObject([{ principalId: f.aliceOwner.id, detail: { impersonator: { principalId: ids.root, login: 'root' } } }])
  })

  it('shows who opened the session on every document of a handed-off session and nowhere else', async () => {
    const xpanel = await createDefaultWebRenderer({ store: f.state.store, db: f.database.db, serverSecret: SECRET, entryPoint: 'xpanel', publicOrigin: ORIGIN.xpanel })
    const page = async (render: typeof xpanel, origin: string, path: string, cookie: string) => (await render(new Request(origin + path, { headers: { cookie } }))).text()
    const owner = await landedAuth('xpanel', await consume('xpanel', (await issue('xwhm', await session(ids.root, 'xwhm'), { accountId: f.alice.id })).grant!.token))
    for (const path of ['/panel', '/not-a-page']) {
      const html = await page(xpanel, ORIGIN.xpanel, path, owner.cookie)
      expect(html, path).toContain('Signed in as <bdi dir="ltr">alice</bdi> by <bdi dir="ltr">root</bdi>')
      expect(html, path).toContain('data-impersonation-end')
    }
    expect(await page(xpanel, ORIGIN.xpanel, '/panel', (await session(f.aliceOwner.id, 'xpanel')).cookie)).not.toContain('data-impersonation')
    const xmail = await createDefaultWebRenderer({ store: f.state.store, db: f.database.db, serverSecret: SECRET, entryPoint: 'xmail', publicOrigin: ORIGIN.xmail })
    const mailbox = await landedAuth('xmail', await consume('xmail', (await issue('xpanel', await session(f.aliceOwner.id, 'xpanel'), { mailbox: 'inbox@alice.example.test' })).grant!.token))
    expect(await page(xmail, ORIGIN.xmail, '/mail/inbox', mailbox.cookie)).toContain('Signed in as <bdi dir="ltr">inbox@alice.example.test</bdi> by <bdi dir="ltr">alice</bdi>')
  })

  it('refuses owner credentials and owner sessions on xMail', async () => {
    const login = await send('xmail', '/api/auth/login', { body: { username: 'alice', password: OWNER_PASSWORD } })
    expect(login.status).toBe(401)
    expect(login.headers.get('set-cookie')).toBeNull()
    expect((await send('xmail', '/api/auth/me', { auth: await session(f.aliceOwner.id, 'xmail') })).status).toBe(401)
  })
})
