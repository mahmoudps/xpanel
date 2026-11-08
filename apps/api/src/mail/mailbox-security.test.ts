import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestDb, findActiveSessionByTokenHash, getMailboxSession, getPrincipal } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from '../auth.ts'
import { computeTotpCode, hashPasswordArgon2id } from '../auth.ts'
import { sessionTokenHash } from '../entry-points.ts'
import { establishMailboxSession } from './inbox.ts'
import type { MailboxTransport } from './inbox.ts'
import { MAILBOX_SECOND_FACTOR_SCOPE, handleMailboxSecurityRoute } from './mailbox-security.ts'
import type { MailboxSecurityPorts } from './mailbox-security.ts'

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const SECRET = 'synthetic-mailbox-security-server-secret'
const PASSWORD = 'synthetic-mailbox-password'
const NEW_PASSWORD = PASSWORD.toUpperCase()
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture() {
  const database = await createTestDb(), state = await createTestStateStore()
  cleanup.push(() => database.close(), () => state.close())
  const features = await state.store.createFeatureList({ name: 'Mailbox fixture', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Mailbox fixture', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1024, bandwidthMbMonth: 'unlimited', ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 512, maxProcesses: 32, cpuPercent: 100 },
    caps: { addonDomains: 2, aliasDomains: 2, subdomains: 2, mailboxes: 2, forwarders: 2, mailingLists: 2, ftpAccounts: 2, databases: 2, phpWorkers: 2 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const php = { version: '8.3', handler: 'fpm' as const, fpm: { mode: 'ondemand' as const, maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} }
  const account = await state.store.createAccount({ username: 'alpha', primaryDomain: 'alpha.example.test', passwordHash: HASH, planId: plan.id, ownerId: null, contactEmail: 'owner@alpha.example.test', ipv4: '192.0.2.10', shell: 'none', php })
  const serviceUser = await state.store.createServiceUser({ accountId: account.id, login: 'a@alpha.example.test', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html', passwordHash: HASH })
  let mailPassword = PASSWORD
  const transport: MailboxTransport = { async verify(_mailbox, password) { if (password !== mailPassword) fail('UNAUTHENTICATED', 'refused') }, async list() { return [] }, async read() { throw new Error('unused') }, async remove() {}, async send() { return { messageId: '<x@example.test>' } } }
  const signIn = (extra: { totpCode?: string; recoveryCode?: string; password?: string } = {}) => establishMailboxSession({ db: database.db, store: state.store, serverSecret: SECRET, transport, entryPoint: 'xmail',
    mailbox: serviceUser.login, password: extra.password ?? mailPassword, totpCode: extra.totpCode, recoveryCode: extra.recoveryCode, mfaMode: 'optional', ip: '192.0.2.5', userAgent: 'fixture' })
  const established = await signIn()
  const caller = async (): Promise<AuthenticatedCaller> => ({ principal: established.principal, principalRecord: (await getPrincipal(database.db, established.principal.id))!, sessionId: established.session.id,
    sessionToken: established.rawToken, apiTokenId: null, scopes: ['*'], csrfValid: true, mfaVerified: true } as AuthenticatedCaller)
  const recordFailure = vi.fn(async () => undefined), audit = vi.fn(async () => undefined), reconcile = vi.fn(async () => ({ ok: true, body: { status: 'applied' } }))
  const ports: MailboxSecurityPorts = { db: database.db, serverSecret: SECRET, mfaMode: 'optional', transport, store: state.store,
    requireCaller: async () => caller(), open: async () => ({ caller: await caller(), opened: { record: (await getMailboxSession(database.db, established.session.id))! } }),
    hashPassword: async password => { mailPassword = password; return HASH }, reconcile, audit, lockedUntil: async () => null, recordFailure, clearCookie: () => 'xmail_session=; Max-Age=0' }
  const post = (path: string, body: unknown, p: MailboxSecurityPorts = ports) => { const url = new URL(path, 'https://mail.example.test'); return handleMailboxSecurityRoute(new Request(url, { method: 'POST', body: JSON.stringify(body) }), url, 'POST', p) }
  const active = () => findActiveSessionByTokenHash(database.db, sessionTokenHash(established.rawToken, 'xmail'))
  return { database, state, serviceUser, established, ports, post, signIn, recordFailure, audit, reconcile, active }
}
const failure = async (run: () => Promise<unknown>): Promise<Record<string, unknown>> => { try { await run() } catch (error) { const e = error as { code: string; detail: Record<string, unknown> }; return { code: e.code, ...e.detail } } return { code: 'accepted' } }

describe('mailbox security (D5: the second factor guards xMail sign-in only)', () => {
  it('tells only the right password that the account is suspended, and opens no session', async () => {
    const f = await fixture(), login = 'held@alpha.example.test'
    const held = await f.state.store.createServiceUser({ accountId: f.serviceUser.accountId, login, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html', passwordHash: '{ARGON2ID}' + await hashPasswordArgon2id(PASSWORD) })
    await f.state.store.suspendAccount(held.accountId, 'test')
    const closed = { async verify() { throw new Error('IMAP is closed') } } as unknown as MailboxTransport
    const attempt = (password: string) => establishMailboxSession({ db: f.database.db, store: f.state.store, serverSecret: SECRET, transport: closed, entryPoint: 'xmail', mailbox: login, password, mfaMode: 'optional', ip: '192.0.2.5', userAgent: 'fixture' })
    await expect(attempt(PASSWORD)).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { reason: 'account_suspended' } })
    await expect(attempt('wrong-password')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
  })

  it('reports the mailbox state and the protected scope', async () => {
    const f = await fixture(), url = new URL('https://mail.example.test/api/webmail/security')
    expect(await (await handleMailboxSecurityRoute(new Request(url), url, 'GET', f.ports))!.json()).toEqual({ mailbox: 'a@alpha.example.test', mfaMode: 'optional', totpEnabled: false, enrolled: false,
      secondFactor: { protects: 'xmail-sign-in', mailProtocols: 'password', appPasswords: false } })
    expect(MAILBOX_SECOND_FACTOR_SCOPE.appPasswords).toBe(false)
  })
  it('changes the mailbox password after the mail server accepts the current one, applies it and ends every mailbox session', async () => {
    const f = await fixture()
    expect(await failure(() => f.post('/api/webmail/security/password', { currentPassword: 'wrong-password', newPassword: NEW_PASSWORD }))).toMatchObject({ code: 'UNAUTHENTICATED', stateChanged: false })
    expect(f.recordFailure).toHaveBeenCalledWith('a@alpha.example.test', expect.any(Request), 'invalid_password_change_reauthentication', f.established.principal.id)
    const response = await f.post('/api/webmail/security/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
    expect(await response!.json()).toMatchObject({ ok: true, reauthenticationRequired: true })
    expect(response!.headers.get('set-cookie')).toBe('xmail_session=; Max-Age=0')
    expect(f.reconcile).toHaveBeenCalledOnce()
    expect(f.audit).toHaveBeenCalledWith(expect.anything(), 'webmail.password_changed', 'a@alpha.example.test', { services: ['email'] })
    expect(await f.active()).toBeNull()
    expect(await failure(() => f.signIn({ password: PASSWORD }))).toMatchObject({ code: 'UNAUTHENTICATED' })
    expect((await f.signIn({ password: NEW_PASSWORD })).session.id).toBeTruthy()
  })
  it('reports an unverified application instead of success when the mail configuration is not applied', async () => {
    const f = await fixture()
    f.reconcile.mockResolvedValueOnce({ ok: false, body: { status: 'failed' } })
    expect(await failure(() => f.post('/api/webmail/security/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }))).toMatchObject({ code: 'SERVICE_UNAVAILABLE', stateChanged: true, verificationRequired: true })
    expect(await f.active()).not.toBeNull()
  })
  it('enrolls an authenticator, then requires it or one recovery code at xMail sign-in', async () => {
    const f = await fixture()
    expect(await failure(() => f.post('/api/webmail/security/2fa/setup', { password: 'wrong-password' }))).toMatchObject({ code: 'UNAUTHENTICATED' })
    const setup = await (await f.post('/api/webmail/security/2fa/setup', { password: PASSWORD }))!.json() as { secret: string; otpauthUrl: string; recoveryCodes: string[] }
    expect(setup.otpauthUrl).toBe('otpauth://totp/xMail:a%40alpha.example.test?secret=' + setup.secret + '&issuer=xMail')
    expect(setup.recoveryCodes).toHaveLength(8)
    expect(await (await f.post('/api/webmail/security/2fa/enable', { code: computeTotpCode(setup.secret) }))!.json()).toMatchObject({ ok: true, totpEnabled: true })
    expect(f.audit).toHaveBeenCalledWith(expect.anything(), 'auth.2fa_enabled', 'a@alpha.example.test')

    expect(await failure(() => f.signIn())).toMatchObject({ code: 'UNAUTHENTICATED', mfaRequired: true })
    expect(await failure(() => f.signIn({ totpCode: '000000' }))).toMatchObject({ code: 'UNAUTHENTICATED', reason: 'invalid_totp' })
    expect(await failure(() => f.signIn({ password: 'wrong-password', totpCode: computeTotpCode(setup.secret, Date.now() + 30_000) }))).toMatchObject({ code: 'UNAUTHENTICATED' })
    expect(await failure(() => f.signIn({ password: 'wrong-password' }))).not.toHaveProperty('mfaRequired')
    const signed = await f.signIn({ totpCode: computeTotpCode(setup.secret, Date.now() + 30_000) })
    expect(signed.session.mfaVerified).toBe(true)
    expect((await f.signIn({ recoveryCode: setup.recoveryCodes[0] })).session.mfaVerified).toBe(true)
    expect(await failure(() => f.signIn({ recoveryCode: setup.recoveryCodes[0] }))).toMatchObject({ code: 'UNAUTHENTICATED', reason: 'invalid_recovery_code' })

    expect(await failure(() => f.post('/api/webmail/security/2fa/disable', { password: PASSWORD, code: '000000' }))).toMatchObject({ code: 'UNAUTHENTICATED' })
    expect(await (await f.post('/api/webmail/security/2fa/disable', { password: PASSWORD, recoveryCode: setup.recoveryCodes[1] }))!.json()).toMatchObject({ ok: true, totpEnabled: false })
    expect((await f.signIn()).session.mfaVerified).toBe(false)
  })
  it('keeps factor changes off in development and off handed-off sessions', async () => {
    const f = await fixture()
    expect(await failure(() => f.post('/api/webmail/security/2fa/setup', { password: PASSWORD }, { ...f.ports, mfaMode: 'disabled' }))).toMatchObject({ code: 'FORBIDDEN', stateChanged: false })
    const handedOff: MailboxSecurityPorts = { ...f.ports, requireCaller: async request => ({ ...await f.ports.requireCaller(request), impersonator: { principalId: 'owner-id', login: 'alpha' } }) }
    expect(await failure(() => f.post('/api/webmail/security/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, handedOff))).toMatchObject({ code: 'FORBIDDEN', reason: 'handoff_session' })
    expect(await failure(() => f.post('/api/webmail/security/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, extra: 1 }))).toMatchObject({ code: 'VALIDATION' })
  })
})
