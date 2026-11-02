// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindPresentationTabs, PRESENTATION_TABS_CLIENT_BINDING } from './presentation-tabs-client.ts'

const originalUrl = window.location.href
const keys = ['one', 'two', 'three']
const panels = (selected = 'one', prefix = 'p'): string => `<div data-presentation-tabs="panels"><div role="tablist" aria-label="Views">${keys.map(key => `<button type="button" role="tab" id="${prefix}-tab-${key}" data-presentation-tab="${key}" aria-selected="${key === selected}" aria-controls="${prefix}-panel-${key}" tabindex="${key === selected ? 0 : -1}">${key}</button>`).join('')}</div>${keys.map(key => `<div role="tabpanel" id="${prefix}-panel-${key}" aria-labelledby="${prefix}-tab-${key}"${key === selected ? '' : ' hidden'}><input aria-label="${key} detail"></div>`).join('')}</div>`
const sections = (): string => `<div data-presentation-tabs="sections"><div role="tablist" aria-label="Sections">${['overview', 'security', 'activity'].map(key => `<button type="button" role="tab" id="s-tab-${key}" data-presentation-tab="${key}" aria-selected="${key === 'overview'}" aria-controls="s-panel" tabindex="${key === 'overview' ? 0 : -1}">${key}</button>`).join('')}</div><div role="tabpanel" id="s-panel" aria-labelledby="s-tab-overview"><div data-presentation-tab-visible="overview security"><div data-readonly="true" data-qualified="false"><button type="button" data-native disabled>Native operation</button><a href="#security-detail" data-presentation-tab-link="security">Security detail</a><h2 id="security-detail">Security</h2></div></div><div data-presentation-tab-visible="overview security"><section id="core-security">Core sign-in</section></div><div data-presentation-tab-visible="overview activity"><h2 id="activity-detail">Activity</h2></div></div></div>`
const tab = (key: string): HTMLButtonElement => document.querySelector<HTMLButtonElement>(`[data-presentation-tab="${key}"]`)!
const selected = (): string | null => document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('data-presentation-tab') ?? null
const press = (key: string, target: HTMLElement, extra: KeyboardEventInit = {}): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })
  target.dispatchEvent(event)
  return event
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
  document.documentElement.removeAttribute('dir')
  window.history.replaceState(null, '', originalUrl)
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
})

describe('local presentation tabs', () => {
  it('keeps the server-selected panel, then selects one panel without changing native controls', () => {
    document.body.innerHTML = panels('two')
    bindPresentationTabs()
    expect(selected()).toBe('two')
    tab('three').click()
    expect(selected()).toBe('three')
    expect([...document.querySelectorAll<HTMLElement>('[role="tabpanel"]')].filter(panel => !panel.hidden).map(panel => panel.id)).toEqual(['p-panel-three'])
    expect(tab('three').tabIndex).toBe(0)
    expect(tab('two').tabIndex).toBe(-1)
  })

  it.each(['ltr', 'rtl'])('uses direction-correct arrows, wraps and supports Home/End in %s', direction => {
    document.documentElement.dir = direction
    document.body.innerHTML = panels()
    bindPresentationTabs()
    tab('one').focus()
    const arrow = direction === 'rtl' ? 'ArrowLeft' : 'ArrowRight'
    expect(press(arrow, tab('one')).defaultPrevented).toBe(true)
    expect(selected()).toBe('two')
    expect(document.activeElement).toBe(tab('two'))
    press('End', tab('two'))
    expect(selected()).toBe('three')
    press(arrow, tab('three'))
    expect(selected()).toBe('one')
    press('End', tab('one'))
    press('Home', tab('three'))
    expect(selected()).toBe('one')
  })

  it.each(['disabled', 'hidden', 'inert', 'aria-disabled', 'fieldset'])('skips an actually unavailable %s tab without enabling it', state => {
    document.body.innerHTML = panels()
    const unavailable = tab('two')
    if (state === 'disabled') unavailable.disabled = true
    else if (state === 'fieldset') { const fieldset = document.createElement('fieldset'); fieldset.disabled = true; unavailable.before(fieldset); fieldset.append(unavailable) }
    else unavailable.setAttribute(state, state === 'aria-disabled' ? 'true' : '')
    const before = unavailable.outerHTML
    bindPresentationTabs()
    press('ArrowRight', tab('one'))
    expect(selected()).toBe('three')
    expect(unavailable.outerHTML).toBe(before)
  })

  it('permits a usable clicked tab after the selected tab becomes disabled, preserving the disabled state', () => {
    document.body.innerHTML = panels()
    bindPresentationTabs()
    tab('one').disabled = true
    tab('two').click()
    expect(selected()).toBe('two')
    expect(tab('one').disabled).toBe(true)
    expect(press('ArrowRight', tab('one')).defaultPrevented).toBe(false)
  })

  it.each([{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }])('preserves modified/composing keyboard input: %j', extra => {
    document.body.innerHTML = panels()
    bindPresentationTabs()
    expect(press('ArrowRight', tab('one'), extra).defaultPrevented).toBe(false)
    expect(selected()).toBe('one')
  })

  it('preserves already prevented events and returns focus before hiding its old panel', () => {
    document.body.innerHTML = panels()
    tab('one').addEventListener('keydown', event => event.preventDefault())
    bindPresentationTabs()
    press('ArrowRight', tab('one'))
    expect(selected()).toBe('one')
    document.querySelector<HTMLInputElement>('#p-panel-one input')!.focus()
    tab('two').click()
    expect(document.activeElement).toBe(tab('two'))
  })

  it('filters shared sections and relabels the common panel while keeping the core security slot unblocked', () => {
    document.body.innerHTML = sections()
    bindPresentationTabs()
    tab('security').click()
    expect(document.querySelector('#s-panel')?.getAttribute('aria-labelledby')).toBe('s-tab-security')
    expect(document.querySelector<HTMLElement>('#activity-detail')!.parentElement!.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('#core-security')!.parentElement!.hidden).toBe(false)
    expect(document.querySelector('#core-security')!.closest('[data-readonly], [data-qualified="false"]')).toBeNull()
    expect(document.querySelector<HTMLButtonElement>('[data-native]')!.disabled).toBe(true)
    tab('overview').click()
    expect([...document.querySelectorAll<HTMLElement>('[data-presentation-tab-visible]')].every(section => !section.hidden)).toBe(true)
  })

  it('uses finite summary links and an initial valid fragment without URL persistence', () => {
    document.body.innerHTML = sections()
    window.history.replaceState(null, '', '#security-detail')
    const push = vi.spyOn(window.history, 'pushState'), replace = vi.spyOn(window.history, 'replaceState')
    bindPresentationTabs()
    expect(selected()).toBe('security')
    tab('overview').click()
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    document.querySelector('[data-presentation-tab-link]')!.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(selected()).toBe('security')
    expect(document.activeElement).toBe(tab('security'))
    expect(window.location.hash).toBe('#security-detail')
    expect(push).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it('keeps local selection usable beneath native read-only markers and calls no transport or storage API', () => {
    document.body.innerHTML = `<div data-readonly="true" data-qualified="false">${panels()}</div>`
    const request = vi.fn(), fetch = vi.fn(), socket = vi.fn()
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
    vi.stubGlobal('fetch', fetch); vi.stubGlobal('WebSocket', socket)
    const store = vi.spyOn(Storage.prototype, 'setItem'), remove = vi.spyOn(Storage.prototype, 'removeItem'), clear = vi.spyOn(Storage.prototype, 'clear')
    const push = vi.spyOn(window.history, 'pushState'), replace = vi.spyOn(window.history, 'replaceState')
    new Function('return ' + PRESENTATION_TABS_CLIENT_BINDING)()()
    tab('two').click(); press('End', tab('two'))
    expect(selected()).toBe('three')
    for (const spy of [request, fetch, socket, store, remove, clear, push, replace]) expect(spy).not.toHaveBeenCalled()
    expect(document.querySelector('[data-readonly]')?.getAttribute('data-qualified')).toBe('false')
  })

  it('initializes once and isolates nested owners and detached roots', () => {
    document.body.innerHTML = panels()
    document.querySelector('#p-panel-one')!.insertAdjacentHTML('beforeend', panels('one', 'nested'))
    bindPresentationTabs(); bindPresentationTabs()
    const inner = document.querySelector<HTMLButtonElement>('#nested-tab-two')!, changes = vi.spyOn(inner, 'setAttribute')
    inner.click()
    expect(inner.getAttribute('aria-selected')).toBe('true')
    expect(tab('one').getAttribute('aria-selected')).toBe('true')
    expect(changes).toHaveBeenCalledTimes(1)
    const root = tab('one').closest('[data-presentation-tabs]')!
    root.remove()
    tabFrom(root, 'two').click()
    expect(tabFrom(root, 'one').getAttribute('aria-selected')).toBe('true')
  })

  const malformed: readonly [string, () => void][] = [
    ['unsupported mode', () => document.querySelector('[data-presentation-tabs]')!.setAttribute('data-presentation-tabs', 'automatic')],
    ['missing label', () => document.querySelector('[role="tablist"]')!.removeAttribute('aria-label')],
    ['duplicate keys', () => tab('two').setAttribute('data-presentation-tab', 'one')],
    ['duplicate global IDs', () => document.body.insertAdjacentHTML('beforeend', '<div id="p-panel-two"></div>')],
    ['missing target', () => tab('two').setAttribute('aria-controls', 'foreign-panel')],
    ['wrong target label', () => document.querySelector('#p-panel-two')!.setAttribute('aria-labelledby', 'p-tab-three')],
    ['two selected tabs', () => tab('two').setAttribute('aria-selected', 'true')],
    ['native action tab', () => tab('two').setAttribute('data-action', 'native-operation')],
    ['submit tab', () => tab('two').type = 'submit'],
  ]
  it.each(malformed)('leaves malformed markup untouched with no listener: %s', (_name, change) => {
    document.body.innerHTML = panels()
    const second = tab('two')
    change()
    const before = document.body.innerHTML
    bindPresentationTabs()
    second.click()
    expect(document.body.innerHTML).toBe(before)
  })

  it('rejects unknown shared-section membership and foreign summary targets before hiding content', () => {
    for (const change of [() => document.querySelector('[data-presentation-tab-visible]')!.setAttribute('data-presentation-tab-visible', 'overview foreign'), () => document.querySelector('[data-presentation-tab-link]')!.setAttribute('href', '#foreign')]) {
      document.body.innerHTML = sections()
      change()
      const before = document.body.innerHTML
      bindPresentationTabs(); tab('security').click()
      expect(document.body.innerHTML).toBe(before)
    }
  })

  it('revalidates targets and native availability before each later selection', () => {
    document.body.innerHTML = panels()
    bindPresentationTabs()
    tab('two').setAttribute('aria-controls', 'foreign')
    tab('two').click()
    expect(selected()).toBe('one')
    expect(document.querySelector<HTMLElement>('#p-panel-one')!.hidden).toBe(false)
  })
})

function tabFrom(root: Element, key: string): HTMLButtonElement { return root.querySelector<HTMLButtonElement>(`[data-presentation-tab="${key}"]`)! }
