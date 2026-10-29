import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import type { HostJobRun, HostJobView } from './host-job-contract.ts'
import { HostJobRunner, validateHostJobPlan } from './host-jobs.ts'
import {
  DNS_CHECK_JOB_KIND, buildDnsCheckPlans, checkDnsNameservers, compareDnsZones, dnsCheckLogSections, parseDnsCheckJob, readDnsCheckLog, savedNameservers,
} from './dns-tools.ts'
import type { DnsToolsResolver, DnsToolsState } from './dns-tools.ts'
import type { ServiceDetailHost } from './service-detail.ts'

const handles: TestDbHandle[] = [], dirs: string[] = [], runners: HostJobRunner[] = []
afterEach(async () => {
  for (const runner of runners.splice(0)) runner.close()
  await Promise.all(handles.splice(0).map(handle => handle.close()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})
const until = async (check: () => Promise<boolean>): Promise<void> => { for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 5)) } throw new Error('condition not reached') }
const zoneNames = (count: number) => Array.from({ length: count }, (_, index) => `z${String(index).padStart(3, '0')}.example`)
const now = () => new Date('2026-10-27T10:00:00Z')
const ns = (zone: string, ...hosts: string[]) => hosts.map(host => ({ name: '@', type: 'NS', content: host }))
const state = (zones: DnsToolsState['zones']): DnsToolsState => ({ zones, serviceUsers: [], server: { settings: { hostname: 'panel.example.test' } } })
const dnsError = (code: string) => Object.assign(new Error(code), { code })
const zoneFile = (zone: string, serial: number) => `$ORIGIN ${zone}.\n@ 3600 IN SOA ns1.host.test. hostmaster.${zone}. ${serial} 3600 1800 1209600 3600\n@ 3600 IN NS ns1.host.test.\n`

describe('DNS check job plans', () => {
  it('pages zones into reviewed read-only jobs of at most 32 steps', () => {
    const plans = buildDnsCheckPlans(zoneNames(70))
    expect(plans.map(plan => plan.steps.length)).toEqual([32, 32, 6])
    expect(plans.map(plan => plan.summary)).toEqual(['Check DNS zones 1-32 of 70', 'Check DNS zones 33-64 of 70', 'Check DNS zones 65-70 of 70'])
    for (const plan of plans) {
      expect(plan.kind).toBe(DNS_CHECK_JOB_KIND)
      expect(() => validateHostJobPlan(plan)).not.toThrow()
      for (const step of plan.steps) {
        expect(step).toMatchObject({ mutates: false, successExitCodes: [1] })
        expect(step.title).toBe('Check zone {zone}')
        expect(step.argv).toEqual(['/usr/bin/pdnsutil', 'check-zone', step.titleValues!.zone!])
        expect(plan.policy(step.argv)).toBe(true)
      }
      expect(plan.verify).toBeUndefined()
    }
    expect(plans[1]!.steps[0]!.argv[2]).toBe('z032.example')
    // A plan admits only its own zones and only check-zone.
    expect(plans[0]!.policy(['/usr/bin/pdnsutil', 'check-zone', 'z069.example'])).toBe(false)
    expect(plans[0]!.policy(['/usr/bin/pdnsutil', 'rectify-zone', 'z000.example'])).toBe(false)
    expect(plans[0]!.policy(['/usr/bin/pdnsutil', 'check-zone', 'z000.example', '--verbose'])).toBe(false)
    expect(buildDnsCheckPlans(zoneNames(32))).toHaveLength(1)
    expect(buildDnsCheckPlans(zoneNames(33))).toHaveLength(2)
  })
  it('refuses empty, duplicate, non-canonical or oversized zone lists', () => {
    for (const bad of [[], ['a.example', 'a.example'], ['A.example'], ['--help'], ['a.example.'], zoneNames(2049)]) expect(() => buildDnsCheckPlans(bad)).toThrow(/distinct saved zones/)
    expect(buildDnsCheckPlans(zoneNames(2048))).toHaveLength(64)
  })
  it('names a long zone by position in its bounded step title', () => {
    const long = Array.from({ length: 4 }, () => 'a'.repeat(60)).join('.') + '.com'
    const [plan] = buildDnsCheckPlans([long])
    expect(plan!.steps[0]!).toMatchObject({ title: 'Check zone {zone}', titleValues: { zone: '1' } })
    expect(plan!.steps[0]!.argv[2]).toBe(long)
  })
})

describe('DNS check job log parsing', () => {
  it('reads per-zone results from a real runner log, using step exit codes as the authority', async () => {
    const handle = await createTestDb(); handles.push(handle)
    const logDir = await mkdtemp(join(tmpdir(), 'xpanel-dns-tools-')); dirs.push(logDir)
    const run: HostJobRun = async argv => {
      const zone = argv[2]
      if (zone === 'a.example') return { ok: true, code: 0, stdout: "Checked 4 records of 'a.example', 0 errors, 0 warnings.\n", stderr: '', timedOut: false }
      if (zone === 'b.example') return { ok: false, code: 1, stdout: "[Error] Following record had a problem: www.b.example IN CNAME x\n[Warning] ttl is low\nChecked 5 records of 'b.example', 1 errors, 1 warnings.\n", stderr: '', timedOut: false }
      if (zone === 'c.example') return { ok: false, code: 1, stdout: '', stderr: '[Error] No such zone in the database\n', timedOut: false }
      return { ok: false, code: null, stdout: '', stderr: '', timedOut: true }
    }
    const runner = new HostJobRunner({ db: handle.db, run, logDir }); runners.push(runner)
    const [plan] = buildDnsCheckPlans(['a.example', 'b.example', 'c.example', 'd.example', 'e.example'])
    const { job } = await runner.submit(plan!, 'root')
    await until(async () => (await runner.get(job.id))!.status === 'failed')
    const finished = (await runner.get(job.id))!
    const log = await readDnsCheckLog(runner, job.id)
    expect(log).toMatchObject({ truncated: false })
    const results = await parseDnsCheckJob(finished, log!.text)
    expect(results.map(result => [result.zone, result.state])).toEqual([['a.example', 'passed'], ['b.example', 'failed'], ['c.example', 'unavailable'], ['d.example', 'unavailable'], ['e.example', 'not-run']])
    expect(results[0]).toMatchObject({ records: 4, errors: 0, warnings: 0, messages: [] })
    expect(results[1]).toMatchObject({ records: 5, errors: 1, warnings: 1, messages: ['[Error] Following record had a problem: www.b.example IN CNAME x', '[Warning] ttl is low'] })
    expect(results[2]).toMatchObject({ records: null, errors: null, messages: ['[Error] No such zone in the database'] })
  })
  it('refuses summaries that contradict the exit code, belong to another zone or lack an exit line', async () => {
    const header = (index: number, total: number) => `\n2026-10-27T10:00:00.00${index}Z step ${index}/${total} zone-${index}`
    const log = [
      '2026-10-27T10:00:00.000Z started (attempt 1)',
      header(1, 4), '$ /usr/bin/pdnsutil check-zone a.example', "Checked 4 records of 'a.example', 0 errors, 0 warnings.", '[exit 1]',
      header(2, 4), '$ /usr/bin/pdnsutil check-zone b.example', "Checked 4 records of 'other.example', 0 errors, 0 warnings.", '[exit 0]',
      header(3, 4), '$ /usr/bin/pdnsutil check-zone c.example', "Checked 4 records of 'c.example', 0 errors, 0 warnings.",
      header(4, 4), '$ /usr/bin/pdnsutil check-zone d.example', "Checked 9 records of 'd.example', 0 errors, 2 warnings.", '[exit 0]', '2026-10-27T10:00:01.000Z job succeeded',
    ].join('\n')
    const job = (states: [string, number | null][], status: HostJobView['status'] = 'succeeded'): HostJobView => ({ id: '11111111-1111-4111-8111-111111111111', referenceCode: null, kind: DNS_CHECK_JOB_KIND, status, progress: 100, summary: 'Check DNS zones 1-4 of 4', accountId: null, actor: 'root',
      createdAt: '2026-10-27T10:00:00.000Z', startedAt: null, finishedAt: null, error: null, failureClass: null, cancelRequested: false, verification: null, logBytes: log.length,
      steps: states.map(([state, exitCode], index) => ({ id: 'zone-' + (index + 1), title: 'Check zone {zone}', titleValues: { zone: 'abcd'[index] + '.example' }, state: state as HostJobView['steps'][number]['state'], exitCode })) })
    const results = await parseDnsCheckJob(job([['succeeded', 0], ['succeeded', 0], ['succeeded', 0], ['succeeded', 0]]), log)
    expect(results.map(result => result.state)).toEqual(['unavailable', 'unavailable', 'unavailable', 'passed'])
    expect(results[3]).toMatchObject({ zone: 'd.example', warnings: 2 })
    const running = await parseDnsCheckJob(job([['succeeded', 0], ['running', null], ['pending', null], ['pending', null]], 'running'), '')
    expect(running.map(result => [result.zone, result.state])).toEqual([['a.example', 'unavailable'], ['b.example', 'pending'], ['c.example', 'pending'], ['d.example', 'pending']])
    const cancelled = await parseDnsCheckJob(job([['pending', null], ['skipped', null], ['running', null], ['failed', 2]], 'cancelled'), log)
    expect(cancelled.map(result => result.state)).toEqual(['not-run', 'not-run', 'unavailable', 'unavailable'])
  })
  it('ignores headers for another step count and keeps the first section of each step', () => {
    const sections = dnsCheckLogSections(['2026-10-27T10:00:00.000Z step 1/3 zone-1', '$ /usr/bin/pdnsutil check-zone a.example', '[exit 0]', '2026-10-27T10:00:00.000Z step 1/2 zone-1', '$ /usr/bin/pdnsutil check-zone b.example', '[exit 0]'].join('\n'), 2)
    expect(sections.get('zone-1')).toMatchObject({ zone: 'b.example', exit: 0, complete: true })
    expect(dnsCheckLogSections('2026-10-27T10:00:00.000Z step 1/1 zone-1\n$ /usr/bin/pdnsutil check-zone --help\n[exit none, timed out]', 1).get('zone-1')).toMatchObject({ zone: null, exit: null, timedOut: true })
  })
})

const host = (files: Record<string, string>): ServiceDetailHost => ({
  run: vi.fn(async (argv: string[]) => argv[0] === '/usr/bin/pdns_control' ? { ok: true, code: 0, stdout: argv[1] === 'rping' ? 'PONG\n' : '4.9.1\n', stderr: '' } : { ok: true, code: 0, stdout: 'loaded\nactive\n', stderr: '' }),
  readFile: vi.fn(async (path: string) => files[path.slice(path.lastIndexOf('/') + 1)] ?? null),
  stat: vi.fn(async () => ({ kind: 'missing' as const, sizeBytes: 0 })),
  listDirectory: vi.fn(async () => ({ state: 'read' as const, entries: Object.entries(files).map(([name, content]) => ({ name, kind: 'file' as const, sizeBytes: Buffer.byteLength(content) })), truncated: false })),
})
const resolver = (soa: Record<string, number | Error>, nsAnswers: Record<string, string[] | Error>, a: Record<string, string[] | Error> = {}, aaaa: Record<string, string[] | Error> = {}): DnsToolsResolver => {
  const pick = <T>(table: Record<string, T | Error>, key: string, missing: string): Promise<T> => { const value = Object.hasOwn(table, key) ? table[key]! : dnsError(missing); return value instanceof Error ? Promise.reject(value) : Promise.resolve(value) }
  return { soaSerial: vi.fn(zone => pick(soa, zone, 'EREFUSED')), ns: vi.fn(zone => pick(nsAnswers, zone, 'EREFUSED')), v4: vi.fn(name => pick(a, name, 'ENODATA')), v6: vi.fn(name => pick(aaaa, name, 'ENODATA')) }
}

describe('published versus saved comparison', () => {
  const saved = state([
    { name: 'ok.example', serial: 2026102701, records: ns('ok.example', 'ns1.host.test.', 'NS2.host.test') },
    { name: 'stale.example', serial: 2026102705, records: ns('stale.example', 'ns1.host.test.') },
    { name: 'gone.example', serial: 7, records: ns('gone.example', 'ns1.host.test.') },
    { name: 'nsdrift.example', serial: 3, records: ns('nsdrift.example', 'ns1.host.test.') },
  ])
  const files = { 'ok.example.zone': zoneFile('ok.example', 2026102702), 'stale.example.zone': zoneFile('stale.example', 2026102706), 'nsdrift.example.zone': zoneFile('nsdrift.example', 3), 'other.example.zone': zoneFile('other.example', 1) }
  it('flags drift per zone from an injected local resolver and opens only this page of zone files', async () => {
    const detailHost = host(files)
    const read = await compareDnsZones({ host: detailHost, state: saved, page: 1, now,
      resolver: resolver({ 'ok.example': 2026102702, 'stale.example': 2026102704, 'nsdrift.example': 3, 'gone.example': dnsError('EREFUSED') as never },
        { 'ok.example': ['ns2.host.test', 'NS1.host.test'], 'stale.example': ['ns1.host.test'], 'nsdrift.example': ['ns9.elsewhere.test'], 'gone.example': dnsError('EREFUSED') as never }) })
    expect(read).toMatchObject({ observedAt: '2026-10-27T10:00:00.000Z', server: '127.0.0.1', control: 'reachable', page: 1, pages: 1, total: 4 })
    const byZone = Object.fromEntries(read.zones.map(row => [row.zone, row]))
    expect(read.zones.map(row => row.zone)).toEqual(['gone.example', 'nsdrift.example', 'ok.example', 'stale.example'])
    expect(byZone['ok.example']).toEqual({ zone: 'ok.example', saved: { stateSerial: 2026102701, file: 'parsed', fileSerial: 2026102702, ns: ['ns1.host.test', 'ns2.host.test'] }, live: { state: 'answered', serial: 2026102702, nsState: 'answered', ns: ['ns1.host.test', 'ns2.host.test'] }, drift: [] })
    expect(byZone['stale.example']!.drift).toEqual(['serial-differs-from-file', 'serial-behind-saved'])
    expect(byZone['gone.example']).toMatchObject({ saved: { file: 'missing', fileSerial: null }, live: { state: 'refused', serial: null, nsState: 'refused', ns: [] }, drift: ['not-answered', 'file-not-parsed', 'ns-not-answered'] })
    expect(byZone['nsdrift.example']!.drift).toEqual(['ns-differs'])
    expect(detailHost.readFile).not.toHaveBeenCalledWith('/var/lib/powerdns/zones/other.example.zone')
  })
  it('treats a malformed answer as unavailable and pages by 25 zones', async () => {
    const many = state(zoneNames(30).map(name => ({ name, serial: 1, records: [] })))
    const second = await compareDnsZones({ host: host({}), state: many, page: 2, resolver: resolver({ 'z025.example': -1 }, { 'z025.example': [''] }) })
    expect(second).toMatchObject({ page: 2, pages: 2, total: 30 })
    expect(second.zones).toHaveLength(5)
    expect(second.zones[0]).toMatchObject({ zone: 'z025.example', live: { state: 'unavailable', serial: null, nsState: 'unavailable' } })
    await expect(compareDnsZones({ host: host({}), state: many, page: 3, resolver: resolver({}, {}) })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

describe('nameserver check', () => {
  it('resolves saved nameservers locally, marks this server and never queries another address', async () => {
    const saved = state([
      { name: 'a.example', serial: 1, records: ns('a.example', 'ns1.a.example.', 'ns2.other.test.', 'ns3.gone.example.', 'ns4.a.example.') },
      { name: 'b.example', serial: 1, records: ns('b.example', 'ns1.a.example.') },
      { name: 'c.example', serial: 1, records: [] },
    ])
    const dns = resolver({ 'a.example': 1, 'c.example': 1, 'b.example': dnsError('ESERVFAIL') as never }, {},
      { 'ns1.a.example': ['203.0.113.10'], 'ns3.gone.example': dnsError('ENOTFOUND') as never, 'ns4.a.example': ['198.51.100.7'], 'ns2.other.test': dnsError('EREFUSED') as never },
      { 'ns1.a.example': ['2001:DB8::10'], 'ns3.gone.example': dnsError('ENOTFOUND') as never, 'ns2.other.test': dnsError('EREFUSED') as never })
    const read = await checkDnsNameservers({ state: saved, resolver: dns, localAddresses: () => ['203.0.113.10', '127.0.0.1'], page: 1, now })
    expect(read).toMatchObject({ server: '127.0.0.1', page: 1, pages: 1, total: 3 })
    const [a, b, c] = read.zones
    expect(a!.soa).toBe('answered')
    expect(a!.nameservers).toEqual([
      { host: 'ns1.a.example', state: 'answered', addresses: [{ address: '203.0.113.10', thisServer: true }, { address: '2001:db8::10', thisServer: false }], result: 'answers' },
      { host: 'ns2.other.test', state: 'refused', addresses: [], result: 'not-local' },
      { host: 'ns3.gone.example', state: 'nxdomain', addresses: [], result: 'not-resolved' },
      { host: 'ns4.a.example', state: 'answered', addresses: [{ address: '198.51.100.7', thisServer: false }], result: 'other-server' },
    ])
    expect(b).toMatchObject({ soa: 'servfail', nameservers: [{ host: 'ns1.a.example', result: 'no-answer' }] })
    expect(c).toEqual({ zone: 'c.example', soa: 'answered', nameservers: [], truncated: false })
    // Each distinct host is resolved once per page; no address is ever queried directly.
    expect(dns.v4).toHaveBeenCalledTimes(4)
    expect(Object.keys(dns)).toEqual(['soaSerial', 'ns', 'v4', 'v6'])
  })
  it('bounds nameservers per zone and reads apex NS records only', () => {
    expect(savedNameservers({ name: 'a.example', serial: 1, records: [...ns('a.example', 'NS1.A.example.', 'ns1.a.example'), { name: 'sub', type: 'NS', content: 'ns9.a.example.' }, { name: '@', type: 'A', content: '192.0.2.1' }] })).toEqual(['ns1.a.example'])
  })
})
