// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Account } from '@xpanel/core'
import { translator } from './i18n.ts'
import { renderSecWorkspace } from './board-port/sec-workspace.ts'
import { renderV2AccountWafPage } from './themes/v2/pages/xpanel/security/tools.ts'
import { renderV2CloudflarePage } from './themes/v2/pages/xpanel/domains/cloudflare.ts'
import { renderV2WhmDnsClusterPage, renderV2WhmDnsProvidersPage } from './themes/v2/pages/xwhm/dns/providers.ts'
import { renderV2WhmSecurityPolicy } from './themes/v2/pages/xwhm/security/policies.ts'
import { SEC_SECURITY_CLIENT_BINDING } from './sec-security-client.ts'
import { SEC_DNS_CLIENT_BINDING } from './sec-dns-client.ts'

type PaintPage = 'account-waf' | 'account-cloudflare' | 'dns-providers' | 'dns-cluster'
type Theme = 'classic' | 'v2'
type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const pages: readonly PaintPage[] = ['account-waf', 'account-cloudflare', 'dns-providers', 'dns-cluster']
const routes: Record<PaintPage, string> = { 'account-waf': '/api/account/sec/waf', 'account-cloudflare': '/api/account/sec/cloudflare', 'dns-providers': '/api/server/sec/dns-providers', 'dns-cluster': '/api/server/sec/dns-cluster' }
const R = 'a'.repeat(64), providerId = '10000000-0000-4000-8000-000000000004', domain = 'alice.example.test'
const account: Account = { id: '10000000-0000-4000-8000-000000000001', username: 'alice', uid: 20001, gid: 20001,
  home: '/home/alice', primaryDomain: domain, planId: '10000000-0000-4000-8000-000000000002', ownerId: null,
  status: 'active', suspendReason: null, contactEmail: 'owner@example.test', ipv4: '192.0.2.10', shell: 'jailed', createdAt: '2026-10-30T00:00:00.000Z' }
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function response(page: PaintPage): unknown {
  if (page === 'account-waf') return { server: null, live: null, revision: R, domains: [{ domain, modsecurity: true }], reconcile: null }
  if (page === 'account-cloudflare') return { domains: [{ domain, linked: true }] }
  if (page === 'dns-providers') return { revision: R,
    accounts: [{ id: providerId, provider: 'cloudflare', label: 'Main', tokenId: 'b'.repeat(32), createdAt: '2026-10-30T00:00:00.000Z', verifiedAt: '2026-10-30T00:00:00.000Z' }],
    links: [{ domain, accountId: providerId, zoneId: 'c'.repeat(32), zoneName: domain, linkedAt: '2026-10-30T00:00:00.000Z' }], domains: [domain] }
  return { state: 'saved', policy: { peers: [{ name: 'ns2.example.test', address: '192.0.2.53' }] }, updatedAt: '2026-10-30T00:00:00.000Z', revision: R, observation: null, reason: null }
}
function html(theme: Theme, page: PaintPage, canManage = true, locale: 'en' | 'ar' = 'en'): string {
  if (theme === 'classic') return renderSecWorkspace({ page, locale, canRead: true, canManage })
  const authority = { canRead: true, canManage }
  if (page === 'account-waf') return renderV2AccountWafPage({ locale, account, activeRoute: '/security/waf' }, authority)
  if (page === 'account-cloudflare') return renderV2CloudflarePage({ locale, account, activeRoute: '/domains/cloudflare' }, authority)
  return page === 'dns-providers' ? renderV2WhmDnsProvidersPage({ locale }, authority) : renderV2WhmDnsClusterPage({ locale }, authority)
}
function template(root: HTMLElement, name: string): HTMLTemplateElement {
  const result = root.querySelector<HTMLTemplateElement>(`template[data-xp-template="${name}"]`)
  if (!result) throw new Error('Expected actual theme prototype: ' + name)
  return result
}
function changeTag(previous: Element, tag: string): void {
  const next = document.createElement(tag)
  for (const attr of previous.attributes) next.setAttribute(attr.name, attr.value)
  next.append(...Array.from(previous.childNodes)); previous.replaceWith(next)
}
function boot(page: PaintPage, send: Send, ask: (options: Record<string, unknown>) => Promise<unknown> = async () => true): void {
  vi.stubGlobal('xpanelSessionRequest', send)
  new Function('return ' + (page === 'account-waf' ? SEC_SECURITY_CLIENT_BINDING : SEC_DNS_CLIENT_BINDING))()(ask)
}
function mount(theme: Theme, page: PaintPage, options: { canManage?: boolean; locale?: 'en' | 'ar'; mutate?: (root: HTMLElement) => void; send?: Send; ask?: (options: Record<string, unknown>) => Promise<unknown> } = {}) {
  const locale = options.locale ?? 'en'
  document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  vi.stubGlobal('xpT', translator(locale))
  document.body.innerHTML = html(theme, page, options.canManage, locale)
  const root = document.querySelector<HTMLElement>('[data-sec-workspace]')!
  options.mutate?.(root)
  const send = vi.fn<Send>(options.send ?? (async () => response(page)))
  const ask = vi.fn(options.ask ?? (async () => true))
  boot(page, send, ask)
  return { root, send, ask }
}
function groupClass(theme: Theme, page: PaintPage): string {
  return theme === 'classic' ? 'xp-sec__actions' : page === 'account-waf' ? 'v2-panel-settings__actions' : page === 'account-cloudflare' ? 'v2-domain-actions' : 'v2-whm-network__actions'
}
function expectUnavailable(root: HTMLElement): void {
  expect(root.querySelector<HTMLElement>('[data-sec-status]')!.dataset.state).toBe('unavailable')
  expect([...root.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select,textarea')].every(control => control.disabled)).toBe(true)
}
const malformed: readonly [string, (root: HTMLElement) => void][] = [
  ['missing action template', root => template(root, 'sec-action').remove()],
  ['duplicate action template', root => root.append(template(root, 'sec-action').cloneNode(true))],
  ['wrong action root', root => changeTag(template(root, 'sec-action').content.firstElementChild!, 'div')],
  ['extra action root', root => template(root, 'sec-action').content.append(document.createElement('button'))],
  ['missing label', root => template(root, 'sec-action').content.querySelector('[data-xp-slot="label"]')!.remove()],
  ['duplicate label', root => { const label = template(root, 'sec-action').content.querySelector('[data-xp-slot="label"]')!; label.after(label.cloneNode(true)) }],
  ['wrong label tag', root => changeTag(template(root, 'sec-action').content.querySelector('[data-xp-slot="label"]')!, 'bdi')],
  ['missing button type', root => template(root, 'sec-action').content.firstElementChild!.removeAttribute('type')],
  ['submit button type', root => template(root, 'sec-action').content.firstElementChild!.setAttribute('type', 'submit')],
  ['missing group template', root => template(root, 'sec-action-group').remove()],
  ['duplicate group template', root => root.append(template(root, 'sec-action-group').cloneNode(true))],
  ['wrong group root', root => changeTag(template(root, 'sec-action-group').content.firstElementChild!, 'section')],
  ['missing group slot', root => template(root, 'sec-action-group').content.firstElementChild!.removeAttribute('data-xp-slot')],
  ['wrong group slot tag', root => { const group = template(root, 'sec-action-group').content.firstElementChild!; group.removeAttribute('data-xp-slot'); const slot = document.createElement('span'); slot.dataset.xpSlot = 'items'; group.append(slot) }],
  ['duplicate group slot', root => { const slot = document.createElement('div'); slot.dataset.xpSlot = 'items'; template(root, 'sec-action-group').content.firstElementChild!.append(slot) }],
]
afterEach(() => { document.body.replaceChildren(); document.documentElement.lang = ''; document.documentElement.dir = ''; vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe.each(['classic', 'v2'] as const)('%s real SSR security action prototypes', theme => {
  for (const page of pages) describe(page, () => {
    it.each(['en', 'ar'] as const)('paints authorized %s actions through the actual serialized binding without changing the source prototypes', async locale => {
      let before = ''
      const { root, send } = mount(theme, page, { locale, mutate: root => { before = [...root.querySelectorAll('template')].map(node => node.innerHTML).join('\n') } })
      await tick()
      expect(send).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledWith('GET', routes[page], undefined)
      expect(root.querySelector<HTMLElement>('[data-sec-status]')!.dataset.state).toBe('read')
      const actions = [...root.querySelectorAll<HTMLButtonElement>('[data-sec-rows] button')]
      expect(actions.length).toBeGreaterThan(0)
      for (const action of actions) {
        expect(action.type).toBe('button'); expect(action.getAttribute('aria-label')).toBeTruthy()
        expect(action.classList.contains(theme === 'classic' ? 'xp-btn' : 'v2-btn')).toBe(true)
        expect(action.querySelector('[data-xp-slot="label"]')!.textContent).toBeTruthy()
        expect(action.closest('[data-xp-slot="items"]')!.classList.contains(groupClass(theme, page))).toBe(true)
      }
      expect([...root.querySelectorAll('template')].map(node => node.innerHTML).join('\n')).toBe(before)
      expect(root.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
    })
    it('retains existing read-only action permissions', async () => {
      const { root, send } = mount(theme, page, { canManage: false }); await tick()
      const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-sec-rows] button')]
      expect(buttons.length).toBeGreaterThan(0)
      if (page === 'account-waf') expect(buttons.every(button => button.disabled)).toBe(true)
      else if (page === 'account-cloudflare' || page === 'dns-cluster') expect(buttons.map(button => button.disabled)).toEqual([false, true])
      else expect(buttons.map(button => button.disabled)).toEqual([true, false, true, true])
      expect(send.mock.calls.every(([method]) => method === 'GET')).toBe(true)
    })
    it.each(malformed)('rejects %s before GET, confirmation or effects', async (_name, mutate) => {
      const { root, send, ask } = mount(theme, page, { mutate }); await tick()
      root.querySelector<HTMLButtonElement>('[data-sec-action="refresh"]')!.dispatchEvent(new Event('click', { bubbles: true }))
      await tick()
      expect(send).not.toHaveBeenCalled(); expect(ask).not.toHaveBeenCalled(); expectUnavailable(root)
    })
    it('refuses painting when the local prototype changes while the read is pending', async () => {
      const pending = deferred<unknown>()
      const { root, send } = mount(theme, page, { send: async () => pending.promise })
      expect(send).toHaveBeenCalledTimes(1)
      template(root, 'sec-action-group').remove(); pending.resolve(response(page)); await tick()
      expectUnavailable(root); expect(root.querySelector('[data-sec-rows] button')).toBeNull()
      expect(send).toHaveBeenCalledTimes(1)
    })
  })
  it.each(['account-waf', 'account-cloudflare'] as const)('rechecks %s prototypes after confirmation and before the write', async page => {
    const confirmed = deferred<unknown>()
    const { root, send, ask } = mount(theme, page, { ask: async () => confirmed.promise }); await tick()
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-sec-rows="domains"] button')]
    buttons[page === 'account-waf' ? 0 : 1]!.click(); await tick()
    expect(ask).toHaveBeenCalledOnce()
    template(root, 'sec-action').content.firstElementChild!.setAttribute('type', 'submit')
    confirmed.resolve(true); await tick()
    expect(send.mock.calls.every(([method]) => method === 'GET')).toBe(true)
    expectUnavailable(root)
  })
  it('retains an unknown outcome when a prototype fails after an acknowledged write and before readback', async () => {
    let currentRoot: HTMLElement | undefined, saved = false
    const { root, send } = mount(theme, 'account-waf', { send: async method => {
      if (method === 'PUT') {
        if (!currentRoot) throw new Error('the admitted fixture root must exist before a write')
        saved = true; template(currentRoot, 'sec-action-group').remove()
        return { server: null, live: null, revision: 'b'.repeat(64), domains: [{ domain, modsecurity: false }], reconcile: null }
      }
      return response('account-waf')
    } })
    currentRoot = root; await tick()
    root.querySelector<HTMLButtonElement>('[data-sec-rows="domains"] button')!.click(); await tick()
    expect(saved).toBe(true); expect(send.mock.calls.map(([method]) => method)).toEqual(['GET', 'PUT'])
    expectUnavailable(root)
    expect(root.querySelector<HTMLElement>('[data-sec-result]')!.dataset.outcome).toBe('unknown')
    expect(root.querySelector('[data-sec-result]')!.textContent).not.toContain('Nothing was changed')
  })
  it('quarantines only the malformed workspace and never borrows a sibling prototype', async () => {
    vi.stubGlobal('xpT', translator('en'))
    document.body.innerHTML = html(theme, 'account-waf') + html(theme, 'account-waf')
    const [bad, good] = [...document.querySelectorAll<HTMLElement>('[data-sec-workspace]')]
    template(bad!, 'sec-action').remove()
    const send = vi.fn<Send>(async () => response('account-waf'))
    boot('account-waf', send); await tick()
    expectUnavailable(bad!); expect(good!.querySelector<HTMLElement>('[data-sec-status]')!.dataset.state).toBe('read')
    expect(good!.querySelector('[data-sec-rows] button')).not.toBeNull(); expect(send).toHaveBeenCalledTimes(1)
  })
})

describe.each(['classic', 'v2'] as const)('%s secKit consumers without dynamic actions', theme => {
  it.each(['waf', 'flood', 'panel-access'] as const)('keeps %s readable without unused prototypes', async page => {
    const policies = {
      waf: { requestsPerSecond: 20, burst: 40, maxBodyMb: 256, deniedResponse: 403, denyIps: [], denyPaths: [], denyUserAgents: [], modsecurity: true },
      flood: { enabled: true, connectionsPerAddress: 100, newConnectionsBurst: null, newConnectionsPerSecond: null, pingPerSecond: 10, webConnectionsPerAddress: null },
      'panel-access': { listeners: { xpanel: [], xwhm: [], xmail: [] } },
    }
    document.body.innerHTML = theme === 'classic' ? renderSecWorkspace({ page, locale: 'en', canRead: true, canManage: true })
      : renderV2WhmSecurityPolicy({ locale: 'en', observationAuthority: { canRead: true, canManage: true } }, page)
    expect(document.querySelector('template[data-xp-template]')).toBeNull()
    vi.stubGlobal('xpT', translator('en'))
    const send = vi.fn<Send>(async () => ({ state: 'default', policy: policies[page], updatedAt: null, revision: R }))
    vi.stubGlobal('xpanelSessionRequest', send)
    new Function('return ' + SEC_SECURITY_CLIENT_BINDING)()(async () => true); await tick()
    expect(send).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledWith('GET', '/api/server/sec/' + page, undefined)
    expect(document.querySelector<HTMLElement>('[data-sec-status]')!.dataset.state).not.toBe('unavailable')
  })
})
