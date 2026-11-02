import { describe, expect, it } from 'vitest'
import { services } from '@xpanel/render'
import { FakeHostExecutor } from '../executor.ts'
import { AuthoritativeDnsServiceAdapter } from './dns.ts'
import { parseNamedZonesConfig } from './dns.ts'
import type { AuthoritativeDnsProber } from './dns.ts'

const now = new Date('2026-10-29T12:00:00Z')
const records = () => services.defaultZoneRecords('example.com', {
  ipv4: '192.0.2.10', nameservers: ['ns1.example.com', 'ns2.example.com'], mailHost: 'mail.example.com', adminEmail: 'admin@example.com', today: now,
})
const explicitProbe: AuthoritativeDnsProber = async ({ expectedSerial, deleted }) => {
  const observed = { aaFlag: !deleted, raFlag: false, rcode: deleted ? 'REFUSED' : 'NOERROR', observedSerial: expectedSerial, answers: [] }
  return { udp: { ...observed, protocol: 'udp' }, tcp: { ...observed, protocol: 'tcp' } }
}

describe('authoritative DNS observations and recovery', () => {
  it('does not manufacture a successful observation from fake default command output', async () => {
    const executor = new FakeHostExecutor()
    const adapter = new AuthoritativeDnsServiceAdapter({ executor })
    await expect(adapter.publishZone({ zone: 'example.com', records: records(), now })).rejects.toMatchObject({
      code: 'CONFIG_TEST_FAILED', detail: { rolledBack: false, unknownOutcome: true, verificationRequired: true },
    })
  })
  it('validates the staged file using named-checkzone and rediscovers before zone-specific reload', async () => {
    const executor = new FakeHostExecutor()
    const adapter = new AuthoritativeDnsServiceAdapter({ executor, prober: explicitProbe })
    await adapter.publishZone({ zone: 'example.com', records: records(), now })
    expect(executor.executedTests[0]?.argv.slice(0, 2)).toEqual(['/usr/sbin/named-checkzone', 'example.com'])
    expect(executor.executedTests[0]?.argv[2]).toMatch(/^\/var\/lib\/powerdns\/staging\/example.com\.zone\..+\.stage$/)
    expect(executor.executedCommands.slice(0, 2)).toEqual([
      ['/usr/bin/pdns_control', 'rediscover'], ['/usr/bin/pdns_control', 'bind-reload-now', 'example.com'],
    ])
  })
  it('refuses pdnsutil as a candidate-file validator before any host action', () => {
    const executor = new FakeHostExecutor()
    expect(() => new AuthoritativeDnsServiceAdapter({ executor, syntaxTool: 'pdnsutil' })).toThrow()
    expect(executor.executedActions).toHaveLength(0)
  })
  it('preserves unrelated zones emitted by the reconciler without an explicit IN class', async () => {
    const executor = new FakeHostExecutor()
    await executor.writeFile({ path: '/etc/powerdns/named.conf.xpanel-zones', content:
      'zone "first.example" {\n type master;\n file "/var/lib/powerdns/zones/first.example.zone";\n};\nzone "second.example" IN {\n type master;\n file "/var/lib/powerdns/zones/second.example.zone";\n};\n',
      mode: 0o644, owner: 'root', group: 'root' })
    const adapter = new AuthoritativeDnsServiceAdapter({ executor, prober: explicitProbe })
    await adapter.publishZone({ zone: 'example.com', records: records(), now })
    expect(parseNamedZonesConfig(await executor.readFile('/etc/powerdns/named.conf.xpanel-zones'))).toEqual(['example.com', 'first.example', 'second.example'])
    await adapter.deleteZone('example.com')
    expect(parseNamedZonesConfig(await executor.readFile('/etc/powerdns/named.conf.xpanel-zones'))).toEqual(['first.example', 'second.example'])
  })
  it('does not claim rollback when the restored zone cannot be observed', async () => {
    const executor = new FakeHostExecutor()
    let fail = false
    const adapter = new AuthoritativeDnsServiceAdapter({ executor, prober: async input => {
      const observation = await explicitProbe(input)
      if (fail) observation.udp.rcode = 'SERVFAIL'
      return observation
    } })
    await adapter.publishZone({ zone: 'example.com', records: records(), now })
    fail = true
    await expect(adapter.publishZone({ zone: 'example.com', records: records(), now })).rejects.toMatchObject({
      detail: { restoredPreviousZone: true, rolledBack: false, stateChanged: true, unknownOutcome: true },
    })
  })
  it('reports verified rollback only after the recovery serial is observed', async () => {
    const executor = new FakeHostExecutor()
    let calls = 0
    const adapter = new AuthoritativeDnsServiceAdapter({ executor, prober: async input => {
      const observation = await explicitProbe(input)
      if (++calls === 2) observation.udp.observedSerial = 1
      return observation
    } })
    await adapter.publishZone({ zone: 'example.com', records: records(), now })
    await expect(adapter.publishZone({ zone: 'example.com', records: records(), now })).rejects.toMatchObject({
      detail: { recoverySerial: 2026102903, rolledBack: true, stateChanged: false, unknownOutcome: false },
    })
    expect(calls).toBe(3)
  })
  it.each(['SERVFAIL', 'NOERROR'])('does not treat %s as proof of zone deletion', async rcode => {
    const executor = new FakeHostExecutor()
    const adapter = new AuthoritativeDnsServiceAdapter({ executor, prober: async input => {
      const observation = await explicitProbe(input)
      if (input.deleted) observation.udp.rcode = rcode
      return observation
    } })
    await adapter.publishZone({ zone: 'example.com', records: records(), now })
    await expect(adapter.deleteZone('example.com')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true, verificationRequired: true } })
  })
})
