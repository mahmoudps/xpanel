import { describe, expect, it } from 'vitest'
import { renderWhmDnsToolsWorkspace } from './whm-dns-tools-workspace.ts'

const controls = (html: string) => [...html.matchAll(/<(input|select|textarea|button)\b[^>]*>/g)].map(match => match[0])

describe('WHM DNS tools renderer', () => {
  it('renders the four English tools with tables, actions and the local-only scope note', () => {
    const html = renderWhmDnsToolsWorkspace({ locale: 'en', canRead: true, canManage: true })
    for (const key of ['jobs', 'results', 'compare', 'nameservers', 'zones', 'preview', 'applied']) expect(html).toContain(`data-whm-dns-tools-rows="${key}"`)
    for (const action of ['check', 'preview', 'apply']) expect(html).toMatch(new RegExp(`data-whm-dns-tools-run="${action}" disabled`))
    for (const load of ['jobs', 'compare', 'nameservers']) expect(html).toContain(`data-whm-dns-tools-load="${load}" disabled`)
    for (const key of ['compare', 'nameservers']) expect(html).toContain(`data-whm-dns-tools-page="${key}" data-direction="next" disabled`)
    expect(html).toContain('min="0" max="2147483647"')
    expect(html).toContain('href="/whm/dns?lang=en"'); expect(html).toContain('href="/whm/jobs?lang=en"')
    expect(html).toContain('Public recursion and other name servers are never queried.')
    expect(html).toContain('public recursion is out of scope')
    expect(html).toContain('read-only host jobs of up to 32 zones each')
    expect(html).toContain('data-dns-tools-can-manage="true"')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('Checks and changes require root authorization.')
    expect(html).toMatch(/@media\(min-width:601px\)\{\.xp-whm-dns-tools__card\{padding:24px\}\}/)
    for (const gap of ['gap:8px', 'gap:16px', 'gap:24px', 'gap:32px']) expect(html).toContain(gap)
  })
  it('renders Arabic RTL copy with ASCII digits and technical values isolated left-to-right', () => {
    const html = renderWhmDnsToolsWorkspace({ locale: 'ar', canRead: true, canManage: true })
    expect(html).toContain('dir="rtl"'); expect(html).toContain('lang="ar"')
    expect(html).toContain('<bdi dir="ltr" data-whm-dns-tools-fact="observed-at">غير مقروء</bdi>')
    expect(html).toContain('127.0.0.1'); expect(html).toContain('32')
    expect(html).toContain('type="number" dir="ltr"'); expect(html).toContain('type="search" dir="ltr" maxlength="253"')
    expect(html).toContain('href="/whm/dns?lang=ar"')
    expect(html).not.toMatch(/[٠-٩۰-۹]/)
    expect(html).not.toMatch(/Nothing has been read yet|Refresh<|Check all zones|Bulk TTL change|Previous page/)
  })
  it('keeps the layout inert without root read authority: every control disabled and no form', () => {
    for (const locale of ['en', 'ar'] as const) {
      const html = renderWhmDnsToolsWorkspace({ locale, canRead: false, canManage: true })
      expect(html).toContain('data-dns-tools-can-read="false"')
      expect(html).toContain('data-dns-tools-can-manage="false"')
      expect(html).toContain('data-state="unavailable"')
      expect(html).not.toContain('<form')
      const found = controls(html)
      expect(found.length).toBeGreaterThan(10)
      for (const control of found) expect(control).toMatch(/\sdisabled[\s>]/)
    }
    expect(renderWhmDnsToolsWorkspace({ locale: 'en', canRead: true, canManage: false })).toContain('Checks and changes require root authorization.')
  })
})
