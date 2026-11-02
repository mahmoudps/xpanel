/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_DETAILS_CLIENT_BINDING } from './account-details-client.ts'

let dispose: (() => void) | undefined
const request = vi.fn()
beforeEach(() => { vi.stubGlobal('fetch', request); request.mockClear() })
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
  document.documentElement.lang = 'en'
  document.documentElement.dir = 'ltr'
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function fixture(locale: 'en' | 'ar' = 'en'): void {
  document.documentElement.lang = locale
  document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  const rows = ['alice', 'bob'].map(name => '<tr data-account-row="' + name + '"><td><button type="button" data-account-detail-open="' + name + '" aria-controls="account-details" aria-expanded="false">' + name + '</button><button type="button" data-action="terminate-account" disabled>Delete</button></td></tr>').join('')
  const panels = ['alice', 'bob'].map(name => '<section data-account-detail-for="' + name + '" hidden><form><label>' + name + '<input name="contactEmail" value="' + name + '@example.test"></label><button type="submit" disabled>Save</button></form><bdi dir="ltr">2.00 MB/s</bdi></section>').join('')
  document.body.innerHTML = '<div data-accounts-workspace data-account-detail-workspace="/whm/accounts" tabindex="-1"><input data-list-search-input><table><tbody>' + rows + '</tbody></table><aside id="account-details" data-account-detail-panel hidden><button type="button" data-account-detail-close>Close</button>' + panels + '</aside></div>'
}
const boot = (): void => { dispose = new Function('return ' + ACCOUNT_DETAILS_CLIENT_BINDING)() as () => void }
const opener = (name = 'alice') => document.querySelector<HTMLButtonElement>('[data-account-detail-open="' + name + '"]')!
const aside = () => document.querySelector<HTMLElement>('[data-account-detail-panel]')!
const panel = (name = 'alice') => document.querySelector<HTMLElement>('[data-account-detail-for="' + name + '"]')!
const close = () => document.querySelector<HTMLButtonElement>('[data-account-detail-close]')!
const observed = async (): Promise<void> => { await new Promise<void>(resolve => queueMicrotask(resolve)) }

describe('serialized account detail presentation', () => {
  it.each(['en', 'ar'] as const)('opens, switches and closes one %s account panel while preserving real form nodes and values', locale => {
    fixture(locale)
    const aliceForm = panel().querySelector('form')!
    const email = aliceForm.querySelector<HTMLInputElement>('input')!
    email.value = 'edited@example.test'
    boot()
    expect(aside().hidden).toBe(true)
    opener().click()
    expect(aside().hidden).toBe(false)
    expect(panel().hidden).toBe(false)
    expect(panel('bob').hidden).toBe(true)
    expect(opener().getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(close())
    opener('bob').click()
    expect(panel().hidden).toBe(true)
    expect(panel('bob').hidden).toBe(false)
    expect(opener().getAttribute('aria-expanded')).toBe('false')
    opener().click()
    expect(panel().querySelector('form')).toBe(aliceForm)
    expect(email.value).toBe('edited@example.test')
    expect(aliceForm.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('[data-action]')!.disabled).toBe(true)
    close().click()
    expect(aside().hidden).toBe(true)
    expect(panel().hidden).toBe(true)
    expect(document.activeElement).toBe(opener())
    expect(request).not.toHaveBeenCalled()
  })

  it('closes on Escape from the selected panel and leaves ordinary Tab navigation untrapped', () => {
    fixture(); boot(); opener().click()
    const input = panel().querySelector<HTMLInputElement>('input')!
    input.focus()
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    input.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(false)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(aside().hidden).toBe(true)
    expect(document.activeElement).toBe(opener())
    expect(request).not.toHaveBeenCalled()
  })

  it('honors an already handled Escape and input composition', () => {
    fixture(); boot(); opener().click()
    const input = panel().querySelector<HTMLInputElement>('input')!
    const handled = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    handled.preventDefault(); input.dispatchEvent(handled)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true }))
    expect(aside().hidden).toBe(false)
  })

  it('closes a selected account filtered out through row.hidden and returns focus to its list search', async () => {
    fixture(); boot(); opener().click()
    opener().closest<HTMLElement>('[data-account-row]')!.hidden = true
    await observed()
    expect(aside().hidden).toBe(true)
    expect(document.activeElement).toBe(document.querySelector('[data-list-search-input]'))
    expect(opener().getAttribute('aria-expanded')).toBe('false')
    expect(request).not.toHaveBeenCalled()
  })

  it('preserves filter-control focus and closes when the selected row is removed', async () => {
    fixture(); boot(); opener().click()
    const search = document.querySelector<HTMLInputElement>('[data-list-search-input]')!
    search.focus()
    opener().closest('[data-account-row]')!.remove()
    await observed()
    expect(aside().hidden).toBe(true)
    expect(document.activeElement).toBe(search)
    expect(request).not.toHaveBeenCalled()
  })

  it.each(['missing-aside', 'duplicate-aside', 'duplicate-root', 'duplicate-panel', 'wrong-opener-tag', 'mismatched-row', 'native-action-opener'] as const)('fails closed for %s', fault => {
    fixture()
    if (fault === 'missing-aside') aside().remove()
    if (fault === 'duplicate-aside') aside().after(aside().cloneNode(true))
    if (fault === 'duplicate-root') document.body.append(document.querySelector('[data-account-detail-workspace]')!.cloneNode(true))
    if (fault === 'duplicate-panel') panel().after(panel().cloneNode(true))
    if (fault === 'wrong-opener-tag') { const div = document.createElement('div'); for (const attr of opener().attributes) div.setAttribute(attr.name, attr.value); div.textContent = 'alice'; opener().replaceWith(div) }
    if (fault === 'mismatched-row') opener().closest('[data-account-row]')!.setAttribute('data-account-row', 'foreign')
    if (fault === 'native-action-opener') opener().setAttribute('data-action', 'terminate-account')
    boot()
    document.querySelector<HTMLElement>('[data-account-detail-open]')!.click()
    expect([...document.querySelectorAll<HTMLElement>('[data-account-detail-panel], [data-account-detail-for]')].every(node => node.hidden)).toBe(true)
    expect(request).not.toHaveBeenCalled()
  })

  it('rejects renamed or duplicated account targets after binding', () => {
    fixture(); boot()
    opener().setAttribute('data-account-detail-open', 'unowned')
    opener('unowned').click()
    expect(aside().hidden).toBe(true)
    opener('unowned').setAttribute('data-account-detail-open', 'alice')
    panel().after(panel().cloneNode(true))
    opener().click()
    expect(aside().hidden).toBe(true)
    expect(request).not.toHaveBeenCalled()
  })

  it('fails closed if its finite close control is removed after binding', async () => {
    fixture(); boot(); opener().click()
    close().remove()
    await observed()
    expect(aside().hidden).toBe(true)
    opener().click()
    expect(aside().hidden).toBe(true)
    expect(request).not.toHaveBeenCalled()
  })

  it('binds once and disconnects finite observers/listeners on disposal and normal page exit', () => {
    fixture()
    const disconnected = vi.spyOn(MutationObserver.prototype, 'disconnect')
    boot()
    const second = new Function('return ' + ACCOUNT_DETAILS_CLIENT_BINDING)() as () => void
    second()
    const focus = vi.spyOn(close(), 'focus')
    opener().click()
    expect(focus).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }))
    expect(disconnected).toHaveBeenCalledTimes(1)
    expect(aside().hidden).toBe(true)
    opener().click()
    expect(aside().hidden).toBe(true)
    dispose?.()
    expect(disconnected).toHaveBeenCalledTimes(1)
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps the binding usable across a persisted back/forward cache transition', () => {
    fixture(); boot()
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    opener().click()
    expect(aside().hidden).toBe(false)
  })
})
