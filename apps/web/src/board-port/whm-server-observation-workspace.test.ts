// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderWhmServerNetwork, renderWhmServerRole, renderWhmServerTimers } from './whm-server-observation-workspace.ts'

const pages = (locale: 'en' | 'ar', canRead: boolean) => [
  ['timers', renderWhmServerTimers({ locale, canRead })],
  ['network', renderWhmServerNetwork({ locale, canRead })],
  ['role', renderWhmServerRole({ locale, canRead })],
] as const

describe('WHM server observation renderers', () => {
  it.each(['en', 'ar'] as const)('render labelled, localized and unread read-only workspaces in %s', locale => {
    for (const [kind, html] of pages(locale, true)) {
      document.body.innerHTML = html
      const root = document.querySelector<HTMLElement>('[data-whm-server-observation]')!
      expect([root.dataset.whmServerObservation, root.getAttribute('dir'), root.getAttribute('lang'), root.dataset.serverObservationCanRead]).toEqual([kind, locale === 'ar' ? 'rtl' : 'ltr', locale, 'true'])
      expect(html).not.toMatch(/[٠-٩۰-۹]/)
      expect(document.querySelector('h1, form')).toBeNull()
      expect(document.querySelector('[data-whm-server-observation-status]')!.getAttribute('data-state')).toBe('unread')
      expect(document.querySelector<HTMLButtonElement>('[data-whm-server-observation-refresh]')!.disabled).toBe(false)
      for (const control of document.querySelectorAll<HTMLElement>('input,select')) expect(document.querySelector('label[for="' + control.id + '"]')).not.toBeNull()
      for (const table of document.querySelectorAll('table')) expect(table.querySelector('caption')).not.toBeNull()
      expect(document.querySelectorAll('bdi[dir="ltr"][data-whm-server-observation-observed-at]').length).toBe(1)
      if (locale === 'ar') expect(document.body.textContent).toMatch(/[؀-ۿ]/)
      else expect(document.body.textContent).not.toMatch(/[؀-ۿ]/)
    }
  })
  it('states read-only scope truthfully and offers no host action', () => {
    document.body.innerHTML = pages('en', true).map(([, html]) => html).join('')
    const text = document.body.textContent ?? ''
    expect(text).toContain('Running, creating or changing system timers is not available here.')
    expect(text).toContain('Changing the server role is not available.')
    expect(text).toContain('File contents are never read.')
    expect(document.querySelector<HTMLAnchorElement>('[data-whm-server-observation-accounts]')!.getAttribute('href')).toBe('/whm/accounts')
    expect([...document.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Read timers', 'Read network', 'Read role'])
    expect([...document.querySelectorAll<HTMLOptionElement>('[data-whm-server-observation-owner] option')].map(option => option.value)).toEqual(['', 'system', 'panel', 'account-cron'])
  })
  it.each(['en', 'ar'] as const)('renders every control disabled and no form in unavailable mode (%s)', locale => {
    for (const [, html] of pages(locale, false)) {
      document.body.innerHTML = html
      expect(document.querySelector<HTMLElement>('[data-whm-server-observation]')!.dataset.serverObservationCanRead).toBe('false')
      expect(document.querySelector('form')).toBeNull()
      for (const control of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input,select,textarea,button')) expect(control.disabled).toBe(true)
    }
  })
})
