import { describe, expect, it } from 'vitest'
import { renderWhmMailServerWorkspace } from './whm-mail-server-workspace.ts'

describe('WHM mail server workspace renderer', () => {
  it('renders the English server page with sources, settings and services tables and the drift workflow links', () => {
    const html = renderWhmMailServerWorkspace({ locale: 'en', page: 'server', canRead: true })
    expect(html).toContain('dir="ltr"')
    expect(html).toContain('data-mail-server-page="server"')
    expect(html).toContain('data-mail-server-can-read="true"')
    for (const key of ['postfix', 'master', 'dovecot', 'desired', 'observed-at']) expect(html).toContain(`data-whm-mail-server-fact="${key}"`)
    expect(html).toContain('data-whm-mail-server-settings'); expect(html).toContain('data-whm-mail-server-services'); expect(html).not.toContain('data-whm-mail-server-domains')
    expect(html).toContain('href="/whm/monitoring/repair"'); expect(html).toContain('href="/whm/panel/data"')
    expect(html).toContain('not editable from this panel yet')
    expect(html).toContain('<bdi dir="ltr">doveconf -h</bdi>')
    expect(html).toMatch(/@media\(min-width:601px\)\{\.xp-whm-mail-server__card\{padding:24px\}\}/)
    expect(html).not.toMatch(/<form|<input|<select|<textarea/)
    expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
  it('renders routing with a domain table and outbound with limits and submission services', () => {
    const routing = renderWhmMailServerWorkspace({ locale: 'en', page: 'routing', canRead: true })
    expect(routing).toContain('data-whm-mail-server-domains'); expect(routing).not.toContain('data-whm-mail-server-services'); expect(routing).not.toContain('data-whm-mail-server-fact="master"')
    expect(routing).toContain('not from live DNS lookups'); expect(routing).toContain('data-whm-mail-server-truncated hidden')
    const outbound = renderWhmMailServerWorkspace({ locale: 'en', page: 'outbound', canRead: true })
    expect(outbound).toContain('Rate and size limits'); expect(outbound).toContain('Submission services'); expect(outbound).toContain('uses the Postfix default')
    expect(outbound).not.toContain('data-whm-mail-server-fact="dovecot"')
    for (const page of ['server', 'routing', 'outbound'] as const) {
      const ids = [...renderWhmMailServerWorkspace({ locale: 'en', page, canRead: true }).matchAll(/ id="([^"]+)"/g)].map(match => match[1]!)
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids.every(id => id.startsWith(`whm-mail-server-${page}-`))).toBe(true)
    }
  })
  it('renders Arabic RTL copy with technical values isolated left-to-right', () => {
    const html = renderWhmMailServerWorkspace({ locale: 'ar', page: 'routing', canRead: true })
    expect(html).toContain('dir="rtl"'); expect(html).toContain('lang="ar"')
    expect(html).toContain('مصادر الإعدادات'); expect(html).toContain('نطاقات البريد المستضافة'); expect(html).toContain('مركز الإصلاح')
    expect(html).toContain('<bdi dir="ltr" data-whm-mail-server-fact="observed-at">')
    expect(html).toContain('<bdi dir="ltr">postconf -n</bdi>')
    expect(html).not.toMatch(/Configuration sources|Hosted mail domains|Repair center/)
    expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
  it('keeps the layout but disables the only control without read authority', () => {
    const html = renderWhmMailServerWorkspace({ locale: 'en', page: 'outbound', canRead: false })
    expect(html).toContain('data-mail-server-can-read="false"')
    expect(html).toContain('data-whm-mail-server-refresh disabled')
    expect(html).toContain('data-whm-mail-server-services')
    expect(html).not.toMatch(/<form|<input|<select|<textarea/)
  })
})
