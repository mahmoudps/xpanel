/// <reference lib="dom" />
// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://panel.example.test/home?lang=en"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tools, type CatalogTool, type VisibilityContext } from '@xpanel/catalog'
import { commandPaletteEntries, renderCommandPaletteModal } from './command-palette.ts'
import { COMMAND_PALETTE_CLIENT_FUNCTIONS } from './command-palette-client.ts'

const catalog: CatalogTool[] = tools.map(tool => tool.status === 'out-of-scope' ? tool : ({ ...tool, status: 'verified', delivery: { ...tool.delivery, status: 'verified' } }))
const root: VisibilityContext = { principal: { kind: 'root', id: 'operator', username: 'operator' }, disabledFeatures: new Set() }
const accounts = [
  { id: 'private-account-id', ownerId: 'reseller-one', username: 'alpha', primaryDomain: 'alpha.example.test' },
  { id: 'foreign-account-id', ownerId: 'reseller-two', username: 'foreign', primaryDomain: 'foreign.example.test' },
]
const domains = [
  { id: 'private-domain-id', accountId: accounts[0]!.id, name: 'alpha.example.test' },
  { id: 'foreign-domain-id', accountId: accounts[1]!.id, name: 'foreign.example.test' },
]

beforeEach(() => { window.localStorage.clear(); document.body.innerHTML = '' })
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = '' })

describe('authorized quick bar model', () => {
  it('does not manufacture records without a supplied read model, visibility or qualified destination', () => {
    expect(commandPaletteEntries('xwhm', 'en', root, catalog).some(item => ['account', 'domain'].includes(item.kind))).toBe(false)
    expect(commandPaletteEntries('login', 'en', root, catalog, { accounts, domains })).toEqual([])
    expect(commandPaletteEntries('xwhm', 'en', undefined, catalog, { accounts, domains })).toEqual([])
    expect(commandPaletteEntries('xwhm', 'en', root, tools, { accounts, domains }).some(item => ['account', 'domain'].includes(item.kind))).toBe(false)
  })

  it('restricts reseller record results to its accounts and requires both its ACL and qualified account destination', () => {
    const reseller: VisibilityContext = { principal: { kind: 'reseller', id: 'reseller-one', username: 'reseller' }, reseller: { acl: ['list-accounts', 'edit-account', 'change-password', 'suspend-account', 'terminate-account', 'manage-dns'] } }
    const entries = commandPaletteEntries('xwhm', 'en', reseller, catalog, { accounts, domains })
    expect(entries.filter(item => item.kind === 'account').map(item => item.label)).toEqual(['alpha'])
    expect(entries.some(item => item.label === 'foreign' || item.label === 'foreign.example.test')).toBe(false)
    const listOnly = commandPaletteEntries('xwhm', 'en', { ...reseller, reseller: { acl: ['list-accounts'] } }, catalog, { accounts, domains })
    expect(listOnly.some(item => item.kind === 'account')).toBe(false)
    const denied = commandPaletteEntries('xwhm', 'en', { ...reseller, reseller: { acl: [] } }, catalog, { accounts, domains })
    expect(denied.some(item => item.kind === 'account' || item.kind === 'domain')).toBe(false)
  })

  it('shows an owner only its own records without serializing internal identity values', () => {
    const owner: VisibilityContext = { principal: { kind: 'user', id: 'principal-private-id', accountId: 'private-account-id', username: 'alpha' }, disabledFeatures: new Set() }
    const html = renderCommandPaletteModal('xpanel', 'en', owner, catalog, { accounts, domains })
    expect(html).toContain('alpha.example.test')
    expect(html).toContain('>alpha</strong>')
    expect(html).not.toContain('private-account-id')
    expect(html).not.toContain('private-domain-id')
    expect(html).not.toContain('principal-private-id')
    expect(html).not.toContain('foreign.example.test')
    expect(html).not.toContain('foreign-account-id')
  })

  it('does not expose account or domain search on mailbox surfaces', () => {
    const owner: VisibilityContext = { principal: { kind: 'user', id: 'user', accountId: accounts[0]!.id, username: 'alpha' }, disabledFeatures: new Set() }
    const entries = commandPaletteEntries('xmail', 'en', owner, catalog, { accounts, domains })
    expect(entries.some(item => item.kind === 'account' || item.kind === 'domain')).toBe(false)
  })

  it('classifies navigation to available forms as actions without executing mutations', () => {
    const entries = commandPaletteEntries('xwhm', 'en', root, catalog)
    expect(entries.find(item => item.route === '/whm/accounts/new')?.kind).toBe('action')
    expect(entries.every(item => item.href.startsWith('/'))).toBe(true)
    const html = renderCommandPaletteModal('xwhm', 'ar', root, catalog, { accounts, domains })
    expect(html).toContain('data-cmdk-scope="all"')
    expect(html).toContain('data-cmdk-scope="action"')
    expect(html).toContain('data-cmdk-scope="account"')
    expect(html).toContain('data-cmdk-scope="domain"')
    expect(html).not.toContain('<form')
    expect(html).not.toMatch(/onclick=|[\u0660-\u0669\u06f0-\u06f9]/)
  })

  it('escapes record labels and keeps technical IDs out of displayed references', () => {
    const html = renderCommandPaletteModal('xwhm', 'en', root, catalog, { accounts: [{ ...accounts[0]!, username: '<img onerror=attack>' }] })
    expect(html).toContain('&lt;img onerror=attack&gt;')
    expect(html).not.toContain('<img onerror=attack>')
    expect(html).not.toContain('account:private-account-id')
  })
})

interface CommandHarness {
  palette(): { matches: Array<{ kind: string; link: HTMLAnchorElement }>; history: { favorites: string[]; recent: string[] } }
  filter(): void
  key(event: KeyboardEvent): boolean
}
function boot() {
  document.body.innerHTML = renderCommandPaletteModal('xwhm', 'en', root, catalog, { accounts, domains })
  const modal = document.querySelector<HTMLElement>('[data-xp-cmdk]')!
  modal.hidden = false
  const closed = vi.fn()
  const harness = new Function('window', 'document', 'closeActiveOverlay', `var commandPalette=null;var activeOverlay={element:document.querySelector('[data-xp-cmdk]')};${COMMAND_PALETTE_CLIENT_FUNCTIONS};bindCommandPalette();return {palette:()=>commandPalette,filter:filterCommandPalette,key:handleCommandPaletteKey};`)(window, document, closed) as CommandHarness
  modal.addEventListener('click', event => { if ((event.target as Element).closest('a')) event.preventDefault() })
  return { ...harness, modal, closed, input: modal.querySelector<HTMLInputElement>('[data-cmdk-search]')! }
}
function search(harness: ReturnType<typeof boot>, query: string) { harness.input.value = query; harness.input.dispatchEvent(new Event('input', { bubbles: true })) }

describe('quick bar client without an independent overlay lifecycle', () => {
  it('filters explicit and prefixed scopes and normalizes Arabic search text', () => {
    const h = boot()
    search(h, '@alpha')
    expect(h.palette().matches.map((item: { kind: string }) => item.kind)).toEqual(['account'])
    search(h, '#alpha.example.test')
    expect(h.palette().matches.map((item: { kind: string }) => item.kind)).toEqual(['domain'])
    search(h, '>create new')
    expect(h.palette().matches.map(item => item.link.getAttribute('data-cmdk-item'))).toContain('/whm/accounts/new')
    search(h, '#alpha.example.test')
    h.modal.querySelector<HTMLButtonElement>('[data-cmdk-scope="action"]')!.click()
    expect(h.input.value).toBe('alpha.example.test')
    search(h, '')
    expect(h.palette().matches.length).toBeGreaterThan(0)
    expect(h.palette().matches.every((item: { kind: string }) => item.kind === 'action')).toBe(true)
    const normalize = new Function(`${COMMAND_PALETTE_CLIENT_FUNCTIONS};return normalizeCommandSearch;`)()
    expect(normalize('إعدادات النِّطاقات')).toBe(normalize('اعدادات النطاقات'))
  })

  it('persists only allowed static page paths, never record identity, names or query strings', () => {
    const h = boot()
    h.modal.querySelector<HTMLButtonElement>('[data-cmdk-favorite="/whm/accounts"]')!.click()
    expect(h.modal.querySelector('[data-cmdk-favorites-section]')!.hasAttribute('hidden')).toBe(false)
    h.modal.querySelector<HTMLAnchorElement>('a[data-cmdk-kind="account"]')!.click()
    const stored = window.localStorage.getItem('xpanel.command-pages.v1.xwhm')!
    expect(JSON.parse(stored).favorites).toEqual(['/whm/accounts'])
    expect(stored).not.toMatch(/private-account-id|private-domain-id|alpha|example\.test|accountId|\?/)
    h.modal.querySelector<HTMLAnchorElement>('a[data-cmdk-kind="page"]')!.click()
    expect(JSON.parse(window.localStorage.getItem('xpanel.command-pages.v1.xwhm')!).recent).toHaveLength(1)
    expect(h.closed).toHaveBeenCalled()
  })

  it('drops stale and unapproved stored pages and treats unavailable browser storage as optional', () => {
    window.localStorage.setItem('xpanel.command-pages.v1.xwhm', JSON.stringify({ favorites: ['/whm/accounts', '/mail/inbox', '/whm/accounts?accountId=private'], recent: ['https://foreign.example', '/whm/accounts'] }))
    const h = boot()
    expect(h.palette().history).toEqual({ favorites: ['/whm/accounts'], recent: ['/whm/accounts'] })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage unavailable') })
    expect(() => boot()).not.toThrow()
  })

  it('keeps arrow wrapping, active-descendant selection and Ctrl Enter navigation', () => {
    const h = boot()
    search(h, '@alpha')
    h.input.focus()
    const down = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    Object.defineProperty(down, 'target', { value: h.input })
    expect(h.key(down)).toBe(true)
    expect(h.input.getAttribute('aria-activedescendant')).toBe(h.palette().matches[0]!.link.id)
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const enter = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, cancelable: true })
    Object.defineProperty(enter, 'target', { value: h.input })
    expect(h.key(enter)).toBe(true)
    expect(open).toHaveBeenCalledWith(expect.stringContaining('/whm/accounts?accountId='), '_blank', 'noopener')
    expect(window.localStorage.getItem('xpanel.command-pages.v1.xwhm')).toBeNull()
  })
})
