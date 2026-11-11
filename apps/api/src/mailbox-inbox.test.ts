import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fail, SESSION_ABSOLUTE_TIMEOUT_MS, SESSION_IDLE_TIMEOUT_MS } from '@xpanel/core'
import { appendAudit, createRootPrincipal, createUserPrincipal, createTestDb, enqueueDurableJob, findActiveSessionByTokenHash, findPrincipalByUsername, initializeOperationalMetadata, listAudit, requestJobCancellation, setTotpSecret, type PrincipalRecord } from '@xpanel/db'
import { createTestStateStore, ExtendedFeaturesStore } from '@xpanel/state'
import { authenticateRequest, hashPasswordArgon2id } from './auth.ts'
import { assertAccountAuthorized, assertRequestAuthorized } from './authorization.ts'
import { sessionTokenHash } from './entry-points.ts'
import { createApiApp } from './server.ts'
import { loadMailDocument } from './mail/document.ts'
import type { InboxMessage, MailboxSendInput, MailboxTransport, MailboxRetirementAttempt } from './mail/inbox.ts'
import { establishHandoffMailboxSession, retireMailboxServiceUser } from './mail/inbox.ts'
import { auditActorQuery, auditTargetQuery, createLocalMailboxTransport, imapHumanCopy, mailboxAddressIndex, mailboxPrincipalUsername, mailReceivedAtUtc, rewriteMailboxIds } from './mail/inbox.ts'

const SECRET = 'mailbox-inbox-synthetic-server-secret-32b'
const ORIGIN = 'https://mail.example.test'
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const SERVICE_HASH = '{SHA512-CRYPT}$6$mailboxfixture$abcdefghijklmnopqrstuvwxyz0123456789'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

interface Box {
  password: string
  messages: InboxMessage[]
  sent: MailboxSendInput[]
}

const message = (uid: number, subject: string, body: string): InboxMessage => ({
  uid, uidValidity: 17, uidValidityObserved: true, from: 'sender@example.test', to: 'inbox@alpha.example.test', subject, receivedAt: '2026-10-23T12:00:00.000Z', unread: true, sizeBytes: body.length, body,
})

const harness = async (transport: MailboxTransport) => {
  const database = await createTestDb()
  await initializeOperationalMetadata(database.db)
  const state = await createTestStateStore()
  cleanup.push(() => database.close(), () => state.close())
  const features = await state.store.createFeatureList({ name: 'Mail features', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({
    name: 'Mail plan', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1024, bandwidthMbMonth: 'unlimited', ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 512, maxProcesses: 32, cpuPercent: 100 },
    caps: { addonDomains: 1, aliasDomains: 1, subdomains: 1, mailboxes: 2, forwarders: 1, mailingLists: 1, ftpAccounts: 1, databases: 1, phpWorkers: 2 },
    dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100,
  })
  await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const php = { version: '8.3', handler: 'fpm' as const, fpm: { mode: 'ondemand' as const, maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} }
  const alpha = await state.store.createAccount({ username: 'alpha', passwordHash: HASH, primaryDomain: 'alpha.example.test', planId: plan.id, ownerId: null, contactEmail: 'owner@alpha.example.test', ipv4: '192.0.2.10', shell: 'none', php })
  const beta = await state.store.createAccount({ username: 'beta', passwordHash: HASH, primaryDomain: 'beta.example.test', planId: plan.id, ownerId: null, contactEmail: 'owner@beta.example.test', ipv4: '192.0.2.10', shell: 'none', php })
  await state.store.createServiceUser({ accountId: alpha.id, login: 'inbox@alpha.example.test', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html', passwordHash: SERVICE_HASH })
  await state.store.createServiceUser({ accountId: beta.id, login: 'other@beta.example.test', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html', passwordHash: SERVICE_HASH })
  await state.store.createServiceUser({ accountId: alpha.id, login: 'closed@alpha.example.test', services: { email: false, ftp: true, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html', passwordHash: SERVICE_HASH })
  const app = createApiApp({ db: database.db, store: state.store, serverSecret: SECRET, entryPoint: 'xmail', publicOrigin: ORIGIN, allowedOrigins: [ORIGIN], secureCookies: true, mailboxTransport: transport })
  const call = async (method: string, path: string, body?: unknown, session?: { cookie: string; csrf: string }) => {
    const response = await app.fetch(new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }), { remoteAddress: '192.0.2.5' })
    const payload = await response.json() as { detail?: string; mailbox?: string; messages?: InboxMessage[]; message?: InboxMessage; messageId?: string; csrfToken?: string }
    const setCookie = response.headers.get('set-cookie') ?? ''
    const cookie = setCookie.split(';')[0] ?? ''
    return { status: response.status, payload, cookie, csrf: payload.csrfToken ?? '' }
  }
  const login = (username: string, password: string) => call('POST', '/api/auth/login', { username, password })
  const sessionOf = (logged: Awaited<ReturnType<typeof login>>) => ({ cookie: logged.cookie, csrf: logged.csrf })
  return { database, state, alpha, beta, call, login, sessionOf }
}

const factorIdentity = (principal: PrincipalRecord | null): string => createHash('sha256').update(JSON.stringify(
  principal ? Object.fromEntries(Object.entries(principal).filter(([name]) => name.startsWith('totp'))) : null,
)).digest('hex')
const retirementFixture = async (kind: 'root' | 'user' = 'root', verify?: () => Promise<void>) => {
  const mailbox = 'inbox@alpha.example.test'
  const transport: MailboxTransport = {
    async verify(login, password) { if (login !== mailbox || password !== 'synthetic-mailbox-password') fail('UNAUTHENTICATED', 'declared fixture credential rejected'); await verify?.() },
    async list() { return [] }, async read() { return fail('NOT_FOUND', 'unused fixture message') }, async remove() {}, async send() { return { messageId: '<fixture@example.test>' } },
  }
  const f = await harness(transport)
  expect((await f.login(mailbox, 'synthetic-mailbox-password')).status).toBe(200)
  const original = await findPrincipalByUsername(f.database.db, mailboxPrincipalUsername(mailbox))
  const service = await f.state.store.getServiceUserByLogin(mailbox)
  if (!original || !service) throw new Error('mailbox retirement fixture missing identity')
  await setTotpSecret(f.database.db, original.id, new Uint8Array(48).fill(7), ['a'.repeat(64)])
  const enrolled = await findPrincipalByUsername(f.database.db, original.username)
  const passwordHash = await hashPasswordArgon2id('SyntheticRetirementActor!2026')
  const actor = kind === 'root'
    ? await createRootPrincipal(f.database.db, { username: 'root', passwordHash, forcePasswordChange: false })
    : await createUserPrincipal(f.database.db, { username: 'alpha', accountId: f.alpha.id, passwordHash, forcePasswordChange: false })
  const entryPoint = kind === 'root' ? 'xwhm' : 'xpanel'
  const origin = kind === 'root' ? 'https://whm.example.test' : 'https://panel.example.test'
  const app = createApiApp({ db: f.database.db, store: f.state.store, serverSecret: SECRET, entryPoint, publicOrigin: origin, allowedOrigins: [origin], secureCookies: true })
  const signedIn = await app.fetch(new Request(origin + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: actor.username, password: 'SyntheticRetirementActor!2026' }) }), { remoteAddress: '192.0.2.5' })
  expect(signedIn.status).toBe(200)
  const payload = await signedIn.json()
  if (!payload || typeof payload.csrfToken !== 'string') throw new Error('retirement fixture CSRF missing')
  const cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0]
  if (!cookie) throw new Error('retirement fixture cookie missing')
  const request = (serviceUserId = service.id) => new Request(origin + '/api/service-users/' + serviceUserId, { method: 'DELETE', headers: { cookie, 'x-csrf-token': payload.csrfToken } })
  const initial = await authenticateRequest(f.database.db, request(), { serverSecret: SECRET, clientIp: '192.0.2.5', entryPoint, touchSession: false })
  if (!initial) throw new Error('retirement fixture original actor missing')
  await assertRequestAuthorized(f.state.store, initial, request())
  const reconcile = vi.fn(async () => null)
  const options: MailboxRetirementAttempt = { db: f.database.db, store: f.state.store, serviceUserId: service.id, actor: initial.principal,
    authorize: async (tx, source) => {
      const current = await authenticateRequest(tx, request(), { serverSecret: SECRET, clientIp: '192.0.2.5', entryPoint, touchSession: false })
      if (!current || !current.mfaVerified || !current.csrfValid || current.principal.id !== initial.principal.id || current.sessionId !== initial.sessionId) return fail('UNAUTHENTICATED', 'original fixture credential is no longer current')
      await assertRequestAuthorized(f.state.store, current, request())
      await assertAccountAuthorized(f.state.store, current, source.account, 'service_user.modify')
      if (!current.sessionToken) return fail('UNAUTHENTICATED', 'original fixture session is unavailable')
      const session = await findActiveSessionByTokenHash(tx, sessionTokenHash(current.sessionToken, entryPoint))
      if (!session || session.id !== current.sessionId || session.principalId !== current.principal.id) return fail('UNAUTHENTICATED', 'original fixture session changed')
      const expires = Date.parse(session.expiresAt), created = Date.parse(session.createdAt), lastSeen = Date.parse(session.lastSeenAt)
      const deadline = Math.min(expires, created + SESSION_ABSOLUTE_TIMEOUT_MS, lastSeen + SESSION_IDLE_TIMEOUT_MS)
      if (![expires, created, lastSeen, deadline].every(Number.isFinite)) return fail('UNAUTHENTICATED', 'original fixture session time is invalid')
      return { assertCurrentTime: (): void => {
        if (Date.now() >= deadline) return fail('UNAUTHENTICATED', 'original fixture session expired', { stateChanged: false })
      } }
    },
    audit: async event => { await appendAudit(f.database.db, { actor: actor.username, principalId: actor.id, action: event.action, target: 'mailbox:' + mailbox,
      detail: { jobId: event.job.id, initiator: event.job.actor, recoveryActorId: actor.id, nativeDeletionVerified: false }, outcome: 'ok' }) },
    reconcile,
  }
  return { ...f, actor, initial, original, service, mailbox, enrolled, options, reconcile,
    retire: (override: Partial<MailboxRetirementAttempt> = {}) => retireMailboxServiceUser({ ...options, ...override }),
    httpDelete: (serviceUserId = service.id) => app.fetch(request(serviceUserId), { remoteAddress: '192.0.2.5' }) }
}

describe('mailbox retirement failure boundaries (real fixture stores, no native mail)', () => {
  it.each(['root', 'user'] as const)('preserves MFA and original identity through failed state deletion and explicit %s recovery', async kind => {
    const f = await retirementFixture(kind)
    const failedWrite = vi.spyOn(f.state.store, 'deleteServiceUser').mockRejectedValueOnce(new Error('declared state failure'))
    try { await expect(f.retire()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'mailbox_retirement_state_unconfirmed', stateChanged: true } }) }
    finally { failedWrite.mockRestore() }
    const held = await findPrincipalByUsername(f.database.db, f.original.username)
    expect(held?.id).toBe(f.original.id)
    expect(held?.disabled).toBe(true)
    expect(factorIdentity(held)).toBe(factorIdentity(f.enrolled))
    expect((await f.state.store.getServiceUser(f.service.id))?.id).toBe(f.service.id)
    expect((await f.login(f.mailbox, 'synthetic-mailbox-password')).status).toBe(401)
    const before = await f.database.db.query<{ id: string }>("SELECT id FROM jobs WHERE kind='mailbox.retire'")
    await expect(f.retire()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'mailbox_retirement_native_unverified', nativeDeletionVerified: false } })
    expect(await f.state.store.getServiceUser(f.service.id)).toBeNull()
    expect(await f.database.db.query("SELECT id FROM jobs WHERE kind='mailbox.retire'")).toEqual(before)
    expect(factorIdentity(await findPrincipalByUsername(f.database.db, f.original.username))).toBe(factorIdentity(f.enrolled))
    expect(f.reconcile).toHaveBeenCalledOnce()
    await expect(f.retire()).rejects.toMatchObject({ detail: { reason: 'mailbox_retirement_native_unverified' } })
    expect(f.reconcile).toHaveBeenCalledOnce()
    expect((await listAudit(f.database.db, { limit: 20 })).some(row => row.action === 'mailbox.deleted' && row.outcome === 'ok')).toBe(false)
  })
  it('rolls back the admitted identity hold and intent together if its callback fails', async () => {
    const f = await retirementFixture()
    await expect(enqueueDurableJob(f.database.db, { kind: 'mailbox.retire', accountId: f.alpha.id, actor: 'root:root', idempotencyKey: 'mailbox.retire:v1:' + f.service.id }, async tx => {
      await tx.query('UPDATE principals SET disabled = 1 WHERE id = $1', [f.original.id])
      throw new Error('declared admitted transaction failure')
    })).rejects.toThrow('declared admitted transaction failure')
    expect(await f.database.db.query("SELECT id FROM jobs WHERE kind='mailbox.retire'")).toHaveLength(0)
    const unchanged = await findPrincipalByUsername(f.database.db, f.original.username)
    expect(unchanged?.disabled).toBe(false)
    expect(factorIdentity(unchanged)).toBe(factorIdentity(f.enrolled))
  })
  it('prevents a handoff issuer queued behind retirement admission from creating a session', async () => {
    const f = await retirementFixture()
    const owner = await createUserPrincipal(f.database.db, { username: 'alpha', accountId: f.alpha.id, passwordHash: HASH, forcePasswordChange: false })
    let enter: () => void = () => undefined, release: () => void = () => undefined
    const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    let first = true
    const retiring = f.retire({ authorize: async (tx, source) => { const checked = await f.options.authorize(tx, source); if (first) { first = false; enter(); await gate } return checked } }).catch(error => error)
    await entered
    const handoff = establishHandoffMailboxSession({ db: f.database.db, mailbox: f.mailbox, serviceUserId: f.service.id, accountId: f.alpha.id,
      entryPoint: 'xmail', impersonator: { principalId: owner.id, login: owner.username }, ttlMs: 60_000, ip: '192.0.2.5', userAgent: 'declared-fixture' })
    const denied = expect(handoff).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    release(); await denied
    expect(await retiring).toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'mailbox_retirement_native_unverified' } })
    expect(await f.database.db.query('SELECT session_id FROM handoff_mailbox_sessions')).toHaveLength(0)
    expect(factorIdentity(await findPrincipalByUsername(f.database.db, f.original.username))).toBe(factorIdentity(f.enrolled))
  })
  it('does not revoke or delete a replacement service user at the retired address', async () => {
    const f = await retirementFixture()
    await expect(f.retire()).rejects.toMatchObject({ detail: { reason: 'mailbox_retirement_native_unverified' } })
    const replacement = await f.state.store.createServiceUser({ accountId: f.alpha.id, login: f.mailbox, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html', passwordHash: SERVICE_HASH })
    await expect(f.retire()).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    expect((await f.state.store.getServiceUser(replacement.id))?.id).toBe(replacement.id)
    expect(f.reconcile).toHaveBeenCalledOnce()
    expect(factorIdentity(await findPrincipalByUsername(f.database.db, f.original.username))).toBe(factorIdentity(f.enrolled))
  })
  it('blocks a replacement address even when no mailbox principal was ever created', async () => {
    const verify = vi.fn(async () => undefined)
    const f = await harness({ verify, async list() { return [] }, async read() { return fail('NOT_FOUND', 'unused') }, async remove() {}, async send() { return { messageId: '<unused@example.test>' } } })
    const mailbox = 'inbox@alpha.example.test'
    const original = await f.state.store.getServiceUserByLogin(mailbox)
    if (!original) throw new Error('declared mailbox source missing')
    // A malformed or partially recovered durable marker also fails closed. It is
    // not evidence of native success and must not allow a new default identity.
    await enqueueDurableJob(f.database.db, { kind: 'mailbox.retire', accountId: f.alpha.id, actor: 'root:fixture',
      idempotencyKey: 'mailbox.retire:v1:' + original.id, detail: { mailboxRetirement: { service: { login: mailbox } } } })
    await f.state.store.deleteServiceUser(original.id)
    const replacement = await f.state.store.createServiceUser({ accountId: f.alpha.id, login: mailbox, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html', passwordHash: SERVICE_HASH })
    expect((await f.login(mailbox, 'synthetic-password')).status).toBe(401)
    const owner = await createUserPrincipal(f.database.db, { username: 'alpha', accountId: f.alpha.id, passwordHash: HASH, forcePasswordChange: false })
    await expect(establishHandoffMailboxSession({ db: f.database.db, mailbox, serviceUserId: replacement.id, accountId: f.alpha.id,
      entryPoint: 'xmail', impersonator: { principalId: owner.id, login: owner.username }, ttlMs: 60_000, ip: '192.0.2.5', userAgent: 'declared-fixture' })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    expect(await findPrincipalByUsername(f.database.db, mailboxPrincipalUsername(mailbox))).toBeNull()
    expect(verify).not.toHaveBeenCalled()
  })
  it('denies password issuance when retirement completes during transport verification', async () => {
    let pause = false, enter: () => void = () => undefined, release: () => void = () => undefined
    const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const f = await retirementFixture('root', async () => { if (pause) { enter(); await gate } })
    pause = true
    const signingIn = f.login(f.mailbox, 'synthetic-mailbox-password')
    await entered
    try { await expect(f.retire()).rejects.toMatchObject({ detail: { reason: 'mailbox_retirement_native_unverified' } }) }
    finally { release() }
    expect((await signingIn).status).toBe(401)
    expect(await f.database.db.query('SELECT session_id FROM mailbox_sessions WHERE service_user_id = $1', [f.service.id])).toHaveLength(0)
    expect(factorIdentity(await findPrincipalByUsername(f.database.db, f.original.username))).toBe(factorIdentity(f.enrolled))
  })
  it('keeps an interrupted post-hold audit recoverable without repeating native requests', async () => {
    const f = await retirementFixture()
    await expect(f.retire({ audit: async () => { throw new Error('declared post-hold audit interruption') } })).rejects.toMatchObject({ detail: { stateChanged: true, reason: 'mailbox_retirement_attempt_unacknowledged' } })
    const jobs = await f.database.db.query<{ id: string }>("SELECT id FROM jobs WHERE kind='mailbox.retire'")
    expect(jobs).toHaveLength(1)
    expect((await findPrincipalByUsername(f.database.db, f.original.username))?.disabled).toBe(true)
    expect(await f.state.store.getServiceUser(f.service.id)).not.toBeNull()
    expect(f.reconcile).not.toHaveBeenCalled()
    await expect(f.retire()).rejects.toMatchObject({ detail: { reason: 'mailbox_retirement_native_unverified' } })
    expect(await f.database.db.query("SELECT id FROM jobs WHERE kind='mailbox.retire'")).toEqual(jobs)
    expect(f.reconcile).toHaveBeenCalledOnce()
    expect(factorIdentity(await findPrincipalByUsername(f.database.db, f.original.username))).toBe(factorIdentity(f.enrolled))
  })
  it.each(['revoked', 'expired', 'cancelled'] as const)('rechecks %s authority after the actual StateStore writer queue', async fault => {
    const f = await retirementFixture()
    const sourcePath = join(f.state.store.rootDir, 'accounts', f.alpha.username, 'users', f.service.id + '.json')
    const sourceHash = createHash('sha256').update(await readFile(sourcePath)).digest('hex')
    const deleteSource = f.state.store.deleteServiceUser.bind(f.state.store)
    let enter: () => void = () => undefined, release: () => void = () => undefined, admittedChecks = 0, clockChanged = false
    const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const blockedDelete = vi.spyOn(f.state.store, 'deleteServiceUser').mockImplementationOnce(async (id, options) => {
      // This starts AFTER the committed MFA hold and the outer DB precheck.
      // The original method really queues behind this separate OS writer lease.
      const blocker = await f.state.store.getWriterLock().acquire()
      const result = deleteSource(id, { ...options, authorize: async (account, service) => {
        admittedChecks++
        if (!options?.authorize) throw new Error('trusted deletion guard missing')
        await options.authorize(account, service)
      } }).then(value => ({ value }), error => ({ value: false, error }))
      enter()
      try { await gate } finally { await blocker.release() }
      const settled = await result
      if ('error' in settled) throw settled.error
      return settled.value
    })
    const attempt = f.retire().catch(error => error)
    try {
      await entered
      const jobs = await f.database.db.query<{ id: string }>("SELECT id FROM jobs WHERE kind='mailbox.retire'")
      const job = jobs[0]
      if (!job || !f.initial.sessionId) throw new Error('admitted retirement fixture missing job/session')
      if (fault === 'revoked') await f.database.db.query('UPDATE principals SET disabled = 1 WHERE id = $1', [f.actor.id])
      else if (fault === 'expired') {
        // A valid future expiry preserves expires_at > created_at. Advance only
        // Date by 5 seconds, keeping this admission inside the 30-second job lease.
        const expiry = Date.now() + 5_000
        await f.database.db.query('UPDATE sessions SET expires_at = $1 WHERE id = $2', [new Date(expiry).toISOString(), f.initial.sessionId])
        vi.useFakeTimers({ toFake: ['Date'] }); clockChanged = true; vi.setSystemTime(expiry + 1)
      }
      else await requestJobCancellation(f.database.db, { jobId: job.id, actor: 'root:fixture', reason: 'declared queued cancellation' })
      release()
      const error = await attempt
      expect(admittedChecks).toBe(1)
      expect(error).toMatchObject(fault === 'cancelled'
        ? { code: 'PRECONDITION_FAILED', detail: { stateChanged: true, reason: 'mailbox_retirement_state_unconfirmed' } }
        : { code: 'UNAUTHENTICATED', detail: { stateChanged: true, reason: 'mailbox_retirement_authorization_changed' } })
      expect(createHash('sha256').update(await readFile(sourcePath)).digest('hex')).toBe(sourceHash)
      expect((await f.state.store.getServiceUser(f.service.id))?.id).toBe(f.service.id)
      const held = await findPrincipalByUsername(f.database.db, f.original.username)
      expect(held?.disabled).toBe(true)
      expect(factorIdentity(held)).toBe(factorIdentity(f.enrolled))
      expect(f.reconcile).not.toHaveBeenCalled()
    } finally { release(); await attempt; if (clockChanged) vi.useRealTimers(); blockedDelete.mockRestore() }
  })
  it('rolls back the identity hold when the original session expires during the final authorization reads', async () => {
    const f = await retirementFixture()
    const rows = await f.database.db.query<{ expires_at: string }>('SELECT expires_at FROM sessions WHERE id = $1', [f.initial.sessionId])
    const expiry = Date.parse(rows[0]?.expires_at ?? '')
    if (!Number.isFinite(expiry)) throw new Error('declared fixture expiry missing')
    let checks = 0
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      await expect(f.retire({ authorize: async (tx, source) => {
        checks++
        const checked = await f.options.authorize(tx, source)
        if (checks === 2) vi.setSystemTime(expiry + 1)
        return checked
      } })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    } finally { vi.useRealTimers() }
    expect(checks).toBe(2)
    expect(await f.database.db.query("SELECT id FROM jobs WHERE kind='mailbox.retire'")).toHaveLength(0)
    const unchanged = await findPrincipalByUsername(f.database.db, f.original.username)
    expect(unchanged?.disabled).toBe(false)
    expect(factorIdentity(unchanged)).toBe(factorIdentity(f.enrolled))
    expect(f.reconcile).not.toHaveBeenCalled()
  })
  it('keeps the ordinary non-mail HTTP deletion and default StateStore behavior', async () => {
    const f = await retirementFixture()
    const ftp = await f.state.store.getServiceUserByLogin('closed@alpha.example.test')
    if (!ftp) throw new Error('declared non-mail fixture missing')
    expect((await f.httpDelete(ftp.id)).status).toBe(200)
    expect(await f.state.store.getServiceUser(ftp.id)).toBeNull()
    expect(await f.database.db.query("SELECT id FROM jobs WHERE kind='mailbox.retire'")).toHaveLength(0)
    const mailbox = await findPrincipalByUsername(f.database.db, f.original.username)
    expect(mailbox?.disabled).toBe(false)
    expect(factorIdentity(mailbox)).toBe(factorIdentity(f.enrolled))
  })
  it.each(['root', 'user'] as const)('preserves existing %s permissions on suspended-account mail services', async kind => {
    const f = await retirementFixture(kind)
    await f.state.store.suspendAccount(f.alpha.id, 'declared fixture suspension')
    if (kind === 'root') {
      await expect(f.retire()).rejects.toMatchObject({ detail: { reason: 'mailbox_retirement_native_unverified' } })
      expect(await f.state.store.getServiceUser(f.service.id)).toBeNull()
      expect((await findPrincipalByUsername(f.database.db, f.original.username))?.disabled).toBe(true)
    } else {
      await expect(f.retire()).rejects.toMatchObject({ code: 'FORBIDDEN' })
      expect((await f.state.store.getServiceUser(f.service.id))?.id).toBe(f.service.id)
      expect((await findPrincipalByUsername(f.database.db, f.original.username))?.disabled).toBe(false)
      expect(await f.database.db.query("SELECT id FROM jobs WHERE kind='mailbox.retire'")).toHaveLength(0)
    }
    expect(factorIdentity(await findPrincipalByUsername(f.database.db, f.original.username))).toBe(factorIdentity(f.enrolled))
  })
  it('rejects the original actor credential revoked while waiting for database admission', async () => {
    const f = await retirementFixture()
    let enter: () => void = () => undefined, release: () => void = () => undefined
    const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const blocker = f.database.db.transaction(async tx => { enter(); await gate; await tx.query('UPDATE principals SET disabled = 1 WHERE id = $1', [f.actor.id]) })
    await entered
    const attempt = f.retire()
    const denied = expect(attempt).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    release(); await blocker; await denied
    expect(await f.database.db.query("SELECT id FROM jobs WHERE kind='mailbox.retire'")).toHaveLength(0)
    expect((await findPrincipalByUsername(f.database.db, f.original.username))?.disabled).toBe(false)
    expect(factorIdentity(await findPrincipalByUsername(f.database.db, f.original.username))).toBe(factorIdentity(f.enrolled))
    expect(f.reconcile).not.toHaveBeenCalled()
  })
})

describe('xMail mailbox inbox', () => {
  it('signs in with the mailbox password and lists, reads, sends and deletes only that mailbox', async () => {
    const boxes = new Map<string, Box>([
      ['inbox@alpha.example.test', { password: 'alpha-secret', messages: [message(7, 'Alpha note', 'Hello from alpha')], sent: [] }],
      ['other@beta.example.test', { password: 'beta-secret', messages: [message(9, 'Beta note', 'Hello from beta')], sent: [] }],
    ])
    let verifies = 0
    const transport: MailboxTransport = {
      async verify(mailbox, password) {
        verifies += 1
        const box = boxes.get(mailbox)
        if (!box || box.password !== password) fail('UNAUTHENTICATED', 'imap rejected the password')
      },
      async list(mailbox, password) {
        await this.verify(mailbox, password)
        return boxes.get(mailbox)!.messages.map(({ body: _body, ...summary }) => summary)
      },
      async read(mailbox, password, uid) {
        await this.verify(mailbox, password)
        const found = boxes.get(mailbox)!.messages.find(item => item.uid === uid)
        if (!found) return fail('NOT_FOUND', 'message not found')
        found.unread = false
        return { ...found }
      },
      async remove(mailbox, password, uid, _folder, options) {
        await this.verify(mailbox, password)
        if (options?.uidValidity !== 17) return fail('CONFLICT', 'declared source namespace changed', { stateChanged: false })
        const box = boxes.get(mailbox)!
        const next = box.messages.filter(item => item.uid !== uid)
        if (next.length === box.messages.length) fail('NOT_FOUND', 'message not found')
        box.messages = next
      },
      async move(mailbox, password, uid, from, _to, options) {
        await this.remove(mailbox, password, uid, from, options)
        return { uid: uid + 40, uidValidity: 23, uidValidityObserved: true, sourceUidValidity: 17, sourceUidValidityObserved: true }
      },
      async send(mailbox, password, input) {
        await this.verify(mailbox, password)
        boxes.get(mailbox)!.sent.push(input)
        return { messageId: '<sent@alpha.example.test>' }
      },
    }
    const { database, state, alpha, call, login, sessionOf } = await harness(transport)
    const wrong = await login('inbox@alpha.example.test', 'nope')
    expect(wrong.status).toBe(401)
    expect(wrong.payload.detail).toBe('invalid username or password')
    expect(wrong.cookie).toBe('')
    expect(await database.db.query('SELECT session_id FROM mailbox_sessions')).toEqual([])

    const missing = await login('nobody@alpha.example.test', 'alpha-secret')
    expect(missing.status).toBe(401)
    expect(missing.payload.detail).toBe('invalid username or password')

    const closed = await login('closed@alpha.example.test', 'alpha-secret')
    expect(closed.status).toBe(401)
    const verifiesBeforeSuspend = verifies
    await state.store.suspendAccount(alpha.id, 'billing')
    const suspended = await login('inbox@alpha.example.test', 'alpha-secret')
    expect(suspended.status).toBe(401)
    expect(suspended.payload.detail).toBe('invalid username or password')
    expect(verifies).toBe(verifiesBeforeSuspend)
    await state.store.unsuspendAccount(alpha.id)

    const logged = await login('inbox@alpha.example.test', 'alpha-secret')
    expect(logged.status).toBe(200)
    expect(logged.payload.mailbox).toBe('inbox@alpha.example.test')
    expect(logged.cookie.startsWith('__Host-xmail_session=')).toBe(true)
    const rows = await database.db.query<{ mailbox: string }>('SELECT mailbox FROM mailbox_sessions')
    expect(rows.map(row => row.mailbox)).toEqual(['inbox@alpha.example.test'])
    const session = sessionOf(logged)

    const listed = await call('GET', '/api/webmail/inbox', undefined, session)
    expect(listed.status).toBe(200)
    expect(listed.payload).toMatchObject({ folder: 'INBOX', complete: true })
    expect(listed.payload.messages?.map(item => item.subject)).toEqual(['Alpha note'])
    expect(listed.payload.messages?.[0]?.body).toBeUndefined()

    const foreign = await call('GET', '/api/webmail/inbox/9', undefined, session)
    expect(foreign.status).toBe(404)

    const read = await call('GET', '/api/webmail/inbox/7', undefined, session)
    expect(read.status).toBe(200)
    expect(read.payload.message?.body).toBe('Hello from alpha')
    expect(read.payload.message?.unread).toBe(false)

    const sent = await call('POST', '/api/webmail/send', { to: 'other@beta.example.test', subject: 'Hello', text: 'A real message' }, session)
    expect(sent.status).toBe(201)
    expect(sent.payload.messageId).toBe('<sent@alpha.example.test>')
    expect(boxes.get('inbox@alpha.example.test')!.sent).toEqual([expect.objectContaining({ to: 'other@beta.example.test', subject: 'Hello', text: 'A real message' })])

    const invalid = await call('POST', '/api/webmail/send', { to: 'not-an-address', subject: 'Hello', text: 'A real message' }, session)
    expect(invalid.status).toBe(422)

    const removed = await call('DELETE', '/api/webmail/inbox/7', { uidValidity: 17 }, session)
    expect(removed.status).toBe(200)
    const empty = await call('GET', '/api/webmail/inbox', undefined, session)
    expect(empty.payload.messages).toEqual([])

    const other = await login('other@beta.example.test', 'beta-secret')
    const otherList = await call('GET', '/api/webmail/inbox', undefined, sessionOf(other))
    expect(otherList.payload.messages?.map(item => item.subject)).toEqual(['Beta note'])
    const stillEmpty = await call('GET', '/api/webmail/inbox', undefined, session)
    expect(stillEmpty.payload.messages).toEqual([])
  })

  it('moves a delete into Trash and expunges only after confirmation', async () => {
    const boxes = new Map<string, Box>([
      ['inbox@alpha.example.test', { password: 'alpha-secret', messages: [message(7, 'Alpha note', 'Hello from alpha')], sent: [] }],
    ])
    let removed = 0
    let movedTo = ''
    const transport: MailboxTransport = {
      async verify() { return undefined },
      async list(mailbox) { return boxes.get(mailbox)!.messages },
      async read() { return fail('NOT_FOUND', 'message not found') },
      async remove(_mailbox, _password, uid, folder, options) {
        if (uid !== 16 || folder !== 'Trash' || options?.uidValidity !== 23) return fail('CONFLICT', 'declared Trash identity changed', { stateChanged: false })
        removed += 1
      },
      async move(_mailbox, _password, uid, _from, to, options) {
        if (options?.uidValidity !== 17) return fail('CONFLICT', 'declared source namespace changed', { stateChanged: false })
        movedTo = to
        boxes.get('inbox@alpha.example.test')!.messages = []
        return { uid: uid + 9, uidValidity: 23, uidValidityObserved: true, sourceUidValidity: 17, sourceUidValidityObserved: true }
      },
      async send() { return { messageId: '<x>' } },
    }
    const { call, login, sessionOf } = await harness(transport)
    const session = sessionOf(await login('inbox@alpha.example.test', 'alpha-secret'))
    const trashed = await call('DELETE', '/api/webmail/inbox/7?folder=INBOX', { uidValidity: 17 }, session)
    expect(trashed.status).toBe(200)
    expect(movedTo).toBe('Trash')
    expect(removed).toBe(0)
    expect(trashed.payload).toMatchObject({ uid: 16, folder: 'Trash' })
    const blocked = await call('DELETE', '/api/webmail/inbox/16?folder=Trash', { uidValidity: 23 }, session)
    expect(blocked.status).toBe(412)
    expect(blocked.payload.detail).toBe('Deleting a message from Trash removes it permanently.')
    expect(removed).toBe(0)
    const gone = await call('DELETE', '/api/webmail/inbox/16?folder=Trash&confirm=delete', { uidValidity: 23 }, session)
    expect(gone.status).toBe(200)
    expect(removed).toBe(1)
    expect(imapHumanCopy('IMAP UID MOVE/COPY failed: NO [TRYCREATE] Mailbox does not exist')).toBe('That folder is not on this mailbox yet.')
  })

  it('converts a mail date to UTC and keeps text that is not a date', () => {
    expect(mailReceivedAtUtc('22-Oct-2026 14:30:00 +0300')).toBe('2026-10-22T11:30:00.000Z')
    expect(mailReceivedAtUtc('Thu, 23 Oct 2026 12:00:00 +0000')).toBe('2026-10-23T12:00:00.000Z')
    expect(mailReceivedAtUtc('not a date')).toBe('not a date')
    expect(mailReceivedAtUtc('')).toBe('')
  })

  it('binds the mailbox document to the stored quota and only the settings that were written', async () => {
    let reads = 0
    const boxes = new Map<string, Box>([
      ['inbox@alpha.example.test', { password: 'alpha-secret', messages: [message(7, 'Alpha note', 'Hello from alpha')], sent: [] }],
    ])
    const transport: MailboxTransport = {
      async verify(mailbox, password) {
        const box = boxes.get(mailbox)
        if (!box || box.password !== password) fail('UNAUTHENTICATED', 'imap rejected the password')
      },
      async list(mailbox, password) {
        await this.verify(mailbox, password)
        return boxes.get(mailbox)!.messages.map(({ body: _body, ...summary }) => summary)
      },
      async read(mailbox, password, uid) {
        reads += 1
        await this.verify(mailbox, password)
        const found = boxes.get(mailbox)!.messages.find(item => item.uid === uid)
        if (!found) return fail('NOT_FOUND', 'message not found')
        return { ...found, unread: false }
      },
      async remove() { return undefined },
      async send() { return { messageId: '<sent@alpha.example.test>' } },
    }
    const { database, state, alpha, login } = await harness(transport)
    const logged = await login('inbox@alpha.example.test', 'alpha-secret')
    expect(logged.status).toBe(200)
    const rows = await database.db.query<{ session_id: string }>('SELECT session_id FROM mailbox_sessions')
    const sessionId = rows[0]?.session_id ?? ''
    const read = async () => loadMailDocument({
      db: database.db, store: state.store, serverSecret: SECRET, sessionId, transport,
    })
    const before = await read()
    expect(reads).toBe(1)
    expect(before.mailbox).toBe('inbox@alpha.example.test')
    expect(before.quotaLimitMb).toBe(100)
    expect(before).not.toHaveProperty('quotaUsedMb')
    expect(before.messages?.map(item => [item.subject, item.body, item.bodyPending, item.unread])).toEqual([['Alpha note', 'Hello from alpha', false, false]])
    expect(before.vacationEnabled).toBe(false)
    expect(before.sieveRules).toEqual([])
    expect(before.identityDkim).toBeUndefined()
    expect(before.identitySize).toBeUndefined()
    expect(before.mailListFailed).toBeUndefined()
    const refresh = await loadMailDocument({ db: database.db, store: state.store, serverSecret: SECRET, sessionId, transport, readFirst: false })
    expect(reads).toBe(1)
    expect(refresh.messages?.map(item => [item.subject, item.body, item.bodyPending, item.unread])).toEqual([['Alpha note', '', true, true]])
    expect(refresh.mailbox).toBe('inbox@alpha.example.test')
    expect(refresh.quotaLimitMb).toBe(100)

    const extended = new ExtendedFeaturesStore(state.store.rootDir)
    await extended.saveVacationResponder('inbox@alpha.example.test', { enabled: true, subject: 'Away', body: 'Out of office' })
    await extended.saveEmailFilter({
      accountId: alpha.id, mailbox: 'inbox@alpha.example.test', name: 'Orders',
      rules: [{ field: 'subject', operator: 'contains', value: 'invoice' }], action: 'folder', actionTarget: 'Orders', enabled: false,
    })
    await extended.provisionBatchEmailAuth(['alpha.example.test'], '192.0.2.10')
    const after = await read()
    expect(after.vacationEnabled).toBe(true)
    expect(after.sieveRules).toEqual([expect.objectContaining({ name: 'Orders', condition: 'Subject contains invoice', action: 'File into Orders', enabled: false })])
    expect(after.identityDkim).toBe('Selector default is stored for alpha.example.test')
    expect(after.identitySpf).toContain('v=spf1 +a +mx +ip4:192.0.2.10 ~all')
    expect(after.identitySpf).toContain('v=DMARC1; p=quarantine')
    expect(after.identitySize).toBeUndefined()
  })

  it('keeps the stored quota when the mail server cannot be listed', async () => {
    const transport: MailboxTransport = {
      async verify() { return undefined },
      async list() { return fail('PRECONDITION_FAILED', 'the mail server could not be reached (ECONNREFUSED)') },
      async read() { return fail('PRECONDITION_FAILED', 'the mail server could not be reached (ECONNREFUSED)') },
      async remove() { return undefined },
      async send() { return fail('PRECONDITION_FAILED', 'the mail server could not be reached (ECONNREFUSED)') },
    }
    const { database, state, login } = await harness(transport)
    const logged = await login('inbox@alpha.example.test', 'alpha-secret')
    expect(logged.status).toBe(200)
    const rows = await database.db.query<{ session_id: string }>('SELECT session_id FROM mailbox_sessions')
    const loaded = await loadMailDocument({
      db: database.db, store: state.store, serverSecret: SECRET, sessionId: rows[0]?.session_id ?? '', transport,
    })
    expect(loaded.quotaLimitMb).toBe(100)
    expect(loaded.messages).toBeUndefined()
    expect(loaded.mailListFailed).toBe(true)
  })

  it('reports an unreachable mail server without treating it as a bad password', async () => {
    const down: MailboxTransport = {
      async verify() { fail('PRECONDITION_FAILED', 'the mail server could not be reached (ECONNREFUSED)') },
      async list() { return fail('PRECONDITION_FAILED', 'the mail server could not be reached (ECONNREFUSED)') },
      async read() { return fail('PRECONDITION_FAILED', 'the mail server could not be reached (ECONNREFUSED)') },
      async remove() { return fail('PRECONDITION_FAILED', 'the mail server could not be reached (ECONNREFUSED)') },
      async send() { return fail('PRECONDITION_FAILED', 'the mail server could not be reached (ECONNREFUSED)') },
    }
    const { login } = await harness(down)
    const response = await login('inbox@alpha.example.test', 'alpha-secret')
    expect(response.status).toBe(412)
    expect(response.payload.detail).toMatch(/the mail server could not be reached/)
  })

  it('reads the postfix size limit and an empty milter as unsigned mail', async () => {
    const transport: MailboxTransport = {
      async verify() { return undefined },
      async list() { return [] },
      async read() { return fail('NOT_FOUND', 'message not found') },
      async remove() { return undefined },
      async send() { return { messageId: '<sent@alpha.example.test>' } },
    }
    const { database, state, login } = await harness(transport)
    const logged = await login('inbox@alpha.example.test', 'alpha-secret')
    expect(logged.status).toBe(200)
    const rows = await database.db.query<{ session_id: string }>('SELECT session_id FROM mailbox_sessions')
    const postfixMain = [
      'message_size_limit = 10240000',
      'smtpd_milters =',
    ].join('\n')
    const loaded = await loadMailDocument({
      db: database.db, store: state.store, serverSecret: SECRET, sessionId: rows[0]?.session_id ?? '', transport, postfixMain,
    })
    expect(loaded.identitySize).toBe('10 MB')
    expect(loaded.identityDkim).toBe('OpenDKIM status unknown')
    expect(loaded.identityDkim).not.toContain('connected')
    expect(loaded.identitySpf).toBe('SPF record missing · DMARC record missing')
    const refused = await loadMailDocument({
      db: database.db, store: state.store, serverSecret: SECRET, sessionId: rows[0]?.session_id ?? '', transport,
      postfixMain: 'smtpd_milters = local:opendkim/opendkim.sock\n',
      dkimProbe: 'refused',
      dkimByDomain: { 'alpha.example.test': { selector: 'xp202610', dnsTxt: 'v=DKIM1; k=rsa; p=abc' } },
    })
    expect(refused.identityDkim).toBe('OpenDKIM refused the connection · v=DKIM1; k=rsa; p=abc')
    expect(refused.identitySpf).toBe('v=spf1 a mx ~all · v=DMARC1; p=none')
  })

  it('holds the mailbox identity and sessions without claiming unverified native deletion', async () => {
    const transport: MailboxTransport = {
      async verify(mailbox, password) {
        const accepted = mailbox === 'inbox@alpha.example.test' ? 'alpha-secret' : mailbox === 'other@beta.example.test' ? 'beta-secret' : ''
        if (password !== accepted) fail('UNAUTHENTICATED', 'imap rejected the password')
      },
      async list() { return [] },
      async read() { return fail('NOT_FOUND', 'message not found') },
      async remove() { return undefined },
      async send() { return { messageId: '<sent@alpha.example.test>' } },
    }
    const { database, state, login, call, sessionOf } = await harness(transport)
    const inbox = await login('inbox@alpha.example.test', 'alpha-secret')
    const other = await login('other@beta.example.test', 'beta-secret')
    expect(inbox.status).toBe(200)
    expect(other.status).toBe(200)
    const names = async () => (await database.db.query<{ username: string }>('SELECT username FROM principals ORDER BY username')).map(row => row.username)
    const inboxName = mailboxPrincipalUsername('inbox@alpha.example.test')
    const otherName = mailboxPrincipalUsername('other@beta.example.test')
    const before = await names()
    expect(before).toEqual(expect.arrayContaining([inboxName, otherName]))
    expect(await database.db.query('SELECT session_id FROM mailbox_sessions')).toHaveLength(2)
    const signedOut = await call('POST', '/api/auth/logout', {}, sessionOf(inbox))
    expect(signedOut.status).toBe(200)

    await createRootPrincipal(database.db, {
      username: 'root',
      passwordHash: await hashPasswordArgon2id('RootPassword!2026'),
      forcePasswordChange: false,
    })
    const origin = 'https://whm.example.test'
    const whm = createApiApp({
      db: database.db, store: state.store, serverSecret: SECRET, entryPoint: 'xwhm',
      publicOrigin: origin, allowedOrigins: [origin], secureCookies: true,
    })
    const rootLogin = await whm.fetch(new Request(`${origin}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: 'RootPassword!2026' }),
    }), { remoteAddress: '192.0.2.5' })
    expect(rootLogin.status).toBe(200)
    const rootBody = await rootLogin.json() as { csrfToken?: string }
    const cookie = (rootLogin.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    const serviceUser = await state.store.getServiceUserByLogin('inbox@alpha.example.test')
    expect(serviceUser?.id).toBeTruthy()
    const removed = await whm.fetch(new Request(`${origin}/api/service-users/${serviceUser!.id}`, {
      method: 'DELETE',
      headers: { cookie, 'x-csrf-token': rootBody.csrfToken ?? '' },
    }), { remoteAddress: '192.0.2.5' })
    expect(removed.status).toBe(412)
    expect(await removed.json()).toMatchObject({ code: 'PRECONDITION_FAILED', details: { reason: 'mailbox_retirement_native_unverified', nativeDeletionVerified: false } })

    const after = await names()
    expect(after).toContain(inboxName)
    expect((await findPrincipalByUsername(database.db, inboxName))?.disabled).toBe(true)
    expect(after).toContain(otherName)
    expect(after.filter(name => name.startsWith('mbx'))).toHaveLength(2)
    const sessions = await database.db.query<{ mailbox: string }>('SELECT mailbox FROM mailbox_sessions')
    expect(sessions.map(row => row.mailbox)).toEqual(['other@beta.example.test'])
    expect(await state.store.getServiceUserByLogin('inbox@alpha.example.test')).toBeNull()
    expect(await state.store.getServiceUserByLogin('other@beta.example.test')).not.toBeNull()
    const audit = await listAudit(database.db, { limit: 20 })
    expect(audit.some(row => row.action === 'mailbox.deleted' && row.outcome === 'ok')).toBe(false)
    const requested = audit.find(row => row.action === 'mailbox.retirement_requested')
    expect(requested?.outcome).toBe('ok')
    expect(requested?.actor).toBe('root')
    expect(requested?.target).toBe('mailbox:inbox@alpha.example.test')
    const logout = audit.find(row => row.action === 'auth.logout' && row.target.includes('inbox@alpha.example.test'))
    expect(logout?.actor).toBe('inbox@alpha.example.test')
    expect(logout?.actor.startsWith('mbx')).toBe(false)
  })

  it('shows a mailbox address in place of the stored principal id', () => {
    const address = 'inbox@alpha.example.test'
    const username = mailboxPrincipalUsername(address)
    const index = mailboxAddressIndex([address, 'not-an-address'])
    expect(rewriteMailboxIds(username, index)).toBe(address)
    expect(rewriteMailboxIds(`service-user:${username}`, index)).toBe(`service-user:${address}`)
    expect(rewriteMailboxIds('root', index)).toBe('root')
    expect(auditActorQuery(address)).toBe(username)
    expect(auditActorQuery('root')).toBe('root')
    expect(auditTargetQuery(`mailbox:${address}`)).toBe(`mailbox:${username}`)
    expect(auditTargetQuery('/health')).toBe('/health')
  })

  it('turns a refused local IMAP connection into a mail-server error', async () => {
    const transport = createLocalMailboxTransport({
      XPANEL_IMAP_HOST: '127.0.0.1',
      XPANEL_IMAP_PORT: '1',
      XPANEL_IMAP_TIMEOUT_MS: '1000',
    })
    await expect(transport.verify('inbox@alpha.example.test', 'alpha-secret')).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/the mail server could not be reached/),
    })
  })

  it('serves POST/PATCH /api/webmail/inbox/:uid/flag, offset pagination and remoteImages=1 over HTTP', async () => {
    const messages = [
      { ...message(15, 'Latest', 'Body 15'), flagged: false, hasRemoteImages: true },
      { ...message(14, 'Older', 'Body 14'), flagged: true, hasRemoteImages: false },
    ]
    const transport: MailboxTransport = {
      async verify(mbx, pw) { if (mbx !== 'inbox@alpha.example.test' || pw !== 'alpha-secret') fail('UNAUTHENTICATED', 'bad') },
      async list(mbx, pw) { await this.verify(mbx, pw); return messages.map(({ body: _b, ...rest }) => rest) },
      async read(mbx, pw, uid, _folder, options) {
        await this.verify(mbx, pw)
        const item = messages.find(m => m.uid === uid)
        if (!item) return fail('NOT_FOUND', 'missing')
        return {
          ...item,
          ...(options?.allowRemoteImages ? { remoteImages: [{ src: 'https://cdn.example.test/logo.png', alt: 'Logo' }] } : {}),
        }
      },
      async flag(mbx, pw, uid, _folder, flagged, options) {
        await this.verify(mbx, pw)
        if (options?.uidValidity !== 17) return fail('CONFLICT', 'namespace changed', { stateChanged: false })
        const item = messages.find(m => m.uid === uid)
        if (!item) return fail('NOT_FOUND', 'missing', { stateChanged: false })
        item.flagged = flagged
        return { uid, uidValidity: 17, uidValidityObserved: true, flagged }
      },
      async remove() {},
      async send() { return { messageId: '<id@alpha.example.test>' } },
    }
    const { call, login, sessionOf } = await harness(transport)
    const session = sessionOf(await login('inbox@alpha.example.test', 'alpha-secret'))

    const page = await call('GET', '/api/webmail/inbox?offset=1&limit=1', undefined, session)
    expect(page.status).toBe(200)
    expect(page.payload).toMatchObject({ total: 2, offset: 1, hasMore: false, nextOffset: null })
    expect(page.payload.messages?.map(m => m.uid)).toEqual([14])

    const starred = await call('POST', '/api/webmail/inbox/15/flag', { folder: 'INBOX', uidValidity: 17, flagged: true }, session)
    expect(starred.status).toBe(200)
    expect(starred.payload).toMatchObject({ ok: true, uid: 15, flagged: true })

    const unstarred = await call('PATCH', '/api/webmail/inbox/15/flag', { folder: 'INBOX', uidValidity: 17, flagged: false }, session)
    expect(unstarred.status).toBe(200)
    expect(unstarred.payload).toMatchObject({ ok: true, uid: 15, flagged: false })

    const withImages = await call('GET', '/api/webmail/inbox/15?remoteImages=1', undefined, session)
    expect(withImages.status).toBe(200)
    expect((withImages.payload.message as { remoteImages?: unknown })?.remoteImages).toEqual([{ src: 'https://cdn.example.test/logo.png', alt: 'Logo' }])
  })
})
