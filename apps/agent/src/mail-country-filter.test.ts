import { describe, expect, it } from 'vitest'
import { buildMailxCountryMap, geoipCountryNetworks } from './mail-country-filter.ts'

/**
 * A 24-bit IPv4 tree: 0.0.0.0/1 is empty, 128.0.0.0/2 is country A (record 3 + offset 16), 192.0.0.0/2 is country B.
 * Node records hold [left, right]; a value above nodeCount is a data record.
 */
const tree = (nodes: readonly (readonly [number, number])[]): Buffer => {
  const db = Buffer.alloc(nodes.length * 6)
  nodes.forEach(([left, right], index) => { db.writeUIntBE(left, index * 6, 3); db.writeUIntBE(right, index * 6 + 3, 3) })
  return db
}
const NODES = 2
const v4 = tree([[NODES, 1], [NODES + 16, NODES + 32]])
const countryOf = (ip: string): string | null => Number(ip.split('.')[0]) >= 192 ? 'BB' : Number(ip.split('.')[0]) >= 128 ? 'AA' : null
const port = { metadata: () => ({ ipVersion: 4, recordSize: 24, nodeCount: NODES }), lookup: (_db: Buffer, ip: string) => countryOf(ip) }

describe('country networks', () => {
  it('returns only the networks of the blocked countries', () => {
    expect(geoipCountryNetworks(v4, new Set(['AA']), port)).toEqual(['128.0.0.0/2'])
    expect(geoipCountryNetworks(v4, new Set(['AA', 'BB']), port)).toEqual(['128.0.0.0/2', '192.0.0.0/2'])
    expect(geoipCountryNetworks(v4, new Set(['CC']), port)).toEqual([])
  })
  it('resolves each data record once', () => {
    let lookups = 0
    const shared = tree([[1, 1], [NODES + 16, NODES + 16]])
    geoipCountryNetworks(shared, new Set(['BB']), { ...port, lookup: () => { lookups++; return 'BB' } })
    expect(lookups).toBe(1)
  })
  it('reads 28 and 32 bit records', () => {
    const db32 = Buffer.alloc(16); db32.writeUInt32BE(NODES, 0); db32.writeUInt32BE(1, 4); db32.writeUInt32BE(NODES + 16, 8); db32.writeUInt32BE(NODES + 32, 12)
    expect(geoipCountryNetworks(db32, new Set(['BB']), { ...port, metadata: () => ({ ipVersion: 4, recordSize: 32, nodeCount: NODES }) })).toEqual(['192.0.0.0/2'])
    const db28 = Buffer.alloc(14); db28.writeUIntBE(NODES, 0, 3); db28.writeUIntBE(1, 4, 3); db28.writeUIntBE(NODES + 16, 7, 3); db28.writeUIntBE(NODES + 32, 11, 3)
    expect(geoipCountryNetworks(db28, new Set(['AA']), { ...port, metadata: () => ({ ipVersion: 4, recordSize: 28, nodeCount: NODES }) })).toEqual(['128.0.0.0/2'])
  })
  it('writes IPv4 networks of an IPv6 tree as IPv4 and skips aliases of that subtree', () => {
    // 96 zero bits lead to node 96; node 97 is reached through bit 0 = 1 and aliases node 96.
    const nodes: [number, number][] = Array.from({ length: 96 }, (_, index) => [index + 1, index === 0 ? 97 : 98])
    nodes.push([98 + 16, 98 + 32]) // node 96: 0.0.0.0/1 and 128.0.0.0/1
    nodes.push([96, 98 + 48]) // node 97: an alias of the IPv4 node, then one IPv6 network
    const lookup = (_db: Buffer, ip: string): string | null => ip.includes(':') ? 'CC' : ip.startsWith('128') ? 'AA' : 'BB'
    const found = geoipCountryNetworks(tree(nodes), new Set(['AA', 'CC']), { lookup, metadata: () => ({ ipVersion: 6, recordSize: 24, nodeCount: 98 }) })
    expect(found).toEqual(['128.0.0.0/1', '[c000:0:0:0:0:0:0:0]/2'])
  })
  it('refuses a table too large to load', () => {
    // A complete tree of 2^18 - 1 nodes has 2^18 leaves, all in one country.
    const nodes = 262_143, leaf = nodes + 16
    const big = Array.from({ length: nodes }, (_, index) => { const left = index * 2 + 1; return (left < nodes ? [left, left + 1] : [leaf, leaf]) as [number, number] })
    expect(() => geoipCountryNetworks(tree(big), new Set(['AA']), { lookup: () => 'AA', metadata: () => ({ ipVersion: 4, recordSize: 24, nodeCount: nodes }) })).toThrow(/more networks/)
  })
  it('stops at a damaged tree that loops', () => {
    expect(() => geoipCountryNetworks(tree([[0, 0], [0, 0]]), new Set(['AA']), port)).toThrow(/damaged/)
  })
})

describe('country map', () => {
  const geoip = { ...port, status: async () => ({ installed: true, month: '2026-11' }), read: async () => v4 }
  it('renders a managed table whose first line names the countries and the month', async () => {
    const file = await buildMailxCountryMap(geoip, ['AA'])
    expect(file.path).toBe('/etc/postfix/xpanel/mailx/country_block')
    expect(file.content.split('\n').slice(1, 3)).toEqual(['# xpanel-country 2026-11 AA', '128.0.0.0/2 REJECT 5.7.1 Mail from this network location is not accepted here'])
  })
  it('refuses with a stable reason while the source or database is missing', async () => {
    for (const source of [null, undefined, { ...geoip, status: async () => ({ installed: false, month: null }) }, { ...geoip, read: async () => null }]) {
      await expect(buildMailxCountryMap(source, ['AA'])).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'geoip_unavailable', stateChanged: false } })
    }
  })
})
