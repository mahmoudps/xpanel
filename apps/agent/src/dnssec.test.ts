import { describe, expect, it } from 'vitest'
import { isDnssecCommand } from '../../../packages/os/src/dnssec-command.ts'
import { dnssecDsRecords, dnssecKeyTag, parseDnssecDnskeys, parseDnssecKeyList, parseDnssecNsec, parseDnssecRequest, parseDnssecSoa, readDnssecView, runDnssecChange } from './dnssec.ts'

const zone = 'example.com'
// RFC 4509 section 2.3 example key and its SHA-256 DS.
const RFC4509 = 'AQOeiiR0GOMYkDshWoSKz9XzfwJr1AYtsmx3TGkJaNXVbfi/2pHm822aJ5iI9BMzNXxeYCmZDRD99WYwYqUSdjMmmAphXdvxegXd/M5+X7OrzKBaMbCVdFLUUh6DhweJBjEVv5f2wwjM9XzcnOf+EPbtG9DMBmADjFDc2w/rljwvFw=='
const P256 = 'mdsswUyr3DPW132mOi8V9xESWE8jTo0dxCjjnopKl+GqJxpVXckHAeF+KkxLbxILfDLUT0rAK9iUzy1L53eKGQ=='

/** A modeled PowerDNS: pdnsutil writes the key store at once; the listener publishes after `cache` reads. */
function host(options: { store?: boolean; served?: boolean; failOn?: string } = {}) {
  const keys: { id: number; type: 'KSK' | 'ZSK' | 'CSK'; active: boolean; published: boolean; key: string }[] = []
  let nsec3: string | null = null, nextId = 1
  const commands: string[][] = []
  const tag = (key: { type: string; key: string }) => dnssecKeyTag({ flags: key.type === 'ZSK' ? 256 : 257, protocol: 3, algorithm: 13, key: key.key })
  const out = (stdout: string) => ({ ok: true, code: 0, stdout, stderr: '' })
  const run = async (argv: string[]) => {
    expect(isDnssecCommand(argv)).toBe(true)
    commands.push(argv)
    if (options.failOn && argv.join(' ').includes(options.failOn)) return { ok: false, code: 1, stdout: '', stderr: 'refused' }
    const [, verb, , arg] = argv
    if (verb === 'current-config') return out(options.store === false ? 'launch=bind\n' : 'launch=bind\nbind-dnssec-db=/var/lib/powerdns/dnssec/keys.sqlite3\n')
    if (argv[0] === '/usr/bin/dig') {
      if (options.served === false) return out('')
      const signed = keys.some(key => key.active)
      if (argv[3] === 'SOA') return out(`example.com.\t3600\tIN\tSOA\tns1.example.com. hostmaster.example.com. 1 3600 600 604800 3600\n${signed ? 'example.com.\t3600\tIN\tRRSIG\tSOA 13 2 3600 20261120000000 20261106000000 1 example.com. c2ln\n' : ''}`)
      return out(keys.filter(key => key.published).map(key => `example.com.\t3600\tIN\tDNSKEY\t${key.type === 'ZSK' ? 256 : 257} 3 13 ${key.key}\n`).join('') + (signed ? 'example.com.\t3600\tIN\tRRSIG\tDNSKEY 13 2 3600 20261120000000 20261106000000 1 example.com. c2ln\n' : ''))
    }
    if (verb === 'list-keys') return out('Zone                          Type Act Pub Size    Algorithm       ID   Location    Keytag\n' + '-'.repeat(90) + '\n'
      + keys.map(key => `example.com                   ${keys.some(item => item.type === 'ZSK') || key.type === 'ZSK' ? key.type : 'CSK'}  ${key.active ? 'Act ' : '    '}${key.published ? 'Pub ' : '    '}256     ECDSAP256SHA256 ${key.id}    cryptokeys  ${tag(key)}\n`).join(''))
    if (verb === 'show-zone') return out(`This is a Native zone\nZone is not presigned\n${nsec3 ? `Zone has hashed NSEC3 semantics, configuration: ${nsec3}` : 'Zone has NSEC semantics'}\nkeys:\n`)
    if (verb === 'add-zone-key') {
      const id = nextId++
      // The second byte varies so each modeled key has its own tag.
      keys.push({ id, type: argv[3] === 'zsk' ? 'ZSK' : 'KSK', active: argv[4] === 'active', published: argv[5] === 'published', key: P256.slice(0, 1) + String.fromCharCode(65 + id) + P256.slice(2) })
      return out(`${id}\n`)
    }
    const key = keys.find(item => item.id === Number(arg))
    if (verb === 'activate-zone-key') key!.active = true
    if (verb === 'deactivate-zone-key') key!.active = false
    if (verb === 'publish-zone-key') key!.published = true
    if (verb === 'unpublish-zone-key') key!.published = false
    if (verb === 'remove-zone-key') keys.splice(keys.indexOf(key!), 1)
    if (verb === 'set-nsec3') nsec3 = argv[3]!
    if (verb === 'unset-nsec3') nsec3 = null
    if (verb === 'disable-dnssec') { keys.length = 0; nsec3 = null }
    return out('')
  }
  return { run, keys, commands }
}

describe('PowerDNS DNSSEC observations', { tags: ['unit'] }, () => {
  it('computes the RFC 4509 key tag and SHA-256 DS from a published DNSKEY', () => {
    const key = { flags: 256, protocol: 3, algorithm: 5, key: RFC4509 }
    expect(dnssecKeyTag(key)).toBe(60485)
    expect(dnssecDsRecords('dskey.example.com', key)[0]).toEqual({ keyTag: 60485, algorithm: 5, digestType: 2, digest: 'D4B7D520E7BB5F0F67674A0CCEB1E3E0614B93C4F9E99B8383F6A1E4469DA50A' })
    expect(dnssecDsRecords('dskey.example.com', key)[1]).toMatchObject({ digestType: 4, digest: expect.stringMatching(/^[0-9A-F]{96}$/) })
  })
  it('parses list-keys rows with and without the Act and Pub columns and refuses anything else', () => {
    const text = 'Zone                          Type Act Pub Size    Algorithm       ID   Location    Keytag\n----\nexample.com.                  KSK  Act Pub 256     ECDSAP256SHA256 3    cryptokeys  31415\nexample.com                   ZSK          256     ECDSAP256SHA256 4    cryptokeys  2718\n'
    expect(parseDnssecKeyList(text, zone)).toEqual([
      { id: 3, type: 'KSK', active: true, published: true, bits: 256, algorithm: 'ECDSAP256SHA256', tag: 31415 },
      { id: 4, type: 'ZSK', active: false, published: false, bits: 256, algorithm: 'ECDSAP256SHA256', tag: 2718 },
    ])
    expect(() => parseDnssecKeyList('example.com KSK Act Pub invalid\n', zone)).toThrow()
    expect(() => parseDnssecKeyList('other.example KSK Act Pub 256 ECDSAP256SHA256 1 cryptokeys 1\n', zone)).toThrow()
  })
  it('reads NSEC and NSEC3 semantics, DNSKEY answers and SOA signatures', () => {
    expect(parseDnssecNsec('Zone has NSEC semantics\n')).toEqual({ mode: 'nsec', optOut: false, narrow: false })
    expect(parseDnssecNsec('Zone has NARROW hashed NSEC3 semantics, configuration: 1 1 0 -\n')).toEqual({ mode: 'nsec3', optOut: true, narrow: true })
    expect(parseDnssecNsec('keys:\n')).toBeNull()
    expect(parseDnssecDnskeys(`example.com. 3600 IN DNSKEY 257 3 13 ${P256}\nexample.com. 3600 IN RRSIG DNSKEY 13 2 3600 1 2 3 example.com. c2ln\n`, zone)).toMatchObject({ signed: true, keys: [{ flags: 257, algorithm: 13, ttl: 3600 }] })
    expect(() => parseDnssecDnskeys(`example.com. 3600 IN DNSKEY 257 3 13 ${P256.slice(0, 20)} ${P256.slice(20)}\n`, zone)).toThrow()
    expect(parseDnssecSoa('', zone)).toBeNull()
    expect(parseDnssecSoa('example.com. 1 IN SOA a. b. 1 2 3 4 5\n', zone)).toBe(false)
  })
  it('accepts only the exact request shapes', () => {
    expect(parseDnssecRequest({ op: 'enable', algorithm: 'ecdsa256', layout: 'csk' })).toEqual({ op: 'enable', algorithm: 'ecdsa256', layout: 'csk' })
    for (const bad of [{ op: 'enable', algorithm: 'rsasha1', layout: 'csk' }, { op: 'key', verb: 'export', keyId: 1 }, { op: 'key', verb: 'remove', keyId: '1' }, { op: 'nsec', mode: 'nsec', optOut: true }, { op: 'read', zone: 'x' }])
      expect(() => parseDnssecRequest(bad)).toThrow()
  })
})

describe('PowerDNS DNSSEC changes', { tags: ['unit'] }, () => {
  it('signs a zone with one CSK, shows its DS and turns DNSSEC off again', async () => {
    const pdns = host()
    const unsigned = await readDnssecView(pdns.run, zone)
    expect(unsigned).toMatchObject({ store: 'ready', served: true, signing: 'unsigned', keys: [], publication: 'none' })
    const { view, addedKeyIds } = await runDnssecChange(pdns.run, zone, { op: 'enable', algorithm: 'ecdsa256', layout: 'csk' })
    expect(addedKeyIds).toEqual([1])
    expect(view).toMatchObject({ signing: 'signed', publication: 'current', nsec: { mode: 'nsec' }, dnskeyTtl: 3600, keys: [{ id: 1, type: 'CSK', active: true, published: true }] })
    expect(view.keys[0]!.ds).toHaveLength(2)
    expect(pdns.commands).toContainEqual(['/usr/bin/pdnsutil', 'add-zone-key', zone, 'ksk', 'active', 'published', 'ecdsa256'])
    expect(pdns.commands.at(-6)).toEqual(['/usr/bin/pdns_control', 'purge', 'example.com$'])
    expect((await runDnssecChange(pdns.run, zone, { op: 'disable' })).view).toMatchObject({ signing: 'unsigned', keys: [] })
  })
  it('rolls a ZSK by pre-publication and keeps the zone signed at every step', async () => {
    const pdns = host()
    await runDnssecChange(pdns.run, zone, { op: 'enable', algorithm: 'ecdsa256', layout: 'split' })
    const started = await runDnssecChange(pdns.run, zone, { op: 'rollover-start', keyId: 2 })
    expect(started.addedKeyIds).toEqual([3])
    expect(started.view.keys.find(key => key.id === 3)).toMatchObject({ type: 'ZSK', active: false, published: true })
    const finished = await runDnssecChange(pdns.run, zone, { op: 'rollover-finish', keyId: 2, newKeyId: 3 })
    expect(finished.view.keys.map(key => [key.id, key.active])).toEqual([[1, true], [2, false], [3, true]])
    expect((await runDnssecChange(pdns.run, zone, { op: 'key', verb: 'remove', keyId: 2 })).view.keys.map(key => key.id)).toEqual([1, 3])
  })
  it('refuses changes that would leave a signed zone unverifiable, with stable reasons', async () => {
    const pdns = host()
    await runDnssecChange(pdns.run, zone, { op: 'enable', algorithm: 'ecdsa256', layout: 'csk' })
    await expect(runDnssecChange(pdns.run, zone, { op: 'key', verb: 'deactivate', keyId: 1 })).rejects.toMatchObject({ detail: { reason: 'last_active_key', stateChanged: false } })
    await expect(runDnssecChange(pdns.run, zone, { op: 'key', verb: 'unpublish', keyId: 1 })).rejects.toMatchObject({ detail: { reason: 'active_key_unpublished' } })
    await expect(runDnssecChange(pdns.run, zone, { op: 'enable', algorithm: 'ecdsa256', layout: 'csk' })).rejects.toMatchObject({ detail: { reason: 'dnssec_already_enabled' } })
    await expect(runDnssecChange(host({ store: false }).run, zone, { op: 'enable', algorithm: 'ecdsa256', layout: 'csk' })).rejects.toMatchObject({ detail: { reason: 'dnssec_key_store_unavailable' } })
    await expect(runDnssecChange(host({ served: false }).run, zone, { op: 'enable', algorithm: 'ecdsa256', layout: 'csk' })).rejects.toMatchObject({ detail: { reason: 'zone_not_published' } })
  })
  it('switches to NSEC3 without extra iterations and reloads the zone for the BIND backend', async () => {
    const pdns = host()
    await runDnssecChange(pdns.run, zone, { op: 'enable', algorithm: 'ed25519', layout: 'csk' })
    const { view } = await runDnssecChange(pdns.run, zone, { op: 'nsec', mode: 'nsec3', optOut: false })
    expect(view.nsec).toEqual({ mode: 'nsec3', optOut: false, narrow: false })
    expect(pdns.commands).toContainEqual(['/usr/bin/pdnsutil', 'set-nsec3', zone, '1 0 0 -'])
    expect(pdns.commands).toContainEqual(['/usr/bin/pdns_control', 'bind-reload-now', zone])
  })
  it('reports a partly applied split layout as needing verification', async () => {
    const pdns = host({ failOn: 'zsk' })
    await expect(runDnssecChange(pdns.run, zone, { op: 'enable', algorithm: 'ecdsa256', layout: 'split' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, verificationRequired: true } })
    expect(pdns.keys).toHaveLength(1)
  })
  it('admits RSA keys only with 2048 bits and no free-form pdnsutil argument', () => {
    expect(isDnssecCommand(['/usr/bin/pdnsutil', 'add-zone-key', zone, 'ksk', 'active', 'published', '2048', 'rsasha256'])).toBe(true)
    expect(isDnssecCommand(['/usr/bin/pdnsutil', 'add-zone-key', zone, 'ksk', 'active', 'published', '1024', 'rsasha256'])).toBe(false)
    expect(isDnssecCommand(['/usr/bin/pdnsutil', 'set-nsec3', zone, '1 0 10 abcd'])).toBe(false)
    expect(isDnssecCommand(['/usr/bin/pdnsutil', 'export-zone-key', zone, '1'])).toBe(false)
    expect(isDnssecCommand(['/usr/bin/pdns_control', 'purge', '-x$'])).toBe(false)
  })
})
