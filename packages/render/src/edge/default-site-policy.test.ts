import { describe, expect, it } from 'vitest'
import { defaultSiteFile, renderDefaultSite, verifyNginxEdgeIsolation } from './nginx.ts'
import { account, cert, debianOs, domain, settings } from './testkit.ts'

describe('explicit default-site policy at the real Nginx renderer', () => {
  it('keeps the original output byte-for-byte for an absent or explicit rejecting policy', () => {
    const source = settings()
    expect(renderDefaultSite({ settings: { ...source, defaultSite: undefined } })).toBe(renderDefaultSite({ settings: source }))
    expect(renderDefaultSite({ settings: { ...source, defaultSite: { response: 'reject', redirectTo: null, refuseHttps: false } } })).toBe(renderDefaultSite({ settings: source }))
    const proof = verifyNginxEdgeIsolation(account(), [domain()], source, debianOs)
    expect(proof.defaultCatchall.returns404).toBe(true)
    expect(proof.defaultCatchall).not.toHaveProperty('fixedRedirect')
  })
  it('renders only an explicit fixed302 target while preserving ACME, log and zero-home/no-proxy boundaries', () => {
    const source = { ...settings(), defaultSite: { response: 'redirect' as const, redirectTo: 'https://landing.example.test/path?q=1', refuseHttps: false } }
    const file = defaultSiteFile(debianOs, { settings: source })
    expect(file.content).toContain('return 302 "https://landing.example.test/path?q=1";')
    expect(file.content).toContain('/.well-known/acme-challenge/')
    expect(file.content).toContain('/default.access.log xpanel_metrics;')
    expect(file.content).not.toContain('return 404;')
    expect(file.content).not.toContain('proxy_pass')
    expect(file.content).not.toContain('/home')
    expect(verifyNginxEdgeIsolation(account(), [domain()], source, debianOs).defaultCatchall).toMatchObject({ returns404: false, fixedRedirect: source.defaultSite.redirectTo, noProxyPass: true, defaultServer80: true, defaultServer443: true })
  })
  it('uses persisted HTTPS refusal through the existing fallback-certificate policy', () => {
    const source = { ...settings(), defaultSite: { response: 'reject' as const, redirectTo: null, refuseHttps: true } }
    expect(renderDefaultSite({ settings: source })).toContain('ssl_reject_handshake on;')
    expect(renderDefaultSite({ settings: source })).not.toContain('ssl_certificate ')
    expect(renderDefaultSite({ settings: source, cert: cert({ id: 'host' }) })).toContain('/etc/xpanel/ssl/host/fullchain.pem')
  })
  it('refuses invalid direct renderer policy inputs instead of bypassing the shared boundary', () => {
    const source = { ...settings(), defaultSite: { response: 'redirect' as const, redirectTo: 'https://example.test/$host', refuseHttps: false } }
    expect(() => renderDefaultSite({ settings: source })).toThrow()
    expect(() => verifyNginxEdgeIsolation(account(), [domain()], source, debianOs)).toThrow()
  })
})
