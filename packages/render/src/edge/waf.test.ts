import { describe, expect, it } from 'vitest'
import { renderModsecurityMain, renderWafHttp, renderWafSite, siteZoneId } from './waf.ts'
import { codeOf } from './testkit.ts'

const ctx = { defaultBodyMb: 128 as const, modsecurityPresent: false }

describe('renderWafHttp', () => {
  it('defines limits status and the server-wide lists', () => {
    const c = renderWafHttp({
      denyIps: ['198.51.100.7', '203.0.113.0/24', '2001:db8::/32'],
      denyUserAgents: [String.raw`sqlmap`, String.raw`(?i)masscan`],
      denyPaths: [String.raw`^/\.git/`, String.raw`\.env$`],
      trustedIps: ['192.0.2.10'],
    })
    expect(c).toContain('limit_req_status 429;')
    expect(c).toContain('limit_conn_status 429;')
    expect(c).toContain('198.51.100.7 1;')
    expect(c).toContain('203.0.113.0/24 1;')
    expect(c).toContain('2001:db8::/32 1;')
    expect(c).toContain('192.0.2.10 1;')
    expect(c).toContain('"~*sqlmap" 1;')
    // backslashes doubled: nginx's parser turns \\ back into one backslash
    expect(c).toContain(String.raw`"~^/\\.git/" 1;`)
    expect(c).toContain(String.raw`"~\\.env$" 1;`)
    expect(c).toContain('default $binary_remote_addr;')
  })

  it('normalizes and de-duplicates addresses', () => {
    const c = renderWafHttp({ denyIps: ['198.51.100.7/32', '198.51.100.7', '2001:DB8::1'] })
    expect(c.match(/198\.51\.100\.7 1;/g)).toHaveLength(1)
    expect(c).toContain('2001:db8::1 1;')
  })

  it('rejects invalid addresses', () => {
    for (const ip of ['1.2.3.4; allow all', '1.2.3.4/33', '::1/129', '010.1.1.1', 'fe80::1%eth0', '1.2.3', 'abc', '1.2.3.4/8/9', '']) {
      expect(codeOf(() => renderWafHttp({ denyIps: [ip] }))).toBe('VALIDATION')
    }
  })

  it('rejects regexes that could break the config or do not compile', () => {
    const bad = [
      'a"; return 200; "',
      "it's",
      'abc\\',
      'line\nbreak',
      '$http_cookie',
      '${host}',
      '(unclosed',
      '(?C1)callout',
      '(?im)x',
      '',
      'x'.repeat(257),
    ]
    for (const r of bad) {
      expect(codeOf(() => renderWafHttp({ denyUserAgents: [r] }))).toBe('VALIDATION')
      expect(codeOf(() => renderWafHttp({ denyPaths: [r] }))).toBe('VALIDATION')
    }
    expect(codeOf(() => renderWafHttp({ denyPaths: [String.raw`\.php$`, '^/wp-(admin|login)', '(?i)^/admin'] }))).toBeNull()
  })

  it('rejects nested quantifiers that backtrack catastrophically in every nginx worker', () => {
    for (const r of ['(a+)+$', '(a*)*', '(?:x+)+y', String.raw`(\w+\s?)*$`, '((ab)+)+', '(a+){2,}', '(.*a){3,10}']) {
      expect(codeOf(() => renderWafHttp({ denyPaths: [r] }))).toBe('VALIDATION')
      expect(codeOf(() => renderWafSite('a.example', { denyUserAgents: [r] }, ctx))).toBe('VALIDATION')
    }
    for (const r of [String.raw`(\d{3})+`, '(ab)+', String.raw`^/(wp-admin|wp-login\.php)`, String.raw`[(+*]+`, String.raw`\(a+\)+`, 'a+b*c?']) {
      expect(codeOf(() => renderWafHttp({ denyPaths: [r] }))).toBeNull()
    }
  })

  it('caps list sizes', () => {
    const many = Array.from({ length: 5001 }, (_, i) => `10.${Math.floor(i / 256) % 256}.${i % 256}.1`)
    expect(codeOf(() => renderWafHttp({ denyIps: many }))).toBe('VALIDATION')
  })

  it('emits ModSecurity only when present', () => {
    expect(renderWafHttp(null, null)).not.toContain('modsecurity')
    const c = renderWafHttp(null, { engineConf: '/etc/modsecurity/modsecurity.conf', crsDir: null })
    expect(c).toContain('modsecurity on;')
    expect(c).toContain('modsecurity_rules_file /etc/xpanel/modsecurity/main.conf;')
    expect(codeOf(() => renderWafHttp(null, { engineConf: 'relative.conf', crsDir: null }))).toBe('VALIDATION')
  })
})

describe('renderModsecurityMain', () => {
  it('includes the engine config and OWASP CRS', () => {
    const f = renderModsecurityMain({ engineConf: '/etc/nginx/modsec/modsecurity.conf', crsDir: '/usr/share/modsecurity-crs' })
    expect(f.path).toBe('/etc/xpanel/modsecurity/main.conf')
    expect(f.content).toContain('Include /etc/nginx/modsec/modsecurity.conf')
    expect(f.content).toContain('Include /usr/share/modsecurity-crs/crs-setup.conf')
    expect(f.content).toContain('Include /usr/share/modsecurity-crs/rules/*.conf')
  })

  it('omits CRS when not installed and rejects hostile paths', () => {
    const f = renderModsecurityMain({ engineConf: '/etc/modsecurity/modsecurity.conf', crsDir: null })
    expect(f.content).not.toContain('crs')
    expect(codeOf(() => renderModsecurityMain({ engineConf: '/etc/x.conf\nSecRuleEngine Off', crsDir: null }))).toBe('VALIDATION')
    expect(codeOf(() => renderModsecurityMain({ engineConf: '/etc/x.conf', crsDir: '/usr/share/../../tmp' }))).toBe('VALIDATION')
  })
})

describe('renderWafSite', () => {
  it('always applies the server-wide lists and a body limit', () => {
    const r = renderWafSite('example.com', undefined, ctx)
    expect(r.http).toEqual([])
    expect(r.server).toContain('if ($xpanel_waf_deny_ip) { return 403; }')
    expect(r.server).toContain('if ($xpanel_waf_deny_ua) { return 403; }')
    expect(r.server).toContain('if ($xpanel_waf_deny_path) { return 403; }')
    expect(r.server).toContain('client_max_body_size 128m;')
  })

  it('renders per-site rate and connection limits with their own zones', () => {
    const id = siteZoneId('example.com')
    const r = renderWafSite('example.com', { rateLimit: { requests: 30, per: 'minute', burst: 5, nodelay: false }, connLimit: 10 }, ctx)
    expect(r.http).toContain(`limit_req_zone $xpanel_waf_key zone=xpw_r_${id}:1m rate=30r/m;`)
    expect(r.http).toContain(`limit_conn_zone $xpanel_waf_key zone=xpw_c_${id}:1m;`)
    expect(r.server).toContain(`limit_req zone=xpw_r_${id} burst=5;`)
    expect(r.server).toContain(`limit_conn xpw_c_${id} 10;`)
    expect(siteZoneId('example.com')).not.toBe(siteZoneId('example.net'))
  })

  it('renders deny lists as deny directives and conditions', () => {
    const r = renderWafSite('example.com', { denyIps: ['198.51.100.0/24'], denyUserAgents: ['curl'], denyPaths: [String.raw`^/xmlrpc\.php$`] }, ctx)
    expect(r.server).toContain('deny 198.51.100.0/24;')
    expect(r.server).toContain('if ($http_user_agent ~* "curl") { return 403; }')
    expect(r.server).toContain(String.raw`if ($uri ~ "^/xmlrpc\\.php$") { return 403; }`)
  })

  it('applies body size limits including explicit unlimited', () => {
    expect(renderWafSite('a.example', { maxBodyMb: 8 }, ctx).server).toContain('client_max_body_size 8m;')
    expect(renderWafSite('a.example', { maxBodyMb: 'unlimited' }, ctx).server).toContain('client_max_body_size 0;')
    expect(renderWafSite('a.example', { maxBodyMb: 102400 }, ctx).server).toContain('client_max_body_size 102400m;')
    expect(codeOf(() => renderWafSite('a.example', { maxBodyMb: 0 }, ctx))).toBe('VALIDATION')
    expect(codeOf(() => renderWafSite('a.example', { maxBodyMb: 102401 }, ctx))).toBe('VALIDATION')
    expect(codeOf(() => renderWafSite('a.example', { maxBodyMb: 1.5 }, ctx))).toBe('VALIDATION')
  })

  it('ignores site rules when disabled but keeps server-wide lists', () => {
    const r = renderWafSite('a.example', { enabled: false, denyIps: ['198.51.100.1'], rateLimit: { requests: 1, per: 'second', burst: 0 }, maxBodyMb: 1 }, ctx)
    expect(r.http).toEqual([])
    expect(r.server.join('\n')).not.toContain('deny 198.51.100.1')
    expect(r.server).toContain('if ($xpanel_waf_deny_ip) { return 403; }')
    expect(r.server).toContain('client_max_body_size 128m;')
  })

  it('switches ModSecurity off per site only when it is present', () => {
    expect(renderWafSite('a.example', { modsecurity: false }, ctx).server).not.toContain('modsecurity off;')
    expect(renderWafSite('a.example', { modsecurity: false }, { ...ctx, modsecurityPresent: true }).server).toContain('modsecurity off;')
    expect(renderWafSite('a.example', { modsecurity: true }, { ...ctx, modsecurityPresent: true }).server).not.toContain('modsecurity off;')
  })

  it('validates limits at their boundaries', () => {
    const rl = (requests: number, burst: number, per: 'second' | 'minute' = 'second') =>
      codeOf(() => renderWafSite('a.example', { rateLimit: { requests, per, burst } }, ctx))
    expect(rl(1, 0)).toBeNull()
    expect(rl(100000, 100000)).toBeNull()
    expect(rl(0, 0)).toBe('VALIDATION')
    expect(rl(100001, 0)).toBe('VALIDATION')
    expect(rl(10, -1)).toBe('VALIDATION')
    expect(rl(10, 1, 'hour' as 'second')).toBe('VALIDATION')
    expect(codeOf(() => renderWafSite('a.example', { connLimit: 0 }, ctx))).toBe('VALIDATION')
  })
})
