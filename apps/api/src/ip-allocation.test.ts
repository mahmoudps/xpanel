import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiToken, createResellerPrincipal, createRootPrincipal, createSession, createTestDb, createUserPrincipal, findPrincipalByUsername, listAudit, setTotpSecret } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import type { AgentApp } from '@xpanel/agent'
import type { ServerIpEntry } from '@xpanel/core'
import { WRITER_MUTEX_FILE } from '../../../packages/state/src/writer-mutex.ts'
import { authenticateRequest, deriveCsrfToken } from './auth.ts'
import { sessionCookieName, sessionTokenHash } from './entry-points.ts'
import type { EntryPoint } from './entry-points.ts'
import { createApiApp, INGRESS_SECRET_HEADER } from './server.ts'

// These are isolated router/state diagnostics. The agent below is a synthetic
// configuration receipt, never evidence that an address is bound on a host.
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const SECRET = 'ip-allocation-synthetic-server-secret-32-bytes'
const INGRESS = 'ip-allocation-synthetic-ingress-secret-32-bytes'
const ORIGIN = 'https://whm.example.test:2087'
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
const fixture = async () => {
  const database = await createTestDb(), state = await createTestStateStore()
  cleanup.push(() => database.close(), () => state.close())
  const feature = await state.store.createFeatureList({ name: 'IP router diagnostics', ownerId: null, disabled: [] })
  const planInput = { name: 'IP router plan', ownerId: null, featureListId: feature.id,
    resources: { diskMb: 1024, bandwidthMbMonth: 10240, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 2, aliasDomains: 2, subdomains: 2, mailboxes: 2, forwarders: 2, mailingLists: 2, ftpAccounts: 2, databases: 2, phpWorkers: 2 }, dedicatedIp: true, shell: 'none' as const, defaultMailboxQuotaMb: 128 }
  const plan = await state.store.createPlan(planInput)
  const noDedicated = await state.store.createPlan({ ...planInput, name: 'Shared-only plan', dedicatedIp: false })
  const resellerInput = { passwordHash: HASH, acl: ['create-account', 'list-accounts'] as ('create-account' | 'list-accounts')[], maxAccounts: 10, totalDiskMb: 100000, totalBandwidthMb: 'unlimited' as const, oversell: false, nameservers: [], delegatedIps: [] }
  const reseller = await state.store.createReseller({ ...resellerInput, username: 'resellerip' })
  const neighbor = await state.store.createReseller({ ...resellerInput, username: 'neighborip' })
  const neighborPlan = await state.store.createPlan({ ...planInput, name: 'Neighbor plan', ownerId: neighbor.id })
  const pool = async (address: string, over: Partial<ServerIpEntry> = {}) => state.store.saveServerIp({ address, version: 4, prefixLength: 24, interfaceName: 'test0', role: 'dedicated', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: false, notes: '', ...over })
  const shared = await pool('192.0.2.10', { role: 'shared', isPrimary: true })
  const dedicated = await pool('192.0.2.11')
  const ownDedicated = await pool('192.0.2.12', { ownerKind: 'reseller', ownerId: reseller.id })
  const neighborDedicated = await pool('192.0.2.13', { ownerKind: 'reseller', ownerId: neighbor.id })
  const mail = await pool('192.0.2.14', { role: 'mail' })
  const root = await createRootPrincipal(database.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })
  await setTotpSecret(database.db, root.id, new Uint8Array(32))
  const resellerPrincipal = await createResellerPrincipal(database.db, { id: reseller.id, username: reseller.username, passwordHash: HASH })
  await setTotpSecret(database.db, resellerPrincipal.id, new Uint8Array(32))
  const session = async (principalId: string, audience: EntryPoint = 'xwhm', mfaVerified = true) => {
    const token = 'test-ip-session-' + randomUUID()
    await createSession(database.db, { principalId, tokenHash: sessionTokenHash(token, audience), expiresAt: new Date(Date.now() + 600000).toISOString(), mfaVerified })
    return { cookie: sessionCookieName(audience, true) + '=' + token, csrf: deriveCsrfToken(token, SECRET, audience) }
  }
  const rootSession = await session(root.id), resellerSession = await session(resellerPrincipal.id)
  expect(await authenticateRequest(database.db, new Request(ORIGIN + '/api/auth/me', { headers: { cookie: rootSession.cookie } }), { serverSecret: SECRET, entryPoint: 'xwhm', touchSession: false })).not.toBeNull()
  let agentCalls = 0
  const agentApp: AgentApp = { subscribe: () => () => {}, fetch: async request => {
    expect(new URL(request.url).pathname).toBe('/state/apply')
    agentCalls++
    return Response.json({ status: 'applied', generation: { id: 1, createdAt: '2026-10-23T00:00:00Z', status: 'active', checksum: 'a'.repeat(64), error: null, actor: 'root', testedAt: '2026-10-23T00:00:00Z', activatedAt: '2026-10-23T00:00:00Z' }, filesCount: 2, durationMs: 1 })
  } }
  const app = (audience: EntryPoint = 'xwhm') => createApiApp({ db: database.db, store: state.store, serverSecret: SECRET, entryPoint: audience, publicOrigin: ORIGIN, allowedOrigins: [ORIGIN], ingressSecret: INGRESS, requireSecureCookies: true, requireOriginHeader: true, agentApp, agentToken: 'a'.repeat(64) })
  const main = app()
  const tokenApp = createApiApp({ db: database.db, store: state.store, serverSecret: SECRET, publicOrigin: ORIGIN, allowedOrigins: [ORIGIN], ingressSecret: INGRESS, requireSecureCookies: true, requireOriginHeader: true, agentApp, agentToken: 'a'.repeat(64) })
  const request = (method: string, path: string, body?: unknown, options: { session?: typeof rootSession; csrf?: string; origin?: string; bearer?: string; audience?: EntryPoint } = {}) => {
    const auth = options.session ?? rootSession
    return (options.bearer ? tokenApp : options.audience ? app(options.audience) : main).fetch(new Request(ORIGIN + path, { method, headers: {
      'content-type': 'application/json', origin: options.origin ?? ORIGIN,
      ...(options.bearer ? { authorization: 'Bearer ' + options.bearer } : { cookie: auth.cookie, 'x-csrf-token': options.csrf ?? auth.csrf }),
      [INGRESS_SECRET_HEADER]: INGRESS, 'x-forwarded-proto': 'https', 'x-forwarded-for': '192.0.2.20',
    }, ...(body !== undefined && { body: JSON.stringify(body) }) }), { remoteAddress: '127.0.0.1' })
  }
  const input = (username: string, over: Record<string, unknown> = {}) => ({ username, primaryDomain: username + '.example.test', planId: plan.id, passwordHash: HASH,
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 100, processIdleTimeoutSec: 10 }, ini: {} }, ...over })
  const fingerprint = async () => {
    const files: [string, string][] = [], operational = new Set(['', '-wal', '-shm', '-journal'].map(suffix => WRITER_MUTEX_FILE + suffix))
    const visit = async (dir: string): Promise<void> => { for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (dir === state.rootDir && operational.has(entry.name)) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) files.push([relative(state.rootDir, path), createHash('sha256').update(await readFile(path)).digest('hex')])
    } }
    await visit(state.rootDir)
    return files.sort(([a], [b]) => a.localeCompare(b))
  }
  const effects = async () => ({ snapshot: await state.store.readSnapshot(),
    principals: await database.db.query('SELECT id, username, kind, account_id, disabled FROM principals ORDER BY id'),
    success: (await listAudit(database.db, { limit: 1000 })).filter(row => row.outcome === 'ok' && /^(account\.|ip\.)/.test(row.action)), agentCalls })
  return { database, state, plan, noDedicated, reseller, neighbor, neighborPlan, shared, dedicated, ownDedicated, neighborDedicated, mail, root, resellerPrincipal, rootSession, resellerSession, session, pool, app, request, input, fingerprint, effects, calls: () => agentCalls }
}

describe('IP API router and desired-state allocation diagnostics', () => {
  it('passes a specific dedicated selection to the leased allocator instead of silently using shared IPv4', async () => {
    const f = await fixture()
    const response = await f.request('POST', '/api/accounts', f.input('specificip', { ipAssignment: { mode: 'dedicated', poolId: f.dedicated.id } }))
    expect(response.status, await response.clone().text()).toBe(201)
    const body = await response.json() as { account: { id: string; ipv4: string } }
    expect(body.account.ipv4).toBe(f.dedicated.address)
    expect((await f.state.store.getAccount(body.account.id))?.ipv4).toBe(f.dedicated.address)
    expect(f.calls()).toBe(1)
  })

  it.each([undefined, { mode: 'shared' }])('uses the persisted shared default for %j', async ipAssignment => {
    const f = await fixture()
    const response = await f.request('POST', '/api/accounts', f.input('sharedip', ipAssignment === undefined ? {} : { ipAssignment }))
    expect(response.status).toBe(201)
    const body = await response.json() as { account: { id: string; ipv4: string } }
    expect(body.account.ipv4).toBe(f.shared.address)
    expect(await findPrincipalByUsername(f.database.db, 'sharedip')).toMatchObject({ kind: 'user', accountId: body.account.id })
    expect((await f.state.store.listDomains({ accountId: body.account.id }))[0]?.accountId).toBe(body.account.id)
  })

  it('selects an unallocated dedicated IPv4 without an API-side primary fallback', async () => {
    const f = await fixture()
    const response = await f.request('POST', '/api/accounts', f.input('automaticip', { ipAssignment: { mode: 'dedicated' } }))
    expect(response.status).toBe(201)
    expect((await response.json() as { account: { ipv4: string } }).account.ipv4).toBe(f.dedicated.address)
  })

  it.each(['shared', 'dedicated'] as const)('returns an explicit 412 when the desired-state %s choice is unavailable', async mode => {
    const f = await fixture()
    if (mode === 'shared') await f.state.store.saveServerIp({ ...f.shared, isPrimary: false })
    else await f.state.store.deleteServerIp(f.dedicated.id)
    const before = await f.effects()
    const response = await f.request('POST', '/api/accounts', f.input('exhaustedip', { ipAssignment: { mode } }))
    expect(response.status).toBe(412)
    expect((await response.json() as { details: unknown }).details).toMatchObject({ reason: mode + '_ipv4_unavailable', stateChanged: false })
    expect(await f.effects()).toEqual(before)
  })

  it.each([
    { ipAssignment: { mode: 'other' } }, { ipAssignment: null }, { ipAssignment: [] },
    { ipAssignment: { mode: 'shared', poolId: 'unexpected' } },
    { ipAssignment: { mode: 'dedicated', poolId: null } },
    { ipAssignment: { mode: 'dedicated', poolId: 'not-a-uuid' } },
    { ipAssignment: { mode: 'dedicated', unknown: true } },
    { ipAssignment: { mode: 'shared' }, ipv4: '192.0.2.10' },
  ])('rejects invalid or mixed selectors before account, identity, agent or success-audit effects: %j', async over => {
    const f = await fixture(), before = await f.effects()
    const response = await f.request('POST', '/api/accounts', f.input('invalidip', over))
    expect(response.status).toBe(422)
    expect(await f.effects()).toEqual(before)
  })

  it.each(['unentitled', 'neighbor', 'mail', 'unknown', 'nondelegated'] as const)('rejects %s allocation without effects', async condition => {
    const f = await fixture(), before = await f.effects()
    const over = { ipAssignment: { mode: 'dedicated', poolId: condition === 'neighbor' ? f.neighborDedicated.id : condition === 'mail' ? f.mail.id : condition === 'unknown' ? randomUUID() : f.dedicated.id },
      ...(condition === 'unentitled' && { planId: f.noDedicated.id }) }
    const response = await f.request('POST', '/api/accounts', f.input('deniedip', over), condition === 'nondelegated' ? { session: f.resellerSession } : {})
    expect(response.status).toBe(403)
    expect(await f.effects()).toEqual(before)
  })

  it('forces the reseller owner even when the request supplies another owner', async () => {
    const f = await fixture()
    const response = await f.request('POST', '/api/accounts', f.input('reselleripone', { ownerId: f.neighbor.id, ipAssignment: { mode: 'dedicated', poolId: f.ownDedicated.id } }), { session: f.resellerSession })
    expect(response.status).toBe(201)
    expect((await response.json() as { account: { ownerId: string; ipv4: string } }).account).toMatchObject({ ownerId: f.reseller.id, ipv4: f.ownDedicated.address })
  })

  it('returns 409 for an already reserved dedicated selection without creating another account', async () => {
    const f = await fixture()
    expect((await f.request('POST', '/api/accounts', f.input('firstip', { ipAssignment: { mode: 'dedicated', poolId: f.dedicated.id } }))).status).toBe(201)
    const before = await f.effects()
    expect((await f.request('POST', '/api/accounts', f.input('secondip', { ipAssignment: { mode: 'dedicated', poolId: f.dedicated.id } }))).status).toBe(409)
    expect(await f.effects()).toEqual(before)
  })

  it('keeps exactly one account reservation when two API creates race for one dedicated entry', async () => {
    const f = await fixture()
    const responses = await Promise.all(['raceipone', 'raceiptwo'].map(username => f.request('POST', '/api/accounts', f.input(username, { ipAssignment: { mode: 'dedicated', poolId: f.dedicated.id } }))))
    expect(responses.map(response => response.status).sort()).toEqual([201, 409])
    expect((await f.state.store.listAccounts()).filter(account => account.ipv4 === f.dedicated.address)).toHaveLength(1)
    expect(f.calls()).toBe(1)
  })

  it.each(['csrf', 'origin', 'scope', 'mfa'] as const)('preserves %s rejection before all allocation effects', async condition => {
    const f = await fixture(), before = await f.effects()
    let options: Parameters<typeof f.request>[3] = condition === 'csrf' ? { csrf: 'wrong' } : condition === 'origin' ? { origin: 'https://foreign.example.test' } : {}
    if (condition === 'scope') {
      const token = 'test-readonly-ip-token'
      await createApiToken(f.database.db, { principalId: f.root.id, name: 'Synthetic read-only', tokenHash: createHash('sha256').update(token).digest('hex'), scopes: ['accounts:read'], expiresAt: new Date(Date.now() + 600000).toISOString() })
      options = { bearer: token }
    }
    if (condition === 'mfa') options = { session: await f.session(f.root.id, 'xwhm', false) }
    expect((await f.request('POST', '/api/accounts', f.input('securityip', { ipAssignment: { mode: 'dedicated' } }), options)).status).toBe(403)
    expect(await f.effects()).toEqual(before)
  })

  it.each(['xpanel', 'xmail'] as const)('does not expose IP management or create routes on %s', async audience => {
    const f = await fixture(), before = await f.effects()
    for (const [method, path, body] of [['GET', '/api/ips', undefined], ['POST', '/api/ips', { address: '192.0.2.90' }], ['POST', '/api/accounts', f.input('profileip')]] as const) {
      expect((await f.request(method, path, body, { audience })).status).toBe(404)
    }
    expect(await f.effects()).toEqual(before)
  })

  it('rejects a missing or non-string pool address as 422 without success effects', async () => {
    const f = await fixture(), before = await f.effects()
    for (const address of [undefined, null, 42, [], {}]) {
      expect((await f.request('POST', '/api/ips', address === undefined ? {} : { address })).status).toBe(422)
      expect(await f.effects()).toEqual(before)
    }
  })

  it('returns 404 for an absent pool ID and does not reconcile or audit successful deletion', async () => {
    const f = await fixture(), before = await f.effects()
    expect((await f.request('DELETE', '/api/ips/' + randomUUID())).status).toBe(404)
    expect(await f.effects()).toEqual(before)
  })

  it('keeps pool writes root-only even for a reseller with account creation ACL', async () => {
    const f = await fixture(), before = await f.effects()
    expect((await f.request('POST', '/api/ips', { address: '192.0.2.90' }, { session: f.resellerSession })).status).toBe(403)
    expect((await f.request('DELETE', '/api/ips/' + f.dedicated.id, undefined, { session: f.resellerSession })).status).toBe(403)
    expect(await f.effects()).toEqual(before)
  })

  it('denies account-owner and mailbox-scoped bearer administration through real authorization', async () => {
    const f = await fixture()
    const created = await f.request('POST', '/api/accounts', f.input('tenantbase'))
    expect(created.status).toBe(201)
    const principal = await findPrincipalByUsername(f.database.db, 'tenantbase')
    expect(principal).not.toBeNull()
    for (const mailbox of [false, true]) {
      const token = 'test-ip-' + (mailbox ? 'mailbox' : 'owner')
      await createApiToken(f.database.db, { principalId: principal!.id, name: 'Synthetic constrained principal', tokenHash: createHash('sha256').update(token).digest('hex'), scopes: mailbox ? ['*', 'mailbox:tenant:tenantbase.example.test'] : ['*'], expiresAt: new Date(Date.now() + 600000).toISOString() })
      const before = await f.effects()
      for (const [method, path, body] of [['POST', '/api/accounts', f.input('tenantdenied')], ['POST', '/api/ips', { address: '192.0.2.90' }], ['DELETE', '/api/ips/' + f.dedicated.id, undefined]] as const) {
        expect((await f.request(method, path, body, { bearer: token })).status).toBe(403)
      }
      expect(await f.effects()).toEqual(before)
    }
  })

  it('preserves successful root inventory save and unreferenced deletion metadata behavior', async () => {
    const f = await fixture()
    const saved = await f.request('POST', '/api/ips', { address: '192.0.2.90', role: 'dedicated' })
    expect(saved.status).toBe(201)
    const body = await saved.json() as { ip: { id: string } }
    expect((await f.request('DELETE', '/api/ips/' + body.ip.id)).status).toBe(200)
    expect((await f.state.store.listServerIps()).some(ip => ip.id === body.ip.id)).toBe(false)
    expect(f.calls()).toBe(2)
  })

  it('refuses deleting a reserved pool address and preserves state and success audit', async () => {
    const f = await fixture()
    expect((await f.request('POST', '/api/accounts', f.input('boundip', { ipAssignment: { mode: 'dedicated', poolId: f.dedicated.id } }))).status).toBe(201)
    const before = await f.effects()
    expect((await f.request('DELETE', '/api/ips/' + f.dedicated.id)).status).toBe(409)
    expect(await f.effects()).toEqual(before)
  })

  it('returns only the central nonissuing desired-state preview and keeps bare GET unchanged', async () => {
    const f = await fixture(), before = await f.fingerprint(), beforeEffects = await f.effects()
    const response = await f.request('GET', '/api/ips?view=allocation&planId=' + f.plan.id)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ scope: 'desired-state', hostBinding: 'unverified', defaultSharedIpv4: { poolId: f.shared.id, address: f.shared.address }, dedicated: { entitled: true, unallocated: [{ poolId: f.dedicated.id, address: f.dedicated.address, version: 4 }], count: 1 } })
    expect(await f.fingerprint()).toEqual(before)
    expect(await f.effects()).toEqual(beforeEffects)
    expect(await (await f.request('GET', '/api/ips')).json()).toEqual({ ips: await f.state.store.listServerIps() })
  })

  it('scopes the preview to the actual reseller and never reveals another owner’s pool', async () => {
    const f = await fixture(), before = await f.fingerprint()
    const response = await f.request('GET', '/api/ips?view=allocation&planId=' + f.plan.id, undefined, { session: f.resellerSession })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ scope: 'desired-state', hostBinding: 'unverified', defaultSharedIpv4: { poolId: f.shared.id, address: f.shared.address }, dedicated: { entitled: true, unallocated: [{ poolId: f.ownDedicated.id, address: f.ownDedicated.address, version: 4 }], count: 1 } })
    expect(await f.fingerprint()).toEqual(before)
  })

  it.each(['?view=other', '?view=allocation', '?view=allocation&planId=invalid', '?view=allocation&planId=', '?view=allocation&planId=PLAN&ownerId=', '?view=allocation&planId=PLAN&extra=1', '?view=allocation&view=allocation&planId=PLAN', '?view=allocation&planId=PLAN&planId=PLAN', '?planId=PLAN'])('rejects invalid or ambiguous preview query %s without writing', async query => {
    const f = await fixture(), before = await f.fingerprint(), beforeEffects = await f.effects()
    expect((await f.request('GET', '/api/ips' + query.replaceAll('PLAN', f.plan.id))).status).toBe(422)
    expect(await f.fingerprint()).toEqual(before)
    expect(await f.effects()).toEqual(beforeEffects)
  })

  it('denies mismatched preview owner and foreign plans while preserving the snapshot', async () => {
    const f = await fixture(), before = await f.fingerprint()
    for (const query of ['&ownerId=' + f.neighbor.id, '&ownerId=' + randomUUID()]) {
      expect((await f.request('GET', '/api/ips?view=allocation&planId=' + f.plan.id + query, undefined, { session: f.resellerSession })).status).toBe(403)
    }
    expect((await f.request('GET', '/api/ips?view=allocation&planId=' + f.neighborPlan.id, undefined, { session: f.resellerSession })).status).toBe(403)
    expect(await f.fingerprint()).toEqual(before)
  })

  it('validates root-selected preview owner and plan and reflects a completed reservation', async () => {
    const f = await fixture(), before = await f.fingerprint()
    const scoped = await f.request('GET', '/api/ips?view=allocation&planId=' + f.plan.id + '&ownerId=' + f.reseller.id)
    expect(scoped.status).toBe(200)
    expect((await scoped.json() as { dedicated: { unallocated: unknown[] } }).dedicated.unallocated).toEqual([{ poolId: f.ownDedicated.id, address: f.ownDedicated.address, version: 4 }])
    expect((await f.request('GET', '/api/ips?view=allocation&planId=' + f.plan.id + '&ownerId=' + randomUUID())).status).toBe(404)
    expect((await f.request('GET', '/api/ips?view=allocation&planId=' + randomUUID())).status).toBe(404)
    expect(await f.fingerprint()).toEqual(before)
    expect((await f.request('POST', '/api/accounts', f.input('previewbound', { ipAssignment: { mode: 'dedicated', poolId: f.dedicated.id } }))).status).toBe(201)
    const preview = await f.request('GET', '/api/ips?view=allocation&planId=' + f.plan.id)
    expect((await preview.json() as { dedicated: { count: number; unallocated: unknown[] } }).dedicated).toMatchObject({ count: 0, unallocated: [] })
  })
})
