// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderSecWorkspace } from './board-port/sec-workspace.ts'
import type { SecPage } from './board-port/sec-workspace.ts'
import { readSecProvidersView, readSecZoneView, SEC_DNS_CLIENT_BINDING } from './sec-dns-client.ts'

type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const tick = async () => { for (let index = 0; index < 10; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const R1 = 'a'.repeat(64), R2 = 'b'.repeat(64), ACCOUNT = '11111111-1111-4111-8111-111111111111', ZONE = 'd'.repeat(32)
const providers = (revision = R1, linked = false) => ({ revision, accounts: [{ id: ACCOUNT, provider: 'cloudflare', label: 'Main', tokenId: 'c'.repeat(32), createdAt: '2026-10-28T10:00:00.000Z', verifiedAt: '2026-10-28T10:00:00.000Z' }], links: linked ? [{ domain: 'alice.test', accountId: ACCOUNT, zoneId: ZONE, zoneName: 'alice.test', linkedAt: '2026-10-28T11:00:00.000Z' }] : [], domains: ['alice.test', 'bob.test'] })
const zone = { domain: 'alice.test', zoneId: ZONE, status: 'active', paused: false, nameServers: ['ada.ns.cloudflare.com'], sslMode: 'strict', localZone: true, truncated: false, observedAt: '2026-10-28T12:00:00.000Z', records: [{ name: 'alice.test', type: 'A', local: ['203.0.113.5'], cloudflare: ['104.16.1.1'], proxied: true, state: 'match' }] }
const boot = (page: SecPage, send?: Send, ask?: (options: Record<string, unknown>) => Promise<unknown>, locale: 'en' | 'ar' = 'en') => {
  delete (window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest
  document.body.innerHTML = renderSecWorkspace({ page, locale, canRead: true, canManage: true })
  if (send) (window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest = send
  new Function('return ' + SEC_DNS_CLIENT_BINDING)()(ask)
}
afterEach(() => { document.body.innerHTML = ''; document.documentElement.lang = ''; document.documentElement.dir = '' })

describe('sec DNS readers', () => {
  it('refuses provider views that carry a token or links to unknown accounts', () => {
    expect(readSecProvidersView(providers()).accounts).toHaveLength(1)
    expect(() => readSecProvidersView({ ...providers(), accounts: [{ ...providers().accounts[0], token: 'x' }] })).toThrow()
    expect(() => readSecProvidersView({ ...providers(true as never), links: [{ domain: 'alice.test', accountId: 'other', zoneId: ZONE, zoneName: 'alice.test', linkedAt: 'x' }] })).toThrow()
    expect(() => readSecZoneView(zone, 'bob.test')).toThrow()
    expect(() => readSecZoneView({ ...zone, sslMode: 'magic' }, 'alice.test')).toThrow()
  })
})

describe('sec DNS bindings', () => {
  it('connects a provider without keeping the token in the page and verifies the saved revision', async () => {
    let saved = false
    const send = vi.fn<Send>(async (method, path) => method === 'POST' ? (saved = true, providers(R2)) : path === '/api/server/sec/dns-providers' ? (saved ? providers(R2) : { ...providers(), accounts: [] }) : null)
    boot('dns-providers', send); await tick()
    expect($('[data-sec-rows="accounts"]').textContent).toContain('No provider accounts')
    $<HTMLInputElement>('[data-sec-input="label"]').value = 'Main'
    $<HTMLInputElement>('[data-sec-input="token"]').value = 'A'.repeat(40)
    $<HTMLButtonElement>('[data-sec-action="connect"]').click(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/sec/dns-providers/accounts', { label: 'Main', token: 'A'.repeat(40), expectedRevision: R1 })
    expect($<HTMLInputElement>('[data-sec-input="token"]').value).toBe('')
    expect($('[data-sec-result]').textContent).toContain('verified the token')
    expect(SEC_DNS_CLIENT_BINDING).not.toContain('innerHTML')
  })
  it('inspects a linked zone and purges only after confirmation', async () => {
    const send = vi.fn<Send>(async (method, path) => path.startsWith('/api/server/sec/dns-providers/zone') ? zone : method === 'POST' ? { domain: 'alice.test', outcome: 'accepted', observedAt: zone.observedAt } : providers(R1, true))
    const ask = vi.fn(async () => false)
    boot('dns-providers', send, ask); await tick()
    const [inspect, purge] = [...document.querySelectorAll<HTMLButtonElement>('[data-sec-rows="links"] button')]
    inspect!.click(); await tick()
    expect($('[data-sec-field="zone-ssl"]').textContent).toBe('strict')
    expect($('[data-sec-rows="records"]').textContent).toContain('Matches')
    purge!.click(); await tick()
    expect(send.mock.calls.some(([method]) => method === 'POST')).toBe(false)
    ask.mockResolvedValue(true); purge!.click(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/sec/dns-providers/purge', { domain: 'alice.test' })
    expect($('[data-sec-result]').textContent).toContain('accepted the purge')
  })
  it('shows the single-node state, saves a peer and applies only after confirmation', async () => {
    const cluster = (peers: unknown[], revision: string, application: string) => ({ state: peers.length ? 'saved' : 'default', policy: { peers }, updatedAt: peers.length ? '2026-10-28T11:00:00.000Z' : null, revision, reason: null,
      observation: { observedAt: zone.observedAt, state: 'read', application, settings: { launch: 'bind', primary: application === 'applied', disableAxfr: false, allowAxfrIps: ['127.0.0.0/8', '::1'], alsoNotify: [], includeDir: '/etc/powerdns/pdns.d' }, peers: [] } })
    const peer = { name: 'ns2.example.net', address: '198.51.100.53' }
    let step = 0
    const send = vi.fn<Send>(async (method, path) => {
      if (method === 'PUT') { step = 1; return cluster([peer], R2, 'drift') }
      if (path.endsWith('/apply')) { step = 2; return { outcome: 'applied', observation: cluster([peer], R2, 'applied').observation } }
      return step === 0 ? cluster([], R1, 'single_node') : cluster([peer], R2, step === 2 ? 'applied' : 'drift')
    })
    const ask = vi.fn(async () => true)
    boot('dns-cluster', send, ask); await tick()
    expect($('[data-sec-field="application"]').textContent).toContain('Single server')
    $<HTMLInputElement>('[data-sec-input="peer-name"]').value = 'NS2.example.net'
    $<HTMLInputElement>('[data-sec-input="peer-address"]').value = '198.51.100.53'
    $<HTMLButtonElement>('[data-sec-action="add-peer"]').click(); await tick()
    expect(send).toHaveBeenCalledWith('PUT', '/api/server/sec/dns-cluster', { policy: { peers: [peer] }, expectedRevision: R1 })
    expect($('[data-sec-field="application"]').textContent).toContain('Not applied')
    $<HTMLButtonElement>('[data-sec-action="apply"]').click(); await tick()
    expect(ask).toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/sec/dns-cluster/apply', { expectedRevision: R2 })
    expect($('[data-sec-field="application"]').textContent).toContain('Applied')
  })
  it('keeps unlinked owner domains without actions and renders RTL with ASCII digits', async () => {
    document.documentElement.lang = 'ar'; document.documentElement.dir = 'rtl'
    boot('account-cloudflare', async () => ({ domains: [{ domain: 'alice.test', linked: false, zoneId: null }] }), undefined, 'ar'); await tick()
    expect($('[data-sec-rows="domains"] button')).toBeNull()
    expect($('[data-sec-workspace]').getAttribute('dir')).toBe('rtl')
    expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
})
