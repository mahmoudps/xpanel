import { describe, expect, it } from 'vitest'
import { renderNginxSite } from './nginx.ts'
import { servedDomains, siteOpenBasedir } from './site-options.ts'
import { account, domain, settings } from './testkit.ts'

const site = (over: Parameters<typeof domain>[0] = {}): string => renderNginxSite(account(), [domain(over)], settings())

describe('site settings at the edge', () => {
  it('renders nothing for a site without settings', () => {
    const plain = site()
    expect(plain).not.toMatch(/limit_conn|# site settings|xpanel_usage/)
    expect(plain).toContain('xpanel_metrics;')
  })
  it('denies the extensions below a directory, PATH_INFO included, before any location', () => {
    const text = site({ site: { denyRules: [{ name: 'uploads', directory: '/up.loads', extensions: ['php', 'phtml'] }] } })
    expect(text).toContain('if ($uri ~* "^/up\\\\.loads/(?:.*/)?[^/]*\\\\.(?:php|phtml)(?:/|$)") { return 403; }')
    expect(site({ site: { denyRules: [{ name: 'all', directory: '/', extensions: ['sql'] }] } })).toContain('"^/(?:.*/)?[^/]*\\\\.(?:sql)(?:/|$)"')
  })
  it('limits one site with its own zones, answering 503', () => {
    const text = site({ site: { traffic: { siteConnections: 100, ipConnections: 2, rateKbPerConnection: 512 } } })
    expect(text).toMatch(/limit_conn_zone \$hostname zone=xps_s_[0-9a-f]{12}:1m;/)
    expect(text).toMatch(/limit_conn_zone \$xpanel_waf_key zone=xps_i_[0-9a-f]{12}:1m;/)
    expect(text).toMatch(/limit_conn xps_s_[0-9a-f]{12} 100;/)
    expect(text).toMatch(/limit_conn xps_i_[0-9a-f]{12} 2;/)
    expect(text).toContain('limit_rate 512k;')
    expect(text).toContain('limit_conn_status 503;')
    expect(text.indexOf('limit_conn_zone')).toBeLessThan(text.indexOf('server {'))
  })
  it('keeps usage lines and drops the visitor when logging is off', () => {
    expect(site({ site: { visitorLogOff: true } })).toMatch(/access_log \S+ xpanel_usage;/)
  })
  it('shows the escaped owner message on a stopped site and stops applying limits', () => {
    const text = site({ suspended: true, site: { stoppedMessage: 'Back at <b>9</b> for $5 "soon"', traffic: { siteConnections: 5, ipConnections: null, rateKbPerConnection: null }, denyRules: [{ name: 'x', directory: '/', extensions: ['php'] }] } })
    expect(text).toContain('return 503')
    expect(text).toContain('Back at &#60;b&#62;9&#60;/b&#62; for &#36;5 &#34;soon&#34;')
    expect(text).not.toMatch(/limit_conn|\$uri/)
    expect(renderNginxSite(account({ status: 'suspended' }), [domain({ site: { stoppedMessage: 'mine' } })], settings())).not.toContain('mine')
  })
  it('stops at the expiry and changes the file when only saved settings change', () => {
    const passed = renderNginxSite(account(), [domain({ expiresAt: '2026-01-01T00:00:00.000Z' })], settings(), null, { now: '2026-01-02T00:00:00.000Z' })
    expect(passed).toContain('return 503;')
    const render = (over: Parameters<typeof domain>[0]) => renderNginxSite(account(), [domain(over)], settings(), null, { now: '2025-01-01T00:00:00.000Z' })
    expect(render({ expiresAt: '2026-01-01T00:00:00.000Z' })).not.toBe(render({ expiresAt: '2026-02-01T00:00:00.000Z' }))
    expect(render({ pathQuotaMb: 100 })).not.toBe(render({ pathQuotaMb: 200 }))
    expect(render({ site: { category: 'a' } })).not.toBe(render({ site: { category: 'b' } }))
  })
  it('points the backend at the run directory and confines PHP to the project root', () => {
    expect(servedDomains([domain({ site: { runDirectory: 'public' } })])[0]!.docRoot).toBe('/home/alice/public_html/public')
    expect(siteOpenBasedir(account(), domain())).toBe('/home/alice/public_html:/home/alice/tmp')
  })
})
