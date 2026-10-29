import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { StateSnapshot } from '@xpanel/state'
import { defaultPlan, type Account } from '@xpanel/core'
import { FakeHostExecutor, type AccountSliceMetrics } from './executor.ts'
import { bandwidthCheck, evaluateServerHealth, handleServerHealthRoute, SERVER_HEALTH_THRESHOLDS } from './server-health.ts'
import type { BandwidthReport } from './metering.ts'
import type { ServerHealthReport, ServerHealthRouteContext, ServerHealthSaved } from './server-health.ts'

const at = '2026-10-27T10:00:00.000Z'
const now = () => new Date(at)
const day = 86_400_000
const DF = `Filesystem Type 1B-blocks Used Available Capacity Mounted on
/dev/sda1 ext4 1000 960 40 96% /
tmpfs tmpfs 100 100 0 100% /run
/dev/loop0 squashfs 50 50 0 100% /snap/core/1
/dev/sdb1 xfs 1000 100 900 10% /home
`
const DF_INODES = `Filesystem Inodes IUsed IFree IUse% Mounted on
/dev/sda1 100 90 10 90% /
tmpfs 10 1 9 10% /run
/dev/loop0 10 10 0 100% /snap/core/1
/dev/sdb1 0 0 0 - /home
`
const FILES: Record<string, string> = {
  '/proc/loadavg': '1.00 3.00 0.50 1/100 1234\n',
  '/proc/cpuinfo': 'processor\t: 0\nmodel name\t: Test CPU\n\nprocessor\t: 1\nmodel name\t: Test CPU\n',
  '/proc/meminfo': 'MemTotal:        1000000 kB\nMemFree:          50000 kB\nMemAvailable:     100000 kB\nSwapTotal:          1000 kB\nSwapFree:            100 kB\n',
  '/run/reboot-required': '*** System restart required ***\n',
}
class Host extends FakeHostExecutor {
  files_: Record<string, string> = { ...FILES }
  commands: string[][] = []
  failing = false
  override async readFile(path: string): Promise<string | null> { if (this.failing) throw new Error('EACCES'); return this.files_[path] ?? null }
  override async runCommand(argv: string[]) {
    this.commands.push(argv)
    if (this.failing) return { ok: false, code: 1, stdout: '', stderr: 'denied' }
    if (argv[0] === '/usr/bin/df') return { ok: true, code: 0, stdout: argv.includes('-i') ? DF_INODES : DF, stderr: '' }
    if (argv[0] === '/usr/bin/systemctl') return { ok: true, code: 0, stdout: argv.at(-1) === 'nginx.service' ? 'loaded\nfailed\n' : 'loaded\nactive\n', stderr: '' }
    return { ok: false, code: 1, stdout: '', stderr: 'unexpected' }
  }
  override async readSliceMetrics(): Promise<AccountSliceMetrics | null> { return null }
}
const cert = (name: string, days: number) => ({ names: [name], notAfter: new Date(Date.parse(at) + days * day).toISOString(), autoRenew: true, source: 'acme' as const })
const saved = (overrides: Partial<ServerHealthSaved> = {}): ServerHealthSaved => ({ certificates: [cert('ok.example.test', 60), cert('soon.example.test', 5), cert('old.example.test', -1)], accounts: [], plans: [], ...overrides })
const drift = async () => ({ hasDrift: true, manifestMissing: false, generationId: 7, items: [{ path: '/etc/nginx/nginx.conf', reason: 'content_mismatch' }] })
const byId = (report: ServerHealthReport) => Object.fromEntries(report.checks.map(entry => [entry.id, entry]))

describe('server health checks', () => {
  it('accepts the saved state snapshot as its saved input', () => {
    expectTypeOf<StateSnapshot>().toExtend<ServerHealthSaved>()
  })
  it('grades each observation against the fixed thresholds with evidence', async () => {
    const host = new Host()
    const report = await evaluateServerHealth({ executor: host, family: 'debian', readDrift: drift, saved: saved(), now })
    const checks = byId(report)
    expect(report).toMatchObject({ observedAt: at, host: 'read', thresholds: SERVER_HEALTH_THRESHOLDS })
    expect(report.checks.map(entry => entry.id)).toEqual(['load', 'memory', 'swap', 'disk-space', 'disk-inodes', 'services', 'drift', 'certificates', 'reboot', 'bandwidth'])
    expect(checks.load).toMatchObject({ state: 'warning', reason: 'load_high' })
    expect(checks.load!.evidence).toContain('5m per processor=1.5')
    expect(checks.memory).toMatchObject({ state: 'warning', reason: 'memory_low' })
    expect(checks.swap).toMatchObject({ state: 'problem', reason: 'swap_exhausted' })
    expect(checks['disk-space']).toMatchObject({ state: 'problem', reason: 'filesystems_problem', omitted: 0 })
    expect(checks['disk-space']!.items!.map(entry => [entry.name, entry.reason])).toEqual([['/', 'space_full'], ['/home', 'space_ok']])
    expect(checks['disk-space']!.evidence).toContain('2 pseudo or image filesystems not graded')
    expect(checks['disk-inodes']).toMatchObject({ state: 'warning', reason: 'filesystems_warning', items: [{ name: '/', reason: 'inodes_high' }] })
    expect(checks.services).toMatchObject({ state: 'problem', reason: 'services_failed', items: [{ name: 'nginx', state: 'problem', reason: 'service_failed' }] })
    expect(checks.drift).toMatchObject({ state: 'problem', reason: 'drift_found', items: [{ name: '/etc/nginx/nginx.conf', reason: 'file_changed' }] })
    expect(checks.certificates).toMatchObject({ state: 'problem', reason: 'certificates_problem' })
    expect(checks.certificates!.items!.map(entry => [entry.name, entry.reason])).toEqual([['old.example.test', 'cert_expired'], ['soon.example.test', 'cert_expiring']])
    expect(checks.reboot).toMatchObject({ state: 'warning', reason: 'reboot_required' })
    expect(report.counts).toEqual({ ok: 0, warning: 4, problem: 5, unavailable: 1 })
    expect(host.commands.every(argv => argv[0] === '/usr/bin/df' || argv[0] === '/usr/bin/systemctl' && argv[1] === 'show')).toBe(true)
  })

  it('applies threshold boundaries exactly and reports healthy values as ok', async () => {
    const host = new Host()
    host.files_['/proc/loadavg'] = '0.10 1.98 0.10 1/100 1\n'
    host.files_['/proc/meminfo'] = 'MemTotal: 1000 kB\nMemAvailable: 150 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n'
    delete host.files_['/run/reboot-required']
    const checks = byId(await evaluateServerHealth({ executor: host, family: 'debian', readDrift: async () => ({ hasDrift: false, manifestMissing: false, generationId: 7, items: [] }), saved: saved({ certificates: [cert('ok.example.test', 14)] }), now }))
    expect(checks.load).toMatchObject({ state: 'ok', reason: 'load_ok' })
    expect(checks.memory).toMatchObject({ state: 'ok', reason: 'memory_ok' })
    expect(checks.swap).toMatchObject({ state: 'ok', reason: 'swap_none' })
    expect(checks.drift).toMatchObject({ state: 'ok', reason: 'drift_none' })
    expect(checks.certificates).toMatchObject({ state: 'ok', reason: 'certificates_ok' })
    expect(checks.reboot).toMatchObject({ state: 'ok', reason: 'reboot_not_required' })
    host.files_['/proc/loadavg'] = '0 2.00 0 1/1 1\n'
    host.files_['/proc/meminfo'] = 'MemTotal: 1000 kB\nMemAvailable: 149 kB\nSwapTotal: 100 kB\nSwapFree: 50 kB\n'
    const next = byId(await evaluateServerHealth({ executor: host, family: 'debian', readDrift: null, saved: saved({ certificates: [] }), now }))
    expect(next.load!.state).toBe('warning')
    expect(next.memory!.state).toBe('warning')
    expect(next.swap).toMatchObject({ state: 'warning', reason: 'swap_high' })
    expect(next.drift).toMatchObject({ state: 'unavailable', reason: 'host_unavailable' })
    expect(next.certificates).toMatchObject({ state: 'ok', reason: 'certificates_none' })
  })

  it('reports every failed or malformed observation as unavailable, never ok', async () => {
    const host = new Host()
    host.failing = true
    const checks = byId(await evaluateServerHealth({ executor: host, family: 'debian', readDrift: async () => { throw new Error('journal') }, saved: saved({ certificates: [{ ...cert('x.example.test', 1), notAfter: 'soon' }] }), now }))
    for (const id of ['load', 'memory', 'swap', 'disk-space', 'disk-inodes', 'services', 'drift', 'reboot']) expect(checks[id]!.state).toBe('unavailable')
    expect(checks.certificates).toMatchObject({ state: 'unavailable', reason: 'certificates_unread' })
    const garbled = new Host()
    garbled.files_['/proc/loadavg'] = 'garbage'
    garbled.files_['/proc/meminfo'] = 'MemTotal: lots\n'
    const partial = byId(await evaluateServerHealth({ executor: garbled, family: 'rhel', readDrift: async () => ({ hasDrift: false, manifestMissing: false, generationId: null, items: [] }), saved: saved(), now }))
    expect(partial.load).toMatchObject({ state: 'unavailable', reason: 'load_unread' })
    expect(partial.memory).toMatchObject({ state: 'unavailable', reason: 'memory_unread' })
    expect(partial.swap).toMatchObject({ state: 'unavailable', reason: 'swap_unread' })
    expect(partial.drift).toMatchObject({ state: 'unavailable', reason: 'no_generation' })
    expect(partial.reboot).toMatchObject({ state: 'unavailable', reason: 'reboot_unsupported' })
    const offline = await evaluateServerHealth({ executor: null, family: null, readDrift: null, saved: saved(), now })
    expect(offline.host).toBe('unavailable')
    expect(offline.checks.filter(entry => entry.id !== 'certificates' && entry.id !== 'bandwidth').every(entry => entry.state === 'unavailable' && entry.reason === 'host_unavailable')).toBe(true)
  })
})

const plan = defaultPlan({ id: 'plan', name: 'Standard', featureListId: 'features' })
const accounts = ['alice', 'bob'].map((username, index) => ({ id: 'id-' + username, username, uid: 20001 + index, home: '/home/' + username, planId: 'plan', status: 'active' }) as Account)
const get = (path: string, init?: RequestInit) => new Request('http://agent.local' + path, init)
const call = (req: Request, ctx: ServerHealthRouteContext) => handleServerHealthRoute(req, new URL(req.url), req.method, ctx)
const context = (overrides: Partial<ServerHealthRouteContext> = {}) => {
  const events: string[] = []
  const ctx: ServerHealthRouteContext = {
    assertRoot: vi.fn(async (action: string) => { events.push('root:' + action); return { actor: 'root' } }),
    executor: null, family: null, readDrift: null, readResources: null, now,
    readSaved: vi.fn(async () => { events.push('saved'); return { certificates: [], accounts, plans: [plan] } }), ...overrides,
  }
  return { ctx, events }
}

describe('bandwidth health check', () => {
  const row = (username: string, totalBytes: number | null, limitBytes: number | null) => ({ username, domain: username + '.test', status: 'active' as const, month: { web: null, mail: null, ftp: null },
    totalBytes, limitBytes, usedPercent: totalBytes !== null && limitBytes ? Math.round(totalBytes / limitBytes * 1000) / 10 : null, limitState: 'within' as const, enforced: username === 'over', limited: username === 'over' })
  const report = (accounts: ReturnType<typeof row>[], state: BandwidthReport['state'] = 'partial'): BandwidthReport => ({ state, month: '2026-10', since: at, updatedAt: at,
    sources: { web: { state: 'read', since: at }, mail: { state: 'unavailable', since: null }, ftp: { state: 'unavailable', since: null } }, pendingBytes: 0, unavailableSites: 0, skippedLines: 0, accounts })
  it('grades accounts against their plan limit with alert-readable evidence and never grades unlimited plans', async () => {
    const graded = await bandwidthCheck(async () => report([row('over', 1100, 1000), row('near', 850, 1000), row('fine', 10, 1000), row('free', 9e9, null), row('blind', null, 1000)]))
    expect(graded).toMatchObject({ id: 'bandwidth', state: 'problem', reason: 'bandwidth_problem' })
    expect(graded.items!.map(entry => [entry.name, entry.state])).toEqual([['over', 'problem'], ['near', 'warning'], ['blind', 'unavailable']])
    expect(graded.items![0]!.evidence).toBe('1100 of 1000 bytes in 2026-10; limit page served (110% used)')
    expect(graded.items![1]!.evidence).toContain('; not enforced (85% used)')
    expect(graded.evidence).toContain('1 serving the limit page')
    expect(await bandwidthCheck(async () => report([row('fine', 10, 1000)]))).toMatchObject({ state: 'ok', reason: 'bandwidth_ok', items: [] })
  })
  it('is unavailable without a meter, a failed read or an unmeasured month', async () => {
    expect((await bandwidthCheck(null)).state).toBe('unavailable')
    expect((await bandwidthCheck(async () => { throw new Error('offline') })).reason).toBe('bandwidth_unread')
    expect((await bandwidthCheck(async () => report([], 'unavailable'))).state).toBe('unavailable')
  })
})

describe('agent server health routes', () => {
  it('ignores unrelated paths without authorizing', async () => {
    const { ctx } = context()
    expect(await call(get('/host/server-info'), ctx)).toBeNull()
    expect(ctx.assertRoot).not.toHaveBeenCalled()
  })
  it('authorizes root before and after each read and returns no-store reports', async () => {
    const { ctx, events } = context()
    const health = (await call(get('/host/server-health'), ctx))!
    expect(health.headers.get('cache-control')).toBe('no-store')
    expect(await health.json()).toMatchObject({ host: 'unavailable', counts: { ok: 1, unavailable: 9 } })
    expect(events).toEqual(['root:server.health.read', 'saved', 'root:server.health.read'])
    const limits = await (await call(get('/host/server-limits?username=bob&username=alice'), ctx))!.json() as { accounts: { username: string }[] }
    expect(limits.accounts.map(entry => entry.username)).toEqual(['bob', 'alice'])
    expect(events.slice(3)).toEqual(['root:server.limits.read', 'saved', 'root:server.limits.read'])
  })
  it('refuses non-root callers before any read and authority lost during the read', async () => {
    const denied = Object.assign(new Error('root role is required'), { code: 'FORBIDDEN' })
    const { ctx } = context({ assertRoot: async () => { throw denied } })
    for (const path of ['/host/server-health', '/host/server-limits?username=alice']) await expect(call(get(path), ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(ctx.readSaved).not.toHaveBeenCalled()
    let calls = 0
    const late = context({ assertRoot: async () => { if (calls++) throw denied; return { actor: 'root' } } })
    await expect(call(get('/host/server-health'), late.ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('enforces the strict request grammar and the batch bound', async () => {
    const { ctx } = context()
    expect((await call(get('/host/server-health', { method: 'POST', body: '{}' }), ctx))!.status).toBe(405)
    await expect(call(get('/host/server-health?x=1'), ctx)).rejects.toMatchObject({ code: 'VALIDATION' })
    const many = Array.from({ length: 51 }, (_, index) => 'username=u' + index).join('&')
    for (const query of ['', '?username=alice&username=alice', '?username=Alice', '?username=alice&debug=1', '?' + many]) await expect(call(get('/host/server-limits' + query), ctx)).rejects.toMatchObject({ code: 'VALIDATION' })
    const fifty = Array.from({ length: 50 }, (_, index) => 'username=u' + index).join('&')
    await expect(call(get('/host/server-limits?' + fifty), ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(call(get('/host/server-limits?username=carol'), ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
