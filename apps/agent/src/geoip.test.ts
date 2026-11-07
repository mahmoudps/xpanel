import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { createGeoipSource, geoipUrl, lookupGeoipCountry, readGeoipMetadata } from './geoip.ts'

const str = (value: string): Buffer => Buffer.concat([Buffer.from([0x40 | value.length]), Buffer.from(value)])
const uint = (type: 5 | 6, value: number, size: number): Buffer => { const b = Buffer.alloc(size); b.writeUIntBE(value, 0, size); return Buffer.concat([Buffer.from([(type << 5) | size]), b]) }
const uint64 = (value: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return Buffer.concat([Buffer.from([4, 2]), b]) }
/** A minimal MaxMind DB: zero search tree, separator, empty data section, marker and metadata map. */
const database = (type = 'DBIP-Country-Lite', nodes = 10, tree = nodes * 6): Buffer => {
  const meta = [['database_type', str(type)], ['ip_version', uint(5, 6, 1)], ['record_size', uint(5, 24, 1)], ['node_count', uint(6, nodes, 4)], ['build_epoch', uint64(1_790_000_000)]] as const
  return Buffer.concat([Buffer.alloc(tree + 16), Buffer.from([0xab, 0xcd, 0xef]), Buffer.from('MaxMind.com'), Buffer.from([0xe0 | meta.length]), ...meta.flatMap(([k, v]) => [str(k), v])])
}

describe('GeoIP database check', () => {
  it('accepts a complete country database and reads its metadata', () => {
    expect(readGeoipMetadata(database())).toEqual({ databaseType: 'DBIP-Country-Lite', ipVersion: 6, recordSize: 24, nodeCount: 10, buildEpoch: 1_790_000_000 })
  })

  it('refuses a truncated tree, another database type and a file without metadata', () => {
    expect(() => readGeoipMetadata(database('DBIP-Country-Lite', 1000, 60))).toThrow('truncated')
    expect(() => readGeoipMetadata(database('DBIP-ASN-Lite'))).toThrow('country')
    expect(() => readGeoipMetadata(Buffer.alloc(4096))).toThrow('marker')
  })
})

/** One country record per first bit of the address; IPv4 sits under 96 zero bits, then bit 97 selects the record. */
const treeDatabase = (recordSize: 24 | 28 | 32): Buffer => {
  const nodes = 98, data = Buffer.concat([Buffer.from([0xe1]), str('country'), Buffer.from([0xe1]), str('iso_code'), str('DE')])
  const pointer = Buffer.from([0x20, 0]), second = Buffer.concat([pointer])
  const records: [number, number][] = []
  // Nodes 0 to 95 walk the zero prefix; the right branch of node 0 is the IPv6 record.
  for (let i = 0; i < 96; i++) records.push([i + 1, i === 0 ? nodes + 16 + data.length : nodes])
  records.push([nodes + 16, nodes])
  records.push([nodes, nodes])
  const node = Buffer.alloc(recordSize / 4), tree = Buffer.concat(records.map(([left, right]) => {
    const out = Buffer.from(node)
    if (recordSize === 24) { out.writeUIntBE(left, 0, 3); out.writeUIntBE(right, 3, 3) }
    else if (recordSize === 32) { out.writeUInt32BE(left, 0); out.writeUInt32BE(right, 4) }
    else { out.writeUIntBE(left & 0xffffff, 0, 3); out[3] = (Math.floor(left / 16777216) << 4) | Math.floor(right / 16777216); out.writeUIntBE(right & 0xffffff, 4, 3) }
    return out
  }))
  const meta = [['database_type', str('DBIP-Country-Lite')], ['ip_version', uint(5, 6, 1)], ['record_size', uint(5, recordSize, 1)], ['node_count', uint(6, nodes, 4)], ['build_epoch', uint64(1_790_000_000)]] as const
  return Buffer.concat([tree, Buffer.alloc(16), data, second, Buffer.from([0xab, 0xcd, 0xef]), Buffer.from('MaxMind.com'), Buffer.from([0xe0 | meta.length]), ...meta.flatMap(([k, v]) => [str(k), v])])
}

describe('GeoIP lookup', () => {
  it.each([24, 28, 32] as const)('walks a %i-bit tree, follows pointers and tells an unknown address from a known one', recordSize => {
    const db = treeDatabase(recordSize)
    expect(lookupGeoipCountry(db, '1.2.3.4')).toBe('DE')
    expect(lookupGeoipCountry(db, '129.0.0.1')).toBeNull()
    expect(lookupGeoipCountry(db, 'not-an-address')).toBeNull()
    expect(lookupGeoipCountry(db, '8000::1')).toBe('DE')
    expect(lookupGeoipCountry(db, '::ffff:1.2.3.4')).toBeNull()
  })
})

describe('GeoIP monthly refresh', () => {
  const dirs: string[] = []
  afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
  const source = async (responses: Record<string, Response>) => {
    const dir = await mkdtemp(join(tmpdir(), 'xpanel-geoip-')), requested: string[] = []
    dirs.push(dir)
    const geoip = createGeoipSource({ dir, fetch: (async (url: string, init?: RequestInit) => { requested.push(url); expect(init?.redirect).toBe('error'); return responses[url] ?? new Response(null, { status: 404 }) }) as typeof fetch })
    return { geoip, requested, dir }
  }

  it('installs this month, then leaves it in place for the rest of the month', async () => {
    const db = database()
    const { geoip, requested, dir } = await source({ [geoipUrl('2026-11')]: new Response(gzipSync(db)) })
    expect(await geoip.status()).toMatchObject({ installed: false })
    expect(await geoip.refresh(new Date('2026-11-07T00:00:00Z'))).toMatchObject({ installed: true, month: '2026-11' })
    expect((await readFile(geoip.path)).equals(db)).toBe(true)
    expect((await geoip.countries(['203.0.113.1'])).size).toBe(0)
    expect(JSON.parse(await readFile(join(dir, 'source.json'), 'utf8'))).toMatchObject({ source: 'DB-IP IP to Country Lite', month: '2026-11', url: geoipUrl('2026-11') })
    await geoip.refresh(new Date('2026-11-20T00:00:00Z'))
    expect(requested).toEqual([geoipUrl('2026-11')])
  })

  it('takes last month before this month is published, and keeps the installed copy when a download is not a database', async () => {
    const { geoip } = await source({ [geoipUrl('2026-10')]: new Response(gzipSync(database())), [geoipUrl('2026-12')]: new Response(gzipSync(Buffer.from('not a database'))) })
    expect(await geoip.refresh(new Date('2026-11-01T00:30:00Z'))).toMatchObject({ month: '2026-10' })
    await expect(geoip.refresh(new Date('2026-12-02T00:00:00Z'))).rejects.toThrow()
    expect(await geoip.status()).toMatchObject({ installed: true, month: '2026-10' })
  })

  it('refuses a failed download without touching the installed copy', async () => {
    const { geoip } = await source({ [geoipUrl('2026-11')]: new Response('busy', { status: 503 }) })
    await expect(geoip.refresh(new Date('2026-11-07T00:00:00Z'))).rejects.toThrow('HTTP 503')
    expect(await geoip.status()).toMatchObject({ installed: false })
  })
})
