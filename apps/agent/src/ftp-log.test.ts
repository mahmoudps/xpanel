import { describe, expect, it, vi } from 'vitest'
import { isFtpLogCommand } from '../../../packages/os/src/ftp-log-command.ts'
import { handleFtpLogRoute, observeFtpLog, projectFtpLog } from './ftp-log.ts'
import type { FtpLogRouteContext, FtpLogState } from './ftp-log.ts'
import type { AgentCallerIdentity } from './server.ts'

const SINCE = '2026-10-27T00:00:00Z', UNTIL = '2026-10-27T12:00:00Z'
const t = (minute: number) => `2026-10-27T10:${String(minute).padStart(2, '0')}:00.000Z`
const rec = (message: unknown, at = t(0), extra: Record<string, unknown> = {}) =>
  JSON.stringify({ __CURSOR: 's=1;i=2', __REALTIME_TIMESTAMP: String(Date.parse(at) * 1000 + 123), __MONOTONIC_TIMESTAMP: '1', _BOOT_ID: 'b', MESSAGE: message, SYSLOG_IDENTIFIER: 'pure-ftpd', _EXE: '/usr/sbin/pure-ftpd', _SYSTEMD_UNIT: 'pure-ftpd.service', ...extra })
const ok = (stdout: string) => ({ ok: true, code: 0, stdout, stderr: '' })
const state: FtpLogState = {
  accounts: [{ id: 'A1', username: 'acme', home: '/home/acme' }, { id: 'A2', username: 'other', home: '/home/other/' }],
  serviceUsers: [{ login: 'bob@example.com', accountId: 'a1', services: { ftp: true } }, { login: 'mail@example.com', accountId: 'A1', services: { ftp: false } }],
}
const observe = (lines: string[], extra: { limit?: number; readState?: () => Promise<FtpLogState> } = {}) =>
  observeFtpLog({ run: async () => ok(lines.join('\n') + '\n'), readState: async () => state, since: SINCE, until: UNTIL, now: () => new Date('2026-10-27T12:00:00Z'), ...extra })
const bob = '(bob@example.com@203.0.113.5)'
const session = [
  rec('(?@203.0.113.5) [INFO] New connection from 203.0.113.5', t(0)),
  rec('(?@203.0.113.5) [INFO] bob@example.com is now logged in', t(0)),
  rec(`${bob} [NOTICE] /home/acme//public_html/index.html uploaded  (1234 bytes, 5.67KB/sec)`, t(1)),
  rec(`${bob} [NOTICE] /home/acme/./public_html/logo.png downloaded  (2048 bytes, 100.00KB/sec)`, t(2)),
  rec(`${bob} [NOTICE] Deleted /home/acme//old file.txt`, t(3)),
  rec(`${bob} [NOTICE] /home/other//secret.txt downloaded  (10 bytes, 0.01KB/sec)`, t(3)),
  rec(`${bob} [INFO] Logout.`, t(4)),
]
const attack = [
  ...Array.from({ length: 6 }, (_, i) => rec('(?@198.51.100.7) [WARNING] Authentication failed for user [' + (i % 2 ? 'admin' : 'root') + ']', t(10 + i))),
  rec('(?@198.51.100.7) [WARNING] Authentication failed for user [root]', t(40)),
  rec('(?@198.51.100.7) [INFO] Timeout - try typing a little faster next time', t(41)),
]
const unmapped = rec('(carol@other.test@2001:db8::1) [NOTICE] /srv/ftp//file.bin downloaded  (10 bytes, 0.01KB/sec)', t(5))
const caller = (extra: Partial<AgentCallerIdentity> = {}): AgentCallerIdentity => ({ principalId: '00000000-0000-4000-8000-000000000001', actor: 'root', role: 'root', accountId: null, resellerId: null, ...extra })

describe('pure-ftpd journal parser', () => {
  it('parses sessions, maps paths to the saved account home and keeps foreign or unmapped paths absolute', async () => {
    const view = projectFtpLog(await observe([...session, unmapped]), {})
    expect(view).toMatchObject({ scope: 'server', state: 'read', accountMapping: 'read', counts: { records: 8, events: 8, skipped: 0, unparsed: 0, untrusted: 0 }, lineLimitReached: false, matched: 8, omittedEvents: 0, matchedSummary: null })
    expect(view.events.map(event => [event.kind, event.user, event.account, event.client, event.path, event.pathBase, event.bytes])).toEqual([
      ['download', 'carol@other.test', null, '2001:db8::1', '/srv/ftp/file.bin', 'host', 10],
      ['logout', 'bob@example.com', 'acme', '203.0.113.5', null, null, null],
      ['download', 'bob@example.com', 'acme', '203.0.113.5', '/home/other/secret.txt', 'host', 10],
      ['delete', 'bob@example.com', 'acme', '203.0.113.5', 'old file.txt', 'home', null],
      ['download', 'bob@example.com', 'acme', '203.0.113.5', 'public_html/logo.png', 'home', 2048],
      ['upload', 'bob@example.com', 'acme', '203.0.113.5', 'public_html/index.html', 'home', 1234],
      ['login', 'bob@example.com', 'acme', '203.0.113.5', null, null, null],
      ['connect', null, null, '203.0.113.5', null, null, null],
    ])
    expect(view.events[0]!.at).toBe(t(5))
  })
  it('rejects forged identifiers, counts malformed lines and skips other pure-ftpd lines', async () => {
    const forged = `${bob} [NOTICE] /home/acme//x uploaded  (1 bytes, 0.01KB/sec)`
    const view = projectFtpLog(await observe([
      rec(forged, t(0), { _EXE: '/usr/bin/logger' }), rec(forged, t(0), { _SYSTEMD_UNIT: 'session-3.scope' }), rec(forged, t(0), { _EXE: undefined }), rec(forged, t(0), { _EXE: '/home/acme/pure-ftpd' }),
      '{not json', rec([1, 2]), rec(null), rec(forged, t(0), { SYSLOG_IDENTIFIER: 'sshd' }), rec('no envelope here'), rec('(bob with space@1.2.3.4) [INFO] Logout.'),
      rec('(?@203.0.113.5) [INFO] Can\'t change directory to /x'), rec('(?@203.0.113.5) [DEBUG] Command [pass] [<*>]'), rec('(?@203.0.113.5) [NOTICE] bob is now logged in'),
      rec('(?@?) [INFO] New connection from 203.0.113.5'), rec('(?@203.0.113.5) Server crashed'), rec(`${bob} [NOTICE] /home/acme//x uploaded (1 bytes, 0.01KB/sec)`),
      '-- No entries --',
    ]), {})
    expect(view.counts).toEqual({ records: 16, events: 0, skipped: 6, unparsed: 6, untrusted: 4 })
    expect(view.events).toEqual([])
  })
  it('keeps crafted file names inside their own event and never forges a login or failure', async () => {
    const view = projectFtpLog(await observe([
      rec(`${bob} [NOTICE] /home/acme//x@6.6.6.6) [WARNING] Authentication failed for user [root] uploaded  (5 bytes, 0.01KB/sec)`),
      rec(`${bob} [NOTICE] Deleted /home/acme//evil is now logged in`),
      rec(`${bob} [NOTICE] /home/acme//a uploaded  (999 bytes, 1.00KB/sec) uploaded  (7 bytes, 0.01KB/sec)`),
    ]), {})
    expect(view.events.map(event => [event.kind, event.client, event.path, event.bytes])).toEqual([
      ['upload', '203.0.113.5', 'a uploaded  (999 bytes, 1.00KB/sec)', 7], ['delete', '203.0.113.5', 'evil is now logged in', null], ['upload', '203.0.113.5', 'x@6.6.6.6) [WARNING] Authentication failed for user [root]', 5],
    ])
    expect(view.summary.logins).toEqual({ succeeded: 0, failed: 0 })
  })
  it('aggregates logins, transfers, top users and clients, and failed-login bursts per client', async () => {
    const { summary } = projectFtpLog(await observe([...session, ...attack, unmapped]), {})
    expect(summary).toMatchObject({ events: 16, connections: 1, logins: { succeeded: 1, failed: 7 }, transfers: { uploads: 1, uploadBytes: 1234, downloads: 3, downloadBytes: 2068, deletes: 1 } })
    expect(summary.topUsers).toEqual([
      { user: 'bob@example.com', account: 'acme', events: 6, logins: 1, failures: 0, uploads: 1, downloads: 2, bytes: 3292 },
      { user: 'root', account: null, events: 4, logins: 0, failures: 4, uploads: 0, downloads: 0, bytes: 0 },
      { user: 'admin', account: null, events: 3, logins: 0, failures: 3, uploads: 0, downloads: 0, bytes: 0 },
      { user: 'carol@other.test', account: null, events: 1, logins: 0, failures: 0, uploads: 0, downloads: 1, bytes: 10 },
    ])
    expect(summary.topClients).toEqual([
      { client: '198.51.100.7', events: 8, connections: 0, logins: 0, failures: 7 }, { client: '203.0.113.5', events: 7, connections: 1, logins: 1, failures: 0 }, { client: '2001:db8::1', events: 1, connections: 0, logins: 0, failures: 0 },
    ])
    // The 7th failure comes 25 minutes later, outside the 10-minute gap, so it does not extend the burst.
    expect(summary.failureBursts).toEqual([{ client: '198.51.100.7', failures: 6, users: 2, firstAt: t(10), lastAt: t(15) }])
  })
  it('filters events and returns the matched summary as the per-user drill-down', async () => {
    const observation = await observe([...session, ...attack, unmapped])
    const kinds = (filters: Parameters<typeof projectFtpLog>[1]) => projectFtpLog(observation, filters).events.map(event => event.kind)
    expect(kinds({ user: 'root' })).toEqual(['login-failed', 'login-failed', 'login-failed', 'login-failed'])
    expect(kinds({ client: '2001:db8::1' })).toEqual(['download'])
    expect(kinds({ kind: 'upload' })).toEqual(['upload'])
    expect(kinds({ text: 'public_html' })).toEqual(['download', 'upload'])
    expect(kinds({ text: 'acme' })).toHaveLength(6)
    expect(kinds({ user: 'Bob@example.com' })).toEqual([])
    const drill = projectFtpLog(observation, { user: 'bob@example.com' })
    expect(drill.summary.events).toBe(16)
    expect(drill.matchedSummary).toMatchObject({ events: 6, logins: { succeeded: 1, failed: 0 }, transfers: { uploads: 1, downloads: 2, deletes: 1 }, topUsers: [{ user: 'bob@example.com', account: 'acme' }], topClients: [{ client: '203.0.113.5', events: 6 }] })
  })
  it('bounds remote text, reports the line limit and keeps the response under 1 MiB', async () => {
    const long = 'é'.repeat(200) + '\u202E\u0007'
    const clipped = projectFtpLog(await observe([rec(`(?@203.0.113.5) [WARNING] Authentication failed for user [${long}]`), rec('(?@203.0.113.5) [INFO] Logout.')], { limit: 2 }), {})
    expect(Buffer.byteLength(clipped.events[1]!.user!)).toBeLessThanOrEqual(254)
    expect(clipped.events[1]!.user).not.toMatch(/[\u202E\u0007]/)
    expect(clipped.lineLimitReached).toBe(true)
    const lines = Array.from({ length: 6000 }, (_, i) => rec(`${bob} [NOTICE] /home/acme//${'d'.repeat(200)}/file-${i}.txt uploaded  (${i} bytes, 1.00KB/sec)`))
    const view = projectFtpLog(await observe(lines), {})
    expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThan(1024 * 1024)
    expect(view.omittedEvents).toBeGreaterThan(0)
    expect(view.events.length + view.omittedEvents).toBe(6000)
    expect(view.events[0]!.path).toContain('file-5999.txt')
    expect(view.summary.transfers.uploads).toBe(6000)
  })
  it('reports truthful unavailable states and never runs another command', async () => {
    expect(await observeFtpLog({ run: null, readState: async () => state, since: SINCE, until: UNTIL })).toMatchObject({ state: 'unavailable', reason: 'journal_unavailable', accountMapping: 'not-read', events: [] })
    expect(await observeFtpLog({ run: async () => ({ ok: false, code: 1, stdout: '', stderr: 'No journal files were found.' }), readState: async () => state, since: SINCE, until: UNTIL })).toMatchObject({ state: 'unavailable', reason: 'journal_unavailable' })
    expect(await observeFtpLog({ run: async () => { throw new Error('spawn') }, readState: async () => state, since: SINCE, until: UNTIL })).toMatchObject({ state: 'unavailable' })
    expect(await observeFtpLog({ run: async () => ok('x'.repeat(16 * 1024 * 1024 + 1)), readState: async () => state, since: SINCE, until: UNTIL })).toMatchObject({ state: 'unavailable', reason: 'output_limit' })
    const run = vi.fn(async (_argv: string[]) => ok(''))
    expect(await observeFtpLog({ run, readState: async () => state, since: SINCE, until: UNTIL })).toMatchObject({ state: 'read', events: [], counts: { records: 0 } })
    expect(run).toHaveBeenCalledTimes(1); expect(isFtpLogCommand(run.mock.calls[0]![0])).toBe(true)
    const unmappedView = projectFtpLog(await observe(session, { readState: async () => { throw new Error('state') } }), {})
    expect(unmappedView.accountMapping).toBe('unavailable')
    expect(unmappedView.events.find(event => event.kind === 'upload')).toMatchObject({ account: null, path: '/home/acme/public_html/index.html', pathBase: 'host' })
  })
})

describe('agent FTP log route', () => {
  const context = (overrides: Partial<FtpLogRouteContext> = {}) => {
    const events: string[] = []
    const ctx: FtpLogRouteContext = {
      authenticateCaller: vi.fn(async () => { events.push('auth'); return caller() }),
      assertRootCaller: vi.fn(async () => { events.push('root') }),
      readState: vi.fn(async () => { events.push('state'); return state }),
      run: vi.fn(async (argv: string[]) => { events.push('run'); expect(isFtpLogCommand(argv)).toBe(true); return ok([...session, ...attack].join('\n')) }),
      ...overrides,
    }
    return { ctx, events }
  }
  const call = (path: string, ctx: FtpLogRouteContext, method = 'GET') => { const url = new URL('http://agent.local' + path); return handleFtpLogRoute(new Request(url, { method }), url, method, ctx) }
  it('serves the root view after root authorization and re-checks authority after the read', async () => {
    const { ctx, events } = context()
    const response = await call(`/host/ftp/log?since=${SINCE}&until=${UNTIL}&user=root&limit=500`, ctx)
    expect(events).toEqual(['auth', 'root', 'run', 'state', 'auth', 'root'])
    expect((ctx.run as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain('500')
    expect(response!.headers.get('cache-control')).toBe('no-store')
    const body = await response!.json() as { scope: string; matched: number; filters: object; matchedSummary: { logins: { failed: number } } }
    expect(body).toMatchObject({ scope: 'server', matched: 4, filters: { user: 'root' }, matchedSummary: { logins: { failed: 4 } } })
  })
  it('refuses a non-root caller before reading the journal or saved state', async () => {
    const { ctx } = context({ assertRootCaller: vi.fn(async () => { throw Object.assign(new Error('denied'), { code: 'FORBIDDEN' }) }) })
    await expect(call(`/host/ftp/log?since=${SINCE}&until=${UNTIL}`, ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(ctx.run).not.toHaveBeenCalled(); expect(ctx.readState).not.toHaveBeenCalled()
  })
  it.each([
    `/host/ftp/log?since=${SINCE}`, `/host/ftp/log?since=${SINCE}&until=${UNTIL}&unit=sshd`, `/host/ftp/log?since=${SINCE}&until=${UNTIL}&since=${SINCE}`,
    `/host/ftp/log?since=2026-10-01T00:00:00Z&until=${UNTIL}`, `/host/ftp/log?since=${SINCE}&until=${UNTIL}&limit=20001`, `/host/ftp/log?since=${SINCE}&until=${UNTIL}&limit=05`,
    `/host/ftp/log?since=${SINCE}&until=${UNTIL}&kind=all`, `/host/ftp/log?since=${SINCE}&until=${UNTIL}&client=a/b`, `/host/ftp/log?since=2026-10-27T00:00:00.000Z&until=${UNTIL}`,
  ])('refuses %s with a validation error and no journal read', async path => {
    const { ctx } = context()
    await expect(call(path, ctx)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(ctx.run).not.toHaveBeenCalled()
  })
  it('discards the read when the caller changes during observation', async () => {
    let n = 0
    const { ctx } = context({ authenticateCaller: vi.fn(async () => caller(n++ ? { principalId: '00000000-0000-4000-8000-000000000002' } : {})) })
    await expect(call(`/host/ftp/log?since=${SINCE}&until=${UNTIL}`, ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('answers only GET and ignores unrelated paths', async () => {
    const { ctx } = context()
    expect(await call('/host/mail/log', ctx)).toBeNull()
    expect((await call(`/host/ftp/log?since=${SINCE}&until=${UNTIL}`, ctx, 'POST'))!.status).toBe(405)
    expect(ctx.authenticateCaller).not.toHaveBeenCalled()
  })
})
