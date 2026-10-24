/// <reference lib="dom" />
// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://panel.example.test/panel?lang=ar&theme=light&accountId=account-test"}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_REALTIME_SCRIPT } from './ws-client.ts'
import { tools, visibleNavigation, type CatalogTool, type VisibilityContext } from '@xpanel/catalog'
import { renderWebApp } from './app.ts'
import { getSurfaceNavigationLabel } from './shell.ts'

const fixture = `
  <div class="xp-shell">
    <nav id="xp-sidebar" data-xp-sidebar tabindex="-1" aria-label="Navigation">
      <button data-action="close-mobile-nav">Close navigation</button>
      <a id="home-link" href="/panel?lang=ar&theme=light&accountId=account-test" data-nav-route="/home" class="xp-nav-item--active" aria-current="page">Home</a>
      <a id="files-link" href="/panel/files/manager?lang=ar&theme=light&accountId=account-test" data-nav-route="/files/manager">Files</a>
    </nav>
    <button data-xp-nav-backdrop data-action="close-mobile-nav" hidden>Close navigation</button>
    <div data-xp-shell-content>
      <button id="nav-toggle" data-action="toggle-mobile-nav" aria-controls="xp-sidebar" aria-expanded="false">Navigation</button>
      <button id="search-toggle" data-action="open-cmdk">Search</button>
      <button id="activity-toggle" data-action="open-activity-drawer">Activity</button>
      <input id="background-input" aria-label="Background field">
      <section id="files-manager" data-section="files-manager">Unrelated section</section>
      <section id="explicit-anchor">Explicit anchor</section>
    </div>
  </div>
  <footer id="previously-inert" inert="">Unavailable background</footer>
  <div id="xp-cmdk-modal" data-xp-cmdk hidden role="dialog" aria-modal="true">
    <button data-action="close-cmdk">Close search</button>
    <input type="search" aria-label="Quick search">
    <a href="/panel/files/manager">Files result</a>
  </div>
  <div id="xp-activity-drawer" data-xp-drawer="activity" tabindex="-1" hidden role="dialog" aria-modal="true">
    <button data-action="close-activity-drawer">Close activity</button>
    <a href="/panel/jobs">Job history</a>
  </div>
`

type Listener = [string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined]
let documentListeners: Listener[]
let windowListeners: Listener[]
let originalWidth: PropertyDescriptor | undefined
let originalScrollX: PropertyDescriptor | undefined
let originalScrollY: PropertyDescriptor | undefined
let socket: ReturnType<typeof vi.fn>

function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const target = document.querySelector<T>(selector)
  if (!target) throw new Error(`Missing fixture element: ${selector}`)
  return target
}

function viewport(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  window.dispatchEvent(new Event('resize'))
}

function bootClient(realtime = 'false'): void {
  document.documentElement.dataset.realtimeEnabled = realtime
  new Function('window', 'document', BROWSER_REALTIME_SCRIPT)(window, document)
}

function press(key: string, options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
  ;(document.activeElement ?? document).dispatchEvent(event)
  return event
}

function toolbarOptions(): HTMLDetailsElement {
  const toolbar = document.createElement('details')
  toolbar.className = 'xp-toolbar-options'
  toolbar.setAttribute('data-xp-toolbar-options', '')
  toolbar.open = true
  toolbar.innerHTML = '<summary class="xp-btn">Search/account</summary><div class="xp-toolbar-options__content"><input id="toolbar-input" aria-label="Toolbar field"></div>'
  toolbar.querySelector('.xp-toolbar-options__content')!.append(element('#search-toggle'), element('#activity-toggle'))
  element('[data-xp-shell-content]').append(toolbar)
  return toolbar
}

function searchablePalette(): void {
  element('#xp-cmdk-modal').innerHTML = `
    <button data-action="close-cmdk">Close search</button>
    <input type="search" data-cmdk-search role="combobox" aria-expanded="false" aria-controls="command-results">
    <ul id="command-results" data-cmdk-results role="listbox">
      <li data-cmdk-row><a id="command-files" data-cmdk-item="/files/manager" data-cmdk-search-text="File manager Files /files/manager" role="option" tabindex="-1" href="/panel/files/manager?lang=ar&theme=light&density=compact&accountId=account-test">File manager</a></li>
      <li data-cmdk-row><a id="command-mail" data-cmdk-item="/email/accounts" data-cmdk-search-text="Email accounts Mail /email/accounts" role="option" tabindex="-1" href="/panel/email/accounts?lang=ar&theme=light&density=compact&accountId=account-test">Email accounts</a></li>
      <li data-cmdk-row><a id="command-arabic" data-cmdk-item="/domains" data-cmdk-search-text="إعدادات النِّطاقات المواقع /domains" role="option" tabindex="-1" href="/panel/domains?lang=ar&theme=light&density=compact&accountId=account-test">إعدادات النطاقات</a></li>
    </ul>
    <p data-cmdk-empty role="status" hidden>No matching pages.</p>
    <p data-cmdk-status aria-live="polite" data-count-label="Results"></p>
  `
}

function searchCommands(query: string): void {
  const input = element<HTMLInputElement>('[data-cmdk-search]')
  input.value = query
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function selectedCommand(): HTMLElement | null {
  return document.querySelector('[data-cmdk-item][aria-selected="true"]')
}

beforeEach(() => {
  document.body.innerHTML = fixture
  document.body.style.overflow = 'clip'
  document.documentElement.style.overflow = 'scroll'
  originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
  originalScrollX = Object.getOwnPropertyDescriptor(window, 'scrollX')
  originalScrollY = Object.getOwnPropertyDescriptor(window, 'scrollY')
  viewport(390)
  socket = vi.fn(function WebSocketMock() {})
  vi.stubGlobal('WebSocket', socket)
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))

  // jsdom has no layout engine; browser acceptance measures geometry separately.
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    if (window.innerWidth >= 960 && (this.matches('[data-action="toggle-mobile-nav"], [data-action="close-mobile-nav"]') || this.matches('details[data-xp-toolbar-options] > summary'))) {
      return [] as unknown as DOMRectList
    }
    if (window.innerWidth < 960 && this.closest('[data-xp-sidebar]') && element('.xp-shell').dataset.mobileNav !== 'open') {
      return [] as unknown as DOMRectList
    }
    let parent = this.parentElement
    while (parent) {
      if (parent instanceof HTMLDetailsElement && !parent.open && !parent.querySelector(':scope > summary')?.contains(this)) {
        return [] as unknown as DOMRectList
      }
      parent = parent.parentElement
    }
    return [new DOMRect(0, 0, 44, 44)] as unknown as DOMRectList
  })
  documentListeners = []
  windowListeners = []
  const addDocumentListener = document.addEventListener.bind(document)
  const addWindowListener = window.addEventListener.bind(window)
  vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
    documentListeners.push([type, listener, options])
    addDocumentListener(type, listener, options)
  })
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    windowListeners.push([type, listener, options])
    addWindowListener(type, listener, options)
  })
})

afterEach(() => {
  for (const [type, listener, options] of documentListeners) document.removeEventListener(type, listener, options)
  for (const [type, listener, options] of windowListeners) window.removeEventListener(type, listener, options)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (originalWidth) Object.defineProperty(window, 'innerWidth', originalWidth)
  if (originalScrollX) Object.defineProperty(window, 'scrollX', originalScrollX)
  if (originalScrollY) Object.defineProperty(window, 'scrollY', originalScrollY)
  document.body.innerHTML = ''
  document.body.style.overflow = ''
  document.documentElement.style.overflow = ''
  delete document.documentElement.dataset.realtimeEnabled
})

describe('overlay document position restoration', () => {
  function documentPosition() {
    const position = { x: 12, y: 180 }
    Object.defineProperty(window, 'scrollX', { configurable: true, get: () => position.x })
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => position.y })
    const restore = vi.spyOn(window, 'scrollTo').mockImplementation((options: ScrollToOptions | number, y?: number) => {
      expect(document.body.style.overflow).toBe('clip')
      expect(document.documentElement.style.overflow).toBe('scroll')
      if (typeof options === 'number') { position.x = options; position.y = y ?? 0 }
      else { position.x = options.left ?? position.x; position.y = options.top ?? position.y }
    })
    return { position, restore }
  }

  it.each([false, true])('restores the captured position after focus causes the observed 5px displacement; missing trigger=%s', missing => {
    viewport(1440)
    const { position, restore } = documentPosition()
    const trigger = element('#search-toggle'), fallback = element('#home-link')
    bootClient()
    trigger.focus()
    trigger.click()
    if (missing) trigger.remove()
    const returned = missing ? fallback : trigger
    returned.addEventListener('focus', () => { position.x += 3; position.y += 5 }, { once: true })
    press('Escape')
    expect(document.activeElement).toBe(returned)
    expect(position).toEqual({ x: 12, y: 180 })
    expect(restore).toHaveBeenCalledOnce()
    expect(restore).toHaveBeenCalledWith({ left: 12, top: 180, behavior: 'instant' })
  })

  it.each(['switch', 'reopen'])('keeps the original document offset across overlay %s', transition => {
    const { position } = documentPosition()
    bootClient()
    element('#search-toggle').click()
    position.y = 185
    element(transition === 'switch' ? '#activity-toggle' : '#search-toggle').click()
    press('Escape')
    expect(position).toEqual({ x: 12, y: 180 })
  })

  it('preserves a negative RTL horizontal offset', () => {
    const { position, restore } = documentPosition()
    position.x = -12
    bootClient()
    element('#search-toggle').click()
    position.x = -9
    press('Escape')
    expect(restore).toHaveBeenCalledWith({ left: -12, top: 180, behavior: 'instant' })
  })

  it('does not overwrite a deliberate history change during an overlay', () => {
    const { position, restore } = documentPosition()
    const href = location.href
    bootClient()
    element('#search-toggle').click()
    history.replaceState(null, '', '#intentional-navigation')
    position.y = 240
    try { press('Escape'); expect(position.y).toBe(240); expect(restore).not.toHaveBeenCalled() }
    finally { history.replaceState(null, '', href) }
  })

  it.each(['ordinary', 'prevented', 'modified', 'new-tab'])('preserves navigation intent and focus policy for %s links', kind => {
    const { position, restore } = documentPosition()
    viewport(1440)
    searchablePalette()
    bootClient()
    const trigger = element('#search-toggle'), link = element<HTMLAnchorElement>('#command-files')
    trigger.focus(); trigger.click()
    position.y = 185
    if (kind === 'new-tab') link.target = '_blank'
    if (kind === 'prevented') link.addEventListener('click', event => event.preventDefault())
    // Prevent jsdom's unimplemented destination load after product event dispatch.
    const stopLoad = (event: Event) => event.preventDefault()
    window.addEventListener('click', stopLoad, { once: true })
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: kind === 'modified' }))
    expect(element('#xp-cmdk-modal').hidden).toBe(true)
    expect(position.y).toBe(185)
    expect(restore).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger)
  })

  it('does not issue a document scroll when focus restoration leaves the position unchanged', () => {
    const { position, restore } = documentPosition()
    bootClient()
    element('#search-toggle').click()
    press('Escape')
    expect(position).toEqual({ x: 12, y: 180 })
    expect(restore).not.toHaveBeenCalled()
  })
})

describe('responsive navigation client', () => {
  it('opens the mobile sheet and restores focus, scroll and existing inert state on Escape', () => {
    bootClient()
    const trigger = element('#nav-toggle')
    trigger.focus()
    trigger.click()

    expect(element('.xp-shell').dataset.mobileNav).toBe('open')
    expect(element('[data-xp-nav-backdrop]').hidden).toBe(false)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(element('[data-xp-shell-content]').hasAttribute('inert')).toBe(true)
    expect(element('#xp-sidebar').getAttribute('role')).toBe('dialog')
    expect(document.activeElement).toBe(element('#home-link'))
    expect(document.body.style.overflow).toBe('hidden')
    expect(document.documentElement.style.overflow).toBe('hidden')
    expect(socket).not.toHaveBeenCalled()

    expect(press('Escape').defaultPrevented).toBe(true)
    expect(element('.xp-shell').dataset.mobileNav).toBeUndefined()
    expect(element('[data-xp-nav-backdrop]').hidden).toBe(true)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
    expect(element('[data-xp-shell-content]').hasAttribute('inert')).toBe(false)
    expect(element('#previously-inert').hasAttribute('inert')).toBe(true)
    expect(element('#xp-sidebar').hasAttribute('role')).toBe(false)
    expect(element('#xp-sidebar').hasAttribute('aria-modal')).toBe(false)
    expect(document.body.style.overflow).toBe('clip')
    expect(document.documentElement.style.overflow).toBe('scroll')
  })

  it.each(['[data-xp-nav-backdrop]', '#xp-sidebar [data-action="close-mobile-nav"]'])('closes the sheet through %s', selector => {
    bootClient()
    element('#nav-toggle').click()
    element(selector).click()
    expect(element('.xp-shell').dataset.mobileNav).toBeUndefined()
    expect(document.activeElement).toBe(element('#nav-toggle'))
  })

  it('wraps Tab in both directions and redirects attempted background focus', () => {
    bootClient()
    element('#nav-toggle').click()
    element('#files-link').focus()
    expect(press('Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(element('#xp-sidebar button'))
    expect(press('Tab', { shiftKey: true }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(element('#files-link'))
    element('#background-input').focus()
    expect(document.activeElement).toBe(element('#home-link'))
  })

  it('focuses the sidebar itself when the navigation has no available controls', () => {
    element('#xp-sidebar').replaceChildren()
    bootClient()
    element('#nav-toggle').click()
    expect(document.activeElement).toBe(element('#xp-sidebar'))
    expect(press('Tab').defaultPrevented).toBe(true)
    press('Escape')
    expect(document.activeElement).toBe(element('#nav-toggle'))
  })

  it('keeps later collapsed section summaries reachable before wrapping mobile navigation focus', () => {
    element('#xp-sidebar').innerHTML = `
      <details open><summary id="first-section">General</summary><a id="first-section-link" href="/panel">Overview</a></details>
      <details><summary id="later-section">More tools</summary><a id="later-section-link" href="/panel/files/manager">Files</a></details>
    `
    bootClient()
    element('#nav-toggle').click()
    expect(document.activeElement).toBe(element('#first-section-link'))
    expect(press('Tab').defaultPrevented).toBe(false)
    element('#later-section').focus()
    expect(document.activeElement).toBe(element('#later-section'))
    expect(press('Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(element('#first-section'))
    element('#later-section').click()
    element('#later-section-link').focus()
    expect(press('Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(element('#first-section'))
  })

  it.each([true, false])('excludes non-focusable closed-details links with positive layout rectangles, using native visibility %s', nativeVisibility => {
    const sidebar = element('#xp-sidebar')
    sidebar.innerHTML = `
      <details open><summary id="first-section">General</summary><a id="first-section-link" href="/panel">Overview</a></details>
      <details><summary id="later-section">More tools</summary><a id="closed-section-link" href="/panel/files/manager">Files</a></details>
    `
    vi.mocked(HTMLElement.prototype.getClientRects).mockReturnValue([new DOMRect(0, 0, 44, 44)] as unknown as DOMRectList)
    for (const target of sidebar.querySelectorAll<HTMLElement>('*')) {
      Object.defineProperty(target, 'checkVisibility', {
        configurable: true,
        value: nativeVisibility ? () => target.id !== 'closed-section-link' : undefined,
      })
    }
    const hiddenLink = element('#closed-section-link')
    const hiddenFocus = vi.spyOn(hiddenLink, 'focus').mockImplementation(() => {})
    expect(hiddenLink.getClientRects().length).toBe(1)
    expect(hiddenLink.tabIndex).toBe(0)

    bootClient()
    element('#nav-toggle').click()
    expect(document.activeElement).toBe(element('#first-section-link'))
    element('#later-section').focus()
    expect(document.activeElement).toBe(element('#later-section'))
    expect(press('Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(element('#first-section'))
    expect(press('Tab', { shiftKey: true }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(element('#later-section'))
    expect(hiddenFocus).not.toHaveBeenCalled()
  })

  it('moves a hidden mobile close control to the active desktop route without scrolling', () => {
    bootClient()
    element('#nav-toggle').click()
    const close = element('#xp-sidebar [data-action="close-mobile-nav"]')
    close.focus()
    expect(document.activeElement).toBe(close)
    const focus = vi.spyOn(element('#home-link'), 'focus')
    viewport(960)
    expect(document.activeElement).toBe(element('#home-link'))
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true })
    expect(element('[data-xp-shell-content]').hasAttribute('inert')).toBe(false)
    expect(document.body.style.overflow).toBe('clip')
  })

  it('recovers the active route when responsive CSS blurs the mobile close button before resize', () => {
    bootClient()
    element('#nav-toggle').click()
    const close = element('#xp-sidebar [data-action="close-mobile-nav"]')
    close.focus()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 960 })
    close.blur()
    expect(document.activeElement).toBe(document.body)
    window.dispatchEvent(new Event('resize'))
    expect(document.activeElement).toBe(element('#home-link'))
    expect(element('[data-xp-shell-content]').hasAttribute('inert')).toBe(false)
  })

  it('preserves a visible sidebar link when the mobile sheet becomes desktop navigation', () => {
    bootClient()
    element('#nav-toggle').click()
    element('#files-link').focus()
    viewport(960)
    expect(document.activeElement).toBe(element('#files-link'))
    expect(press('Tab').defaultPrevented).toBe(false)
  })

  it('cleans mobile state at 960px and leaves desktop navigation untrapped', () => {
    bootClient()
    element('#nav-toggle').click()
    viewport(960)
    expect(element('.xp-shell').dataset.mobileNav).toBeUndefined()
    expect(element('[data-xp-nav-backdrop]').hidden).toBe(true)
    expect(element('[data-xp-shell-content]').hasAttribute('inert')).toBe(false)
    expect(document.body.style.overflow).toBe('clip')
    expect(element('#nav-toggle').getAttribute('aria-expanded')).toBe('false')
    element('#files-link').focus()
    expect(press('Tab').defaultPrevented).toBe(false)
    expect(press('Escape').defaultPrevented).toBe(false)
    element('#nav-toggle').click()
    expect(element('.xp-shell').dataset.mobileNav).toBeUndefined()
  })
})

describe('responsive toolbar disclosure', () => {
  it('initially closes on mobile, preserves mobile choices, and resets only across the breakpoint', () => {
    const toolbar = toolbarOptions()
    bootClient()
    expect(toolbar.open).toBe(false)
    expect(toolbar.dataset.mobileReady).toBe('true')
    element('details[data-xp-toolbar-options] > summary').click()
    expect(toolbar.open).toBe(true)
    viewport(768)
    expect(toolbar.open).toBe(true)
    viewport(959.5)
    expect(toolbar.open).toBe(true)
    viewport(960)
    expect(toolbar.open).toBe(true)
    viewport(1440)
    expect(toolbar.open).toBe(true)
    viewport(390)
    expect(toolbar.open).toBe(false)
    viewport(768)
    expect(toolbar.open).toBe(false)
  })

  it('starts expanded on desktop and moves focus to the summary when mobile collapse hides a focused control', () => {
    const toolbar = toolbarOptions()
    viewport(1440)
    bootClient()
    expect(toolbar.open).toBe(true)
    element('#toolbar-input').focus()
    expect(press('Escape').defaultPrevented).toBe(false)
    expect(toolbar.open).toBe(true)
    viewport(390)
    expect(toolbar.open).toBe(false)
    expect(document.activeElement).toBe(element('details[data-xp-toolbar-options] > summary'))
  })

  it('moves the mobile summary to a visible desktop toolbar control without scrolling', () => {
    toolbarOptions()
    bootClient()
    const summary = element('details[data-xp-toolbar-options] > summary')
    summary.focus()
    expect(document.activeElement).toBe(summary)
    const focus = vi.spyOn(element('#toolbar-input'), 'focus')
    viewport(960)
    expect(document.activeElement).toBe(element('#toolbar-input'))
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true })
  })

  it('recovers a toolbar control when responsive CSS blurs its summary before resize', () => {
    toolbarOptions()
    bootClient()
    const summary = element('details[data-xp-toolbar-options] > summary')
    summary.focus()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 960 })
    summary.blur()
    expect(document.activeElement).toBe(document.body)
    window.dispatchEvent(new Event('resize'))
    expect(document.activeElement).toBe(element('#toolbar-input'))
  })

  it('does not revive toolbar focus after a deliberate visible blur before resize', () => {
    toolbarOptions()
    bootClient()
    const summary = element('details[data-xp-toolbar-options] > summary')
    summary.focus()
    summary.blur()
    expect(document.activeElement).toBe(document.body)
    viewport(960)
    expect(document.activeElement).toBe(document.body)
  })

  it.each([
    { from: 1440, to: 390, expected: 'details[data-xp-toolbar-options] > summary' },
    { from: 390, to: 1440, expected: '#toolbar-input' },
  ])('restores palette focus across the toolbar breakpoint from $from to $to', ({ from, to, expected }) => {
    const toolbar = toolbarOptions()
    viewport(from)
    bootClient()
    toolbar.open = true
    element('#search-toggle').focus()
    element('#search-toggle').click()
    expect(document.activeElement).toBe(element('#xp-cmdk-modal input'))
    viewport(to)
    const focus = vi.spyOn(element(expected), 'focus')
    press('Escape')
    expect(document.activeElement).toBe(element(expected))
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true })
    expect(document.body.style.overflow).toBe('clip')
    expect(element('.xp-shell').hasAttribute('inert')).toBe(false)
  })

  it('retains the original desktop opener after resizing through mobile while the palette is open', () => {
    toolbarOptions()
    viewport(1440)
    bootClient()
    element('#search-toggle').focus()
    element('#search-toggle').click()
    viewport(390)
    viewport(1440)
    press('Escape')
    expect(document.activeElement).toBe(element('#search-toggle'))
  })

  it('closes on Escape from a toolbar input and restores summary focus without a modal trap or scroll lock', () => {
    const toolbar = toolbarOptions()
    bootClient()
    toolbar.open = true
    element('#toolbar-input').focus()
    expect(press('Escape').defaultPrevented).toBe(true)
    expect(toolbar.open).toBe(false)
    expect(document.activeElement).toBe(element('details[data-xp-toolbar-options] > summary'))
    expect(press('Tab').defaultPrevented).toBe(false)
    expect(document.body.style.overflow).toBe('clip')
    expect(element('[data-xp-shell-content]').hasAttribute('inert')).toBe(false)
  })

  it.each(['#search-toggle', '#activity-toggle', '#nav-toggle'])('closes the disclosure when %s opens an overlay and returns to a visible control', selector => {
    const toolbar = toolbarOptions()
    bootClient()
    toolbar.open = true
    element(selector).focus()
    element(selector).click()
    expect(toolbar.open).toBe(false)
    expect(document.body.style.overflow).toBe('hidden')
    press('Escape')
    expect(document.activeElement).toBe(selector === '#nav-toggle'
      ? element('#nav-toggle')
      : element('details[data-xp-toolbar-options] > summary'))
    expect(document.body.style.overflow).toBe('clip')
    expect(element('[data-xp-shell-content]').hasAttribute('inert')).toBe(false)
  })

  it('returns to the disclosure summary after opening search by keyboard from a nested input', () => {
    const toolbar = toolbarOptions()
    bootClient()
    toolbar.open = true
    element('#toolbar-input').focus()
    press('k', { ctrlKey: true })
    expect(toolbar.open).toBe(false)
    expect(document.activeElement).toBe(element('#xp-cmdk-modal input'))
    press('Escape')
    expect(document.activeElement).toBe(element('details[data-xp-toolbar-options] > summary'))
  })
})

describe('command palette and activity drawer focus', () => {
  it('focuses search, wraps Tab only while open, and returns to the search trigger', () => {
    viewport(1440)
    bootClient()
    element('#search-toggle').focus()
    element('#search-toggle').click()
    expect(document.activeElement).toBe(element('#xp-cmdk-modal input'))
    expect(element('.xp-shell').hasAttribute('inert')).toBe(true)
    element('#xp-cmdk-modal a').focus()
    expect(press('Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(element('#xp-cmdk-modal button'))
    element('#xp-cmdk-modal button').click()
    expect(element('#xp-cmdk-modal').hidden).toBe(true)
    expect(document.activeElement).toBe(element('#search-toggle'))
    expect(element('.xp-shell').hasAttribute('inert')).toBe(false)
    expect(press('Tab').defaultPrevented).toBe(false)
  })

  it('focuses the first drawer control and returns focus on Escape and its close button', () => {
    bootClient()
    for (const close of ['escape', 'button']) {
      element('#activity-toggle').click()
      expect(document.activeElement).toBe(element('#xp-activity-drawer button'))
      if (close === 'escape') press('Escape')
      else element('#xp-activity-drawer button').click()
      expect(element('#xp-activity-drawer').hidden).toBe(true)
      expect(document.activeElement).toBe(element('#activity-toggle'))
    }
  })

  it.each(['hidden', 'disconnected'])('uses the visible active route when the palette opener is %s', state => {
    viewport(1440)
    bootClient()
    const opener = element('#search-toggle')
    opener.focus()
    opener.click()
    if (state === 'hidden') opener.hidden = true
    else opener.remove()
    const focus = vi.spyOn(element('#home-link'), 'focus')
    press('Escape')
    expect(document.activeElement).toBe(element('#home-link'))
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true })
    expect(element('.xp-shell').hasAttribute('inert')).toBe(false)
  })

  it('returns keyboard-opened search from the document body to the active route', () => {
    viewport(1440)
    bootClient()
    expect(document.activeElement).toBe(document.body)
    press('k', { ctrlKey: true })
    expect(document.activeElement).toBe(element('#xp-cmdk-modal input'))
    press('Escape')
    expect(document.activeElement).toBe(element('#home-link'))
  })

  it('falls back to the main content when no visible opener or active route remains', () => {
    viewport(1440)
    const main = document.createElement('main')
    main.id = 'main-content'
    main.tabIndex = -1
    element('[data-xp-shell-content]').append(main)
    bootClient()
    element('#search-toggle').click()
    element('#search-toggle').remove()
    element('#home-link').removeAttribute('aria-current')
    const focus = vi.spyOn(main, 'focus')
    press('Escape')
    expect(document.activeElement).toBe(main)
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true })
  })

  it('switches from the mobile sheet to search without stranding focus in the closed navigation', () => {
    bootClient()
    element('#nav-toggle').click()
    press('k', { ctrlKey: true })
    expect(element('.xp-shell').dataset.mobileNav).toBeUndefined()
    expect(element('#xp-cmdk-modal').hidden).toBe(false)
    expect(document.activeElement).toBe(element('#xp-cmdk-modal input'))
    press('Escape')
    expect(document.activeElement).toBe(element('#nav-toggle'))
    expect(element('.xp-shell').hasAttribute('inert')).toBe(false)
    expect(element('[data-xp-shell-content]').hasAttribute('inert')).toBe(false)
    expect(document.body.style.overflow).toBe('clip')
  })
})

describe('document navigation and scrolling', () => {
  it('leaves anchor navigation and active route state to the document response', () => {
    bootClient()
    const scroll = vi.fn()
    element('#files-manager').scrollIntoView = scroll
    let preventedByClient = true
    document.addEventListener('click', event => {
      preventedByClient = event.defaultPrevented
      event.preventDefault()
    }, { once: true })
    element('#files-link').click()
    expect(preventedByClient).toBe(false)
    expect(element('#home-link').getAttribute('aria-current')).toBe('page')
    expect(element('#files-link').hasAttribute('aria-current')).toBe(false)
    expect(scroll).not.toHaveBeenCalled()
  })

  it('uses the rendered contextual link for programmatic product navigation', () => {
    bootClient()
    let destination: string | undefined
    document.addEventListener('click', event => {
      destination = (event.target as HTMLAnchorElement).href
      event.preventDefault()
    }, { once: true })
    const client = window as unknown as { xpanelSwitchView: (route: string) => void }
    client.xpanelSwitchView('/files/manager')
    expect(destination).toBe('https://panel.example.test/panel/files/manager?lang=ar&theme=light&accountId=account-test')
  })

  it.each([true, false])('honors reduced motion %s for an explicit anchor scroll', reducedMotion => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: reducedMotion })))
    bootClient()
    const scroll = vi.fn()
    element('#explicit-anchor').scrollIntoView = scroll
    const client = window as unknown as { xpanelSwitchView: (route: string) => void }
    client.xpanelSwitchView('#explicit-anchor')
    expect(scroll).toHaveBeenCalledWith({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' })
  })

  it('opens the rendered palette for slash when its search input is hidden', () => {
    element('#xp-cmdk-modal input').setAttribute('data-xp-filter-input', '')
    bootClient()
    element('#nav-toggle').focus()
    expect(press('/').defaultPrevented).toBe(true)
    expect(element('#xp-cmdk-modal').hidden).toBe(false)
    expect(document.activeElement).toBe(element('#xp-cmdk-modal input'))
    press('Escape')
    expect(document.activeElement).toBe(element('#nav-toggle'))
  })

  it('chooses a visible page filter instead of the earlier hidden palette search', () => {
    element('#xp-cmdk-modal input').setAttribute('data-xp-filter-input', '')
    const filter = document.createElement('input')
    filter.type = 'search'
    filter.id = 'page-filter'
    element('[data-xp-shell-content]').append(filter)
    bootClient()
    element('#nav-toggle').focus()
    const focus = vi.spyOn(filter, 'focus')
    expect(press('/').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(filter)
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true })
    expect(element('#xp-cmdk-modal').hidden).toBe(true)
  })

  it('ignores slash inside an editable field and leaves it native when no search exists', () => {
    bootClient()
    element('#background-input').focus()
    expect(press('/').defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(element('#background-input'))
    element('#xp-cmdk-modal').remove()
    element('#nav-toggle').focus()
    expect(press('/').defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(element('#nav-toggle'))
  })

  it('starts real-time transport only when the document enables it', () => {
    bootClient('true')
    expect(socket).toHaveBeenCalledOnce()
    expect(socket).toHaveBeenCalledWith('wss://panel.example.test/api/ws')
  })
})

describe('local command palette behavior', () => {
  beforeEach(() => {
    viewport(1440)
    searchablePalette()
  })

  it('filters by page name, section and route without a request or a synthetic account search', () => {
    bootClient()
    element('#search-toggle').click()
    for (const query of ['FILE manager', 'files', '/files/manager', 'manager files']) {
      searchCommands(query)
      expect(selectedCommand()?.id).toBe('command-files')
      expect(element('[data-cmdk-status]').textContent).toBe('Results: 1')
      expect(element('#command-mail').closest('li')!.hidden).toBe(true)
      expect(element('[data-cmdk-empty]').hidden).toBe(true)
      expect(element('[data-cmdk-search]').getAttribute('aria-activedescendant')).toBe('command-files')
    }
    searchCommands('files mail')
    expect(selectedCommand()).toBeNull()
    expect(element('[data-cmdk-empty]').hidden).toBe(false)
    expect(element('[data-cmdk-status]').textContent).toBe('')
    expect(element('[data-cmdk-search]').hasAttribute('aria-activedescendant')).toBe(false)
    expect(press('Enter').defaultPrevented).toBe(true)
    expect(element('#xp-cmdk-modal').hidden).toBe(false)
    expect(socket).not.toHaveBeenCalled()
  })

  it('matches Arabic accents, hamza variants and excess whitespace while keeping ASCII counts', () => {
    bootClient()
    element('#search-toggle').click()
    searchCommands('  اعدادات   النطاقات  ')
    expect(selectedCommand()?.id).toBe('command-arabic')
    expect(element('[data-cmdk-status]').textContent).toBe('Results: 1')
    expect(element('#command-arabic').getAttribute('aria-posinset')).toBe('1')
    expect(element('#command-arabic').getAttribute('aria-setsize')).toBe('1')
  })

  it('finds a keyword alias without changing its visible label or contextual keyboard destination', () => {
    const link = element('#command-files')
    link.setAttribute('data-cmdk-search-text', `${link.getAttribute('data-cmdk-search-text')} Legacy file browser`)
    const activate = vi.spyOn(link, 'click').mockImplementation(() => {})
    const href = link.getAttribute('href')
    bootClient()
    element('#search-toggle').click()
    searchCommands('legacy browser')
    expect(selectedCommand()).toBe(link)
    expect(link.textContent).toBe('File manager')
    expect(element('#command-mail').closest('li')!.hidden).toBe(true)
    expect(element('[data-cmdk-search]')).toBe(document.activeElement)
    expect(press('Enter').defaultPrevented).toBe(true)
    expect(activate).toHaveBeenCalledTimes(1)
    expect(link.getAttribute('href')).toBe(href)
    expect(socket).not.toHaveBeenCalled()
  })

  it('wraps arrow selection, keeps focus in the input, and executes the exact contextual link on Enter', () => {
    bootClient()
    element('#search-toggle').focus()
    element('#search-toggle').click()
    const input = element('[data-cmdk-search]')
    expect(input.getAttribute('aria-expanded')).toBe('true')
    expect(selectedCommand()?.id).toBe('command-files')
    expect(press('ArrowUp').defaultPrevented).toBe(true)
    expect(selectedCommand()?.id).toBe('command-arabic')
    press('ArrowDown')
    expect(selectedCommand()?.id).toBe('command-files')
    press('ArrowDown')
    expect(selectedCommand()?.id).toBe('command-mail')
    expect(document.activeElement).toBe(input)
    let destination: string | undefined
    document.addEventListener('click', event => {
      destination = (event.target as HTMLAnchorElement).href
      event.preventDefault()
    }, { once: true })
    expect(press('Enter').defaultPrevented).toBe(true)
    expect(destination).toBe('https://panel.example.test/panel/email/accounts?lang=ar&theme=light&density=compact&accountId=account-test')
    expect(element('#xp-cmdk-modal').hidden).toBe(true)
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(element('#search-toggle'))
    expect(element('.xp-shell').hasAttribute('inert')).toBe(false)
  })

  it('resets a previous query and selection on reopening and traps Tab around the composite control', () => {
    bootClient()
    element('#search-toggle').click()
    searchCommands('mail')
    press('Escape')
    element('#search-toggle').click()
    expect(element<HTMLInputElement>('[data-cmdk-search]').value).toBe('')
    expect(selectedCommand()?.id).toBe('command-files')
    expect(element('[data-cmdk-status]').textContent).toBe('Results: 3')
    expect(press('Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(element('#xp-cmdk-modal button'))
    expect(press('Tab', { shiftKey: true }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(element('[data-cmdk-search]'))
  })

  it('never executes a filtered-out option and restores all results after clearing a query', () => {
    bootClient()
    element('#search-toggle').click()
    press('ArrowUp')
    searchCommands('mail')
    expect(selectedCommand()?.id).toBe('command-mail')
    press('ArrowDown')
    expect(selectedCommand()?.id).toBe('command-mail')
    searchCommands('')
    expect(selectedCommand()?.id).toBe('command-files')
    expect(document.querySelectorAll('[data-cmdk-row]:not([hidden])')).toHaveLength(3)
    expect(element('[data-cmdk-status]').textContent).toBe('Results: 3')
  })

  it('scrolls only the result container to reveal keyboard selection', () => {
    bootClient()
    element('#search-toggle').click()
    const list = element('[data-cmdk-results]')
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 400, 100))
    const row = element('#command-mail').closest('li')!
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 240, 400, 44))
    const scrollIntoView = vi.fn()
    row.scrollIntoView = scrollIntoView
    document.documentElement.scrollTop = 180
    document.body.scrollTop = 180
    press('ArrowDown')
    expect(list.scrollTop).toBe(84)
    expect(document.documentElement.scrollTop).toBe(180)
    expect(document.body.scrollTop).toBe(180)
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('selects a pointer result and honors its normal anchor click', () => {
    bootClient()
    element('#search-toggle').click()
    element('#command-mail').dispatchEvent(new Event('pointermove', { bubbles: true }))
    expect(selectedCommand()?.id).toBe('command-mail')
    let prevented = true
    document.addEventListener('click', event => {
      prevented = event.defaultPrevented
      event.preventDefault()
    }, { once: true })
    element('#command-mail').click()
    expect(prevented).toBe(false)
    expect(element('#xp-cmdk-modal').hidden).toBe(true)
  })

  it('preserves IME composition and modified input keys', () => {
    bootClient()
    element('#search-toggle').click()
    for (const options of [{ isComposing: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(press('ArrowDown', options).defaultPrevented).toBe(false)
      expect(press('Enter', options).defaultPrevented).toBe(false)
      expect(selectedCommand()?.id).toBe('command-files')
      expect(element('#xp-cmdk-modal').hidden).toBe(false)
    }
  })
})

describe('contextual navigation chords', () => {
  it.each([
    ['d', '#home-link', '/home'],
    ['a', '#accounts-link', '/whm/accounts'],
    ['f', '#files-link', '/files/manager'],
  ])('uses g %s for the rendered %s link with all context intact', (key, selector, route) => {
    element('#xp-sidebar').insertAdjacentHTML('beforeend', '<a id="accounts-link" href="/whm/accounts?lang=ar&theme=light&density=compact&accountId=account-test" data-nav-route="/whm/accounts">Accounts</a>')
    bootClient()
    let destination: string | undefined
    document.addEventListener('click', event => {
      destination = (event.target as HTMLAnchorElement).getAttribute('data-nav-route') ?? undefined
      expect((event.target as HTMLAnchorElement).href).toContain('lang=ar&theme=light')
      expect((event.target as HTMLAnchorElement).href).toContain('accountId=account-test')
      event.preventDefault()
    }, { once: true })
    press('g')
    expect(press(key).defaultPrevented).toBe(true)
    expect(destination).toBe(route)
    expect(element(selector)).toBeDefined()
  })

  it.each(['/whm', '/mail/inbox'])('finds the current surface home %s rather than inventing a dashboard URL', route => {
    element('#home-link').setAttribute('data-nav-route', route)
    element('#home-link').setAttribute('href', `${route}?lang=ar&theme=light&density=compact&accountId=account-test`)
    bootClient()
    const click = vi.spyOn(element('#home-link'), 'click').mockImplementation(() => {})
    press('g')
    press('d')
    expect(click).toHaveBeenCalledOnce()
  })

  it('does not follow unqualified, hidden or broad href-only lookalikes', () => {
    element('#home-link').remove()
    element('#files-link').hidden = true
    element('[data-xp-shell-content]').insertAdjacentHTML('beforeend', '<a href="/whm/accounts?lang=ar">Unavailable accounts shortcut</a><a href="/fake-dashboard">Dashboard text</a>')
    bootClient()
    const click = vi.fn()
    document.addEventListener('click', click)
    for (const key of ['a', 'd', 'f']) {
      press('g')
      expect(press(key).defaultPrevented).toBe(false)
    }
    expect(click).not.toHaveBeenCalled()
  })

  it('does not use a prefix across editing, a modifier, or an intervening overlay', () => {
    bootClient()
    const click = vi.spyOn(element('#home-link'), 'click').mockImplementation(() => {})
    press('g')
    element('#background-input').focus()
    press('d')
    element('#nav-toggle').focus()
    press('d')
    press('g')
    press('d', { ctrlKey: true })
    press('d')
    press('g')
    press('k', { ctrlKey: true })
    press('Escape')
    press('d')
    expect(click).not.toHaveBeenCalled()
  })
})

describe('authorized command palette rendering', () => {
  const qualifiedCatalog: CatalogTool[] = tools.map(tool => tool.status === 'out-of-scope' ? tool : ({
    ...tool, status: 'verified', delivery: { status: 'verified', reason: 'Synthetic navigation unit fixture only.', evidence: [] },
  }))
  const owner: VisibilityContext = { principal: { kind: 'user', id: 'fixture-user', username: 'fixture', accountId: 'fixture-account' }, disabledFeatures: new Set() }
  const root: VisibilityContext = { principal: { kind: 'root', id: 'fixture-root', username: 'fixture-admin' } }

  it.each(['en', 'ar'] as const)('includes existing search aliases only for admitted pages in %s', locale => {
    const html = renderWebApp({ surface: 'xpanel', visibility: owner, catalog: qualifiedCatalog, locale })
    const parsed = new DOMParser().parseFromString(html, 'text/html')
    const domains = parsed.querySelector('[data-cmdk-item="/domains"]')!
    expect(domains.getAttribute('data-cmdk-search-text')).toContain('Addon Domains')
    expect(domains.textContent).not.toContain('Addon Domains')
    expect(parsed.querySelectorAll('[data-cmdk-item^="/whm"]')).toHaveLength(0)
    expect(parsed.querySelectorAll('[data-cmdk-item^="/design/"]')).toHaveLength(0)
  })

  it('escapes keyword metadata and never leaks aliases from a page outside the principal scope', () => {
    const pages = (visibility: VisibilityContext) => visibleNavigation(visibility, qualifiedCatalog)
      .flatMap(surface => surface.sections.flatMap(section => section.pages))
    const admitted = pages(owner).find(page => page.route === '/domains')!
    const forbidden = pages(root).find(page => page.route === '/whm/accounts/new')!
    const admittedKeywords = admitted.keywords, forbiddenKeywords = forbidden.keywords
    const hostile = '\" data-alias-injected=\"true\"><img src=x onerror=alert(1)>'
    try {
      admitted.keywords = [...admittedKeywords, hostile]
      forbidden.keywords = [...forbiddenKeywords, 'admin-only-alias-marker']
      const html = renderWebApp({ surface: 'xpanel', visibility: owner, catalog: qualifiedCatalog })
      const parsed = new DOMParser().parseFromString(html, 'text/html')
      expect(parsed.querySelector('[data-cmdk-item="/domains"]')?.getAttribute('data-cmdk-search-text')).toContain(hostile)
      expect(parsed.querySelector('[data-alias-injected]')).toBeNull()
      expect(parsed.querySelector('img[src="x"]')).toBeNull()
      expect([...parsed.querySelectorAll('[data-cmdk-search-text]')].some(option => option.getAttribute('data-cmdk-search-text')!.includes('admin-only-alias-marker'))).toBe(false)
      expect(parsed.querySelector('[data-cmdk-item="/whm/accounts/new"]')).toBeNull()
    } finally {
      admitted.keywords = admittedKeywords
      forbidden.keywords = forbiddenKeywords
    }
  })

  it.each(['xpanel', 'xwhm', 'xmail'] as const)('includes every authorized %s page once, beyond the former section and global caps', surface => {
    const visibility = surface === 'xwhm' ? root : owner
    const expected = visibleNavigation(visibility, qualifiedCatalog).find(item => item.surface === surface)!.sections.flatMap(section => section.pages)
    const html = renderWebApp({ surface, visibility, catalog: qualifiedCatalog, locale: 'ar', theme: 'dark', density: 'compact', accountId: 'fixture-account' })
    const parsed = new DOMParser().parseFromString(html, 'text/html')
    const options = [...parsed.querySelectorAll<HTMLAnchorElement>('[data-cmdk-item]')]
    expect(options).toHaveLength(expected.length)
    expect(new Set(options.map(option => option.dataset.cmdkItem)).size).toBe(expected.length)
    if (surface !== 'xmail') expect(options.length).toBeGreaterThan(8)
    for (const page of expected) {
      const option = options.find(item => item.dataset.cmdkItem === page.route)!
      expect(option.textContent).toContain(getSurfaceNavigationLabel(surface, 'page', page, 'ar'))
      expect(option.getAttribute('href')).toContain('lang=ar&theme=dark&density=compact&accountId=fixture-account')
      expect(option.getAttribute('role')).toBe('option')
      expect(option.tabIndex).toBe(-1)
    }
    expect(parsed.querySelector('[data-cmdk-search]')?.getAttribute('placeholder')).toBe('ابحث عن صفحة')
    expect(parsed.querySelector('[data-cmdk-search]')?.getAttribute('aria-controls')).toBe('xp-cmdk-results')
  })

  it('never renders a palette or navigation options for an unqualified catalog', () => {
    const html = renderWebApp({ surface: 'xpanel', visibility: owner })
    const parsed = new DOMParser().parseFromString(html, 'text/html')
    expect(parsed.querySelector('[data-xp-cmdk]')).toBeNull()
    expect(parsed.querySelectorAll('[data-cmdk-item]')).toHaveLength(0)
    expect(parsed.querySelectorAll('[data-nav-route]').length).toBeGreaterThan(0)
  })

  it('limits the palette to the same reseller permissions as the sidebar', () => {
    const visibility: VisibilityContext = { principal: { kind: 'reseller', id: 'fixture-reseller', username: 'fixture' }, reseller: { acl: ['list-accounts'] } }
    const html = renderWebApp({ surface: 'xwhm', visibility, catalog: qualifiedCatalog })
    const parsed = new DOMParser().parseFromString(html, 'text/html')
    const sidebarRoutes = [...parsed.querySelectorAll('[data-xp-sidebar] [data-nav-route]')].map(link => link.getAttribute('data-nav-route'))
    const paletteRoutes = [...parsed.querySelectorAll('[data-cmdk-item]')].map(link => link.getAttribute('data-cmdk-item'))
    expect(sidebarRoutes).toContain('/whm')
    expect(sidebarRoutes).toContain('/whm/accounts')
    for (const route of ['/whm/software/php', '/whm/security/firewall', '/whm/server/upgrade', '/whm/accounts/new']) expect(sidebarRoutes).not.toContain(route)
    expect(paletteRoutes).not.toContain('/whm/security/firewall')
    expect(paletteRoutes).not.toContain('/whm/accounts/new')
  })
})
