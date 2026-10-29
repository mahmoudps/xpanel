import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeHostExecutor, HostReconciler, createAgentApp } from '@xpanel/agent'
import { fail } from '@xpanel/core'
import { createApiToken, createTestDb, createUserPrincipal, listAudit } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { atomicWriteJson, createTestStateStore } from '@xpanel/state'
import { sha256Hex, verifyPasswordArgon2id } from './auth.ts'
import { mailboxPrincipalUsername } from './mail/inbox.ts'
import type { MailboxTransport } from './mail/inbox.ts'
import { createApiApp, listenApiServer } from './server.ts'
import { TEST_AGENT_TOKEN, TEST_SERVER_SECRET } from './testing.ts'

// Public independent Argon2 fixture vector; these identities authenticate disposable synthetic fixtures only.
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const PASSWORD = 'correct horse battery staple'
const ORIGIN = 'https://mail.example.test:2096'
const route = '/api/webmail/vacation'
const application = { status: 'configuration_only', nativeApplied: false } as const
// Static metadata-authority guidance now accompanies every vacation response; it asserts no withheld record exists.
const metadataReview = { status: 'review_required', reason: 'mailbox_metadata_binding_unverified' } as const
const cleanup: Array<() => Promise<unknown>> = []

interface VacationRecord {
  mailbox: string
  enabled: boolean
  subject: string
  body: string
  htmlBody: string
  startDate: string | null
  endDate: string | null
  replyIntervalHours: number
  compiledSieve: string
  updatedAt: string
  ownerAuthority?: { accountId: string; serviceUserId: string; mailbox: string }
}
interface SealedView {
  context: { mailbox: string }
  vacation: VacationRecord | null
  revision: string
  application: { status: string; nativeApplied: boolean }
}
interface SealedAck {
  context: { mailbox: string }
  vacation: VacationRecord
  revision: string
  stateChanged: boolean
  application: { status: string; nativeApplied: boolean }
}
interface Problem {
  code: string
  details?: Record<string, unknown>
}
interface Session {
  cookie: string
  csrf: string
  sessionId: string
}
interface Snapshot {
  contents: { inbox: string | null; sibling: string | null; foreign: string | null }
  audits: number
  agentCalls: number
  files: number
  actions: number
  tests: number
  commands: number
}

const editable = ['enabled', 'subject', 'body', 'htmlBody', 'startDate', 'endDate', 'replyIntervalHours'] as const
const draft = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  enabled: true,
  subject: 'Away from the office',
  body: '  I will reply when I am back.\r\nThanks.  ',
  htmlBody: '',
  startDate: null,
  endDate: null,
  replyIntervalHours: 24,
  ...patch,
})

const fixture = async () => {
  const database = await createTestDb()
  cleanup.push(() => database.close())
  const state = await createTestStateStore()
  cleanup.push(() => state.close())
  const features = await state.store.createFeatureList({ name: 'Vacation policy', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({
    name: 'Vacation plan', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 4, forwarders: 4, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 },
    dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100,
  })
  await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const account = (username: string) => state.store.createAccount({
    username, passwordHash: HASH, primaryDomain: `${username}.example.test`, planId: plan.id, ownerId: null,
    contactEmail: `owner@${username}.example.test`, ipv4: '192.0.2.10', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} },
  })
  const owner = await account('vacationa'), other = await account('vacationb')
  const mailbox = (accountId: string, local: string, domain: string) => state.store.createServiceUser({
    accountId, login: `${local}@${domain}`, passwordHash: `{ARGON2ID}${HASH}`,
    services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html',
  })
  const inbox = await mailbox(owner.id, 'inbox', owner.primaryDomain)
  const sibling = await mailbox(owner.id, 'support', owner.primaryDomain)
  const foreign = await mailbox(other.id, 'inbox', other.primaryDomain)
  // Pre-provision the sealed mailbox identities so the real mail login path only seals a session here.
  const sealedPrincipal = await createUserPrincipal(database.db, { username: mailboxPrincipalUsername(inbox.login), accountId: owner.id, passwordHash: HASH })
  await createUserPrincipal(database.db, { username: mailboxPrincipalUsername(sibling.login), accountId: owner.id, passwordHash: HASH })
  await createUserPrincipal(database.db, { username: mailboxPrincipalUsername(foreign.login), accountId: other.id, passwordHash: HASH })
  const adminPrincipal = await createUserPrincipal(database.db, { username: owner.username, accountId: owner.id, passwordHash: HASH })
  // The existing sanctioned mail transport fake verifies the stored synthetic mailbox hash; no route logic is replaced.
  const transport: MailboxTransport = {
    async verify(login, password) {
      const service = await state.store.getServiceUserByLogin(login)
      const stored = service ? await state.store.getServiceUserHash(service.id) : null
      const hash = stored?.startsWith('{ARGON2ID}') ? stored.slice('{ARGON2ID}'.length) : stored
      if (!service?.services.email || !hash || !await verifyPasswordArgon2id(password, hash)) fail('UNAUTHENTICATED', 'invalid mailbox credentials')
    },
    async list() { return [] },
    async read() { return fail('NOT_FOUND', 'message not found') },
    async remove() {},
    async send() { return { messageId: '<synthetic@example.test>' } },
  }
  const executor = new FakeHostExecutor()
  const osProfile = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
  const agentApp = createAgentApp({
    reconciler: new HostReconciler({ store: state.store, db: database.db, executor, os: osProfile }),
    store: state.store, db: database.db, executor,
    os: { id: osProfile.id, versionId: osProfile.versionId, family: osProfile.family },
    agentToken: TEST_AGENT_TOKEN,
  })
  const agent = vi.spyOn(agentApp, 'fetch')
  const sealedApp = createApiApp({
    db: database.db, store: state.store, serverSecret: TEST_SERVER_SECRET,
    entryPoint: 'xmail', publicOrigin: ORIGIN, allowedOrigins: [ORIGIN],
    secureCookies: true, requireOriginHeader: true,
    mailboxTransport: transport, agentApp, agentToken: TEST_AGENT_TOKEN,
  })
  const listener = await listenApiServer(sealedApp)
  cleanup.push(async () => { listener.server.closeAllConnections(); await listener.close() })
  const legacy = createApiApp({ db: database.db, store: state.store, serverSecret: TEST_SERVER_SECRET, agentApp, agentToken: TEST_AGENT_TOKEN })
  const token = async (scopes: string[], principalId = adminPrincipal.id) => {
    const raw = `xp_${randomUUID()}`
    await createApiToken(database.db, { principalId, name: 'Synthetic vacation acceptance', tokenHash: sha256Hex(raw), scopes, expiresAt: new Date(Date.now() + 60_000).toISOString() })
    return raw
  }
  const credential = await token(['webmail:read', 'webmail:write'])
  const readOnly = await token(['webmail:read'])
  const call = (path: string, method = 'GET', body?: unknown, session?: Session, extra: Record<string, string> = {}): Promise<Response> => new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1', port: listener.port, path, method,
      headers: {
        host: new URL(ORIGIN).host,
        origin: ORIGIN,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}),
        ...extra,
      },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
      response.once('error', reject)
      response.once('end', () => resolve(new Response(Buffer.concat(chunks), {
        status: response.statusCode ?? 500,
        headers: { 'set-cookie': response.headers['set-cookie']?.join(', ') ?? '' },
      })))
    })
    request.once('error', reject)
    request.end(body === undefined ? undefined : JSON.stringify(body))
  })
  const sessions = new Map<string, Session>()
  const open = async (address: string = inbox.login): Promise<Session> => {
    const cached = sessions.get(address)
    if (cached) return cached
    const response = await call('/api/auth/login', 'POST', { username: address, password: PASSWORD })
    expect(response.status).toBe(200)
    const body = await response.json() as { csrfToken?: unknown; mailbox?: unknown; session?: { id?: unknown }; principal?: { username?: unknown } }
    expect(body.mailbox).toBe(address)
    expect(body.principal?.username).toMatch(/^mbx[0-9a-f]{28}$/)
    const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0]!
    expect(cookie.startsWith('__Host-xmail_session=')).toBe(true)
    const session = {
      cookie,
      csrf: typeof body.csrfToken === 'string' ? body.csrfToken : '',
      sessionId: typeof body.session?.id === 'string' ? body.session.id : '',
    }
    expect(session.csrf).toMatch(/^[0-9a-f]{64}$/)
    expect(session.sessionId.length).toBeGreaterThan(0)
    sessions.set(address, session)
    return session
  }
  const view = async (session: Session, path = route): Promise<SealedView> => {
    const response = await call(path, 'GET', undefined, session)
    expect(response.status).toBe(200)
    return await response.json() as SealedView
  }
  const save = (session: Session, body: unknown) => call(route, 'PUT', body, session)
  const saveValid = async (session: Session, patch: Record<string, unknown> = {}): Promise<SealedAck> => {
    const current = await view(session)
    const response = await save(session, { ...draft(patch), expectedRevision: current.revision })
    expect(response.status).toBe(200)
    return await response.json() as SealedAck
  }
  const legacyCall = (path: string, method = 'GET', body?: unknown, raw: string = credential) => legacy.fetch(new Request(`http://panel.example.test${path}`, {
    method,
    headers: { authorization: `Bearer ${raw}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  const filePath = (login: string) => join(state.rootDir, 'extended', 'webmail', 'vacation', `${encodeURIComponent(login)}.json`)
  const readBytes = async (login: string): Promise<string | null> => {
    try { return await readFile(filePath(login), 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  const stored = async (login: string = inbox.login): Promise<VacationRecord | null> => {
    const raw = await readBytes(login)
    return raw === null ? null : JSON.parse(raw) as VacationRecord
  }
  const audits = () => listAudit(database.db, { action: 'webmail.vacation.updated', limit: 100 })
  // Persisted records carry the server-captured mailbox lifetime that the projection omits.
  const authorityFor = (service: { id: string; accountId: string; login: string }) => ({ accountId: service.accountId, serviceUserId: service.id, mailbox: service.login })
  const snapshot = async (): Promise<Snapshot> => ({
    contents: { inbox: await readBytes(inbox.login), sibling: await readBytes(sibling.login), foreign: await readBytes(foreign.login) },
    audits: (await audits()).length,
    agentCalls: agent.mock.calls.length,
    files: executor.files.size,
    actions: executor.executedActions.length,
    tests: executor.executedTests.length,
    commands: executor.executedCommands.length,
  })
  return {
    database, state, features, owner, other, inbox, sibling, foreign, sealedPrincipal, adminPrincipal,
    credential, readOnly, open, view, save, saveValid, call, legacyCall, filePath, readBytes, stored, audits, snapshot, authorityFor,
  }
}

const refuse = async (response: Response, status: number, code: string, label?: string): Promise<Problem> => {
  expect(response.status, label).toBe(status)
  const body = await response.json() as Problem
  expect(body.code, label).toBe(code)
  return body
}
// Sealed request validation fails before any transactional write, so the refusal is a body-independent no-op.
const expectValidation = (response: Response, label?: string): Promise<Problem> => refuse(response, 422, 'VALIDATION', label)
const timeout = (ms: number, message: string) => new Promise<never>((_, reject) => { setTimeout(() => reject(new Error(message)), ms) })

describe('sealed mailbox vacation responder configuration HTTP security acceptance', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })
  afterEach(async () => {
    vi.restoreAllMocks()
    const results = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close()))
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Synthetic vacation fixture cleanup failed')
  })

  it('returns the sealed mailbox context, absence revision and configuration-only application without allocating state', async () => {
    const session = await f.open()
    const before = await f.snapshot()
    const first = await f.view(session), second = await f.view(session)
    expect(first).toEqual(second)
    expect(first.context).toEqual({ mailbox: f.inbox.login })
    expect(first.vacation).toBeNull()
    expect(first.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(first.application).toEqual(application)
    expect(await f.readBytes(f.inbox.login)).toBeNull()
    expect(await f.snapshot()).toEqual(before)
  })

  it('saves exactly the seven editable fields with the captured revision and reads the stored rule back exactly', async () => {
    const session = await f.open()
    const absence = await f.view(session)
    const patch = {
      enabled: true, subject: '  Away from the office  ', body: '  Line one\r\nLine two  ', htmlBody: '<p>Away &amp; away</p>',
      startDate: '2026-12-24T00:00:00.000Z', endDate: '2027-01-02T12:30:00.000Z', replyIntervalHours: 30,
    }
    const response = await f.save(session, { ...patch, expectedRevision: absence.revision })
    expect(response.status).toBe(200)
    const ack = await response.json() as SealedAck
    expect(ack.context).toEqual({ mailbox: f.inbox.login })
    expect(ack.stateChanged).toBe(true)
    expect(ack.application).toEqual(application)
    expect(ack.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(ack.revision).not.toBe(absence.revision)
    expect(ack.vacation).toMatchObject({
      mailbox: f.inbox.login, enabled: true, subject: 'Away from the office', body: patch.body, htmlBody: patch.htmlBody,
      startDate: patch.startDate, endDate: patch.endDate, replyIntervalHours: 30,
    })
    expect(ack.vacation.compiledSieve).toContain('vacation :seconds 108000')
    expect(ack.vacation.compiledSieve).toContain('"vacation-seconds"')
    expect(ack.vacation.compiledSieve).toContain('currentdate :zone "+0000"')
    expect(ack.vacation.compiledSieve).toContain(' :mime ')
    expect(ack.vacation.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    const readback = await f.view(session)
    expect(readback).toEqual({ context: { mailbox: f.inbox.login }, vacation: ack.vacation, revision: ack.revision, application, metadataReview })
    const saved = (await f.stored())!
    expect(saved).toEqual({ ...ack.vacation, ownerAuthority: f.authorityFor(f.inbox) })
    expect(Object.keys(saved).sort()).toEqual(['body', 'compiledSieve', 'enabled', 'endDate', 'htmlBody', 'mailbox', 'ownerAuthority', 'replyIntervalHours', 'startDate', 'subject', 'updatedAt'])
    const later = await f.saveValid(session, { replyIntervalHours: 48, startDate: null, endDate: null })
    expect(later.revision).not.toBe(ack.revision)
    expect(later.vacation.compiledSieve).toContain('vacation :days 2 ')
    expect((await f.view(session))).toMatchObject({ vacation: later.vacation, revision: later.revision })
  })

  it('rejects bodies that are not exactly the seven editable fields plus expectedRevision', async () => {
    const session = await f.open()
    await f.saveValid(session)
    const current = (await f.view(session)).revision
    const valid: Record<string, unknown> = { ...draft(), expectedRevision: current }
    const before = await f.snapshot()
    for (const key of editable) {
      const body: Record<string, unknown> = { ...valid }
      delete body[key]
      await expectValidation(await f.save(session, body), `missing ${key}`)
    }
    const missingRevision = { ...draft() }
    await expectValidation(await f.save(session, missingRevision), 'missing expectedRevision')
    for (const key of ['mailbox', 'owner', 'accountId', 'compiledSieve', 'updatedAt', 'nativeApplied', 'application', 'revision', 'unexpected']) {
      await expectValidation(await f.save(session, { ...valid, [key]: key === 'mailbox' ? f.foreign.login : 'injected' }), `injected ${key}`)
    }
    for (const value of [null, [], 42, 'settings']) await expectValidation(await f.save(session, value), `non-object body ${JSON.stringify(value)}`)
    expect(await f.snapshot()).toEqual(before)
  })

  it('refuses every mailbox selector on the sealed workspace without switching authority', async () => {
    const session = await f.open()
    const current = await f.view(session)
    const before = await f.snapshot()
    for (const query of [`mailbox=${encodeURIComponent(f.foreign.login)}`, `owner=${encodeURIComponent(f.sibling.login)}`, `id=${encodeURIComponent(f.foreign.id)}`, 'unexpected=1']) {
      const read = await expectValidation(await f.call(`${route}?${query}`, 'GET', undefined, session), `GET ${query}`)
      expect(read.details, `GET ${query}`).toMatchObject({ stateChanged: false })
      const write = await expectValidation(await f.call(`${route}?${query}`, 'PUT', { ...draft(), expectedRevision: current.revision }, session), `PUT ${query}`)
      expect(write.details, `PUT ${query}`).toMatchObject({ stateChanged: false })
    }
    expect(await f.snapshot()).toEqual(before)
    expect((await f.view(session)).revision).toBe(current.revision)
  })

  it('rejects a stale revision without overwriting the saved configuration', async () => {
    const session = await f.open()
    const absence = await f.view(session)
    const first = await f.saveValid(session)
    const second = await f.saveValid(session, { subject: 'Later saved subject' })
    const before = await f.snapshot()
    const stale = await f.save(session, { ...draft({ subject: 'Stale overwrite' }), expectedRevision: first.revision })
    const body = await refuse(stale, 409, 'CONFLICT', 'stale save')
    expect(body.details).toMatchObject({ stateChanged: false })
    expect(await f.snapshot()).toEqual(before)
    expect(await f.view(session)).toMatchObject({ vacation: { subject: 'Later saved subject' }, revision: second.revision })
    expect(absence.revision).not.toBe(second.revision)
  })

  it('creates from the known absence revision and treats that revision as stale after the first save', async () => {
    const session = await f.open()
    const absence = await f.view(session)
    expect(absence.vacation).toBeNull()
    const created = await f.saveValid(session)
    expect(created.vacation.mailbox).toBe(f.inbox.login)
    const before = await f.snapshot()
    await refuse(await f.save(session, { ...draft({ subject: 'Replayed absence' }), expectedRevision: absence.revision }), 409, 'CONFLICT', 'absent revision replay')
    expect(await f.snapshot()).toEqual(before)
    expect(await f.stored()).toEqual({ ...created.vacation, ownerAuthority: f.authorityFor(f.inbox) })
  })

  it('rejects malformed schedules, intervals, header controls, oversized messages and invalid enabled states', async () => {
    const session = await f.open()
    await f.saveValid(session)
    const current = (await f.view(session)).revision
    const before = await f.snapshot()
    const invalid: Array<[string, Record<string, unknown>]> = [
      ['fractional start', { startDate: '2026-12-24T00:00:00.123Z' }],
      ['fractional end', { endDate: '2026-12-24T13:04:00.999Z' }],
      ['noncanonical start', { startDate: '2026-12-24T00:00:00Z' }],
      ['date-only start', { startDate: '2026-12-24' }],
      ['offset bound', { startDate: '2026-12-24T00:00:00.000+00:00' }],
      ['equal bounds', { startDate: '2026-12-24T00:00:00.000Z', endDate: '2026-12-24T00:00:00.000Z' }],
      ['unsorted bounds', { startDate: '2026-12-25T00:00:00.000Z', endDate: '2026-12-24T00:00:00.000Z' }],
      ['object bound', { endDate: { instant: '2026-12-24T00:00:00.000Z' } }],
      ['interval zero', { replyIntervalHours: 0 }],
      ['interval negative', { replyIntervalHours: -1 }],
      ['interval too large', { replyIntervalHours: 8761 }],
      ['fractional interval', { replyIntervalHours: 1.5 }],
      ['string interval', { replyIntervalHours: '24' }],
      ['null interval', { replyIntervalHours: null }],
      ['subject header control', { subject: 'Away\r\nBcc: injected@example.test' }],
      ['subject nul', { subject: 'Away\u0000' }],
      ['subject next-line control', { subject: 'Away\u0085' }],
      ['subject separator', { subject: 'Away\u2028' }],
      ['subject too long', { subject: 'x'.repeat(257) }],
      ['body control', { body: 'Away\u0000' }],
      ['body next-line control', { body: 'Away\u000b' }],
      ['html body control', { htmlBody: 'Away\u001f' }],
      ['body over 64 KiB bytes', { body: '\u00e9'.repeat(32769) }],
      ['html body over 64 KiB bytes', { htmlBody: '\u00e9'.repeat(32769) }],
      ['enabled blank subject', { subject: '   ' }],
      ['enabled blank message', { subject: 'Away', body: '   ', htmlBody: '' }],
      ['enabled string boolean', { enabled: 'true' }],
      ['null body field', { body: null }],
    ]
    for (const [label, patch] of invalid) {
      await expectValidation(await f.save(session, { ...draft(patch), expectedRevision: current }), label)
      expect(await f.readBytes(f.inbox.login), label).toBe(before.contents.inbox)
    }
    expect(await f.snapshot()).toEqual(before)
  })

  it('permits a disabled empty configuration and an enabled HTML-only message', async () => {
    const session = await f.open()
    const disabled = await f.saveValid(session, { enabled: false, subject: '', body: '', htmlBody: '' })
    expect(disabled.vacation).toMatchObject({ enabled: false, subject: '', body: '', htmlBody: '', startDate: null, endDate: null, replyIntervalHours: 24 })
    expect(disabled.vacation.compiledSieve).toBe('# Vacation responder disabled\n')
    expect(await f.view(session)).toMatchObject({ vacation: disabled.vacation, revision: disabled.revision })
    const htmlOnly = await f.saveValid(session, { enabled: true, subject: 'Away', body: '', htmlBody: '<p>Back soon</p>' })
    expect(htmlOnly.vacation).toMatchObject({ enabled: true, subject: 'Away', body: '', htmlBody: '<p>Back soon</p>' })
    expect(htmlOnly.vacation.compiledSieve).toContain(' :mime ')
    expect(htmlOnly.vacation.compiledSieve).toContain(Buffer.from('<p>Back soon</p>').toString('base64'))
    const before = await f.snapshot()
    await expectValidation(await f.save(session, { ...draft({ subject: 'Away', body: '', htmlBody: '' }), expectedRevision: htmlOnly.revision }), 'enabled blank message')
    expect(await f.snapshot()).toEqual(before)
  })

  it('projects the stored record without stored metadata and keeps its current-value revision', async () => {
    const record = {
      mailbox: f.inbox.login, enabled: true, subject: 'Seeded', body: 'Seeded body', htmlBody: '',
      startDate: null, endDate: null, replyIntervalHours: 24, compiledSieve: 'require ["vacation"];\n', updatedAt: '2026-01-01T00:00:00.000Z',
      nativeApplied: true, password: 'PRIVATE_MARKER', internalMarker: 'INTERNAL_MARKER',
      // Bound to the current lifetime; unbound legacy rows are withheld (metadata-authority.test.ts).
      ownerAuthority: f.authorityFor(f.inbox),
    }
    await atomicWriteJson(f.filePath(f.inbox.login), record)
    const session = await f.open()
    const response = await f.call(route, 'GET', undefined, session)
    expect(response.status).toBe(200)
    const serialized = await response.text()
    expect(serialized).not.toMatch(/PRIVATE_MARKER|INTERNAL_MARKER/)
    const view = JSON.parse(serialized) as SealedView
    expect(view.vacation).toEqual({
      mailbox: f.inbox.login, enabled: true, subject: 'Seeded', body: 'Seeded body', htmlBody: '',
      startDate: null, endDate: null, replyIntervalHours: 24, compiledSieve: 'require ["vacation"];\n', updatedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(view.vacation).not.toHaveProperty('nativeApplied')
    expect(view.revision).toMatch(/^[0-9a-f]{64}$/)
    const saved = await f.save(session, { ...draft({ subject: 'Replaced' }), expectedRevision: view.revision })
    expect(saved.status).toBe(200)
    const replaced = (await f.stored())!
    expect(replaced).not.toHaveProperty('password')
    expect(Object.keys(replaced).sort()).toEqual(['body', 'compiledSieve', 'enabled', 'endDate', 'htmlBody', 'mailbox', 'ownerAuthority', 'replyIntervalHours', 'startDate', 'subject', 'updatedAt'])
    expect(replaced.compiledSieve).not.toBe(record.compiledSieve)
    expect(replaced.compiledSieve).toContain(':subject "Replaced"')
  })

  it('serializes a queued save behind the current writer lease', async () => {
    const session = await f.open()
    const current = await f.view(session)
    const lock = f.state.store.getWriterLock()
    const held = await lock.acquire()
    const acquire = lock.acquire.bind(lock)
    let queued!: () => void
    const reached = new Promise<void>(resolve => { queued = resolve })
    const spy = vi.spyOn(lock, 'acquire').mockImplementation((...args) => { queued(); return acquire(...args) })
    let settled = false
    let released = false
    const pending = f.save(session, { ...draft(), expectedRevision: current.revision })
    pending.then(() => { settled = true }, () => { settled = true })
    try {
      await Promise.race([reached, timeout(5000, 'vacation save did not reach the queued writer checkpoint')])
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(settled).toBe(false)
      await held.release(); released = true
      expect((await pending).status).toBe(200)
      expect(await f.stored()).toMatchObject({ mailbox: f.inbox.login, enabled: true, subject: 'Away from the office' })
    } finally {
      if (!released) await held.release()
      spy.mockRestore()
      await pending.catch(() => undefined)
    }
  })

  it('admits only one concurrent save for the same captured revision', async () => {
    const session = await f.open()
    const current = await f.view(session)
    const responses = await Promise.all([
      f.save(session, { ...draft({ subject: 'Concurrent A' }), expectedRevision: current.revision }),
      f.save(session, { ...draft({ subject: 'Concurrent B' }), expectedRevision: current.revision }),
    ])
    expect(responses.map(response => response.status).sort()).toEqual([200, 409])
    const winner = responses.find(response => response.status === 200)!
    const ack = await winner.json() as SealedAck
    expect(await f.stored()).toEqual({ ...ack.vacation, ownerAuthority: f.authorityFor(f.inbox) })
    expect((await f.view(session)).vacation).toEqual(ack.vacation)
    expect((await f.audits()).filter(entry => entry.outcome === 'ok')).toHaveLength(1)
  })

  it('rechecks the sealed session after queuing behind the writer lease', async () => {
    const session = await f.open()
    const current = await f.view(session)
    const lock = f.state.store.getWriterLock()
    const held = await lock.acquire()
    const acquire = lock.acquire.bind(lock)
    let queued!: () => void
    const reached = new Promise<void>(resolve => { queued = resolve })
    const spy = vi.spyOn(lock, 'acquire').mockImplementation((...args) => { queued(); return acquire(...args) })
    let released = false
    const pending = f.save(session, { ...draft({ subject: 'Denied queued save' }), expectedRevision: current.revision })
    try {
      await Promise.race([reached, timeout(5000, 'vacation save did not reach the queued writer checkpoint')])
      await f.database.db.query('DELETE FROM sessions WHERE id = $1', [session.sessionId])
      await held.release(); released = true
      const response = await pending
      expect(response.status).toBe(401)
      expect((await response.json() as Problem).code).toBe('UNAUTHENTICATED')
      expect(await f.readBytes(f.inbox.login)).toBeNull()
      expect(await f.audits()).toHaveLength(0)
    } finally {
      if (!released) await held.release()
      spy.mockRestore()
      await pending.catch(() => undefined)
    }
  })

  it('binds a second account sealed mailbox to its own record and refuses mailbox injection', async () => {
    const ownerSession = await f.open(f.inbox.login)
    const foreignSession = await f.open(f.foreign.login)
    const ownerAbsence = await f.view(ownerSession)
    const ownerSave = await f.save(ownerSession, { ...draft({ subject: 'Owner private subject' }), expectedRevision: ownerAbsence.revision })
    expect(ownerSave.status).toBe(200)
    const foreignAbsence = await f.view(foreignSession)
    expect(foreignAbsence).toMatchObject({ context: { mailbox: f.foreign.login }, vacation: null })
    expect(foreignAbsence.revision).toBe(ownerAbsence.revision)
    expect(await f.readBytes(f.foreign.login)).toBeNull()
    const foreignSave = await f.save(foreignSession, { ...draft({ subject: 'Foreign own subject' }), expectedRevision: foreignAbsence.revision })
    expect(foreignSave.status).toBe(200)
    const foreignAck = await foreignSave.json() as SealedAck
    expect(foreignAck.vacation.mailbox).toBe(f.foreign.login)
    expect(await f.stored(f.foreign.login)).toEqual({ ...foreignAck.vacation, ownerAuthority: f.authorityFor(f.foreign) })
    expect((await f.stored(f.inbox.login))!.subject).toBe('Owner private subject')
    const injected = await f.save(foreignSession, { ...draft(), mailbox: f.inbox.login, expectedRevision: (await f.view(foreignSession)).revision })
    await expectValidation(injected, 'foreign mailbox body injection')
    expect((await f.stored(f.inbox.login))!.subject).toBe('Owner private subject')
    expect((await f.stored(f.foreign.login))!.subject).toBe('Foreign own subject')
    expect((await f.audits()).map(entry => entry.target).sort()).toEqual([`vacation:${f.inbox.login}`, `vacation:${f.foreign.login}`].sort())
  })

  it('refuses a record stored under the wrong mailbox scope without switching authority', async () => {
    const record = {
      mailbox: f.inbox.login, enabled: true, subject: 'SCOPED_MARKER', body: 'Scoped body', htmlBody: '',
      startDate: null, endDate: null, replyIntervalHours: 24, compiledSieve: '# scoped\n', updatedAt: '2026-01-01T00:00:00.000Z',
    }
    await atomicWriteJson(f.filePath(f.sibling.login), record)
    const session = await f.open(f.sibling.login)
    const before = await f.snapshot()
    const readResponse = await f.call(route, 'GET', undefined, session)
    // A record bound to another mailbox is withheld like absence (no existence signal) and is never adopted or overwritten.
    expect(readResponse.status).toBe(200)
    const read = await readResponse.text()
    expect(read).not.toContain('SCOPED_MARKER')
    const withheld = JSON.parse(read) as SealedView
    expect(withheld).toMatchObject({ context: { mailbox: f.sibling.login }, vacation: null })
    for (const expectedRevision of [withheld.revision, 'a'.repeat(64)]) {
      const refused = await refuse(await f.save(session, { ...draft(), expectedRevision }), 404, 'NOT_FOUND', 'wrong-scope write')
      expect(refused.details).toMatchObject({ stateChanged: false })
    }
    expect(await f.snapshot()).toEqual(before)
    expect(JSON.parse(before.contents.sibling!)).toMatchObject({ mailbox: f.inbox.login, subject: 'SCOPED_MARKER' })
  })

  it('refuses unauthenticated, cross-origin and CSRF-less sealed writes without changing state', async () => {
    const session = await f.open()
    const current = await f.view(session)
    const body = { ...draft(), expectedRevision: current.revision }
    const before = await f.snapshot()
    await refuse(await f.call(route, 'GET'), 401, 'UNAUTHENTICATED', 'unauthenticated GET')
    await refuse(await f.call(route, 'PUT', body), 401, 'UNAUTHENTICATED', 'unauthenticated PUT')
    await refuse(await f.call(route, 'GET', undefined, { ...session, cookie: session.cookie + 'tampered' }), 401, 'UNAUTHENTICATED', 'tampered session cookie')
    await refuse(await f.call(route, 'PUT', body, session, { 'x-csrf-token': '' }), 403, 'FORBIDDEN', 'missing CSRF token')
    await refuse(await f.call(route, 'PUT', body, session, { origin: 'https://evil.example.test' }), 403, 'FORBIDDEN', 'foreign origin')
    await refuse(await f.call(route, 'PUT', body, session, { authorization: `Bearer ${f.credential}` }), 401, 'UNAUTHENTICATED', 'API token is not a sealed session')
    expect(await f.snapshot()).toEqual(before)
    expect(await f.readBytes(f.inbox.login)).toBeNull()
  })

  it('keeps the non-mailbox administrator path legacy-shaped and still validates its writes', async () => {
    const ownerSession = await f.open()
    const absentResponse = await f.legacyCall(`${route}?mailbox=${encodeURIComponent(f.inbox.login)}`)
    expect(absentResponse.status).toBe(200)
    const absent = await absentResponse.json() as { vacation: VacationRecord }
    expect(Object.keys(absent)).toEqual(['vacation', 'metadataReview'])
    expect(absent.vacation).toMatchObject({ mailbox: f.inbox.login, enabled: false, compiledSieve: '# Vacation responder disabled\n' })
    await expectValidation(await f.legacyCall(route), 'legacy request without a mailbox selector')
    const wroteResponse = await f.legacyCall(route, 'PUT', { mailbox: f.inbox.login, enabled: true, subject: 'Legacy admin save', body: 'Legacy body' })
    expect(wroteResponse.status).toBe(200)
    const wrote = await wroteResponse.json() as { vacation: VacationRecord }
    expect(Object.keys(wrote)).toEqual(['vacation', 'metadataReview'])
    expect(wrote).not.toHaveProperty('context')
    expect(wrote).not.toHaveProperty('application')
    expect(wrote).not.toHaveProperty('stateChanged')
    expect(wrote.vacation).toMatchObject({ mailbox: f.inbox.login, enabled: true, subject: 'Legacy admin save', body: 'Legacy body' })
    expect(wrote.vacation.compiledSieve).toContain('vacation :days 1 ')
    const readback = await f.legacyCall(`${route}?mailbox=${encodeURIComponent(f.inbox.login)}`)
    expect((await readback.json() as { vacation: VacationRecord }).vacation).toEqual(wrote.vacation)
    expect((await f.view(ownerSession)).vacation).toEqual(wrote.vacation)
    const legacyAudit = (await f.audits()).find(entry => entry.target === `vacation:${f.inbox.login}`)
    expect(legacyAudit).toMatchObject({ outcome: 'ok', detail: { enabled: true, nativeApplied: false } })
    expect(legacyAudit!.actor).toBe(f.owner.username)
    const savedBytes = await f.readBytes(f.inbox.login)
    await expectValidation(await f.legacyCall(route, 'PUT', { mailbox: f.inbox.login, enabled: true, subject: '   ', body: '' }), 'legacy blank enabled subject')
    await expectValidation(await f.legacyCall(route, 'PUT', { mailbox: f.inbox.login, enabled: true, subject: 'X', body: 'Y', replyIntervalHours: 1.5 }), 'legacy fractional interval')
    expect(await f.readBytes(f.inbox.login)).toBe(savedBytes)
    await refuse(await f.legacyCall(route, 'PUT', { mailbox: f.foreign.login, enabled: true, subject: 'Injected', body: 'Injected' }), 404, 'NOT_FOUND', 'legacy foreign mail target')
    expect(await f.readBytes(f.foreign.login)).toBeNull()
    expect((await f.legacyCall(`${route}?mailbox=${encodeURIComponent(f.inbox.login)}`, 'GET', undefined, f.readOnly)).status).toBe(200)
    await refuse(await f.legacyCall(route, 'PUT', { mailbox: f.inbox.login, enabled: false }, f.readOnly), 403, 'FORBIDDEN', 'legacy read-only write scope')
  })

  it('joins exactly one account-bound audit entry per successful save and none for refusals', async () => {
    const session = await f.open()
    expect(await f.audits()).toHaveLength(0)
    const current = await f.view(session)
    const response = await f.save(session, { ...draft({ enabled: true }), expectedRevision: current.revision })
    expect(response.status).toBe(200)
    const ack = await response.json() as SealedAck
    const entries = await f.audits()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ action: 'webmail.vacation.updated', target: `vacation:${f.inbox.login}`, outcome: 'ok', detail: { enabled: true, nativeApplied: false } })
    expect(entries[0]!.actor).toBe(f.inbox.login)
    expect(entries[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    const auditRows = await f.database.db.query<{ principal_id: string | null }>("SELECT principal_id FROM audit_log WHERE action = 'webmail.vacation.updated' ORDER BY id DESC LIMIT 1")
    expect(auditRows[0]?.principal_id).toBe(f.sealedPrincipal.id)
    const principalRows = await f.database.db.query<{ account_id: string | null }>('SELECT account_id FROM principals WHERE id = $1', [f.sealedPrincipal.id])
    expect(principalRows[0]?.account_id).toBe(f.owner.id)
    const before = await f.snapshot()
    await refuse(await f.save(session, { ...draft({ subject: 'Stale audit' }), expectedRevision: current.revision }), 409, 'CONFLICT', 'stale attempt has no success audit')
    await expectValidation(await f.save(session, { ...draft(), expectedRevision: 'a'.repeat(64), mailbox: f.foreign.login }), 'malformed attempt has no success audit')
    await refuse(await f.call(route, 'PUT', { ...draft(), expectedRevision: ack.revision }), 401, 'UNAUTHENTICATED', 'unauthenticated attempt has no success audit')
    expect(await f.snapshot()).toEqual(before)
    expect(await f.audits()).toHaveLength(1)
    expect(await f.saveValid(session)).toBeDefined()
    expect(await f.audits()).toHaveLength(2)
  })

  it('reports a configuration-only application without any host agent or executor effect', async () => {
    const session = await f.open()
    const before = await f.snapshot()
    expect(before.agentCalls).toBe(0)
    const ack = await f.saveValid(session)
    const after = await f.snapshot()
    expect(ack.application).toEqual(application)
    expect(after.agentCalls).toBe(0)
    expect(after.files).toBe(0)
    expect(after.actions).toBe(0)
    expect(after.tests).toBe(0)
    expect(after.commands).toBe(0)
    expect(after.contents.sibling).toBe(before.contents.sibling)
    expect(after.contents.foreign).toBe(before.contents.foreign)
    expect(after.audits).toBe(1)
    expect((await f.view(session)).application).toEqual(application)
    const saved = (await f.stored())!
    expect(saved).not.toHaveProperty('nativeApplied')
    expect(saved).not.toHaveProperty('application')
    expect(JSON.stringify(saved)).not.toMatch(/nativeApplied|sieveApplied|hostAgent/)
  })
})
