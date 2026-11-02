import { describe, expect, it } from 'vitest'
import { services } from '@xpanel/render'
import type { RenderedFile } from '@xpanel/core'
import { FakeHostExecutor } from '../executor.ts'
import {
  createNativeDnsReconcileProvider, effectiveBindBackend, MAX_DNS_OBSERVATION_BYTES, parseObservedAxfr,
} from './dns-native.ts'
import { DEFAULT_NAMED_ZONES_CONF, renderNamedZonesConfig } from './dns.ts'

const zone = 'example.com'
const path = '/var/lib/powerdns/zones/example.com.zone'
const now = new Date('2026-10-29T12:00:00Z')
const records = () => services.defaultZoneRecords(zone, { ipv4: '192.0.2.12', nameservers: ['ns1.example.com', 'ns2.example.com'], mailHost: 'mail.example.com', adminEmail: 'admin@example.com', today: now })
const linesFor = (rows: services.ZoneRecord[]) => [...rows].sort((a, b) => a.type === 'SOA' ? -1 : b.type === 'SOA' ? 1 : 0)
  .map(record => `${record.name === '@' ? zone + '.' : `${record.name}.${zone}.`}\t${record.ttl}\tIN\t${record.type}\t${services.pdnsContent(record)}`)
const axfr = (rows: services.ZoneRecord[]) => {
  const lines = linesFor(rows)
  lines.push(lines[0]!)
  return lines.join('\n') + `\n;; XFR size: ${lines.length} records (messages 1, bytes ${Buffer.byteLength(lines.join('\n'))})\n`
}
const soa = (rows: services.ZoneRecord[]) => ';; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 120\n;; flags: qr aa; QUERY: 1, ANSWER: 1\n;; ANSWER SECTION:\n' + linesFor(rows)[0] + '\n'
const ok = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '' })
const file = (content: string, filePath = path): RenderedFile => ({ path: filePath, content, owner: 'root', group: 'root', mode: 0o644 })
const candidate = (rows = records()) => [file(services.renderBindZone(rows)), file(renderNamedZonesConfig([zone]), DEFAULT_NAMED_ZONES_CONF)]

const fixture = async (rows = records()) => {
  const executor = new FakeHostExecutor()
  const files = candidate(rows)
  for (const item of files) await executor.writeFile(item)
  const commands: { argv: string[]; timeout: number }[] = []
  let runtimeRecords = rows
  let config = `launch=bind\nbind-config=${DEFAULT_NAMED_ZONES_CONF}\n`
  let transferUnavailable = false
  const provider = createNativeDnsReconcileProvider({ executor, family: 'debian', inspectExecutable: async () => true,
    readOwnedPaths: async () => new Set([path, DEFAULT_NAMED_ZONES_CONF]),
    runCommand: async (argv, timeout) => {
      commands.push({ argv, timeout })
      if (argv[0] === '/usr/bin/pdns_control') return ok(config)
      if (argv[0]!.includes('named-checkzone')) return ok()
      if (argv[3] === 'AXFR') return transferUnavailable ? { ...ok(), ok: false, code: 9 } : ok(axfr(runtimeRecords))
      if (!executor.files.has(path)) return ok(';; ->>HEADER<<- opcode: QUERY, status: REFUSED, id: 1\n;; flags: qr; QUERY: 1, ANSWER: 0\n')
      return ok(soa(runtimeRecords))
    },
  })
  return { executor, files, commands, provider, setRuntime: (value: services.ZoneRecord[]) => { runtimeRecords = value }, setConfig: (value: string) => { config = value }, refuseTransfer: () => { transferUnavailable = true } }
}

describe('production DNS reconciliation provider', () => {
  it('validates exact candidate bytes and observes current generation without publishing or changing its serial', async () => {
    const host = await fixture()
    const before = new Map(host.executor.files)
    await host.provider.validate(host.files, [])
    await host.provider.verify(host.files, [])
    expect(host.executor.files).toEqual(before)
    expect(host.commands.some(command => command.argv[0] === '/usr/bin/named-checkzone')).toBe(true)
    expect(host.commands.filter(command => command.argv[0] === '/usr/bin/dig').map(command => command.argv.slice(3))).toEqual([
      ['SOA', '+norecurse', '+time=2', '+tries=1', '+notcp'],
      ['SOA', '+norecurse', '+time=2', '+tries=1', '+tcp'],
      ['AXFR', '+norecurse', '+time=2', '+tries=1', '+tcp'],
    ])
    expect(host.commands.some(command => command.argv.some(arg => ['rediscover', 'reload', 'bind-reload-now'].includes(arg)))).toBe(false)
    expect(host.commands.every(command => command.timeout > 0 && command.timeout <= 60_000)).toBe(true)
  })
  it('keeps ordinary hosts without DNS candidates independent of missing DNS binaries', async () => {
    const executor = new FakeHostExecutor()
    let inspected = 0
    const provider = createNativeDnsReconcileProvider({ executor, family: 'rhel', inspectExecutable: async () => { inspected++; return false } })
    await provider.validate([file('site', '/etc/nginx/site.conf')], [])
    await provider.verify([], [])
    expect(inspected).toBe(0)
  })
  it('refuses missing protected binaries before any staging or host changes', async () => {
    const executor = new FakeHostExecutor()
    const provider = createNativeDnsReconcileProvider({ executor, family: 'rhel', inspectExecutable: async () => false })
    await expect(provider.validate(candidate(), [])).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(executor.executedActions).toHaveLength(0)
    expect(executor.files.size).toBe(0)
  })
  it.each([
    'launch=gpgsql\n', `launch=bind,gpgsql\nbind-config=${DEFAULT_NAMED_ZONES_CONF}\n`,
    'launch=bind\nbind-config=/etc/foreign-zones.conf\n',
    `launch=bind\nbind-config=${DEFAULT_NAMED_ZONES_CONF}\nlocal-address=192.0.2.9\n`,
    `launch=bind\nbind-config=${DEFAULT_NAMED_ZONES_CONF}\nlocal-port=5300\n`,
  ])('rejects foreign or differently bound runtime configuration', async config => {
    const host = await fixture()
    host.setConfig(config + 'gpgsql-password=synthetic-must-not-appear\n')
    let failure: unknown
    try { await host.provider.validate(host.files, []) } catch (error) { failure = error }
    expect(failure).toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'dns_backend_unavailable' } })
    expect(String(failure)).not.toContain('synthetic-must-not-appear')
    expect(host.executor.executedActions).toHaveLength(0)
  })
  it('preserves unrelated existing BIND zones and rejects unexpected candidate file bindings', async () => {
    const host = await fixture()
    await host.executor.writeFile(file(renderNamedZonesConfig([zone, 'foreign.example']), DEFAULT_NAMED_ZONES_CONF))
    await expect(host.provider.validate(host.files, [])).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    const bad = candidate()
    bad[1] = file(`zone "${zone}" { type master; file "/etc/shadow"; };`, DEFAULT_NAMED_ZONES_CONF)
    await expect(host.provider.validate(bad, [])).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(host.executor.executedActions).toHaveLength(0)
  })
  it('does not adopt or overwrite a preexisting zone without generation ownership', async () => {
    const host = await fixture()
    await host.executor.writeFile(file('foreign existing zone'))
    const provider = createNativeDnsReconcileProvider({ executor: host.executor, family: 'debian', inspectExecutable: async () => true,
      runCommand: async () => ok(`launch=bind\nbind-config=${DEFAULT_NAMED_ZONES_CONF}\n`),
    })
    await expect(provider.validate(host.files, [])).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(await host.executor.readFile(path)).toBe('foreign existing zone')
  })
  it('does not adopt an unowned catalog merely because its zone names match the candidate', async () => {
    const host = await fixture()
    await host.executor.removePath(path)
    const provider = createNativeDnsReconcileProvider({ executor: host.executor, family: 'debian', inspectExecutable: async () => true,
      runCommand: async () => ok(`launch=bind\nbind-config=${DEFAULT_NAMED_ZONES_CONF}\n`),
    })
    await expect(provider.validate(host.files, [])).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(host.executor.executedActions).toHaveLength(0)
  })
  it('rejects stale or extra served records even with the expected SOA serial', async () => {
    const host = await fixture()
    host.setRuntime(services.validateZone([...records(), { zone, name: 'removed', type: 'A', ttl: 14400, content: '192.0.2.99' }]))
    await expect(host.provider.verify(host.files, [])).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED' })
  })
  it('retains wildcard, delegation/glue and case-sensitive TXT records in the full snapshot oracle', async () => {
    const rows = services.validateZone([...records(),
      { zone, name: '*', type: 'TXT', ttl: 14400, content: 'CaseSensitiveToken' },
      { zone, name: 'child', type: 'NS', ttl: 14400, content: 'ns.child.example.com.' },
      { zone, name: 'ns.child', type: 'A', ttl: 14400, content: '192.0.2.55' },
    ])
    const host = await fixture(rows)
    await host.provider.verify(host.files, [])
    expect(host.commands.every(command => !command.argv.some(arg => arg.includes('*')))).toBe(true)
    host.setRuntime(rows.map(record => record.type === 'TXT' ? { ...record, content: record.content.toLowerCase() } : record))
    await expect(host.provider.verify(host.files, [])).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED' })
  })
  it('refuses unavailable AXFR without changing existing transfer permissions', async () => {
    const host = await fixture()
    host.refuseTransfer()
    await expect(host.provider.verify(host.files, [])).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'dns_local_transfer_unavailable' } })
    expect(host.executor.executedActions).toHaveLength(0)
  })
  it('does not assert unchanged state when post-activation readiness is lost', async () => {
    const host = await fixture()
    host.setConfig('launch=gpgsql\n')
    let failure: unknown
    try { await host.provider.verify(host.files, []) } catch (error) { failure = error }
    expect(failure).toMatchObject({ detail: { unknownOutcome: true, verificationRequired: true } })
    expect((failure as { detail: Record<string, unknown> }).detail.stateChanged).toBeUndefined()
  })
  it('compares managed catalog bytes before and after observation', async () => {
    const host = await fixture()
    await host.executor.writeFile(file('; unexpected catalog\n' + host.files[1]!.content, DEFAULT_NAMED_ZONES_CONF))
    await expect(host.provider.verify(host.files, [])).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED' })
  })
  it('verifies final-zone absence with an empty retained catalog', async () => {
    const host = await fixture()
    await host.executor.removePath(path)
    const empty = file(renderNamedZonesConfig([]), DEFAULT_NAMED_ZONES_CONF)
    await host.executor.writeFile(empty)
    await host.provider.validate([empty], [path])
    await host.provider.verify([empty], [path])
    expect(host.commands.some(command => command.argv[3] === 'AXFR')).toBe(false)
  })
  it('uses one bounded total deadline and does not start another native child after exhaustion', async () => {
    const executor = new FakeHostExecutor()
    let time = 0, commands = 0
    const provider = createNativeDnsReconcileProvider({ executor, family: 'debian', inspectExecutable: async () => true, clock: () => time,
      runCommand: async () => { commands++; time = 60_001; return ok(`launch=bind\nbind-config=${DEFAULT_NAMED_ZONES_CONF}\n`) },
    })
    await expect(provider.validate(candidate(), [])).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(commands).toBe(1)
    expect(executor.executedActions).toHaveLength(0)
  })
})

describe('complete AXFR envelopes', () => {
  it('requires matching opening and closing SOA records and a complete transfer footer', () => {
    expect(parseObservedAxfr(axfr(records()), zone)).toHaveLength(records().length)
    for (const invalid of [axfr(records()).replace(/;; XFR size:.*/, ''), axfr(records()).replace(/records \(messages/, 'records (invalid'), axfr(records()).replace(/2026102901(?=[^\n]*\n;; XFR)/, '2026102902')]) {
      expect(() => parseObservedAxfr(invalid, zone)).toThrow()
    }
  })
  it('rejects unknown record types and oversized transcripts instead of silently ignoring them', () => {
    const transfer = axfr(records())
    const lines = transfer.split('\n')
    lines.splice(1, 0, 'unknown.example.com. 14400 IN TYPE65280 \\# 2 0000')
    const invalid = lines.join('\n').replace(/XFR size: (\d+) records/, (_match, count) => `XFR size: ${Number(count) + 1} records`)
    expect(() => parseObservedAxfr(invalid, zone)).toThrow()
    expect(() => parseObservedAxfr('x'.repeat(MAX_DNS_OBSERVATION_BYTES + 1), zone)).toThrow()
  })
  it('requires effective loopback binding and rejects duplicate configuration authority', () => {
    expect(effectiveBindBackend(`launch=bind\nbind-config=${DEFAULT_NAMED_ZONES_CONF}\n`)).toBe(true)
    expect(effectiveBindBackend(`launch=bind\nlaunch=bind\nbind-config=${DEFAULT_NAMED_ZONES_CONF}\n`)).toBe(false)
  })
})
