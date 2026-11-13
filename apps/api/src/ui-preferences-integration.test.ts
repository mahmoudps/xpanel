import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createApiToken, createRootPrincipal, createResellerPrincipal, createSession, createTestDb, createUserPrincipal, saveMailboxSession, setTotpSecret,
} from '@xpanel/db'
import type { Db, PrincipalRecord, Row, TestDbHandle } from '@xpanel/db'
import { atomicWriteJson, createStateStore } from '@xpanel/state'
import type { TestStateStoreHandle } from '@xpanel/state'
import { captureMfaRuntimePolicy, type Account, type Reseller, type ServiceUser } from '@xpanel/core'
import { deriveCsrfToken } from './auth.ts'
import { sessionCookieName, sessionTokenHash, type EntryPoint } from './entry-points.ts'
import { createApiApp } from './server.ts'
import { createDefaultWebRenderer } from './main.ts'
import { mailboxPrincipalUsername } from './mail/inbox.ts'
import { createTeamSession } from './team-store.ts'
import { readSavedTeam } from './acct-team-workspace.ts'
import type { TeamMember } from './acct-team-workspace.ts'
import type { UiPreferencesView } from './ui-preferences.ts'
import * as uiPreferenceReads from './ui-preferences.ts'
import * as mailDocuments from './mail/document.ts'
import { parseMarkup } from '../../web/src/themes/markup.ts'
import { serveWebUi } from '../../web/src/index.ts'
import { roleLabel } from '../../web/src/chrome.ts'
import { registeredThemeDocuments } from '../../web/src/themes/contract.ts'
import { canonicalNavigationRoute, registeredDocumentAliases } from '@xpanel/catalog'
import { CROSS_ORIGIN_FORM_CSP, DOCUMENT_CSP } from '../../web/src/content-security-policy.ts'
import { cspMarkupIssues } from '../../web/src/csp.test-helper.ts'

// produced is the provider state exactly as its JSON response would carry it.
interface DocumentObservation { uiTheme: string | undefined; nativeFacts: boolean; qualified: boolean; factorKnown: boolean; produced: any }
const documentFlow = vi.hoisted(() => {
  const observations: DocumentObservation[] = []
  return { real: false, observations }
})
// Capture the state handed to the presentation layer; keep the real registry and all request authorization.
vi.mock('../../web/src/index.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../web/src/index.ts')>()
  return { ...actual, serveWebUi: async (...args: Parameters<typeof actual.serveWebUi>) => {
    const [request, provider] = args
    if (documentFlow.real) return actual.serveWebUi(request, provider ? async (url: URL, req: Request) => {
      const state = await provider(url, req)
      const { catalog: rawCatalog, ...restState } = state
      const cloned = JSON.parse(JSON.stringify(restState))
      if (rawCatalog !== undefined) {
        cloned.catalog = Array.isArray(rawCatalog)
          ? rawCatalog.map(tool => ({ id: tool.id, status: tool.status, delivery: { status: tool.delivery.status } }))
          : JSON.parse(JSON.stringify(rawCatalog))
      }
      documentFlow.observations.push({ uiTheme: state.uiTheme, nativeFacts: state.panel !== undefined || state.whm !== undefined || state.mail !== undefined,
        qualified: state.catalog?.some(tool => tool.status === 'verified' && tool.delivery.status === 'verified') ?? false, factorKnown: typeof state.security?.totpEnabled === 'boolean',
        produced: cloned })
      return state
    } : undefined)
    return new Response(JSON.stringify(provider ? await provider(new URL(request.url), request) : {}), { headers: { 'content-type': 'application/json' } })
  } }
})

// Every owner document read takes a real writer lease with fsynced lock files. These cases test
// authorization and rendering, not durability, so their state lives in RAM where the host has it.
const STATE_PARENT = existsSync('/dev/shm') ? '/dev/shm' : tmpdir()
async function createTestStateStore(): Promise<TestStateStoreHandle> {
  const rootDir = await mkdtemp(join(STATE_PARENT, 'xpanel-state-'))
  return { store: createStateStore(rootDir), rootDir, close: () => rm(rootDir, { recursive: true, force: true }) }
}

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const SECRET = 'ui-preference-integration-fixture-secret'
const ROUTE = '/api/auth/ui-preferences'
const MEMBERS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'] as const
const ORIGIN = { xpanel: 'https://panel.example.test:2083', xwhm: 'https://whm.example.test:2087', xmail: 'https://mail.example.test:2096' } as const
let database: TestDbHandle, baseline: TestStateStoreHandle, account: Account, mailbox: ServiceUser
let root: PrincipalRecord, owner: PrincipalRecord, mailboxPrincipal: PrincipalRecord
let realmReseller: Reseller, realmResellerPrincipal: PrincipalRecord

// Parent-first insertion order; deletion reverses this list. The principal rows
// retain their identity and are restored in place, preserving audit attribution.
const MUTABLE_TABLES = ['principals', 'team_credentials', 'sessions', 'mailbox_sessions', 'handoff_mailbox_sessions',
  'totp_enrollments', 'api_tokens', 'team_sessions', 'panel_handoffs', 'login_attempts', 'lockouts', 'login_failure_counters'] as const
interface TableSnapshot { name: string; columns: string[]; rows: Row[] }
let mutableSnapshot: TableSnapshot[]
let loginSequence: Row[]
let auditGuards: Row[]
let auditRowExpr = ''
interface CachedStateFile { relPath: string; bytes: Buffer }
let baselineFiles: CachedStateFile[] = []
let baselineRelDirs: string[] = []
async function snapshotStateFiles(rootDir: string, mutexFilePath: string, lockDirPath: string): Promise<CachedStateFile[]> {
  const files: CachedStateFile[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (full === mutexFilePath || full.startsWith(mutexFilePath + '-') || full === lockDirPath || full.startsWith(lockDirPath + sep)) continue
      if (entry.isDirectory()) await walk(full)
      else files.push({ relPath: relative(rootDir, full), bytes: await readFile(full) })
    }
  }
  await walk(rootDir)
  return files
}
async function restoreStateFiles(rootDir: string): Promise<void> {
  for (const relDir of baselineRelDirs) await mkdir(join(rootDir, relDir), { recursive: true, mode: 0o750 })
  await Promise.all(baselineFiles.map(file => writeFile(join(rootDir, file.relPath), file.bytes, { mode: 0o640 })))
}

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
  realmReseller = await baseline.store.createReseller({ username: 'realmreader', passwordHash: HASH, acl: ['list-accounts', 'manage-feature-lists'],
    maxAccounts: 4, totalDiskMb: 8000, totalBandwidthMb: 20000, oversell: { disk: false, bandwidth: false }, nameservers: ['ns1.example.test'], delegatedIps: [] })
  realmResellerPrincipal = await createResellerPrincipal(database.db, { id: realmReseller.id, username: realmReseller.username, passwordHash: HASH, forcePasswordChange: false })
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
  const auditCols = (await database.db.query<{ name: string }>('PRAGMA table_info("audit_log")')).map(column => column.name)
  auditRowExpr = auditCols.map(name => 'quote("' + name.replaceAll('"', '""') + '")').join("||','||")
  const lock = baseline.store.getWriterLock()
  baselineFiles = await snapshotStateFiles(baseline.rootDir, lock.mutexFilePath, lock.lockDirPath)
  baselineRelDirs = [...new Set(baselineFiles.map(file => dirname(file.relPath)).filter(dir => dir !== '.'))]
})
afterAll(async () => {
  try { await database?.close() }
  finally { await baseline?.close() }
})

/**
 * Prepare state and SQLite once, then reset the actual mutable authentication rows
 * in one transaction when a fixture closes. Audit history remains append-only; each
 * fixture captures its cursor and verifies that its old prefix stays unchanged.
 * Actual HTTP requests must run outside SQL transactions: request admission takes
 * the permanent state mutex before SQL, and recovery opens its own transaction.
 * Every fixture gets fresh state without the mutex, its sidecars or recovery intent.
 */
interface Fixture { db: Db; state: TestStateStoreHandle; close: () => Promise<void> }
async function openFixture(): Promise<Fixture> {
  const [auditBefore] = await database.db.query<{ max_id: number; dump: string }>(`SELECT coalesce(max(id),0) AS max_id, coalesce(group_concat(r, char(10)), '') AS dump FROM (SELECT id, ${auditRowExpr} AS r FROM audit_log ORDER BY id)`)
  const auditCursor = Number(auditBefore?.max_id ?? 0)
  const auditPrefixDump = auditBefore?.dump ?? ''
  const state = await createTestStateStore()
  const close = async () => {
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
        const [auditAfter] = await db.query<{ dump: string }>(`SELECT coalesce(group_concat(r, char(10)), '') AS dump FROM (SELECT ${auditRowExpr} AS r FROM audit_log WHERE id<=$1 ORDER BY id)`, [auditCursor])
        expect(auditAfter?.dump ?? '').toBe(auditPrefixDump)
        expect(await db.query("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='audit_log' ORDER BY name")).toEqual(auditGuards)
      })
    } finally { await state.close() }
  }
  try {
    await restoreStateFiles(state.rootDir)
  } catch (error) { await close(); throw error }
  return { db: database.db, state, close }
}
async function withFixture(run: (fixture: { db: Db; state: TestStateStoreHandle }) => Promise<void>): Promise<void> {
  const fixture = await openFixture()
  try { await run(fixture) } finally { await fixture.close() }
}

async function session(db: Db, principal: PrincipalRecord, surface?: EntryPoint, options: { mfaVerified?: boolean; mailbox?: ServiceUser; impersonated?: boolean } = {}) {
  const raw = `preference-${randomUUID()}`
  const saved = await createSession(db, { principalId: principal.id, tokenHash: sessionTokenHash(raw, surface), expiresAt: new Date(Date.now() + 600_000).toISOString(),
    mfaVerified: options.mfaVerified ?? true, ...(options.impersonated ? { impersonator: { principalId: root.id, login: root.username } } : {}) })
  if (options.mailbox) await saveMailboxSession(db, { sessionId: saved.id, mailbox: options.mailbox.login, accountId: account.id,
    serviceUserId: options.mailbox.id, sealedPassword: new Uint8Array(32) })
  return { cookie: `${surface ? sessionCookieName(surface, true) : 'xpanel_session'}=${raw}`, csrf: deriveCsrfToken(raw, SECRET, surface), raw }
}

const app = (db: Db, state: TestStateStoreHandle, surface?: EntryPoint, options: Pick<Parameters<typeof createApiApp>[0], 'mfaRuntimePolicy' | 'webRenderer'> = {}) => createApiApp({ db, store: state.store, serverSecret: SECRET, secureCookies: true, ...options,
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

const checkedSameOriginHrefs = new Map<string, boolean>()
function leakedAccountHrefs(nodes: ReturnType<typeof parseMarkup>, surface: EntryPoint): string[] {
  const baseOrigin = ORIGIN[surface]
  const leaked: string[] = []
  for (let i = 0; i < nodes.length; i++) {
    const anchor = nodes[i]!
    if (anchor.namespace !== 'html' || anchor.template >= 0 || anchor.tag !== 'a' || !anchor.attrs.has('href')) continue
    const value = anchor.attrs.get('href')
    if (value === undefined) throw new Error('missing normal document link')
    const key = surface + '\0' + value
    let hasAccountId = checkedSameOriginHrefs.get(key)
    if (hasAccountId === undefined) {
      const href = new URL(value, baseOrigin)
      hasAccountId = href.origin === baseOrigin && href.searchParams.has('accountId')
      checkedSameOriginHrefs.set(key, hasAccountId)
    }
    if (hasAccountId) leaked.push(value)
  }
  return leaked
}

// The database web-client pages post their sign-on ticket to the client's own origin; no other document posts away.
const CROSS_ORIGIN_FORM_ROUTES = new Set(['/databases/phpmyadmin', '/databases/phppgadmin', '/whm/databases/phpmyadmin'])
/** Every rendered document carries the strict policy, and its own markup runs under it: no inline script or handler. */
function expectDocumentPolicy(response: Response, body: string, route: string, parsedNodes?: ReturnType<typeof parseMarkup>): ReturnType<typeof parseMarkup> {
  const nodes = parsedNodes ?? parseMarkup(body)
  expect(response.headers.get('content-security-policy')).toBe(CROSS_ORIGIN_FORM_ROUTES.has(route) ? CROSS_ORIGIN_FORM_CSP : DOCUMENT_CSP)
  expect(response.headers.get('referrer-policy')).toBe('same-origin')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(cspMarkupIssues(body, nodes)).toEqual([])
  return nodes
}

/** One fixture, renderer, session and normally saved theme shared by a route matrix; afterAll closes it. */
interface DocumentGroup extends Fixture { application: ReturnType<typeof app>; auth: Awaited<ReturnType<typeof session>> }
async function openDocumentGroup(surface: EntryPoint, actor: PrincipalRecord, uiTheme: 'classic' | 'v2', options: Parameters<typeof session>[3] = {}): Promise<DocumentGroup> {
  const fixture = await openFixture()
  try {
    const renderer = await createDefaultWebRenderer({ db: fixture.db, store: fixture.state.store, serverSecret: SECRET, entryPoint: surface, publicOrigin: ORIGIN[surface] })
    const application = app(fixture.db, fixture.state, surface, { webRenderer: renderer })
    const auth = await session(fixture.db, actor, surface, options)
    const preference = await read(application, surface, auth)
    expect((await request(application, surface, auth, { method: 'PUT', body: { uiTheme, expectedRevision: preference.revision } })).status).toBe(200)
    expect(await read(application, surface, auth)).toMatchObject({ state: 'saved', uiTheme })
    return { ...fixture, application, auth }
  } catch (error) { await fixture.close(); throw error }
}
/** One real document request: the observed producer state and the HTML rendered from it. */
async function renderDocument(application: ReturnType<typeof app>, surface: EntryPoint, auth: { cookie: string; csrf: string }, path: string) {
  expect(documentFlow.real).toBe(false)
  documentFlow.observations.length = 0
  documentFlow.real = true
  try {
    const response = await request(application, surface, auth, { path })
    return { response, body: await response.text(), observations: [...documentFlow.observations] }
  } finally { documentFlow.real = false; documentFlow.observations.length = 0 }
}

describe('personal UI preference request integration', () => {
  it('uses only registered choices and the normal authenticated CSRF and Origin boundary', () => withFixture(async ({ db, state }) => {
    const application = app(db, state, 'xwhm'), auth = await session(db, root, 'xwhm')
    expect((await request(application, 'xwhm', null)).status).toBe(401)
    const view = await read(application, 'xwhm', auth)
    expect(view).toMatchObject({ state: 'default', uiTheme: 'v2', choices: ['classic', 'v2'] })
    expect(view.choices).not.toContain('unregistered-test-theme')
    const body = { uiTheme: 'classic', expectedRevision: view.revision }
    expect((await request(application, 'xwhm', auth, { method: 'PUT', body, csrf: 'wrong' })).status).toBe(403)
    expect((await request(application, 'xwhm', auth, { method: 'PUT', body, origin: 'https://foreign.example.test' })).status).toBe(403)
    expect((await request(application, 'xwhm', auth, { method: 'PUT', body: { ...body, uiTheme: 'unregistered-test-theme' } })).status).toBe(422)
    expect((await request(application, 'xwhm', auth, { path: ROUTE + '?surface=xpanel' })).status).toBe(422)
    expect((await save(application, 'xwhm', auth, view)).status).toBe(200)
    const classic = await read(application, 'xwhm', auth)
    expect(classic).toMatchObject({ state: 'saved', uiTheme: 'classic' })
    expect((await request(application, 'xwhm', auth, { method: 'PUT', body: { uiTheme: 'v2', expectedRevision: classic.revision } })).status).toBe(200)
    expect(await read(application, 'xwhm', auth)).toMatchObject({ state: 'saved', uiTheme: 'v2', choices: ['classic', 'v2'] })
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
  it.each(['classic', 'v2'] as const)('injects the saved %s choice through common rendering for preferences, security and status documents', uiTheme => withFixture(async ({ db, state }) => {
    const application = app(db, state, 'xwhm'), auth = await session(db, root, 'xwhm')
    const current = await read(application, 'xwhm', auth)
    expect((await request(application, 'xwhm', auth, { method: 'PUT', body: { uiTheme, expectedRevision: current.revision } })).status).toBe(200)
    const render = await createDefaultWebRenderer({ db, store: state.store, serverSecret: SECRET, entryPoint: 'xwhm', publicOrigin: ORIGIN.xwhm })
    for (const path of ['/whm/preferences', '/whm/security/sign-in', '/does-not-exist', `/whm/preferences?uiTheme=${uiTheme === 'classic' ? 'v2' : 'classic'}`]) {
      const response = await render(new Request(ORIGIN.xwhm + path, { headers: { cookie: auth.cookie } }))
      const state = await response.json() as { uiTheme?: string; surface?: string }
      expect(state.uiTheme, path).toBe(uiTheme)
      expect(state.surface, path).toBe('xwhm')
    }
    const login = await render(new Request(ORIGIN.xwhm + '/login?uiTheme=v2'))
    expect(await login.json()).not.toHaveProperty('uiTheme')
  }))

  it('does not load an owner preference into a member document or accept query theme authority', () => withFixture(async ({ db, state }) => {
    const application = app(db, state, 'xpanel'), auth = await session(db, owner, 'xpanel')
    const ownerView = await read(application, 'xpanel', auth)
    expect((await request(application, 'xpanel', auth, { method: 'PUT', body: { uiTheme: 'v2', expectedRevision: ownerView.revision } })).status).toBe(200)
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

describe('normal saved V2 factor-only documents', () => {
  const factorRoutes = { xpanel: '/security/account', xwhm: '/whm/security/sign-in', xmail: '/mail/settings/security' } as const
  for (const surface of ['xpanel', 'xwhm', 'xmail'] as const) it.each(['en', 'ar'] as const)(
    'saves V2 normally then renders the unqualified ' + surface + ' security document in %s',
    { tags: ['feature'] },
    locale => withFixture(async ({ db, state }) => {
      const previousEnvironment = process.env.NODE_ENV
      let policy: ReturnType<typeof captureMfaRuntimePolicy>
      try {
        process.env.NODE_ENV = 'development'
        policy = captureMfaRuntimePolicy()
      } finally {
        if (previousEnvironment === undefined) delete process.env.NODE_ENV
        else process.env.NODE_ENV = previousEnvironment
      }
      const renderer = await createDefaultWebRenderer({ db, store: state.store, serverSecret: SECRET, entryPoint: surface, publicOrigin: ORIGIN[surface], mfaRuntimePolicy: policy })
      const application = app(db, state, surface, { mfaRuntimePolicy: policy, webRenderer: renderer })
      const actor = surface === 'xwhm' ? root : surface === 'xmail' ? mailboxPrincipal : owner
      const auth = await session(db, actor, surface, surface === 'xmail' ? { mailbox } : {})
      const current = await read(application, surface, auth)
      expect((await request(application, surface, auth, { method: 'PUT', body: { uiTheme: 'v2', expectedRevision: current.revision } })).status).toBe(200)
      expect(await read(application, surface, auth)).toMatchObject({ state: 'saved', uiTheme: 'v2' })
      documentFlow.observations.length = 0
      documentFlow.real = true
      try {
        const response = await request(application, surface, auth, { path: factorRoutes[surface] + '?lang=' + locale })
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toContain('text/html')
        const nodes = parseMarkup(await response.text())
        const html = nodes.find(node => node.template < 0 && node.tag === 'html')
        expect(html?.attrs.get('data-ui-theme')).toBe('v2')
        expect(html?.attrs.get('lang')).toBe(locale)
        expect(html?.attrs.get('dir')).toBe(locale === 'ar' ? 'rtl' : 'ltr')
        const cards = nodes.filter(node => node.template < 0 && node.attrs.get('data-account-security') === 'two-factor')
        expect(cards).toHaveLength(1)
        expect(cards[0]?.attrs.get('data-auth-state')).toBe('development-disabled')
        expect(nodes.some(node => node.template < 0 && (node.attrs.has('data-auth-setup-form') || node.attrs.has('data-auth-enroll-form')))).toBe(false)
        expect(documentFlow.observations).toHaveLength(1)
        // Stored realm identity props are distinct from native qualification.
        expect(documentFlow.observations[0]).toMatchObject({ uiTheme: 'v2', nativeFacts: true, qualified: false, factorKnown: true })
      } finally {
        documentFlow.real = false
        documentFlow.observations.length = 0
      }
    }),
  )
})


describe('normal saved V2 owner session identity without selected context', () => {
  const cases = (['en', 'ar'] as const).flatMap(locale =>
    (['/panel', '/home'] as const).map(path => ({ locale, path })))

  it.each(cases)('keeps the authenticated role on $path in $locale without injecting accountId', { tags: ['feature'] }, ({ locale, path }) => withFixture(async ({ db, state }) => {
    const renderer = await createDefaultWebRenderer({ db, store: state.store, serverSecret: SECRET, entryPoint: 'xpanel', publicOrigin: ORIGIN.xpanel })
    const application = app(db, state, 'xpanel', { webRenderer: renderer })
    // An unenrolled owner uses the ordinary optional-MFA policy; no verified MFA bit is supplied.
    const auth = await session(db, owner, 'xpanel', { mfaVerified: false })
    const current = await read(application, 'xpanel', auth)
    expect((await request(application, 'xpanel', auth, { method: 'PUT', body: { uiTheme: 'v2', expectedRevision: current.revision } })).status).toBe(200)
    expect(await read(application, 'xpanel', auth)).toMatchObject({ state: 'saved', uiTheme: 'v2' })
    const documentPath = path + '?lang=' + locale

    // Existing observation mode exposes the actual API producer; it never replaces its state.
    expect(documentFlow.real).toBe(false)
    const producedResponse = await request(application, 'xpanel', auth, { path: documentPath })
    expect(producedResponse.status).toBe(200)
    const produced = await producedResponse.json()
    expect(produced).not.toHaveProperty('accountId')
    expect(produced).toMatchObject({
      surface: 'xpanel', uiTheme: 'v2',
      visibility: { principal: { kind: 'user', id: owner.id, username: owner.username, accountId: account.id } },
      panel: { account: { id: account.id, username: owner.username, status: 'active' } },
    })

    documentFlow.observations.length = 0
    documentFlow.real = true
    try {
      const response = await request(application, 'xpanel', auth, { path: documentPath })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/html')
      const nodes = parseMarkup(await response.text())
      const html = nodes.find(node => node.namespace === 'html' && node.template < 0 && node.tag === 'html')
      expect(html?.attrs.get('data-ui-theme')).toBe('v2')
      expect(html?.attrs.get('lang')).toBe(locale)
      expect(html?.attrs.get('dir')).toBe(locale === 'ar' ? 'rtl' : 'ltr')
      const menus = nodes.flatMap((node, index) => node.namespace === 'html' && node.template < 0 && node.tag === 'details' && node.attrs.has('data-user-menu') ? [index] : [])
      expect(menus).toHaveLength(1)
      const menu = menus[0]
      if (menu === undefined) throw new Error('missing authenticated owner menu')
      const insideMenu = (index: number): boolean => {
        for (let parent = nodes[index]?.parent ?? -1; parent >= 0; parent = nodes[parent]?.parent ?? -1) if (parent === menu) return true
        return false
      }
      const summaries = nodes.filter(node => node.namespace === 'html' && node.template < 0 && node.tag === 'summary' && node.parent === menu)
      expect(summaries).toHaveLength(1)
      expect(summaries[0]?.attrs.get('aria-label')).toContain(owner.username)
      expect(summaries[0]?.attrs.get('aria-label')).toContain(roleLabel('user', locale))
      const links = nodes.filter((node, index) => node.namespace === 'html' && node.template < 0 && node.tag === 'a' && node.attrs.has('data-security-link') && insideMenu(index))
      expect(links).toHaveLength(1)
      const href = links[0]?.attrs.get('href')
      if (href === undefined) throw new Error('missing authenticated owner security link')
      expect(href.startsWith('/') && !href.startsWith('//')).toBe(true)
      const security = new URL(href, ORIGIN.xpanel)
      expect(security.origin).toBe(ORIGIN.xpanel)
      expect(security.pathname).toBe('/security/account')
      expect(security.hash).toBe('')
      expect([...security.searchParams.keys()].sort()).toEqual(['density', 'lang', 'theme'])
      expect(security.searchParams.getAll('lang')).toEqual([locale])
      expect(security.searchParams.getAll('accountId')).toEqual([])
      expect(security.href).not.toContain(account.id)
      expect(documentFlow.observations).toHaveLength(1)
      expect(documentFlow.observations[0]).toMatchObject({ uiTheme: 'v2', qualified: false, factorKnown: true })
    } finally {
      documentFlow.real = false
      documentFlow.observations.length = 0
    }
  }))
})


describe('normal authenticated Security personal-authority producer', () => {
  it.each(['en', 'ar'] as const)('projects only self-auth flags from the real unenrolled owner in %s', { tags: ['feature'] }, locale => withFixture(async ({ db, state }) => {
    const renderer = await createDefaultWebRenderer({ db, store: state.store, serverSecret: SECRET, entryPoint: 'xpanel', publicOrigin: ORIGIN.xpanel })
    const application = app(db, state, 'xpanel', { webRenderer: renderer })
    const auth = await session(db, owner, 'xpanel', { mfaVerified: false })
    const current = await read(application, 'xpanel', auth)
    expect((await request(application, 'xpanel', auth, { method: 'PUT', body: { uiTheme: 'v2', expectedRevision: current.revision } })).status).toBe(200)
    expect(documentFlow.real).toBe(false)
    const response = await request(application, 'xpanel', auth, { path: '/security/account?lang=' + locale })
    expect(response.status).toBe(200)
    const produced = await response.json()
    expect(produced).not.toHaveProperty('accountId')
    expect(produced).toMatchObject({ panel: { account: { id: account.id, status: 'active' }, plan: { id: account.planId } } })
    expect(produced.panel).not.toHaveProperty('usage')
    expect(produced).toMatchObject({ surface: 'xpanel', uiTheme: 'v2',
      visibility: { principal: { kind: 'user', id: owner.id, username: owner.username, accountId: account.id } },
      security: { totpEnabled: false, authPersonal: {
        schemaVersion: 1, provenance: 'interactive-owner', surface: 'xpanel', route: '/security/account',
        principalId: owner.id, accountId: account.id, username: owner.username, state: 'ready',
        canChangePassword: true, canReadSessions: true, canRevokeSessions: true, canReadApiTokens: true, canManageApiTokens: true,
      } },
    })
    expect(produced.catalog.every((tool: { status: string; delivery: { status: string } }) => tool.status !== 'verified' && tool.delivery.status !== 'verified')).toBe(true)
    expect(Object.keys(produced.security.authPersonal).sort()).toEqual(['accountId', 'canChangePassword', 'canManageApiTokens', 'canReadApiTokens', 'canReadSessions', 'canRevokeSessions', 'principalId', 'provenance', 'route', 'schemaVersion', 'state', 'surface', 'username'].sort())

    documentFlow.observations.length = 0
    documentFlow.real = true
    try {
      const htmlResponse = await request(application, 'xpanel', auth, { path: '/security/account?lang=' + locale })
      expect(htmlResponse.status).toBe(200)
      const body = await htmlResponse.text(), nodes = parseMarkup(body)
      const scripts = nodes.filter(node => node.namespace === 'html' && node.template < 0 && node.tag === 'script')
      const asset = scripts.filter(node => node.attrs.get('id') === 'xpanel-realtime-client')
      expect(asset).toHaveLength(1)
      const src = asset[0]?.attrs.get('src')
      if (src === undefined) throw new Error('missing normal Security client asset')
      expect(src).toMatch(/^\/assets\/ws-client\.js\?v=[0-9a-f]{16}$/)
      const transportAt = scripts.findIndex(node => node.attrs.get('id') === 'xpanel-login-client')
      const workspaceAt = scripts.findIndex(node => node.attrs.get('id') === 'xpanel-realtime-client')
      expect(transportAt).toBeGreaterThanOrEqual(0)
      expect(workspaceAt).toBeGreaterThan(transportAt)
      expect(scripts.some(node => node.attrs.get('id') === 'xpanel-account-password-client')).toBe(false)
      expect(body).not.toContain(owner.id)
    } finally { documentFlow.real = false; documentFlow.observations.length = 0 }

  }))
})


describe('normal saved V2 owner Resources without host qualification', () => {
  it.each(['en', 'ar'] as const)('renders scoped stored limits with unread usage in %s through the normal producer', { tags: ['feature'] }, locale => withFixture(async ({ db, state }) => {
    const scoped = await state.store.readAccountWorkspace(account.id, { username: owner.username })
    if (!scoped?.account || !scoped.plan) throw new Error('missing real scoped Resources fixture')
    const storedPlan = scoped.plan
    const renderer = await createDefaultWebRenderer({ db, store: state.store, serverSecret: SECRET, entryPoint: 'xpanel', publicOrigin: ORIGIN.xpanel })
    const application = app(db, state, 'xpanel', { webRenderer: renderer })
    const auth = await session(db, owner, 'xpanel', { mfaVerified: false })
    const current = await read(application, 'xpanel', auth)
    expect((await request(application, 'xpanel', auth, { method: 'PUT', body: { uiTheme: 'v2', expectedRevision: current.revision } })).status).toBe(200)
    expect(await read(application, 'xpanel', auth)).toMatchObject({ state: 'saved', uiTheme: 'v2' })
    const documentPath = '/resources?lang=' + locale + '&theme=light&density=comfortable'

    // Observe the real API producer, then execute the real registered theme. No state or catalog is replaced.
    expect(documentFlow.real).toBe(false)
    const producedResponse = await request(application, 'xpanel', auth, { path: documentPath })
    expect(producedResponse.status).toBe(200)
    const produced = await producedResponse.json()
    expect(produced).not.toHaveProperty('accountId')
    expect(produced).toMatchObject({ surface: 'xpanel', uiTheme: 'v2', panel: {
      account: { id: account.id, planId: storedPlan.id, status: 'active' },
      plan: { id: storedPlan.id, resources: storedPlan.resources, caps: storedPlan.caps },
    } })
    expect(produced.panel).not.toHaveProperty('usage')
    // Closed forms show saved values: the account's own domains travel; other collections stay out.
    expect(produced.panel.domains.every((domain: { accountId: string }) => domain.accountId === account.id)).toBe(true)
    for (const key of ['databases', 'databaseUsers', 'serviceUsers', 'certificates', 'dnsRecords', 'files', 'recentAudit']) expect(produced.panel).not.toHaveProperty(key)
    expect(produced.catalog.some((tool: { status: string; delivery: { status: string } }) => tool.status === 'verified' && tool.delivery.status === 'verified')).toBe(false)

    documentFlow.observations.length = 0
    documentFlow.real = true
    try {
      const response = await request(application, 'xpanel', auth, { path: documentPath })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/html')
      const body = await response.text()
      const nodes = parseMarkup(body)
      const document = nodes.find(node => node.namespace === 'html' && node.template < 0 && node.tag === 'html')
      expect(document?.attrs.get('data-ui-theme')).toBe('v2')
      expect(document?.attrs.get('lang')).toBe(locale)
      expect(document?.attrs.get('dir')).toBe(locale === 'ar' ? 'rtl' : 'ltr')
      for (const anchor of nodes.filter(node => node.namespace === 'html' && node.template < 0 && node.tag === 'a' && node.attrs.has('href'))) {
        const hrefValue = anchor.attrs.get('href')
        if (hrefValue === undefined) throw new Error('missing live Resources link')
        const href = new URL(hrefValue, ORIGIN.xpanel)
        if (href.origin === new URL(ORIGIN.xpanel).origin) expect(href.searchParams.has('accountId')).toBe(false)
      }
      const roots = nodes.flatMap((node, index) => node.namespace === 'html' && node.template < 0 && node.attrs.get('class')?.split(/\s+/).includes('v2-panel-resources') ? [index] : [])
      expect(roots).toHaveLength(1)
      const root = roots[0]
      if (root === undefined) throw new Error('missing owned Resources root')
      const rootNode = nodes[root]
      if (!rootNode) throw new Error('missing Resources root node')
      expect(rootNode.attrs.get('data-account')).toBe(account.id)
      expect(rootNode.attrs.get('data-resource-reading')).toBe('unread')
      const within = (index: number): boolean => {
        for (let parent = nodes[index]?.parent ?? -1; parent >= 0; parent = nodes[parent]?.parent ?? -1) if (parent === root) return true
        return false
      }
      const ancestors: typeof nodes = []
      for (let parent = rootNode.parent; parent >= 0;) {
        const ancestor = nodes[parent]
        if (!ancestor) throw new Error('missing Resources ancestor')
        ancestors.push(ancestor)
        parent = ancestor.parent
      }
      expect(ancestors.some(node => node.attrs.get('data-readonly') === 'true' && node.attrs.get('data-qualified') === 'false')).toBe(true)
      const owned = nodes.filter((node, index) => node.namespace === 'html' && node.template < 0 && within(index))
      expect(owned.filter(node => node.tag === 'form')).toHaveLength(0)
      const controls = owned.filter(node => ['input', 'select', 'textarea', 'button'].includes(node.tag))
      // No reader, so no control can act: no refresh is drawn, and the approved IO direction stays disabled.
      expect(controls.map(node => [node.tag, node.attrs.has('disabled')])).toEqual([['button', true], ['button', true]])
      const readings = owned.filter(node => node.attrs.has('data-resource-state'))
      expect(readings.length).toBeGreaterThan(0)
      // Only the stored addon-domain count is known; no slice usage is measured without a reader.
      expect(readings.filter(node => node.attrs.get('data-resource-state') === 'measured')).toHaveLength(1)
      expect(owned.filter(node => node.attrs.has('data-resource-observation')).every(node => node.attrs.get('data-resource-observation') === 'unread')).toBe(true)
      // The stored 1024 MiB disk limit is shown in the product's binary byte format.
      expect(storedPlan.resources.diskMb).toBe(1024)
      expect(body).toContain('1.00 GiB')
      expect(body).not.toContain(account.contactEmail)
      expect(documentFlow.observations).toHaveLength(1)
      expect(documentFlow.observations[0]).toMatchObject({ uiTheme: 'v2', qualified: false })
    } finally {
      documentFlow.real = false
      documentFlow.observations.length = 0
    }
  }))

  it('keeps an explicit non-owner account selector denied after saving V2', { tags: ['feature'] }, () => withFixture(async ({ db, state }) => {
    const renderer = await createDefaultWebRenderer({ db, store: state.store, serverSecret: SECRET, entryPoint: 'xpanel', publicOrigin: ORIGIN.xpanel })
    const application = app(db, state, 'xpanel', { webRenderer: renderer })
    const auth = await session(db, owner, 'xpanel', { mfaVerified: false })
    const current = await read(application, 'xpanel', auth)
    expect((await request(application, 'xpanel', auth, { method: 'PUT', body: { uiTheme: 'v2', expectedRevision: current.revision } })).status).toBe(200)
    documentFlow.observations.length = 0
    documentFlow.real = true
    try {
      const response = await request(application, 'xpanel', auth, { path: '/resources?lang=en&theme=light&density=comfortable&accountId=' + randomUUID() })
      expect(response.status).toBe(404)
      const nodes = parseMarkup(await response.text())
      expect(nodes.some(node => node.template < 0 && node.attrs.get('class')?.split(/\s+/).includes('v2-panel-resources'))).toBe(false)
    } finally {
      documentFlow.real = false
      documentFlow.observations.length = 0
    }
  }))
})


describe('normal registered owner documents with stored facts and unqualified native capabilities', () => {
  const routes = registeredThemeDocuments().filter(document => document.surface === 'xpanel').map(document => document.route).sort()
  const aliases = registeredDocumentAliases.filter(alias => routes.includes(alias.route))
  const cases = (['en', 'ar'] as const).flatMap(locale => routes.map(route => ({ locale, route })))

  it('pins the actual75 owner documents and the seven installer aliases without adding policy routes', () => {
    expect(routes).toHaveLength(75)
    expect(new Set(routes).size).toBe(75)
    expect(routes).toEqual(expect.arrayContaining(['/home', '/resources', '/security/account', '/software/installer']))
    expect(routes).not.toContain('/panel')
    expect(aliases).toHaveLength(7)
    for (const alias of aliases) {
      expect(alias.parentRoute).toBe('/software/installer')
      expect(canonicalNavigationRoute(alias.route)).toBe(alias.parentRoute)
    }
  })

  describe.each(['classic', 'v2'] as const)('with a saved %s theme', uiTheme => {
    let group: DocumentGroup
    beforeAll(async () => { group = await openDocumentGroup('xpanel', owner, uiTheme, { mfaVerified: false }) })
    afterAll(async () => { await group?.close() })

    it.each(cases)('renders ' + uiTheme + ' $locale $route from the real authorized producer without a native grant', { tags: ['feature'] }, async ({ locale, route }) => {
      const documentPath = route + '?lang=' + locale + '&theme=light&density=comfortable'
      const { response, body, observations } = await renderDocument(group.application, 'xpanel', group.auth, documentPath)
      expect(observations).toHaveLength(1)
      const produced = observations[0]?.produced
      expect(produced).toMatchObject({ surface: 'xpanel', activeRoute: route, uiTheme, panel: {
        account: { id: account.id, planId: account.planId, status: 'active' }, plan: { id: account.planId },
      } })
      expect(produced).not.toHaveProperty('accountId')
      expect(produced.panel).not.toHaveProperty('usage')
      expect(produced.catalog.some((tool: { status: string; delivery: { status: string } }) => tool.status === 'verified' && tool.delivery.status === 'verified')).toBe(false)
      // Existing Home may supply authorized stored collections. Other unqualified documents receive account, plan and the
      // account's own saved domains, so closed forms show their values.
      if (route !== '/home') {
        expect(produced.panel.domains.every((domain: { accountId: string }) => domain.accountId === account.id)).toBe(true)
        for (const key of ['databases', 'databaseUsers', 'serviceUsers', 'certificates', 'dnsRecords', 'files', 'recentAudit']) expect(produced.panel).not.toHaveProperty(key)
      }
      expect(response.status).toBe(200)
      const nodes = expectDocumentPolicy(response, body, route)
      const html = nodes.find(node => node.namespace === 'html' && node.template < 0 && node.tag === 'html')
      expect(html?.attrs.get('lang')).toBe(locale)
      expect(html?.attrs.get('dir')).toBe(locale === 'ar' ? 'rtl' : 'ltr')
      expect(html?.attrs.get('data-ui-theme') ?? 'classic').toBe(uiTheme)
      expect(leakedAccountHrefs(nodes, 'xpanel')).toEqual([])
      expect(observations[0]?.qualified).toBe(false)
    })
  })
})


describe('normal registered operator and mailbox documents with stored identity only', () => {
  const documents = registeredThemeDocuments()
  const routes = {
    xwhm: documents.filter(document => document.surface === 'xwhm').map(document => document.route).sort(),
    xmail: documents.filter(document => document.surface === 'xmail').map(document => document.route).sort(),
  }
  const groups = (['xwhm', 'xmail'] as const).flatMap(surface => (['classic', 'v2'] as const).map(uiTheme => ({ surface, uiTheme })))

  it('pins the actual120 operator and23 mailbox documents with their existing aliases', () => {
    expect(routes.xwhm).toHaveLength(120)
    expect(routes.xmail).toHaveLength(23)
    expect(new Set(routes.xwhm).size).toBe(120)
    expect(new Set(routes.xmail).size).toBe(23)
    const whmAliases = registeredDocumentAliases.filter(alias => routes.xwhm.includes(alias.route))
    const mailAliases = registeredDocumentAliases.filter(alias => routes.xmail.includes(alias.route))
    expect(whmAliases).toHaveLength(3)
    expect(mailAliases).toHaveLength(4)
    for (const alias of whmAliases) {
      expect(alias.parentRoute).toBe('/whm/software/site-software')
      expect(canonicalNavigationRoute(alias.route)).toBe(alias.parentRoute)
    }
    for (const alias of mailAliases) {
      expect(alias.parentRoute).toBe('/mail/inbox')
      expect(canonicalNavigationRoute(alias.route)).toBe(alias.parentRoute)
    }
    expect(routes.xmail).toEqual(expect.arrayContaining(['/mail/search', '/mail/settings/security']))
  })

  describe.each(groups)('$surface with a saved $uiTheme theme', ({ surface, uiTheme }) => {
    let group: DocumentGroup
    beforeAll(async () => {
      group = await openDocumentGroup(surface, surface === 'xwhm' ? root : mailboxPrincipal, uiTheme, surface === 'xmail' ? { mailbox, mfaVerified: false } : {})
    })
    afterAll(async () => { await group?.close() })
    const cases = (['en', 'ar'] as const).flatMap(locale => routes[surface].map(route => ({ locale, route })))

    it.each(cases)('renders ' + surface + ' ' + uiTheme + ' $locale $route without provider observations', { tags: ['feature'] }, async ({ locale, route }) => {
      const snapshot = vi.spyOn(group.state.store, 'readSnapshot')
      const nativeMail = vi.spyOn(mailDocuments, 'loadMailDocument').mockImplementation(async () => { throw new Error('unexpected mail provider document load') })
      const path = route + '?lang=' + locale + '&theme=light&density=comfortable'
      try {
        const { response, body, observations } = await renderDocument(group.application, surface, group.auth, path)
        expect(observations).toHaveLength(1)
        const produced = observations[0]?.produced
        expect(produced).toMatchObject({ surface, uiTheme, activeRoute: route })
        expect(produced).not.toHaveProperty('accountId')
        expect(produced).not.toHaveProperty('generationId')
        expect(produced.catalog.some((tool: { status: string; delivery: { status: string } }) => tool.status === 'verified' && tool.delivery.status === 'verified')).toBe(false)
        if (surface === 'xwhm') {
          // Read-only documents carry the first page of each saved list; preferences address only the principal.
          expect(Object.keys(produced.whm).sort()).toEqual(route === '/whm/preferences' ? ['activeReseller', 'principal']
            : ['accounts', 'activeReseller', 'dnsZones', 'domains', 'featureLists', 'ipPool', 'plans', 'principal', 'resellers'])
          expect(produced.whm).toMatchObject({ principal: { kind: 'root', id: root.id }, activeReseller: null })
          expect(produced).not.toHaveProperty('mail')
        } else {
          expect(produced.mail).toEqual({ mailbox: mailbox.login })
          expect(produced).not.toHaveProperty('whm')
        }
        expect(response.status).toBe(200)
        const nodes = expectDocumentPolicy(response, body, route)
        const html = nodes.find(node => node.namespace === 'html' && node.template < 0 && node.tag === 'html')
        expect(html?.attrs.get('lang')).toBe(locale)
        expect(html?.attrs.get('dir')).toBe(locale === 'ar' ? 'rtl' : 'ltr')
        expect(html?.attrs.get('data-ui-theme') ?? 'classic').toBe(uiTheme)
        expect(leakedAccountHrefs(nodes, surface)).toEqual([])
        expect(observations[0]?.qualified).toBe(false)
        expect(snapshot).not.toHaveBeenCalled()
        expect(nativeMail).not.toHaveBeenCalled()
      } finally {
        snapshot.mockRestore()
        nativeMail.mockRestore()
      }
    })
  })

  const denied = async (application: ReturnType<typeof app>, surface: 'xwhm' | 'xmail', auth: Awaited<ReturnType<typeof session>>, path: string, status: 403 | 404 = 403): Promise<void> => {
    // Observation mode exposes the real producer model; real mode checks the actual HTML status.
    expect(documentFlow.real).toBe(false)
    const source = await (await request(application, surface, auth, { path })).json()
    expect(source.error?.status).toBe(status)
    expect(source).not.toHaveProperty('mail')
    expect(source).not.toHaveProperty('whm')
    documentFlow.real = true
    try {
      const response = await request(application, surface, auth, { path })
      expect(response.status).toBe(status)
      const nodes = parseMarkup(await response.text())
      expect(nodes.some(node => node.namespace === 'html' && node.template < 0 && node.attrs.get('data-mailbox') === mailbox.login)).toBe(false)
    } finally { documentFlow.real = false; documentFlow.observations.length = 0 }
  }

  it.each(['missing', 'deleted', 'recreated', 'wrong-account', 'email-disabled', 'feature-disabled'] as const)('refuses an ordinary mailbox document with %s binding', { tags: ['feature'] }, mode => withFixture(async ({ db, state }) => {
    const renderer = await createDefaultWebRenderer({ db, store: state.store, serverSecret: SECRET, entryPoint: 'xmail', publicOrigin: ORIGIN.xmail })
    const application = app(db, state, 'xmail', { webRenderer: renderer })
    const auth = await session(db, mailboxPrincipal, 'xmail', mode === 'missing' ? { mfaVerified: false } : { mailbox, mfaVerified: false })
    if (mode === 'deleted' || mode === 'recreated') {
      await state.store.deleteServiceUser(mailbox.id)
      if (mode === 'recreated') {
        const replacement = await state.store.createServiceUser({ accountId: account.id, login: mailbox.login, passwordHash: HASH,
          services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html' })
        expect(replacement.id).not.toBe(mailbox.id)
      }
    } else if (mode === 'wrong-account') {
      const saved = (await db.query<{ id: string }>('SELECT id FROM sessions WHERE token_hash=$1', [sessionTokenHash(auth.raw, 'xmail')]))[0]
      if (!saved) throw new Error('missing actual mailbox session fixture')
      await db.query('UPDATE mailbox_sessions SET account_id=$1 WHERE session_id=$2', [randomUUID(), saved.id])
    } else if (mode === 'email-disabled') {
      await state.store.updateServiceUser(mailbox.id, { services: { email: false, ftp: true, webdisk: false } })
    } else if (mode === 'feature-disabled') {
      const plan = await state.store.getPlan(account.planId)
      if (!plan) throw new Error('missing actual mailbox plan fixture')
      await state.store.updateFeatureList(plan.featureListId, { disabled: ['webmail-message-list'] })
    }
    await denied(application, 'xmail', auth, '/mail/inbox?lang=en')
  }))

  it('retains a successfully revalidated mailbox when the saved preference cannot be read', { tags: ['feature'] }, () => withFixture(async ({ db, state }) => {
    const renderer = await createDefaultWebRenderer({ db, store: state.store, serverSecret: SECRET, entryPoint: 'xmail', publicOrigin: ORIGIN.xmail })
    const application = app(db, state, 'xmail', { webRenderer: renderer })
    const auth = await session(db, mailboxPrincipal, 'xmail', { mailbox, mfaVerified: false })
    const preference = await read(application, 'xmail', auth)
    expect((await request(application, 'xmail', auth, { method: 'PUT', body: { uiTheme: 'v2', expectedRevision: preference.revision } })).status).toBe(200)
    const failedPreference = vi.spyOn(uiPreferenceReads, 'readUiPreferenceValue').mockRejectedValue(new Error('unreadable saved preference fixture'))
    const nativeMail = vi.spyOn(mailDocuments, 'loadMailDocument').mockImplementation(async () => { throw new Error('unexpected mail provider document load') })
    try {
      const produced = await (await request(application, 'xmail', auth, { path: '/mail/inbox?lang=en' })).json()
      expect(produced.mail).toEqual({ mailbox: mailbox.login })
      expect(produced).not.toHaveProperty('error')
      documentFlow.real = true
      expect((await request(application, 'xmail', auth, { path: '/mail/inbox?lang=en' })).status).toBe(200)
      expect(failedPreference).toHaveBeenCalledTimes(2)
      expect(nativeMail).not.toHaveBeenCalled()
    } finally { documentFlow.real = false; documentFlow.observations.length = 0; failedPreference.mockRestore(); nativeMail.mockRestore() }
  }))

  it('does not turn a swallowed binding failure into mailbox authority or a preference fallback grant', { tags: ['feature'] }, () => withFixture(async ({ db, state }) => {
    const renderer = await createDefaultWebRenderer({ db, store: state.store, serverSecret: SECRET, entryPoint: 'xmail', publicOrigin: ORIGIN.xmail })
    const application = app(db, state, 'xmail', { webRenderer: renderer })
    const auth = await session(db, mailboxPrincipal, 'xmail', { mfaVerified: false })
    const preference = vi.spyOn(uiPreferenceReads, 'readUiPreferenceValue').mockRejectedValue(new Error('unreadable saved preference fixture'))
    try { await denied(application, 'xmail', auth, '/mail/inbox?lang=ar'); expect(preference).not.toHaveBeenCalled() }
    finally { preference.mockRestore() }
  }))

  it('uses the validated mailbox record rather than URL mailbox or username hints', { tags: ['feature'] }, () => withFixture(async ({ db, state }) => {
    const renderer = await createDefaultWebRenderer({ db, store: state.store, serverSecret: SECRET, entryPoint: 'xmail', publicOrigin: ORIGIN.xmail })
    const application = app(db, state, 'xmail', { webRenderer: renderer })
    const auth = await session(db, mailboxPrincipal, 'xmail', { mailbox, mfaVerified: false })
    const produced = await (await request(application, 'xmail', auth, { path: '/mail/inbox?lang=en&mailbox=foreign%40example.test&username=foreign' })).json()
    expect(produced.mail).toEqual({ mailbox: mailbox.login })
    expect(produced).not.toHaveProperty('accountId')
  }))

  it.each([
    { surface: 'xwhm', actor: 'owner' }, { surface: 'xwhm', actor: 'mailbox' },
    { surface: 'xmail', actor: 'root' }, { surface: 'xmail', actor: 'owner' },
  ] as const)('keeps legacy authenticated $actor out of $surface documents', { tags: ['feature'] }, ({ surface, actor }) => withFixture(async ({ db, state }) => {
    const renderer = await createDefaultWebRenderer({ db, store: state.store, serverSecret: SECRET })
    const application = app(db, state, undefined, { webRenderer: renderer })
    const identity = actor === 'root' ? root : actor === 'owner' ? owner : mailboxPrincipal
    const auth = await session(db, identity, undefined, actor === 'mailbox' ? { mailbox } : {})
    await denied(application, surface, auth, surface === 'xwhm' ? '/whm/accounts?lang=en' : '/mail/inbox?lang=en')
  }))

  it.each(['xwhm', 'xmail'] as const)('keeps an unknown account selector denied in %s', { tags: ['feature'] }, surface => withFixture(async ({ db, state }) => {
    const renderer = await createDefaultWebRenderer({ db, store: state.store, serverSecret: SECRET, entryPoint: surface, publicOrigin: ORIGIN[surface] })
    const application = app(db, state, surface, { webRenderer: renderer })
    const auth = await session(db, surface === 'xwhm' ? root : mailboxPrincipal, surface, surface === 'xmail' ? { mailbox, mfaVerified: false } : {})
    await denied(application, surface, auth, (surface === 'xwhm' ? '/whm/accounts' : '/mail/inbox') + '?lang=en&accountId=' + randomUUID(), 404)
  }))

  it('supplies only exact matched reseller identity after ordinary ACL admission', { tags: ['feature'] }, () => withFixture(async ({ db, state }) => {
    const renderer = await createDefaultWebRenderer({ db, store: state.store, serverSecret: SECRET, entryPoint: 'xwhm', publicOrigin: ORIGIN.xwhm })
    const application = app(db, state, 'xwhm', { webRenderer: renderer })
    const auth = await session(db, realmResellerPrincipal, 'xwhm', { mfaVerified: false })
    const produced = await (await request(application, 'xwhm', auth, { path: '/whm/accounts?lang=en' })).json()
    expect(Object.keys(produced.whm).sort()).toEqual(['accounts', 'activeReseller', 'dnsZones', 'domains', 'featureLists', 'plans', 'principal', 'resellers'])
    expect(produced.whm).toMatchObject({ principal: { kind: 'reseller', id: realmReseller.id, username: realmReseller.username }, activeReseller: { id: realmReseller.id, username: realmReseller.username } })
  }))

  it('does not substitute mismatched reseller metadata for the authenticated principal', { tags: ['feature'] }, () => withFixture(async ({ db, state }) => {
    const renderer = await createDefaultWebRenderer({ db, store: state.store, serverSecret: SECRET, entryPoint: 'xwhm', publicOrigin: ORIGIN.xwhm })
    const application = app(db, state, 'xwhm', { webRenderer: renderer })
    const auth = await session(db, realmResellerPrincipal, 'xwhm', { mfaVerified: false })
    await db.query('UPDATE principals SET username=$1 WHERE id=$2', ['realmchanged', realmResellerPrincipal.id])
    await denied(application, 'xwhm', auth, '/whm/accounts?lang=en')
  }))

  it('keeps ordinary ACL denial and the existing self-preference and factor exceptions distinct', { tags: ['feature'] }, () => withFixture(async ({ db, state }) => {
    const renderer = await createDefaultWebRenderer({ db, store: state.store, serverSecret: SECRET, entryPoint: 'xwhm', publicOrigin: ORIGIN.xwhm })
    const application = app(db, state, 'xwhm', { webRenderer: renderer })
    const auth = await session(db, realmResellerPrincipal, 'xwhm', { mfaVerified: false })
    await state.store.updateReseller(realmReseller.id, { acl: [] })
    await denied(application, 'xwhm', auth, '/whm/accounts?lang=en')
    documentFlow.real = true
    try {
      expect((await request(application, 'xwhm', auth, { path: '/whm/preferences?lang=en' })).status).toBe(200)
      expect((await request(application, 'xwhm', auth, { path: '/whm/security/sign-in?lang=en' })).status).toBe(200)
    } finally { documentFlow.real = false; documentFlow.observations.length = 0 }
  }))

  it('does not supply operator facts after the reseller record disappears', { tags: ['feature'] }, () => withFixture(async ({ db, state }) => {
    const renderer = await createDefaultWebRenderer({ db, store: state.store, serverSecret: SECRET, entryPoint: 'xwhm', publicOrigin: ORIGIN.xwhm })
    const application = app(db, state, 'xwhm', { webRenderer: renderer })
    const auth = await session(db, realmResellerPrincipal, 'xwhm', { mfaVerified: false })
    await state.store.deleteReseller(realmReseller.id)
    await denied(application, 'xwhm', auth, '/whm/accounts?lang=en')
  }))

  it('preserves factor-only mailbox recovery without inventing a mailbox binding', { tags: ['feature'] }, () => withFixture(async ({ db, state }) => {
    const renderer = await createDefaultWebRenderer({ db, store: state.store, serverSecret: SECRET, entryPoint: 'xmail', publicOrigin: ORIGIN.xmail })
    const application = app(db, state, 'xmail', { webRenderer: renderer })
    const auth = await session(db, mailboxPrincipal, 'xmail', { mfaVerified: false })
    const produced = await (await request(application, 'xmail', auth, { path: '/mail/settings/security?lang=en' })).json()
    expect(produced).not.toHaveProperty('mail')
    expect(produced).not.toHaveProperty('error')
    documentFlow.real = true
    try {
      const response = await request(application, 'xmail', auth, { path: '/mail/settings/security?lang=en' })
      expect(response.status).toBe(200)
      const nodes = parseMarkup(await response.text())
      expect(nodes.filter(node => node.namespace === 'html' && node.template < 0 && node.attrs.get('data-account-security') === 'two-factor')).toHaveLength(1)
    } finally { documentFlow.real = false; documentFlow.observations.length = 0 }
  }))

  it('does not turn a pending enrolled factor into operator document authority', { tags: ['feature'] }, () => withFixture(async ({ db, state }) => {
    const renderer = await createDefaultWebRenderer({ db, store: state.store, serverSecret: SECRET, entryPoint: 'xwhm', publicOrigin: ORIGIN.xwhm })
    const application = app(db, state, 'xwhm', { webRenderer: renderer })
    const auth = await session(db, root, 'xwhm', { mfaVerified: false })
    const response = await request(application, 'xwhm', auth, { path: '/whm/accounts?lang=en' })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/login')
    expect(await response.text()).toBe('')
  }))

  it('renders the v2 unavailable page over HTTP when an admitted caller opens an unqualified route without panel facts', { tags: ['feature'] }, () => withFixture(async ({ db, state }) => {
    const baselineWorkspace = await state.store.readAccountWorkspace(account.id, { username: owner.username })
    if (!baselineWorkspace?.account || !baselineWorkspace.plan || !baselineWorkspace.featureList) throw new Error('missing workspace fixture')
    const mismatchedWorkspace = {
      account: baselineWorkspace.account,
      plan: { ...baselineWorkspace.plan, id: randomUUID() },
      featureList: baselineWorkspace.featureList,
    }
    const splitRenderer = await createDefaultWebRenderer({ db, store: state.store, serverSecret: SECRET, entryPoint: 'xpanel', publicOrigin: ORIGIN.xpanel })
    const splitApp = app(db, state, 'xpanel', { webRenderer: splitRenderer })
    const ownerAuth = await session(db, owner, 'xpanel')

    const spy = vi.spyOn(state.store, 'readAccountWorkspace')
    try {
      spy.mockResolvedValueOnce(mismatchedWorkspace)
      const produced = await (await request(splitApp, 'xpanel', ownerAuth, { path: '/resources?lang=en' })).json()
      expect(produced).not.toHaveProperty('panel')
      expect(produced.workspaceSummary).toMatchObject({ account: { id: account.id, status: 'active' } })

      documentFlow.real = true
      for (const locale of ['en', 'ar'] as const) {
        spy.mockResolvedValueOnce(mismatchedWorkspace)
        const mismatchRes = await request(splitApp, 'xpanel', ownerAuth, { path: `/resources?lang=${locale}` })
        const mismatchHtml = await mismatchRes.text()
        expect(mismatchRes.status).toBe(200)
        expectDocumentPolicy(mismatchRes, mismatchHtml, '/resources')
        expect(mismatchHtml).toContain('data-ui-theme="v2"')
        expect(mismatchHtml).toContain('data-tool-availability="unverified"')
        expect(mismatchHtml).toContain('data-workspace-field="status"')
        expect(mismatchHtml).not.toContain('data-readonly="true"')
      }
    } finally {
      documentFlow.real = false
      documentFlow.observations.length = 0
      spy.mockRestore()
    }

    await state.store.suspendAccount(account.id, 'Suspended fixture')
    const summaryApp = app(db, state, 'xpanel', {
      webRenderer: req => serveWebUi(req, async url => ({
        surface: 'xpanel',
        activeRoute: '/resources',
        ...(url.searchParams.get('lang') === 'ar' ? { locale: 'ar' as const } : { locale: 'en' as const }),
        visibility: { principal: { kind: 'user', id: owner.id, username: owner.username, accountId: account.id }, disabledFeatures: new Set() },
        workspaceSummary: {
          account: { id: account.id, ownerId: account.ownerId, username: account.username, primaryDomain: account.primaryDomain, status: 'suspended', planId: account.planId },
        },
      })),
    })
    documentFlow.real = true
    try {
      const deniedSuspended = await request(splitApp, 'xpanel', ownerAuth, { path: '/resources?lang=en' })
      const deniedHtml = await deniedSuspended.text()
      expect(deniedSuspended.status).toBe(403)
      expectDocumentPolicy(deniedSuspended, deniedHtml, '/resources')
      expect(deniedHtml).toContain('data-ui-theme="v2"')

      for (const locale of ['en', 'ar'] as const) {
        const summaryRes = await request(summaryApp, 'xpanel', ownerAuth, { path: `/resources?lang=${locale}` })
        const summaryHtml = await summaryRes.text()
        expect(summaryRes.status).toBe(200)
        expectDocumentPolicy(summaryRes, summaryHtml, '/resources')
        expect(summaryHtml).toContain('data-ui-theme="v2"')
        expect(summaryHtml).toContain('data-tool-availability="unverified"')
        expect(summaryHtml).toContain('data-workspace-field="status"')
        expect(summaryHtml).not.toContain('data-readonly="true"')
        if (locale === 'en') expect(summaryHtml).toContain('Suspended')
        else expect(summaryHtml).toContain('dir="rtl"')
      }
    } finally { documentFlow.real = false; documentFlow.observations.length = 0 }
  }))
})
