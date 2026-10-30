import { describe, expect, it } from 'vitest'
import { parseMarkup, type MarkupNode } from '../../../../markup.ts'
import { renderV2WhmMailPage, WHM_MAIL_ROUTES, WHM_MAIL_CSS, type WhmMailPageInput } from './index.ts'

const readable: WhmMailPageInput = { mailAuthority: { canRead: true, canManage: true } }
const render = (route: string, overrides: WhmMailPageInput = {}): string => renderV2WhmMailPage({ ...readable, ...overrides, activeRoute: route })!
const nodes = (route: string, overrides: WhmMailPageInput = {}): MarkupNode[] => parseMarkup(render(route, overrides))
const node = (items: MarkupNode[], hook: string, value?: string): MarkupNode => {
  const found = items.find(item => item.attrs.has(hook) && (value === undefined || item.attrs.get(hook) === value))
  if (!found) throw new Error(`Missing ${hook}`)
  return found
}

describe('v2 xWHM mail documents', () => {
  it('dispatches only the 12 implemented mail documents', () => {
    expect(new Set(WHM_MAIL_ROUTES).size).toBe(12)
    for (const route of WHM_MAIL_ROUTES) {
      const html = render(route)
      expect(html).toContain(`data-whm-detail-route="${route}"`)
      expect(html.match(/<h1\b/g)).toHaveLength(1)
      expect(html).not.toMatch(/\bclass="[^"\n]*\bxp-|<style\b|<script\b/)
    }
    expect(renderV2WhmMailPage({ activeRoute: '/whm/jobs' })).toBeUndefined()
  })

  it('defaults all root-only reads and mutations to unavailable until core supplies authority', () => {
    for (const route of WHM_MAIL_ROUTES) {
      const html = render(route, { mailAuthority: undefined })
      expect(html).toContain('data-capability-state="unavailable"')
      expect(html).not.toMatch(/data-(?:mail-server|mail-queue|mailx|mailbox-maintenance)-can-manage="true"/)
      expect(parseMarkup(html).filter(item => ['input', 'select', 'textarea', 'button'].includes(item.tag)).every(item => item.attrs.has('disabled'))).toBe(true)
    }
  })

  it('keeps a host capability fence stronger than requested management authority', () => {
    const html = render('/whm/email/server', { capabilityUnavailable: true })
    expect(html).toContain('data-mail-server-can-read="false"')
    expect(html).toContain('data-mail-server-can-manage="false"')
    expect(html).not.toContain('data-whm-mail-settings novalidate')
  })

  it('retains exact server policy groups and preview-before-save hooks', () => {
    const items = nodes('/whm/email/server')
    expect(node(items, 'data-whm-mail-settings').tag).toBe('form')
    expect(node(items, 'data-whm-mail-settings-save').attrs.get('type')).toBe('submit')
    expect(node(items, 'data-whm-mail-settings-save').attrs.has('disabled')).toBe(true)
    for (const key of ['myhostname', 'mydomain', 'myorigin', 'smtpd_banner', 'inet_interfaces', 'inet_protocols', 'mynetworks', 'smtpd_helo_required',
      'smtpd_tls_protocols', 'smtpd_tls_mandatory_protocols', 'smtpd_tls_ciphers', 'smtpd_tls_mandatory_ciphers', 'smtpd_tls_exclude_ciphers', 'tls_preempt_cipherlist',
      'smtp_tls_security_level', 'smtp_tls_protocols', 'smtp_tls_mandatory_protocols', 'smtp_tls_ciphers', 'protocols', 'ssl_min_protocol', 'ssl_cipher_list', 'ssl_prefer_server_ciphers']) {
      expect(node(items, 'data-mail-setting', key).attrs.has('disabled'), key).toBe(true)
    }
    expect(node(items, 'data-mail-setting', 'protocols').attrs.get('data-mail-setting-source')).toBe('dovecot')
    expect(node(items, 'data-mail-rbl').tag).toBe('textarea')
    expect(items.filter(item => item.attrs.has('data-mail-certificate'))).toHaveLength(3)
    expect(node(items, 'data-whm-mail-settings-preview').attrs.has('hidden')).toBe(true)
    expect(node(items, 'data-whm-mail-server-changes').tag).toBe('tbody')
  })

  it('retains routing as domain observations and exposes no unrelated server settings', () => {
    const items = nodes('/whm/email/routing')
    expect(node(items, 'data-whm-mail-server-domains').tag).toBe('tbody')
    expect(node(items, 'data-whm-mail-server-truncated').attrs.has('hidden')).toBe(true)
    expect(items.some(item => item.attrs.has('data-mail-setting'))).toBe(false)
    expect(render('/whm/email/routing')).toContain('MX records come from the saved DNS zones')
  })

  it('renders saved outbound policy values as escaped values and refuses to invent unread ones', () => {
    const config = { mode: 'custom-map' as const, defaultIpv4: '192.0.2.77', defaultIpv6: null, defaultHelo: '<script>sender</script>',
      domainOverrides: [{ domainName: 'example.test', ipv4: '192.0.2.78', ipv6: null, heloHostname: 'mail.example.test' }] }
    const html = render('/whm/email/outbound', { mailIpConfig: config })
    expect(html).toContain('value="192.0.2.77"')
    expect(html).toContain('&lt;script&gt;sender&lt;/script&gt;')
    expect(html).not.toContain('<script>sender')
    expect(html).toContain('data-mail-ip-editable="true"')
    expect(html).toContain('example.test · 192.0.2.78 · mail.example.test')
    const untrusted = render('/whm/email/outbound', { mailAuthority: undefined, mailIpConfig: config })
    expect(untrusted).not.toContain('192.0.2.77')
    expect(untrusted).not.toContain('mail.example.test')
    expect(untrusted).toContain('data-mail-ip-editable="false"')
    expect(render('/whm/email/outbound')).toContain('data-mail-ip-editable="false"')
    const unread = parseMarkup(render('/whm/email/outbound'))
    const modeIndex = unread.findIndex(item => item.tag === 'select' && item.attrs.get('name') === 'mode')
    expect(unread.filter(item => item.parent === modeIndex && item.tag === 'option' && item.attrs.has('selected')).map(item => item.attrs.get('value'))).toEqual([''])
  })

  it('keeps relay credentials blank and preserves real protocol and port constraints', () => {
    const items = nodes('/whm/email/relay')
    const password = node(items, 'data-mailx-field', 'password')
    expect(password.attrs.get('type')).toBe('password')
    expect(password.attrs.get('autocomplete')).toBe('new-password')
    expect(password.attrs.has('value')).toBe(false)
    expect(Object.fromEntries(node(items, 'data-mailx-field', 'port').attrs)).toMatchObject({ min: '1', max: '65535', step: '1', disabled: '' })
    expect(render('/whm/email/relay')).toContain('Port 465 (implicit TLS) is not supported')
  })

  it('keeps read-only policies form-free without removing their fields', () => {
    const html = render('/whm/email/spam', { mailAuthority: { canRead: true, canManage: false } })
    expect(html).not.toMatch(/<form\b/)
    const items = parseMarkup(html)
    expect(node(items, 'data-mailx-field', 'enabled').attrs.has('disabled')).toBe(true)
    expect(node(items, 'data-mailx-field', 'countries').attrs.has('disabled')).toBe(true)
    expect(Object.fromEntries(node(items, 'data-mailx-field', 'rejectScore').attrs)).toMatchObject({ type: 'number', min: '0.5', max: '100', step: '0.5' })
  })

  it('does not present a bulk sending policy as a campaign sender', () => {
    const html = render('/whm/email/marketing')
    expect(html).toContain('xPanel does not send campaigns.')
    const items = parseMarkup(html)
    for (const key of ['messageRateLimit', 'recipientRateLimit', 'rateWindow', 'recipientsPerMessage', 'destinationConcurrency', 'destinationRateDelay']) {
      expect(node(items, 'data-mailx-field', key).tag).toBe('input')
    }
    expect(items.some(item => item.attrs.has('data-send-campaign'))).toBe(false)
  })

  it('retains bounded queue filters, selections, results and all mutation verbs', () => {
    const items = nodes('/whm/email/queue')
    expect(node(items, 'data-whm-mail-queue-rows').tag).toBe('tbody')
    expect(node(items, 'data-whm-mail-queue-filter', 'text').attrs.get('maxlength')).toBe('254')
    expect(items.filter(item => item.attrs.has('data-whm-mail-queue-count'))).toHaveLength(5)
    for (const operation of ['deliver', 'hold', 'release', 'delete']) expect(node(items, 'data-whm-mail-queue-bulk', operation).attrs.has('disabled')).toBe(true)
    expect(node(items, 'data-whm-mail-queue-bulk', 'delete').attrs.get('class')).toContain('v2-btn--danger')
    expect(node(items, 'data-whm-mail-queue-results').tag).toBe('ol')
    expect(render('/whm/email/queue')).toContain('No messages have been read.')
  })

  it('keeps delivery filters, keyset controls and the full recipient timeline panel', () => {
    const items = nodes('/whm/email/delivery')
    for (const field of ['status', 'sender', 'recipient', 'domain', 'dsn', 'since', 'until']) expect(node(items, 'name', field).attrs.has('disabled')).toBe(true)
    expect(node(items, 'data-mail-log-detail-recipients').tag).toBe('tbody')
    expect(node(items, 'data-mail-log-detail-events').tag).toBe('ol')
    expect(items.filter(item => item.attrs.has('data-mail-log-page')).map(item => item.attrs.get('data-mail-log-page'))).toEqual(['newer', 'older'])
    expect(node(items, 'data-mail-log-limit').attrs.has('hidden')).toBe(true)
    expect(node(items, 'data-mail-log-detail-body').attrs.has('hidden')).toBe(true)
  })

  it('keeps observed mail-flow counters unknown and all three real rankings', () => {
    const html = render('/whm/email/monitor'), items = parseMarkup(html)
    expect(items.filter(item => item.attrs.has('data-mail-monitor-count'))).toHaveLength(6)
    expect(items.filter(item => item.attrs.has('data-mail-monitor-table')).map(item => item.attrs.get('data-mail-monitor-table'))).toEqual(['senders', 'domains', 'deferrals'])
    expect(html).toContain('Mail flow has not been read.')
    expect(items.filter(item => item.attrs.has('data-mail-monitor-count')).every(item => item.tag === 'dd')).toBe(true)
  })

  it('keeps DNS quality read-only and all DNS record result channels present', () => {
    const html = render('/whm/email/quality'), items = parseMarkup(html)
    expect(html).not.toMatch(/<form\b/)
    expect(node(items, 'data-whm-mail-quality-rows').tag).toBe('tbody')
    expect(node(items, 'data-whm-mail-quality-check').attrs.has('disabled')).toBe(true)
    for (const record of ['MX', 'SPF', 'DKIM', 'DMARC']) expect(html).toContain(`<th scope="col">${record}</th>`)
  })

  it('preserves per-mailbox maintenance facts, truncation notices and all job operations', () => {
    const items = nodes('/whm/email/maintenance')
    for (const key of ['mailboxes', 'quota', 'folders']) expect(node(items, 'data-whm-mailbox-maintenance-rows', key).tag).toBe('tbody')
    for (const operation of ['quota-recalc', 'resync', 'index']) expect(node(items, 'data-whm-mailbox-maintenance-run', operation).attrs.has('disabled')).toBe(true)
    expect(node(items, 'data-whm-mailbox-maintenance-job-link').attrs.has('hidden')).toBe(true)
    expect(node(items, 'data-whm-mailbox-maintenance-fts-note').attrs.has('hidden')).toBe(true)
  })

  it('uses logical scoped CSS and preserves ASCII output in Arabic', () => {
    expect(WHM_MAIL_CSS).not.toMatch(/\.xp-|(?:text-align|float|clear)\s*:\s*(?:left|right)|(?:margin|padding|border)-(?:left|right)/)
    const html = render('/whm/email/queue', { locale: 'ar' })
    expect(html).toContain('dir="rtl"')
    expect(html).not.toMatch(/[٠-٩۰-۹]/)
  })
})
