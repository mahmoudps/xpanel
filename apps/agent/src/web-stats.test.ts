import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Account, Domain, FeatureList, Plan, WebsiteAnalyticsSnapshot } from '@xpanel/core'
import { edge } from '@xpanel/render'
import type { SiteLogChunk, WebsiteAnalyticsFeed } from './analytics.ts'
import type { BackupCommand, BackupCommandResult } from './backup-low-priority.ts'
import type { GeoipSource } from './geoip.ts'
import { createWebStats } from './web-stats.ts'
import { defaultWebStatsPolicy } from './web-stats-config.ts'
import type { WebStatsConfig } from './web-stats-config.ts'

const ACCOUNT = '0f8c9a52-6c55-4a43-9f1e-3b2a1c4d5e6f'
const LOG = edge.nginxAccessLog('alice.test')
const roots: string[] = []
afterEach(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }) })

const line = (scheme: 'http' | 'https', n: number, month = '11'): string => JSON.stringify({ time: `2026-${month}-07T10:20:${String(n % 60).padStart(2, '0')}+00:00`, host: 'alice.test', ip: '203.0.113.' + n, method: 'GET', uri: '/p' + n,
  status: 200, body_bytes: 10, bytes: 20, request_bytes: 5, request_time: 0.001, scheme, protocol: 'HTTP/1.1', upstream_time: '', cache: '', referer: '', agent: 'test' }) + '\n'
const chunk = (text: string, start = 0, identity = '1:2'): SiteLogChunk => ({ path: LOG, accountId: ACCOUNT, owners: new Map([['alice.test', { id: 'd' }]]), identity, start,
  sizeBytes: start + Buffer.byteLength(text), bytes: Buffer.from(text), readAt: '2026-11-07T11:00:00.000Z', since: '2026-11-07T10:00:00.000Z', caughtUp: true })

const setup = async (opts: { disabled?: string[]; webalizer?: string | null; fail?: (command: BackupCommand) => boolean; spoolMaxBytes?: number; config?: () => WebStatsConfig | null; backupBusy?: boolean; at?: string } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'xpanel-web-stats-'))
  roots.push(root)
  // The engines are fakes, so nothing is written under the account home.
  const home = '/home/alice'
  const account = { id: ACCOUNT, username: 'alice', uid: 1001, gid: 1001, home, primaryDomain: 'alice.test', status: 'active', planId: 'basic' } as Account
  const domain = { id: 'd', accountId: ACCOUNT, name: 'alice.test', kind: 'primary', parentId: null, docRoot: home + '/public_html', siteType: 'php', upstream: null, redirect: null, php: { version: '8.3' }, wildcard: false, suspended: false } as Domain
  const plans = [{ id: 'basic', featureListId: 'f' } as Plan], featureLists = [{ id: 'f', name: 'f', ownerId: null, disabled: opts.disabled ?? [] } as FeatureList]
  const commands: (BackupCommand & { stdin?: string })[] = [], errors: unknown[] = []
  const run = async (command: BackupCommand): Promise<BackupCommandResult> => {
    const stdin = command.stdinPath ? await readFile(command.stdinPath, 'utf8') : undefined
    commands.push({ ...command, ...(stdin !== undefined ? { stdin } : {}) })
    if (opts.fail?.(command)) return { ok: false, code: 1, stdout: '', stderr: 'failed', stdoutBytes: 0, killed: null }
    if (command.argv[0] === '/usr/bin/cat' && command.stdoutPath) await writeFile(command.stdoutPath, 'BEGIN_GENERAL 2\nTotalVisits 3\nTotalUnique 2\nEND_GENERAL\nBEGIN_DAY 1\n20261107 2 2 20 3\nEND_DAY\n')
    return { ok: true, code: 0, stdout: '', stderr: '', stdoutBytes: 0, killed: null }
  }
  const stats = createWebStats({ root: root.replaceAll('\\', '/'), readState: async () => ({ accounts: [account], domains: [domain], plans, featureLists }), run, readConfig: async () => opts.config ? opts.config() : { policy: defaultWebStatsPolicy(), choices: {}, resellerLocks: {} }, backupBusy: () => opts.backupBusy ?? false,
    engines: () => ({ awstats: '/usr/lib/cgi-bin/awstats.pl', webalizer: opts.webalizer === undefined ? '/usr/bin/webalizer' : opts.webalizer }), geoip: null, geoipReady: () => false,
    owner: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }, onError: error => { errors.push(error) }, now: () => new Date(opts.at ?? '2026-11-07T12:00:00Z'), ...(opts.spoolMaxBytes ? { spoolMaxBytes: opts.spoolMaxBytes } : {}) })
  const analytics: WebsiteAnalyticsFeed & { ingested: number } = { ingested: 0, load: async () => undefined, ingestSiteLog: () => { analytics.ingested++; return 0 }, save: async () => undefined }
  return { root: root.replaceAll('\\', '/'), stats, feed: stats.tee(analytics), analytics, commands, account, domain, errors }
}
const spool = (root: string, scheme: string, batch = false) => readFile(`${root}/spool/${ACCOUNT}_alice.test_${scheme}${batch ? '.batch' : '.log'}`, 'utf8')

describe('web statistics spool', () => {
  it('spools each metered line once per scheme, also when the meter reads the same bytes again', async () => {
    const { root, feed, analytics } = await setup()
    const text = line('http', 1) + line('https', 2)
    await feed.load(); feed.ingestSiteLog(chunk(text)); await feed.save(new Date())
    // A meter re-read after its ledger write was lost: same file, same offsets.
    await feed.load(); feed.ingestSiteLog(chunk(text)); feed.ingestSiteLog(chunk(line('http', 3), Buffer.byteLength(text))); await feed.save(new Date())
    expect((await spool(root, 'http')).split('\n').filter(Boolean)).toHaveLength(2)
    expect(await spool(root, 'https')).toContain('"GET /p2 HTTP/1.1"')
    expect(analytics.ingested).toBe(3)
  })

  it('drops bytes a save never committed and counts a gap in the read offsets as lost', async () => {
    const { root, stats, feed } = await setup()
    await feed.load(); feed.ingestSiteLog(chunk(line('http', 1))); await feed.save(new Date())
    await appendFile(`${root}/spool/${ACCOUNT}_alice.test_http.log`, 'half-written line')
    const offset = Buffer.byteLength(line('http', 1))
    feed.ingestSiteLog(chunk(line('http', 2), offset + 100)); await feed.save(new Date())
    expect(await spool(root, 'http')).toBe((await import('./web-stats-format.ts')).toCombinedLog(line('http', 1))!.text + (await import('./web-stats-format.ts')).toCombinedLog(line('http', 2))!.text)
    expect((await stats.status()).spools[`${ACCOUNT}/alice.test/http`]).toMatchObject({ lostBytes: 100 })
  })

  it('counts lines past the spool limit instead of growing without bound', async () => {
    const { stats, feed } = await setup({ spoolMaxBytes: 150 })
    await feed.load(); feed.ingestSiteLog(chunk(line('http', 1) + line('http', 2) + line('http', 3))); await feed.save(new Date())
    expect((await stats.status()).spools[`${ACCOUNT}/alice.test/http`]).toMatchObject({ dropped: 2 })
  })
})

describe('web statistics run', () => {
  it('runs each engine as the account on the spooled lines and keeps the AWStats month', async () => {
    const { root, stats, feed, commands, account, errors } = await setup()
    await feed.load(); feed.ingestSiteLog(chunk(line('http', 1) + line('http', 2))); await feed.save(new Date())
    await stats.tick(true)
    expect(errors).toEqual([])
    const awstats = commands.find(c => c.argv[0] === '/usr/lib/cgi-bin/awstats.pl')!, webalizer = commands.find(c => c.argv[0] === '/usr/bin/webalizer')!
    expect(awstats.argv).toEqual(['/usr/lib/cgi-bin/awstats.pl', '-config=alice.test', `-configdir=${root}/conf/alice/http`, '-update'])
    expect(webalizer.argv).toEqual(['/usr/bin/webalizer', '-c', '/dev/null', '-p', '-Q', '-F', 'clf', '-n', 'alice.test', '-t', 'alice.test', '-o', `${account.home}/tmp/webalizer/alice.test`, '-'])
    for (const command of commands) expect(command.runAsUser).toBe('alice')
    expect(awstats.stdin!.split('\n').filter(Boolean)).toHaveLength(2)
    expect(webalizer.stdin).toBe(awstats.stdin)
    const conf = `${root}/conf/alice/http/awstats.alice.test.conf`
    expect(await readFile(conf, 'utf8')).toContain(`DirData="${account.home}/tmp/awstats"`)
    expect((await stat(conf)).mode & 0o777).toBe(0o640)
    expect(commands.find(c => c.argv[0] === '/usr/bin/cat')!.argv).toEqual(['/usr/bin/cat', '--', `${account.home}/tmp/awstats/awstats112026.alice.test.txt`])
    const reports = (await stats.reports(ACCOUNT))!.sites['alice.test']!.http!
    expect(reports.awstats).toMatchObject({ state: 'updated' })
    expect(reports.months['2026-11']).toMatchObject({ visits: 3, unique: 2, pages: 2 })
    await expect(spool(root, 'http', true)).rejects.toThrow()
    expect((await stats.status()).lastRunAt).toBe('2026-11-07T12:00:00.000Z')
  })

  it('retries only the engine that failed and never feeds a finished engine the same lines', async () => {
    let failing = true
    const { root, stats, feed, commands } = await setup({ fail: command => failing && command.argv[0] === '/usr/bin/webalizer' })
    await feed.load(); feed.ingestSiteLog(chunk(line('https', 1))); await feed.save(new Date())
    await stats.tick(true)
    expect((await stats.reports(ACCOUNT))!.sites['alice.test']!.https!.webalizer).toMatchObject({ state: 'failed', reason: 'exit 1' })
    expect(await spool(root, 'https', true)).toContain('/p1')
    failing = false
    commands.length = 0
    await stats.tick(true)
    expect(commands.map(c => c.argv[0])).toEqual(['/usr/bin/mkdir', '/usr/bin/webalizer'])
    await expect(spool(root, 'https', true)).rejects.toThrow()
  })

  it('reports engines the plan excludes or the host lacks without running them', async () => {
    const { stats, feed, commands } = await setup({ disabled: ['Awstats'], webalizer: null })
    await feed.load(); feed.ingestSiteLog(chunk(line('http', 1))); await feed.save(new Date())
    await stats.tick(true)
    expect(commands).toEqual([])
    expect((await stats.reports(ACCOUNT))!.sites['alice.test']!.http).toMatchObject({ awstats: { state: 'not-entitled' }, webalizer: { state: 'unavailable', reason: 'not installed' } })
  })

  it('gives an engine turned off in the Metrics Editor no new lines at the next run', async () => {
    const { stats, feed, commands } = await setup({ config: () => ({ policy: defaultWebStatsPolicy(), choices: { [ACCOUNT]: { 'alice.test': ['awstats'] } }, resellerLocks: {} }) })
    await feed.load(); feed.ingestSiteLog(chunk(line('http', 1))); await feed.save(new Date())
    await stats.tick(true)
    expect(commands.some(c => c.argv[0] === '/usr/bin/webalizer')).toBe(false)
    expect(commands.some(c => c.argv[0] === '/usr/lib/cgi-bin/awstats.pl')).toBe(true)
    expect((await stats.reports(ACCOUNT))!.sites['alice.test']!.http).toMatchObject({ awstats: { state: 'updated' }, webalizer: { state: 'not-selected' } })
  })

  it('writes the policy into the AWStats configuration and prepares the include as the account', async () => {
    const { root, stats, feed, commands, account } = await setup({ config: () => ({ policy: { ...defaultWebStatsPolicy(), allowInclude: true, reverseDns: true }, choices: {}, resellerLocks: {} }) })
    await feed.load(); feed.ingestSiteLog(chunk(line('https', 1))); await feed.save(new Date())
    await stats.tick(true)
    const include = `${account.home}/tmp/awstats/awstats.conf.include`
    expect(commands.find(c => c.argv[0] === '/usr/bin/touch')).toMatchObject({ argv: ['/usr/bin/touch', '--', include], runAsUser: 'alice' })
    const conf = (await readFile(`${root}/conf/alice/https/awstats.alice.test.conf`, 'utf8')).split('\n')
    expect(conf).toContain(`Include "${include}"`)
    expect(conf).toContain('DNSLookup=1')
  })

  it('keeps every spool and starts nothing while the saved configuration needs review', async () => {
    const { root, stats, feed, commands, errors } = await setup({ config: () => null })
    await feed.load(); feed.ingestSiteLog(chunk(line('http', 1))); await feed.save(new Date())
    await stats.tick(true)
    expect(commands).toEqual([])
    expect(errors).toHaveLength(1)
    expect(await spool(root, 'http')).toContain('/p1')
  })

  it('waits out a blackout hour and a running backup on a scheduled tick', async () => {
    const blackout = await setup({ at: '2026-11-07T03:10:00Z', config: () => ({ policy: { ...defaultWebStatsPolicy(), blackoutHours: [3] }, choices: {}, resellerLocks: {} }) })
    await blackout.feed.load(); blackout.feed.ingestSiteLog(chunk(line('http', 1))); await blackout.feed.save(new Date())
    await blackout.stats.tick()
    expect(blackout.commands).toEqual([])
    const backup = await setup({ backupBusy: true })
    await backup.feed.load(); backup.feed.ingestSiteLog(chunk(line('http', 1))); await backup.feed.save(new Date())
    await backup.stats.tick()
    expect(backup.commands).toEqual([])
    expect((await backup.stats.status()).lastRunAt).toBeNull()
  })

  it('processes one account on request without moving the schedule, and refuses while a run holds the slot', async () => {
    const { stats, feed, commands } = await setup()
    await feed.load(); feed.ingestSiteLog(chunk(line('http', 1))); await feed.save(new Date())
    expect(stats.processNow(ACCOUNT)).toBe(true)
    expect(stats.processNow(ACCOUNT)).toBe(false)
    await stats.tick()
    expect(commands.some(c => c.argv[0] === '/usr/bin/webalizer')).toBe(true)
    expect(await stats.status()).toMatchObject({ lastRunAt: null, running: false, accounts: { [ACCOUNT]: '2026-11-07T12:00:00.000Z' } })
  })

  it('withholds the Analog lists when the plan or the saved choice turns Analog off, and keeps totals', async () => {
    const snapshot = { totals: { requests: 4 }, topPaths: [{ key: '/', requests: 4, bytes: 9 }], topReferrers: [{ key: 'r', requests: 1, bytes: 1 }], topClientIps: [] } as unknown as WebsiteAnalyticsSnapshot
    const site = { name: 'alice.test' }, disabled: string[] = []
    const { stats, account, domain } = await setup({ config: () => ({ policy: defaultWebStatsPolicy(), choices: { [ACCOUNT]: { 'alice.test': ['awstats'] } }, resellerLocks: {} }) })
    const store = { getPlan: async () => ({ featureListId: 'f' }) as Plan, getFeatureList: async () => ({ id: 'f', name: 'f', ownerId: null, disabled }) as FeatureList, listDomains: async () => [domain] }
    expect(await stats.trafficView(snapshot, account, site, store)).toEqual({ ...snapshot, topPaths: [], topReferrers: [], topClientIps: [], analog: 'off' })
    const { stats: open, account: same } = await setup()
    expect(await open.trafficView(snapshot, same, site, store)).toBe(snapshot)
    disabled.push('Analog Stats')
    expect((await open.trafficView(snapshot, same, site, store)).analog).toBe('off')
  })

  it('adds visitor countries from the local database and leaves them out without one', async () => {
    const snapshot = { topClientIps: [{ key: '203.0.113.1', requests: 2, bytes: 3 }, { key: '198.51.100.1', requests: 1, bytes: 1 }] } as WebsiteAnalyticsSnapshot
    const { stats } = await setup()
    expect(await stats.withVisitorCountries(snapshot)).toBe(snapshot)
    const located = createWebStats({ root: '/nonexistent', readState: async () => ({ accounts: [], domains: [], plans: [], featureLists: [] }), readConfig: async () => null, run: async () => ({ ok: true, code: 0, stdout: '', stderr: '', stdoutBytes: 0, killed: null }),
      engines: () => ({ awstats: null, webalizer: null }), geoip: { countries: async () => new Map([['203.0.113.1', 'DE']]) } as unknown as GeoipSource, geoipReady: () => true })
    expect((await located.withVisitorCountries(snapshot)).topClientIps).toEqual([{ key: '203.0.113.1', requests: 2, bytes: 3, country: 'DE' }, { key: '198.51.100.1', requests: 1, bytes: 1 }])
  })
})
