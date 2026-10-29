import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiToken, createRootPrincipal, createSession, createTestDb, createUserPrincipal } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import type { CronJobState } from '@xpanel/state'
import { deriveCsrfToken, sha256Hex } from './auth.ts'
import { createApiApp, listenApiServer } from './server.ts'
import { CRON_WORKSPACE_MAX_JOBS } from './cron-workspace.ts'
import { createCronWorkspaceRoutes } from './cron-workspace.ts'
import { cronJobUnitId } from '@xpanel/core'
import type { CronJobObservationReceipt } from '@xpanel/core'
import { principalRecordToPrincipal } from './auth.ts'
import type { AuthenticatedCaller } from './auth.ts'

// Actual loopback HTTP with disposable state/database and synthetic credentials.
// Desired-state persistence is real; no host scheduler, process or email execution is claimed.
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const SECRET = 'cron-workspace-synthetic-server-secret'
const api = '/api/account/cron'
const cleanup: Array<() => Promise<unknown>> = []
interface Envelope { revision: string; jobs: Array<Omit<CronJobState, 'maxRuntimeSec'> & { maxRuntimeSec: number | null; onCalendar: string[] }>; application: { status: string; nativeApplied: boolean }; context: { accountId: string } }
const fixture = async () => {
  const database = await createTestDb(); cleanup.push(() => database.close())
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const featureList = await state.store.createFeatureList({ name: 'Cron fixture', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Cron fixture', ownerId: null, featureListId: featureList.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 4, forwarders: 4, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.55', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const account = (username: string) => state.store.createAccount({ username, passwordHash: HASH, primaryDomain: `${username}.example.test`, planId: plan.id, ownerId: null,
    contactEmail: `owner@${username}.example.test`, ipv4: '192.0.2.55', shell: 'none', php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  const owner = await account('crona'), other = await account('cronb')
  const principal = await createUserPrincipal(database.db, { username: owner.username, accountId: owner.id, passwordHash: HASH })
  const otherPrincipal = await createUserPrincipal(database.db, { username: other.username, accountId: other.id, passwordHash: HASH })
  const root = await createRootPrincipal(database.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })
  const token = async (principalId: string, scopes = ['cron:*']) => {
    const raw = 'xp_' + randomUUID()
    await createApiToken(database.db, { principalId, name: 'Synthetic cron', tokenHash: sha256Hex(raw), scopes, expiresAt: new Date(Date.now() + 60000).toISOString() })
    return raw
  }
  const ownerToken = await token(principal.id), otherToken = await token(otherPrincipal.id), rootToken = await token(root.id, ['*'])
  // Declared synthetic admission isolates persistence/auth tests; it certifies no host capability.
  const admission = vi.fn(async () => {})
  const app = createApiApp({ db: database.db, store: state.store, serverSecret: SECRET, admitCronMutation: admission })
  const server = await listenApiServer(app); cleanup.push(() => server.close())
  const request = (method = 'GET', body?: unknown, path = api, bearer: string | null = ownerToken, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${server.port}` + path,
    { method, headers: { ...(bearer ? { authorization: 'Bearer ' + bearer } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const read = async (bearer = ownerToken) => { const response = await request('GET', undefined, api, bearer); expect(response.status).toBe(200); return await response.json() as Envelope }
  const bytes = () => readFile(join(state.rootDir, 'accounts', owner.username, 'cron.json'), 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
  const draft = { schedule: '*/5 * * * *', command: '  printf "%s" "cron fixture"  ', comment: 'Synthetic scheduled work', enabled: true, maxRuntimeSec: 300 }
  const create = async () => { const response = await request('POST', { ...draft, expectedRevision: (await read()).revision }); expect(response.status).toBe(201); return await response.json() as Envelope }
  return { database, state, featureList, owner, other, principal, ownerToken, otherToken, rootToken, token, request, read, bytes, draft, create, admission }
}

describe('account cron real-loopback security acceptance', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })
  afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
  it('refuses persistence before writing when trusted qualification is absent', async () => {
    const app = createApiApp({ db: f.database.db, store: f.state.store, serverSecret: SECRET })
    const server = await listenApiServer(app); cleanup.push(() => server.close())
    const response = await fetch(`http://127.0.0.1:${server.port}` + api, { method: 'POST', headers: { authorization: 'Bearer ' + f.ownerToken, 'content-type': 'application/json' }, body: JSON.stringify({ ...f.draft, expectedRevision: (await f.read()).revision }) })
    expect(response.status).toBe(412); expect(await f.bytes()).toBeNull()
  })
  it('releases API preparation before the host broker reads its own snapshot and binds the accepted receipt', async () => {
    const created = await f.create(), target = created.jobs[0]!, nativeId = cronJobUnitId(target.id)
    const caller: AuthenticatedCaller = { principal: principalRecordToPrincipal(f.principal), principalRecord: f.principal, sessionId: null, sessionToken: null, apiTokenId: randomUUID(), scopes: ['cron:*'], csrfValid: true, mfaVerified: true }
    let preparing = false
    const broker = vi.fn(async (_caller: AuthenticatedCaller, intent: { accountId: string; jobId: string; expectedRevision: string }): Promise<CronJobObservationReceipt> => {
      expect(preparing).toBe(false)
      await f.state.store.readSnapshot() // Would reenter/deadlock if the API still owned its writer lease.
      return { context: { accountId: intent.accountId, jobId: intent.jobId }, revision: intent.expectedRevision, observation: { username: f.owner.username, jobId: nativeId, timerUnit: 'xpanel-cron-' + f.owner.username + '-' + nativeId + '.timer', serviceUnit: 'xpanel-cron-' + f.owner.username + '-' + nativeId + '.service', slice: 'xpanel-' + f.owner.uid + '.slice', timerActive: true, timerEnabled: true, serviceRunning: true, lastStartedAt: null, lastTriggerAt: null, nextRunAt: null, durationMs: null, lastExitCode: null, lastResult: 'unknown' } }
    })
    const route = createCronWorkspaceRoutes({ store: f.state.store, requireCaller: async () => caller, emitAudit: async () => {}, triggerReconcile: async () => { throw new Error('manual execution must not reconcile') }, admitCronMutation: f.admission,
      withCronAccountLease: (accountId, operation) => f.state.store.withCronAccountLease(accountId, async (account, jobs) => { preparing = true; try { return await operation(account, jobs) } finally { preparing = false } }), runCronNow: broker })
    const url = new URL('http://api.test' + api + '/' + target.id + '/run'), request = new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: created.revision, confirmation: target.command }) })
    const response = await route(request, url, 'POST'); expect(response?.status).toBe(202)
    expect(await response!.json()).toMatchObject({ status: 'accepted', requested: true, completed: false, context: { accountId: f.owner.id, jobId: target.id } })
    expect(broker).toHaveBeenCalledOnce(); expect(Object.keys(broker.mock.calls[0]![1]).sort()).toEqual(['accountId', 'expectedRevision', 'jobId'])
    expect((await f.read()).revision).toBe(created.revision)
  })

  it('reads an empty saved collection without allocating a job or writing configuration', async () => {
    expect(await f.bytes()).toBeNull()
    const first = await f.read(), second = await f.read()
    expect(first.jobs).toEqual([]); expect(first.context.accountId).toBe(f.owner.id); expect(second.revision).toBe(first.revision)
    expect(await f.bytes()).toBeNull()
    expect(first.application).toEqual({ status: 'configuration_only', nativeApplied: false })
  })
  it('keeps legacy unsupported schedules readable and removable without enabling unsupported execution', async () => {
    const id = randomUUID()
    await f.state.store.saveCronJobs(f.owner.id, [{ id, accountId: f.owner.id, schedule: '@reboot', command: 'echo legacy fixture', comment: 'Legacy schedule', enabled: true }])
    const current = await f.read()
    expect(current.jobs[0]).toMatchObject({ id, schedule: '@reboot', onCalendar: [], scheduleSupported: false })
    expect((await f.request('DELETE', { expectedRevision: current.revision, confirmation: 'echo legacy fixture' }, api + '/' + id)).status).toBe(200)
    expect((await f.read()).jobs).toEqual([])
  })
  it('creates a server-issued job, preserves the exact command/runtime and audits scoped persistence', async () => {
    const body = await f.create(), saved = body.jobs[0]!
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(saved).toMatchObject({ accountId: f.owner.id, ...f.draft })
    expect(saved.onCalendar).toEqual(['*-*-* *:00/5:00'])
    expect((await f.state.store.listCronJobs(f.owner.id))[0]).toMatchObject(f.draft)
    expect(await f.bytes()).not.toBeNull()
    expect((await f.read()).revision).toBe(body.revision)
    expect((await f.database.db.query('SELECT action FROM audit_log WHERE action = $1', ['cron.created'])).length).toBe(1)
  })
  it('edits a saved job, can disable its schedule and remove the runtime cap', async () => {
    const created = await f.create(), target = created.jobs[0]!
    const response = await f.request('PATCH', { expectedRevision: created.revision, enabled: false, maxRuntimeSec: null, command: ' printf "%s" "updated fixture" ' }, api + '/' + target.id)
    expect(response.status).toBe(200)
    const body = await response.json() as Envelope
    expect(body.jobs[0]).toMatchObject({ id: target.id, enabled: false, maxRuntimeSec: null, command: ' printf "%s" "updated fixture" ' })
    expect((await f.state.store.listCronJobs(f.owner.id))[0]).not.toHaveProperty('maxRuntimeSec')
  })
  it.each([
    ['unknown account selector', { accountId: 'foreign' }], ['injected identity', { id: randomUUID() }], ['UID injection', { uid: 0 }],
    ['shell injection', { shell: '/bin/bash' }], ['invalid schedule', { schedule: '@reboot' }], ['invalid command', { command: 'echo one\necho two' }],
    ['invalid enabled', { enabled: 'yes' }], ['invalid runtime', { maxRuntimeSec: 604801 }], ['null schedule', { schedule: null }],
  ])('refuses %s without source changes', async (_name, patch) => {
    const current = await f.create(), before = await f.bytes()
    const response = await f.request('PATCH', { expectedRevision: current.revision, ...patch }, api + '/' + current.jobs[0]!.id)
    expect(response.status).toBe(422); expect(await f.bytes()).toBe(before)
  })
  it('refuses stale writes and a write that loses its revision while waiting for the lease', async () => {
    const created = await f.create(), target = created.jobs[0]!, original = f.state.store.saveCronJobs.bind(f.state.store)
    vi.spyOn(f.state.store, 'saveCronJobs').mockImplementationOnce(async (accountId, jobs, options) => {
      await original(accountId, [{ ...target, maxRuntimeSec: 300, command: 'echo concurrent writer' }])
      return original(accountId, jobs, options)
    })
    const response = await f.request('PATCH', { expectedRevision: created.revision, command: 'echo stale writer' }, api + '/' + target.id)
    expect(response.status).toBe(409)
    const before = await f.bytes()
    expect((await f.request('DELETE', { expectedRevision: created.revision, confirmation: target.command }, api + '/' + target.id)).status).toBe(409)
    expect(await f.bytes()).toBe(before)
    expect((await f.state.store.listCronJobs(f.owner.id))[0]!.command).toBe('echo concurrent writer')
  })
  it('serializes two creates so one request consumes the revision and the other conflicts', async () => {
    const input = { ...f.draft, expectedRevision: (await f.read()).revision }
    const responses = await Promise.all([f.request('POST', input), f.request('POST', input)])
    expect(responses.map(response => response.status).sort()).toEqual([201, 409])
    expect((await f.state.store.listCronJobs(f.owner.id)).length).toBe(1)
  })
  it('rechecks account feature authorization under the writer lease', async () => {
    const current = await f.read(), original = f.state.store.saveCronJobs.bind(f.state.store)
    vi.spyOn(f.state.store, 'saveCronJobs').mockImplementationOnce(async (accountId, jobs, options) => {
      await f.state.store.updateFeatureList(f.featureList.id, { disabled: ['cron'] })
      return original(accountId, jobs, options)
    })
    const response = await f.request('POST', { ...f.draft, expectedRevision: current.revision })
    expect(response.status).toBe(403); expect(await f.bytes()).toBeNull()
  })
  it('deletes only after exact command confirmation, verifies absence and retains foreign jobs', async () => {
    const created = await f.create(), target = created.jobs[0]!
    await f.state.store.saveCronJobs(f.other.id, [{ id: randomUUID(), accountId: f.other.id, schedule: '@daily', command: 'echo other owner', comment: '', enabled: true }])
    const before = await f.bytes()
    expect((await f.request('DELETE', { expectedRevision: created.revision, confirmation: 'wrong command' }, api + '/' + target.id)).status).toBe(422)
    expect(await f.bytes()).toBe(before)
    const deleted = await f.request('DELETE', { expectedRevision: created.revision, confirmation: target.command }, api + '/' + target.id)
    expect(deleted.status).toBe(200); expect((await deleted.json() as Envelope).jobs).toEqual([])
    expect(await f.state.store.listCronJobs(f.owner.id)).toEqual([])
    expect((await f.state.store.listCronJobs(f.other.id)).length).toBe(1)
    expect((await f.database.db.query('SELECT action FROM audit_log WHERE action = $1', ['cron.deleted'])).length).toBe(1)
  })
  it('isolates owners and refuses selectors and administrative self impersonation', async () => {
    const created = await f.create(), before = await f.bytes()
    expect((await f.read(f.otherToken)).jobs).toEqual([])
    expect((await f.request('PATCH', { expectedRevision: (await f.read(f.otherToken)).revision, command: 'echo foreign' }, api + '/' + created.jobs[0]!.id, f.otherToken)).status).toBe(404)
    expect((await f.request('PATCH', { expectedRevision: created.revision, command: 'echo foreign' }, api + '/' + created.jobs[0]!.id, f.otherToken)).status).toBe(409)
    expect((await f.request('GET', undefined, api + '?accountId=' + f.other.id)).status).toBe(422)
    expect((await f.request('GET', undefined, api, f.rootToken)).status).toBe(403)
    expect(await f.bytes()).toBe(before)
  })
  it('retains authentication, scoped bearer permissions and session CSRF protection', async () => {
    const current = await f.read(), input = { ...f.draft, expectedRevision: current.revision }
    expect((await f.request('GET', undefined, api, null)).status).toBe(401)
    expect((await f.request('POST', input, api, await f.token(f.principal.id, ['cron:read']))).status).toBe(403)
    const raw = randomUUID() + randomUUID()
    await createSession(f.database.db, { principalId: f.principal.id, tokenHash: sha256Hex(raw), expiresAt: new Date(Date.now() + 60000).toISOString() })
    const cookie = { cookie: 'xpanel_session=' + raw }
    expect((await f.request('POST', input, api, null, cookie)).status).toBe(403)
    expect((await f.request('POST', input, api, null, { ...cookie, 'x-csrf-token': 'wrong' })).status).toBe(403)
    expect(await f.bytes()).toBeNull()
    expect((await f.request('POST', input, api, null, { ...cookie, 'x-csrf-token': deriveCsrfToken(raw, SECRET) })).status).toBe(201)
  })
  it('enforces the account capacity without adding another job', async () => {
    await f.state.store.saveCronJobs(f.owner.id, Array.from({ length: CRON_WORKSPACE_MAX_JOBS }, () => ({ id: randomUUID(), accountId: f.owner.id, schedule: '@daily', command: 'echo capacity fixture', comment: '', enabled: true })))
    const current = await f.read(), before = await f.bytes()
    expect((await f.request('POST', { ...f.draft, expectedRevision: current.revision })).status).toBe(409)
    expect(await f.bytes()).toBe(before)
  })
})
