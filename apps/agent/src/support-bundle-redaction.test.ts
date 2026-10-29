import { describe, expect, it } from 'vitest'
import { createSupportRedactor, isSupportRedacted, redactSupportValue, SUPPORT_REDACTION_RULES } from './support-bundle-redaction.ts'
import { translator } from '../../web/src/i18n.ts'

const key = new Uint8Array(32).fill(7)
const redact = createSupportRedactor(key)

describe('support bundle redaction', () => {
  it('replaces PEM blocks, including one cut off by the message limit', () => {
    // Markers are assembled at run time so secret scanners do not read this synthetic, non-working fragment as a key.
    const marker = (edge: string, label: string): string => '-'.repeat(5) + edge + ' ' + label + '-'.repeat(5)
    const pem = marker('BEGIN', 'PRIVATE KEY') + '\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n' + marker('END', 'PRIVATE KEY')
    expect(redact('loaded ' + pem + ' ok')).toBe('loaded [redacted:pem] ok')
    expect(redact('cert -----BEGIN CERTIFICATE-----\nMIIDdzCCAl+gAwIBAgIE')).toBe('cert [redacted:pem]')
    expect(redact(marker('BEGIN', 'OPENSSH PRIVATE KEY') + '\nb3BlbnNzaC1rZXktdjEAAAAA\n' + marker('END', 'OPENSSH PRIVATE KEY'))).toBe('[redacted:pem]')
  })

  it('replaces Authorization and Cookie headers to the end of the line, in text and JSON', () => {
    expect(redact('GET / Authorization: Bearer abc.def.ghi extra\nnext')).toBe('GET / Authorization: [redacted]\nnext')
    expect(redact('proxy-authorization=Basic dXNlcjpwYXNz')).toBe('proxy-authorization=[redacted]')
    expect(redact('Cookie: xpanel_session=0123456789abcdef; theme=dark')).toBe('Cookie: [redacted]')
    expect(redact('{"set-cookie":"sid=abc; HttpOnly"}')).toBe('{"set-cookie":[redacted]')
  })

  it('replaces bearer, panel and JSON web tokens and secret assignments', () => {
    expect(redact('sent Bearer 0123456789abcdefABCDEF to peer')).toBe('sent Bearer [redacted] to peer')
    expect(redact('token xp_' + 'A'.repeat(43) + ' used')).toBe('token [redacted:token] used')
    expect(redact('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl')).toBe('jwt [redacted:token]')
    expect(redact('x-xpanel-agent-token: s3cr3t-value')).toBe('x-xpanel-agent-token: [redacted]')
    expect(redact('db_password = "two words"; api_key=abc&csrfToken=zz')).toBe('db_password = [redacted]; api_key=[redacted]&csrfToken=[redacted]')
    expect(redact('{"secret":"hunter2","session_id":\'q\'}')).toBe('{"secret":[redacted],"session_id":[redacted]}')
    expect(redact('user=password=abc')).toBe('user=password=[redacted]')
    expect(redact('https://admin:pa55@mirror.example.test/repo')).toBe('https://[redacted]@mirror.example.test/repo')
  })

  it('replaces emails and IPv4/IPv6 addresses with stable keyed hashes', () => {
    const once = redact('from alice@example.test to 192.0.2.10 and 2001:db8::1, again alice@example.test 192.0.2.10.')
    expect(once).not.toMatch(/alice|example\.test|192\.0\.2\.10|2001:db8/)
    const email = /\[email:[0-9a-f]{12}\]/g, v4 = /\[ipv4:[0-9a-f]{12}\]/g
    const emails = once.match(email)!, ipv4 = once.match(v4)!
    expect(emails).toHaveLength(2)
    expect(emails[0]).toBe(emails[1])
    expect(ipv4).toHaveLength(2)
    expect(ipv4[0]).toBe(ipv4[1])
    expect(once).toMatch(/\[ipv6:[0-9a-f]{12}\],/)
    expect(once.endsWith(ipv4[1] + '.')).toBe(true)
    expect(createSupportRedactor(new Uint8Array(32).fill(8))('192.0.2.10')).not.toBe(redact('192.0.2.10'))
    for (const value of ['[2001:db8::2]:443', 'fe80::1%eth0', '::ffff:192.0.2.1', 'peer ::1 closed', 'addr:2001:db8::3']) expect(redact(value)).toMatch(/\[ipv6:[0-9a-f]{12}\]/)
    expect(redact('10.0.0.1:8443')).toMatch(/^\[ipv4:[0-9a-f]{12}\]:8443$/)
  })

  it('keeps times, versions, MAC addresses and ordinary text', () => {
    for (const value of ['2026-10-27T10:00:00.000Z', 'at 12:30:45.', 'node v26.12.1', 'mac 00:1a:2b:3c:4d:5e', 'xpanel-agent.service started', 'checksum 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', '999.1.1.1'])
      expect(redact(value)).toBe(value)
  })

  it('is a fixed point, redacts object keys and proves a pass ran', () => {
    const raw = { 'alice@example.test': ['Authorization: Basic x', 'password=1', 'ip 198.51.100.7', { nested: 'cookie=a' }], count: 3, flag: null }
    const value = redactSupportValue(raw, redact)
    expect(redactSupportValue(value, createSupportRedactor())).toEqual(value)
    expect(JSON.stringify(value)).not.toMatch(/alice|Basic x|password=1|198\.51|cookie=a/)
    expect(value.count).toBe(3)
    expect(isSupportRedacted(value)).toBe(true)
    expect(isSupportRedacted(raw)).toBe(false)
  })

  it('stays linear on hostile 4 KiB lines', () => {
    const started = Date.now()
    for (const line of ['token'.repeat(820), 'a'.repeat(4096), ':'.repeat(4096), '-----BEGIN X-----'.repeat(240), 'a.'.repeat(2048) + '@', '1.'.repeat(2048)]) redact(line)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('documents every rule as a catalog message with an Arabic translation', () => {
    expect(SUPPORT_REDACTION_RULES.map(rule => rule.id)).toEqual(['pem-block', 'authorization-header', 'cookie-header', 'bearer-token', 'url-credentials', 'panel-token', 'secret-assignment', 'email-address', 'ip-address'])
    for (const rule of SUPPORT_REDACTION_RULES) { const arabic = translator('ar')(rule.text); expect(arabic).toMatch(/[؀-ۿ]/); expect(rule.text + arabic).not.toMatch(/[٠-٩۰-۹]/) }
  })
})
