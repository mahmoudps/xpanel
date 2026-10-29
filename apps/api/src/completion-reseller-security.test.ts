import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeHostExecutor, HostReconciler, createAgentApp } from '@xpanel/agent'
import type { Limit, PhpSettings, ResellerAcl } from '@xpanel/core'
import { createRootPrincipal, createTestDb, createUserPrincipal, findPrincipalByUsername } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { createTestStateStore } from '@xpanel/state'
import { createApiApp, listenApiServer } from './server.ts'
import { TEST_AGENT_TOKEN, TEST_SERVER_SECRET } from './testing.ts'

/**
 * Focused real-HTTP acceptance for the reseller administration surface:
 * GET/POST /api/resellers, PATCH/DELETE /api/resellers/:id, root-only guards, ACL and
 * limit readback/revocation, reseller-owned account scoping through GET/POST /api/accounts,
 * and the real reseller.created / reseller.updated audit join.
 *
 * The fixture reuses the production bootstrap: disposable in-memory SQLite, a disposable
 * StateStore directory, the real API app served over a loopback socket, real root/reseller/
 * user password logins with CSRF, and the real agent app backed by FakeHostExecutor (host
 * effects are only the documented fake executor, never claimed as native provisioning).
 * No route internals are mocked and no test-only server export is used.
 */

// Public independent Argon2 fixture vector; these identities authenticate disposable synthetic fixtures only.
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const PASSWORD = 'correct horse battery staple'
const OS_RELEASE = ['ID=ubuntu', 'VERSION_ID="24.04"', 'VERSION_CODENAME=noble', 'NAME="Ubuntu"'].join('\n')
const RESELLER_KEYS = ['acl', 'delegatedIps', 'id', 'maxAccounts', 'nameservers', 'oversell', 'totalBandwidthMb', 'totalDiskMb', 'username']
const cleanup: Array<() => Promise<unknown>> = []

afterEach(async () => {
  const results = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close()))
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Synthetic reseller fixture cleanup failed')
})

interface Problem {
  code?: string
  detail?: string
  details?: Record<string, unknown>
}
interface Session {
  cookie: string
  csrf: string
  principal: { kind: string; id: string; username: string; accountId?: string }
}
interface ResellerView {
  id: string
  username: string
  acl: ResellerAcl[]
  maxAccounts: Limit
  totalDiskMb: Limit
  totalBandwidthMb: Limit
  oversell: boolean
  nameservers: string[]
  delegatedIps: string[]
}
interface AccountView {
  id: string
  username: string
  ownerId: string | null
  planId: string
  status: string
  contactEmail: string
  ipv4: string
}
interface AuditRow {
  [column: string]: unknown
  actor: string
  principal_id: string | null
  action: string
  target: string
  outcome: string
  detail: string
}
interface AccountAck {
  account: AccountView
  reconcile: { status: string } | null
  execution: { status: string; scope: string; targetVerified: boolean }
}

const sortedAcl = (acl: readonly ResellerAcl[]): ResellerAcl[] => [...new Set(acl)].sort()
const omit = (value: Record<string, unknown>, key: string): Record<string, unknown> => {
  const copy = { ...value }
  delete copy[key]
  return copy
}
const resellerDraft = (username: string, patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  username,
  passwordHash: HASH,
  acl: ['create-account', 'edit-account', 'list-accounts'],
  maxAccounts: 4,
  totalDiskMb: 8000,
  totalBandwidthMb: 20000,
  oversell: false,
  nameservers: ['ns1.example.test'],
  delegatedIps: ['192.0.2.42'],
  ...patch,
})

const fixture = async () => {
  const database = await createTestDb()
  cleanup.push(() => database.close())
  const state = await createTestStateStore()
  cleanup.push(() => state.close())
  const hostDir = await mkdtemp(join(tmpdir(), 'xpanel-reseller-host-'))
  cleanup.push(() => rm(hostDir, { recursive: true, force: true }))

  const features = await state.store.createFeatureList({ name: 'Reseller policy', ownerId: null, disabled: [] })
  const planResources = {
    diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576,
    ioReadIops: 100, ioWriteIops: 100, memoryMb: 256, maxProcesses: 16, cpuPercent: 100,
  }
  const planCaps = {
    addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 4, forwarders: 4,
    mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5,
  }
  const plan = await state.store.createPlan({
    name: 'Reseller plan', ownerId: null, featureListId: features.id,
    resources: planResources, caps: planCaps, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100,
  })
  const createPlan = (name: string, ownerId: string | null, patch: { diskMb?: number; bandwidthMbMonth?: number } = {}) =>
    state.store.createPlan({
      name, ownerId, featureListId: features.id,
      resources: { ...planResources, ...patch }, caps: planCaps,
      dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100,
    })
  await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  await state.store.saveServerIp({ address: '192.0.2.42', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: false, notes: '' })
  await state.store.saveServerIp({ address: '192.0.2.77', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: false, notes: '' })

  const os = profileFor(OS_RELEASE)
  const executor = new FakeHostExecutor()
  const agentApp = createAgentApp({
    reconciler: new HostReconciler({ store: state.store, db: database.db, executor, os }),
    store: state.store, db: database.db, executor,
    os: { id: os.id, versionId: os.versionId, family: os.family },
    agentToken: TEST_AGENT_TOKEN,
    homeBaseDir: hostDir,
  })
  const app = createApiApp({
    db: database.db, store: state.store, serverSecret: TEST_SERVER_SECRET,
    agentApp, agentToken: TEST_AGENT_TOKEN, os,
  })
  const listener = await listenApiServer(app, { host: '127.0.0.1', port: 0 })
  cleanup.push(async () => { listener.server.closeAllConnections(); await listener.close() })

  const root = await createRootPrincipal(database.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })
  const php: PhpSettings = {
    version: '8.3', handler: 'fpm',
    fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 },
    ini: {},
  }
  const seedAccount = (username: string, ownerId: string | null, patch: { ipv4?: string } = {}) => state.store.createAccount({
    username, passwordHash: HASH, primaryDomain: `${username}.example.test`, planId: plan.id, ownerId,
    contactEmail: `owner@${username}.example.test`, ipv4: patch.ipv4 ?? '192.0.2.10', shell: 'none', php,
  })
  const rootOwned = await seedAccount('rootown9', null)
  const userPrincipal = await createUserPrincipal(database.db, { username: rootOwned.username, accountId: rootOwned.id, passwordHash: HASH })

  const call = (path: string, method = 'GET', body?: unknown, session?: Session | null, opts: { csrf?: string | null } = {}): Promise<Response> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const headers: Record<string, string> = { host: 'localhost' }
      if (payload !== undefined) {
        headers['content-type'] = 'application/json'
        headers['content-length'] = String(Buffer.byteLength(payload))
      }
      if (session) {
        headers.cookie = session.cookie
        const csrf = opts.csrf === undefined ? session.csrf : opts.csrf
        if (csrf !== null && method !== 'GET' && method !== 'HEAD') headers['x-csrf-token'] = csrf
      }
      const outgoing = httpRequest({ hostname: '127.0.0.1', port: listener.port, path, method, headers }, incoming => {
        const chunks: Buffer[] = []
        incoming.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
        incoming.once('error', reject)
        incoming.once('end', () => resolve(new Response(Buffer.concat(chunks), {
          status: incoming.statusCode ?? 500,
          headers: { 'set-cookie': incoming.headers['set-cookie']?.join(', ') ?? '' },
        })))
      })
      outgoing.once('error', reject)
      outgoing.end(payload)
    })
  const login = async (username: string, password: string = PASSWORD): Promise<Session> => {
    const response = await call('/api/auth/login', 'POST', { username, password })
    const text = await response.text()
    expect(response.status, `login ${username}: ${text}`).toBe(200)
    const body = JSON.parse(text) as { csrfToken?: unknown; principal?: { kind?: unknown; id?: unknown; username?: unknown; accountId?: unknown } }
    expect(typeof body.csrfToken, `login ${username} csrf`).toBe('string')
    expect((body.csrfToken as string)).toMatch(/^[0-9a-f]{64}$/)
    const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    expect(cookie).toMatch(/^xpanel_session=[0-9a-f]{64}$/)
    const principal = body.principal ?? {}
    return {
      cookie,
      csrf: body.csrfToken as string,
      principal: {
        kind: String(principal.kind), id: String(principal.id), username: String(principal.username),
        ...(typeof principal.accountId === 'string' ? { accountId: principal.accountId } : {}),
      },
    }
  }
  const rootSession = await login('root')
  const createReseller = async (username: string, patch: Record<string, unknown> = {}): Promise<ResellerView> => {
    const response = await call('/api/resellers', 'POST', resellerDraft(username, patch), rootSession)
    const text = await response.text()
    expect(response.status, `create reseller ${username}: ${text}`).toBe(201)
    return (JSON.parse(text) as { reseller: ResellerView }).reseller
  }
  const problemOf = async (response: Response): Promise<Problem> => JSON.parse(await response.text()) as Problem
  const auditRows = (action?: string) => database.db.query<AuditRow>(
    action === undefined
      ? 'SELECT actor, principal_id, action, target, outcome, detail FROM audit_log ORDER BY id ASC'
      : 'SELECT actor, principal_id, action, target, outcome, detail FROM audit_log WHERE action = $1 ORDER BY id ASC',
    action === undefined ? [] : [action],
  )
  const accountsOf = async (session: Session): Promise<AccountView[]> => {
    const response = await call('/api/accounts', 'GET', undefined, session)
    const text = await response.text()
    expect(response.status, text).toBe(200)
    return (JSON.parse(text) as { accounts: AccountView[] }).accounts
  }
  const resellersOf = async (session: Session): Promise<ResellerView[]> => {
    const response = await call('/api/resellers', 'GET', undefined, session)
    const text = await response.text()
    expect(response.status, text).toBe(200)
    return (JSON.parse(text) as { resellers: ResellerView[] }).resellers
  }
  const accountDraft = (username: string, patch: Record<string, unknown> = {}): Record<string, unknown> => ({
    username, primaryDomain: `${username}.example.test`, planId: plan.id, passwordHash: HASH, ...patch,
  })

  return {
    database, state, features, plan, root, rootOwned, userPrincipal, executor, rootSession,
    call, login, createReseller, problemOf, auditRows, accountsOf, resellersOf, createPlan, seedAccount, accountDraft,
  }
}

describe('real HTTP reseller administration security', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })

  it('creates a reseller as root with exact StateStore readback and a principal-bound audit entry', async () => {
    expect(await f.state.store.listResellers()).toEqual([])
    const reseller = await f.createReseller('resellera')
    expect(reseller).toMatchObject({
      username: 'resellera',
      acl: sortedAcl(['create-account', 'edit-account', 'list-accounts']),
      maxAccounts: 4,
      totalDiskMb: 8000,
      totalBandwidthMb: 20000,
      oversell: false,
      nameservers: ['ns1.example.test'],
      delegatedIps: ['192.0.2.42'],
    })
    expect(reseller.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    // The real StateStore is authoritative; the response must not leak the credential hash.
    expect(await f.state.store.getReseller(reseller.id)).toEqual(reseller)
    expect(JSON.stringify(reseller)).not.toContain(HASH)
    expect(await f.resellersOf(f.rootSession)).toEqual([reseller])

    const created = await f.auditRows('reseller.created')
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ actor: 'root', principal_id: f.root.id, target: 'reseller:resellera', outcome: 'ok' })
    expect(JSON.parse(created[0]!.detail)).toMatchObject({ resellerId: reseller.id })
  })

  it('lists every reseller for root and only its own record for a reseller', async () => {
    const first = await f.createReseller('lista')
    const second = await f.createReseller('listb')
    const rootView = await f.resellersOf(f.rootSession)
    expect(rootView.map(item => item.id).sort()).toEqual([first.id, second.id].sort())
    expect(rootView.map(item => item.id).sort()).toEqual((await f.state.store.listResellers()).map(item => item.id).sort())

    const own = await f.resellersOf(await f.login('lista'))
    expect(own).toHaveLength(1)
    expect(own[0]).toEqual(first)
    expect(JSON.stringify(own)).not.toContain(second.id)
    expect(JSON.stringify(own)).not.toContain('listb')
  })

  it('applies a root edit with exact PATCH readback and a bound reseller.updated audit entry', async () => {
    const created = await f.createReseller('edita')
    const patch = {
      acl: ['list-accounts', 'edit-account'],
      maxAccounts: 6,
      totalDiskMb: 'unlimited' as const,
      totalBandwidthMb: 30000,
      oversell: true,
      nameservers: ['ns1.example.test', 'ns2.example.test'],
      delegatedIps: [],
    }
    const response = await f.call(`/api/resellers/${created.id}`, 'PATCH', patch, f.rootSession)
    const text = await response.text()
    expect(response.status, text).toBe(200)
    const updated = (JSON.parse(text) as { reseller: ResellerView }).reseller
    const expected = { ...created, ...patch, acl: sortedAcl(patch.acl as ResellerAcl[]) }
    expect(updated).toEqual(expected)
    expect(await f.state.store.getReseller(created.id)).toEqual(expected)
    expect((await f.resellersOf(f.rootSession)).find(item => item.id === created.id)).toEqual(expected)

    const audits = await f.auditRows('reseller.updated')
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ actor: 'root', principal_id: f.root.id, target: 'reseller:edita', outcome: 'ok' })
  })

  it('refuses invalid reseller bodies and unknown ids without changing stored resellers or audits', async () => {
    const created = await f.createReseller('valida')
    const before = await f.state.store.listResellers()
    const createdAudits = (await f.auditRows('reseller.created')).length
    const valid = resellerDraft('validb')
    const invalidPosts: Array<{ label: string; body: unknown; status: number; code: string }> = [
      { label: 'missing username', body: omit(valid, 'username'), status: 422, code: 'VALIDATION' },
      { label: 'missing acl', body: omit(valid, 'acl'), status: 422, code: 'VALIDATION' },
      { label: 'unknown acl', body: { ...valid, acl: ['not-an-acl'] }, status: 422, code: 'VALIDATION' },
      { label: 'acl not a list', body: { ...valid, acl: 'list-accounts' }, status: 422, code: 'VALIDATION' },
      { label: 'negative account cap', body: { ...valid, maxAccounts: -1 }, status: 422, code: 'VALIDATION' },
      { label: 'negative disk total', body: { ...valid, totalDiskMb: -5 }, status: 422, code: 'VALIDATION' },
      { label: 'non-boolean oversell', body: { ...valid, oversell: 'yes' }, status: 422, code: 'VALIDATION' },
      { label: 'malformed nameserver', body: { ...valid, nameservers: ['bad host'] }, status: 422, code: 'VALIDATION' },
      { label: 'cidr delegated ip', body: { ...valid, delegatedIps: ['192.0.2.42/24'] }, status: 422, code: 'VALIDATION' },
      { label: 'malformed password hash', body: { ...valid, passwordHash: 'not-a-hash' }, status: 422, code: 'VALIDATION' },
      { label: 'password and hash', body: { ...valid, password: 'SyntheticPass!2026' }, status: 422, code: 'VALIDATION' },
      { label: 'non-object array body', body: [], status: 422, code: 'VALIDATION' },
      { label: 'null body', body: null, status: 422, code: 'VALIDATION' },
      { label: 'duplicate reseller username', body: resellerDraft('valida'), status: 409, code: 'CONFLICT' },
    ]
    for (const { label, body, status, code } of invalidPosts) {
      const response = await f.call('/api/resellers', 'POST', body, f.rootSession)
      const text = await response.text()
      expect(response.status, `${label}: ${text}`).toBe(status)
      expect((JSON.parse(text) as Problem).code, label).toBe(code)
    }
    const invalidPatches: Array<{ label: string; body: unknown }> = [
      { label: 'unknown acl', body: { acl: ['not-an-acl'] } },
      { label: 'negative account cap', body: { maxAccounts: -1 } },
      { label: 'negative disk total', body: { totalDiskMb: -5 } },
      { label: 'non-boolean oversell', body: { oversell: 'yes' } },
      { label: 'malformed nameserver', body: { nameservers: ['bad host'] } },
      { label: 'cidr delegated ip', body: { delegatedIps: ['192.0.2.42/24'] } },
      { label: 'array body', body: [] },
    ]
    for (const { label, body } of invalidPatches) {
      const response = await f.call(`/api/resellers/${created.id}`, 'PATCH', body, f.rootSession)
      const text = await response.text()
      expect(response.status, `${label}: ${text}`).toBe(422)
      expect((JSON.parse(text) as Problem).code, label).toBe('VALIDATION')
    }
    const unknown = await f.call(`/api/resellers/${randomUUID()}`, 'PATCH', { maxAccounts: 5 }, f.rootSession)
    expect(unknown.status).toBe(404)
    expect((await f.problemOf(unknown)).code).toBe('NOT_FOUND')

    expect(await f.state.store.listResellers()).toEqual(before)
    expect(await f.state.store.getReseller(created.id)).toEqual(created)
    expect((await f.auditRows('reseller.created')).length).toBe(createdAudits)
    expect(await f.auditRows('reseller.updated')).toEqual([])
  })

  it('does not persist unknown reseller properties or silently apply a rename', async () => {
    // The route validates every known reseller field through the StateStore but ignores
    // unlisted properties rather than refusing the body; assert that real, non-escalating
    // behavior (and never claim a rejection the server does not perform).
    const response = await f.call('/api/resellers', 'POST', {
      ...resellerDraft('unknowna'),
      escalate: true,
      ownerId: randomUUID(),
      extraAcl: ['change-password'],
    }, f.rootSession)
    const text = await response.text()
    expect(response.status, `unknown fields: ${text}`).toBe(201)
    const created = (JSON.parse(text) as { reseller: ResellerView }).reseller
    const stored = await f.state.store.getReseller(created.id)
    expect(stored).not.toBeNull()
    expect(Object.keys(stored!).sort()).toEqual([...RESELLER_KEYS].sort())
    expect(stored).not.toHaveProperty('escalate')
    expect(stored).not.toHaveProperty('ownerId')
    expect(stored).not.toHaveProperty('extraAcl')
    expect(created).toEqual(stored)

    const patched = await f.call(`/api/resellers/${created.id}`, 'PATCH', { username: 'renamed', escalate: true }, f.rootSession)
    const patchedText = await patched.text()
    expect(patched.status, patchedText).toBe(200)
    expect((JSON.parse(patchedText) as { reseller: ResellerView }).reseller).toEqual(stored)
    expect((await f.state.store.getReseller(created.id))?.username).toBe('unknowna')
  })

  it('refuses reseller administration writes from a reseller session without mutation', async () => {
    const reseller = await f.createReseller('resa')
    const session = await f.login('resa')
    const before = await f.state.store.listResellers()
    for (const attempt of [
      await f.call('/api/resellers', 'POST', resellerDraft('resb'), session),
      await f.call(`/api/resellers/${reseller.id}`, 'PATCH', { maxAccounts: 'unlimited', acl: ['change-password', 'list-accounts'] }, session),
      await f.call(`/api/resellers/${reseller.id}`, 'DELETE', undefined, session),
    ]) {
      const text = await attempt.text()
      expect(attempt.status, text).toBe(403)
      expect((JSON.parse(text) as Problem).code).toBe('FORBIDDEN')
    }
    expect(await f.state.store.listResellers()).toEqual(before)
    expect(await f.state.store.getReseller(reseller.id)).toEqual(reseller)
    expect(await f.auditRows('reseller.created')).toHaveLength(1)
    expect(await f.auditRows('reseller.updated')).toEqual([])
    expect(await f.auditRows('reseller.deleted')).toEqual([])
  })

  it('refuses reseller administration for a hosting-user session and records the list denial', async () => {
    const reseller = await f.createReseller('resx')
    const session = await f.login('rootown9')
    expect(session.principal).toMatchObject({ kind: 'user', accountId: f.rootOwned.id })
    const before = await f.state.store.listResellers()
    const deniedBefore = (await f.auditRows('rbac.denied')).length

    const list = await f.call('/api/resellers', 'GET', undefined, session)
    expect(list.status).toBe(403)
    expect((await f.problemOf(list)).code).toBe('FORBIDDEN')
    const denied = (await f.auditRows('rbac.denied')).slice(deniedBefore)
    expect(denied).toHaveLength(1)
    expect(denied[0]).toMatchObject({ actor: 'rootown9', principal_id: f.userPrincipal.id, action: 'rbac.denied', target: 'resellers.list', outcome: 'denied' })

    const post = await f.call('/api/resellers', 'POST', resellerDraft('resy'), session)
    expect(post.status).toBe(403)
    expect((await f.problemOf(post)).code).toBe('FORBIDDEN')
    const patch = await f.call(`/api/resellers/${reseller.id}`, 'PATCH', { maxAccounts: 99 }, session)
    expect(patch.status).toBe(403)
    expect((await f.problemOf(patch)).code).toBe('FORBIDDEN')

    expect(await f.state.store.listResellers()).toEqual(before)
    expect(await f.auditRows('reseller.created')).toHaveLength(1)
    expect(await f.auditRows('reseller.updated')).toEqual([])
  })

  it('rejects state-changing reseller requests without a valid CSRF token', async () => {
    const wrong = await f.call('/api/resellers', 'POST', resellerDraft('csrfx'), f.rootSession, { csrf: 'b'.repeat(64) })
    const wrongProblem = await f.problemOf(wrong)
    expect(wrong.status).toBe(403)
    expect(wrongProblem.code).toBe('FORBIDDEN')
    expect(wrongProblem.detail).toContain('CSRF')
    const missing = await f.call('/api/resellers', 'POST', resellerDraft('csrfy'), f.rootSession, { csrf: null })
    expect(missing.status).toBe(403)
    expect((await f.problemOf(missing)).code).toBe('FORBIDDEN')
    expect(await f.state.store.listResellers()).toEqual([])
    expect(await f.auditRows('reseller.created')).toEqual([])
    expect(await f.auditRows('auth.csrf_rejected')).toHaveLength(2)
  })
})

describe('real HTTP reseller-owned account scope', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })

  it('scopes GET /api/accounts to each reseller current ownership', async () => {
    const a = await f.createReseller('scopea')
    const b = await f.createReseller('scopeb')
    const aOwned = await f.seedAccount('scopea1', a.id)
    const bOwned = await f.seedAccount('scopeb1', b.id)
    const rootView = await f.accountsOf(f.rootSession)
    expect(rootView.map(item => item.username).sort()).toEqual(['rootown9', 'scopea1', 'scopeb1'])
    expect(rootView.find(item => item.id === aOwned.id)?.ownerId).toBe(a.id)
    expect(rootView.find(item => item.id === bOwned.id)?.ownerId).toBe(b.id)

    const aView = await f.accountsOf(await f.login('scopea'))
    expect(aView.map(item => item.id)).toEqual([aOwned.id])
    expect(JSON.stringify(aView)).not.toContain('scopeb1')
    expect(JSON.stringify(aView)).not.toContain('rootown9')
    const bView = await f.accountsOf(await f.login('scopeb'))
    expect(bView.map(item => item.id)).toEqual([bOwned.id])
    expect((await f.state.store.listAccounts({ ownerId: a.id })).map(item => item.id)).toEqual([aOwned.id])
    expect((await f.state.store.listAccounts({ ownerId: b.id })).map(item => item.id)).toEqual([bOwned.id])
  })

  it('hides foreign reseller-owned accounts behind NOT_FOUND and refuses their mutation', async () => {
    const a = await f.createReseller('foreigna')
    const b = await f.createReseller('foreignb')
    const own = await f.seedAccount('foreigna1', a.id)
    const foreign = await f.seedAccount('foreignb1', b.id)
    const session = await f.login('foreigna')

    const ownRead = await f.call(`/api/accounts/${own.id}`, 'GET', undefined, session)
    const ownText = await ownRead.text()
    expect(ownRead.status, ownText).toBe(200)
    expect((JSON.parse(ownText) as { account: AccountView }).account.id).toBe(own.id)
    for (const target of [foreign.id, randomUUID()]) {
      const read = await f.call(`/api/accounts/${target}`, 'GET', undefined, session)
      expect(read.status).toBe(404)
      expect((await f.problemOf(read)).code).toBe('NOT_FOUND')
    }
    const foreignBefore = await f.state.store.getAccount(foreign.id)
    const mutation = await f.call(`/api/accounts/${foreign.id}`, 'PATCH', { contactEmail: 'attacker@example.test' }, session)
    expect(mutation.status).toBe(404)
    expect((await f.problemOf(mutation)).code).toBe('NOT_FOUND')
    expect(await f.state.store.getAccount(foreign.id)).toEqual(foreignBefore)
    expect((await f.state.store.getAccount(own.id))?.ownerId).toBe(a.id)
  })

  it('binds a reseller-created account to the reseller and ignores a foreign ownerId', async () => {
    const reseller = await f.createReseller('spawna', { acl: ['list-accounts', 'create-account'] })
    const session = await f.login('spawna')
    const response = await f.call('/api/accounts', 'POST', f.accountDraft('spawna1', { ownerId: null }), session)
    const text = await response.text()
    expect(response.status, text).toBe(201)
    const ack = JSON.parse(text) as AccountAck
    expect(ack.account).toMatchObject({ username: 'spawna1', ownerId: reseller.id })
    // The real agent contract acknowledged a global configuration apply; this is not native proof.
    expect(ack.reconcile?.status).toBe('applied')
    expect(ack.execution).toMatchObject({ status: 'configuration_applied', scope: 'global_configuration' })
    const persisted = await f.state.store.getAccountByUsername('spawna1')
    expect(persisted?.ownerId).toBe(reseller.id)
    expect(await findPrincipalByUsername(f.database.db, 'spawna1')).toMatchObject({ kind: 'user', accountId: persisted!.id })
    expect((await f.accountsOf(session)).map(item => item.id)).toEqual([persisted!.id])
    expect(await f.auditRows('account.desired.created')).toHaveLength(1)
  })

  it('refuses account creation over the reseller account cap without creating state', async () => {
    const reseller = await f.createReseller('capa', { maxAccounts: 1 })
    await f.seedAccount('capa1', reseller.id)
    const session = await f.login('capa')
    const accountsBefore = await f.state.store.listAccounts()
    const response = await f.call('/api/accounts', 'POST', f.accountDraft('capa2'), session)
    const text = await response.text()
    expect(response.status, `cap: ${text}`).toBe(422)
    expect((JSON.parse(text) as Problem).code).toBe('LIMIT_EXCEEDED')
    expect(await f.state.store.getAccountByUsername('capa2')).toBeNull()
    expect(await findPrincipalByUsername(f.database.db, 'capa2')).toBeNull()
    expect(await f.state.store.listAccounts()).toEqual(accountsBefore)
    expect(await f.auditRows('account.desired.created')).toEqual([])
  })

  it('refuses account creation that would oversell the reseller disk total without creating state', async () => {
    const reseller = await f.createReseller('diska', { totalDiskMb: 500, totalBandwidthMb: 20000 })
    const session = await f.login('diska')
    const accountsBefore = await f.state.store.listAccounts()
    const response = await f.call('/api/accounts', 'POST', f.accountDraft('diska1'), session)
    const text = await response.text()
    expect(response.status, `disk: ${text}`).toBe(422)
    expect((JSON.parse(text) as Problem).code).toBe('OVERSELL_BLOCKED')
    expect(await f.state.store.getAccountByUsername('diska1')).toBeNull()
    expect(await findPrincipalByUsername(f.database.db, 'diska1')).toBeNull()
    expect(await f.state.store.listAccounts()).toEqual(accountsBefore)
    expect(await f.auditRows('account.desired.created')).toEqual([])
  })

  it('refuses a plan that another reseller owns', async () => {
    const a = await f.createReseller('plana')
    const b = await f.createReseller('planb')
    const foreignPlan = await f.createPlan('Plan B owned', b.id)
    const session = await f.login('plana')
    const accountsBefore = await f.state.store.listAccounts()
    const response = await f.call('/api/accounts', 'POST', f.accountDraft('plana1', { planId: foreignPlan.id }), session)
    const text = await response.text()
    expect(response.status, `plan owner: ${text}`).toBe(403)
    expect((JSON.parse(text) as Problem).code).toBe('FORBIDDEN')
    expect(await f.state.store.getAccountByUsername('plana1')).toBeNull()
    expect(await f.state.store.listAccounts()).toEqual(accountsBefore)
  })

  it('re-applies root ACL changes so a reseller gains and then loses account creation', async () => {
    const reseller = await f.createReseller('acla', { acl: ['list-accounts'] })
    const session = await f.login('acla')
    const denied = await f.call('/api/accounts', 'POST', f.accountDraft('acla1'), session)
    expect(denied.status).toBe(403)
    expect((await f.problemOf(denied)).code).toBe('FORBIDDEN')

    const grant = await f.call(`/api/resellers/${reseller.id}`, 'PATCH', { acl: ['list-accounts', 'create-account'] }, f.rootSession)
    const grantText = await grant.text()
    expect(grant.status, grantText).toBe(200)
    expect((JSON.parse(grantText) as { reseller: ResellerView }).reseller.acl).toEqual(sortedAcl(['list-accounts', 'create-account']))
    expect((await f.state.store.getReseller(reseller.id))?.acl).toEqual(sortedAcl(['list-accounts', 'create-account']))
    const created = await f.call('/api/accounts', 'POST', f.accountDraft('acla1'), session)
    const createdText = await created.text()
    expect(created.status, createdText).toBe(201)
    expect((JSON.parse(createdText) as AccountAck).account.ownerId).toBe(reseller.id)

    const revoke = await f.call(`/api/resellers/${reseller.id}`, 'PATCH', { acl: ['list-accounts'] }, f.rootSession)
    const revokeText = await revoke.text()
    expect(revoke.status, revokeText).toBe(200)
    expect((await f.state.store.getReseller(reseller.id))?.acl).toEqual(['list-accounts'])
    const deniedAgain = await f.call('/api/accounts', 'POST', f.accountDraft('acla2'), session)
    expect(deniedAgain.status).toBe(403)
    expect((await f.problemOf(deniedAgain)).code).toBe('FORBIDDEN')
    expect(await f.state.store.getAccountByUsername('acla2')).toBeNull()
    expect((await f.auditRows('reseller.updated')).length).toBe(2)
  })

  it('refuses a root-only account owner change by a reseller and records the denial', async () => {
    const reseller = await f.createReseller('owna')
    const owned = await f.seedAccount('owna1', reseller.id)
    const session = await f.login('owna')
    const deniedBefore = (await f.auditRows('rbac.denied')).length
    const updatedBefore = (await f.auditRows('account.desired.updated')).length
    const response = await f.call(`/api/accounts/${owned.id}`, 'PATCH', { ownerId: null }, session)
    const text = await response.text()
    expect(response.status, text).toBe(403)
    expect((JSON.parse(text) as Problem).code).toBe('FORBIDDEN')
    expect((await f.state.store.getAccount(owned.id))?.ownerId).toBe(reseller.id)
    const denied = (await f.auditRows('rbac.denied')).slice(deniedBefore)
    expect(denied).toHaveLength(1)
    expect(denied[0]).toMatchObject({ actor: 'owna', target: 'account.change_owner', outcome: 'denied' })
    expect((await f.auditRows('account.desired.updated')).length).toBe(updatedBefore)
  })

  it('refuses a foreign or undelegated IPv4 and in-use delegated IP removal', async () => {
    const reseller = await f.createReseller('ipa', { delegatedIps: ['192.0.2.42'] })
    const owned = await f.seedAccount('ipa1', reseller.id, { ipv4: '192.0.2.42' })
    const session = await f.login('ipa')
    const undelegated = await f.call('/api/accounts', 'POST', f.accountDraft('ipa2', { ipv4: '192.0.2.77' }), session)
    const undelegatedText = await undelegated.text()
    expect(undelegated.status, undelegatedText).toBe(403)
    expect((JSON.parse(undelegatedText) as Problem).code).toBe('FORBIDDEN')
    expect(await f.state.store.getAccountByUsername('ipa2')).toBeNull()

    const removed = await f.call(`/api/resellers/${reseller.id}`, 'PATCH', { delegatedIps: [] }, f.rootSession)
    const removedText = await removed.text()
    expect(removed.status, removedText).toBe(403)
    expect((JSON.parse(removedText) as Problem).code).toBe('FORBIDDEN')
    const after = await f.state.store.getReseller(reseller.id)
    expect(after?.delegatedIps).toEqual(['192.0.2.42'])
    expect((await f.state.store.getAccount(owned.id))?.ipv4).toBe('192.0.2.42')
  })

  it('refuses plan upgrades beyond the reseller allocation and without the change-plan ACL', async () => {
    const reseller = await f.createReseller('planup', { acl: ['list-accounts', 'edit-account'], totalDiskMb: 1500, totalBandwidthMb: 20000 })
    const owned = await f.seedAccount('planup1', reseller.id)
    const biggerPlan = await f.createPlan('Bigger plan', null, { diskMb: 2000 })
    const session = await f.login('planup')
    const updatedBefore = (await f.auditRows('account.desired.updated')).length

    const noAcl = await f.call(`/api/accounts/${owned.id}`, 'PATCH', { planId: biggerPlan.id }, session)
    expect(noAcl.status).toBe(403)
    expect((await f.problemOf(noAcl)).code).toBe('FORBIDDEN')
    expect((await f.state.store.getAccount(owned.id))?.planId).toBe(f.plan.id)

    const grant = await f.call(`/api/resellers/${reseller.id}`, 'PATCH', { acl: ['list-accounts', 'edit-account', 'change-plan'] }, f.rootSession)
    const grantText = await grant.text()
    expect(grant.status, grantText).toBe(200)
    const oversell = await f.call(`/api/accounts/${owned.id}`, 'PATCH', { planId: biggerPlan.id }, session)
    const oversellText = await oversell.text()
    expect(oversell.status, oversellText).toBe(422)
    expect((JSON.parse(oversellText) as Problem).code).toBe('OVERSELL_BLOCKED')
    expect((await f.state.store.getAccount(owned.id))?.planId).toBe(f.plan.id)
    expect((await f.auditRows('account.desired.updated')).length).toBe(updatedBefore)
  })
})
