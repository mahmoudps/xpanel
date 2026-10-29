import { describe, expect, it, vi } from 'vitest'
import type { Account, Domain, Plan } from '@xpanel/core'
import { edge } from '@xpanel/render'
import type { LogSlice } from './account-logs.ts'
import type { FtpLogObservation } from './ftp-log.ts'
import type { MailLogObservation } from './mail-log.ts'
import { UNAVAILABLE_DISK_LATENCY } from './host-metrics.ts'
import { BANDWIDTH_INTERVAL_MS, addFtpObservation, addLogLines, addMailObservation, createBandwidthMeter, emptyBandwidthLedger, enforceBandwidthLimits, handleMeteringRoute, parseBandwidthLedger, withDiskLatency, type BandwidthLedger, type BandwidthReport, type MeteringRouteContext } from './metering.ts'

const NOW = new Date('2026-10-28T12:00:00.000Z')
const ACCOUNT = '11111111-1111-4111-8111-111111111111', OTHER = '33333333-3333-4333-8333-333333333333'
const line = (time: string, bytes: number, requestBytes = 100): string => JSON.stringify({ time, host: 'alice.test', status: 200, bytes, request_bytes: requestBytes }) + '\n'
const keep = new Set(['2026-10', '2026-09'])
const web = (ledger: BandwidthLedger, month = '2026-10', id = ACCOUNT) => ledger.months[month]?.[id]?.web

describe('bandwidth log accounting', () => {
  it('counts complete lines per UTC month and leaves a trailing partial line for the next read', () => {
    const ledger = emptyBandwidthLedger(NOW)
    const text = line('2026-10-28T01:00:00+00:00', 500) + line('2026-10-01T00:30:00+02:00', 40) + line('2026-08-01T00:00:00+00:00', 9) + 'not json\n' + '{"time":"2026-10-28T02:00:00+00:00","bytes":7'
    const consumed = addLogLines(ledger, ACCOUNT, Buffer.from(text), false, keep)
    expect(consumed).toBe(Buffer.byteLength(text) - Buffer.byteLength('{"time":"2026-10-28T02:00:00+00:00","bytes":7'))
    expect(web(ledger)).toEqual({ count: 1, receivedBytes: 100, sentBytes: 500 })
    expect(web(ledger, '2026-09')).toEqual({ count: 1, receivedBytes: 100, sentBytes: 40 })
    expect(ledger.months['2026-08']).toBeUndefined()
    expect(ledger.skippedLines).toBe(1)
  })
  it('waits on a partial line but skips an oversized one that fills a whole read', () => {
    const ledger = emptyBandwidthLedger(NOW)
    expect(addLogLines(ledger, ACCOUNT, Buffer.from('{"time"'), false, keep)).toBe(0)
    expect(addLogLines(ledger, ACCOUNT, Buffer.alloc(20_000, 0x61), true, keep)).toBe(20_000)
    expect(ledger.skippedLines).toBe(1)
  })
  it('trusts only a well-formed ledger file', () => {
    expect(parseBandwidthLedger(emptyBandwidthLedger(NOW))).not.toBeNull()
    expect(parseBandwidthLedger({ ...emptyBandwidthLedger(NOW), months: { '2026-13': {} } })).toBeNull()
    expect(parseBandwidthLedger({ ...emptyBandwidthLedger(NOW), cursors: { x: { accountId: ACCOUNT, identity: '1:2', offset: -1 } } })).toBeNull()
    expect(parseBandwidthLedger({ ...emptyBandwidthLedger(NOW), journals: { mail: { state: 'read' }, ftp: { state: 'read' } } })).toBeNull()
    expect(parseBandwidthLedger('garbage')).toBeNull()
  })
})

const recipient = (address: string, status: string, at: string) => ({ address, originalAddress: null, status, dsn: '2.0.0', relay: 'local', response: null, at, attempts: 1 })
const message = (input: { queueId: string; size: number | null; sender: string | null; recipients?: ReturnType<typeof recipient>[]; removed?: boolean }) => ({
  queueId: input.queueId, firstSeen: '2026-10-28T11:00:00.000Z', lastSeen: '2026-10-28T11:00:05.000Z', sender: input.sender, size: input.size, recipientCount: null, messageId: null, client: null, saslUsername: null, expired: false,
  recipients: new Map((input.recipients ?? []).map(entry => [entry.address, entry])), lines: input.removed ? [{ kind: 'removed' }] : [],
})
const mail = (messages: ReturnType<typeof message>[]): MailLogObservation => ({ state: 'read', observedAt: NOW.toISOString(), window: { since: '', until: '' }, limit: 20000, lineLimitReached: false, counts: { records: 0, events: 0, skipped: 0, unparsed: 0, untrusted: 0 }, messages } as unknown as MailLogObservation)

describe('mail and FTP accounting', () => {
  const owners = new Map([['alice.test', ACCOUNT], ['bob.test', OTHER]])
  it('counts delivered copies inbound per recipient account and outbound for the sender account, carrying sizes across windows', () => {
    const ledger = emptyBandwidthLedger(NOW)
    addMailObservation(ledger, mail([message({ queueId: 'Q1', size: 1000, sender: 'a@alice.test' })]), owners, keep, NOW)
    expect(ledger.mailQueue.Q1).toMatchObject({ size: 1000, sender: 'a@alice.test' })
    const at = '2026-10-28T11:30:00.000Z'
    addMailObservation(ledger, mail([message({ queueId: 'Q1', size: null, sender: null, removed: true, recipients: [recipient('x@bob.test', 'sent', at), recipient('y@bob.test', 'sent', at), recipient('z@remote.example', 'sent', at), recipient('w@remote.example', 'deferred', at)] })]), owners, keep, NOW)
    expect(ledger.months['2026-10']![OTHER]!.mail).toEqual({ count: 1, receivedBytes: 2000, sentBytes: 0 })
    expect(ledger.months['2026-10']![ACCOUNT]!.mail).toEqual({ count: 1, receivedBytes: 0, sentBytes: 3000 })
    expect(ledger.mailQueue.Q1).toBeUndefined()
    addMailObservation(ledger, mail([message({ queueId: 'Q2', size: null, sender: 'a@alice.test', recipients: [recipient('x@bob.test', 'sent', at)] })]), owners, keep, NOW)
    expect(ledger.skippedLines).toBe(1)
  })
  it('counts FTP uploads as received and downloads as sent by the logged-in account', () => {
    const ledger = emptyBandwidthLedger(NOW)
    const event = (kind: string, bytes: number | null, account: string | null) => ({ at: '2026-10-28T11:00:00.000Z', kind, client: '192.0.2.1', user: account, account, path: null, pathBase: null, bytes })
    addFtpObservation(ledger, { events: [event('upload', 500, 'alice'), event('download', 70, 'alice'), event('login', null, 'alice'), event('upload', 9, 'ghost')] } as unknown as FtpLogObservation, new Map([['alice', ACCOUNT]]), keep)
    expect(ledger.months['2026-10']![ACCOUNT]!.ftp).toEqual({ count: 2, receivedBytes: 500, sentBytes: 70 })
    expect(ledger.skippedLines).toBe(1)
  })
})

const account = { id: ACCOUNT, username: 'alice', uid: 1001, gid: 1001, home: '/home/alice', primaryDomain: 'alice.test', status: 'active', planId: 'basic' } as Account
const domain = { id: 'd', accountId: ACCOUNT, name: 'alice.test', kind: 'primary', parentId: null, docRoot: '/home/alice/public_html', siteType: 'php', upstream: null, redirect: null, php: { version: '8.3' }, wildcard: false, suspended: false } as Domain
const plan = { id: 'basic', resources: { bandwidthMbMonth: 1 } } as unknown as Plan
type Window = { since: string; until: string }
const meter = (files: Record<string, { identity: string; text: string }>, clock = { at: NOW.getTime() }, journals: { mail?: (window: Window) => MailLogObservation; ftp?: (window: Window) => FtpLogObservation } = {}) => {
  let ledger: unknown = null
  const readFrom = vi.fn(async (path: string, offset: number, maxBytes: number): Promise<LogSlice> => {
    const file = files[path]
    if (!file) return { exists: false, identity: null, sizeBytes: 0, start: 0, bytes: Buffer.alloc(0) }
    const all = Buffer.from(file.text), start = Math.min(offset, all.length)
    return { exists: true, identity: file.identity, sizeBytes: all.length, start, bytes: all.subarray(start, start + maxBytes) }
  })
  const mailWindows: Window[] = []
  const readMail = journals.mail ? vi.fn(async (since: string, until: string) => { mailWindows.push({ since, until }); return journals.mail!({ since, until }) }) : null
  const readFtp = journals.ftp ? vi.fn(async (since: string, until: string) => journals.ftp!({ since, until })) : null
  const writeLedger = vi.fn(async (value: BandwidthLedger) => { ledger = structuredClone(value) })
  const instance = createBandwidthMeter({ onError: error => { throw error }, readState: async () => ({ accounts: [account], domains: [domain], plans: [plan] }), readFrom, readMail, readFtp, readLedger: async () => ledger, writeLedger, now: () => new Date(clock.at) })
  return { instance, readFrom, writeLedger, clock, mailWindows, ledger: () => ledger as BandwidthLedger | null }
}

describe('bandwidth meter', () => {
  const path = edge.nginxAccessLog('alice.test')
  it('reports unavailable before the first collection, never zero', async () => {
    const { instance } = meter({})
    expect(await instance.report()).toMatchObject({ state: 'unavailable', since: null, accounts: [{ username: 'alice', month: { web: null, mail: null, ftp: null }, totalBytes: null, limitState: 'unmeasured', enforced: false, limited: false }] })
  })
  it('counts incrementally, rate-limits collections and restarts a rotated log at zero', async () => {
    const files = { [path]: { identity: '1:10', text: line('2026-10-28T01:00:00Z', 1000) } }
    const { instance, readFrom, clock, ledger } = meter(files)
    await instance.collect()
    expect(ledger()?.cursors[path]).toMatchObject({ identity: '1:10', offset: Buffer.byteLength(files[path]!.text) })
    files[path]!.text += line('2026-10-28T02:00:00Z', 24)
    await instance.collect(); expect(readFrom).toHaveBeenCalledTimes(1)
    clock.at += BANDWIDTH_INTERVAL_MS; await instance.collect()
    expect(web(ledger()!)).toEqual({ count: 2, receivedBytes: 200, sentBytes: 1024 })
    files[path] = { identity: '1:11', text: line('2026-10-28T03:00:00Z', 1) }
    await instance.collect(true)
    expect(web(ledger()!)?.sentBytes).toBe(1025)
    const report = await instance.report()
    expect(report.accounts[0]).toMatchObject({ username: 'alice', domain: 'alice.test', month: { web: { count: 3, sentBytes: 1025 }, mail: null, ftp: null }, totalBytes: 1325, limitBytes: 1048576, usedPercent: 0.1, limitState: 'within' })
    // Counting began mid-month and mail/FTP journals are not read here, so the month is truthfully partial.
    expect(report).toMatchObject({ state: 'partial', sources: { web: { state: 'partial' }, mail: { state: 'unavailable' }, ftp: { state: 'unavailable' } } })
  })
  it('reads journals in consecutive whole-second windows and flags an account over its plan limit', async () => {
    const big = { [path]: { identity: '1:1', text: line('2026-10-28T01:00:00Z', 2 * 1024 * 1024) } }
    const ftpEvents = (window: Window) => ({ state: 'read', lineLimitReached: false, events: [{ at: window.until.replace('Z', '.000Z'), kind: 'upload', account: 'alice', bytes: 10 }] }) as unknown as FtpLogObservation
    const { instance, clock, mailWindows, ledger } = meter(big, { at: NOW.getTime() }, { mail: () => mail([]), ftp: ftpEvents })
    await instance.collect(); clock.at += BANDWIDTH_INTERVAL_MS; await instance.collect()
    expect(mailWindows).toEqual([{ since: '2026-10-28T11:55:00Z', until: '2026-10-28T11:59:59Z' }, { since: '2026-10-28T12:00:00Z', until: '2026-10-28T12:04:59Z' }])
    expect(ledger()?.months['2026-10']?.[ACCOUNT]?.ftp).toEqual({ count: 2, receivedBytes: 20, sentBytes: 0 })
    const row = (await instance.report()).accounts[0]!
    expect(row).toMatchObject({ month: { mail: { count: 0 }, ftp: { count: 2 } }, limitState: 'over' })
    expect(row.usedPercent).toBeGreaterThan(100)
  })
  it('keeps an unreadable journal unavailable and retries the same window start', async () => {
    const { instance, clock, mailWindows, ledger } = meter({}, { at: NOW.getTime() }, { mail: () => ({ state: 'unavailable' }) as unknown as MailLogObservation })
    await instance.collect(); clock.at += BANDWIDTH_INTERVAL_MS; await instance.collect()
    expect(ledger()?.journals.mail).toMatchObject({ state: 'unavailable', since: null, next: null })
    expect(mailWindows).toHaveLength(2)
  })
  it('marks a missing site log unmeasured and drops months outside the kept window', async () => {
    const { instance, ledger } = meter({})
    await instance.collect()
    expect(ledger()?.unavailableSites).toBe(1)
    expect((await instance.report()).accounts[0]).toMatchObject({ month: { web: null }, limitState: 'unmeasured' })
    const { instance: later, clock, ledger: laterLedger } = meter({ [path]: { identity: '1:1', text: line('2026-09-30T23:00:00Z', 5) } })
    await later.collect(); clock.at = Date.parse('2026-12-01T00:00:00.000Z'); await later.collect()
    expect(laterLedger()?.months['2026-09']).toBeUndefined()
  })
})

describe('bandwidth enforcement', () => {
  const ROW: Omit<BandwidthReport['accounts'][number], 'username'> = { domain: 'x.test', status: 'active', month: { web: null, mail: null, ftp: null }, totalBytes: 2000, limitBytes: 1000, usedPercent: 200, limitState: 'over', enforced: true, limited: false }
  const report = (rows: Partial<typeof ROW & { username: string }>[], month = '2026-10'): BandwidthReport => ({ state: 'partial', month, since: NOW.toISOString(), updatedAt: NOW.toISOString(),
    sources: { web: { state: 'read', since: null }, mail: { state: 'unavailable', since: null }, ftp: { state: 'unavailable', since: null } }, pendingBytes: 0, unavailableSites: 0, skippedLines: 0,
    accounts: rows.map(row => ({ ...ROW, username: 'alice', ...row })) })
  const plans = (enforce: boolean) => [{ ...plan, enforceBandwidth: enforce }]
  const run = async (input: { report: BandwidthReport; account?: Partial<Account>; enforce?: boolean; failWrite?: boolean }) => {
    const setLimits = vi.fn(async () => { if (input.failWrite) throw new Error('revision conflict') }), audit = vi.fn(async () => undefined), reconcile = vi.fn(async () => undefined)
    const result = await enforceBandwidthLimits(input.report, { revision: 7, accounts: [{ ...account, ...input.account }], plans: plans(input.enforce ?? true) }, { setLimits, audit, reconcile })
    return { result, setLimits, audit, reconcile }
  }
  it('serves the limit page only for an active account proven over an enforced plan limit, bound to the read revision', async () => {
    const on = await run({ report: report([{}]) })
    expect(on.result).toEqual({ limited: ['alice'], lifted: [] })
    expect(on.setLimits).toHaveBeenCalledWith([{ accountId: ACCOUNT, month: '2026-10' }], 7)
    expect(on.audit).toHaveBeenCalledWith(expect.objectContaining({ actor: 'system', action: 'account.bandwidth_limited', target: 'account:alice', outcome: 'ok', detail: expect.objectContaining({ usedPercent: 200 }) }))
    expect(on.reconcile).toHaveBeenCalledTimes(1)
    for (const off of [await run({ report: report([{}]), enforce: false }), await run({ report: report([{}]), account: { status: 'suspended' } }), await run({ report: report([{ limitState: 'near', usedPercent: 90 }]) })]) {
      expect(off.setLimits).not.toHaveBeenCalled(); expect(off.reconcile).not.toHaveBeenCalled()
    }
    expect((await run({ report: report([{}]), account: { bandwidthLimitedMonth: '2026-10' } })).setLimits).not.toHaveBeenCalled()
  })
  it('lifts on month rollover, a raised limit or enforcement off, but never on missing data', async () => {
    const limited = { bandwidthLimitedMonth: '2026-09' }
    const rollover = await run({ report: report([{ limitState: 'within', usedPercent: 1 }]), account: limited })
    expect(rollover.setLimits).toHaveBeenCalledWith([{ accountId: ACCOUNT, month: null }], 7)
    expect(rollover.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'account.bandwidth_limit_lifted', detail: expect.objectContaining({ reason: 'month-rollover' }) }))
    const thisMonth = { bandwidthLimitedMonth: '2026-10' }
    expect((await run({ report: report([{ limitState: 'unlimited', limitBytes: null, usedPercent: null }]), account: thisMonth })).audit).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.objectContaining({ reason: 'limit-raised' }) }))
    expect((await run({ report: report([{}]), account: thisMonth, enforce: false })).audit).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.objectContaining({ reason: 'enforcement-off' }) }))
    expect((await run({ report: report([{ limitState: 'unmeasured', totalBytes: null, usedPercent: null }]), account: thisMonth })).setLimits).not.toHaveBeenCalled()
  })
  it('audits a failed revision-bound write and leaves the edge unchanged', async () => {
    const failed = await run({ report: report([{}]), failWrite: true })
    expect(failed.result).toEqual({ limited: [], lifted: [] })
    expect(failed.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'account.bandwidth_limited', outcome: 'failed' }))
    expect(failed.reconcile).not.toHaveBeenCalled()
  })
})

describe('metering host route', () => {
  const route = (path: string, overrides: Partial<MeteringRouteContext> = {}) => {
    const assertRoot = vi.fn(async () => ({ actor: 'root' }))
    const url = new URL('http://agent.local' + path)
    return { assertRoot, run: () => handleMeteringRoute(new Request(url), url, 'GET', { assertRoot, readIo: null, readDiskLatency: null, bandwidth: null, ...overrides }) }
  }
  it('authorizes before and after the cached read and refuses selectors', async () => {
    const { assertRoot, run } = route('/host/monitoring/io')
    const response = await run()
    expect(await response!.json()).toEqual({ state: 'unavailable', reason: 'not-sampled', observedAt: null, host: null, accounts: [], unmeasuredAccounts: 0, disk: UNAVAILABLE_DISK_LATENCY })
    expect(assertRoot).toHaveBeenCalledTimes(2)
    await expect(route('/host/monitoring/bandwidth?path=/etc').run()).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(route('/host/monitoring/bandwidth').run()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(await route('/host/monitoring/other').run()).toBeNull()
  })
  it('fills the sampler latency from the host collector; an idle disk does not make the view partial', () => {
    const host = { cpuPercent: 1, memoryUsedBytes: 1, memoryTotalBytes: 2, loadAvg1m: 0, psiSomeAvg10: 0, psiFullAvg10: 0, awaitMs: null }
    const view = { state: 'partial' as const, reason: null, observedAt: NOW.toISOString(), host, accounts: [], unmeasuredAccounts: 0 }
    const disk = (state: 'read' | 'idle', awaitMs: number | null) => ({ state, observedAt: NOW.toISOString(), intervalSeconds: 60, awaitMs, devices: [{ name: 'vda', readAwaitMs: awaitMs, writeAwaitMs: null, utilPercent: 1 }] })
    expect(withDiskLatency(view, disk('read', 4.2))).toMatchObject({ state: 'read', host: { awaitMs: 4.2 } })
    expect(withDiskLatency(view, disk('idle', null))).toMatchObject({ state: 'read', host: { awaitMs: null } })
    expect(withDiskLatency(view, UNAVAILABLE_DISK_LATENCY).state).toBe('partial')
    expect(withDiskLatency({ ...view, unmeasuredAccounts: 1 }, disk('read', 1)).state).toBe('partial')
  })
})
