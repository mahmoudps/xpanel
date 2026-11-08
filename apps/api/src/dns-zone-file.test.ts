import { describe, expect, it, vi } from 'vitest'
import { handleDnsZoneFileRoute, previewZoneImport, zoneFileText } from './dns-zone-file.ts'

const ID = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222'
const zone = { id: ID, name: 'example.test', accountId: null, serial: 2026110701, records: [
  { id: ID, zone: 'example.test', name: '@', type: 'A' as const, ttl: 3600, content: '192.0.2.1', priority: null },
  { id: OTHER, zone: 'example.test', name: 'mail', type: 'MX' as const, ttl: 3600, content: 'mx.example.test.', priority: 10 },
] }
const ports = (found = zone) => ({
  store: { getDnsZone: vi.fn(async () => found), getAccount: vi.fn(async () => null), getServerSettings: vi.fn(async () => ({ nameservers: ['ns1.host.test'] })) },
  requireCaller: vi.fn(async () => ({ principal: { kind: 'root' } })), assertRoot: vi.fn(async () => undefined), assertCanAccessAccount: vi.fn(async () => undefined),
}) as never
const call = (method: string, body?: unknown, port = ports()) => handleDnsZoneFileRoute(new Request('http://x/api/dns/zones/example.test/zone-file', { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), new URL('http://x/api/dns/zones/example.test/zone-file'), method, port)

describe('BIND zone file', () => {
  it('exports the saved records under the SOA the reconciler publishes', () => {
    const text = zoneFileText(zone, 'ns1.host.test.')
    expect(text).toContain('$ORIGIN example.test.')
    expect(text).toMatch(/SOA\s+ns1\.host\.test\. hostmaster\.example\.test\./)
    expect(text).toContain('2026110701')
    expect(text).toContain('192.0.2.1')
  })
  it('round-trips an export without a difference and keeps record ids', () => {
    const preview = previewZoneImport(zone, zoneFileText(zone, 'ns1.host.test'))
    expect(preview.differences).toEqual([])
    expect(preview.records.map(record => record.id).sort()).toEqual([ID, OTHER].sort())
  })
  it('reports added, removed and changed records, and lists what it skipped', () => {
    const text = '$ORIGIN example.test.\n$TTL 300\n@ 7200 IN A 192.0.2.1\nwww IN A 192.0.2.2\nold IN LOC 1 2 3\n'
    const preview = previewZoneImport(zone, text)
    expect(preview.differences.map(item => item.action).sort()).toEqual(['add', 'change', 'remove'])
    expect(preview.skipped.some(item => item.type === 'LOC')).toBe(true)
    expect(preview.records.find(record => record.name === '@')!.id).toBe(ID)
    expect(preview.records.find(record => record.name === 'www')!.ttl).toBe(300)
  })
})

describe('zone file route', () => {
  it('ignores other paths and refuses other methods', async () => {
    expect(await handleDnsZoneFileRoute(new Request('http://x/api/dns/zones'), new URL('http://x/api/dns/zones'), 'GET', ports())).toBeNull()
    expect((await call('DELETE'))!.status).toBe(405)
  })
  it('requires root for an unowned zone and returns the file', async () => {
    const port = ports()
    const body = await (await call('GET', undefined, port))!.json() as { fileName: string; text: string }
    expect(body.fileName).toBe('example.test.db')
    expect((port as unknown as { assertRoot: unknown }).assertRoot).toHaveBeenCalled()
  })
  it('previews without storing and rejects a wrong body', async () => {
    const body = await (await call('POST', { text: '$ORIGIN example.test.\n@ 3600 IN A 192.0.2.9\n' }))!.json() as { revision: string; records: unknown[] }
    expect(body.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(body.records).toHaveLength(1)
    await expect(call('POST', { text: 1 })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('hides a missing zone', async () => {
    await expect(call('GET', undefined, ports(null as never))).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
