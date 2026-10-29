import { describe, expect, it, vi } from 'vitest'
import { fail, isXpanelError } from '@xpanel/core'
import { MONITORING_PS_ARGV } from '../../../packages/os/src/monitoring-command.ts'
import { handleHostMonitoringRoute } from './host-monitoring-route.ts'
import type { HostMonitoringCaller, HostMonitoringRouteContext } from './host-monitoring-route.ts'

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0)
const root: HostMonitoringCaller = { principalId: 'p-root', actor: 'root', role: 'root' }
const PS = '   1  0     0 root  0.0 0.1 12000 86400 Ss systemd\n4242  1 20001 alice 1.5 1.0 20480   120 S  php-fpm8.3\n'
const body = { pid: 4242, uid: 20001, comm: 'php-fpm8.3', startedAt: new Date(NOW - 120_000).toISOString(), signal: 'TERM' }
const context = (overrides: Partial<HostMonitoringRouteContext> = {}) => {
  let reads = 0
  const run = vi.fn(async (argv: string[]) => {
    if (argv.join(' ') === MONITORING_PS_ARGV.join(' ')) return { ok: true, stdout: reads++ ? PS.split('\n')[0]! : PS, stderr: '' }
    if (argv[0] === '/usr/bin/kill' || argv[0] === '/usr/bin/journalctl') return { ok: true, stdout: '', stderr: '' }
    return { ok: false, stdout: '', stderr: '' }
  })
  const audit = vi.fn(async (_entry: { action: string; outcome: string }) => {})
  const assertRoot = vi.fn(async (caller: HostMonitoringCaller) => { if (caller.role !== 'root') fail('FORBIDDEN', 'root role is required') })
  const ctx: HostMonitoringRouteContext = { caller: root, reauthenticate: async () => root, assertRoot, run, listAccounts: async () => [{ username: 'alice', uid: 20001, status: 'active' }], audit, self: { pid: 900, ppid: 899 }, now: () => new Date(NOW), sleep: async () => {}, ...overrides }
  return { ctx, run, audit, assertRoot }
}
const call = (path: string, ctx: HostMonitoringRouteContext, init: RequestInit = {}) => {
  const url = new URL('http://agent.local' + path)
  return handleHostMonitoringRoute(new Request(url, init), url, init.method ?? 'GET', ctx)
}
const post = (value: unknown, type = 'application/json'): RequestInit => ({ method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(value) })
const refusal = async (promise: Promise<unknown>) => { try { await promise; return 'resolved' } catch (error) { return isXpanelError(error) ? [error.code, error.detail.stateChanged] : String(error) } }

describe('host monitoring agent route', () => {
  it('ignores other paths and requires root before any host read', async () => {
    const { ctx, run } = context({ caller: { principalId: 'p-user', actor: 'alice', role: 'user' } })
    expect(await call('/host/info', ctx)).toBeNull()
    for (const path of ['/host/monitoring/processes', '/host/monitoring/disk', '/host/monitoring/logs?unit=nginx.service']) expect(await refusal(call(path, ctx))).toEqual(['FORBIDDEN', false])
    expect(await refusal(call('/host/monitoring/processes/signal', ctx, post(body)))).toEqual(['FORBIDDEN', false])
    expect(run).not.toHaveBeenCalled()
  })
  it('enforces methods and refuses selectors on fixed reads', async () => {
    const { ctx, run } = context()
    expect((await call('/host/monitoring/processes', ctx, { method: 'DELETE' }))!.status).toBe(405)
    expect((await call('/host/monitoring/processes/signal', ctx))!.headers.get('allow')).toBe('POST')
    for (const path of ['/host/monitoring/processes?user=alice', '/host/monitoring/disk?path=/home', '/host/monitoring/logs?unit=cron.service', '/host/monitoring/logs?unit=nginx.service&grep=x', '/host/monitoring/logs?unit=nginx.service&priority=9'])
      expect(await refusal(call(path, ctx))).toEqual(['VALIDATION', false])
    expect(run).not.toHaveBeenCalled()
  })
  it('returns unavailable observations without a native executor and no-store reads with one', async () => {
    const bare = context({ run: undefined }).ctx
    expect(await (await call('/host/monitoring/processes', bare))!.json()).toMatchObject({ state: 'unavailable', items: [], reason: 'process-list-unavailable' })
    expect(await (await call('/host/monitoring/disk', bare))!.json()).toMatchObject({ filesystems: { state: 'unavailable' }, accounts: { state: 'unavailable' } })
    expect(await (await call('/host/monitoring/logs?unit=sshd.service', bare))!.json()).toMatchObject({ state: 'unavailable', unit: 'sshd.service', lines: 100 })
    expect(await refusal(call('/host/monitoring/processes/signal', bare, post(body)))).toEqual(['PRECONDITION_FAILED', false])
    const { ctx, run } = context()
    const response = (await call('/host/monitoring/processes', ctx))!
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ state: 'read', total: 2, accounts: [{ username: 'alice', processes: 1 }] })
    await call('/host/monitoring/logs?unit=nginx.service&lines=20&priority=3&since=2026-10-27T10:00Z', ctx)
    expect(run.mock.calls.at(-1)![0]).toEqual(['/usr/bin/journalctl', '--no-pager', '-o', 'json', '--output-fields=MESSAGE,PRIORITY,_SYSTEMD_UNIT,_PID', '-n', '20', '-u', 'nginx.service', '--since', '@' + String(Date.UTC(2026, 9, 27, 10) / 1000), '-p', '3'])
  })
  it('signals after a fresh root re-check and audits request and outcome', async () => {
    const { ctx, run, audit, assertRoot } = context()
    const response = (await call('/host/monitoring/processes/signal', ctx, post(body)))!
    expect(await response.json()).toMatchObject({ state: 'confirmed', pid: 4242, signal: 'TERM', verificationRequired: false })
    expect(run.mock.calls.filter(([argv]) => argv[0] === '/usr/bin/kill')).toEqual([[['/usr/bin/kill', '-s', 'TERM', '4242']]])
    expect(assertRoot).toHaveBeenCalledTimes(2)
    expect(audit.mock.calls.map(([entry]) => [entry.action, entry.outcome])).toEqual([['host.process.signal_requested', 'ok'], ['host.process.signal', 'ok']])
  })
  it('refuses changed authority, failed pre-dispatch audit and malformed bodies without signalling', async () => {
    for (const overrides of [
      { reauthenticate: async () => ({ ...root, principalId: 'p-other' }) },
      { reauthenticate: async () => ({ ...root, role: 'reseller' }) },
      { audit: vi.fn(async () => { throw new Error('db') }) },
    ]) {
      const { ctx, run } = context(overrides)
      expect((await refusal(call('/host/monitoring/processes/signal', ctx, post(body))) as unknown[])[1]).toBe(false)
      expect(run.mock.calls.some(([argv]) => argv[0] === '/usr/bin/kill')).toBe(false)
    }
    const { ctx, run } = context()
    for (const init of [post(body, 'text/plain'), post({ ...body, signal: 'KILL' }), post({ ...body, extra: true }), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }])
      expect(await refusal(call('/host/monitoring/processes/signal', ctx, init))).toEqual(['VALIDATION', false])
    expect(await refusal(call('/host/monitoring/processes/signal?pid=1', ctx, post(body)))).toEqual(['VALIDATION', false])
    expect(run).not.toHaveBeenCalled()
  })
  it('marks an unaudited outcome as requiring verification', async () => {
    const audit = vi.fn(async (entry: { action: string }) => { if (entry.action === 'host.process.signal') throw new Error('db') })
    const { ctx } = context({ audit })
    expect(await refusal(call('/host/monitoring/processes/signal', ctx, post(body)))).toEqual(['SERVICE_UNAVAILABLE', true])
  })
})
