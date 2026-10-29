// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderSecWorkspace } from './sec-workspace.ts'
import type { SecPage } from './sec-workspace.ts'

const pages: SecPage[] = ['waf', 'flood', 'panel-access', 'dns-providers', 'dns-cluster', 'account-waf', 'account-cloudflare']
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html')

describe('sec workspace renderer', () => {
  it.each(pages)('renders %s with every control disabled until an authorized read, in both directions', page => {
    for (const locale of ['en', 'ar'] as const) {
      const doc = parse(renderSecWorkspace({ page, locale, canRead: true, canManage: true }))
      const root = doc.querySelector<HTMLElement>('[data-sec-workspace]')!
      expect(root.dataset.secPage).toBe(page)
      expect(root.getAttribute('dir')).toBe(locale === 'ar' ? 'rtl' : 'ltr')
      expect([...doc.querySelectorAll<HTMLInputElement>('[data-sec-input]')].every(control => control.disabled)).toBe(true)
      expect([...doc.querySelectorAll('[data-sec-field]')].every(node => node.tagName === 'BDI' && node.getAttribute('dir') === 'ltr' || node.classList.contains('xp-sec__pill'))).toBe(true)
      expect([...doc.querySelectorAll('table')].every(table => table.closest('[role="region"][tabindex="0"]') && table.querySelector('th[scope="col"]'))).toBe(true)
      expect([...doc.querySelectorAll('[data-sec-input]')].every(control => doc.querySelector(`label[for="${control.id}"]`))).toBe(true)
      expect(doc.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
    }
  })
  it('keeps the approved WAF and ModSecurity components and states that nothing was read without authority', () => {
    const doc = parse(renderSecWorkspace({ page: 'waf', locale: 'en', canRead: false, canManage: false }))
    expect(doc.querySelector('[data-sec-status]')!.getAttribute('data-state')).toBe('unavailable')
    for (const key of ['rate', 'burst', 'rate-unlimited', 'body', 'body-unlimited', 'denied', 'deny-ips', 'deny-paths', 'deny-agents', 'modsecurity']) expect(doc.querySelector(`[data-sec-input="${key}"]`)).not.toBeNull()
    expect(doc.querySelector('[data-sec-field="modsec-state"]')).not.toBeNull()
    expect(doc.querySelector('a[href^="/whm/software/catalog"]')).not.toBeNull()
    expect(doc.body.textContent).toContain('Changes require root authorization.')
  })
})
