import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestStateStore } from '@xpanel/state'
import type { DnsZoneState } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { dnsZoneRevision } from './dns-workspace.ts'
import { driftOf, handleDnsToolsWorkspaceRoute, projectCheckJob, projectCompare, projectNameservers } from './dns-tools-workspace.ts'
import type { DnsToolsWorkspaceHelpers } from './dns-tools-workspace.ts'

const root = { principal: { kind: 'root', id: 'root-1', username: 'root' } } as AuthenticatedCaller
const observedAt = '2026-10-27T10:00:00.000Z', jobId = '11111111-1111-4111-8111-111111111111'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map(close => close())) })
const record = (zone: string, ttl: number, name = '@') => ({ id: randomUUID(), zone, name, type: 'A' as const, ttl, content: '192.0.2.1', priority: null })
const zone = (name: string, ttls: number[]): DnsZoneState => ({ id: randomUUID(), accountId: null, name, serial: 2026102701, records: ttls.map((ttl, index) => record(name, ttl, 'h' + index)) })
const compareRow = { zone: 'a.example', saved: { stateSerial: 1, file: 'parsed', fileSerial: 2, ns: ['ns1.host.test'] }, live: { state: 'answered', serial: 2, nsState: 'answered', ns: ['ns1.host.test'] }, drift: [] }
const compare = (extra: Record<string, unknown> = {}) => ({ observedAt, server: '127.0.0.1', control: 'reachable', page: 1, pages: 1, total: 1, zones: [compareRow], ...extra })
const nsRead = (extra: Record<string, unknown> = {}) => ({ observedAt, server: '127.0.0.1', page: 1, pages: 1, total: 1,
  zones: [{ zone: 'a.example', soa: 'answered', truncated: false, nameservers: [{ host: 'ns1.host.test', state: 'answered', addresses: [{ address: '192.0.2.1', thisServer: true }], result: 'answers' }, { host: 'ns2.other.test', state: 'refused', addresses: [], result: 'not-local' }] }], ...extra })
const jobSummary = { id: jobId, status: 'succeeded', summary: 'Check DNS zones 1-1 of 1', zones: 1, createdAt: observedAt, startedAt: observedAt, finishedAt: observedAt, error: null }
const jobRead = (results: unknown[] = [{ zone: 'a.example', state: 'failed', records: 3, errors: 1, warnings: 0, messages: ['[Error] x'] }]) => ({ job: jobSummary, logAvailable: true, logTruncated: false, results })

const setup = async (zones: DnsZoneState[] = [], overrides: Partial<DnsToolsWorkspaceHelpers> = {}, reply: (path: string, body?: unknown) => unknown = () => ({})) => {
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  for (const item of zones) await state.store.saveDnsZone(item)
  const events: string[] = []
  const helpers: DnsToolsWorkspaceHelpers = {
    store: state.store, now: () => new Date(observedAt),
    requireCaller: vi.fn(async () => { events.push('auth'); return root }), assertRoot: vi.fn(async (_caller, action: string) => { events.push('root:' + action) }),
    emitAudit: vi.fn(async (entry: { action: string; target: string }) => { events.push('audit:' + entry.action + ':' + entry.target) }),
    triggerReconcile: vi.fn(async () => { events.push('reconcile'); return { ok: true, status: 200, body: {} } }),
    callHost: vi.fn(async (_caller, path: string, body?: unknown) => { events.push('host:' + path); return reply(path, body) }), ...overrides,
  }
  return { helpers, events, store: state.store }
}
const send = (helpers: DnsToolsWorkspaceHelpers, path: string, method = 'GET', body?: unknown) => {
  const req = new Request('http://localhost' + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }) })
  return handleDnsToolsWorkspaceRoute(req, new URL(req.url), req.method, helpers)
}

describe('API DNS tools workspace', () => {
  it('leaves unrelated routes untouched and refuses non-root callers with 403 before any read', async () => {
    const { helpers } = await setup()
    for (const path of ['/api/server/services/dns', '/api/server/dns-toolsx', '/api/server/dns-tools/compare/1', '/api/server/dns-tools/ttl']) expect(await send(helpers, path)).toBeNull()
    expect(helpers.requireCaller).not.toHaveBeenCalled()
    const denied = await setup([], { assertRoot: async () => { throw Object.assign(new Error('root role is required'), { code: 'FORBIDDEN', status: 403 }) } })
    for (const [path, method, body] of [['/api/server/dns-tools', 'GET'], ['/api/server/dns-tools/compare?page=1', 'GET'], ['/api/server/dns-tools/nameservers?page=1', 'GET'], ['/api/server/dns-tools/check-jobs', 'POST', {}],
      ['/api/server/dns-tools/check-jobs/' + jobId, 'GET'], ['/api/server/dns-tools/ttl/preview', 'POST', { ttl: 300, zones: ['a.example'] }], ['/api/server/dns-tools/ttl/apply', 'POST', { ttl: 300, zones: [] }]] as const)
      await expect(send(denied.helpers, path, method, body)).rejects.toMatchObject({ status: 403 })
    expect(denied.helpers.callHost).not.toHaveBeenCalled()
  })
  it('rejects unknown selectors, fields, bounds and wrong methods with 400 or 405 before the host or store', async () => {
    const { helpers, store } = await setup([zone('a.example', [300])])
    const save = vi.spyOn(store, 'saveDnsZone')
    expect((await send(helpers, '/api/server/dns-tools', 'POST', {}))!.status).toBe(405)
    expect((await send(helpers, '/api/server/dns-tools/ttl/apply'))!.headers.get('allow')).toBe('POST')
    expect((await send(helpers, '/api/server/dns-tools/check-jobs', 'DELETE'))!.headers.get('allow')).toBe('GET, POST')
    const revision = 'a'.repeat(64)
    for (const [path, method, body] of [['/api/server/dns-tools?zone=a.example', 'GET'], ['/api/server/dns-tools/compare', 'GET'], ['/api/server/dns-tools/compare?page=0', 'GET'], ['/api/server/dns-tools/nameservers?page=1&zone=a', 'GET'],
      ['/api/server/dns-tools/check-jobs/NOT-A-UUID', 'GET'], ['/api/server/dns-tools/check-jobs', 'POST', { zones: ['a.example'] }],
      ['/api/server/dns-tools/ttl/preview', 'POST', { ttl: 300 }], ['/api/server/dns-tools/ttl/preview', 'POST', { ttl: -1, zones: ['a.example'] }], ['/api/server/dns-tools/ttl/preview', 'POST', { ttl: 2147483648, zones: ['a.example'] }],
      ['/api/server/dns-tools/ttl/preview', 'POST', { ttl: 1.5, zones: ['a.example'] }], ['/api/server/dns-tools/ttl/preview', 'POST', { ttl: 300, zones: ['A.example'] }], ['/api/server/dns-tools/ttl/preview', 'POST', { ttl: 300, zones: ['a.example', 'a.example'] }],
      ['/api/server/dns-tools/ttl/preview', 'POST', { ttl: 300, zones: Array.from({ length: 33 }, (_, index) => `z${index}.example`) }], ['/api/server/dns-tools/ttl/preview', 'POST', { ttl: 300, zones: ['a.example'], type: 'A' }],
      ['/api/server/dns-tools/ttl/apply', 'POST', { ttl: 300, zones: ['a.example'] }], ['/api/server/dns-tools/ttl/apply', 'POST', { ttl: 300, zones: [{ zone: 'a.example' }] }], ['/api/server/dns-tools/ttl/apply', 'POST', { ttl: 300, zones: [{ zone: 'a.example', expectedZoneRevision: 'x' }] }],
      ['/api/server/dns-tools/ttl/apply', 'POST', { ttl: 300, zones: [{ zone: 'a.example', expectedZoneRevision: revision, records: [] }] }], ['/api/server/dns-tools/ttl/apply', 'POST', 'not json']] as const)
      await expect(send(helpers, path, method, body)).rejects.toMatchObject({ code: 'VALIDATION', status: 400, detail: { stateChanged: false } })
    expect(helpers.callHost).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled()
  })
  it('states host unavailability truthfully and still serves store-backed tools', async () => {
    const { helpers } = await setup([zone('b.example', [60, 3600]), zone('a.example', [])], { callHost: undefined })
    for (const path of ['/api/server/dns-tools/compare?page=1', '/api/server/dns-tools/nameservers?page=1', '/api/server/dns-tools/check-jobs']) await expect(send(helpers, path)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    const overview = await (await send(helpers, '/api/server/dns-tools'))!.json()
    expect(overview.zones.map((item: { zone: string }) => item.zone)).toEqual(['a.example', 'b.example'])
    expect(overview.zones[1]).toMatchObject({ records: 2, minTtl: 60, maxTtl: 3600, revision: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(overview.zones[0]).toMatchObject({ records: 0, minTtl: null, maxTtl: null })
  })
  it('projects host reads, dropping unknown fields and refusing evidence that contradicts itself', async () => {
    const { helpers, events } = await setup([], {}, path => path.startsWith('/host/dns-tools/compare') ? { ...compare(), secret: 1 } : path.startsWith('/host/dns-tools/nameservers') ? nsRead() : path.endsWith('/check-jobs') ? { jobs: [{ ...jobSummary, extra: true }] } : jobRead())
    expect(await (await send(helpers, '/api/server/dns-tools/compare?page=1'))!.json()).toEqual(compare())
    expect(await (await send(helpers, '/api/server/dns-tools/nameservers?page=1'))!.json()).toEqual(nsRead())
    expect(await (await send(helpers, '/api/server/dns-tools/check-jobs'))!.json()).toEqual({ jobs: [jobSummary] })
    expect(await (await send(helpers, '/api/server/dns-tools/check-jobs/' + jobId))!.json()).toEqual(jobRead())
    expect(events).toContain('host:/host/dns-tools/compare?page=1')
    for (const bad of [compare({ zones: [{ ...compareRow, drift: ['ns-differs'] }] }), compare({ zones: [{ ...compareRow, live: { ...compareRow.live, serial: null } }] }), compare({ total: 2 }), compare({ server: '8.8.8.8' }),
      compare({ zones: [{ ...compareRow, saved: { ...compareRow.saved, file: 'missing' } }] }), compare({ zones: [{ ...compareRow, live: { ...compareRow.live, nsState: 'refused' } }] })]) expect(() => projectCompare(bad, 1)).toThrow()
    expect(() => projectCompare(compare(), 2)).toThrow()
    const zones = nsRead().zones
    for (const bad of [nsRead({ zones: [{ ...zones[0], nameservers: [{ ...zones[0]!.nameservers[0], result: 'other-server' }] }] }), nsRead({ zones: [{ ...zones[0], nameservers: [{ ...zones[0]!.nameservers[1], addresses: [{ address: '192.0.2.9', thisServer: false }] }] }] }),
      nsRead({ zones: [{ ...zones[0], soa: 'refused' }] })]) expect(() => projectNameservers(bad, 1)).toThrow()
    for (const bad of [jobRead([]), jobRead([{ zone: 'a.example', state: 'passed', records: 3, errors: 1, warnings: 0, messages: [] }]), jobRead([{ zone: 'a.example', state: 'pending', records: 3, errors: 0, warnings: 0, messages: [] }]), { ...jobRead(), job: { ...jobSummary, id: '22222222-2222-4222-8222-222222222222' } }])
      expect(() => projectCheckJob(bad, jobId)).toThrow()
  })
  it('recomputes drift flags exactly as the agent does', () => {
    expect(driftOf({ stateSerial: 5, file: 'parsed', fileSerial: 6, ns: ['a'] }, { state: 'answered', serial: 4, nsState: 'answered', ns: ['b'] })).toEqual(['serial-differs-from-file', 'serial-behind-saved', 'ns-differs'])
    expect(driftOf({ stateSerial: null, file: 'missing', fileSerial: null, ns: [] }, { state: 'refused', serial: null, nsState: 'refused', ns: [] })).toEqual(['not-answered', 'file-not-parsed', 'ns-not-answered'])
  })
  it('submits check jobs with fresh root authority and treats an unverifiable acknowledgement as unknown', async () => {
    const ack = { jobs: [{ id: jobId, kind: 'dns.tools.check-zones', status: 'queued', zones: 32 }, { id: '22222222-2222-4222-8222-222222222222', kind: 'dns.tools.check-zones', status: 'queued', zones: 6 }], zones: 38, notQueued: 0, incomplete: false }
    const { helpers, events } = await setup([], {}, () => ack)
    const response = (await send(helpers, '/api/server/dns-tools/check-jobs', 'POST', {}))!
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ jobs: ack.jobs.map(({ kind: _kind, ...job }) => job), zones: 38, notQueued: 0, incomplete: false })
    expect(events).toEqual(['auth', 'root:server.dns-tools.check', 'auth', 'root:server.dns-tools.check', 'host:/host/dns-tools/check-jobs'])
    expect(helpers.callHost).toHaveBeenCalledWith(root, '/host/dns-tools/check-jobs', {})
    const odd = await setup([], {}, () => ({ ...ack, jobs: [{ ...ack.jobs[0], kind: 'system.packages.upgrade' }] }))
    await expect(send(odd.helpers, '/api/server/dns-tools/check-jobs', 'POST', {})).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { unknownOutcome: true, stateChanged: true } })
  })
  it('previews and applies a TTL per zone with each zone revision, proving every write by re-read', async () => {
    const a = zone('a.example', [300, 3600]), b = zone('b.example', [600]), c = zone('c.example', [60])
    const { helpers, events, store } = await setup([a, b, c])
    const preview = await (await send(helpers, '/api/server/dns-tools/ttl/preview', 'POST', { ttl: 600, zones: ['a.example', 'b.example', 'missing.example'] }))!.json()
    expect(preview).toEqual({ observedAt, ttl: 600, zones: [
      { zone: 'a.example', state: 'ready', revision: dnsZoneRevision(a), records: 2, changes: 2, minTtl: 300, maxTtl: 3600 },
      { zone: 'b.example', state: 'unchanged', revision: dnsZoneRevision(b), records: 1, changes: 0, minTtl: 600, maxTtl: 600 },
      { zone: 'missing.example', state: 'not-found', revision: null, records: 0, changes: 0, minTtl: null, maxTtl: null }] })
    // c changes after its preview, so its stale revision must not be written.
    await store.saveDnsZone({ ...c, serial: c.serial + 1 })
    const result = await (await send(helpers, '/api/server/dns-tools/ttl/apply', 'POST', { ttl: 600, zones: [
      { zone: 'a.example', expectedZoneRevision: dnsZoneRevision(a) }, { zone: 'b.example', expectedZoneRevision: dnsZoneRevision(b) }, { zone: 'c.example', expectedZoneRevision: dnsZoneRevision(c) }, { zone: 'missing.example', expectedZoneRevision: 'f'.repeat(64) }] }))!.json()
    const savedA = (await store.getDnsZone('a.example'))!
    expect(result).toEqual({ ttl: 600, reconcile: 'requested', auditIncomplete: false, results: [
      { zone: 'a.example', state: 'applied', revision: dnsZoneRevision(savedA), changes: 2 }, { zone: 'b.example', state: 'unchanged', revision: dnsZoneRevision(b), changes: 0 },
      { zone: 'c.example', state: 'conflict', revision: null, changes: 0 }, { zone: 'missing.example', state: 'not-found', revision: null, changes: 0 }] })
    expect(savedA).toMatchObject({ serial: a.serial + 1, accountId: null })
    expect(savedA.records.map(item => [item.id, item.ttl])).toEqual(a.records.map(item => [item.id, 600]))
    expect((await store.getDnsZone('c.example'))!.records[0]!.ttl).toBe(60)
    expect(events.filter(event => event.startsWith('audit:') || event === 'reconcile')).toEqual(['audit:dns.zone.saved:zone:a.example', 'reconcile'])
  })
  it('stops the remaining zones when authority changes or a write outcome is unknown', async () => {
    const a = zone('a.example', [300]), b = zone('b.example', [300])
    let calls = 0
    const changed = await setup([a, b], { requireCaller: vi.fn(async () => ++calls > 1 ? { principal: { kind: 'root', id: 'root-2', username: 'other' } } as AuthenticatedCaller : root) })
    const refused = await (await send(changed.helpers, '/api/server/dns-tools/ttl/apply', 'POST', { ttl: 60, zones: [{ zone: 'a.example', expectedZoneRevision: dnsZoneRevision(a) }, { zone: 'b.example', expectedZoneRevision: dnsZoneRevision(b) }] }))!.json()
    expect(refused).toMatchObject({ reconcile: 'not-needed', results: [{ zone: 'a.example', state: 'refused' }, { zone: 'b.example', state: 'not-attempted' }] })
    expect((await changed.store.getDnsZone('a.example'))!.records[0]!.ttl).toBe(300)
    expect(changed.helpers.triggerReconcile).not.toHaveBeenCalled()
    const broken = await setup([a, b])
    vi.spyOn(broken.store, 'saveDnsZone').mockRejectedValueOnce(new Error('disk full'))
    const unknown = await (await send(broken.helpers, '/api/server/dns-tools/ttl/apply', 'POST', { ttl: 60, zones: [{ zone: 'a.example', expectedZoneRevision: dnsZoneRevision(a) }, { zone: 'b.example', expectedZoneRevision: dnsZoneRevision(b) }] }))!.json()
    expect(unknown).toMatchObject({ results: [{ zone: 'a.example', state: 'unknown' }, { zone: 'b.example', state: 'not-attempted' }] })
    const offline = await setup([a], { triggerReconcile: vi.fn(async () => null), emitAudit: vi.fn(async () => { throw new Error('audit down') }) })
    expect(await (await send(offline.helpers, '/api/server/dns-tools/ttl/apply', 'POST', { ttl: 60, zones: [{ zone: 'a.example', expectedZoneRevision: dnsZoneRevision(a) }] }))!.json()).toMatchObject({ reconcile: 'not-connected', auditIncomplete: true, results: [{ state: 'applied' }] })
  })
})
