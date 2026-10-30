/// <reference lib="dom" />
// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://panel.example.test/panel/missing"}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MOBILE_NAVIGATION_CLIENT_SCRIPT } from './mobile-navigation-client.ts'

type Listener = [string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined]
let documentListeners: Listener[]
let windowListeners: Listener[]
let originalWidth: PropertyDescriptor | undefined

const fixture = (theme: 'classic' | 'v2' = 'v2') => `
<div class="${theme === 'classic' ? 'xp-shell' : 'v2-shell'}">
  <nav id="xp-sidebar" data-xp-sidebar tabindex="-1" aria-label="Navigation">
    <button data-action="close-mobile-nav">Close navigation</button>
    <a id="current-link" href="/panel" data-nav-route="/home" aria-current="page">Home</a>
    <a id="last-link" href="/panel/files/manager" data-nav-route="/files/manager">Files</a>
  </nav>
  <button data-xp-nav-backdrop data-action="close-mobile-nav" hidden tabindex="-1">Close navigation</button>
  <div data-xp-shell-content>
    <button id="nav-toggle" data-action="toggle-mobile-nav" aria-controls="xp-sidebar" aria-expanded="false">Navigation</button>
    <details data-xp-toolbar-options open><summary>Account</summary><button id="account-control">Account action</button></details>
    <main id="main-content" tabindex="-1"><h1>Page not found</h1></main>
  </div>
</div>
<footer id="already-inert" inert="">Existing unavailable content</footer>`

function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector)
  if (!node) throw new Error(`Missing navigation fixture: ${selector}`)
  return node
}

function shell(): HTMLElement { return element('[data-xp-sidebar]').parentElement! }
function boot(): void { new Function('window', 'document', MOBILE_NAVIGATION_CLIENT_SCRIPT)(window, document) }
function viewport(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  window.dispatchEvent(new Event('resize'))
}
function press(key: string, options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
  ;(document.activeElement ?? document).dispatchEvent(event)
  return event
}

beforeEach(() => {
  document.body.innerHTML = fixture()
  document.documentElement.setAttribute('data-status', '404')
  document.body.style.overflow = 'clip'
  document.documentElement.style.overflow = 'scroll'
  originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
  viewport(390)
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
  vi.stubGlobal('WebSocket', vi.fn())
  vi.stubGlobal('fetch', vi.fn())
  // jsdom has no layout engine. These tests exercise the controller only.
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    if (window.innerWidth >= 960 && this.matches('[data-action="toggle-mobile-nav"], [data-action="close-mobile-nav"], details[data-xp-toolbar-options] > summary')) return [] as unknown as DOMRectList
    if (window.innerWidth < 960 && this.closest('[data-xp-sidebar]') && shell().dataset.mobileNav !== 'open') return [] as unknown as DOMRectList
    const details = this.closest('details:not([open])')
    if (details && !details.querySelector(':scope > summary')?.contains(this)) return [] as unknown as DOMRectList
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
  document.documentElement.removeAttribute('data-status')
})

describe('status document mobile navigation', () => {
  it.each(['classic', 'v2'] as const)('opens and restores the %s shell without realtime or business calls', theme => {
    document.body.innerHTML = fixture(theme)
    boot()
    const trigger = element<HTMLButtonElement>('#nav-toggle')
    trigger.focus()
    trigger.click()
    expect(shell().dataset.mobileNav).toBe('open')
    expect(element('[data-xp-nav-backdrop]').hidden).toBe(false)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(element('[data-xp-sidebar]').getAttribute('role')).toBe('dialog')
    expect(element('[data-xp-sidebar]').getAttribute('aria-modal')).toBe('true')
    expect(element('[data-xp-shell-content]').hasAttribute('inert')).toBe(true)
    expect(document.activeElement).toBe(element('#current-link'))
    expect(document.body.style.overflow).toBe('hidden')
    expect(document.documentElement.style.overflow).toBe('hidden')
    expect(press('Escape').defaultPrevented).toBe(true)
    expect(shell().dataset.mobileNav).toBeUndefined()
    expect(element('[data-xp-nav-backdrop]').hidden).toBe(true)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(element('[data-xp-sidebar]').hasAttribute('role')).toBe(false)
    expect(element('[data-xp-sidebar]').hasAttribute('aria-modal')).toBe(false)
    expect(element('[data-xp-shell-content]').hasAttribute('inert')).toBe(false)
    expect(element('#already-inert').hasAttribute('inert')).toBe(true)
    expect(document.body.style.overflow).toBe('clip')
    expect(document.documentElement.style.overflow).toBe('scroll')
    expect(document.activeElement).toBe(trigger)
    expect(WebSocket).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['[data-xp-nav-backdrop]', '[data-xp-sidebar] [data-action="close-mobile-nav"]'])('closes through %s', selector => {
    boot()
    element('#nav-toggle').click()
    element(selector).click()
    expect(shell().dataset.mobileNav).toBeUndefined()
    expect(document.activeElement).toBe(element('#nav-toggle'))
  })

  it('traps Tab at both edges and prevents focus from leaving the active navigation', () => {
    boot()
    element('#nav-toggle').click()
    element('#last-link').focus()
    expect(press('Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(element('[data-xp-sidebar] button'))
    expect(press('Tab', { shiftKey: true }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(element('#last-link'))
    element('#account-control').focus()
    expect(document.activeElement).toBe(element('#current-link'))
  })

  it('does not close during composed keyboard input', () => {
    boot()
    element('#nav-toggle').click()
    expect(press('Escape', { isComposing: true }).defaultPrevented).toBe(false)
    expect(shell().dataset.mobileNav).toBe('open')
  })

  it('releases mobile state at the desktop boundary and restores visible focus', () => {
    boot()
    element('#nav-toggle').click()
    element('[data-xp-sidebar] button').focus()
    viewport(960)
    expect(shell().dataset.mobileNav).toBeUndefined()
    expect(element('[data-xp-sidebar]').hasAttribute('aria-modal')).toBe(false)
    expect(document.activeElement).toBe(element('#current-link'))
    expect(document.body.style.overflow).toBe('clip')
    expect(element<HTMLDetailsElement>('[data-xp-toolbar-options]').open).toBe(true)
  })

  it('keeps a visible navigation link focused when resizing to desktop', () => {
    boot()
    element('#nav-toggle').click()
    element('#last-link').focus()
    viewport(960)
    expect(document.activeElement).toBe(element('#last-link'))
    expect(shell().dataset.mobileNav).toBeUndefined()
  })

  it('closes synchronously when an actual navigation link is followed', () => {
    boot()
    element('#nav-toggle').click()
    const link = element<HTMLAnchorElement>('#last-link')
    link.addEventListener('click', event => event.preventDefault()) // Keep jsdom on this document.
    link.click()
    expect(shell().dataset.mobileNav).toBeUndefined()
    expect(element('[data-xp-shell-content]').hasAttribute('inert')).toBe(false)
  })

  it('closes a focused mobile toolbar with Escape on a status document', () => {
    boot()
    const toolbar = element<HTMLDetailsElement>('[data-xp-toolbar-options]')
    toolbar.open = true
    element('#account-control').focus()
    expect(press('Escape').defaultPrevented).toBe(true)
    expect(toolbar.open).toBe(false)
    expect(document.activeElement).toBe(element('[data-xp-toolbar-options] > summary'))
  })

  it('mounts only once when the standalone script is evaluated twice', () => {
    boot()
    const listenerCount = documentListeners.length + windowListeners.length
    boot()
    expect(documentListeners.length + windowListeners.length).toBe(listenerCount)
    element('#nav-toggle').click()
    expect(shell().dataset.mobileNav).toBe('open')
    element('#nav-toggle').click()
    expect(shell().dataset.mobileNav).toBeUndefined()
  })

  it('leaves an ordinary document to its existing realtime navigation owner', () => {
    document.documentElement.removeAttribute('data-status')
    boot()
    expect(documentListeners).toHaveLength(0)
    expect(windowListeners).toHaveLength(0)
    element('#nav-toggle').click()
    expect(shell().dataset.mobileNav).toBeUndefined()
  })

  it('does not mount on a standalone status card without a sidebar', () => {
    document.body.innerHTML = '<main id="main-content"><h1>Page not found</h1></main>'
    boot()
    expect(documentListeners).toHaveLength(0)
    expect(windowListeners).toHaveLength(0)
  })
})
