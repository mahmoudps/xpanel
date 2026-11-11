// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmSecurityEvidence } from './board-port/whm-security-components.ts'
import { WHM_SECURITY_CLIENT_BINDING } from './whm-security-client.ts'
import { renderV2WhmSecurityOverview } from './themes/v2/pages/xwhm/security/overview.ts'

const payload = () => ({ overall: 'not-qualified', configuration: { state: 'read', source: 'saved-configuration', panelPort: 2087, sshPort: 22, engine: 'apache' }, checks: ['ssh-service', 'ssh-public-key', 'ssh-password', 'ssh-root-login', 'ssh-attempts'].map(id => ({ id, state: 'unavailable', value: null as string | null, source: 'host-observation' })) })
const status = () => document.querySelector<HTMLElement>('[data-whm-security-status]')!
const boot = (send?: ReturnType<typeof vi.fn>) => { if (send) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send; new Function('return ' + WHM_SECURITY_CLIENT_BINDING)()() }
beforeEach(() => { document.body.innerHTML = renderWhmSecurityEvidence({ locale: 'en' }); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })

describe('root security observation controller', () => {
  it('refuses reads under the canonical unavailable capability wrapper', () => {
    document.querySelector<HTMLElement>('[data-whm-security-evidence]')!.dataset.capabilityState = 'unavailable'
    const send = vi.fn(); boot(send)
    expect(send).not.toHaveBeenCalled(); expect(status().dataset.state).toBe('unavailable')
    expect(document.querySelector<HTMLButtonElement>('[data-whm-security-refresh]')!.disabled).toBe(true)
  })
  it('keeps missing transport or unavailable admission explicit without issuing a check', async () => {
    boot(); expect(status().dataset.state).toBe('unavailable')
    document.querySelector<HTMLElement>('[data-whm-security-evidence]')!.dataset.securityBound = ''
    document.querySelector<HTMLElement>('[data-whm-security-evidence]')!.dataset.capabilityUnavailable = 'true'
    const send = vi.fn(); boot(send); expect(send).not.toHaveBeenCalled()
  })
  it('renders saved configuration separately and never marks unknown checks healthy', async () => {
    const send = vi.fn(async () => payload()); boot(send)
    await vi.waitFor(() => expect(status().dataset.state).toBe('read'))
    expect(document.querySelectorAll('[data-check-state="unavailable"]')).toHaveLength(5)
    expect(document.querySelector('[data-whm-security-configuration]')!.textContent).toContain('Saved SSH port22')
    expect(send.mock.calls).toEqual([['GET', '/api/security/workspace']])
    expect(WHM_SECURITY_CLIENT_BINDING).not.toContain('innerHTML'); expect(WHM_SECURITY_CLIENT_BINDING).not.toContain('fetch(')
  })
  it('renders returned values as text and rejects an invented overall pass while retaining prior observations', async () => {
    const current = payload(); current.checks[0] = { ...current.checks[0]!, state: 'attention', value: '<img src=x>' }
    const send = vi.fn(async () => current); boot(send)
    await vi.waitFor(() => expect(status().dataset.state).toBe('read'))
    expect(document.querySelector('img')).toBeNull()
    const before = document.querySelector('[data-whm-security-check-rows]')!.textContent
    current.overall = 'verified'
    document.querySelector<HTMLButtonElement>('[data-whm-security-refresh]')!.click()
    await vi.waitFor(() => expect(status().dataset.state).toBe('failed'))
    expect(document.querySelector('[data-whm-security-check-rows]')!.textContent).toBe(before)
  })
})

type SecurityTheme = 'classic' | 'v2'
const securityMarkup = (theme: SecurityTheme, locale: 'en' | 'ar' = 'en') => theme === 'classic' ? renderWhmSecurityEvidence({ locale }) : renderV2WhmSecurityOverview({ locale, observationAuthority: { canRead: true, canManage: false } })
const mountSecurity = (theme: SecurityTheme, locale: 'en' | 'ar' = 'en') => {
  document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'; document.body.innerHTML = securityMarkup(theme, locale)
  return document.querySelector<HTMLElement>('[data-whm-security-evidence]')!
}
const securityTemplate = (root: HTMLElement, name = 'whm-security-fact-technical') => root.querySelector<HTMLTemplateElement>(`template[data-xp-template="${name}"]`)!
const corruptSecurityTemplates: readonly (readonly [string, (template: HTMLTemplateElement, root: HTMLElement) => void])[] = [
  ['missing', template => template.remove()],
  ['duplicate', (template, root) => root.append(template.cloneNode(true))],
  ['wrong root', template => template.content.replaceChildren(document.createElement('section'))],
  ['missing label', template => template.content.querySelector('[data-xp-slot="label"]')!.remove()],
  ['wrong label tag', template => { const node = document.createElement('span'); node.dataset.xpSlot = 'label'; template.content.querySelector('[data-xp-slot="label"]')!.replaceWith(node) }],
  ['wrong value tag', template => { const node = document.createElement('code'); node.dataset.xpSlot = 'value'; template.content.querySelector('[data-xp-slot="value"]')!.replaceWith(node) }],
  ['duplicate value', template => { const value = template.content.querySelector('[data-xp-slot="value"]')!; value.parentElement!.append(value.cloneNode(true)) }],
  ['unexpected slot', template => { const node = document.createElement('span'); node.dataset.xpSlot = 'unexpected'; template.content.firstElementChild!.append(node) }],
  ['wrong direction', template => template.content.querySelector('[data-xp-slot="value"]')!.setAttribute('dir', 'rtl')],
  ['event handler', template => template.content.firstElementChild!.setAttribute('onclick', 'window.unexpected=true')],
  ['native action metadata', template => template.content.firstElementChild!.setAttribute('data-api-url', '/api/security/workspace')],
  ['interactive child', template => template.content.firstElementChild!.append(document.createElement('button'))],
  ['borrowed from nested workspace', (template, root) => { const nested = document.createElement('div'); nested.dataset.whmSecurityEvidence = ''; nested.dataset.securityBound = 'true'; nested.append(template); root.append(nested) }],
]

describe('security facts from the selected theme', () => {
  it.each(['classic', 'v2'] as const)('writes the %s finding totals as text into the count slots a theme provides', async theme => {
    mountSecurity(theme)
    const current = payload(); current.checks[0] = { ...current.checks[0]!, state: 'observed-ok', value: 'active' }; current.checks[1] = { ...current.checks[1]!, state: 'attention', value: 'no' }
    const slots = () => Object.fromEntries([...document.querySelectorAll<HTMLElement>('[data-whm-security-count]')].map(slot => [slot.dataset.whmSecurityCount, slot.textContent]))
    if (theme === 'v2') expect(slots()).toEqual({ all: '—', 'observed-ok': '—', attention: '—', unavailable: '—' })
    boot(vi.fn(async () => current))
    await vi.waitFor(() => expect(status().dataset.state).toBe('read'))
    expect(slots()).toEqual(theme === 'v2' ? { all: '5', 'observed-ok': '1', attention: '1', unavailable: '3' } : {})
    const tiles = [...document.querySelectorAll<HTMLElement>('[data-whm-security-count]')].map(slot => slot.closest('.v2-kpi')!)
    expect(tiles.filter(tile => tile.querySelector('.v2-kpi__note, .v2-kpi__value--text'))).toEqual([])
  })
  it.each(['classic', 'v2'] as const)('uses the real %s renderer and emitted binding for technical facts and unknown text in both locales', async theme => {
    for (const locale of ['en', 'ar'] as const) {
      const root = mountSecurity(theme, locale), current = payload(); current.configuration.engine = '<img src=x>'
      const send = vi.fn(async () => current); boot(send)
      await vi.waitFor(() => expect(status().dataset.state).toBe('read'))
      const config = root.querySelector('[data-whm-security-configuration]')!
      expect([...config.querySelectorAll('bdi')].map(node => node.textContent)).toEqual(['2087', '22', '<img src=x>'])
      expect([...config.querySelectorAll('bdi')].every(node => node.dir === 'ltr')).toBe(true)
      expect([...config.children].every(node => theme === 'classic' ? node.classList.contains('xp-security-observation__fact') : !node.className.includes('xp-'))).toBe(true)
      expect(config.querySelector('img,button,input')).toBeNull()
      expect(root.querySelectorAll('[data-check-state="unavailable"]')).toHaveLength(5)
      expect(send.mock.calls).toEqual([['GET', '/api/security/workspace']])
      expect(root.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)

      mountSecurity(theme, locale)
      const unknown = vi.fn(async () => ({ ...payload(), configuration: { state: 'unavailable', source: 'saved-configuration' } })); boot(unknown)
      await vi.waitFor(() => expect(status().dataset.state).toBe('read'))
      const unknownConfig = document.querySelector('[data-whm-security-configuration]')!
      expect(unknownConfig.querySelectorAll('bdi')).toHaveLength(0)
      expect(unknownConfig.querySelector('[data-xp-slot="value"]')?.tagName).toBe('SPAN')
      expect(unknownConfig.querySelector('[data-xp-slot="value"]')?.hasAttribute('dir')).toBe(false)
      expect(unknown.mock.calls).toEqual([['GET', '/api/security/workspace']])
    }
    expect(WHM_SECURITY_CLIENT_BINDING).not.toContain('xp-security-observation__fact')
    expect(WHM_SECURITY_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_SECURITY_CLIENT_BINDING).not.toContain('fetch(')
  })

  it.each(['classic', 'v2'] as const)('sends zero transport calls for malformed finite %s templates before startup', theme => {
    for (const name of ['whm-security-fact-technical', 'whm-security-fact-text']) for (const [reason, corrupt] of corruptSecurityTemplates) {
      const root = mountSecurity(theme), template = securityTemplate(root, name); corrupt(template, root)
      const send = vi.fn(); boot(send)
      expect(send, `${name}: ${reason}`).not.toHaveBeenCalled()
      expect(status().dataset.state, `${name}: ${reason}`).toBe('unavailable')
      expect(root.querySelector<HTMLButtonElement>('[data-whm-security-refresh]')!.disabled).toBe(true)
      expect(root.querySelector('[data-whm-security-configuration]')!.children).toHaveLength(0)
    }
  })

  it.each(['classic', 'v2'] as const)('rejects ambiguous or mistyped live %s roots before the GET', theme => {
    for (const selector of ['[data-whm-security-check-rows]', '[data-whm-security-configuration]', '[data-whm-security-status]', '[data-whm-security-refresh]']) {
      const root = mountSecurity(theme), node = root.querySelector(selector)!; node.parentElement!.append(node.cloneNode(true))
      const send = vi.fn(); boot(send); expect(send, selector).not.toHaveBeenCalled()
      expect(root.querySelector<HTMLButtonElement>('[data-whm-security-refresh]')!.disabled).toBe(true)
    }
    const root = mountSecurity(theme); root.querySelector<HTMLButtonElement>('[data-whm-security-refresh]')!.type = 'submit'
    const send = vi.fn(); boot(send); expect(send).not.toHaveBeenCalled()
  })

  it.each(['classic', 'v2'] as const)('retains prior %s facts and permanently closes the local contract after a late malformed template', async theme => {
    const root = mountSecurity(theme), send = vi.fn(async () => payload()); boot(send)
    await vi.waitFor(() => expect(status().dataset.state).toBe('read'))
    const config = root.querySelector('[data-whm-security-configuration]')!, before = config.outerHTML
    const template = securityTemplate(root), repair = template.cloneNode(true); template.remove()
    const refresh = root.querySelector<HTMLButtonElement>('[data-whm-security-refresh]')!; refresh.click()
    expect(send).toHaveBeenCalledTimes(1); expect(config.outerHTML).toBe(before); expect(status().dataset.state).toBe('unavailable'); expect(refresh.disabled).toBe(true)
    root.append(repair); refresh.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(send).toHaveBeenCalledTimes(1); expect(refresh.disabled).toBe(true)
  })

  it.each(['classic', 'v2'] as const)('revalidates the %s template after both fulfilled and rejected awaits', async theme => {
    for (const rejected of [false, true]) {
      const root = mountSecurity(theme)
      let finish!: (value: unknown) => void, fail!: (reason: unknown) => void
      const send = vi.fn(() => new Promise<unknown>((resolve, reject) => { finish = resolve; fail = reject })); boot(send)
      expect(send).toHaveBeenCalledTimes(1)
      const rows = root.querySelector('[data-whm-security-check-rows]')!.outerHTML
      securityTemplate(root).content.querySelector('[data-xp-slot="value"]')!.remove()
      if (rejected) fail(new Error('unavailable')); else finish(payload())
      await vi.waitFor(() => expect(status().dataset.state).toBe('unavailable'))
      expect(root.querySelector('[data-whm-security-check-rows]')!.outerHTML).toBe(rows)
      expect(root.querySelector('[data-whm-security-configuration]')!.children).toHaveLength(0)
      expect(root.querySelector<HTMLButtonElement>('[data-whm-security-refresh]')!.disabled).toBe(true)
      expect(status().textContent).toBe('Unavailable')
      expect(send).toHaveBeenCalledTimes(1)
    }
  })

  it.each(['classic', 'v2'] as const)('does not paint a %s response or reenable controls after admission is revoked', async theme => {
    const root = mountSecurity(theme); let finish!: (value: unknown) => void
    const send = vi.fn(() => new Promise<unknown>(resolve => { finish = resolve })); boot(send)
    root.dataset.readonly = 'true'; finish(payload())
    await vi.waitFor(() => expect(status().dataset.state).toBe('unavailable'))
    expect(root.querySelector('[data-whm-security-configuration]')!.children).toHaveLength(0)
    expect(root.querySelector<HTMLButtonElement>('[data-whm-security-refresh]')!.disabled).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
  })
})
