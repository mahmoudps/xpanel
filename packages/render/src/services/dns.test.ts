import { describe, expect, it } from 'vitest'
import { isXpanelError } from '@xpanel/core'
import {
  acmeChallengeFqdn,
  acmeTxtChange,
  bumpSerial,
  defaultZoneRecords,
  fromPdnsRrsets,
  pdnsContent,
  pdnsCreateZone,
  pdnsDeleteRrset,
  pdnsDiff,
  pdnsNotify,
  pdnsPatchZone,
  pdnsRrsets,
  pdnsZonePath,
  serialFor,
  soaRname,
  validateRecord,
  validateZone,
  withSerial,
  type RecordInput,
  type ZoneRecord,
} from './dns.ts'
import { quoteTxt, txtChunks, parseTxtPresentation } from './txt.ts'

const today = new Date('2026-10-22T10:00:00Z')
const base = { ipv4: '203.0.113.10', nameservers: ['ns1.host.net', 'ns2.host.net'], mailHost: 'mail.example.com', adminEmail: 'hostmaster@host.net', today }

const rejects = (fn: () => unknown, pattern?: RegExp): void => {
  let err: unknown
  try {
    fn()
  } catch (e) {
    err = e
  }
  expect(isXpanelError(err), `expected VALIDATION, got ${String(err)}`).toBe(true)
  if (isXpanelError(err)) {
    expect(err.code).toBe('VALIDATION')
    if (pattern) expect(err.message).toMatch(pattern)
  }
}

const rec = (type: string, name: string, content: string, priority: number | null = null): RecordInput => ({ zone: 'example.com', name, type, ttl: 3600, content, priority })
const find = (rs: ZoneRecord[], name: string, type: string): ZoneRecord[] => rs.filter((r) => r.name === name && r.type === type)

describe('defaultZoneRecords', () => {
  const rs = defaultZoneRecords('Example.COM', base)

  it('starts with an apex SOA carrying a YYYYMMDDnn serial and the rname from the admin email', () => {
    expect(rs[0]).toEqual({
      zone: 'example.com',
      name: '@',
      type: 'SOA',
      ttl: 14400,
      content: 'ns1.host.net. hostmaster.host.net. 2026102201 3600 1800 1209600 3600',
      priority: null,
    })
  })

  it('has NS, A for apex/www/mail/ftp/autoconfig/autodiscover, MX, SPF, DMARC and autodiscover SRV', () => {
    expect(find(rs, '@', 'NS').map((r) => r.content)).toEqual(['ns1.host.net.', 'ns2.host.net.'])
    for (const h of ['@', 'www', 'mail', 'ftp', 'autoconfig', 'autodiscover']) expect(find(rs, h, 'A')[0]?.content).toBe('203.0.113.10')
    expect(find(rs, '@', 'MX')).toEqual([{ zone: 'example.com', name: '@', type: 'MX', ttl: 14400, content: 'mail.example.com.', priority: 10 }])
    expect(find(rs, '@', 'TXT')[0]?.content).toBe('v=spf1 a mx ip4:203.0.113.10 ~all')
    expect(find(rs, '_dmarc', 'TXT')[0]?.content).toBe('v=DMARC1; p=none')
    expect(find(rs, '_autodiscover._tcp', 'SRV')[0]).toMatchObject({ content: '0 443 autodiscover.example.com.', priority: 0 })
  })

  it('adds no wildcard and no AAAA unless asked', () => {
    expect(rs.some((r) => r.name === '*')).toBe(false)
    expect(rs.some((r) => r.type === 'AAAA')).toBe(false)
  })

  it('adds * A and AAAA when the domain is wildcard, and ip6 in SPF', () => {
    const w = defaultZoneRecords('example.com', { ...base, wildcard: true, ipv6: '2001:DB8:0:0:0:0:0:1' })
    expect(find(w, '*', 'A')[0]?.content).toBe('203.0.113.10')
    expect(find(w, '*', 'AAAA')[0]?.content).toBe('2001:db8::1')
    expect(find(w, 'www', 'AAAA')[0]?.content).toBe('2001:db8::1')
    expect(find(w, '@', 'TXT')[0]?.content).toBe('v=spf1 a mx ip4:203.0.113.10 ip6:2001:db8::1 ~all')
  })

  it('adds an A record for an in-zone mail host that is not one of the defaults', () => {
    const r = defaultZoneRecords('example.com', { ...base, mailHost: 'mx1.example.com' })
    expect(find(r, 'mx1', 'A')).toHaveLength(1)
    const ext = defaultZoneRecords('example.com', { ...base, mailHost: 'server1.host.net' })
    expect(find(ext, '@', 'MX')[0]?.content).toBe('server1.host.net.')
  })

  it('is deterministic with an explicit date or serial, and never reads the clock', () => {
    expect(defaultZoneRecords('example.com', base)).toEqual(rs)
    expect(defaultZoneRecords('example.com', { ...base, serial: 2026102207 })[0]?.content).toContain(' 2026102207 ')
    const { today: _t, ...noDate } = base
    rejects(() => defaultZoneRecords('example.com', noDate), /date/)
  })

  it('adds glue for in-zone nameservers: the zone address by default, an explicit one when given', () => {
    const own = defaultZoneRecords('example.com', { ...base, ipv6: '2001:db8::10', nameservers: ['ns1.example.com', 'ns2.example.com', 'ns.host.net'] })
    expect(find(own, 'ns1', 'A')[0]?.content).toBe('203.0.113.10')
    expect(find(own, 'ns2', 'AAAA')[0]?.content).toBe('2001:db8::10')
    expect(own.some((r) => r.name === 'ns' || r.name === 'ns.host.net')).toBe(false)
    const split = defaultZoneRecords('example.com', {
      ...base,
      nameservers: ['ns1.example.com', 'ns2.example.com'],
      nameserverAddresses: { 'NS2.example.com': { ipv4: '198.51.100.2', ipv6: '2001:db8::2' } },
    })
    expect(find(split, 'ns1', 'A')[0]?.content).toBe('203.0.113.10')
    expect(find(split, 'ns2', 'A').map((r) => r.content)).toEqual(['198.51.100.2'])
    expect(find(split, 'ns2', 'AAAA')[0]?.content).toBe('2001:db8::2')
    // a nameserver that is also a default host label keeps exactly one address set
    const mailNs = defaultZoneRecords('example.com', { ...base, nameservers: ['mail.example.com'], nameserverAddresses: { 'mail.example.com': { ipv4: '198.51.100.9' } } })
    expect(find(mailNs, 'mail', 'A').map((r) => r.content)).toEqual(['198.51.100.9'])
    expect(validateZone(split)).toHaveLength(split.length)
  })

  it('rejects glue for unknown nameservers, bad glue addresses and an apex nameserver', () => {
    rejects(() => defaultZoneRecords('example.com', { ...base, nameserverAddresses: { 'ns9.host.net': { ipv4: '198.51.100.9' } } }), /not one of the nameservers/)
    rejects(() => defaultZoneRecords('example.com', { ...base, nameservers: ['ns1.example.com'], nameserverAddresses: { 'ns1.example.com': { ipv4: '::1' } } }), /IPv4/)
    const apexNs = defaultZoneRecords('example.com', { ...base, nameservers: ['example.com'] })
    expect(find(apexNs, '@', 'A').map((r) => r.content)).toEqual(['203.0.113.10'])
    rejects(() => defaultZoneRecords('example.com', { ...base, nameservers: ['example.com'], nameserverAddresses: { 'example.com': { ipv4: '198.51.100.1' } } }), /apex/)
    rejects(() => defaultZoneRecords('example.com', { ...base, nameserverAddresses: [] as unknown as Record<string, { ipv4: string }> }))
  })

  it('passes its own zone validation (one SOA, apex NS, no CNAME conflicts)', () => {
    expect(validateZone(rs)).toHaveLength(rs.length)
  })

  it('rejects bad inputs instead of repairing them', () => {
    rejects(() => defaultZoneRecords('example.com', { ...base, nameservers: [] }), /nameservers/)
    rejects(() => defaultZoneRecords('example.com', { ...base, nameservers: ['ns1.host.net', 'NS1.host.net'] }), /duplicates/)
    rejects(() => defaultZoneRecords('example.com', { ...base, ipv4: '203.0.113.010' }))
    rejects(() => defaultZoneRecords('example.com', { ...base, ipv4: '999.1.1.1' }))
    rejects(() => defaultZoneRecords('exa mple.com', base))
    rejects(() => defaultZoneRecords('example.com\nevil', base))
    rejects(() => defaultZoneRecords('localhost', base), /two labels/)
    rejects(() => defaultZoneRecords('example.com', { ...base, adminEmail: 'not-an-email' }))
    rejects(() => defaultZoneRecords('example.com', { ...base, mailHost: 'mail..example.com' }))
    rejects(() => defaultZoneRecords('example.com', { ...base, dmarcPolicy: 'p=reject; evil' as 'reject' }))
  })
})

describe('soaRname', () => {
  it('escapes dots in the mailbox part', () => {
    expect(soaRname('host.master@Example.com')).toBe('host\\.master.example.com.')
  })
  it('refuses characters an rname cannot carry', () => {
    rejects(() => soaRname('a&b@example.com'))
  })
})

describe('serials', () => {
  it('serialFor builds YYYYMMDDnn in UTC', () => {
    expect(serialFor(new Date('2026-01-05T23:59:59Z'))).toBe(2026010501)
    expect(serialFor(new Date('2026-01-05T00:00:00Z'), 42)).toBe(2026010542)
  })

  it('bumpSerial jumps to today when the zone is older', () => {
    expect(bumpSerial(2025123105, today)).toBe(2026102201)
    expect(bumpSerial(1, today)).toBe(2026102201)
  })

  it('bumpSerial increments within the same day and keeps going past nn=99', () => {
    expect(bumpSerial(2026102201, today)).toBe(2026102202)
    expect(bumpSerial(2026102299, today)).toBe(2026102300)
  })

  it('bumpSerial never goes backwards for serials ahead of today', () => {
    expect(bumpSerial(2027010100, today)).toBe(2027010101)
  })

  it('bumpSerial refuses overflow and garbage', () => {
    rejects(() => bumpSerial(4294967295, today), /overflow/)
    rejects(() => bumpSerial(-1, today))
    rejects(() => bumpSerial(1.5, today))
    rejects(() => bumpSerial(2026102201, new Date('nope')))
  })

  it('withSerial rewrites only the serial', () => {
    const soa = defaultZoneRecords('example.com', base)[0] as ZoneRecord
    expect(withSerial(soa, 2026102209).content).toBe('ns1.host.net. hostmaster.host.net. 2026102209 3600 1800 1209600 3600')
  })
})

describe('validateRecord', () => {
  it('canonicalizes A and AAAA', () => {
    expect(validateRecord(rec('A', 'www', '192.0.2.1')).content).toBe('192.0.2.1')
    expect(validateRecord(rec('AAAA', 'www', '2001:0DB8:0000:0000:0001:0000:0000:0001')).content).toBe('2001:db8::1:0:0:1')
    expect(validateRecord(rec('aaaa', 'www', '::')).content).toBe('::')
  })

  it('rejects malformed addresses', () => {
    for (const bad of ['192.0.2', '192.0.2.1.5', '192.0.2.256', '01.2.3.4', ' 192.0.2.1', '192.0.2.1\n', '::1', '::ffff:192.0.2.1']) rejects(() => validateRecord(rec('A', 'x', bad)))
    for (const bad of ['fe80::1%eth0', '1:2:3:4:5:6:7:8:9', '1::2::3', '12345::', '[::1]', '1.2.3.4::', 'gggg::1', '192.0.2.1']) rejects(() => validateRecord(rec('AAAA', 'x', bad)))
    // an IPv4-mapped AAAA is an A record in disguise
    rejects(() => validateRecord(rec('AAAA', 'x', '::ffff:192.0.2.1')), /IPv4-mapped/)
  })

  it('normalizes owner names and rejects names outside or ambiguous to the zone', () => {
    expect(validateRecord(rec('A', 'WWW', '192.0.2.1')).name).toBe('www')
    expect(validateRecord(rec('A', 'www.example.com.', '192.0.2.1')).name).toBe('www')
    expect(validateRecord(rec('A', 'example.com.', '192.0.2.1')).name).toBe('@')
    expect(validateRecord(rec('A', '', '192.0.2.1')).name).toBe('@')
    expect(validateRecord(rec('A', '*', '192.0.2.1')).name).toBe('*')
    expect(validateRecord(rec('A', '*.dev', '192.0.2.1')).name).toBe('*.dev')
    rejects(() => validateRecord(rec('A', 'www.example.com', '192.0.2.1')), /ambiguous/)
    rejects(() => validateRecord(rec('A', 'www.other.com.', '192.0.2.1')), /outside zone/)
    rejects(() => validateRecord(rec('A', 'a.*', '192.0.2.1')))
    rejects(() => validateRecord(rec('A', 'a..b', '192.0.2.1')))
    rejects(() => validateRecord(rec('A', 'bad name', '192.0.2.1')))
    rejects(() => validateRecord(rec('A', 'x\nIN A 6.6.6.6', '192.0.2.1')))
    rejects(() => validateRecord(rec('A', 'ünï', '192.0.2.1')))
    rejects(() => validateRecord(rec('A', '-lead', '192.0.2.1')))
    rejects(() => validateRecord(rec('A', `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(50)}`, '192.0.2.1')), /253/)
  })

  it('handles CNAME rules', () => {
    expect(validateRecord(rec('CNAME', 'www', 'Example.com')).content).toBe('example.com.')
    expect(validateRecord(rec('CNAME', '_acme-challenge', '_acme-challenge.dns.example.net.')).content).toBe('_acme-challenge.dns.example.net.')
    rejects(() => validateRecord(rec('CNAME', '@', 'example.net')), /apex/)
    rejects(() => validateRecord(rec('CNAME', 'www', 'target')), /fully qualified/)
    rejects(() => validateRecord(rec('CNAME', 'www', 'example.net', 5)), /priority/)
  })

  it('handles MX priority, the combined "prio host" form and null MX', () => {
    expect(validateRecord(rec('MX', '@', 'mail.example.com', 5))).toMatchObject({ content: 'mail.example.com.', priority: 5 })
    expect(validateRecord(rec('MX', '@', '20 mx.example.net.'))).toMatchObject({ content: 'mx.example.net.', priority: 20 })
    expect(validateRecord(rec('MX', '@', '.', 0))).toMatchObject({ content: '.', priority: 0 })
    rejects(() => validateRecord(rec('MX', '@', 'mail.example.com')), /required/)
    rejects(() => validateRecord(rec('MX', '@', 'mail.example.com', 65536)))
    rejects(() => validateRecord(rec('MX', '@', 'mail.example.com', -1)))
    rejects(() => validateRecord(rec('MX', '@', '.', 10)), /null MX/)
    rejects(() => validateRecord(rec('MX', '@', '192.0.2.1', 10)))
  })

  it('stores TXT as the logical value; quoted input is parsed only when asked', () => {
    expect(validateRecord(rec('TXT', '@', 'v=spf1 a mx ~all')).content).toBe('v=spf1 a mx ~all')
    const quoted = rec('TXT', '@', '"v=spf1 " "include:_spf.example.net ~all"')
    expect(validateRecord(quoted, { txtInput: 'auto' }).content).toBe('v=spf1 include:_spf.example.net ~all')
    expect(validateRecord(quoted, { txtInput: 'presentation' }).content).toBe('v=spf1 include:_spf.example.net ~all')
    expect(validateRecord(quoted).content).toBe('"v=spf1 " "include:_spf.example.net ~all"')
    expect(validateRecord(rec('TXT', '@', 'say "hi"; ok'), { txtInput: 'auto' }).content).toBe('say "hi"; ok')
    rejects(() => validateRecord(rec('TXT', '@', 'x'), { txtInput: 'raw' as 'auto' }))
    rejects(() => validateRecord(rec('TXT', '@', 'line1\nline2')), /control/)
    rejects(() => validateRecord(rec('TXT', '@', 'nul\u0000')), /control/)
    rejects(() => validateRecord(rec('TXT', '@', '')), /empty/)
    rejects(() => validateRecord(rec('TXT', '@', 'x'.repeat(4097))), /4096/)
    rejects(() => validateRecord(rec('TXT', '@', '"unterminated'), { txtInput: 'auto' }))
    rejects(() => validateRecord(rec('TXT', '@', '\uD800 lone surrogate')))
  })

  it('validates SRV names and fields', () => {
    expect(validateRecord(rec('SRV', '_sip._tcp', '5 5060 sip.example.com', 10))).toMatchObject({ content: '5 5060 sip.example.com.', priority: 10 })
    expect(validateRecord(rec('SRV', '_sip._udp.voice', '0 5 5060 sip.example.com.'))).toMatchObject({ content: '5 5060 sip.example.com.', priority: 0 })
    expect(validateRecord(rec('SRV', '_x._tcp', '0 0 .', 0)).content).toBe('0 0 .')
    rejects(() => validateRecord(rec('SRV', 'sip', '5 5060 sip.example.com', 10)), /_service/)
    rejects(() => validateRecord(rec('SRV', '_sip._xyz', '5 5060 sip.example.com', 10)))
    rejects(() => validateRecord(rec('SRV', '_sip._tcp', '5 70000 sip.example.com', 10)))
    rejects(() => validateRecord(rec('SRV', '_sip._tcp', '5 sip.example.com', 10)))
  })

  it('validates CAA and renders the value quoted', () => {
    expect(validateRecord(rec('CAA', '@', '0 issue "letsencrypt.org"')).content).toBe('0 issue "letsencrypt.org"')
    expect(validateRecord(rec('CAA', '@', '0 ISSUEWILD letsencrypt.org')).content).toBe('0 issuewild "letsencrypt.org"')
    expect(validateRecord(rec('CAA', '@', '0 issue ";"')).content).toBe('0 issue ";"')
    expect(validateRecord(rec('CAA', '@', '128 iodef "mailto:security@example.com"')).content).toBe('128 iodef "mailto:security@example.com"')
    rejects(() => validateRecord(rec('CAA', '@', '256 issue "letsencrypt.org"')))
    rejects(() => validateRecord(rec('CAA', '@', '0 issue "lets"encrypt.org"')), /quotes/)
    rejects(() => validateRecord(rec('CAA', '@', '0 iodef "javascript:alert(1)"')), /iodef/)
    rejects(() => validateRecord(rec('CAA', '@', '0 issue "bad domain!"')))
    rejects(() => validateRecord(rec('CAA', '@', '0 issue letsencrypt org')))
  })

  it('keeps SOA at the apex and validates its fields', () => {
    expect(validateRecord(rec('SOA', '@', 'NS1.host.net hostmaster.host.net. 1 2 3 4 5')).content).toBe('ns1.host.net. hostmaster.host.net. 1 2 3 4 5')
    rejects(() => validateRecord(rec('SOA', 'www', 'ns1.host.net. hostmaster.host.net. 1 2 3 4 5')), /apex/)
    rejects(() => validateRecord(rec('SOA', '@', 'ns1.host.net. hostmaster.host.net. 4294967296 2 3 4 5')))
    rejects(() => validateRecord(rec('SOA', '@', 'ns1.host.net. hostmaster.host.net. 1 2 3 4')))
  })

  it('rejects unknown types, priorities on plain types and bad TTLs', () => {
    rejects(() => validateRecord(rec('PTR', 'x', 'a.example.com.')), /record type/)
    rejects(() => validateRecord(rec('A', 'x', '192.0.2.1', 10)), /priority/)
    rejects(() => validateRecord({ ...rec('A', 'x', '192.0.2.1'), ttl: -5 }))
    rejects(() => validateRecord({ ...rec('A', 'x', '192.0.2.1'), ttl: 2147483648 }))
    rejects(() => validateRecord({ ...rec('A', 'x', '192.0.2.1'), ttl: 1.5 }))
    rejects(() => validateRecord({ ...rec('A', 'x', '192.0.2.1'), zone: '../etc' }))
  })
})

describe('validateRecord idempotency', () => {
  it('re-validating a canonical record returns it unchanged', () => {
    const samples = [
      ...defaultZoneRecords('example.com', { ...base, wildcard: true, ipv6: '2001:db8::1' }),
      validateRecord(rec('TXT', 'q', '"quoted" value with \ and ;')),
      validateRecord(rec('CAA', '@', '0 issue "ca.example.net; account=12"')),
      validateRecord(rec('SRV', '_sip._tcp', '0 5 5060 sip.example.com')),
      validateRecord(rec('MX', '@', '.', 0)),
    ]
    for (const r of samples) expect(validateRecord(r)).toEqual(r)
  })
})

describe('validateZone', () => {
  const soa = rec('SOA', '@', 'ns1.host.net. h.host.net. 1 2 3 4 5')
  const ns = rec('NS', '@', 'ns1.host.net.')
  it('rejects a CNAME next to other data and a second SOA', () => {
    rejects(() => validateZone([soa, ns, rec('CNAME', 'www', 'example.net'), rec('A', 'www', '192.0.2.1')]), /CNAME next to/)
    rejects(() => validateZone([soa, ns, rec('CNAME', 'www', 'a.example.net'), rec('CNAME', 'www', 'b.example.net')]), /more than one CNAME/)
    rejects(() => validateZone([soa, soa, ns, rec('SOA', '@', 'ns2.host.net. h.host.net. 1 2 3 4 5')]), /more than one SOA/)
    rejects(() => validateZone([ns]), /no SOA/)
    rejects(() => validateZone([soa]), /no apex NS/)
    rejects(() => validateZone([soa, ns, { ...rec('A', 'x', '192.0.2.1'), zone: 'other.com' }]), /mixes zones/)
  })
  it('drops identical duplicates', () => {
    expect(validateZone([soa, ns, ns, rec('A', 'x', '192.0.2.1'), rec('A', 'X', '192.0.2.1')])).toHaveLength(3)
  })
})

describe('TXT encoding', () => {
  it('chunks at 255 octets without splitting UTF-8 sequences', () => {
    const v = `${'a'.repeat(254)}é${'b'.repeat(10)}`
    const chunks = txtChunks(v)
    expect(chunks).toEqual(['a'.repeat(254), `é${'b'.repeat(10)}`])
    expect(txtChunks('x'.repeat(600)).map((c) => c.length)).toEqual([255, 255, 90])
  })
  it('quotes with escapes and round-trips through the parser', () => {
    const v = 'He said "hi" \\ back; é'
    expect(quoteTxt(v)).toBe('"He said \\"hi\\" \\\\ back; \\195\\169"')
    expect(parseTxtPresentation(quoteTxt(v))).toBe(v)
    const long = `v=DKIM1; k=rsa; p=${'A'.repeat(400)}`
    expect(parseTxtPresentation(quoteTxt(long))).toBe(long)
  })
})

describe('PowerDNS payloads', () => {
  const zone = defaultZoneRecords('example.com', base)

  it('groups records into REPLACE rrsets with absolute names and API content', () => {
    const rr = pdnsRrsets([rec('A', 'www', '192.0.2.2'), rec('A', 'www', '192.0.2.1'), rec('A', 'www', '192.0.2.1'), rec('MX', '@', 'mail.example.com', 10), rec('TXT', '@', 'v=spf1 ~all')])
    expect(rr).toEqual([
      { name: 'example.com.', type: 'MX', changetype: 'REPLACE', ttl: 3600, records: [{ content: '10 mail.example.com.', disabled: false }] },
      { name: 'example.com.', type: 'TXT', changetype: 'REPLACE', ttl: 3600, records: [{ content: '"v=spf1 ~all"', disabled: false }] },
      {
        name: 'www.example.com.',
        type: 'A',
        changetype: 'REPLACE',
        ttl: 3600,
        records: [
          { content: '192.0.2.1', disabled: false },
          { content: '192.0.2.2', disabled: false },
        ],
      },
    ])
  })

  it('uses the lowest TTL of an rrset and chunks long TXT', () => {
    const rr = pdnsRrsets([{ ...rec('A', 'x', '192.0.2.1'), ttl: 300 }, { ...rec('A', 'x', '192.0.2.2'), ttl: 60 }])
    expect(rr[0]?.ttl).toBe(60)
    const t = pdnsContent(validateRecord(rec('TXT', 'k._domainkey', 'p'.repeat(300))))
    expect(t).toBe(`"${'p'.repeat(255)}" "${'p'.repeat(45)}"`)
  })

  it('builds a zone creation request', () => {
    const req = pdnsCreateZone('example.com', zone)
    expect(req.method).toBe('POST')
    expect(req.path).toBe('/api/v1/servers/localhost/zones')
    const body = req.body as { name: string; kind: string; nameservers: string[]; soa_edit_api: string; rrsets: { name: string; type: string; changetype?: string }[] }
    expect(body).toMatchObject({ name: 'example.com.', kind: 'Native', nameservers: [], soa_edit_api: 'DEFAULT' })
    expect(body.rrsets.some((r) => r.type === 'SOA' && r.name === 'example.com.')).toBe(true)
    expect(body.rrsets.every((r) => r.changetype === undefined)).toBe(true)
  })

  it('diffs current against desired: REPLACE changed rrsets, DELETE removed ones, never the SOA', () => {
    const soa = rec('SOA', '@', 'ns1.host.net. h.host.net. 1 2 3 4 5')
    const current = [soa, rec('A', 'www', '192.0.2.1'), rec('A', 'old', '192.0.2.9'), rec('TXT', '@', 'same')]
    const desired = [rec('A', 'www', '192.0.2.2'), rec('TXT', '@', 'same'), rec('A', 'new', '192.0.2.3')]
    expect(pdnsDiff('example.com', current, desired)).toEqual([
      { name: 'new.example.com.', type: 'A', changetype: 'REPLACE', ttl: 3600, records: [{ content: '192.0.2.3', disabled: false }] },
      { name: 'www.example.com.', type: 'A', changetype: 'REPLACE', ttl: 3600, records: [{ content: '192.0.2.2', disabled: false }] },
      { name: 'old.example.com.', type: 'A', changetype: 'DELETE' },
    ])
    expect(pdnsDiff('example.com', desired, desired)).toEqual([])
    rejects(() => pdnsDiff('example.com', [], [{ ...rec('A', 'x', '192.0.2.1'), zone: 'other.com' }]), /expected example.com/)
  })

  it('never rolls the SOA serial back below the live one (soa_edit_api moves it on every PATCH)', () => {
    const soa = (serial: number, mname = 'ns1.host.net.'): RecordInput => rec('SOA', '@', `${mname} h.host.net. ${serial} 3600 1800 1209600 3600`)
    const live = [soa(2026102207)]
    // only the serial differs: nothing to send
    expect(pdnsDiff('example.com', live, [soa(2026102201)])).toEqual([])
    // a real change with a stale stored serial goes out as live + 1
    expect(pdnsDiff('example.com', live, [soa(2026102201, 'ns2.host.net.')])).toEqual([
      { name: 'example.com.', type: 'SOA', changetype: 'REPLACE', ttl: 3600, records: [{ content: 'ns2.host.net. h.host.net. 2026102208 3600 1800 1209600 3600', disabled: false }] },
    ])
    // a newer stored serial is kept as is
    expect(pdnsDiff('example.com', live, [soa(2026102301, 'ns2.host.net.')])[0]?.records?.[0]?.content).toContain(' 2026102301 ')
    // a TTL change on the SOA is a real change too
    expect(pdnsDiff('example.com', live, [{ ...soa(2026102201), ttl: 60 }])[0]?.records?.[0]?.content).toContain(' 2026102208 ')
    rejects(() => pdnsDiff('example.com', [soa(4294967295)], [soa(1, 'ns2.host.net.')]), /overflow/)
  })

  it('reads live PowerDNS rrsets back into canonical records for diffing', () => {
    const desired = [rec('MX', '@', 'mail.example.com', 10), rec('TXT', '@', 'v=spf1 "q" ~all'), rec('SRV', '_sip._tcp', '5 5060 sip.example.com', 1)]
    const live = pdnsRrsets(desired).map(({ changetype: _c, ...r }) => ({ ...r, ttl: r.ttl ?? 0, records: r.records ?? [] }))
    const back = fromPdnsRrsets('example.com', [
      ...live,
      { name: 'example.com.', type: 'DNSKEY', ttl: 3600, records: [{ content: '257 3 13 abc', disabled: false }] },
      { name: 'off.example.com.', type: 'A', ttl: 60, records: [{ content: '192.0.2.9', disabled: true }] },
      { name: 'bad.example.com.', type: 'A', ttl: 60, records: [{ content: 'nope', disabled: false }] },
    ])
    expect(pdnsDiff('example.com', back.records, desired)).toEqual([])
    expect(back.skipped.map((x) => x.reason)).toEqual(['unsupported type', 'disabled record', expect.stringMatching(/IPv4/)])
  })

  it('builds patch, delete-rrset and notify requests on validated paths', () => {
    expect(pdnsZonePath('Example.com')).toBe('/api/v1/servers/localhost/zones/example.com.')
    expect(pdnsDeleteRrset('example.com', 'old', 'A')).toEqual({ name: 'old.example.com.', type: 'A', changetype: 'DELETE' })
    expect(pdnsNotify('example.com', { serverId: 'ns-a' })).toEqual({ method: 'PUT', path: '/api/v1/servers/ns-a/zones/example.com./notify' })
    expect(pdnsPatchZone('example.com', [pdnsDeleteRrset('example.com', 'x', 'TXT')]).method).toBe('PATCH')
    rejects(() => pdnsPatchZone('example.com', []))
    rejects(() => pdnsZonePath('example.com', { serverId: '../../config' }))
    rejects(() => pdnsZonePath('example.com/../x'))
  })
})

describe('ACME dns-01 TXT changes', () => {
  const t1 = 'A'.repeat(43)
  const t2 = 'b_-'.repeat(14) + 'c'

  it('maps identifiers to _acme-challenge names; wildcard validates at the base', () => {
    expect(acmeChallengeFqdn('www.example.com')).toBe('_acme-challenge.www.example.com')
    expect(acmeChallengeFqdn('*.example.com')).toBe('_acme-challenge.example.com')
    expect(acmeChallengeFqdn('_acme-challenge.example.com')).toBe('_acme-challenge.example.com')
  })

  it('adds with REPLACE, keeping values that must survive', () => {
    const req = acmeTxtChange('example.com', '*.example.com', t2, 'add', { keep: [t1] })
    expect(req).toEqual({
      method: 'PATCH',
      path: '/api/v1/servers/localhost/zones/example.com.',
      body: {
        rrsets: [
          {
            name: '_acme-challenge.example.com.',
            type: 'TXT',
            changetype: 'REPLACE',
            ttl: 60,
            records: [
              { content: `"${t1}"`, disabled: false },
              { content: `"${t2}"`, disabled: false },
            ],
          },
        ],
      },
    })
  })

  it('deletes the rrset when nothing remains, otherwise replaces with the rest', () => {
    expect(acmeTxtChange('example.com', 'example.com', [t1, t2], 'delete').body).toEqual({
      rrsets: [{ name: '_acme-challenge.example.com.', type: 'TXT', changetype: 'DELETE' }],
    })
    const partial = acmeTxtChange('example.com', 'example.com', t1, 'delete', { keep: [t1, t2] }).body as { rrsets: { changetype: string; records?: unknown[] }[] }
    expect(partial.rrsets[0]).toMatchObject({ changetype: 'REPLACE', records: [{ content: `"${t2}"`, disabled: false }] })
  })

  it('rejects names outside the zone, malformed tokens and bad operations', () => {
    rejects(() => acmeTxtChange('example.com', 'www.other.com', t1, 'add'), /outside zone/)
    rejects(() => acmeTxtChange('example.com', 'www.example.com', 'short', 'add'), /43 base64url/)
    rejects(() => acmeTxtChange('example.com', 'www.example.com', `${'A'.repeat(42)}"`, 'add'))
    rejects(() => acmeTxtChange('example.com', 'www.example.com', [], 'add'))
    rejects(() => acmeTxtChange('example.com', 'www.example.com', t1, 'upsert' as 'add'), /add or delete/)
  })
})
