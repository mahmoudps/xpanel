// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_REVERSE_PROXY_CLIENT_BINDING, reverseProxyAcknowledged, reverseProxyBlocked, reverseProxyUpstreamDraft } from './account-reverse-proxy-client.ts'
import { readDomainWorkspace } from './domain-workspace-client.ts'
import { renderAccountReverseProxyWorkspace } from './board-port/account-reverse-proxy-workspace.ts'

const accountId = '11111111-1111-4111-8111-111111111111', home = '/home/alice'
const PRIMARY = '22222222-2222-4222-8222-222222222222', ADDON = '33333333-3333-4333-8333-333333333333', ALIAS = '44444444-4444-4444-8444-444444444444', APP = '55555555-5555-4555-8555-555555555555'
const php = { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: { memory_limit: '64M' } }
const domain = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, accountId, name, kind: 'addon', parentId: null, docRoot: home + '/domains/' + name + '/public_html', siteType: 'php', upstream: null, redirect: null, php,
  wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited', ...extra })
const primary = domain(PRIMARY, 'alice.example.test', { kind: 'primary', docRoot: home + '/public_html' })
const view = (domains: Record<string, unknown>[] = [primary], revision = 'a', application = 'unverified') => ({ context: { accountId, home }, revision: revision.repeat(64), domains,
  limits: { addonDomains: 3, aliasDomains: 3, subdomains: 3 }, removals: domains.map(row => ({ domainId: row.id, canRemove: false, childCount: domains.filter(child => child.parentId === row.id).length, serviceUserCount: 0 })),
  application: { status: application, targetVerified: false } })
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
afterEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; document.body.replaceChildren(); vi.restoreAllMocks() })
async function bind(html: string, request?: (method: string, path: string, body?: unknown) => Promise<unknown>, confirm: unknown = async () => true) {
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  document.body.innerHTML = html
  ;(new Function('return ' + ACCOUNT_REVERSE_PROXY_CLIENT_BINDING)() as (confirm: unknown) => void)(confirm)
  await settle()
}
const $ = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!
const page = (canManage = true) => renderAccountReverseProxyWorkspace({ lang: 'en', accountId, home, canManage })
const configure = (index = 0) => { document.querySelectorAll<HTMLButtonElement>('[data-rp-rows] button')[index]!.click() }
const choose = (mode: string, upstream?: string) => {
  $<HTMLSelectElement>('[data-rp-mode]').value = mode; $('[data-rp-mode]').dispatchEvent(new Event('change'))
  if (upstream !== undefined) $<HTMLInputElement>('[data-rp-upstream]').value = upstream
}

describe('account reverse proxy page', () => {
  it('renders bilingual markup with isolated technical values, the proxy warning, ASCII digits and no form', () => {
    for (const lang of ['en', 'ar'] as const) {
      const html = renderAccountReverseProxyWorkspace({ lang, accountId, home, canManage: true })
      expect(html).toContain(`dir="${lang === 'ar' ? 'rtl' : 'ltr'}"`); expect(html).not.toMatch(/[٠-٩۰-۹]/); expect(html).not.toContain('<form')
      for (const part of ['data-rp-rows', 'data-rp-mode', 'data-rp-upstream', 'data-rp-save', 'data-rp-refresh', 'data-rp-status', 'data-rp-application', 'data-rp-warning',
        '<bdi dir="ltr">http://127.0.0.1:3000</bdi>', '<bdi dir="ltr">::1</bdi>', 'id="rp-upstream" class="xp-input xp-mono" dir="ltr"']) expect(html, part).toContain(part)
    }
    expect(page()).toContain('document root and PHP settings are kept but not used')
    expect(renderAccountReverseProxyWorkspace({ lang: 'ar', accountId, home, canManage: true })).toContain('تبقى إعدادات جذر المستندات وPHP محفوظة لكنها لا تُستخدم')
    expect(renderAccountReverseProxyWorkspace({ lang: 'en', accountId: '<x>', home: '"/h', canManage: false })).not.toContain('<x>')
    expect(ACCOUNT_REVERSE_PROXY_CLIENT_BINDING).not.toContain('innerHTML')
  })

  it('keeps read-only and design-placeholder pages inert: every control disabled and nothing requested', async () => {
    const request = vi.fn(async () => clone(view()))
    await bind(page(false), request)
    expect(request).not.toHaveBeenCalled(); expect([...document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select')].every(control => control.disabled)).toBe(true)
    expect($('[data-rp-status]').getAttribute('data-state')).toBe('unavailable')
    document.body.replaceChildren()
    await bind(`<section data-wiring="soon">${page()}</section>`, request)
    expect(request).not.toHaveBeenCalled(); expect($('[data-rp-status]').getAttribute('data-state')).toBe('unavailable')
  })

  it('pre-checks upstream drafts and blocks aliases, alias parents, application sites and redirects', () => {
    for (const ok of ['http://127.0.0.1:3000', 'https://[::1]:3443/app/v1']) expect(reverseProxyUpstreamDraft(ok), ok).toBe(ok)
    for (const bad of [null, 3000, 'http://127.0.0.1:80', 'http://127.0.0.1:70000', 'http://10.0.0.5:3000', 'http://localhost:3000', 'http://user@127.0.0.1:3000', 'http://127.0.0.1:3000/?a', 'http://127.0.0.1:3000/a/../b', ' http://127.0.0.1:3000'])
      expect(reverseProxyUpstreamDraft(bad), String(bad)).toBeNull()
    const addon = domain(ADDON, 'shop.example.test'), alias = domain(ALIAS, 'mirror.example.test', { kind: 'alias', parentId: ADDON, docRoot: addon.docRoot })
    const rows = readDomainWorkspace(view([primary, addon, alias, domain(APP, 'node.example.test', { siteType: 'node', upstream: 'http://127.0.0.1:3001' }), domain('66666666-6666-4666-8666-666666666666', 'moved.example.test', { redirect: { to: 'https://example.org/', code: 301 } })]), { accountId, home }).domains
    expect(rows.map(row => reverseProxyBlocked(row, rows))).toEqual([null, 'aliases', 'alias', 'app', 'redirect'])
  })

  it('accepts only an acknowledgement that changes exactly the selected row and reports application truthfully', () => {
    const before = readDomainWorkspace(view([primary, domain(ADDON, 'shop.example.test')]), { accountId, home })
    const proxied = { ...primary, siteType: 'proxy', upstream: 'http://127.0.0.1:3000' }
    const ack = (rows: Record<string, unknown>[], application = 'not_requested', reconcile: unknown = null, domainRow: unknown = proxied) => {
      const raw = { ...view(rows, 'b', application), domain: domainRow, stateChanged: true, reconcile }
      return reverseProxyAcknowledged(raw, readDomainWorkspace(raw, { accountId, home }), before, PRIMARY, 'proxy', 'http://127.0.0.1:3000')
    }
    const addon = domain(ADDON, 'shop.example.test')
    expect(ack([proxied, addon])).toBeNull()
    expect(ack([proxied, addon], 'global_configuration_applied', { status: 'applied', generation: { id: 7, status: 'active', checksum: 'c'.repeat(64) }, filesCount: 2, durationMs: 1 })).toBe(7)
    expect(ack([proxied, addon], 'global_configuration_applied', null)).toBe(false)
    expect(ack([proxied, addon], 'not_requested', { status: 'applied' })).toBe(false)
    expect(ack([{ ...proxied, docRoot: home + '/other' }, addon], 'not_requested', null, { ...proxied, docRoot: home + '/other' })).toBe(false)
    expect(ack([proxied, { ...addon, siteType: 'static' }])).toBe(false)
    expect(ack([primary, addon], 'not_requested', null, primary)).toBe(false)
    expect(ack([proxied])).toBe(false)
  })

  it('switches to a proxy with the captured revision, reads back, then switches back to PHP and reports application', async () => {
    let current = view([primary], 'a')
    const request = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === 'GET') { expect(path).toBe('/api/domains'); return clone(current) }
      expect(method).toBe('PUT'); expect(path).toBe('/api/domains/' + PRIMARY + '/reverse-proxy')
      const target = body as Record<string, unknown>
      if (target.siteType === 'proxy') {
        expect(body).toEqual({ expectedRevision: 'a'.repeat(64), siteType: 'proxy', upstream: 'http://127.0.0.1:3000' })
        const row = { ...primary, siteType: 'proxy', upstream: 'http://127.0.0.1:3000' }; current = view([row], 'b')
        return { ...view([row], 'b', 'not_requested'), domain: row, stateChanged: true, reconcile: null }
      }
      expect(body).toEqual({ expectedRevision: 'b'.repeat(64), siteType: 'php' }); current = view([primary], 'c')
      return { ...view([primary], 'c', 'global_configuration_applied'), domain: primary, stateChanged: true, reconcile: { status: 'applied', generation: { id: 7, status: 'active', checksum: 'c'.repeat(64) }, filesCount: 2, durationMs: 1 } }
    })
    await bind(page(), request)
    expect($('[data-rp-status]').getAttribute('data-state')).toBe('read'); expect($('[data-rp-rows]').textContent).toContain('alice.example.test')
    expect($<HTMLButtonElement>('[data-rp-save]').disabled).toBe(true)
    configure(); expect($('[data-rp-selected]').textContent).toBe('alice.example.test'); expect($('[data-rp-root]').textContent).toBe(home + '/public_html')
    expect($<HTMLElement>('[data-rp-upstream-field]').hidden).toBe(true)
    choose('proxy', ' http://127.0.0.1:3000 '); expect($<HTMLInputElement>('[data-rp-upstream]').disabled).toBe(false)
    $<HTMLButtonElement>('[data-rp-save]').click(); await settle()
    expect(request.mock.calls.map(call => call[0])).toEqual(['GET', 'GET', 'PUT', 'GET']); expect($('[data-rp-status]').getAttribute('data-state')).toBe('saved')
    expect($('[data-rp-application]').textContent).toContain('was not applied by this request'); expect($('[data-rp-rows]').textContent).toContain('http://127.0.0.1:3000')
    expect($('[data-rp-current]').textContent).toBe('Reverse proxy · http://127.0.0.1:3000')
    choose('php'); expect($<HTMLElement>('[data-rp-upstream-field]').hidden).toBe(true)
    $<HTMLButtonElement>('[data-rp-save]').click(); await settle()
    expect(request.mock.calls.map(call => call[0])).toEqual(['GET', 'GET', 'PUT', 'GET', 'GET', 'PUT', 'GET']); expect($('[data-rp-status]').getAttribute('data-state')).toBe('saved')
    expect($('[data-rp-application]').textContent).toContain('generation 7'); expect($('[data-rp-current]').textContent).toBe('PHP files')
  })

  it('stops on a stale revision before sending, shows field refusals, and locks on uncertain or mismatched outcomes', async () => {
    let reads = 0
    const stale = vi.fn(async (method: string) => { if (method === 'GET') return clone(view([primary], reads++ === 0 ? 'a' : 'd')); throw new Error('unexpected') })
    await bind(page(), stale)
    configure(); choose('proxy', 'http://127.0.0.1:3000'); $<HTMLButtonElement>('[data-rp-save]').click(); await settle()
    expect(stale.mock.calls.map(call => call[0])).toEqual(['GET', 'GET']); expect($('[data-rp-status]').getAttribute('data-state')).toBe('stale')
    expect($<HTMLButtonElement>('[data-rp-save]').disabled).toBe(true); expect($<HTMLButtonElement>('[data-rp-refresh]').disabled).toBe(false)
    $<HTMLButtonElement>('[data-rp-refresh]').click(); await settle(); expect($<HTMLButtonElement>('[data-rp-save]').disabled).toBe(false)

    document.body.replaceChildren()
    const refused = vi.fn(async (method: string) => { if (method === 'PUT') throw Object.assign(new Error('refused'), { status: 422, details: { stateChanged: false, fields: [{ field: 'upstream', code: 'reserved_port' }] } }); return clone(view()) })
    await bind(page(), refused)
    configure(); choose('proxy', 'http://127.0.0.1:3306'); $<HTMLButtonElement>('[data-rp-save]').click(); await settle()
    expect($('[data-rp-status]').getAttribute('data-state')).toBe('fields'); expect($<HTMLElement>('[data-rp-error]').hidden).toBe(false); expect($('[data-rp-upstream]').getAttribute('aria-invalid')).toBe('true')
    expect($<HTMLButtonElement>('[data-rp-save]').disabled).toBe(false)
    choose('proxy', 'http://10.0.0.5:3000'); $<HTMLButtonElement>('[data-rp-save]').click(); await settle()
    expect(refused.mock.calls.map(call => call[0])).toEqual(['GET', 'GET', 'PUT'])

    for (const reply of [async () => { throw Object.assign(new Error('unverified'), { status: 503, details: { stateChanged: true, verificationRequired: true, unknownOutcome: true } }) },
      async () => ({ ...view([primary], 'b', 'not_requested'), domain: primary, stateChanged: true, reconcile: null })]) {
      document.body.replaceChildren()
      const uncertain = vi.fn(async (method: string) => method === 'PUT' ? reply() : clone(view()))
      await bind(page(), uncertain)
      configure(); choose('proxy', 'http://127.0.0.1:3000'); $<HTMLButtonElement>('[data-rp-save]').click(); await settle()
      expect($('[data-rp-status]').getAttribute('data-state')).toBe('uncertain'); expect($<HTMLButtonElement>('[data-rp-save]').disabled).toBe(true)
      expect(uncertain.mock.calls.map(call => call[0])).toEqual(['GET', 'GET', 'PUT'])
    }
  })

  it('disables blocked rows and sends nothing when the confirmation is declined', async () => {
    const addon = domain(ADDON, 'shop.example.test'), alias = domain(ALIAS, 'mirror.example.test', { kind: 'alias', parentId: ADDON, docRoot: addon.docRoot })
    const declined = vi.fn(async () => clone(view([primary, addon, alias])))
    await bind(page(), declined, async () => false)
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-rp-rows] button')]
    expect(buttons.map(button => button.disabled)).toEqual([false, true, true]); expect($('[data-rp-rows]').textContent).toContain('Has aliases')
    configure(); choose('static'); $<HTMLButtonElement>('[data-rp-save]').click(); await settle()
    expect(declined).toHaveBeenCalledTimes(1); expect($('[data-rp-status]').getAttribute('data-state')).toBe('read')
  })
})
