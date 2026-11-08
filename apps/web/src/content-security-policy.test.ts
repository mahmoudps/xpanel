import { describe, expect, it } from 'vitest'
import { tools } from '@xpanel/catalog'
import { defaultPlan, type Account } from '@xpanel/core'
import { serveStaticAsset, serveWebUi, type WebAppRenderState } from './app.ts'
import { CROSS_ORIGIN_FORM_CSP, DOCUMENT_CSP } from './content-security-policy.ts'
import { cspMarkupIssues } from './csp.test-helper.ts'

const catalog = tools.map(tool => tool.status === 'out-of-scope' ? tool : { ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const } })
const plan = defaultPlan({ id: 'csp-plan', name: 'Standard', featureListId: 'csp-features' })
const account: Account = { id: 'csp-account', username: 'alpha', uid: 20001, gid: 20001, home: '/home/alpha', primaryDomain: 'alpha.example.test', planId: plan.id, ownerId: null,
  status: 'active', suspendReason: null, contactEmail: 'alpha@example.test', ipv4: '192.0.2.10', ipv6: null, extraIps: [], shell: 'none', createdAt: '2026-11-08T00:00:00Z' }
const root = { kind: 'root' as const, id: 'csp-root', username: 'operator' }
const owner = { kind: 'user' as const, id: 'csp-owner', username: account.username, accountId: account.id }

const serve = async (path: string, state?: WebAppRenderState) => {
  const response = await serveWebUi(new Request('https://panel.example.test' + path), state && (() => state))
  return { response, html: await response.text() }
}
const scriptSources = (html: string): string[] => [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1]!)

describe('document Content-Security-Policy', () => {
  it('allows no inline or evaluated script, plugin, base URL or framing', () => {
    const directives = new Map(DOCUMENT_CSP.split('; ').map(part => [part.split(' ')[0], part]))
    expect(directives.get('script-src')).toBe("script-src 'self'")
    expect(DOCUMENT_CSP).not.toContain('unsafe-eval')
    expect([directives.get('object-src'), directives.get('base-uri'), directives.get('frame-ancestors'), directives.get('form-action')])
      .toEqual(["object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'"])
    expect(CROSS_ORIGIN_FORM_CSP).toBe(DOCUMENT_CSP.replace("form-action 'self'", "form-action 'self' https:"))
  })

  it.each(['classic', 'v2'])('sends it on the %s sign-in page, whose scripts all come from this origin', async uiTheme => {
    const { response, html } = await serve('/login', { surface: 'login', uiTheme })
    expect(response.headers.get('content-security-policy')).toBe(DOCUMENT_CSP)
    expect(response.headers.get('referrer-policy')).toBe('same-origin')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(cspMarkupIssues(html)).toEqual([])
    expect(html).toContain('<script type="application/json" id="xpanel-i18n-messages">')
    const sources = scriptSources(html)
    expect(sources.map(src => src.replace(/\?v=[0-9a-f]{16}$/, ''))).toEqual(['/assets/i18n-runtime.js', '/assets/login-client.js', '/assets/team-password.js'])
    for (const src of sources) {
      const asset = serveStaticAsset(new URL(src, 'https://panel.example.test').pathname)
      expect(asset?.status).toBe(200)
      expect(asset?.headers.get('content-type')).toBe('application/javascript; charset=utf-8')
    }
  })

  it('keeps it on a document the route table does not know', async () => {
    const { response, html } = await serve('/no-such-document')
    expect(response.status).toBe(404)
    expect(response.headers.get('content-security-policy')).toBe(DOCUMENT_CSP)
    expect(cspMarkupIssues(html)).toEqual([])
  })

  it('posts a handoff to another origin only from a document that renders the handoff controls', async () => {
    const { response, html } = await serve('/whm/accounts', { surface: 'xwhm', activeRoute: '/whm/accounts', catalog, visibility: { principal: root, disabledFeatures: new Set() },
      whm: { principal: root, accounts: [account], plans: [plan] } })
    expect(html).toContain('<script id="xpanel-handoff-client" src="/assets/handoff.js?v=')
    expect(response.headers.get('content-security-policy')).toBe(CROSS_ORIGIN_FORM_CSP)
    // The handoff target checks the exact Origin header of this cross-origin POST.
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
    expect(cspMarkupIssues(html)).toEqual([])
  })

  it('posts the phpMyAdmin sign-on ticket to the client origin, without widening the referrer policy', async () => {
    const { response, html } = await serve('/databases/phpmyadmin', { surface: 'xpanel', activeRoute: '/databases/phpmyadmin', catalog, accountId: account.id,
      visibility: { principal: owner, disabledFeatures: new Set() }, panel: { account, plan } })
    expect(html).toContain('data-db-engine="account-phpmyadmin"')
    expect(response.headers.get('content-security-policy')).toBe(CROSS_ORIGIN_FORM_CSP)
    expect(response.headers.get('referrer-policy')).toBe('same-origin')
  })
})
