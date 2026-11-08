import { describe, expect, it } from 'vitest'
import { services } from '@xpanel/render'
import type { DnsZoneState } from '@xpanel/state'
import { stampZoneContent } from './zone-serial.ts'
import { decideDnsZone, decideDnsZoneRemoval, dnsClusterRevision, dnsClusterTokenHash, dnsClusterTokenMatches, dnsZoneCopyFromText, dnsZoneDigest, readDnsClusterConfig } from './dns-cluster-model.ts'

const zoneText = (serial: number, address = '192.0.2.10'): string => services.renderBindZone([
  { zone: 'example.test', name: '@', type: 'SOA', ttl: 3600, content: `ns1.example.test. hostmaster.example.test. ${serial} 3600 1800 1209600 3600`, priority: null },
  { zone: 'example.test', name: '@', type: 'A', ttl: 300, content: address, priority: null },
])
const copy = dnsZoneCopyFromText('example.test', zoneText(7))
const held = (over: Partial<DnsZoneState> = {}): DnsZoneState => ({ id: 'a', accountId: null, name: 'example.test', serial: 7, records: copy.records.map(record => ({ ...record, id: 'r' })) as DnsZoneState['records'], replica: { peer: 'ns1.peer.test', digest: copy.digest, at: '2026-11-07T00:00:00.000Z' }, ...over })
const incoming = (serial: number, digest: string = copy.digest) => ({ peer: 'ns1.peer.test', serial, digest })
const token = 'xpdc_' + 'a'.repeat(43), other = '0'.repeat(64)
const member = { name: 'ns2.peer.test', address: '192.0.2.2', port: 2087, pin: 'f'.repeat(64), token, role: 'synchronize', createdAt: '2026-11-07T00:00:00.000Z' }
const config = { version: 1, enabled: true, failureThreshold: 10, members: [member], inbound: [], updatedAt: null }

describe('dns cluster zone copies', () => {
  it('reads a rendered zone without its SOA and hashes it the same on both ends', () => {
    expect(copy).toMatchObject({ zone: 'example.test', serial: 7 })
    expect(copy.records.map(record => record.type)).toEqual(['A'])
    expect(dnsZoneCopyFromText('example.test', zoneText(9)).digest).toBe(copy.digest)
    expect(dnsZoneDigest([...copy.records].reverse())).toBe(copy.digest)
    expect(dnsZoneCopyFromText('example.test', zoneText(7, '192.0.2.11')).digest).not.toBe(copy.digest)
  })
  it('reads the stamped file PowerDNS serves, and survives a render of its own records', () => {
    const records = [
      { zone: 'example.test', name: '@', type: 'SOA' as const, ttl: 3600, content: 'ns1.example.test. hostmaster.example.test. 9 3600 1800 1209600 3600', priority: null },
      { zone: 'example.test', name: '@', type: 'MX' as const, ttl: 300, content: 'mail.example.test.', priority: 10 },
      { zone: 'example.test', name: '_dmarc', type: 'TXT' as const, ttl: 300, content: 'v=DMARC1; p=none', priority: null },
      { zone: 'example.test', name: 'default._domainkey', type: 'TXT' as const, ttl: 300, content: 'v=DKIM1; k=rsa; p=' + 'A'.repeat(600), priority: null },
      { zone: 'example.test', name: '_sip._tcp', type: 'SRV' as const, ttl: 300, content: '5 5060 sip.example.test.', priority: 10 },
      { zone: 'example.test', name: '@', type: 'CAA' as const, ttl: 300, content: '0 issue "letsencrypt.org"', priority: null },
      { zone: 'example.test', name: 'www', type: 'CNAME' as const, ttl: 300, content: 'example.test.', priority: null },
    ]
    const first = dnsZoneCopyFromText('example.test', stampZoneContent(services.renderBindZone(records)))
    expect(first.serial).toBe(9)
    expect(first.records).toHaveLength(6)
    const again = dnsZoneCopyFromText('example.test', services.renderBindZone([records[0]!, ...first.records]))
    expect(again.digest).toBe(first.digest)
  })
  it('refuses text that is not one whole zone', () => {
    expect(() => dnsZoneCopyFromText('example.test', '@ 300 IN A 192.0.2.1\n')).toThrow()
    expect(() => dnsZoneCopyFromText('example.test', '$INCLUDE /etc/passwd\n')).toThrow()
    expect(() => dnsZoneCopyFromText('example.test', ' '.repeat(1024 * 1024 + 1))).toThrow()
  })
  it('writes a new zone and a newer copy, and leaves an identical one', () => {
    expect(decideDnsZone(null, incoming(7))).toEqual({ action: 'write' })
    expect(decideDnsZone(held(), incoming(7))).toEqual({ action: 'unchanged' })
    expect(decideDnsZone(held(), incoming(8, other))).toEqual({ action: 'write' })
    expect(decideDnsZone(held(), incoming(8))).toEqual({ action: 'write' })
  })
  it('compares serials with RFC 1982 arithmetic across the wrap', () => {
    expect(decideDnsZone(held({ serial: 4_294_967_290 }), incoming(5, other))).toEqual({ action: 'write' })
    expect(decideDnsZone(held({ serial: 5 }), incoming(4_294_967_290, other))).toEqual({ action: 'conflict', reason: 'older_serial' })
  })
  it('names every conflict, and force resolves only the ones the source may settle', () => {
    const edited = held({ records: [{ ...held().records[0]!, content: '192.0.2.99' }] })
    expect(decideDnsZone(held({ accountId: 'x', replica: undefined as never }), incoming(9))).toEqual({ action: 'conflict', reason: 'owned_locally' })
    expect(decideDnsZone({ ...held(), replica: undefined }, incoming(9))).toEqual({ action: 'conflict', reason: 'owned_locally' })
    expect(decideDnsZone(held(), { ...incoming(9), peer: 'ns9.peer.test' })).toEqual({ action: 'conflict', reason: 'other_origin' })
    expect(decideDnsZone(edited, incoming(9))).toEqual({ action: 'conflict', reason: 'modified_here' })
    expect(decideDnsZone(held(), incoming(7, other))).toEqual({ action: 'conflict', reason: 'same_serial' })
    expect(decideDnsZone(held(), incoming(6, other))).toEqual({ action: 'conflict', reason: 'older_serial' })
    expect(decideDnsZone(edited, incoming(9), true)).toEqual({ action: 'write' })
    expect(decideDnsZone(held(), incoming(6, other), true)).toEqual({ action: 'write' })
    expect(decideDnsZone(held({ accountId: 'x' }), incoming(9), true)).toEqual({ action: 'conflict', reason: 'owned_locally' })
    expect(decideDnsZone(held(), { ...incoming(9), peer: 'ns9.peer.test' }, true)).toEqual({ action: 'conflict', reason: 'other_origin' })
  })
  it('removes only an untouched copy from its own source', () => {
    expect(decideDnsZoneRemoval(null, 'ns1.peer.test')).toEqual({ action: 'unchanged' })
    expect(decideDnsZoneRemoval(held(), 'ns1.peer.test')).toEqual({ action: 'write' })
    expect(decideDnsZoneRemoval(held(), 'ns9.peer.test')).toEqual({ action: 'conflict', reason: 'other_origin' })
    expect(decideDnsZoneRemoval(held({ accountId: 'x' }), 'ns1.peer.test')).toEqual({ action: 'conflict', reason: 'owned_locally' })
    expect(decideDnsZoneRemoval(held({ records: [] }), 'ns1.peer.test')).toEqual({ action: 'conflict', reason: 'modified_here' })
  })
})

describe('dns cluster configuration', () => {
  it('reads the exact grammar and starts turned off', () => {
    expect(readDnsClusterConfig(null)).toMatchObject({ enabled: false, failureThreshold: 10, members: [], inbound: [] })
    expect(readDnsClusterConfig(config)?.members[0]?.name).toBe('ns2.peer.test')
    expect(readDnsClusterConfig({ ...config, extra: 1 })).toBeNull()
    expect(readDnsClusterConfig({ ...config, members: [{ ...member, token: 'short' }] })).toBeNull()
    expect(readDnsClusterConfig({ ...config, members: [{ ...member, pin: 'F'.repeat(64) }] })).toBeNull()
    expect(readDnsClusterConfig({ ...config, members: [{ ...member, role: 'primary' }] })).toBeNull()
    expect(readDnsClusterConfig({ ...config, members: [member, member] })).toBeNull()
    expect(readDnsClusterConfig({ ...config, members: [{ ...member, name: 'single' }] })).toBeNull()
  })
  it('moves the revision with a token change while never hashing the token alone', () => {
    const next = { ...config, members: [{ ...member, token: 'xpdc_' + 'b'.repeat(43) }] }
    expect(dnsClusterRevision(next)).not.toBe(dnsClusterRevision(config))
    expect(dnsClusterRevision(config)).not.toBe(dnsClusterTokenHash(token))
  })
  it('matches a token against its hash in constant time', () => {
    expect(dnsClusterTokenMatches(token, dnsClusterTokenHash(token))).toBe(true)
    expect(dnsClusterTokenMatches(token, other)).toBe(false)
  })
})
