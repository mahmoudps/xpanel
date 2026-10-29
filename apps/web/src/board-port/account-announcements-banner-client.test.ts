// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { renderAccountAnnouncementNotice, renderAccountAnnouncementsBanner } from './account-announcements-banner.ts'
import type { AccountAnnouncementNotice } from './account-announcements-banner.ts'
import { ACCOUNT_ANNOUNCEMENTS_CLIENT_BINDING, buildAccountAnnouncementNotice, readAccountAnnouncements } from './account-announcements-banner-client.ts'

const A = '77777777-7777-4777-8777-000000000001', B = '77777777-7777-4777-8777-000000000002'
const notice = (overrides: Partial<AccountAnnouncementNotice> = {}): AccountAnnouncementNotice => ({
  id: A, severity: 'warning', title: { en: 'Disk upgrade', ar: 'ترقية القرص' }, body: { en: 'Line one\nLine two', ar: 'نص' }, startsAt: null, endsAt: '2026-10-30T18:00:00.000Z', ...overrides,
})
type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const run = () => new Function('return ' + ACCOUNT_ANNOUNCEMENTS_CLIENT_BINDING)()()
const boot = (send?: Send, locale: 'en' | 'ar' = 'en', wrap = (html: string) => html) => {
  const banner = renderAccountAnnouncementsBanner({ locale, announcements: [] })
  // The home page renders its desktop and phone layouts side by side; both carry the banner.
  document.body.innerHTML = wrap(`<div data-layout="desk">${banner}</div><div data-layout="phone">${banner}</div>`)
  if (send) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
  document.documentElement.lang = locale
  run()
}
const roots = () => Array.from(document.querySelectorAll<HTMLElement>('[data-account-announcements]'))

beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })
afterEach(() => { document.body.innerHTML = '' })

describe('account announcements client parser', () => {
  it('accepts only the owner view shape and never an audience', () => {
    expect(readAccountAnnouncements({ announcements: [notice()] })).toEqual([notice()])
    for (const bad of [
      { announcements: [{ ...notice(), audience: { kind: 'all' } }] },
      { announcements: [notice({ severity: 'critical' as 'info' })] },
      { announcements: [notice({ id: 'x' })] },
      { announcements: [notice({ title: { en: 'x'.repeat(141), ar: 'x' } })] },
      { announcements: [notice({ endsAt: 'tomorrow' })] },
      { announcements: [notice(), notice()] },
      { announcements: {} },
      [],
    ]) expect(() => readAccountAnnouncements(bad), JSON.stringify(bad)).toThrow()
  })

  it('builds the same markup as the server renderer, in both languages', () => {
    for (const locale of ['en', 'ar'] as const) for (const value of [notice(), notice({ endsAt: null, severity: 'info' })]) {
      document.documentElement.lang = locale
      const holder = document.createElement('div')
      holder.innerHTML = renderAccountAnnouncementNotice(value, locale, true)
      expect(buildAccountAnnouncementNotice(value, locale, true).outerHTML).toBe(holder.firstElementChild!.outerHTML)
    }
    document.documentElement.lang = 'en'
    expect(buildAccountAnnouncementNotice(notice(), 'en', false).querySelector('button')).toBeNull()
  })
})

describe('account announcements client binding', () => {
  it('reads once for both layouts, shows notices as text and never uses markup injection', async () => {
    const hostile = notice({ id: B, severity: 'info', title: { en: '<img src=x onerror=alert(1)>', ar: 'x' }, body: { en: '<b>bold</b>', ar: 'x' }, endsAt: null })
    const send: Mock<Send> = vi.fn<Send>(async () => ({ announcements: [notice(), hostile] }))
    boot(send)
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('GET', '/api/account/announcements')
    for (const root of roots()) {
      expect(root.hidden).toBe(false)
      expect(root.dataset.state).toBe('read')
      expect(root.querySelectorAll('[data-account-announcement][role="status"]')).toHaveLength(2)
      expect(root.querySelector('img,b')).toBeNull()
      expect(root.querySelector(`[data-account-announcement="${B}"] .xp-account-announcement__title span:last-child`)!.textContent).toBe('<img src=x onerror=alert(1)>')
    }
    expect(ACCOUNT_ANNOUNCEMENTS_CLIENT_BINDING).not.toContain('innerHTML')
    expect(ACCOUNT_ANNOUNCEMENTS_CLIENT_BINDING).not.toContain('fetch(')
  })

  it('stays hidden when nothing is live or the read fails', async () => {
    boot(vi.fn<Send>(async () => ({ announcements: [] })))
    await flush()
    expect(roots().every(root => root.hidden && root.dataset.state === 'read')).toBe(true)
    boot(vi.fn<Send>(async () => { throw Object.assign(new Error('down'), { status: 503 }) }))
    await flush()
    expect(roots().every(root => root.hidden && root.dataset.state === 'failed')).toBe(true)
    boot(vi.fn<Send>(async () => ({ announcements: [{ ...notice(), audience: { kind: 'all' } }] })))
    await flush()
    expect(roots().every(root => root.hidden && root.dataset.state === 'failed')).toBe(true)
  })

  it('dismisses through the API, removes the notice from both layouts and keeps focus in the banner', async () => {
    const send: Mock<Send> = vi.fn<Send>(async (method) => method === 'GET' ? { announcements: [notice(), notice({ id: B })] } : { dismissed: A, announcements: [notice({ id: B })] })
    boot(send)
    await flush()
    const button = roots()[0]!.querySelector<HTMLButtonElement>(`[data-account-announcement-dismiss="${A}"]`)!
    button.focus(); button.click(); await flush()
    expect(send).toHaveBeenLastCalledWith('POST', `/api/account/announcements/${A}/dismiss`)
    for (const root of roots()) expect(Array.from(root.querySelectorAll<HTMLElement>('[data-account-announcement]')).map(node => node.dataset.accountAnnouncement)).toEqual([B])
    expect(document.activeElement).toBe(roots()[0]!.querySelector(`[data-account-announcement-dismiss="${B}"]`))
  })

  it('keeps the notice and explains a failed dismissal, in Arabic too', async () => {
    const send: Mock<Send> = vi.fn<Send>(async (method) => { if (method === 'GET') return { announcements: [notice()] }; throw new Error('down') })
    boot(send, 'ar')
    await flush()
    const root = roots()[1]!
    root.querySelector<HTMLButtonElement>('[data-account-announcement-dismiss]')!.click(); await flush()
    expect(root.querySelectorAll('[data-account-announcement]')).toHaveLength(1)
    const status = root.querySelector<HTMLElement>('[data-account-announcements-status]')!
    expect(status.hidden).toBe(false)
    expect(status.getAttribute('role')).toBe('alert')
    expect(status.textContent).toBe('تعذّر إخفاء الإعلان. لا يزال معروضًا؛ حاول مجددًا.')
    expect(root.querySelector<HTMLButtonElement>('[data-account-announcement-dismiss]')!.disabled).toBe(false)
    expect(root.querySelector('.xp-account-announcement__severity')!.textContent).toBe('تحذير')
    expect(root.querySelector('[data-account-announcement-dismiss]')!.getAttribute('aria-label')).toBe('إخفاء الإعلان: ترقية القرص')
  })

  it('sends nothing without a transport or inside an unavailable context, and binds once', async () => {
    boot(undefined)
    await flush()
    const send = vi.fn<Send>(async () => ({ announcements: [notice()] }))
    boot(send, 'en', html => `<div data-capability-state="unavailable">${html}</div>`)
    await flush()
    expect(send).not.toHaveBeenCalled()
    expect(roots().every(root => root.hidden)).toBe(true)
    boot(send)
    await flush()
    run()
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('complete browser announcement timestamps', () => {
  it.each(['en', 'ar'] as const)('preserves the exact API end instant in both layouts in %s', async locale => {
    const endsAt = '2026-10-30T18:19:20.345Z', send = vi.fn<Send>(async () => ({ announcements: [notice({ endsAt })] }))
    boot(send, locale); await flush()
    expect(roots()).toHaveLength(2)
    for (const root of roots()) {
      const timestamp = root.querySelector('.xp-account-announcement__text .xp-help bdi')!
      expect(timestamp.textContent).toBe('2026-10-30 18:19 UTC')
      expect(timestamp.getAttribute('dir')).toBe('ltr')
    }
    expect(send.mock.calls).toEqual([['GET', '/api/account/announcements']])
  })
})
