import { describe, expect, it, vi } from 'vitest'
import type { HostJobPlan, HostJobView } from './host-job-contract.ts'
import { handleDnsToolsRoute } from './dns-tools-routes.ts'
import type { DnsToolsRouteContext } from './dns-tools-routes.ts'
import type { DnsToolsResolver, DnsToolsState } from './dns-tools.ts'

const now = () => new Date('2026-10-27T10:00:00Z')
const jobId = '11111111-1111-4111-8111-111111111111'
const names = (count: number) => Array.from({ length: count }, (_, index) => `z${String(index).padStart(3, '0')}.example`)
const state = (count = 2): DnsToolsState => ({ zones: names(count).map(name => ({ name, serial: 1, records: [{ name: '@', type: 'NS', content: 'ns1.host.test.' }] })), serviceUsers: [], server: { settings: { hostname: 'panel.example.test' } } })
const view = (plan: HostJobPlan, id = jobId, status: HostJobView['status'] = 'queued'): HostJobView => ({ id, referenceCode: null, kind: plan.kind, status, progress: 0, summary: plan.summary, accountId: null, actor: 'root', createdAt: '2026-10-27T10:00:00.000Z', startedAt: null, finishedAt: null,
  steps: plan.steps.map(step => ({ id: step.id, title: step.title, ...(step.titleValues ? { titleValues: step.titleValues } : {}), state: 'pending', exitCode: null })), error: null, failureClass: null, cancelRequested: false, verification: null, logBytes: 0 })
const refused = Object.assign(new Error('refused'), { code: 'EREFUSED' })
const resolver: DnsToolsResolver = { soaSerial: async () => 1, ns: async () => ['ns1.host.test'], v4: async () => ['127.0.0.1'], v6: async () => { throw refused } }
const call = (path: string, ctx: DnsToolsRouteContext, method = 'GET', body?: string) => { const req = new Request('http://agent.local' + path, { method, ...(body === undefined ? {} : { body }) }); return handleDnsToolsRoute(req, new URL(req.url), req.method, ctx) }
const context = (overrides: Partial<DnsToolsRouteContext> = {}, zones = 2) => {
  const submitted: HostJobPlan[] = [], commands: string[][] = []
  const finished: HostJobView = { ...view(buildPlan()), status: 'succeeded', steps: [{ id: 'zone-1', title: 'Check zone {zone}', titleValues: { zone: 'z000.example' }, state: 'succeeded', exitCode: 0 }] }
  const ctx: DnsToolsRouteContext = {
    assertRoot: vi.fn(async () => ({ actor: 'root' })), now, resolver, localAddresses: () => ['127.0.0.1'],
    host: { run: vi.fn(async (argv: string[]) => { commands.push(argv); return { ok: true, code: 0, stdout: argv[1] === 'rping' ? 'PONG\n' : '', stderr: '' } }), readFile: vi.fn(async () => null), stat: vi.fn(async () => ({ kind: 'missing' as const, sizeBytes: 0 })), listDirectory: vi.fn(async () => ({ state: 'missing' as const, entries: [], truncated: false })) },
    readState: vi.fn(async () => state(zones)),
    jobs: {
      list: vi.fn(async () => [finished, { ...finished, id: '22222222-2222-4222-8222-222222222222', kind: 'dns.tools.check-zones-other' }]),
      get: vi.fn(async (id: string) => id === jobId ? finished : null),
      readLog: vi.fn(async (id: string) => ({ id, available: true, offset: 0, nextOffset: 10, total: 10, truncated: false, text: "\n2026-10-27T10:00:00.001Z step 1/1 zone-1\n$ /usr/bin/pdnsutil check-zone z000.example\nChecked 3 records of 'z000.example', 0 errors, 0 warnings.\n[exit 0]\n" })),
    },
    submitJob: vi.fn(async (plan: HostJobPlan) => { submitted.push(plan); return view(plan, jobId.slice(0, -1) + submitted.length) }),
    audit: vi.fn(async () => undefined), ...overrides,
  }
  return { ctx, submitted, commands }
}
function buildPlan(): HostJobPlan { return { kind: 'dns.tools.check-zones', summary: 'Check DNS zones 1-1 of 1', accountId: null, fingerprint: {}, detail: {}, steps: [{ id: 'zone-1', title: 'Check zone {zone}', titleValues: { zone: 'z000.example' }, argv: [], timeoutMs: 1, mutates: false }], policy: () => true } }

describe('agent DNS tools routes', () => {
  it('ignores unrelated paths without authorizing', async () => {
    const { ctx } = context()
    for (const path of ['/host/dns-tools', '/host/dns-tools/compare/1', '/host/dns-tools/other', '/host/services/detail/dns', '/host/dns-tools/check-jobs/a/b']) expect(await call(path, ctx)).toBeNull()
    expect(ctx.assertRoot).not.toHaveBeenCalled()
  })
  it('refuses non-root callers before touching state, the host or jobs', async () => {
    const { ctx, commands } = context({ assertRoot: async () => { throw Object.assign(new Error('root role is required'), { code: 'FORBIDDEN' }) } })
    for (const [path, method] of [['/host/dns-tools/compare?page=1', 'GET'], ['/host/dns-tools/nameservers?page=1', 'GET'], ['/host/dns-tools/check-jobs', 'POST'], ['/host/dns-tools/check-jobs', 'GET'], ['/host/dns-tools/check-jobs/' + jobId, 'GET']] as const)
      await expect(call(path, ctx, method)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(ctx.readState).not.toHaveBeenCalled(); expect(ctx.submitJob).not.toHaveBeenCalled(); expect(ctx.jobs!.list).not.toHaveBeenCalled(); expect(commands).toEqual([])
  })
  it.each([['/host/dns-tools/compare', 'GET'], ['/host/dns-tools/compare?page=0', 'GET'], ['/host/dns-tools/compare?page=1&page=2', 'GET'], ['/host/dns-tools/nameservers?page=1&zone=a.example', 'GET'], ['/host/dns-tools/nameservers?page=-1', 'GET'],
    ['/host/dns-tools/check-jobs?zone=a.example', 'GET'], ['/host/dns-tools/check-jobs/NOT-A-UUID', 'GET'], ['/host/dns-tools/check-jobs?force=1', 'POST']] as const)('rejects request grammar %s before any read', async (path, method) => {
    const { ctx, commands } = context()
    await expect(call(path, ctx, method)).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } })
    expect(ctx.readState).not.toHaveBeenCalled(); expect(commands).toEqual([])
  })
  it('rejects methods and request bodies and states missing host capability truthfully', async () => {
    const { ctx } = context()
    expect((await call('/host/dns-tools/compare?page=1', ctx, 'POST'))!.headers.get('allow')).toBe('GET')
    expect((await call('/host/dns-tools/check-jobs', ctx, 'DELETE'))!.headers.get('allow')).toBe('GET, POST')
    for (const body of ['{"zones":["z000.example"]}', '[]', 'nope', '{"a":1}']) await expect(call('/host/dns-tools/check-jobs', ctx, 'POST', body)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('/host/dns-tools/compare?page=1', { ...ctx, host: null })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    await expect(call('/host/dns-tools/check-jobs', { ...ctx, submitJob: null }, 'POST', '{}')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(call('/host/dns-tools/check-jobs', { ...ctx, jobs: null })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    await expect(call('/host/dns-tools/check-jobs', context({}, 0).ctx, 'POST', '{}')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'no_zones' } })
    expect(ctx.submitJob).not.toHaveBeenCalled()
  })
  it('queues every saved zone in pages of 32, re-checking root before submission', async () => {
    const { ctx, submitted } = context({}, 70)
    const response = (await call('/host/dns-tools/check-jobs', ctx, 'POST', '{}'))!
    expect(response.status).toBe(202)
    const body = await response.json() as { jobs: { zones: number }[] }
    expect(body).toMatchObject({ zones: 70, notQueued: 0, incomplete: false })
    expect(body.jobs.map(job => job.zones)).toEqual([32, 32, 6])
    expect(submitted.flatMap(plan => plan.steps.map(step => step.argv[2]))).toEqual(names(70))
    expect(ctx.assertRoot).toHaveBeenCalledTimes(2)
    expect(ctx.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'dns.tools.check_submitted', target: 'zones:70', outcome: 'ok' }))
  })
  it('reports partial queueing and an unknown first submission truthfully', async () => {
    let calls = 0
    const partial = context({ submitJob: vi.fn(async (plan: HostJobPlan) => { if (++calls > 1) throw new Error('db down'); return view(plan) }) }, 40)
    expect(await (await call('/host/dns-tools/check-jobs', partial.ctx, 'POST', ''))!.json()).toMatchObject({ jobs: [{ id: jobId, zones: 32 }], incomplete: true })
    const unknown = context({ submitJob: vi.fn(async () => { throw new Error('db down') }) })
    await expect(call('/host/dns-tools/check-jobs', unknown.ctx, 'POST', '{}')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true } })
    const changed = context({ assertRoot: vi.fn().mockResolvedValueOnce({ actor: 'root' }).mockResolvedValueOnce({ actor: 'other' }) })
    await expect(call('/host/dns-tools/check-jobs', changed.ctx, 'POST', '{}')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(changed.ctx.submitJob).not.toHaveBeenCalled()
  })
  it('lists check jobs of the exact kind and parses one job log into per-zone results', async () => {
    const { ctx } = context()
    const list = await (await call('/host/dns-tools/check-jobs', ctx))!.json() as { jobs: unknown[] }
    expect(list.jobs).toEqual([{ id: jobId, status: 'succeeded', summary: 'Check DNS zones 1-1 of 1', zones: 1, createdAt: '2026-10-27T10:00:00.000Z', startedAt: null, finishedAt: null, error: null }])
    const one = await (await call('/host/dns-tools/check-jobs/' + jobId, ctx))!.json()
    expect(one).toMatchObject({ job: { id: jobId }, logAvailable: true, logTruncated: false, results: [{ zone: 'z000.example', state: 'passed', records: 3, errors: 0, warnings: 0 }] })
    await expect(call('/host/dns-tools/check-jobs/33333333-3333-4333-8333-333333333333', ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
  it('serves paged comparison and nameserver reads with no-store', async () => {
    const { ctx } = context()
    const compare = (await call('/host/dns-tools/compare?page=1', ctx))!
    expect(compare.headers.get('cache-control')).toBe('no-store')
    expect(await compare.json()).toMatchObject({ server: '127.0.0.1', page: 1, pages: 1, total: 2, zones: [{ zone: 'z000.example', live: { state: 'answered', serial: 1 }, drift: ['file-not-parsed'] }, { zone: 'z001.example' }] })
    expect(await (await call('/host/dns-tools/nameservers?page=1', ctx))!.json()).toMatchObject({ zones: [{ zone: 'z000.example', soa: 'answered', nameservers: [{ host: 'ns1.host.test', result: 'answers', addresses: [{ address: '127.0.0.1', thisServer: true }] }] }, { zone: 'z001.example' }] })
    await expect(call('/host/dns-tools/compare?page=2', ctx)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('/host/dns-tools/compare?page=1', { ...ctx, readState: async () => { throw new Error('locked') } })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})
