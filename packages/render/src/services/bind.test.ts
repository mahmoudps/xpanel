import { describe, expect, it } from 'vitest'
import { isXpanelError } from '@xpanel/core'
import { parseBindTtl, parseBindZone, renderBindZone } from './bind.ts'
import { defaultZoneRecords, type ZoneRecord } from './dns.ts'

const rejects = (fn: () => unknown, pattern?: RegExp): void => {
  let err: unknown
  try {
    fn()
  } catch (e) {
    err = e
  }
  expect(isXpanelError(err), `expected VALIDATION, got ${String(err)}`).toBe(true)
  if (pattern && isXpanelError(err)) expect(err.message).toMatch(pattern)
}

// Shaped like a cPanel dnszones/example.com.db: no $ORIGIN, absolute and relative owners,
// multi-line SOA in parentheses, comments, tab/space mix, quoted TXT with ; and spaces.
const CPANEL_ZONE = `; cPanel first:110.0.18 (update_time):1729555200
; Zone file for example.com
$TTL 14400
example.com.\t86400\tIN\tSOA\tns1.host.net.\thostmaster.host.net.\t(
\t\t\t\t\t\t2026102103\t;Serial Number
\t\t\t\t\t\t3600\t;refresh
\t\t\t\t\t\t7200\t;retry
\t\t\t\t\t\t1209600\t;expire
\t\t\t\t\t\t86400\t)\t;minimum

example.com.\t86400\tIN\tNS\tns1.host.net.
example.com.\t86400\tIN\tNS\tns2.host.net.

example.com.\t14400\tIN\tA\t203.0.113.10
localhost\t14400\tIN\tA\t127.0.0.1
example.com.\t14400\tIN\tMX\t0\texample.com.
mail\t14400\tIN\tCNAME\texample.com.
www\t14400\tIN\tCNAME\texample.com.
ftp\t14400\tIN\tA\t203.0.113.10
webmail 14400 IN A 203.0.113.10 ; trailing comment
example.com.\tIN\t14400\tTXT\t"v=spf1 +a +mx +ip4:203.0.113.10 ~all"
_dmarc 14400 IN TXT "v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com"
default._domainkey\t14400\tIN\tTXT\t( "v=DKIM1; k=rsa; "
\t\t"p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA" )
note 300 IN TXT "say \\"hi\\"; then (leave)" "  two parts"
_sip._tcp 14400 IN SRV 10 5 5060 sip
\t\t14400 IN SRV 20 5 5060 sip2.example.com.
example.com. 3600 IN CAA 0 issue "letsencrypt.org"
1.10.113.203.in-addr.arpa. 14400 IN PTR example.com.
example.com. 14400 CH TXT "chaos"
`

const byType = (rs: ZoneRecord[], name: string, type: string): ZoneRecord[] => rs.filter((r) => r.name === name && r.type === type)

describe('parseBindZone (cPanel dnszones import)', () => {
  const z = parseBindZone(CPANEL_ZONE, { origin: 'example.com' })

  it('reads the parenthesized multi-line SOA with comments inside', () => {
    expect(z.zone).toBe('example.com')
    expect(z.records[0]).toEqual({
      zone: 'example.com',
      name: '@',
      type: 'SOA',
      ttl: 86400,
      content: 'ns1.host.net. hostmaster.host.net. 2026102103 3600 7200 1209600 86400',
      priority: null,
    })
  })

  it('resolves absolute and relative names and $TTL defaults', () => {
    expect(byType(z.records, '@', 'NS').map((r) => r.content)).toEqual(['ns1.host.net.', 'ns2.host.net.'])
    expect(byType(z.records, 'localhost', 'A')[0]?.content).toBe('127.0.0.1')
    expect(byType(z.records, 'www', 'CNAME')[0]?.content).toBe('example.com.')
    expect(byType(z.records, 'webmail', 'A')[0]).toMatchObject({ ttl: 14400, content: '203.0.113.10' })
    expect(byType(z.records, '@', 'MX')[0]).toMatchObject({ priority: 0, content: 'example.com.' })
  })

  it('accepts class before TTL', () => {
    expect(byType(z.records, '@', 'TXT')[0]).toMatchObject({ ttl: 14400, content: 'v=spf1 +a +mx +ip4:203.0.113.10 ~all' })
  })

  it('keeps semicolons, spaces, parentheses and escaped quotes inside TXT strings', () => {
    expect(byType(z.records, '_dmarc', 'TXT')[0]?.content).toBe('v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com')
    expect(byType(z.records, 'note', 'TXT')[0]).toMatchObject({ ttl: 300, content: 'say "hi"; then (leave)  two parts' })
  })

  it('joins multi-string TXT split across lines in parentheses', () => {
    expect(byType(z.records, 'default._domainkey', 'TXT')[0]?.content).toBe('v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA')
  })

  it('continues the previous owner on blank-owner lines and absolutizes relative targets', () => {
    expect(byType(z.records, '_sip._tcp', 'SRV').map((r) => [r.priority, r.content])).toEqual([
      [10, '5 5060 sip.example.com.'],
      [20, '5 5060 sip2.example.com.'],
    ])
  })

  it('reads CAA', () => {
    expect(byType(z.records, '@', 'CAA')[0]?.content).toBe('0 issue "letsencrypt.org"')
  })

  it('reports what it skipped instead of importing it', () => {
    expect(z.skipped.map((s) => [s.line, s.type])).toEqual([
      [29, 'PTR'],
      [30, 'TXT'],
    ])
    expect(z.skipped[1]?.reason).toMatch(/class CH/)
  })
})

describe('parseBindZone directives and edge cases', () => {
  it('honours $ORIGIN changes, @, TTL units and CRLF line endings', () => {
    const text = [
      '$ORIGIN example.org.',
      '$TTL 1h',
      '@ IN SOA ns1 admin\\.ops ( 2026010101 2h 30m 2w 1d )',
      '@ IN NS ns1',
      'ns1 IN A 192.0.2.53',
      '$ORIGIN dev.example.org.',
      'api 5m IN A 192.0.2.80',
      '* IN AAAA 2001:db8::80',
      '',
    ].join('\r\n')
    const z = parseBindZone(text)
    expect(z.zone).toBe('example.org')
    expect(z.records[0]?.content).toBe('ns1.example.org. admin\\.ops.example.org. 2026010101 7200 1800 1209600 86400')
    expect(z.records[0]?.ttl).toBe(3600)
    expect(byType(z.records, 'api.dev', 'A')[0]?.ttl).toBe(300)
    expect(byType(z.records, '*.dev', 'AAAA')[0]?.content).toBe('2001:db8::80')
    expect(z.skipped).toEqual([])
  })

  it('takes the zone from the SOA owner when there is no origin', () => {
    const z = parseBindZone('example.net. 3600 IN SOA ns1.example.net. h.example.net. 1 2 3 4 5\nexample.net. 3600 IN NS ns1.example.net.\n')
    expect(z.zone).toBe('example.net')
    expect(z.records).toHaveLength(2)
  })

  it('skips out-of-zone and invalid records with reasons', () => {
    const z = parseBindZone('www 300 IN A 999.1.1.1\nother.org. 300 IN A 192.0.2.1\nmx 300 IN MX ten mail\nok 300 IN A 192.0.2.2\n', { origin: 'example.com' })
    expect(z.records.map((r) => r.name)).toEqual(['ok'])
    expect(z.skipped.map((s) => s.line)).toEqual([1, 2, 3])
    expect(z.skipped.find((s) => s.line === 2)?.reason).toMatch(/outside zone/)
  })

  it('refuses $INCLUDE, $GENERATE and structural syntax errors', () => {
    rejects(() => parseBindZone('$INCLUDE /etc/shadow\n', { origin: 'example.com' }), /not supported/)
    rejects(() => parseBindZone('$GENERATE 1-10 host$ A 192.0.2.$\n', { origin: 'example.com' }), /not supported/)
    rejects(() => parseBindZone('@ IN SOA ns1 h ( 1 2 3 4 5\n', { origin: 'example.com' }), /unbalanced/)
    rejects(() => parseBindZone('@ IN TXT "open\n', { origin: 'example.com' }), /quoted string/)
    rejects(() => parseBindZone('x ) IN A 192.0.2.1\n', { origin: 'example.com' }), /unbalanced/)
    rejects(() => parseBindZone('www IN A 192.0.2.1\n'), /before \$ORIGIN/)
    rejects(() => parseBindZone('\tIN A 192.0.2.1\n', { origin: 'example.com' }), /without an owner/)
    rejects(() => parseBindZone('x 300 IN\n', { origin: 'example.com' }), /without a type/)
  })

  it('applies the whole-zone rules: duplicates collapse, a CNAME next to other data is refused', () => {
    const dup = parseBindZone('www 300 IN A 192.0.2.1\nWWW.example.com. 300 IN A 192.0.2.1\n', { origin: 'example.com' })
    expect(dup.records).toHaveLength(1)
    rejects(() => parseBindZone('www 300 IN CNAME example.com.\nwww 300 IN A 192.0.2.1\n', { origin: 'example.com' }), /CNAME next to/)
  })

  it('never lets a quoted newline or escape smuggle a second record', () => {
    const z = parseBindZone('t 300 IN TXT "a\\010b"\n', { origin: 'example.com' })
    expect(z.records).toEqual([])
    expect(z.skipped[0]?.reason).toMatch(/control/)
  })

  it('parses BIND TTL units', () => {
    expect(parseBindTtl('3600')).toBe(3600)
    expect(parseBindTtl('1h30m')).toBe(5400)
    expect(parseBindTtl('2W')).toBe(1209600)
    rejects(() => parseBindTtl('1y'))
  })
})

describe('renderBindZone', () => {
  const records = defaultZoneRecords('example.com', {
    ipv4: '203.0.113.10',
    ipv6: '2001:db8::10',
    nameservers: ['ns1.host.net', 'ns2.host.net'],
    mailHost: 'mail.example.com',
    adminEmail: 'host.master@host.net',
    wildcard: true,
    today: new Date('2026-10-22T00:00:00Z'),
  })

  it('writes $ORIGIN, $TTL, a multi-line SOA first and relative names', () => {
    const text = renderBindZone(records)
    const lines = text.split('\n')
    expect(lines.slice(0, 4)).toEqual(['; zone example.com exported by xPanel', '$ORIGIN example.com.', '$TTL 14400', '@\t14400\tIN\tSOA\tns1.host.net. host\\.master.host.net. ('])
    expect(text).toContain('@\t14400\tIN\tMX\t10 mail.example.com.\n')
    expect(text).toContain('_dmarc\t14400\tIN\tTXT\t"v=DMARC1; p=none"\n')
    expect(text).toContain('*\t14400\tIN\tA\t203.0.113.10\n')
  })

  it('round-trips through parseBindZone', () => {
    const parsed = parseBindZone(renderBindZone(records), { origin: 'example.com' })
    expect(parsed.skipped).toEqual([])
    const key = (r: ZoneRecord): string => JSON.stringify(r)
    expect(parsed.records.map(key).sort()).toEqual(records.map(key).sort())
  })

  it('round-trips hostile TXT content safely', () => {
    const hostile: ZoneRecord = { zone: 'example.com', name: 'x', type: 'TXT', ttl: 60, content: 'a"; evil IN A 6.6.6.6 ; \\ (', priority: null }
    const text = renderBindZone([hostile])
    expect(text).toContain('x\t60\tIN\tTXT\t"a\\"; evil IN A 6.6.6.6 ; \\\\ ("')
    expect(parseBindZone(text).records).toEqual([hostile])
  })

  it('refuses invalid input instead of exporting it', () => {
    rejects(() => renderBindZone([]))
    rejects(() => renderBindZone([{ zone: 'example.com', name: 'x\ny', type: 'A', ttl: 60, content: '192.0.2.1' }]))
  })

  it('refuses a default TTL that would inject a directive', () => {
    const one = [{ zone: 'example.com', name: 'x', type: 'A', ttl: 60, content: '192.0.2.1' }]
    expect(renderBindZone(one, { ttl: 300 })).toContain('$TTL 300\n')
    rejects(() => renderBindZone(one, { ttl: '1\n$INCLUDE /etc/shadow' as unknown as number }), /TTL/)
    rejects(() => renderBindZone(one, { ttl: -1 }), /TTL/)
  })
})

describe('parseBindZone SOA serial', () => {
  it('takes units only on the SOA timers, never on the serial', () => {
    const z = parseBindZone('@ 3600 IN SOA ns1.host.net. h.host.net. 1w 2h 30m 2w 1d\n@ 3600 IN NS ns1.host.net.\n', { origin: 'example.com' })
    expect(z.records.some((r) => r.type === 'SOA')).toBe(false)
    expect(z.skipped[0]).toMatchObject({ line: 1, type: 'SOA' })
    expect(z.skipped[0]?.reason).toMatch(/serial/)
  })
})
