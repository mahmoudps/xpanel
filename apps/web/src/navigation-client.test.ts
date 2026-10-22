/// <reference lib="dom" />
// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://panel.example.test/panel?lang=ar&theme=light&accountId=account-test"}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_REALTIME_SCRIPT } from './ws-client.ts'

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

beforeEach(() => {
  document.body.innerHTML = fixture
  document.body.style.overflow = 'clip'
  document.documentElement.style.overflow = 'scroll'
  originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
  viewport(390)
  socket = vi.fn(function WebSocketMock() {})
  vi.stubGlobal('WebSocket', socket)
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))

  // jsdom has no layout engine; browser acceptance measures geometry separately.
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
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
  document.body.innerHTML = ''
  document.body.style.overflow = ''
  document.documentElement.style.overflow = ''
  delete document.documentElement.dataset.realtimeEnabled
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

  it('starts real-time transport only when the document enables it', () => {
    bootClient('true')
    expect(socket).toHaveBeenCalledOnce()
    expect(socket).toHaveBeenCalledWith('wss://panel.example.test/api/ws')
  })
})
