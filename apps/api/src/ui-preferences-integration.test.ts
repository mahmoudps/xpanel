import { randomUUID } from 'node:crypto'
import { cp } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createApiToken, createRootPrincipal, createSession, createTestDb, createUserPrincipal, saveMailboxSession, setTotpSecret,
} from '@xpanel/db'
import type { Db, PrincipalRecord, Row, TestDbHandle } from '@xpanel/db'
import { atomicWriteJson, createTestStateStore } from '@xpanel/state'
import type { TestStateStoreHandle } from '@xpanel/state'
import type { Account, ServiceUser } from '@xpanel/core'
import { deriveCsrfToken } from './auth.ts'
import { sessionCookieName, sessionTokenHash, type EntryPoint } from './entry-points.ts'
import { createApiApp } from './server.ts'
import { createDefaultWebRenderer } from './main.ts'
import { mailboxPrincipalUsername } from './mail/inbox.ts'
import { createTeamSession } from './team-store.ts'
import { readSavedTeam } from './acct-team-workspace.ts'
import type { TeamMember } from './acct-team-workspace.ts'
import type { UiPreferencesView } from './ui-preferences.ts'

// Capture the state handed to the presentation layer; keep the real registry and all request authorization.
vi.mock('../../web/src/index.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../web/src/index.ts')>()
  return { ...actual, serveWebUi: async (...args: Parameters<typeof actual.serveWebUi>) => {
    const [request, provider] = args
    return new Response(JSON.stringify(provider ? await provider(new URL(request.url), request) : {}), { headers: { 'content-type': 'application/json' } })
  } }
})

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const SECRET = 'ui-preference-integration-fixture-secret'
const ROUTE = '/api/auth/ui-preferences'
const MEMBERS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'] as const
const ORIGIN = { xpanel: 'https://panel.example.test:2083', xwhm: 'https://whm.example.test:2087', xmail: 'https://mail.example.test:2096' } as const
let database: TestDbHandle, baseline: TestStateStoreHandle, account: Account, mailbox: ServiceUser
let root: PrincipalRecord, owner: PrincipalRecord, mailboxPrincipal: PrincipalRecord

// Parent-first insertion order; deletion reverses this list. The principal rows
// retain their identity and are restored in place, preserving audit attribution.
const MUTABLE_TABLES = ['principals', 'team_credentials', 'sessions', 'mailbox_sessions', 'handoff_mailbox_sessions',
  'totp_enrollments', 'api_tokens', 'team_sessions', 'panel_handoffs', 'login_attempts', 'lockouts', 'login_failure_counters'] as const
interface TableSnapshot { name: string; columns: string[]; rows: Row[] }
let mutableSnapshot: TableSnapshot[]
let loginSequence: Row[]
let auditGuards: Row[]

beforeAll(async () => {
  database = await createTestDb()
  baseline = await createTestStateStore()
  root = await createRootPrincipal(database.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })
  await setTotpSecret(database.db, root.id, new Uint8Array(32))
  const feature = await baseline.store.createFeatureList({ name: 'Preference fixture', ownerId: null, disabled: [] })
  const plan = await baseline.store.createPlan({ name: 'Preference fixture', ownerId: null, featureListId: feature.id,
    resources: { diskMb: 1024, bandwidthMbMonth: 1024, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 1, aliasDomains: 1, subdomains: 1, mailboxes: 2, forwarders: 1, mailingLists: 1, ftpAccounts: 1, databases: 1, phpWorkers: 1 },
    dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await baseline.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  account = await baseline.store.createAccount({ username: 'alice', passwordHash: HASH, primaryDomain: 'alice.example.test', planId: plan.id, ownerId: null,
    contactEmail: 'alice@example.test', ipv4: '192.0.2.10', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 1, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  owner = await createUserPrincipal(database.db, { username: account.username, accountId: account.id, passwordHash: HASH })
  mailbox = await baseline.store.createServiceUser({ accountId: account.id, login: 'mail@alice.example.test', passwordHash: HASH,
    services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html' })
  mailboxPrincipal = await createUserPrincipal(database.db, { username: mailboxPrincipalUsername(mailbox.login), accountId: account.id, passwordHash: HASH })
  const now = new Date().toISOString()
  const members: TeamMember[] = MEMBERS.map((id, index) => ({ id, username: `member${index + 1}`, roles: ['web'], contactEmail: `member${index + 1}@example.test`, notes: '',
    expiresAt: null, expiryReason: null, status: 'active', suspendReason: null, createdAt: now, createdBy: account.username, updatedAt: now, updatedBy: account.username }))
  expect(readSavedTeam(members)).toEqual(members)
  await atomicWriteJson(join(baseline.rootDir, 'extended', 'accounts', 'team', account.id + '.json'), members)
  for (const memberId of MEMBERS) await database.db.query(
    'INSERT INTO team_credentials (member_id,account_id,password_hash,password_set_at,created_at,updated_at) VALUES ($1,$2,$3,$4,$4,$4)',
    [memberId, account.id, HASH, now])
  mutableSnapshot = await Promise.all(MUTABLE_TABLES.map(async name => ({ name,
    columns: (await database.db.query<{ name: string }>(`PRAGMA table_info("${name}")`)).map(column => column.name),
    rows: await database.db.query(`SELECT * FROM "${name}" ORDER BY rowid`),
  })))
  loginSequence = await database.db.query("SELECT name,seq FROM sqlite_sequence WHERE name='login_attempts'")
  auditGuards = await database.db.query("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='audit_log' ORDER BY name")
})
afterAll(async () => {
  try { await database?.close() }
  finally { await baseline?.close() }
})

/**
 * Prepare state and SQLite once, then reset the actual mutable authentication rows
 * in one transaction after every case. Audit history remains append-only; each
 * case captures its cursor and verifies that its old prefix stays unchanged.
 * Actual HTTP requests must run outside SQL transactions: request admission takes
 * the permanent state mutex before SQL, and recovery opens its own transaction.
 * Every case gets fresh state without the mutex, its sidecars or recovery intent.
 */
async function withFixture(run: (fixture: { db: Db; state: TestStateStoreHandle }) => Promise<void>): Promise<void> {
  const auditBefore = await database.db.query('SELECT * FROM audit_log ORDER BY id')
  const auditCursor = Number(auditBefore.at(-1)?.id ?? 0)
  const state = await createTestStateStore()
  try {
    const mutex = baseline.store.getWriterLock().mutexFilePath
    const lockDirectory = baseline.store.getWriterLock().lockDirPath
    await cp(baseline.rootDir, state.rootDir, { recursive: true, filter: source =>
      source !== mutex && !source.startsWith(mutex + '-')
      && source !== lockDirectory && !source.startsWith(lockDirectory + sep),
    })
    await run({ db: database.db, state })
  } finally {
    try {
      await database.db.transaction(async db => {
        const principals = mutableSnapshot[0]!
        expect(await db.query('SELECT id FROM principals ORDER BY id')).toEqual(principals.rows.map(row => ({ id: row.id })).sort((a, b) => String(a.id).localeCompare(String(b.id))))
        for (const table of [...mutableSnapshot.slice(1)].reverse()) await db.query(`DELETE FROM "${table.name}"`)
        for (const row of principals.rows) {
          const columns = principals.columns.filter(name => name !== 'id')
          const assignments = columns.map((name, index) => '"' + name.replaceAll('"', '""') + '"=$' + (index + 1)).join(',')
          await db.query(`UPDATE principals SET ${assignments} WHERE id=$${columns.length + 1}`, [...columns.map(name => row[name]), row.id])
        }
        for (const table of mutableSnapshot.slice(1)) {
          const columns = table.columns.map(name => '"' + name.replaceAll('"', '""') + '"').join(',')
          const placeholders = table.columns.map((_, index) => '$' + (index + 1)).join(',')
          for (const row of table.rows) await db.query(`INSERT INTO "${table.name}" (${columns}) VALUES (${placeholders})`, table.columns.map(name => row[name]))
        }
        await db.query("DELETE FROM sqlite_sequence WHERE name='login_attempts'")
        for (const row of loginSequence) await db.query('INSERT INTO sqlite_sequence(name,seq) VALUES ($1,$2)', [row.name, row.seq])
        for (const table of mutableSnapshot) expect(await db.query(`SELECT * FROM "${table.name}" ORDER BY rowid`), table.name).toEqual(table.rows)
        expect(await db.query('PRAGMA foreign_key_check')).toEqual([])
        expect(await db.query('SELECT * FROM audit_log WHERE id<=$1 ORDER BY id', [auditCursor])).toEqual(auditBefore)
        expect(await db.query("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='audit_log' ORDER BY name")).toEqual(auditGuards)
      })
    } finally { await state.close() }
  }
}

async function session(db: Db, principal: PrincipalRecord, surface?: EntryPoint, options: { mfaVerified?: boolean; mailbox?: ServiceUser; impersonated?: boolean } = {}) {
  const raw = `preference-${randomUUID()}`
  const saved = await createSession(db, { principalId: principal.id, tokenHash: sessionTokenHash(raw, surface), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    mfaVerified: options.mfaVerified ?? true, ...(options.impersonated ? { impersonator: { principalId: root.id, login: root.username } } : {}) })
  if (options.mailbox) await saveMailboxSession(db, { sessionId: saved.id, mailbox: options.mailbox.login, accountId: account.id,
    serviceUserId: options.mailbox.id, sealedPassword: new Uint8Array(32) })
  return { cookie: `${surface ? sessionCookieName(surface, true) : 'xpanel_session'}=${raw}`, csrf: deriveCsrfToken(raw, SECRET, surface), raw }
}

const app = (db: Db, state: TestStateStoreHandle, surface?: EntryPoint) => createApiApp({ db, store: state.store, serverSecret: SECRET, secureCookies: true,
  requireOriginHeader: true, ...(surface ? { entryPoint: surface, publicOrigin: ORIGIN[surface], allowedOrigins: [ORIGIN[surface]] } : {}) })
const request = (application: ReturnType<typeof app>, surface: EntryPoint, auth: { cookie: string; csrf: string } | null, options: {
  method?: string; body?: unknown; csrf?: string; origin?: string; path?: string; headers?: Record<string, string>
} = {}) => application.fetch(new Request(ORIGIN[surface] + (options.path ?? ROUTE), {
  method: options.method ?? 'GET', headers: { origin: options.origin ?? ORIGIN[surface], ...(auth ? { cookie: auth.cookie, 'x-csrf-token': options.csrf ?? auth.csrf } : {}),
    ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
  ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
}))
const read = async (application: ReturnType<typeof app>, surface: EntryPoint, auth: { cookie: string; csrf: string }): Promise<UiPreferencesView> => {
  const response = await request(application, surface, auth)
  expect(response.status).toBe(200)
  return await response.json() as UiPreferencesView
}
const save = (application: ReturnType<typeof app>, surface: EntryPoint, auth: { cookie: string; csrf: string }, view: UiPreferencesView) =>
  request(application, surface, auth, { method: 'PUT', body: { uiTheme: 'classic', expectedRevision: view.revision } })

describe('personal UI preference request integration', () => {
  it('uses only registered choices and the normal authenticated CSRF and Origin boundary', () => withFixture(async ({ db, state }) => {
    const application = app(db, state, 'xwhm'), auth = await session(db, root, 'xwhm')
    expect((await request(application, 'xwhm', null)).status).toBe(401)
    const view = await read(application, 'xwhm', auth)
    expect(view).toMatchObject({ state: 'default', uiTheme: 'classic', choices: ['classic'] })
    const body = { uiTheme: 'classic', expectedRevision: view.revision }
    expect((await request(application, 'xwhm', auth, { method: 'PUT', body, csrf: 'wrong' })).status).toBe(403)
    expect((await request(application, 'xwhm', auth, { method: 'PUT', body, origin: 'https://foreign.example.test' })).status).toBe(403)
    expect((await request(application, 'xwhm', auth, { method: 'PUT', body: { ...body, uiTheme: 'v2' } })).status).toBe(422)
    expect((await request(application, 'xwhm', auth, { path: ROUTE + '?surface=xpanel' })).status).toBe(422)
    expect((await save(application, 'xwhm', auth, view)).status).toBe(200)
    expect(await read(application, 'xwhm', auth)).toMatchObject({ state: 'saved', uiTheme: 'classic' })
  }))

  it('preserves optional MFA, forced-password and bearer restrictions', () => withFixture(async ({ db, state }) => {
    const application = app(db, state, 'xwhm'), pending = await session(db, root, 'xwhm', { mfaVerified: false })
    expect((await request(application, 'xwhm', pending)).status).toBe(403)
    const raw = `preference-api-${randomUUID()}`
    await createApiToken(db, { principalId: root.id, name: 'Preference fixture', tokenHash: sessionTokenHash(raw), scopes: ['*'], expiresAt: new Date(Date.now() + 60_000).toISOString() })
    // Interactive listeners reject bearer credentials before route authorization.
    expect((await request(application, 'xwhm', null, { headers: { authorization: `Bearer ${raw}` } })).status).toBe(401)
    // The legacy listener authenticates this token, but preferences still require a session.
    expect((await request(app(db, state), 'xwhm', null, { headers: { authorization: `Bearer ${raw}` } })).status).toBe(403)
    const auth = await session(db, root, 'xwhm')
    await db.query('UPDATE principals SET force_password_change=1 WHERE id=$1', [root.id])
    expect((await request(application, 'xwhm', auth)).status).toBe(403)
  }))

  it('keeps a member preference separate from its owner and other members', () => withFixture(async ({ db, state }) => {
    const application = app(db, state, 'xpanel'), ownerAuth = await session(db, owner, 'xpanel')
    const memberAuth = async (memberId: string, index: number) => {
      const raw = `preference-team-${index}-${randomUUID()}`, now = new Date()
      const saved = await createTeamSession(db, { memberId, accountId: account.id, ownerPrincipalId: owner.id, login: `member${index}@${account.primaryDomain}`,
        tokenHash: sessionTokenHash(raw, 'xpanel'), expectedPasswordHash: HASH, ip: null, userAgent: null, now, expiresAt: new Date(now.getTime() + 60_000) })
      expect(saved).not.toBeNull()
      return { cookie: `${sessionCookieName('xpanel', true)}=${raw}`, csrf: deriveCsrfToken(raw, SECRET, 'xpanel') }
    }
    const first = await memberAuth(MEMBERS[0], 1), second = await memberAuth(MEMBERS[1], 2)
    const view = await read(application, 'xpanel', first)
    expect((await save(application, 'xpanel', first, view)).status).toBe(200)
    expect(await read(application, 'xpanel', first)).toMatchObject({ state: 'saved' })
    expect(await read(application, 'xpanel', second)).toMatchObject({ state: 'default' })
    expect(await read(application, 'xpanel', ownerAuth)).toMatchObject({ state: 'default' })
    expect((await request(application, 'xpanel', first, { path: '/api/account/preferences' })).status).toBe(403)
    // Listener confinement rejects an unregistered suffix before session authorization.
    const unavailable = await request(application, 'xpanel', first, { path: '/api/auth/ui-preferences/other' })
    expect(unavailable.status).toBe(404)
    expect(await unavailable.json()).toMatchObject({ status: 404, code: 'NOT_FOUND', instance: '/api/auth/ui-preferences/other' })
    expect(await read(application, 'xpanel', first)).toMatchObject({ state: 'saved' })
    expect(await read(application, 'xpanel', second)).toMatchObject({ state: 'default' })
    expect(await read(application, 'xpanel', ownerAuth)).toMatchObject({ state: 'default' })
  }))

  it('binds mailbox preferences to the sealed service lifetime without opening its credential', () => withFixture(async ({ db, state }) => {
    const application = app(db, state, 'xmail'), auth = await session(db, mailboxPrincipal, 'xmail', { mailbox })
    const view = await read(application, 'xmail', auth)
    expect((await save(application, 'xmail', auth, view)).status).toBe(200)
    expect(await read(application, 'xmail', auth)).toMatchObject({ state: 'saved' })
    await state.store.deleteServiceUser(mailbox.id)
    const recreated = await state.store.createServiceUser({ accountId: account.id, login: mailbox.login, passwordHash: HASH,
      services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html' })
    expect((await request(application, 'xmail', auth)).status).toBe(403)
    const next = await session(db, mailboxPrincipal, 'xmail', { mailbox: recreated })
    expect(await read(application, 'xmail', next)).toMatchObject({ state: 'default' })
  }))

  it('uses current mailbox classification on the legacy listener and confines listener cookies', () => withFixture(async ({ db, state }) => {
    const legacy = app(db, state), auth = await session(db, mailboxPrincipal, undefined, { mailbox })
    expect((await read(legacy, 'xmail', auth)).state).toBe('default')
    const panel = app(db, state, 'xpanel'), mailAuth = await session(db, mailboxPrincipal, 'xmail', { mailbox })
    expect((await request(panel, 'xpanel', mailAuth)).status).toBe(401)
    const mail = app(db, state, 'xmail'), ownerAuth = await session(db, owner, 'xpanel')
    expect((await request(mail, 'xmail', ownerAuth)).status).toBe(401)
  }))

  it('permits handed-off reads while refusing permanent writes through normal request guards', () => withFixture(async ({ db, state }) => {
    const application = app(db, state, 'xpanel'), auth = await session(db, owner, 'xpanel', { impersonated: true })
    const view = await read(application, 'xpanel', auth)
    expect((await save(application, 'xpanel', auth, view)).status).toBe(403)
    expect(await read(application, 'xpanel', auth)).toMatchObject({ state: 'default' })
  }))
})

describe('personal UI preference document integration', () => {
  it('injects the saved choice through common rendering for preferences, security and status documents', () => withFixture(async ({ db, state }) => {
    const application = app(db, state, 'xwhm'), auth = await session(db, root, 'xwhm')
    expect((await save(application, 'xwhm', auth, await read(application, 'xwhm', auth))).status).toBe(200)
    const render = await createDefaultWebRenderer({ db, store: state.store, serverSecret: SECRET, entryPoint: 'xwhm', publicOrigin: ORIGIN.xwhm })
    for (const path of ['/whm/preferences', '/whm/security/sign-in', '/does-not-exist', '/whm/preferences?uiTheme=v2']) {
      const response = await render(new Request(ORIGIN.xwhm + path, { headers: { cookie: auth.cookie } }))
      const state = await response.json() as { uiTheme?: string; surface?: string }
      expect(state.uiTheme, path).toBe('classic')
      expect(state.surface, path).toBe('xwhm')
    }
    const login = await render(new Request(ORIGIN.xwhm + '/login?uiTheme=v2'))
    expect(await login.json()).not.toHaveProperty('uiTheme')
  }))

  it('does not load an owner preference into a member document or accept query theme authority', () => withFixture(async ({ db, state }) => {
    const application = app(db, state, 'xpanel'), auth = await session(db, owner, 'xpanel')
    expect((await save(application, 'xpanel', auth, await read(application, 'xpanel', auth))).status).toBe(200)
    const raw = `preference-html-team-${randomUUID()}`, now = new Date()
    await createTeamSession(db, { memberId: MEMBERS[0], accountId: account.id, ownerPrincipalId: owner.id, login: `member1@${account.primaryDomain}`,
      tokenHash: sessionTokenHash(raw, 'xpanel'), expectedPasswordHash: HASH, ip: null, userAgent: null, now, expiresAt: new Date(now.getTime() + 60_000) })
    const render = await createDefaultWebRenderer({ db, store: state.store, serverSecret: SECRET, entryPoint: 'xpanel', publicOrigin: ORIGIN.xpanel })
    const response = await render(new Request(ORIGIN.xpanel + '/does-not-exist?uiTheme=v2', { headers: { cookie: `${sessionCookieName('xpanel', true)}=${raw}` } }))
    expect(await response.json()).not.toHaveProperty('uiTheme')
    const anonymous = await render(new Request(ORIGIN.xpanel + '/home?uiTheme=v2'))
    expect(anonymous.status).toBe(303)
  }))
})
