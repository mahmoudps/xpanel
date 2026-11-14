// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmPhpReadback } from './board-port/whm-php-workspace.ts'
import { readPhpInventoryView, readPhpManageView, readPhpUsageView, WHM_PHP_CLIENT_BINDING } from './whm-php-client.ts'
import { tools } from '@xpanel/catalog'
import { renderWhmDetailPage } from './board-port/approved-xwhm.ts'
import { renderV2WhmPhp } from './themes/v2/pages/xwhm/host/php.ts'
import { PRESENTATION_TABS_CLIENT_BINDING } from './presentation-tabs-client.ts'
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const inventory = () => ({ state: 'read', source: 'dpkg', observedAt: '2026-10-26T12:00:00.000Z', versions: [{ version: '8.3', supported: true, packages: [{ name: 'php8.3-cli', version: '8.3.12-1', component: 'cli' }, { name: 'php8.3-curl', version: '8.3.12-1', component: 'curl' }], binary: { state: 'read', scope: 'cli-without-ini', version: '8.3.12', sapi: 'cli', builtInExtensions: ['Core', 'json'] }, extensionEnablement: 'not-read', fpmRequest: 'not-read' }] })
const usage = () => ({ scope: 'saved-domain-configuration', observedRuntime: false, usage: [{ version: '8.3', domainCount: 1, domains: [{ name: 'site.example.test', account: 'alpha', handler: 'fpm' }] }] })
type PhpTheme = 'classic' | 'v2'
const phpPrincipal = { kind: 'root' as const, id: 'php-fixture-root', username: 'operator' }
const phpCatalog = tools.map(tool => ({ ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const } }))
const runPresentationTabs = new Function('return ' + PRESENTATION_TABS_CLIENT_BINDING)() as () => void
const runWhmPhpBinding = new Function('return ' + WHM_PHP_CLIENT_BINDING)() as (ask?: (options: Record<string, unknown>) => Promise<boolean>) => void
const phpTemplateCache = new Map<string, HTMLTemplateElement>()
const fastRtlStyle = { display: 'block', visibility: 'visible', direction: 'rtl', getPropertyValue: (p: string) => p === 'display' ? 'block' : p === 'visibility' ? 'visible' : p === 'direction' ? 'rtl' : '' } as unknown as CSSStyleDeclaration
const fastLtrStyle = { display: 'block', visibility: 'visible', direction: 'ltr', getPropertyValue: (p: string) => p === 'display' ? 'block' : p === 'visibility' ? 'visible' : p === 'direction' ? 'ltr' : '' } as unknown as CSSStyleDeclaration
let origGetComputedStyle: typeof window.getComputedStyle
let origQuerySelectorAll: typeof Element.prototype.querySelectorAll
let origDocQuerySelectorAll: typeof Document.prototype.querySelectorAll
const simpleAttrRe = /^\[(name|data-php-action)="([a-z0-9_-]+)"\]$/
const simplePresenceRe = /^\[(id|data-php-[a-z0-9-]+)\]$/
beforeAll(() => {
  origGetComputedStyle = window.getComputedStyle.bind(window)
  window.getComputedStyle = ((el: Element, pseudoElt?: string | null): CSSStyleDeclaration => {
    if (!pseudoElt && !el.closest('[hidden],template,head,script,style')) {
      let cur: Element | null = el
      let inlineVisibility = false
      while (cur) {
        const st = cur.getAttribute('style')
        if (st && /(?:display|visibility|direction)\s*:/i.test(st)) { inlineVisibility = true; break }
        cur = cur.parentElement
      }
      if (!inlineVisibility) {
        const dirAttr = el.closest('[dir]')?.getAttribute('dir')?.toLowerCase()
        return (dirAttr ? dirAttr === 'rtl' : document.documentElement.dir === 'rtl') ? fastRtlStyle : fastLtrStyle
      }
    }
    return origGetComputedStyle(el, pseudoElt)
  }) as typeof window.getComputedStyle
  origQuerySelectorAll = Element.prototype.querySelectorAll
  Element.prototype.querySelectorAll = function (this: Element, selectors: string): NodeListOf<Element> {
    const m = typeof selectors === 'string' ? simpleAttrRe.exec(selectors) : null
    if (m) {
      const attr = m[1]!, val = m[2]!, out: Element[] = [], stack: Element[] = []
      for (let c = this.lastElementChild; c; c = c.previousElementSibling) stack.push(c)
      while (stack.length > 0) {
        const el = stack.pop()!
        if (el.getAttribute(attr) === val) out.push(el)
        for (let c = el.lastElementChild; c; c = c.previousElementSibling) stack.push(c)
      }
      return out as unknown as NodeListOf<Element>
    }
    const pm = typeof selectors === 'string' ? simplePresenceRe.exec(selectors) : null
    if (pm) {
      const attr = pm[1]!, out: Element[] = [], stack: Element[] = []
      for (let c = this.lastElementChild; c; c = c.previousElementSibling) stack.push(c)
      while (stack.length > 0) {
        const el = stack.pop()!
        if (el.hasAttribute(attr)) out.push(el)
        for (let c = el.lastElementChild; c; c = c.previousElementSibling) stack.push(c)
      }
      return out as unknown as NodeListOf<Element>
    }
    return origQuerySelectorAll.call(this, selectors)
  } as typeof Element.prototype.querySelectorAll
  origDocQuerySelectorAll = Document.prototype.querySelectorAll
  Document.prototype.querySelectorAll = function (this: Document, selectors: string): NodeListOf<Element> {
    const pm = typeof selectors === 'string' ? simplePresenceRe.exec(selectors) : null
    if (pm) {
      const attr = pm[1]!, out: Element[] = [], stack: Element[] = this.documentElement ? [this.documentElement] : []
      while (stack.length > 0) {
        const el = stack.pop()!
        if (el.hasAttribute(attr)) out.push(el)
        for (let c = el.lastElementChild; c; c = c.previousElementSibling) stack.push(c)
      }
      return out as unknown as NodeListOf<Element>
    }
    return origDocQuerySelectorAll.call(this, selectors)
  } as typeof Document.prototype.querySelectorAll
  mountPhp('classic', 'en', false, true)
  startPhp(async (_method: string, path: string) => phpResponse(path))
  mountPhp('classic', 'ar', false, false)
  mountPhp('v2', 'en', false, true)
  startPhp(async (_method: string, path: string) => phpResponse(path))
  mountPhp('v2', 'ar', false, false)
  document.body.replaceChildren()
  document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
})
afterAll(() => {
  window.getComputedStyle = origGetComputedStyle
  Element.prototype.querySelectorAll = origQuerySelectorAll
  Document.prototype.querySelectorAll = origDocQuerySelectorAll
})
const wait = async <T>(fn: () => T): Promise<T> => {
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  try { return fn() } catch { return vi.waitFor(fn, { interval: 5 }) }
}
let defaultPhpBodyTemplate: HTMLTemplateElement | undefined
afterEach(async () => {
  document.body.replaceChildren(); await Promise.resolve()
  document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
})
const mountPhp = (theme: PhpTheme, locale: 'en' | 'ar' = 'en', unavailable = false, bindTabs = true): HTMLElement => {
  document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  const key = `${theme}:${locale}:${unavailable}`
  let tpl = phpTemplateCache.get(key)
  if (!tpl) {
    const props = { activeRoute: '/whm/software/php', locale, principal: phpPrincipal, catalog: phpCatalog, capabilityUnavailable: unavailable }
    tpl = document.createElement('template')
    tpl.innerHTML = theme === 'classic' ? renderWhmDetailPage(props)! : renderV2WhmPhp(props)
    phpTemplateCache.set(key, tpl)
  }
  document.body.replaceChildren(tpl.content.cloneNode(true))
  if (bindTabs) runPresentationTabs()
  return document.querySelector<HTMLElement>('[data-whm-detail-route="/whm/software/php"]')!
}
const startPhp = (send: (method: string, path: string, body?: unknown) => Promise<unknown>, ask = vi.fn(async () => true)) => {
  ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
  runWhmPhpBinding(ask); return ask
}
const phpTemplate = (page: HTMLElement, name: string) => page.querySelector<HTMLTemplateElement>(`template[data-xp-template="${name}"]`)!
const pairedPhp = () => {
  const observed = inventory(), managed = manageView(), saved = usage()
  return {
    inventory: { ...observed, versions: [...observed.versions, { ...observed.versions[0]!, version: '8.2', supported: false, binary: { ...observed.versions[0]!.binary, version: '8.2.28' }, packages: [{ name: 'php8.2-cli', version: '8.2.28-1', component: 'cli' }] }] },
    usage: { ...saved, usage: [...saved.usage, { version: '8.2', domainCount: 0, domains: [] }] },
    manage: { ...managed, versions: [...managed.versions, { ...managed.versions[0]!, version: '8.2', lifecycle: { state: 'active' }, domainCount: 0, accountCount: 0, ini: { memory_limit: '128M' }, extensions: [] }] },
  }
}
const phpResponse = (path: string, fixtures = pairedPhp()): unknown => path.endsWith('/inventory') ? fixtures.inventory : path.endsWith('/usage') ? fixtures.usage : fixtures.manage
const phpState = () => document.querySelector<HTMLElement>('[data-whm-php-status]')!
const phpPrototypeNames = ['whm-php-version-entry', 'whm-php-versions-empty', 'whm-php-status', 'whm-php-revoke', 'whm-php-extension-switch', 'whm-php-version-action', 'whm-php-version-remove', 'whm-php-version-tab'] as const
const phpCorruptions: readonly (readonly [string, (template: HTMLTemplateElement, page: HTMLElement) => void])[] = [
  ['missing', template => template.remove()],
  ['duplicate', (template, page) => page.querySelector('[data-whm-php-workspace]')!.append(template.cloneNode(true))],
  ['wrong root', template => template.content.replaceChildren(document.createElement('section'))],
  ['missing slot', template => template.content.querySelector('[data-xp-slot]')!.remove()],
  ['mistyped slot', template => { const old = template.content.querySelector<HTMLElement>('[data-xp-slot]')!, wrong = document.createElement('code'); wrong.dataset.xpSlot = old.dataset.xpSlot; old.replaceWith(wrong) }],
  ['unexpected slot', template => { const extra = document.createElement('span'); extra.dataset.xpSlot = 'unexpected'; template.content.firstElementChild!.append(extra) }],
  ['native routing metadata', template => template.content.firstElementChild!.setAttribute('data-api-url', '/api/server/php/manage/apply')],
  ['borrowed prototype', (template, page) => { const nested = document.createElement('div'); nested.dataset.whmPhpWorkspace = ''; nested.dataset.phpBound = 'true'; nested.append(template); page.querySelector('[data-whm-php-workspace]')!.append(nested) }],
]

describe('PHP selected-theme fidelity and finite native admission', () => {
  beforeAll(() => {
    for (const theme of ['classic', 'v2'] as const) for (const locale of ['en', 'ar'] as const) mountPhp(theme, locale, false, false)
  })
  it.each([
    ['classic', 'en'],
    ['classic', 'ar'],
    ['v2', 'en'],
    ['v2', 'ar'],
  ] as const)('paints real %s inventory shapes, source-separated facts and typed native controls (%s)', async (theme, locale) => {
    const page = mountPhp(theme, locale), fixtures = pairedPhp(), send = vi.fn(async (_method: string, path: string) => phpResponse(path, fixtures))
    startPhp(send); await wait(() => expect(phpState().dataset.state).toBe('read'))
    const entries = [...page.querySelectorAll<HTMLElement>('[data-php-version-entry]')]
    expect(entries).toHaveLength(2); expect(entries.every(node => node.tagName === (theme === 'classic' ? 'ARTICLE' : 'TR'))).toBe(true)
    if (theme === 'v2') for (const entry of entries) expect(entry.children).toHaveLength(6)
    expect(entries[0]!.querySelector('[data-xp-slot="version"]')!.textContent).toBe('PHP 8.3')
    expect(entries[0]!.querySelector<HTMLElement>('[data-xp-slot="default-holder"]')!.hidden).toBe(false)
    expect(entries[0]!.querySelector('[data-xp-slot="binary"]')!.textContent).toBe('8.3.12')
    expect(entries[0]!.querySelector('[data-xp-slot="packages"]')!.textContent).toContain('php8.3-curl 8.3.12-1')
    expect(entries[0]!.querySelector('[data-xp-slot="usage"]')!.textContent).toContain('1')
    expect(page.querySelector<HTMLTextAreaElement>('[name="php-ini"]')!.disabled).toBe(true)
    expect(page.querySelector<HTMLInputElement>('[data-php-display-errors]')!.disabled).toBe(true)
    expect(page.querySelector('[data-php-exception-revoke="omar"]')!.classList.contains(theme === 'classic' ? 'xp-btn' : 'v2-btn')).toBe(true)
    const exception = page.querySelector('[data-php-exception-revoke="omar"]')!.closest<HTMLTableRowElement>('tr')!
    expect(exception.cells).toHaveLength(5); expect(exception.cells[3]!.textContent).toBe('2026-08-02 00:00 UTC')
    expect(page.querySelector('[data-php-extension="opcache"]')!.getAttribute('role')).toBe('switch')
    const matrix = page.querySelector<HTMLTableSectionElement>('[data-whm-php-handler-rows]')!
    expect(matrix.closest('table')!.tHead!.rows[0]!.cells).toHaveLength(7)
    expect([...matrix.rows].every(row => row.cells.length === 7)).toBe(true)
    expect([...matrix.querySelectorAll<HTMLButtonElement>('button')].every(button => button.disabled)).toBe(true)
    for (const name of ['php-selected-version', 'php-extension-version', 'php-version', 'memory_limit', 'php-ini']) expect(page.querySelectorAll('[name="' + name + '"]')).toHaveLength(1)
    expect(send.mock.calls).toEqual([['GET', '/api/server/php/inventory'], ['GET', '/api/server/php/usage'], ['GET', '/api/server/php/manage']])
    expect(page.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
    expect(page.textContent).not.toContain('/usr/bin/php8.3')
    expect(WHM_PHP_CLIENT_BINDING).not.toContain('xp-btn'); expect(WHM_PHP_CLIENT_BINDING).not.toContain('xp-whm-detail-status')
    expect(WHM_PHP_CLIENT_BINDING).not.toContain('innerHTML'); expect(WHM_PHP_CLIENT_BINDING).not.toContain('fetch(')
  })

  it.each(['classic', 'v2'] as const)('keeps %s lifecycle and FPM unknown when only package/CLI observations are available', async theme => {
    const page = mountPhp(theme), fixtures = pairedPhp()
    startPhp(vi.fn(async (_method: string, path: string) => path.endsWith('/manage') ? { state: 'unavailable' } : phpResponse(path, fixtures)))
    await wait(() => expect(phpState().dataset.state).toBe('read'))
    for (const entry of page.querySelectorAll('[data-php-version-entry]')) {
      expect(entry.querySelector('[data-xp-slot="lifecycle"]')!.textContent).toBe('Not read')
      expect(entry.querySelector('[data-xp-slot="fpm"]')!.textContent).toBe('Not read')
      expect(entry.querySelector<HTMLElement>('[data-xp-slot="default-holder"]')!.hidden).toBe(true)
      expect([...entry.querySelectorAll<HTMLButtonElement>('button')].every(button => button.disabled)).toBe(true)
    }
    expect(page.querySelector('[data-php-version-entry="8.2"]')!.textContent).toContain('outside supported provisioning')
    expect(page.querySelector('[data-php-version-entry="8.2"]')!.textContent).not.toContain('End of life')
  })

  it.each([
    ['classic', 'en'],
    ['classic', 'ar'],
    ['v2', 'en'],
    ['v2', 'ar'],
  ] as const)('uses finite %s version tabs without IO, supports RTL/Home/End, and retains same-revision INI drafts (%s)', async (theme, locale) => {
    const page = mountPhp(theme, locale), fixtures = pairedPhp(), send = vi.fn(async (_method: string, path: string) => phpResponse(path, fixtures)), ask = startPhp(send)
    await wait(() => expect(phpState().dataset.state).toBe('read'))
    const tabs = [...page.querySelectorAll<HTMLButtonElement>('[data-php-version-pick]')], memory = page.querySelector<HTMLInputElement>('[name="memory_limit"]')!
    expect(tabs).toHaveLength(2); memory.value = '512M'; tabs[0]!.focus()
    tabs[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: locale === 'ar' ? 'ArrowLeft' : 'ArrowRight', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(tabs[1]); expect(tabs[1]!.getAttribute('aria-selected')).toBe('true'); expect(memory.value).toBe('128M')
    expect(page.querySelector<HTMLSelectElement>('[name="php-extension-version"]')!.value).toBe('8.2')
    expect(page.querySelector<HTMLSelectElement>('[name="php-version"]')!.value).toBe('8.2')
    tabs[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })); expect(memory.value).toBe('512M')
    page.querySelector<HTMLButtonElement>('[data-php-action="discard-ini"]')!.click(); expect(memory.value).toBe('256M')
    tabs[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })); expect(document.activeElement).toBe(tabs[1])
    const fileTab = page.querySelector<HTMLButtonElement>('[data-presentation-tab="file"]')!; fileTab.click()
    expect(page.querySelector<HTMLTextAreaElement>('[name="php-ini"]')!.closest<HTMLElement>('[role="tabpanel"]')!.hidden).toBe(false)
    expect(page.querySelector<HTMLTextAreaElement>('[name="php-ini"]')!.disabled).toBe(true)
    page.querySelector<HTMLButtonElement>('[data-php-action="apply-ini"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(send).toHaveBeenCalledTimes(3); expect(ask).not.toHaveBeenCalled()
  })

  it.each(['classic', 'v2'] as const)('routes one %s version shortcut through the existing default action and preserves focus after readback', async theme => {
    const page = mountPhp(theme), fixtures = pairedPhp()
    const send = vi.fn(async (method: string, path: string, _body?: unknown) => {
      if (method === 'PUT') { fixtures.manage.defaultVersion = '8.2'; fixtures.manage.revision = 'd'.repeat(64); return {} }
      return phpResponse(path, fixtures)
    })
    startPhp(send); await wait(() => expect(phpState().dataset.state).toBe('read'))
    const action = page.querySelector<HTMLButtonElement>('[data-php-version-entry="8.2"] [data-php-version-command="set-default"]')!; action.focus(); action.click(); action.click()
    await wait(() => expect(page.querySelector<HTMLElement>('[data-php-version-entry="8.2"] [data-xp-slot="default-holder"]')!.hidden).toBe(false))
    expect(send.mock.calls.filter(call => call[0] === 'PUT')).toEqual([['PUT', '/api/server/php/default', { version: '8.2', expectedRevision: 'c'.repeat(64) }]])
    expect((document.activeElement as HTMLElement).dataset.phpVersionEntry).toBe('8.2')
    if (theme === 'v2') expect(page.querySelector('[data-whm-php-default]')!.textContent).toBe('8.2')
  })

  it.each(['classic', 'v2'] as const)('rejects every malformed finite %s prototype before any of the 3 startup reads', { tags: ['slow'] }, theme => {
    for (const name of phpPrototypeNames) for (const [reason, corrupt] of phpCorruptions) {
      const page = mountPhp(theme, 'en', false, false); corrupt(phpTemplate(page, name), page)
      const send = vi.fn(); startPhp(send)
      expect(send, `${name}: ${reason}`).not.toHaveBeenCalled(); expect(phpState().dataset.state, `${name}: ${reason}`).toBe('unavailable')
      expect([...page.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select')].every(control => control.disabled)).toBe(true)
      expect(page.querySelector<HTMLButtonElement>('[data-presentation-tab="file"]')!.disabled).toBe(false)
    }
  })

  it.each(['classic', 'v2'] as const)('revalidates %s after a fulfilled or rejected GET without painting stale responses or reopening controls', async theme => {
    for (const rejected of [false, true]) {
      const page = mountPhp(theme, 'en', false, false), pending: { path: string; resolve: (value: unknown) => void; reject: (reason: unknown) => void }[] = []
      const send = vi.fn((_method: string, path: string) => new Promise<unknown>((resolve, reject) => pending.push({ path, resolve, reject }))); startPhp(send)
      expect(send).toHaveBeenCalledTimes(3); phpTemplate(page, 'whm-php-status').remove()
      for (const request of pending) if (rejected) request.reject(new Error('unavailable')); else request.resolve(phpResponse(request.path))
      await wait(() => expect(phpState().dataset.state).toBe('unavailable'))
      expect(page.querySelectorAll('[data-php-version-entry]')).toHaveLength(0)
      expect([...page.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select')].every(control => control.disabled)).toBe(true)
      expect(send).toHaveBeenCalledTimes(3)
    }
  })

  it.each(['classic', 'v2'] as const)('refuses malformed %s control types and presentation-marker spoofing before startup', theme => {
    for (const name of ['whm-php-revoke', 'whm-php-version-action', 'whm-php-version-remove', 'whm-php-version-tab']) for (const field of ['type', 'disabled', 'role', 'presentation']) {
      const page = mountPhp(theme, 'en', false, false), button = phpTemplate(page, name).content.querySelector('button')!
      if (field === 'type') button.type = 'submit'
      if (field === 'disabled') button.disabled = false
      if (field === 'role') button.setAttribute('role', 'link')
      if (field === 'presentation') button.setAttribute('data-presentation-tab', 'file')
      const send = vi.fn(); startPhp(send); expect(send, `${name}: ${field}`).not.toHaveBeenCalled(); expect(phpState().dataset.state).toBe('unavailable')
    }
    for (const field of ['type', 'disabled', 'role']) {
      const page = mountPhp(theme, 'en', false, false), input = phpTemplate(page, 'whm-php-extension-switch').content.querySelector('input')!
      if (field === 'type') input.type = 'text'
      if (field === 'disabled') input.disabled = false
      if (field === 'role') input.setAttribute('role', 'textbox')
      const send = vi.fn(); startPhp(send); expect(send, field).not.toHaveBeenCalled()
    }
  })

  it.each(['classic', 'v2'] as const)('does not apply a %s preview when its contract or admission changes during confirmation', async theme => {
    for (const revoked of [false, true]) {
      const page = mountPhp(theme, 'en', false, false); let confirm!: (value: boolean) => void
      const ask = vi.fn(() => new Promise<boolean>(resolve => { confirm = resolve })), send = vi.fn(async (method: string, path: string) => method === 'GET' ? phpResponse(path) : { preview: { state: 'ready' } })
      startPhp(send, ask); await wait(() => expect(phpState().dataset.state).toBe('read'))
      page.querySelector<HTMLButtonElement>('[data-php-action="apply-ini"]')!.click(); await wait(() => expect(ask).toHaveBeenCalledOnce())
      if (revoked) page.dataset.readonly = 'true'; else phpTemplate(page, 'whm-php-revoke').remove()
      // A read-only frame keeps the saved values shown; only a broken contract makes the page unavailable.
      confirm(true); await tick(); await wait(() => expect(phpState().dataset.state).toBe(revoked ? 'read' : 'unavailable'))
      expect(send.mock.calls.filter(call => call[0] !== 'GET').map(call => call[1])).toEqual(['/api/server/php/manage/preview'])
      expect(page.querySelector<HTMLButtonElement>('[data-php-action="apply-ini"]')!.disabled).toBe(true)
      expect(page.querySelector<HTMLButtonElement>('[data-presentation-tab="file"]')!.disabled).toBe(false)
    }
  })

  it.each(['classic', 'v2'] as const)('does not claim %s job success or retry when a sent apply loses its contract before acknowledgement', async theme => {
    const page = mountPhp(theme, 'en', false, false); let finish!: (value: unknown) => void
    const send = vi.fn((method: string, path: string) => method === 'GET' ? Promise.resolve(phpResponse(path)) : path.endsWith('/preview') ? Promise.resolve({ preview: { state: 'ready' } }) : new Promise<unknown>(resolve => { finish = resolve }))
    startPhp(send); await wait(() => expect(phpState().dataset.state).toBe('read'))
    page.querySelector<HTMLButtonElement>('[data-php-action="apply-ini"]')!.click()
    await wait(() => expect(send.mock.calls.some(call => call[1] === '/api/server/php/manage/apply')).toBe(true))
    phpTemplate(page, 'whm-php-status').remove(); finish({ job: { referenceCode: 'J-9100' } })
    await wait(() => expect(phpState().dataset.state).toBe('unavailable'))
    expect(page.textContent).not.toContain('J-9100')
    expect(send.mock.calls.filter(call => call[0] === 'GET')).toHaveLength(3)
    expect(send.mock.calls.filter(call => call[1] === '/api/server/php/manage/apply')).toHaveLength(1)
    expect(page.querySelector<HTMLButtonElement>('[data-php-action="apply-ini"]')!.disabled).toBe(true)
  })

  it('refuses duplicate version identities, negative usage facts and unbounded install choices', () => {
    expect(() => readPhpManageView({ ...manageView(), versions: [...manageView().versions, ...manageView().versions] })).toThrow()
    expect(() => readPhpManageView({ ...manageView(), versions: [{ ...manageView().versions[0]!, domainCount: -1 }] })).toThrow()
    expect(() => readPhpManageView({ ...manageView(), installable: Array(33).fill('8.2') })).toThrow()
  })
})
const boot = (request?: (method: string, path: string) => Promise<unknown>) => { if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request; runWhmPhpBinding() }
describe('WHM PHP inventory reader', () => {
  beforeEach(() => {
    if (!defaultPhpBodyTemplate) {
      defaultPhpBodyTemplate = document.createElement('template')
      defaultPhpBodyTemplate.innerHTML = `<section data-whm-detail-route="/whm/software/php" data-capability-state="authorized"><section data-whm-detail-section="php-versions">${renderWhmPhpReadback({ locale: 'en', canRead: true })}<table><tbody><tr><td>Not read</td></tr></tbody></table><select name="php-selected-version" disabled></select><button data-native-write disabled>Set default</button></section><section data-whm-detail-section="php-extensions"><select name="php-extension-version" disabled></select><table><tbody></tbody></table><input type="checkbox" disabled></section><section data-whm-detail-section="php-configure"><select name="php-version" disabled></select><textarea name="php-ini" disabled></textarea></section></section>`
    }
    document.body.replaceChildren(defaultPhpBodyTemplate.content.cloneNode(true))
  })

  it.each([
    { locale: 'en', stamp: '2026-10-27T12:34:56.123Z', expected: '2026-10-27 12:34 UTC' },
    { locale: 'ar', stamp: '2026-10-27T12:34:56.000Z', expected: '2026-10-27 12:34 UTC' },
  ] as const)('renders readable datetime metadata for PHP without changing raw observations ($locale)', async ({ locale, stamp, expected }) => {
    document.querySelector<HTMLElement>('[data-whm-php-workspace]')!.outerHTML = renderWhmPhpReadback({ locale, canRead: true })
    const observed = { ...inventory(), observedAt: stamp }
    const send = vi.fn(async (_method: string, path: string) => path.endsWith('/inventory') ? observed : usage())
    document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
    boot(send); await tick()
    document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'
    expect(document.querySelector('[data-whm-php-binary-status]')!.textContent).toBe(locale === 'ar' ? 'قُرئ ملف CLI التنفيذي دون php.ini: \u20668.3.12\u2069. لا يثبت هذا تفعيل امتدادات FPM أو التحقق من طلب للتطبيق.' : 'CLI binary read without php.ini: 8.3.12. This is not FPM extension enablement or application request verification.')
    const shown = document.querySelector<HTMLElement>('[data-whm-php-observed-at]')!
    expect(shown.textContent).toBe(expected)
    expect(shown.tagName).toBe('BDI'); expect(shown.dir).toBe('ltr')
    expect(readPhpInventoryView(observed).observedAt).toBe(stamp)
    expect(document.querySelector<HTMLElement>('[data-whm-php-status]')!.dataset.state).toBe('read')
    expect(document.querySelector<HTMLButtonElement>('[data-native-write]')!.disabled).toBe(true)
    expect(send.mock.calls.map(call => call.slice(0, 2))).toEqual([['GET', '/api/server/php/inventory'], ['GET', '/api/server/php/usage'], ['GET', '/api/server/php/manage']])
  })

  it('requires distinct installed and desired evidence contracts', () => {
    expect(readPhpInventoryView(inventory()).versions[0]!.binary.scope).toBe('cli-without-ini')
    expect(readPhpUsageView(usage())[0]!.domains[0]!.account).toBe('alpha')
    expect(() => readPhpInventoryView({ ...inventory(), source: null })).toThrow()
    expect(() => readPhpUsageView({ ...usage(), observedRuntime: true })).toThrow()
  })
  it('does not accept an unbound binary or unsafe data as an observed runtime', () => {
    const wrong = inventory(); wrong.versions[0]!.binary.version = '8.2.12'
    expect(() => readPhpInventoryView(wrong)).toThrow()
    const bad = inventory(); bad.versions[0]!.packages[0]!.name = '<img src=x>'
    expect(() => readPhpInventoryView(bad)).toThrow()
    expect(() => readPhpUsageView({ ...usage(), usage: [{ version: '8.3', domainCount: 1, domains: [{ name: 'site.example.test', account: 'internal-uuid-key', handler: 'fpm' }] }] })).toThrow()
  })
  it('retains the workspace but makes no request without transport or admission', async () => {
    boot(); expect(document.querySelector<HTMLElement>('[data-whm-php-status]')!.dataset.state).toBe('unavailable')
    document.querySelector<HTMLElement>('[data-whm-php-workspace]')!.removeAttribute('data-php-bound')
    document.querySelector<HTMLElement>('[data-whm-php-workspace]')!.dataset.phpCanRead = 'false'
    const send = vi.fn(); boot(send); await tick(); expect(send).not.toHaveBeenCalled()
  })
  it('reads packages and saved assignments while leaving actual management controls disabled', async () => {
    const send = vi.fn(async (_method: string, path: string) => path.endsWith('/inventory') ? inventory() : usage())
    boot(send); await tick()
    expect(send.mock.calls.map(call => call.slice(0, 2))).toEqual([['GET', '/api/server/php/inventory'], ['GET', '/api/server/php/usage'], ['GET', '/api/server/php/manage']])
    expect(document.querySelector<HTMLElement>('[data-whm-php-status]')!.dataset.state).toBe('read')
    expect(document.querySelector<HTMLSelectElement>('[name="php-selected-version"]')!.value).toBe('8.3')
    expect(document.querySelector<HTMLSelectElement>('[name="php-selected-version"]')!.disabled).toBe(false)
    expect(document.querySelector<HTMLButtonElement>('[data-native-write]')!.disabled).toBe(true)
    expect(document.querySelector<HTMLTextAreaElement>('[name="php-ini"]')!.disabled).toBe(true)
    expect(document.querySelector('[data-whm-detail-section="php-extensions"] tbody')!.textContent).toContain('FPM not read')
    expect(document.querySelector('[data-whm-php-usage]')!.textContent).toContain('site.example.test')
    expect(document.querySelector('[data-whm-php-usage]')!.textContent).toContain('alpha')
    expect(WHM_PHP_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_PHP_CLIENT_BINDING).not.toContain('fetch(')
  })
  it('does not call a desired version installed when package inventory is unavailable', async () => {
    boot(async (_method, path) => path.endsWith('/inventory') ? { state: 'unavailable', source: null, observedAt: '2026-10-26T12:00:00Z', versions: [] } : usage())
    await tick()
    expect(document.querySelector<HTMLElement>('[data-whm-php-status]')!.dataset.state).toBe('failed')
    expect(document.querySelector<HTMLSelectElement>('[name="php-selected-version"]')!.options).toHaveLength(0)
    expect(document.querySelector('[data-whm-php-usage]')!.textContent).toContain('site.example.test')
  })
})

const manageView = () => ({
  state: 'read', reason: null, family: 'debian', observedAt: '2026-10-29T00:00:00.000Z', revision: 'c'.repeat(64), defaultVersion: '8.3', installable: ['8.2'], capabilities: { install: true, remove: true, extensions: true, ini: true }, actions: { manage: true }, usage: [], exceptions: [{ account: 'omar', functions: ['proc_open'], reason: 'Laravel queue worker', grantedAt: '2026-08-02T00:00:00.000Z', grantedBy: 'root' }], exceptionsRevision: 'e'.repeat(64),
  versions: [{ version: '8.3', packages: ['php8.3-fpm'], fpmInstalled: true, fpmBinary: '/usr/sbin/php-fpm8.3', iniFile: '/etc/php/8.3/fpm/php.ini', managedIni: '/etc/php/8.3/fpm/conf.d/99-xpanel.ini', ini: { memory_limit: '256M' }, lifecycle: { state: 'security' }, domainCount: 1, accountCount: 1,
    extensions: [{ module: 'opcache', package: 'opcache', installed: true, enabled: true, purpose: null }, { module: 'redis', package: 'redis', installed: false, enabled: false, purpose: null }] }],
})
describe('WHM PHP management writes', () => {
  const page = () => `<section data-whm-detail-route="/whm/software/php" data-capability-state="authorized"><section data-whm-detail-section="php-versions">${renderWhmPhpReadback({ locale: 'en', canRead: true })}<table><tbody></tbody></table><select name="php-selected-version" disabled></select><button data-php-action="set-default" disabled data-wiring="soon">Set as default</button><details><summary>Confirm</summary><button data-php-action="confirm-remove" disabled>Remove</button></details></section><section data-whm-detail-section="php-install"><input name="php-install-request" disabled><button data-php-action="install-version" disabled>Install</button></section><section data-whm-detail-section="php-extensions"><select name="php-extension-version" disabled></select><table><tbody></tbody></table></section><section data-whm-detail-section="php-configure"><select name="php-version" disabled></select><input name="memory_limit" disabled><button data-php-action="apply-ini" disabled>Test and apply</button></section><section data-whm-detail-section="php-functions"><table><tbody></tbody></table><details><summary>New</summary><select name="php-exception-account" disabled><option value="karim">karim</option></select><textarea name="php-exception-reason" disabled></textarea><input type="checkbox" name="php-exception-exec" disabled><input type="checkbox" name="php-exception-popen" disabled><button data-php-action="grant-exception" disabled>Grant exception</button></details></section></section>`
  let writePageTemplate: HTMLTemplateElement | undefined
  const bootWith = (send: (method: string, path: string, body?: unknown) => Promise<unknown>, ask = vi.fn(async () => true)) => {
    if (!writePageTemplate) {
      writePageTemplate = document.createElement('template')
      writePageTemplate.innerHTML = page()
    }
    document.body.replaceChildren(writePageTemplate.content.cloneNode(true))
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
    runWhmPhpBinding(ask); return ask
  }
  const reads = (path: string) => path.endsWith('/inventory') ? inventory() : path.endsWith('/usage') ? usage() : manageView()
  it('hides only the semantic draft extension choices after a host read, independent of theme class names', async () => {
    bootWith(vi.fn(async (_method: string, path: string) => reads(path)))
    const section = document.querySelector('[data-whm-detail-section="php-extensions"]')!
    const draft = document.createElement('div'); draft.dataset.phpExtensionDraftGrid = ''; draft.className = 'v2-host__choices'; draft.textContent = 'Draft only'
    const independent = document.createElement('div'); independent.className = 'xp-whm-detail-choice-grid'; independent.textContent = 'Independent controls'
    section.append(draft, independent); await tick()
    expect(draft.hidden).toBe(true); expect(independent.hidden).toBe(false)
    expect(section.querySelector('[data-php-extension="opcache"]')).not.toBeNull()
  })
  it('enables the reviewed controls and paints extension switches from the host observation', async () => {
    bootWith(vi.fn(async (_method: string, path: string) => reads(path))); await tick()
    expect(document.querySelector<HTMLButtonElement>('[data-php-action="set-default"]')!.disabled).toBe(false)
    expect(document.querySelector<HTMLInputElement>('[name="memory_limit"]')!.value).toBe('256M')
    const boxes = document.querySelectorAll<HTMLInputElement>('[data-php-extension]')
    expect([...boxes].map(box => [box.dataset.phpExtension, box.checked, box.disabled])).toEqual([['opcache', true, false], ['redis', false, false]])
    expect(document.querySelector('[data-whm-php-version-entries]')!.textContent).toContain('Default')
  })
  it('previews, confirms and submits an ini change bound to the observed revision', async () => {
    const send = vi.fn(async (method: string, path: string, _body?: unknown) => method === 'GET' ? reads(path) : path.endsWith('/preview') ? { preview: { state: 'ready', reason: null } } : { job: { id: 'job-1', referenceCode: 'J-1001' } })
    const ask = bootWith(send); await tick()
    document.querySelector<HTMLInputElement>('[name="memory_limit"]')!.value = '512M'
    document.querySelector<HTMLButtonElement>('[data-php-action="apply-ini"]')!.click(); await tick(); await tick()
    const body = { operation: 'set-ini', version: '8.3', ini: { memory_limit: '512M' }, expectedRevision: 'c'.repeat(64) }
    expect(send.mock.calls.filter(call => call[0] === 'POST')).toEqual([['POST', '/api/server/php/manage/preview', body], ['POST', '/api/server/php/manage/apply', body]])
    expect(ask).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-whm-detail-section="php-configure"] [data-php-manage-status]')!.textContent).toContain('J-1001')
  })
  it.each([
    { referenceCode: null, locale: 'en', expected: 'Unnumbered' },
    { referenceCode: undefined, locale: 'en', expected: 'Unnumbered' },
    { referenceCode: '', locale: 'en', expected: 'Unnumbered' },
    { referenceCode: '  ', locale: 'en', expected: 'Unnumbered' },
    { referenceCode: 123, locale: 'en', expected: 'Unnumbered' },
    { referenceCode: null, locale: 'ar', expected: 'غير مرقمة' },
  ])('shows a localized unnumbered job without exposing its storage id ($locale, $referenceCode)', async ({ referenceCode, locale, expected }) => {
    const internalId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const send = vi.fn(async (method: string, path: string) => method === 'GET' ? reads(path) : path.endsWith('/preview') ? { preview: { state: 'ready', reason: null } } : { job: { id: internalId, referenceCode } })
    document.documentElement.lang = locale
    try {
      bootWith(send); await tick()
      document.querySelector<HTMLButtonElement>('[data-php-action="apply-ini"]')!.click(); await tick(); await tick()
      const message = document.querySelector('[data-whm-detail-section="php-configure"] [data-php-manage-status]')!.textContent
      expect(message).toContain(expected)
      expect(message).not.toContain(internalId)
      expect(send.mock.calls.filter(call => call[0] === 'POST').map(call => call[1])).toEqual(['/api/server/php/manage/preview', '/api/server/php/manage/apply'])
    } finally { document.documentElement.lang = 'en' }
  })
  it('sends nothing when the host refuses the preview or the user cancels', async () => {
    const send = vi.fn(async (method: string, path: string) => method === 'GET' ? reads(path) : { preview: { state: 'blocked', reason: 'nothing-to-do' } })
    bootWith(send, vi.fn(async () => false)); await tick()
    document.querySelector<HTMLButtonElement>('[data-php-action="apply-ini"]')!.click(); await tick(); await tick()
    expect(send.mock.calls.some(call => call[1] === '/api/server/php/manage/apply')).toBe(false)
    expect(document.querySelector('[data-whm-detail-section="php-configure"] [data-php-manage-status]')!.textContent).toContain('nothing-to-do')
  })
  it('lists exceptions with revoke and grants a new one bound to the exceptions revision', async () => {
    const send = vi.fn(async (method: string, path: string, _body?: unknown) => method === 'GET' ? reads(path) : { disableFunctions: 'shell_exec' })
    const ask = bootWith(send); await tick()
    const body = document.querySelector('[data-whm-detail-section="php-functions"] tbody')!
    expect(body.textContent).toContain('omar')
    expect(body.querySelector('button')!.textContent).toBe('Revoke')
    document.querySelector<HTMLTextAreaElement>('[name="php-exception-reason"]')!.value = 'Ghostscript thumbnails'
    document.querySelector<HTMLInputElement>('[name="php-exception-exec"]')!.checked = true
    document.querySelector<HTMLButtonElement>('[data-php-action="grant-exception"]')!.click(); await tick(); await tick()
    expect(ask).toHaveBeenCalledOnce()
    expect(send.mock.calls.find(call => call[0] === 'POST')).toEqual(['POST', '/api/server/php/exceptions', { account: 'karim', functions: ['exec'], reason: 'Ghostscript thumbnails', expectedRevision: 'e'.repeat(64) }])
    document.querySelector('[data-whm-detail-section="php-functions"] tbody button')!.dispatchEvent(new MouseEvent('click')); await tick(); await tick()
    expect(send.mock.calls.find(call => call[0] === 'DELETE')).toEqual(['DELETE', '/api/server/php/exceptions/omar', { expectedRevision: 'e'.repeat(64) }])
  })
  it('reads the management contract strictly', () => {
    expect(readPhpManageView(manageView()).versions[0]!.extensions).toHaveLength(2)
    expect(() => readPhpManageView({ ...manageView(), revision: 'x' })).toThrow()
    expect(() => readPhpManageView({ ...manageView(), versions: [{ ...manageView().versions[0], extensions: [{ module: '<b>', package: null, installed: true, enabled: true }] }] })).toThrow()
  })
})
