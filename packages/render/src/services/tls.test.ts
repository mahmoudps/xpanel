import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { isXpanelError, type Certificate } from '@xpanel/core'
import { renderDefaultSite } from '../edge/nginx.ts'
import { DEFAULT_TLS, XP_PATHS, certPaths as edgeCertPaths } from '../edge/paths.ts'
import {
  ACME_CHALLENGE_PATH,
  assertKeyPair,
  certFiles,
  certInstall,
  certsForAutoRenew,
  coversHost,
  dns01Changes,
  dns01Value,
  http01File,
  normalizeCertName,
  planAcmeOrder,
  selectCertificate,
} from './tls.ts'

const rejects = (fn: () => unknown, pattern?: RegExp, code = 'VALIDATION'): void => {
  let err: unknown
  try {
    fn()
  } catch (e) {
    err = e
  }
  expect(isXpanelError(err), `expected ${code}, got ${String(err)}`).toBe(true)
  if (isXpanelError(err)) {
    expect(err.code).toBe(code)
    if (pattern) expect(err.message).toMatch(pattern)
  }
}

const cert = (id: string, names: string[], notAfter: string, over: Partial<Certificate> = {}): Certificate => ({
  id,
  accountId: 'acc1',
  names,
  source: 'acme',
  challenge: 'dns-01',
  notAfter,
  autoRenew: true,
  ...over,
})

describe('coversHost', () => {
  const wild = ['*.example.com']
  it('wildcard covers exactly one label', () => {
    expect(coversHost(wild, 'sub.example.com')).toBe(true)
    expect(coversHost(wild, 'SUB.Example.COM.')).toBe(true)
    expect(coversHost(wild, 'a.b.example.com')).toBe(false)
    expect(coversHost(wild, 'example.com')).toBe(false)
    expect(coversHost(wild, 'sub.example.org')).toBe(false)
    expect(coversHost(wild, 'subexample.com')).toBe(false)
  })

  it('covers the apex only when it is listed', () => {
    expect(coversHost(['*.example.com', 'example.com'], 'example.com')).toBe(true)
    expect(coversHost(['example.com'], 'www.example.com')).toBe(false)
  })

  it('never matches garbage hosts or partial wildcards', () => {
    expect(coversHost(wild, '*.example.com')).toBe(false)
    expect(coversHost(wild, '.example.com')).toBe(false)
    expect(coversHost(wild, 'evil\n.example.com')).toBe(false)
    expect(coversHost(['f*.example.com'], 'foo.example.com')).toBe(false)
    expect(coversHost([], 'example.com')).toBe(false)
  })
})

describe('placement', () => {
  it('places certificates exactly where the edge reads them: <sslDir>/<certificate id>/', () => {
    const edge = edgeCertPaths('cert_01H9')
    expect(certFiles('cert_01H9')).toEqual({ dir: `${XP_PATHS.sslDir}/cert_01H9`, fullchain: edge.cert, privkey: edge.key })
    expect(certFiles('cert_01H9').fullchain).toBe('/etc/xpanel/ssl/cert_01H9/fullchain.pem')
    for (const bad of ['../../etc', 'a/../../root', '*.example.com', 'example.com', '', 'x'.repeat(65), 'id\n']) rejects(() => certFiles(bad), /certificate id/)
    // the installer's self-signed fallback is never overwritten by an issued certificate
    expect(DEFAULT_TLS.cert).toBe(`${XP_PATHS.sslDir}/default/fullchain.pem`)
    rejects(() => certFiles('default'), /reserved/)
  })

  it('normalizes certificate names with core rules', () => {
    expect(normalizeCertName('*.Example.COM')).toBe('*.example.com')
    expect(normalizeCertName('münchen.de')).toBe('xn--mnchen-3ya.de')
    for (const bad of ['a.*.example.com', '*example.com', '*.*.example.com', '*.com', 'exa mple.com', '192.0.2.1']) rejects(() => normalizeCertName(bad), /certificate name/)
  })

  // Throwaway self-signed P-256 pairs made for these tests only (CN=test1.example / test2.example).
  const PEM = [
    '-----BEGIN CERTIFICATE-----',
    'MIIBVTCB+6ADAgECAhQsAft1gFT1XlYZD80uR4uVaZXR7zAKBggqhkjOPQQDAjAY',
    'MRYwFAYDVQQDDA10ZXN0MS5leGFtcGxlMCAXDTI2MTAyMjAwNDYwNloYDzIxMjYw',
    'OTI4MDA0NjA2WjAYMRYwFAYDVQQDDA10ZXN0MS5leGFtcGxlMFkwEwYHKoZIzj0C',
    'AQYIKoZIzj0DAQcDQgAEtJDJQWEZkRArZOBXijQpo4fKDexMyrqPH/wQLpF+yGNc',
    'vzmM51pWCeZQ37sV2dgn/iv/iMpaWaQ5W7hhhoh4Q6MhMB8wHQYDVR0OBBYEFE7S',
    'T4SH1XQjIrktrOW/ueJ5WVBGMAoGCCqGSM49BAMCA0kAMEYCIQDZ++vYHoh44PHA',
    'uB67iFdYufN/zxtFwgMupAHbZruB3AIhAMUN/uYXKYESNCauqt4nT6txqKvJFgcR',
    'c6/TrfjSYIxh',
    '-----END CERTIFICATE-----',
    '',
  ].join('\n')
  const KEY = [
    '-----BEGIN PRIVATE KEY-----',
    'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgxtJi/HKA9rw8Xjci',
    'EJBEompp48E2dTDJHCGDc0rbntChRANCAAS0kMlBYRmRECtk4FeKNCmjh8oN7EzK',
    'uo8f/BAukX7IY1y/OYznWlYJ5lDfuxXZ2Cf+K/+IylpZpDlbuGGGiHhD',
    '-----END PRIVATE KEY-----',
    '',
  ].join('\n')
  const PEM2 = [
    '-----BEGIN CERTIFICATE-----',
    'MIIBVDCB+6ADAgECAhQ1sh/yj5rp6Mp3CAyo3JvPsAaNZDAKBggqhkjOPQQDAjAY',
    'MRYwFAYDVQQDDA10ZXN0Mi5leGFtcGxlMCAXDTI2MTAyMjAwNDYwNloYDzIxMjYw',
    'OTI4MDA0NjA2WjAYMRYwFAYDVQQDDA10ZXN0Mi5leGFtcGxlMFkwEwYHKoZIzj0C',
    'AQYIKoZIzj0DAQcDQgAE/ZYHrtB1HFR0UzZfH1c6v3H4ejsW/91beL94Mdfk4Tz5',
    '0VfvaM58f4O9Rd3JvuL+RDtm+/LqcYmnfdUNPMAGFaMhMB8wHQYDVR0OBBYEFNo3',
    'YToHchvNcC9D3tjAGsE2eR5jMAoGCCqGSM49BAMCA0gAMEUCIE7bbK3tdGJ+2hKK',
    'IV9ww974MqakzXfmCd6gml3xqkERAiEAzoSOQDoB9cE+9vRbW5llgOpRJCZTCrhs',
    'U9C+XDbZt7U=',
    '-----END CERTIFICATE-----',
    '',
  ].join('\n')
  const KEY2 = [
    '-----BEGIN PRIVATE KEY-----',
    'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQghVtKMqkeyHIH+8V+',
    'UOT2EAfGnaSI6OZtcHVLbjc75z6hRANCAAT9lgeu0HUcVHRTNl8fVzq/cfh6Oxb/',
    '3Vt4v3gx1+ThPPnRV+9oznx/g71F3cm+4v5EO2b78upxiad91Q08wAYV',
    '-----END PRIVATE KEY-----',
    '',
  ].join('\n')

  it('installs the key 0600 root in a 0700 root directory', () => {
    const out = certInstall('c1', { fullchain: PEM + PEM2, privkey: KEY })
    expect(out.actions).toEqual([
      { kind: 'ensure-dir', path: '/etc/xpanel/ssl', mode: 0o755, owner: 'root', group: 'root' },
      { kind: 'ensure-dir', path: '/etc/xpanel/ssl/c1', mode: 0o700, owner: 'root', group: 'root' },
    ])
    expect(out.files).toEqual([
      { path: '/etc/xpanel/ssl/c1/fullchain.pem', content: PEM + PEM2, mode: 0o644, owner: 'root', group: 'root' },
      { path: '/etc/xpanel/ssl/c1/privkey.pem', content: KEY, mode: 0o600, owner: 'root', group: 'root' },
    ])
  })

  it('refuses a key that does not match the leaf, and chain blocks that are not X.509', () => {
    expect(() => assertKeyPair(PEM2 + PEM, KEY2)).not.toThrow()
    rejects(() => certInstall('c1', { fullchain: PEM, privkey: KEY2 }), /does not match/)
    // the leaf is the first block: a matching key for the intermediate does not count
    rejects(() => certInstall('c1', { fullchain: PEM2 + PEM, privkey: KEY }), /does not match/)
    const fake = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ0123456789abcdefABCDEF+/=\n-----END CERTIFICATE-----\n'
    rejects(() => certInstall('c1', { fullchain: PEM + fake, privkey: KEY }), /X\.509/)
    const fakeKey = '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg\n-----END PRIVATE KEY-----\n'
    rejects(() => certInstall('c1', { fullchain: PEM, privkey: fakeKey }), /parsable private key/)
  })

  it('refuses keys in the chain, encrypted keys and trailing junk', () => {
    rejects(() => certInstall('c1', { fullchain: PEM + KEY, privkey: KEY }), /CERTIFICATE/)
    rejects(() => certInstall('c1', { fullchain: PEM, privkey: KEY.replace(/PRIVATE KEY/g, 'ENCRYPTED PRIVATE KEY') }), /passphrase/)
    rejects(() => certInstall('c1', { fullchain: `${PEM}include /etc/shadow;\n`, privkey: KEY }))
    rejects(() => certInstall('c1', { fullchain: PEM, privkey: KEY + KEY }))
    rejects(() => certInstall('c1', { fullchain: PEM, privkey: KEY.replace('-----END PRIVATE KEY-----', '-----END RSA PRIVATE KEY-----') }))
  })
})

describe('certsForAutoRenew', () => {
  const now = new Date('2026-10-22T00:00:00Z')
  const certs = [
    cert('later', ['b.example.com'], '2026-11-20T00:00:00Z'),
    cert('soon', ['a.example.com'], '2026-10-30T00:00:00Z'),
    cert('far', ['c.example.com'], '2027-01-01T00:00:00Z'),
    cert('expired', ['d.example.com'], '2026-10-01T00:00:00Z'),
    cert('uploaded', ['e.example.com'], '2026-10-25T00:00:00Z', { source: 'upload', challenge: null }),
    cert('manual', ['f.example.com'], '2026-10-25T00:00:00Z', { autoRenew: false }),
    cert('selfsigned', ['g.example.com'], '2026-10-23T00:00:00Z', { source: 'self-signed', challenge: null }),
    cert('broken', ['h.example.com'], 'not a date'),
  ]

  it('picks auto-renewable certs inside the window, soonest first, never uploaded or manual ones', () => {
    expect(certsForAutoRenew(certs, now).map((c) => c.id)).toEqual(['broken', 'expired', 'selfsigned', 'soon', 'later'])
    expect(certsForAutoRenew(certs, now, 7).map((c) => c.id)).toEqual(['broken', 'expired', 'selfsigned'])
    expect(certsForAutoRenew(certs, now, 29).map((c) => c.id)).toContain('later')
    expect(certsForAutoRenew(certs, now, 28).map((c) => c.id)).not.toContain('later')
    rejects(() => certsForAutoRenew(certs, now, -1))
    rejects(() => certsForAutoRenew(certs, new Date('nope')), /now/)
    rejects(() => selectCertificate(certs, 'a.example.com', new Date('nope')), /now/)
  })

  it('selectCertificate prefers an exact unexpired name over a wildcard', () => {
    const pool = [
      cert('wild', ['example.com', '*.example.com'], '2027-03-01T00:00:00Z'),
      cert('exact', ['shop.example.com'], '2027-01-01T00:00:00Z'),
      cert('old', ['shop.example.com'], '2026-01-01T00:00:00Z'),
    ]
    expect(selectCertificate(pool, 'shop.example.com', now)?.id).toBe('exact')
    expect(selectCertificate(pool, 'blog.example.com', now)?.id).toBe('wild')
    expect(selectCertificate(pool, 'example.com', now)?.id).toBe('wild')
    expect(selectCertificate(pool, 'a.b.example.com', now)).toBeNull()
  })
})

describe('ACME planning', () => {
  it('plans http-01 against the shared webroot and refuses wildcards there', () => {
    const plan = planAcmeOrder(['WWW.example.com', 'example.com', 'example.com'], 'http-01')
    expect(plan.identifiers).toEqual(['example.com', 'www.example.com'])
    expect(plan.steps[0]).toEqual({ identifier: 'example.com', challenge: 'http-01', webroot: '/var/lib/xpanel/acme', urlPath: '/.well-known/acme-challenge/' })
    rejects(() => planAcmeOrder(['example.com', '*.example.com'], 'http-01'), /dns-01/)
    rejects(() => planAcmeOrder([], 'http-01'))
    rejects(() => planAcmeOrder(Array.from({ length: 101 }, (_, i) => `h${i}.example.com`), 'http-01'), /100/)
    rejects(() => planAcmeOrder(['example.com'], 'tls-alpn-01' as 'http-01'))
  })

  it('plans dns-01 in the longest hosted zone and fails when the zone is not ours', () => {
    const plan = planAcmeOrder(['*.example.com', 'example.com', 'api.dev.example.com'], 'dns-01', { zones: ['example.com', 'dev.example.com'] })
    expect(plan.steps).toEqual([
      { identifier: 'api.dev.example.com', challenge: 'dns-01', zone: 'dev.example.com', recordName: '_acme-challenge.api.dev.example.com' },
      { identifier: 'example.com', challenge: 'dns-01', zone: 'example.com', recordName: '_acme-challenge.example.com' },
      { identifier: '*.example.com', challenge: 'dns-01', zone: 'example.com', recordName: '_acme-challenge.example.com' },
    ])
    rejects(() => planAcmeOrder(['example.org'], 'dns-01', { zones: ['example.com'] }), /no hosted DNS zone/, 'PRECONDITION_FAILED')
  })

  it('publishes apex and wildcard TXT values together, then deletes the rrset', () => {
    const plan = planAcmeOrder(['example.com', '*.example.com'], 'dns-01', { zones: ['example.com'] })
    const v1 = 'A'.repeat(43)
    const v2 = 'B'.repeat(43)
    const { publish, cleanup } = dns01Changes(plan, { 'example.com': v1, '*.example.com': v2 })
    expect(publish).toEqual([
      {
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
                { content: `"${v1}"`, disabled: false },
                { content: `"${v2}"`, disabled: false },
              ],
            },
          ],
        },
      },
    ])
    expect(cleanup).toEqual([{ method: 'PATCH', path: '/api/v1/servers/localhost/zones/example.com.', body: { rrsets: [{ name: '_acme-challenge.example.com.', type: 'TXT', changetype: 'DELETE' }] } }])
    rejects(() => dns01Changes(plan, { 'example.com': v1 }), /missing/)
    rejects(() => dns01Changes(plan, { 'example.com': v1, '*.example.com': 'not-base64url!' }))
    rejects(() => dns01Changes(planAcmeOrder(['example.com'], 'http-01'), {}))
  })

  it('computes the dns-01 value and the http-01 file', () => {
    const ka = `${'t'.repeat(43)}.${'k'.repeat(43)}`
    expect(dns01Value(ka)).toBe(createHash('sha256').update(ka).digest('base64url'))
    expect(dns01Value(ka)).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const token = 't'.repeat(43)
    expect(http01File(token, ka)).toEqual({ path: `/var/lib/xpanel/acme/${token}`, content: ka, mode: 0o644, owner: 'root', group: 'root' })
    rejects(() => http01File('../../../etc/passwd', ka))
    rejects(() => http01File('short', 'short.x'))
    rejects(() => http01File(token, `${'x'.repeat(43)}.${'k'.repeat(43)}`), /key authorization/)
    rejects(() => dns01Value('nodot'))
  })

  it('writes the http-01 answer where the edge Nginx location resolves the challenge URL', () => {
    const conf = renderDefaultSite()
    const m = /location \^~ (\S+) \{\s*alias (\S+);/.exec(conf)
    expect(m?.[1]).toBe(ACME_CHALLENGE_PATH)
    const token = 'T'.repeat(43)
    const plan = planAcmeOrder(['example.com'], 'http-01')
    const step = plan.steps[0] as { webroot: string; urlPath: string }
    // nginx alias: the URI minus the location prefix is appended to the alias path
    const served = `${m?.[2]}${`${step.urlPath}${token}`.slice((m?.[1] ?? '').length)}`
    expect(http01File(token, `${token}.${'k'.repeat(43)}`).path).toBe(served)
    expect(served.startsWith(`${step.webroot}/`)).toBe(true)
  })
})
