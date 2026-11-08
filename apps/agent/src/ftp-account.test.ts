import { describe, expect, it, vi } from 'vitest'
import { anonymousFtpFiles, assertFtpWelcome, disconnectFtpSessions, ftpReportWindows, handleFtpAccountRoute, parseFtpWho, readFtpMonthlyReport, readFtpSessions, summarizeFtpMonth } from './ftp-account.ts'
import type { FtpLogEvent, FtpLogObservation } from './ftp-log.ts'

const WHO = ['1064628|?|1|IDLE||127.0.0.1|127.0.0.1|21210|0|0|0|0', '200|ftp@example.test|14|DL|/home/a/f.zip|203.0.113.9|10.0.0.1|21|10|20|50|100', '300|bob@other.test|5|UL|/x|203.0.113.8|10.0.0.1|21|1|2|50|1', '400|alice|3|IDLE||203.0.113.7|10.0.0.1|21|0|0|0|0'].join('\n') + '\n'
const account = { id: 'a1', username: 'alice' }
const now = new Date('2026-11-07T12:00:00.000Z')
const run = (stdout = WHO) => vi.fn(async (_argv: string[]) => ({ ok: true, stdout, stderr: '' }))

describe('FTP sessions', () => {
  it('parses pure-ftpwho -s and drops sessions before login', () => {
    expect(parseFtpWho(WHO)?.map(row => [row.pid, row.login, row.state])).toEqual([[200, 'ftp@example.test', 'download'], [300, 'bob@other.test', 'upload'], [400, 'alice', 'idle']])
    expect(parseFtpWho('not|a|session')).toBeNull()
    expect(parseFtpWho('')).toEqual([])
  })
  it('lists only this account\'s logins, by exact match', async () => {
    const view = await readFtpSessions(run(), account, ['ftp@example.test'], ['example.test'], now)
    expect(view.sessions.map(row => row.pid)).toEqual([200, 400])
    expect((await readFtpSessions(null, account, [], [], now)).state).toBe('unavailable')
  })
  it('kills only pids from the fresh account listing', async () => {
    const view = await readFtpSessions(run(), account, ['ftp@example.test'], [], now), kill = run('')
    await expect(disconnectFtpSessions(kill, view, 300)).rejects.toThrow(/no longer open/)
    expect(kill).not.toHaveBeenCalled()
    expect(await disconnectFtpSessions(kill, view, 200)).toEqual({ disconnected: [200] })
    expect(kill.mock.calls[0]![0]).toEqual(['/usr/bin/kill', '-s', 'TERM', '200'])
    expect((await disconnectFtpSessions(kill, view, 'all')).disconnected).toEqual([200, 400])
  })
})

describe('FTP monthly report', () => {
  const event = (kind: FtpLogEvent['kind'], user: string, bytes: number, at = '2026-11-03T08:15:00.000Z'): FtpLogEvent => ({ at, kind, client: '203.0.113.9', user, account: null, path: null, pathBase: null, bytes })
  it('splits a month into windows the journal reader accepts, ending now', () => {
    const windows = ftpReportWindows('2026-11', now)
    expect(windows[0]).toEqual({ since: '2026-11-01T00:00:00Z', until: '2026-11-07T12:00:00Z' })
    expect(ftpReportWindows('2026-10', now).at(-1)!.until).toBe('2026-11-01T00:00:00Z')
    expect(ftpReportWindows('2026-10', now).length).toBeLessThanOrEqual(5)
  })
  it('counts two downloads of the account with the correct byte total and ignores others', () => {
    const summary = summarizeFtpMonth([event('download', 'ftp@example.test', 100), event('download', 'ftp@example.test', 50, '2026-11-04T09:00:00.000Z'), event('login', 'ftp@example.test', 0), event('download', 'bob@other.test', 9)], new Set(['ftp@example.test']))
    expect(summary.totals).toEqual({ transfers: 2, downloads: 2, uploads: 0, bytes: 150 })
    expect(summary.days.map(row => row.day)).toEqual(['2026-11-03', '2026-11-04'])
    expect(summary.users).toEqual([{ user: 'ftp@example.test', transfers: 2, downloads: 2, uploads: 0, bytes: 150 }])
  })
  it('reports a partial month and never invents totals for an unread one', async () => {
    const read = vi.fn(async (): Promise<FtpLogObservation> => ({ state: 'read', observedAt: '', window: { since: '', until: '' }, limit: 1, lineLimitReached: true, counts: { records: 0, events: 0, skipped: 0, unparsed: 0, untrusted: 0 }, accountMapping: 'read', events: [] }))
    expect((await readFtpMonthlyReport(read, account, [], [], '2026-11', now)).state).toBe('partial')
    const none = await readFtpMonthlyReport(null, account, [], [], '2026-11', now)
    expect(none.state).toBe('unavailable'); expect(none.totals.transfers).toBe(0)
  })
})

describe('Anonymous FTP files', () => {
  it('prepares public_ftp as the account, opening incoming only for uploads', async () => {
    const actions: unknown[] = [], files = anonymousFtpFiles({} as never, async action => { actions.push(action) }, 'alice')
    await files.prepare('/home/alice', false)
    expect(actions).toEqual([{ kind: 'exec', argv: ['/usr/bin/mkdir', '-p', '/home/alice/public_ftp/incoming'], runAsUser: 'alice' }, { kind: 'exec', argv: ['/usr/bin/chmod', '0755', '/home/alice/public_ftp'], runAsUser: 'alice' }, { kind: 'exec', argv: ['/usr/bin/chmod', '0700', '/home/alice/public_ftp/incoming'], runAsUser: 'alice' }])
    await files.prepare('/home/alice', true)
    expect(actions.at(-1)).toEqual({ kind: 'exec', argv: ['/usr/bin/chmod', '0733', '/home/alice/public_ftp/incoming'], runAsUser: 'alice' })
  })
})

describe('owner route', () => {
  const plan = { featureListId: 'f' }, base = { id: 'a1', username: 'alice', status: 'active', planId: 'p', home: '/home/alice' }
  const deps = (over: Record<string, unknown> = {}) => ({
    caller: { role: 'user', accountId: 'a1', principalId: 'p1', actor: 'alice' },
    store: { getAccountByUsername: async () => base, getPlan: async () => plan, getFeatureList: async () => ({ disabled: [] }), listDomains: async () => [{ name: 'example.test' }], listServiceUsers: async () => [{ login: 'ftp@example.test', services: { ftp: true } }] },
    currentPrincipal: async () => ({ kind: 'user', id: 'p1', username: 'alice', accountId: 'a1', disabled: false }),
    run: run(), readLog: null, files: null, audit: vi.fn(async () => undefined), now: () => now, ...over,
  }) as unknown as Parameters<typeof handleFtpAccountRoute>[3]
  const call = (path: string, method: string, input: ReturnType<typeof deps>, body?: unknown) => handleFtpAccountRoute(new Request('http://agent' + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }), new URL('http://agent' + path), method, input)
  it('refuses another account and a plan without the tool', async () => {
    await expect(call('/accounts/alice/ftp/sessions', 'GET', deps({ caller: { role: 'user', accountId: 'a2', principalId: 'p1' } }))).rejects.toThrow(/account owner/)
    await expect(call('/accounts/alice/ftp/sessions', 'GET', deps({ store: { getAccountByUsername: async () => base, getPlan: async () => plan, getFeatureList: async () => ({ disabled: ['ftp-connections'] }) } }))).rejects.toThrow(/disabled by the account plan/)
  })
  it('disconnects and audits one owned session', async () => {
    const input = deps(), response = await call('/accounts/alice/ftp/sessions/disconnect', 'POST', input, { target: 200 })
    expect(await response!.json()).toMatchObject({ disconnected: [200] })
    expect(input.audit).toHaveBeenCalledWith(base, 'ftp.session.disconnected', { target: 200, sessions: 1 })
  })
  it('bounds the welcome message and the report month', async () => {
    expect(() => assertFtpWelcome('x'.repeat(2049))).toThrow(); expect(() => assertFtpWelcome('bad\u0000')).toThrow(); expect(assertFtpWelcome('Hello\nworld')).toBe('Hello\nworld')
    await expect(call('/accounts/alice/ftp/monthly-report?month=2030-01', 'GET', deps())).rejects.toThrow(/YYYY-MM/)
  })
})
