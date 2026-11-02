import { describe, expect, it } from 'vitest'
import { parseMarkup } from '../themes/markup.ts'
import { renderWhmServiceManagerWorkspace } from './whm-service-manager-workspace.ts'

describe('service manager workspace', () => {
  it('preserves service, boot, restart and unsupported capability sections in both languages', () => {
    for (const locale of ['en', 'ar'] as const) {
      const html = renderWhmServiceManagerWorkspace({ locale, canRead: true, canManage: true })
      expect(html).toContain(`lang="${locale}" dir="${locale === 'ar' ? 'rtl' : 'ltr'}"`)
      for (const marker of ['data-sm-rows', 'data-sm-search', 'data-sm-filter', 'data-sm-refresh', 'data-sm-confirm', 'data-sm-reboot', 'data-sm-job-link']) expect(html).toContain(marker)
      for (const fact of ['services', 'active', 'boot-time', 'observed-at']) expect(html).toContain(`<bdi dir="ltr" data-sm-fact="${fact}">`)
      expect(html).toContain('<bdi dir="ltr">REBOOT SERVER</bdi>')
      expect(html).toContain('PostgreSQL'); expect(html).toContain('Supervisor')
      expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
      expect(html).toContain('gap:32px'); expect(html).toContain('gap:24px'); expect(html).toContain('gap:16px'); expect(html).toContain('gap:8px')
      expect(html).toContain('@media(min-width:601px){.xp-whm-service-manager__panel{padding:24px}}')
      expect(html).not.toContain('<form')
    }
  })
  it('contains no synthetic states and fences native controls beside finite local area filters', () => {
    const html = renderWhmServiceManagerWorkspace({ locale: 'en', canRead: false, canManage: true })
    expect(html).toContain('data-sm-can-read="false" data-sm-can-manage="false"')
    expect(html).toContain('Service state has not been read.')
    expect(html).toContain('This does not indicate whether the software is installed.')
    expect(html).not.toMatch(/\d+ (?:services|running)|2026-/)
    const live = parseMarkup(html).filter(node => node.template < 0 && node.namespace === 'html')
    expect(live.filter(node => node.attrs.has('data-whm-service-manager'))).toHaveLength(1)
    expect(live.filter(node => node.tag === 'form')).toHaveLength(0)
    const areas = live.filter(node => node.attrs.has('data-sm-area'))
    expect(areas.map(node => node.attrs.get('data-sm-area'))).toEqual(['', 'web', 'mail', 'data', 'access', 'unread'])
    for (const area of areas) {
      expect(area.tag).toBe('button'); expect(area.attrs.get('type')).toBe('button')
      expect(area.attrs.has('disabled')).toBe(false)
      expect(area.attrs.get('aria-pressed')).toBe(String(area.attrs.get('data-sm-area') === ''))
      for (const action of ['name', 'form', 'formaction', 'onclick', 'data-sm-action', 'data-sm-reboot', 'data-sm-refresh', 'data-action', 'data-xp-action', 'data-api-url', 'api-url']) expect(area.attrs.has(action)).toBe(false)
    }
    const presentation = new Set(areas)
    for (const control of live.filter(node => ['input', 'select', 'textarea', 'button'].includes(node.tag))) {
      if (!presentation.has(control)) expect(control.attrs.has('disabled'), JSON.stringify([...control.attrs])).toBe(true)
    }
  })
})
