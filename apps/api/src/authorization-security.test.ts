import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Account, PhpSettings } from '@xpanel/core'
import { createApiToken, createResellerPrincipal, createRootPrincipal, createTestDb, createUserPrincipal, getPrincipal, setTotpSecret, setPasswordHash } from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import { atomicWriteJson, createTestStateStore } from '@xpanel/state'
import type { TestStateStoreHandle } from '@xpanel/state'
import { join } from 'node:path'
import { hashPasswordArgon2id, sha256Hex, sealTotpSecret } from './auth.ts'
import { createApiApp, listenApiServer } from './server.ts'
import type { ApiApp } from './server.ts'

const SERVER_SECRET = 'test-only-authorization-server-secret-at-least-32-bytes'
const php: PhpSettings = { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} }
let passwordHash: string
beforeAll(async () => { passwordHash = await hashPasswordArgon2id('GeneratedFixturePassword!') })

describe('HTTP authorization security regressions', () => {
  let db: TestDbHandle
  let state: TestStateStoreHandle
  let app: ApiApp
  let alice: Account
  let bob: Account
  let rootId: string
  let aliceId: string
  let featureListId: string

  beforeEach(async () => {
    db = await createTestDb()
    state = await createTestStateStore()
    rootId = (await createRootPrincipal(db.db, { username: 'root', passwordHash, forcePasswordChange: false })).id
    await setTotpSecret(db.db, rootId, sealTotpSecret('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', SERVER_SECRET), [])
    featureListId = (await state.store.createFeatureList({ name: 'Fixture features', ownerId: null, disabled: [] })).id
    const plan = await state.store.createPlan({ name: 'Fixture plan', ownerId: null, featureListId, resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 }, caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 10, forwarders: 10, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
    alice = await state.store.createAccount({ username: 'alice', passwordHash, primaryDomain: 'alice.example.test', planId: plan.id, ownerId: null, contactEmail: 'owner@alice.example.test', ipv4: '192.0.2.10', shell: 'none', php })
    bob = await state.store.createAccount({ username: 'bobby', passwordHash, primaryDomain: 'bob.example.test', planId: plan.id, ownerId: null, contactEmail: 'owner@bob.example.test', ipv4: '192.0.2.10', shell: 'none', php })
    aliceId = (await createUserPrincipal(db.db, { username: alice.username, accountId: alice.id, passwordHash })).id
    for (const account of [alice, bob]) await state.store.createServiceUser({ accountId: account.id, login: `inbox@${account.primaryDomain}`, passwordHash: `{ARGON2ID}${passwordHash}`, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html' })
    app = createApiApp({ db: db.db, store: state.store, serverSecret: SERVER_SECRET })
  })

  afterEach(async () => { await state.close(); await db.close() })

  const tokenFor = async (principalId: string, scopes: string[]) => {
    const raw = `xp_${randomUUID()}`
    await createApiToken(db.db, { principalId, name: 'Fixture token', tokenHash: sha256Hex(raw), scopes, expiresAt: new Date(Date.now() + 60000).toISOString() })
    return raw
  }
  const request = (token: string, path: string, method = 'GET', body?: unknown) => app.fetch(new Request(`http://localhost${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }))
  const login = (username = 'alice', password = 'GeneratedFixturePassword!') => app.fetch(new Request('http://localhost/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) }))
  const sessionRequest = (cookie: string, csrf: string, path: string, method = 'GET', body?: unknown) => app.fetch(new Request(`http://localhost${path}`, { method, headers: { cookie, 'x-csrf-token': csrf, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }))

  it('forced password change confines both bearer and interactive callers to password recovery', async () => {
    await setPasswordHash(db.db, aliceId, passwordHash, { forceChange: true })
    const token = await tokenFor(aliceId, ['*'])
    const protectedRead = await request(token, '/api/domains')
    expect(protectedRead.status).toBe(403)
    expect(await protectedRead.json()).toMatchObject({ details: { passwordChangeRequired: true } })
    const signedIn = await login()
    expect(signedIn.status).toBe(200)
    const body = await signedIn.json() as { csrfToken: string; passwordChangeRequired: boolean }
    expect(body.passwordChangeRequired).toBe(true)
    const cookie = signedIn.headers.get('set-cookie')!.split(';')[0]!
    const me = await sessionRequest(cookie, body.csrfToken, '/api/auth/me')
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ passwordChangeRequired: true, mfaEnrollmentRequired: false })
    for (const path of ['/api/domains', '/api/events/recent']) expect((await sessionRequest(cookie, body.csrfToken, path)).status).toBe(403)
    expect((await sessionRequest(cookie, body.csrfToken, '/api/auth/2fa/setup', 'POST', { password: 'GeneratedFixturePassword!' })).status).toBe(403)
    expect((await request(token, '/api/auth/change-password', 'POST', { currentPassword: 'GeneratedFixturePassword!', newPassword: 'ReplacementFixturePassword!' })).status).toBe(403)
  })

  it('password change needs JSON, session CSRF and fresh current password then requires a new login', async () => {
    await setPasswordHash(db.db, aliceId, passwordHash, { forceChange: true })
    const signedIn = await login()
    const { csrfToken } = await signedIn.json() as { csrfToken: string }
    const cookie = signedIn.headers.get('set-cookie')!.split(';')[0]!
    const sibling = await login()
    const siblingCookie = sibling.headers.get('set-cookie')!.split(';')[0]!
    const oldToken = await tokenFor(aliceId, ['*'])
    const change = { currentPassword: 'GeneratedFixturePassword!', newPassword: 'ReplacementFixturePassword!' }
    expect((await sessionRequest(cookie, '', '/api/auth/change-password', 'POST', change)).status).toBe(403)
    const form = await app.fetch(new Request('http://localhost/api/auth/change-password', { method: 'POST', headers: { cookie, 'x-csrf-token': csrfToken, 'content-type': 'text/plain' }, body: JSON.stringify(change) }))
    expect(form.status).toBe(415)
    expect((await sessionRequest(cookie, csrfToken, '/api/auth/change-password', 'POST', { ...change, forcePasswordChange: false })).status).toBe(422)
    expect((await sessionRequest(cookie, csrfToken, '/api/auth/change-password', 'POST', { ...change, newPassword: change.currentPassword })).status).toBe(422)
    expect((await sessionRequest(cookie, csrfToken, '/api/auth/change-password', 'POST', { ...change, newPassword: 'short' })).status).toBe(422)
    expect((await sessionRequest(cookie, csrfToken, '/api/auth/change-password', 'POST', { ...change, currentPassword: 'IncorrectFixturePassword!' })).status).toBe(401)
    expect((await getPrincipal(db.db, aliceId))?.forcePasswordChange).toBe(true)
    const changed = await sessionRequest(cookie, csrfToken, '/api/auth/change-password', 'POST', change)
    expect(changed.status).toBe(200)
    expect(await changed.json()).toEqual({ ok: true, reauthenticationRequired: true })
    expect(changed.headers.get('set-cookie')).toContain('Max-Age=0')
    const principal = await getPrincipal(db.db, aliceId)
    expect(principal?.forcePasswordChange).toBe(false)
    expect(principal?.passwordHash).not.toBe(passwordHash)
    expect((await sessionRequest(cookie, csrfToken, '/api/auth/me')).status).toBe(401)
    expect((await sessionRequest(siblingCookie, '', '/api/auth/me')).status).toBe(401)
    expect((await request(oldToken, '/api/domains')).status).toBe(401)
    expect((await login()).status).toBe(401)
    const fresh = await login('alice', change.newPassword)
    expect(fresh.status).toBe(200)
    expect(await fresh.json()).toMatchObject({ passwordChangeRequired: false })
    const freshCookie = fresh.headers.get('set-cookie')!.split(';')[0]!
    expect((await sessionRequest(freshCookie, '', '/api/domains')).status).toBe(200)
  })

  it('root forced-password recovery preserves enabled MFA and cannot use password-only login', async () => {
    const recovery = 'fixture-recovery-code-128-bits-at-least'
    const sealed = sealTotpSecret('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', SERVER_SECRET)
    await setTotpSecret(db.db, rootId, sealed, [sha256Hex(recovery)])
    await setPasswordHash(db.db, rootId, passwordHash, { forceChange: true })
    const denied = await login('root')
    expect(denied.status).toBe(401)
    expect(await denied.json()).toMatchObject({ details: { mfaRequired: true } })
    const signedIn = await app.fetch(new Request('http://localhost/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'root', password: 'GeneratedFixturePassword!', recoveryCode: recovery }) }))
    expect(signedIn.status).toBe(200)
    const auth = await signedIn.json() as { csrfToken: string }
    const cookie = signedIn.headers.get('set-cookie')!.split(';')[0]!
    const changed = await sessionRequest(cookie, auth.csrfToken, '/api/auth/change-password', 'POST', { currentPassword: 'GeneratedFixturePassword!', newPassword: 'ReplacementRootPassword!' })
    expect(changed.status).toBe(200)
    const root = await getPrincipal(db.db, rootId)
    expect(root?.totpEnabled).toBe(true)
    expect(root?.totpSecretEnc).toEqual(sealed)
    expect(root?.forcePasswordChange).toBe(false)
    const passwordOnly = await login('root', 'ReplacementRootPassword!')
    expect(passwordOnly.status).toBe(401)
    expect(await passwordOnly.json()).toMatchObject({ details: { mfaRequired: true } })
  })

  it('unenrolled root must change bootstrap password first and still enroll MFA after relogin', async () => {
    await setTotpSecret(db.db, rootId, null, [])
    await setPasswordHash(db.db, rootId, passwordHash, { forceChange: true })
    const signedIn = await login('root')
    const auth = await signedIn.json() as { csrfToken: string }
    expect(auth).toMatchObject({ passwordChangeRequired: true, mfaEnrollmentRequired: true })
    const cookie = signedIn.headers.get('set-cookie')!.split(';')[0]!
    expect((await sessionRequest(cookie, auth.csrfToken, '/api/auth/2fa/setup', 'POST', { password: 'GeneratedFixturePassword!' })).status).toBe(403)
    expect((await sessionRequest(cookie, auth.csrfToken, '/api/auth/change-password', 'POST', { currentPassword: 'GeneratedFixturePassword!', newPassword: 'ReplacementRootPassword!' })).status).toBe(200)
    const fresh = await login('root', 'ReplacementRootPassword!')
    const next = await fresh.json() as { csrfToken: string }
    expect(next).toMatchObject({ passwordChangeRequired: false, mfaEnrollmentRequired: true })
    const freshCookie = fresh.headers.get('set-cookie')!.split(';')[0]!
    expect((await sessionRequest(freshCookie, next.csrfToken, '/api/domains')).status).toBe(403)
    expect((await sessionRequest(freshCookie, next.csrfToken, '/api/auth/2fa/setup', 'POST', { password: 'ReplacementRootPassword!' })).status).toBe(200)
  })

  it('password change cannot overwrite a reset committed after its session credential snapshot', async () => {
    await setPasswordHash(db.db, aliceId, passwordHash, { forceChange: true })
    const signedIn = await login()
    const { csrfToken } = await signedIn.json() as { csrfToken: string }
    const cookie = signedIn.headers.get('set-cookie')!.split(';')[0]!
    const adminHash = await hashPasswordArgon2id('AuthoritativeAdminResetPassword!')
    let signalSnapshot: () => void = () => {}
    const snapshot = new Promise<void>(resolve => { signalSnapshot = resolve })
    let releaseSnapshot: () => void = () => {}
    const resume = new Promise<void>(resolve => { releaseSnapshot = resolve })
    let armed = true
    const traced = new Proxy(db.db, { get(target, key) {
      const value = Reflect.get(target, key)
      if (key === 'query') return async (...args: Parameters<typeof target.query>) => {
        const rows = await target.query(...args)
        if (armed && /FROM\s+principals\s+WHERE\s+id\s*=/i.test(args[0])) {
          armed = false
          signalSnapshot()
          await resume
        }
        return rows
      }
      return typeof value === 'function' ? value.bind(target) : value
    } })
    const concurrent = createApiApp({ db: traced, store: state.store, serverSecret: SERVER_SECRET })
    const changing = concurrent.fetch(new Request('http://localhost/api/auth/change-password', { method: 'POST', headers: { cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword: 'GeneratedFixturePassword!', newPassword: 'StaleCallerReplacementPassword!' }) }))
    await snapshot
    await setPasswordHash(db.db, aliceId, adminHash, { forceChange: true })
    releaseSnapshot()
    expect((await changing).status).toBe(401)
    expect((await getPrincipal(db.db, aliceId))?.passwordHash).toBe(adminHash)
    expect((await getPrincipal(db.db, aliceId))?.forcePasswordChange).toBe(true)
  })

  it('root read-only token cannot create feature lists and rejection has no state mutation', async () => {
    const token = await tokenFor(rootId, ['audit:read'])
    const before = await state.store.listFeatureLists()
    expect((await request(token, '/api/feature-lists', 'POST', { name: 'Unauthorized', ownerId: null, disabled: [] })).status).toBe(403)
    expect(await state.store.listFeatureLists()).toEqual(before)
    expect((await request(token, '/api/audit')).status).toBe(200)
  })

  it('empty token scopes deny protected reads while explicit resource scopes allow their own action', async () => {
    expect((await request(await tokenFor(rootId, []), '/api/accounts')).status).toBe(403)
    expect((await request(await tokenFor(rootId, ['accounts:read']), '/api/accounts')).status).toBe(200)
    expect((await request(await tokenFor(rootId, ['accounts:read']), '/api/accounts', 'POST', {})).status).toBe(403)
  })

  it('owned resources remain protected by reseller ACL and account feature policy', async () => {
    const reseller = await state.store.createReseller({ username: 'resell', passwordHash, acl: [], maxAccounts: 5, totalDiskMb: 10000, totalBandwidthMb: 100000, oversell: false, nameservers: [], delegatedIps: [] })
    await createResellerPrincipal(db.db, { id: reseller.id, username: reseller.username, passwordHash })
    await state.store.changeOwner(alice.id, reseller.id)
    const resellerToken = await tokenFor(reseller.id, ['*'])
    expect((await request(resellerToken, `/api/accounts/${alice.id}`)).status).toBe(403)
    await state.store.updateReseller(reseller.id, { acl: ['list-accounts'] })
    expect((await request(resellerToken, `/api/accounts/${alice.id}`)).status).toBe(200)
    expect((await request(resellerToken, `/api/accounts/${alice.id}`, 'PATCH', { contactEmail: 'changed@example.test' })).status).toBe(403)
    await state.store.updateFeatureList(featureListId, { disabled: ['mysql'] })
    const aliceToken = await tokenFor(aliceId, ['*'])
    expect((await request(aliceToken, '/api/databases', 'POST', { name: 'private' })).status).toBe(403)
    expect(await state.store.listDatabases(alice.id)).toEqual([])
  })

  it('webmail messages and search never enumerate another account mailbox', async () => {
    const own = `inbox@${alice.primaryDomain}`
    const foreign = `inbox@${bob.primaryDomain}`
    const base = { id: randomUUID(), folder: 'INBOX', from: 'sender@example.test', to: [own], cc: [], bcc: [], subject: 'marker', textBody: 'private marker', htmlBody: '', attachments: [], identityId: null, read: false, starred: false, sentAt: new Date().toISOString() }
    await atomicWriteJson(join(state.rootDir, 'extended/webmail/messages.json'), [{ ...base, mailbox: own }, { ...base, id: randomUUID(), mailbox: foreign, textBody: 'FOREIGN_MARKER' }])
    const token = await tokenFor(aliceId, ['webmail:read'])
    for (const path of ['/api/webmail/messages', '/api/webmail/search?q=marker']) {
      const res = await request(token, path)
      expect(res.status).toBe(200)
      const content = await res.text()
      expect(content).toContain('private marker')
      expect(content).not.toContain('FOREIGN_MARKER')
      const denied = await request(token, `${path}${path.includes('?') ? '&' : '?'}mailbox=${encodeURIComponent(foreign)}`)
      expect(denied.status).toBe(404)
      expect(await denied.text()).not.toContain('FOREIGN_MARKER')
    }
  })

  it('foreign identity deletion and forged sender cannot mutate shared webmail state', async () => {
    const own = `inbox@${alice.primaryDomain}`
    const foreign = `inbox@${bob.primaryDomain}`
    const identity = { id: randomUUID(), mailbox: foreign, email: foreign, displayName: 'Other', replyTo: foreign, textSignature: '', htmlSignature: '', isDefault: true, createdAt: new Date().toISOString() }
    await atomicWriteJson(join(state.rootDir, 'extended/webmail/identities.json'), [identity])
    const token = await tokenFor(aliceId, ['webmail:*'])
    expect((await request(token, `/api/webmail/identities/${identity.id}`, 'DELETE')).status).toBe(404)
    expect((await request(token, '/api/webmail/messages', 'POST', { mailbox: own, from: foreign, to: [own] })).status).toBe(403)
    expect((await request(await tokenFor(rootId, ['webmail:read']), `/api/webmail/identities?mailbox=${encodeURIComponent(foreign)}`)).status).toBe(200)
  })

  it('DNS mutation cannot replace a foreign zone owner by supplying an owned account id', async () => {
    await state.store.saveDnsZone({ id: randomUUID(), name: bob.primaryDomain, accountId: bob.id, serial: 1, records: [] })
    const token = await tokenFor(aliceId, ['dns:*'])
    expect((await request(token, `/api/dns/zones/${bob.primaryDomain}`, 'PUT', { accountId: alice.id, records: [] })).status).toBe(404)
    expect((await state.store.getDnsZone(bob.primaryDomain))?.accountId).toBe(bob.id)
    expect((await request(token, '/api/dns/templates/apply', 'POST', { domain: bob.primaryDomain, accountId: alice.id })).status).toBe(404)
  })

  it('suspended account credentials cannot read or write protected resources', async () => {
    await state.store.suspendAccount(alice.id, 'Fixture suspension')
    const token = await tokenFor(aliceId, ['*'])
    expect((await request(token, '/api/domains')).status).toBe(403)
    expect((await request(token, '/api/databases', 'POST', { name: 'private' })).status).toBe(403)
    expect(await state.store.listDatabases(alice.id)).toEqual([])
  })

  it('email and FTP capabilities are gated independently and service verifiers never appear in reads', async () => {
    const token = await tokenFor(aliceId, ['*'])
    await state.store.updateFeatureList(featureListId, { disabled: ['email-accounts'] })
    const body = { login: `newbox@${alice.primaryDomain}`, passwordHash: `{ARGON2ID}${passwordHash}`, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html' }
    expect((await request(token, '/api/service-users', 'POST', body)).status).toBe(403)
    expect((await request(token, '/api/service-users', 'POST', { ...body, login: `ftpone@${alice.primaryDomain}`, services: { email: false, ftp: true, webdisk: false } })).status).toBe(201)
    await state.store.updateFeatureList(featureListId, { disabled: ['ftpaccts'] })
    expect((await request(token, '/api/service-users', 'POST', { ...body, login: `ftptwo@${alice.primaryDomain}`, services: { email: false, ftp: true, webdisk: false } })).status).toBe(403)
    const response = await request(await tokenFor(rootId, ['service-users:read']), '/api/service-users')
    expect(response.status).toBe(200)
    expect(await response.text()).not.toContain('passwordHash')
  })

  it('extended mail and PostgreSQL lists and deletion are restricted by persisted account ownership', async () => {
    const own = { id: randomUUID(), accountId: alice.id, sourceAddress: `team@${alice.primaryDomain}`, destinations: ['visible@example.test'], createdAt: new Date().toISOString() }
    const foreign = { ...own, id: randomUUID(), accountId: bob.id, sourceAddress: `secret@${bob.primaryDomain}`, destinations: ['FOREIGN_ADDRESS@example.test'] }
    await atomicWriteJson(join(state.rootDir, 'extended/mail/forwarders.json'), [own, foreign])
    const pgOwn = { id: randomUUID(), accountId: alice.id, name: 'alice_owned', encoding: 'UTF8', locale: 'C', extensions: [], compiledSql: '', createdAt: new Date().toISOString() }
    const pgForeign = { ...pgOwn, id: randomUUID(), accountId: bob.id, name: 'bobby_FOREIGN_DATABASE' }
    await atomicWriteJson(join(state.rootDir, 'extended/databases/postgres-dbs.json'), [pgOwn, pgForeign])
    const token = await tokenFor(aliceId, ['*'])
    const forwarders = await request(token, '/api/mail/forwarders')
    expect(forwarders.status).toBe(200)
    expect(await forwarders.text()).not.toContain('FOREIGN_ADDRESS')
    expect((await request(token, `/api/mail/forwarders/${foreign.id}`, 'DELETE')).status).toBe(404)
    const postgres = await request(token, '/api/databases/postgres')
    expect(postgres.status).toBe(200)
    expect(await postgres.text()).not.toContain('FOREIGN_DATABASE')
    expect((await request(token, `/api/databases/postgres/${pgForeign.id}`, 'DELETE')).status).toBe(404)
    expect((await request(token, `/api/databases/postgres/${pgOwn.id}`, 'DELETE')).status).toBe(200)
  })

  it('malformed JSON is rejected without creating a feature list or falling back to an empty request', async () => {
    const token = await tokenFor(rootId, ['feature-lists:write'])
    const before = await state.store.listFeatureLists()
    const response = await app.fetch(new Request('http://localhost/api/feature-lists', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{broken' }))
    expect(response.status).toBe(422)
    expect(await state.store.listFeatureLists()).toEqual(before)
  })

  it('login refuses cross-site form media and known proxy identity cannot degrade to an unknown source', async () => {
    const body = JSON.stringify({ username: 'alice', password: 'GeneratedFixturePassword!', x: '=' })
    const form = await app.fetch(new Request('http://localhost/api/auth/login', { method: 'POST', headers: { 'content-type': 'text/plain' }, body }))
    expect(form.status).toBe(415)
    expect(form.headers.get('set-cookie')).toBeNull()
    const proxied = createApiApp({ db: db.db, store: state.store, serverSecret: SERVER_SECRET, trustedProxyAddresses: ['192.0.2.200'] })
    const badForwarding = await proxied.fetch(new Request('http://localhost/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': 'invalid, 198.51.100.4' }, body }), { remoteAddress: '192.0.2.200' })
    expect(badForwarding.status).toBe(401)
    expect(badForwarding.headers.get('set-cookie')).toBeNull()
  })

  it('real HTTP rejects oversized unauthenticated request bodies before parsing credentials', async () => {
    const server = await listenApiServer(app)
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(1024 * 1024 + 1) })
      expect(response.status).toBe(413)
      expect(response.headers.get('set-cookie')).toBeNull()
    } finally { await server.close() }
  })

  it('a password reset after credential lookup cannot issue a stale native-verified login session', async () => {
    const newHash = await hashPasswordArgon2id('ReplacementFixturePassword!')
    let releaseLookup: () => void = () => {}
    const observedLookup = new Promise<void>(resolve => { releaseLookup = resolve })
    let resumeLookup: () => void = () => {}
    const resume = new Promise<void>(resolve => { resumeLookup = resolve })
    const traced = new Proxy(db.db, { get(target, key) {
      const value = Reflect.get(target, key)
      if (key === 'query') return async (...args: Parameters<typeof target.query>) => {
        const rows = await target.query(...args)
        if (/FROM\s+principals[\s\S]*lower\(username\)/i.test(args[0])) { releaseLookup(); await resume }
        return rows
      }
      return typeof value === 'function' ? value.bind(target) : value
    } })
    const concurrent = createApiApp({ db: traced, store: state.store, serverSecret: SERVER_SECRET })
    const login = concurrent.fetch(new Request('http://localhost/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'GeneratedFixturePassword!' }) }))
    await observedLookup
    await setPasswordHash(db.db, aliceId, newHash)
    resumeLookup()
    const response = await login
    expect(response.status).toBe(401)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('reseller target-account features constrain mail writes even when edit-account ACL is granted', async () => {
    const reseller = await state.store.createReseller({ username: 'reseller', passwordHash, acl: ['edit-account'], maxAccounts: 5, totalDiskMb: 10000, totalBandwidthMb: 100000, oversell: false, nameservers: [], delegatedIps: [] })
    await createResellerPrincipal(db.db, { id: reseller.id, username: reseller.username, passwordHash })
    await state.store.changeOwner(alice.id, reseller.id)
    await state.store.updateFeatureList(featureListId, { disabled: ['forwarders'] })
    const response = await request(await tokenFor(reseller.id, ['mail:write']), '/api/mail/forwarders', 'POST', { accountId: alice.id, sourceAddress: `team@${alice.primaryDomain}`, destinations: ['out@example.test'] })
    expect(response.status).toBe(403)
    const root = await request(await tokenFor(rootId, ['mail:read']), '/api/mail/forwarders')
    expect((await root.json() as { forwarders: unknown[] }).forwarders).toEqual([])
  })

  it('A08 mailbox principal is isolated from sibling mailboxes in the same account and denied account/admin routes', async () => {
    const inboxLogin = `inbox@${alice.primaryDomain}`
    const siblingLogin = `support@${alice.primaryDomain}`
    const foreignLogin = `inbox@${bob.primaryDomain}`
    const siblingUser = await state.store.createServiceUser({
      accountId: alice.id,
      login: siblingLogin,
      passwordHash: `{ARGON2ID}${passwordHash}`,
      services: { email: true, ftp: false, webdisk: false },
      mailboxQuotaMb: 100,
      ftpDir: 'public_html',
    })
    const inboxUser = (await state.store.listServiceUsers(alice.id)).find(u => u.login === inboxLogin)!
    const inboxMailboxToken = await tokenFor(aliceId, [`mailbox:${inboxUser.id}`, 'webmail:*', 'mail:*'])
    const siblingMailboxToken = await tokenFor(aliceId, [`mailbox:support:${alice.primaryDomain}`, 'webmail:*', 'mail:*'])

    // Own mailbox access succeeds
    const sendOwn = await request(inboxMailboxToken, '/api/webmail/messages', 'POST', {
      to: ['external@example.test'],
      subject: 'Inbox internal note',
      textBody: 'CONFIDENTIAL_INBOX_BODY',
      attachments: [{ filename: 'invoice.pdf', contentType: 'application/pdf', sizeBytes: 128 }],
    })
    expect(sendOwn.status).toBe(201)
    const sentMsg = ((await sendOwn.json()) as { message: { id: string } }).message

    const foldersRes = await request(inboxMailboxToken, '/api/webmail/folders')
    expect(foldersRes.status).toBe(200)

    const msgDetail = await request(inboxMailboxToken, `/api/webmail/messages/${sentMsg.id}`)
    expect(msgDetail.status).toBe(200)

    const attDetail = await request(inboxMailboxToken, `/api/webmail/messages/${sentMsg.id}/attachments/invoice.pdf`)
    expect(attDetail.status).toBe(200)

    // Sibling mailbox in the SAME account cannot read, search, or delete inbox's message or attachments
    expect((await request(siblingMailboxToken, `/api/webmail/messages?mailbox=${encodeURIComponent(inboxLogin)}`)).status).toBe(404)
    expect((await request(siblingMailboxToken, `/api/webmail/search?q=CONFIDENTIAL&mailbox=${encodeURIComponent(inboxLogin)}`)).status).toBe(404)
    expect((await request(siblingMailboxToken, `/api/webmail/messages/${sentMsg.id}`)).status).toBe(404)
    expect((await request(siblingMailboxToken, `/api/webmail/messages/${sentMsg.id}`, 'DELETE')).status).toBe(404)
    expect((await request(siblingMailboxToken, `/api/webmail/messages/${sentMsg.id}/attachments/invoice.pdf`)).status).toBe(404)
    expect((await request(siblingMailboxToken, `/api/webmail/messages?mailbox=${encodeURIComponent(foreignLogin)}`)).status).toBe(404)

    // Unparameterized list/search for sibling only sees sibling's own messages (not inbox's)
    const siblingList = await request(siblingMailboxToken, '/api/webmail/messages')
    expect(siblingList.status).toBe(200)
    expect(await siblingList.text()).not.toContain('CONFIDENTIAL_INBOX_BODY')

    // Mailbox principal can manage its own mailbox-scoped Sieve filter, but cannot create global filters or touch sibling filters
    const ownFilterRes = await request(inboxMailboxToken, '/api/mail/filters', 'POST', {
      name: 'Inbox Filter',
      conditions: [{ field: 'Subject', comparator: 'contains', value: '[SPAM]' }],
      actions: [{ type: 'fileinto', argument: 'Junk' }],
    })
    expect(ownFilterRes.status).toBe(201)
    const ownFilter = ((await ownFilterRes.json()) as { filter: { id: string; mailbox: string } }).filter
    expect(ownFilter.mailbox).toBe(inboxLogin)

    expect(
      (
        await request(inboxMailboxToken, '/api/mail/filters', 'POST', {
          name: 'Attempted Global Filter',
          scope: 'global',
          conditions: [{ field: 'Subject', comparator: 'contains', value: 'alert' }],
          actions: [{ type: 'discard', argument: '' }],
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await request(siblingMailboxToken, '/api/mail/filters', 'POST', {
          name: 'Attempted Forged Sibling Filter',
          mailbox: inboxLogin,
          conditions: [{ field: 'Subject', comparator: 'contains', value: 'alert' }],
          actions: [{ type: 'discard', argument: '' }],
        })
      ).status,
    ).toBe(404)
    expect((await request(siblingMailboxToken, `/api/mail/filters/${ownFilter.id}`, 'DELETE')).status).toBe(404)

    // Mailbox principal is denied all non-mailbox account/admin routes
    for (const deniedRoute of [
      '/api/accounts',
      `/api/accounts/${alice.id}`,
      '/api/domains',
      '/api/databases',
      '/api/service-users',
      '/api/mail/forwarders',
      '/api/backups/snapshots',
      `/api/containers/${alice.id}`,
    ]) {
      expect((await request(inboxMailboxToken, deniedRoute)).status).toBe(403)
    }

    // Disabling email on the service user immediately revokes mailbox principal access
    await state.store.updateServiceUser(siblingUser.id, { services: { email: false, ftp: true, webdisk: false } })
    expect((await request(siblingMailboxToken, '/api/webmail/messages')).status).toBe(403)
  })

  it('A46 calendar and contact sharing, revocation, and ICS/vCard import/export enforce permissions and reject malicious payloads', async () => {
    const inboxLogin = `inbox@${alice.primaryDomain}`
    const siblingLogin = `support@${alice.primaryDomain}`
    const foreignLogin = `inbox@${bob.primaryDomain}`
    const siblingUser = await state.store.createServiceUser({
      accountId: alice.id,
      login: siblingLogin,
      passwordHash: `{ARGON2ID}${passwordHash}`,
      services: { email: true, ftp: false, webdisk: false },
      mailboxQuotaMb: 100,
      ftpDir: 'public_html',
    })
    const inboxUser = (await state.store.listServiceUsers(alice.id)).find(u => u.login === inboxLogin)!
    const inboxToken = await tokenFor(aliceId, [`mailbox:${inboxUser.id}`, 'webmail:*'])
    const siblingToken = await tokenFor(aliceId, [`mailbox:${siblingUser.id}`, 'webmail:*'])

    // Create calendar as inbox
    const calRes = await request(inboxToken, '/api/webmail/calendars', 'POST', {
      name: 'Ops Schedule',
      color: '#10b981',
      timezone: 'UTC',
    })
    expect(calRes.status).toBe(201)
    const calId = ((await calRes.json()) as { calendar: { id: string } }).calendar.id

    // Sibling cannot see or export unshared calendar
    expect(((await (await request(siblingToken, '/api/webmail/calendars')).json()) as { calendars: unknown[] }).calendars).toHaveLength(0)
    expect((await request(siblingToken, `/api/webmail/calendars/${calId}/export`)).status).toBe(404)

    // Cross-account share is rejected
    expect(
      (
        await request(inboxToken, `/api/webmail/calendars/${calId}/share`, 'POST', {
          grantee: foreignLogin,
          permission: 'read',
        })
      ).status,
    ).toBe(404)

    // Share with sibling as read-only
    const shareRead = await request(inboxToken, `/api/webmail/calendars/${calId}/share`, 'POST', {
      grantee: siblingLogin,
      permission: 'read',
    })
    expect(shareRead.status).toBe(200)

    // Sibling can now read & export calendar, but cannot PATCH, import, DELETE, or re-share
    const siblingCals = ((await (await request(siblingToken, '/api/webmail/calendars')).json()) as { calendars: { id: string }[] }).calendars
    expect(siblingCals.map(c => c.id)).toEqual([calId])
    expect((await request(siblingToken, `/api/webmail/calendars/${calId}/export`)).status).toBe(200)
    expect((await request(siblingToken, `/api/webmail/calendars/${calId}`, 'PATCH', { name: 'Hijacked' })).status).toBe(403)
    expect(
      (
        await request(siblingToken, `/api/webmail/calendars/${calId}/import`, 'POST', {
          ics: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:ev-1\r\nSUMMARY:Test\r\nDTSTART:20261022T100000Z\r\nDTEND:20261022T110000Z\r\nEND:VEVENT\r\nEND:VCALENDAR',
        })
      ).status,
    ).toBe(403)
    expect((await request(siblingToken, `/api/webmail/calendars/${calId}`, 'DELETE')).status).toBe(403)
    expect((await request(siblingToken, `/api/webmail/calendars/${calId}/share`, 'POST', { grantee: inboxLogin, permission: 'read' })).status).toBe(403)

    // Upgrade sibling to read-write
    expect(
      (
        await request(inboxToken, `/api/webmail/calendars/${calId}/share`, 'POST', {
          grantee: siblingLogin,
          permission: 'read-write',
        })
      ).status,
    ).toBe(200)

    // Sibling can now import valid ICS events and PATCH calendar metadata, but still cannot DELETE or share
    const validIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:deploy-window-2026',
      'SUMMARY:Production Release Window',
      'DTSTART:20261022T120000Z',
      'DTEND:20261022T130000Z',
      'LOCATION:DataCenter-1',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')
    const importCalRes = await request(siblingToken, `/api/webmail/calendars/${calId}/import`, 'POST', { ics: validIcs })
    expect(importCalRes.status).toBe(201)
    expect((await request(siblingToken, `/api/webmail/calendars/${calId}`, 'PATCH', { name: 'Team Ops Schedule' })).status).toBe(200)
    expect((await request(siblingToken, `/api/webmail/calendars/${calId}`, 'DELETE')).status).toBe(403)

    const exportedIcs = await (await request(inboxToken, `/api/webmail/calendars/${calId}/export`)).text()
    expect(exportedIcs).toContain('SUMMARY:Production Release Window')
    expect(exportedIcs).toContain('X-WR-CALNAME:Team Ops Schedule')

    // Malicious ICS payloads are rejected with 422 VALIDATION and do not corrupt calendar state
    for (const badIcs of [
      'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:<script>alert(1)</script>\r\nDTSTART:20261022T120000Z\r\nDTEND:20261022T130000Z\r\nEND:VEVENT\r\nEND:VCALENDAR',
      'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Leak\r\nATTACH;VALUE=URI:file:///etc/passwd\r\nDTSTART:20261022T120000Z\r\nDTEND:20261022T130000Z\r\nEND:VEVENT\r\nEND:VCALENDAR',
    ]) {
      expect((await request(inboxToken, `/api/webmail/calendars/${calId}/import`, 'POST', { ics: badIcs })).status).toBe(422)
    }

    // Revoke calendar share
    const revokeRes = await request(inboxToken, `/api/webmail/calendars/${calId}/share`, 'DELETE', { grantee: siblingLogin })
    expect(revokeRes.status).toBe(200)
    expect(((await (await request(siblingToken, '/api/webmail/calendars')).json()) as { calendars: unknown[] }).calendars).toHaveLength(0)
    expect((await request(siblingToken, `/api/webmail/calendars/${calId}/export`)).status).toBe(404)
    expect((await request(siblingToken, `/api/webmail/calendars/${calId}`, 'PATCH', { name: 'Denied' })).status).toBe(404)

    // Contacts vCard import/export + sharing & revocation
    const validVcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Nadia Al-Mansoor',
      'EMAIL;TYPE=INTERNET:nadia@alice.example.test',
      'TEL;TYPE=CELL:+971500000001',
      'ORG:Nebula Ops',
      'END:VCARD',
    ].join('\r\n')
    const importContactsRes = await request(inboxToken, '/api/webmail/contacts/import', 'POST', { vcard: validVcard })
    expect(importContactsRes.status).toBe(201)
    const importedContact = ((await importContactsRes.json()) as { contacts: { id: string }[] }).contacts[0]!

    // Reject malicious vCard payloads
    expect(
      (
        await request(inboxToken, '/api/webmail/contacts/import', 'POST', {
          vcard: 'BEGIN:VCARD\r\nFN:<script>evil()</script>\r\nEMAIL:bad@example.test\r\nEND:VCARD',
        })
      ).status,
    ).toBe(422)

    // Share contact read-only with sibling, then upgrade to read-write, then revoke
    expect(
      (
        await request(inboxToken, `/api/webmail/contacts/${importedContact.id}/share`, 'POST', {
          grantee: siblingLogin,
          permission: 'read',
        })
      ).status,
    ).toBe(200)
    expect((await request(siblingToken, '/api/webmail/contacts/export')).status).toBe(200)
    expect((await request(siblingToken, `/api/webmail/contacts/${importedContact.id}`, 'PATCH', { title: 'Blocked' })).status).toBe(403)
    expect(
      (
        await request(inboxToken, `/api/webmail/contacts/${importedContact.id}/share`, 'POST', {
          grantee: siblingLogin,
          permission: 'read-write',
        })
      ).status,
    ).toBe(200)
    expect((await request(siblingToken, `/api/webmail/contacts/${importedContact.id}`, 'PATCH', { title: 'Lead SRE' })).status).toBe(200)
    expect(
      (
        await request(inboxToken, `/api/webmail/contacts/${importedContact.id}/share`, 'POST', {
          grantee: siblingLogin,
          permission: 'revoke',
        })
      ).status,
    ).toBe(200)
    expect((await request(siblingToken, `/api/webmail/contacts/${importedContact.id}`, 'PATCH', { title: 'Revoked' })).status).toBe(404)
  })

  it('A06/A30 live state re-verification blocks reseller mutation if account ownership changes mid-flight and fails closed on missing plan metadata', async () => {
    const reseller = await state.store.createReseller({
      username: 'resellerlive',
      passwordHash,
      acl: ['list-accounts', 'edit-account'],
      maxAccounts: 5,
      totalDiskMb: 10000,
      totalBandwidthMb: 100000,
      oversell: false,
      nameservers: [],
      delegatedIps: [],
    })
    await createResellerPrincipal(db.db, { id: reseller.id, username: reseller.username, passwordHash })
    await state.store.changeOwner(alice.id, reseller.id)
    const resellerToken = await tokenFor(reseller.id, ['*'])

    // Reseller initially owns alice, then ownership is transferred back to root before reseller's write
    await state.store.changeOwner(alice.id, null)
    const afterTransfer = await request(resellerToken, `/api/web-features/${alice.id}/hotlink-protection`, 'PUT', {
      enabled: true,
    })
    expect(afterTransfer.status).toBe(404)

    // Fault injection: if account's feature list or plan metadata is missing/corrupted in state store, feature-gated actions fail closed (403)
    const faultStore = new Proxy(state.store, {
      get(target, key) {
        if (key === 'getFeatureList') return async () => null
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const faultApp = createApiApp({ db: db.db, store: faultStore, serverSecret: SERVER_SECRET })
    const aliceToken = await tokenFor(aliceId, ['*'])
    const failClosed = await faultApp.fetch(
      new Request('http://localhost/api/databases', {
        method: 'POST',
        headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'should_fail_closed' }),
      }),
    )
    expect(failClosed.status).toBe(403)
    expect(await state.store.listDatabases(alice.id)).toEqual([])
  })
})
