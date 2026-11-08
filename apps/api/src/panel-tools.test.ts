import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import { appendAudit, createTestDb } from '@xpanel/db'
import { atomicWriteJson, createTestStateStore, readJsonIfExists } from '@xpanel/state'
import type { MetricsSample } from '@xpanel/db'
import { buildShellRequest, handleApiShellRoute, openApiDocument, parseShellShape, shapeRecords } from './api-shell.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { CLI_API_FUNCTIONS } from './cli-api/functions.ts'
import { diffTree, exportTree, handleConfigAsCodeRoute, treeRevision } from './config-as-code.ts'
import { errorEnvelope, handleErrorReportingRoute, isReportableError, parseDsn, parseErrorReportingConfig, scrubReport } from './error-reporting.ts'
import { handleMetricsExportRoute, parseMetricsConfig, renderOpenMetrics } from './metrics-export.ts'
import { dispatchWebhooks, WEBHOOK_FILES } from './webhook-dispatch.ts'
import { policyForRequest } from './authorization.ts'
import { verifyWebhookSignature } from '../../agent/src/ops-webhooks.ts'

const root = { principal: { kind: 'root', id: '11111111-1111-4111-8111-111111111111', username: 'root' }, sessionId: 's', apiTokenId: null, scopes: [] } as unknown as AuthenticatedCaller
const fixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xpanel-tools-'))
  return { dir, store: { rootDir: dir, getWriterLock: () => ({ acquire: async () => ({ assertFencingToken: async () => undefined, release: async () => undefined }) }) } as never }
}

describe('OpenMetrics export', () => {
  const sample = { memoryMb: 2, cpuPercent: 5, diskMb: 3, bandwidthBytes: 7, ioReadBps: 1, ioWriteBps: 2, processes: 4 } as MetricsSample
  it('renders each account and leaves out what no sample holds', () => {
    const text = renderOpenMetrics({ host: { hostObservation: { load1: 0.5, load5: null, load15: null, memoryTotalBytes: 100, memoryAvailableBytes: 50, swapTotalBytes: null, swapFreeBytes: null, diskTotalBytes: null, diskUsedBytes: null, diskAvailableBytes: null, cpuPercent: 12, processes: 9 } } as MetricsSample, accounts: [{ username: 'alpha', sample, limits: { memoryMb: 512, cpuPercent: null, maxProcesses: 10 } }], generation: 42, services: [{ name: 'nginx', up: true }, { name: 'mail', up: false }] })
    expect(text).toContain('xpanel_account_memory_bytes{account="alpha"} 2097152')
    expect(text).toContain('# TYPE xpanel_account_memory_bytes gauge')
    expect(text).toContain('xpanel_service_up{service="mail"} 0')
    expect(text).toContain('xpanel_reconcile_generation 42')
    expect(text).toContain('xpanel_account_memory_limit_bytes{account="alpha"} 536870912')
    expect(text).not.toContain('xpanel_account_cpu_limit_percent{')
    expect(text).not.toContain('xpanel_load5')
    expect(text.endsWith('# EOF\n')).toBe(true)
  })
  it('accepts only canonical source addresses', () => {
    expect(parseMetricsConfig({ enabled: true, allow: ['192.0.2.1', '2001:db8::1'] })).not.toBeNull()
    expect(parseMetricsConfig({ enabled: true, allow: ['not an address'] })).toBeNull()
    expect(parseMetricsConfig({ enabled: 'yes', allow: [] })).toBeNull()
  })
  it('names the scraper token scope and refuses a scrape while off', async () => {
    expect(policyForRequest('/api/metrics', 'GET')).toMatchObject({ resource: 'metrics', rootOnly: true, scopeAccess: 'read' })
    const url = new URL('http://local/api/metrics'), f = await fixture()
    const helpers = { requireCaller: async () => root, assertRoot: async () => undefined, emitAudit: async () => undefined, store: f.store, db: null as never, clientIp: () => '192.0.2.1', readServices: async () => [] }
    await expect(handleMetricsExportRoute(new Request(url), url, 'GET', helpers)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'metrics_disabled' } })
    await rm(f.dir, { recursive: true, force: true })
  })
})

describe('error reporting', () => {
  const dsnUser = '0123456789abcdef'.repeat(2), dsn = `https://${dsnUser}@sentry.example.com/42`
  it('reads only an https project DSN on a public host', () => {
    expect(parseDsn(dsn)).toEqual({ key: dsnUser, envelope: 'https://sentry.example.com/api/42/envelope/' })
    for (const bad of ['http://k@sentry.example.com/1', 'https://sentry.example.com/1', 'https://0123456789abcdef@127.0.0.1/1', 'https://0123456789abcdef@sentry.example.com/x', 'nonsense']) expect(parseDsn(bad)).toBeNull()
    expect(parseErrorReportingConfig({ dsn: null, environment: 'production', sampleRate: 1 })).not.toBeNull()
    expect(parseErrorReportingConfig({ dsn: null, environment: 'production', sampleRate: 2 })).toBeNull()
  })
  it('replaces secrets, email addresses and IP addresses', () => {
    expect(scrubReport({ password: 'hunter2', nested: { apiToken: 'x', note: 'ask a@b.test from 192.0.2.7' }, cookie: 'c', count: 3 })).toEqual({ password: '[redacted]', nested: { apiToken: '[redacted]', note: 'ask [redacted] from [redacted]' }, cookie: '[redacted]', count: 3 })
  })
  it('sends the stack, release, generation and component with the password replaced', () => {
    const error = new TypeError('boom for a@b.test')
    const [header, item, event] = errorEnvelope(error, { component: 'api', method: 'POST', path: '/api/x', body: { password: 'hunter2', name: 'n' } }, { dsn, environment: 'production', release: '1.2.3', generation: '9', at: new Date(0), eventId: 'a'.repeat(32) }).trim().split('\n')
    expect(JSON.parse(header!)).toMatchObject({ event_id: 'a'.repeat(32) })
    expect(JSON.parse(item!)).toEqual({ type: 'event' })
    const body = JSON.parse(event!)
    expect(body).toMatchObject({ release: 'xpanel@1.2.3', environment: 'production', tags: { component: 'api', generation: '9' }, request: { data: { password: '[redacted]', name: 'n' } } })
    expect(body.exception.values[0]).toMatchObject({ type: 'TypeError', value: 'boom for [redacted]' })
    expect(body.exception.values[0].stacktrace.frames.length).toBeGreaterThan(0)
  })
  it('reports unexpected failures, never refusals', () => {
    expect(isReportableError(new Error('x'))).toBe(true)
    let refused: unknown
    try { fail('VALIDATION', 'no') } catch (error) { refused = error }
    expect(isReportableError(refused)).toBe(false)
  })
  it('refuses a test event without a DSN', async () => {
    const f = await fixture(), url = new URL('http://local/api/server/error-reporting/test')
    const reporter = { wanted: async () => false, capture: vi.fn(async () => null) }
    await expect(handleErrorReportingRoute(new Request(url, { method: 'POST' }), url, 'POST', { requireCaller: async () => root, assertRoot: async () => undefined, emitAudit: async () => undefined, store: f.store, reporter })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'dsn_not_configured' } })
    expect(reporter.capture).not.toHaveBeenCalled()
    await rm(f.dir, { recursive: true, force: true })
  })
})

describe('configuration as code', () => {
  const plan = { id: 'p1', name: 'Basic', ownerId: null, featureListId: 'f1', resources: { diskMb: 100 }, caps: {}, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 10 }
  const state = { server: null, featureLists: [{ id: 'f1', name: 'Default', ownerId: null, disabled: [] }], plans: [plan], resellers: [{ id: 'r1', username: 'res', passwordHash: 'x', acl: [] }], accounts: [{ id: 'a1', username: 'alpha', primaryDomain: 'a.test', planId: 'p1', ownerId: null, status: 'active', passwordHash: 'secret' }] } as never
  it('exports stable files without secrets', () => {
    const files = exportTree(state)
    expect(Object.keys(files)).toEqual(['accounts/alpha.yaml', 'feature-lists/Default.yaml', 'plans/Basic.yaml', 'resellers/res.yaml'])
    expect(JSON.stringify(files)).not.toContain('secret'); expect(files['resellers/res.yaml']).not.toContain('passwordHash')
    expect(treeRevision(files)).toBe(treeRevision(exportTree(state)))
  })
  it('importing the export changes nothing and a changed disk limit shows exactly that change', async () => {
    const { parseYaml } = await import('@xpanel/lifecycle'), files = exportTree(state)
    const parsed = Object.fromEntries(Object.entries(files).map(([path, text]) => [path, parseYaml(text)]))
    expect(diffTree(parsed, state)).toEqual([])
    const changed = { ...parsed, 'plans/Basic.yaml': { ...plan, resources: { diskMb: 200 } } }
    expect(diffTree(changed, state)).toEqual([{ path: 'plans/Basic.yaml', kind: 'changed', apply: 'plan', reason: null, fields: [{ field: 'resources.diskMb', from: 100, to: 200 }] }])
  })
  it('refuses what a file cannot carry', async () => {
    const { parseYaml } = await import('@xpanel/lifecycle'), files = exportTree(state)
    const account = parseYaml(files['accounts/alpha.yaml']!) as Record<string, unknown>
    expect(diffTree({ 'accounts/alpha.yaml': { ...account, status: 'suspended' } }, state)[0]).toMatchObject({ apply: 'not-importable', reason: 'account_change_not_importable' })
    expect(diffTree({ 'accounts/new.yaml': { id: 'new', username: 'new', planId: 'p1' } }, state)[0]).toMatchObject({ apply: 'not-importable' })
    expect(diffTree({ 'accounts/alpha.yaml': { ...account, planId: 'p2' } }, state)[0]).toMatchObject({ apply: 'account-plan', reason: null })
  })
  it('applies a plan change through the store and reconciles once', async () => {
    const handle = await createTestStateStore(), store = handle.store
    const list = await store.createFeatureList({ name: 'Base', disabled: [], ownerId: null })
    const { id: _id, ...base } = (await import('@xpanel/core')).defaultPlan({ name: 'Basic', ownerId: null, featureListId: list.id })
    const created = await store.createPlan(base)
    const exported = exportTree(await store.readSnapshot()), text = exported['plans/Basic.yaml']!.replace(/diskMb: [0-9a-z]+/, 'diskMb: 12345')
    const reconcile = vi.fn(async () => ({ ok: true, status: 200, body: {} })), emitAudit = vi.fn(async () => undefined)
    const helpers = { requireCaller: async () => root, assertRoot: async () => undefined, emitAudit, store, reconcile }
    const post = async (path: string, body: unknown) => { const url = new URL('http://local/api/server/config-as-code/' + path); return (await handleConfigAsCodeRoute(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), url, 'POST', helpers))!.json() as Promise<{ changes: { path: string }[]; revision: string; applied: number }> }
    const preview = await post('preview', { files: { 'plans/Basic.yaml': text } })
    expect(preview.changes.map(change => change.path)).toEqual(['plans/Basic.yaml'])
    await expect(post('apply', { files: { 'plans/Basic.yaml': text }, expectedRevision: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect((await post('apply', { files: { 'plans/Basic.yaml': text }, expectedRevision: preview.revision })).applied).toBe(1)
    expect((await store.getPlan(created.id))!.resources.diskMb).toBe(12345)
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(emitAudit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'server.config_as_code.applied', outcome: 'ok' }))
    reconcile.mockResolvedValueOnce({ ok: false, status: 422, body: {} })
    const again = await post('preview', { files: { 'plans/Basic.yaml': text.replace('12345', '23456') } })
    await expect(post('apply', { files: { 'plans/Basic.yaml': text.replace('12345', '23456') }, expectedRevision: again.revision })).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED' })
    expect((await store.getPlan(created.id))!.resources.diskMb).toBe(12345)
    await handle.close()
  })
})

describe('API shell', () => {
  const list = { accounts: [{ id: 1, name: 'b', size: 0 }, { id: 2, name: 'a', size: 5 }, { id: 3, name: 'ab', size: 2 }] }
  it('pages, filters, sorts and selects columns over the first list', () => {
    expect(shapeRecords(list, parseShellShape({ limit: 2 }))).toMatchObject({ pagination: { start: 0, limit: 2, total: 3, returned: 2 } })
    expect((shapeRecords(list, parseShellShape({ filters: [{ column: 'name', type: 'begins', value: 'a' }], sorts: [{ column: 'size', method: 'numeric', reverse: true }], columns: ['name'] })).body as typeof list).accounts).toEqual([{ name: 'a' }, { name: 'ab' }])
    expect((shapeRecords(list, parseShellShape({ sorts: [{ column: 'size', method: 'numeric_zero_max', reverse: false }] })).body as typeof list).accounts.at(-1)).toMatchObject({ size: 0 })
    expect(shapeRecords({ one: 1 }, parseShellShape(undefined)).pagination).toBeNull()
    expect(() => parseShellShape({ limit: -1 })).toThrow(); expect(() => parseShellShape({ filters: [{ column: 'a b', type: 'x', value: '' }] })).toThrow()
  })
  it('keeps a path value in its segment', () => {
    expect(buildShellRequest(['a', 'b', 'GET', '/api/accounts/{id}'], { id: '../x y', q: '1' })).toEqual({ method: 'GET', path: '/api/accounts/..%2Fx%20y', query: 'q=1', body: null })
    expect(buildShellRequest(['a', 'b', 'POST', '/api/plans'], { name: 'p' })).toMatchObject({ body: { name: 'p' } })
    expect(() => buildShellRequest(['a', 'b', 'GET', '/api/accounts/{id}'], {})).toThrow(); expect(() => buildShellRequest(['a', 'b', 'GET', '/api/accounts/{id}'], { id: '..' })).toThrow()
  })
  it('publishes OpenAPI 3.1 from the function catalog, without the shell itself', () => {
    const document = openApiDocument('administrator', '1.0.0') as { openapi: string; paths: Record<string, Record<string, { operationId: string }>> }
    expect(document.openapi).toBe('3.1.0')
    const [module, fn, method, path] = CLI_API_FUNCTIONS.xwhmapi.find(row => !row[3].startsWith('/api/auth') && !row[3].includes('/developer'))!
    expect(document.paths[path]![method.toLowerCase()]!.operationId).toBe(module + '_' + fn)
    expect(Object.keys(document.paths).some(key => key.includes('/developer'))).toBe(false)
  })
  const shell = (over: Record<string, unknown> = {}) => ({ requireCaller: async () => root, assertRoot: async () => undefined, emitAudit: vi.fn(async () => undefined), store: {} as never, apiShellEnabled: async () => true, ...over })
  const call = (helpers: ReturnType<typeof shell>, body: unknown) => { const url = new URL('http://local/api/server/panel/developer/call'); return handleApiShellRoute(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': 'c' }, body: JSON.stringify(body) }), url, 'POST', helpers as never) }
  it('is refused with the switch off, for tokens and for unlisted functions', async () => {
    await expect(call(shell({ apiShellEnabled: async () => false }), {})).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { reason: 'api_shell_disabled' } })
    await expect(call(shell({ requireCaller: async () => ({ ...root, sessionId: null, apiTokenId: 't' }) }), {})).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call(shell({ dispatchRead: async () => new Response('{}') }), { module: 'no', fn: 'such', params: {} })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
  it('sends the session through the normal dispatcher and separates headers from the shaped body', async () => {
    const [module, fn] = CLI_API_FUNCTIONS.xwhmapi.find(row => row[2] === 'GET' && row[3] === '/api/plans')!
    const dispatchRead = vi.fn(async (request: Request) => { expect(request.headers.get('x-csrf-token')).toBe('c'); return new Response(JSON.stringify({ plans: [{ id: 1 }, { id: 2 }, { id: 3 }] }), { headers: { 'content-type': 'application/json', 'set-cookie': 'a=b' } }) })
    const helpers = shell({ dispatchRead }), reply = await (await call(helpers, { module, fn, params: {}, shape: { limit: 2 } }))!.json() as { status: number; json: { plans: unknown[] }; pagination: { total: number }; headers: string[][] }
    expect(reply).toMatchObject({ status: 200, pagination: { total: 3, returned: 2 } }); expect(reply.json.plans).toHaveLength(2)
    expect(reply.headers.flat()).toContain('content-type'); expect(reply.headers.flat()).not.toContain('set-cookie')
    expect(helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'developer.shell.call', outcome: 'ok' }))
  })
})

describe('webhook dispatch', () => {
  let dir: string, db: Awaited<ReturnType<typeof createTestDb>>
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'xpanel-hooks-')); db = await createTestDb() })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
  const endpoint = { id: 'whk_' + 'a'.repeat(16), url: 'https://hooks.example.com/x', events: ['account.created'], active: true }
  const secret = 's'.repeat(40)
  const seed = async () => { await atomicWriteJson(join(dir, 'extended', WEBHOOK_FILES.saved), { endpoints: [endpoint] }); await atomicWriteJson(join(dir, 'extended', WEBHOOK_FILES.secrets), { [endpoint.id]: secret }) }
  const log = () => readJsonIfExists<{ state: string; attempts: { status: number | null }[] }[]>(join(dir, 'extended', WEBHOOK_FILES.log))
  it('stays idle without an active endpoint', async () => {
    const send = vi.fn(async () => ({ status: 200 }))
    expect(await dispatchWebhooks({ db: db.db, store: { rootDir: dir }, send })).toEqual({ queued: 0, attempted: 0 })
    expect(send).not.toHaveBeenCalled()
  })
  it('signs one delivery for an audited account creation and sends nothing from before the endpoint', async () => {
    await appendAudit(db.db, { actor: 'root', action: 'account.provisioned', target: 'old', outcome: 'ok' })
    await seed()
    const bodies: { body: string; headers: Record<string, string> }[] = []
    const send = vi.fn(async (input: { body: string; headers: Record<string, string> }) => { bodies.push(input); return { status: 200 } })
    expect(await dispatchWebhooks({ db: db.db, store: { rootDir: dir }, send })).toEqual({ queued: 0, attempted: 0 })
    await appendAudit(db.db, { actor: 'root', action: 'account.provisioned', target: 'account:alpha', outcome: 'ok', detail: { password: 'x' } })
    await appendAudit(db.db, { actor: 'root', action: 'account.provisioned', target: 'failed', outcome: 'failed' })
    await dispatchWebhooks({ db: db.db, store: { rootDir: dir }, send })
    expect(send).toHaveBeenCalledTimes(1)
    expect(JSON.parse(bodies[0]!.body)).toMatchObject({ event: 'account.created', target: 'account:alpha' }); expect(bodies[0]!.body).not.toContain('password')
    expect(verifyWebhookSignature(secret, bodies[0]!.headers['x-xpanel-signature']!, bodies[0]!.body, Math.floor(Date.now() / 1000))).toBe(true)
    expect((await log())![0]!.state).toBe('delivered')
    await dispatchWebhooks({ db: db.db, store: { rootDir: dir }, send }); expect(send).toHaveBeenCalledTimes(1)
  })
  it('retries a failing endpoint on the backoff schedule and shows it failing, then exhausted', async () => {
    await seed()
    let now = Date.now()
    const send = vi.fn(async () => ({ status: 500 })), run = () => dispatchWebhooks({ db: db.db, store: { rootDir: dir }, send, now: () => new Date(now) })
    await run()
    await appendAudit(db.db, { actor: 'root', action: 'account.provisioned', target: 'account:alpha', outcome: 'ok' })
    await run()
    expect((await log())![0]).toMatchObject({ state: 'failed' }); expect(send).toHaveBeenCalledTimes(1)
    await run(); expect(send).toHaveBeenCalledTimes(1)
    for (const seconds of [30, 120, 300, 900, 1800]) { now += seconds * 1000 + 1; await run() }
    expect(send).toHaveBeenCalledTimes(6)
    expect((await log())![0]!).toMatchObject({ state: 'exhausted' }); expect((await log())![0]!.attempts).toHaveLength(6)
    now += 86_400_000; await run(); expect(send).toHaveBeenCalledTimes(6)
  })
})
