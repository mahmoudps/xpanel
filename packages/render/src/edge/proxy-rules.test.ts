import type { ProxyOptions } from '@xpanel/core'
import { describe, expect, it } from 'vitest'
import { renderNginxSite } from './nginx.ts'
import { proxyRuleRefusal, type ProxyRule } from './proxy-rules.ts'
import { account, domain, settings } from './testkit.ts'

const options: ProxyOptions = { websocket: true, hostHeader: 'client', headers: [] }
const site = (rules: Record<string, ProxyRule[]>, extra: Parameters<typeof renderNginxSite>[4] = {}, server = settings()): string =>
  renderNginxSite(account(), [domain()], server, null, { proxyRules: rules, ...extra })

describe('reverse proxy rules at the nginx edge', () => {
  it('refuses loopback, link-local, panel ports and paths in the target', () => {
    const server = settings()
    for (const target of ['http://127.0.0.1:9000', 'http://localhost:9000', 'http://[::1]:9000']) expect(proxyRuleRefusal(target, server)).toBe('loopback')
    expect(proxyRuleRefusal('http://169.254.169.254', server)).toBe('forbidden_range')
    expect(proxyRuleRefusal('http://[::ffff:127.0.0.1]:9000', server)).toBe('forbidden_range')
    for (const port of [2083, 2087, 2096, 12083, 12087, 12096, server.panelPort, server.backendPort]) expect(proxyRuleRefusal(`http://203.0.113.7:${port}`, server)).toBe('panel_port')
    for (const target of ['http://203.0.113.7/base', 'ftp://203.0.113.7', 'http://user:secret@203.0.113.7', 'http://203.0.113.7:1;}', 7]) expect(proxyRuleRefusal(target, server)).toBe('invalid')
    expect(proxyRuleRefusal('https://203.0.113.7:9443', server)).toBeNull()
    expect(proxyRuleRefusal('http://10.0.0.5:9080', server)).toBeNull()
    expect(proxyRuleRefusal('https://app.example.net', server)).toBe('resolver_unavailable')
    expect(proxyRuleRefusal('https://app.example.net', { ...server, edge: { resolvers: ['192.0.2.53'] } } as typeof server)).toBeNull()
    expect(proxyRuleRefusal('https://app.example.net', { ...server, edge: { resolvers: ['192.0.2.0/24'] } } as typeof server)).toBe('resolver_unavailable')
  })

  it('renders a path rule beside the site backend and a root rule in place of it', () => {
    const name = domain().name
    const path = site({ [name]: [{ path: '/app', target: 'https://203.0.113.7:9443', options }] })
    expect(path).toContain('location = /app {')
    expect(path).toContain('return 308 /app/$is_args$args;')
    expect(path).toContain('location ^~ /app/ {')
    expect(path).toContain('proxy_pass https://203.0.113.7:9443;')
    expect(path).toContain('proxy_ssl_server_name on;')
    expect(path).toContain('proxy_set_header Proxy "";')
    expect(path).toContain('proxy_set_header X-Forwarded-For $remote_addr;')
    expect(path).toContain('proxy_pass http://127.0.0.1:')
    const root = site({ [name]: [{ path: '/', target: 'http://203.0.113.7:9080', options: { ...options, hostHeader: 'upstream', websocket: false } }] })
    expect(root).toContain('proxy_pass http://203.0.113.7:9080;')
    expect(root).toContain('proxy_set_header Host $proxy_host;')
    expect(root).not.toContain('proxy_pass http://127.0.0.1:')
  })

  it('keeps the account cache choice and resolves named targets per request', () => {
    const name = domain().name, rules = { [name]: [{ path: '/app', target: 'https://app.example.net', options }] }
    const named = site(rules, {}, { ...settings(), edge: { resolvers: ['192.0.2.53'] } } as ReturnType<typeof settings>)
    expect(named).toContain('resolver 192.0.2.53 valid=300s;')
    expect(named).toContain('proxy_pass https://app.example.net:443$request_uri;')
    expect(site({ [name]: [{ path: '/app', target: 'http://203.0.113.7:9080', options }] }, { cache: false })).not.toContain('proxy_cache xpanel_cache;')
  })

  it('leaves out a rule that would fail the configuration test of every site', () => {
    const name = domain().name
    const appTaken = site({ [name]: [{ path: '/api', target: 'http://203.0.113.7:9080', options }] }, { appRoutes: { [name]: [{ path: '/api', socket: '/run/xpanel-app-proxy/alice-api.sock' }] } })
    expect(appTaken.match(/location \^~ \/api\/ \{/g)).toHaveLength(1)
    expect(appTaken).toContain('# proxy rule skipped: /api (path already served)')
    expect(appTaken).not.toContain('203.0.113.7')
    const stale = site({ [name]: [{ path: '/app', target: `http://203.0.113.7:${settings().panelPort}`, options }] })
    expect(stale).toContain('# proxy rule skipped: /app (panel_port)')
    expect(stale).not.toContain('location ^~ /app/')
  })

  it('gives way to a suspended site', () => {
    const name = domain().name
    const suspended = renderNginxSite(account({ status: 'suspended' }), [domain()], settings(), null, { proxyRules: { [name]: [{ path: '/app', target: 'http://203.0.113.7:9080', options }] } })
    expect(suspended).not.toContain('203.0.113.7')
  })
})
