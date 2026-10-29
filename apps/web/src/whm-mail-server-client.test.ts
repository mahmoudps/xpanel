// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmMailServerWorkspace } from './board-port/whm-mail-server-workspace.ts'
import type { WhmMailServerPage } from './board-port/whm-mail-server-workspace.ts'
import { readMailServerView, WHM_MAIL_SERVER_CLIENT_BINDING } from './whm-mail-server-client.ts'

const tick = async () => { for (let index = 0; index < 6; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const sources = { postfix: 'read', master: 'read', dovecot: 'read', desired: 'rendered' }
const view = (page: WhmMailServerPage, extra: Record<string, unknown> = {}) => ({
  page, host: 'connected', observedAt: '2026-10-27T10:00:00.000Z', sources, truncated: false, editable: false,
  settings: [
    { source: 'postfix', key: 'smtpd_milters', observed: 'local:opendkim/opendkim.sock', desired: 'local:opendkim/opendkim.sock', state: 'match' },
    { source: 'postfix', key: 'milter_default_action', observed: 'tempfail', desired: 'accept', state: 'drift' },
    { source: 'postfix', key: 'myhostname', observed: null, desired: null, state: 'not-managed' },
    { source: 'dovecot', key: 'mail_location', observed: null, desired: null, state: 'not-managed' },
  ],
  services: page === 'routing' ? [] : [{ service: '127.0.0.1:587', observed: 'inet n - n - - smtpd', desired: 'inet n - n - - smtpd', state: 'drift', otherOptions: 2,
    options: [{ key: 'smtpd_tls_auth_only', observed: 'no', desired: 'yes', state: 'drift' }, { key: 'syslog_name', observed: '', desired: null, state: 'not-managed' }] }],
  domains: page !== 'routing' ? [] : [
    { domain: 'example.test', account: 'alice', mailboxes: 2, zone: 'example.test', mx: [{ priority: 10, host: 'mail.example.test' }], state: 'mx-saved' },
    { domain: 'shop.example.test', account: 'alice', mailboxes: 1, zone: 'example.test', mx: [], state: 'mx-missing' },
    { domain: 'nozone.test', account: null, mailboxes: 1, zone: null, mx: [], state: 'zone-missing' }],
  ...extra,
})
const status = () => document.querySelector<HTMLElement>('[data-whm-mail-server-status]')!
const rows = (name: string) => [...document.querySelectorAll<HTMLTableRowElement>(`[data-whm-mail-server-${name}] tr`)]
const mount = (page: WhmMailServerPage = 'server', locale: 'en' | 'ar' = 'en', canRead = true, state = 'authorized') => { document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'; document.body.innerHTML = `<section data-whm-detail-route="/whm/email/${page}" data-capability-state="${state}">${renderWhmMailServerWorkspace({ locale, page, canRead })}</section>` }
const boot = (request?: (method: string, path: string) => Promise<unknown>) => {
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  new Function('return ' + WHM_MAIL_SERVER_CLIENT_BINDING)()()
}
beforeEach(() => { mount(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('mail server client parser', () => {
  it('accepts the projected view and drops unknown fields', () => {
    const parsed = readMailServerView({ ...view('server'), extra: 'x', settings: view('server').settings.map(item => ({ ...item, secret: 'S3cret' })) }, 'server')
    expect(parsed.settings).toHaveLength(4)
    expect(JSON.stringify(parsed)).not.toMatch(/S3cret|extra/)
  })
  it('refuses inconsistent states, wrong pages and oversized values', () => {
    const settings = view('server').settings
    for (const [bad, page] of [
      [view('server'), 'routing'], [{ ...view('server'), editable: true }, 'server'], [{ ...view('server'), host: 'not-connected' }, 'server'],
      [{ ...view('server'), host: 'not-connected', observedAt: null }, 'server'], [{ ...view('server'), settings: [{ ...settings[0], desired: null }] }, 'server'],
      [{ ...view('server'), settings: [{ ...settings[0], observed: null }] }, 'server'], [{ ...view('server'), settings: [{ ...settings[2], desired: 'x' }] }, 'server'],
      [{ ...view('server'), settings: [{ ...settings[0], observed: 'x'.repeat(4097) }] }, 'server'], [{ ...view('server'), settings: [{ ...settings[0], key: 'Bad Key' }] }, 'server'],
      [{ ...view('routing'), domains: [{ ...view('routing').domains[0], mx: [] }] }, 'routing'], [{ ...view('routing'), domains: [{ ...view('routing').domains[2], zone: 'nozone.test' }] }, 'routing'],
      [{ ...view('server'), domains: view('routing').domains }, 'server'], [{ ...view('routing'), services: view('server').services }, 'routing'],
    ] as const) expect(() => readMailServerView(bad, page)).toThrow()
    expect(readMailServerView({ ...view('server'), host: 'not-connected', observedAt: null, sources: { postfix: 'unavailable', master: 'unavailable', dovecot: 'unavailable', desired: 'rendered' },
      settings: [{ ...settings[0], observed: null, state: 'unknown' }] }, 'server').host).toBe('not-connected')
  })
})

describe('mail server client binding', () => {
  it('stays inert without transport, without read authority or inside an unavailable capability', async () => {
    boot(); expect(status().dataset.state).toBe('unavailable')
    const send = vi.fn(async () => view('server'))
    mount('server', 'en', false); boot(send); await tick()
    mount('outbound', 'en', true, 'unavailable'); boot(send); await tick()
    expect(send).not.toHaveBeenCalled()
    expect(status().dataset.state).toBe('unavailable')
    expect(document.querySelector<HTMLButtonElement>('[data-whm-mail-server-refresh]')!.disabled).toBe(true)
    expect(document.querySelector('form')).toBeNull()
    expect([...document.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,select,textarea,button')].every(control => control.disabled)).toBe(true)
    expect(WHM_MAIL_SERVER_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_MAIL_SERVER_CLIENT_BINDING).not.toContain('fetch(')
  })
  it('paints sources, compared settings and services with drift marked and technical values isolated', async () => {
    const send = vi.fn(async () => view('server'))
    boot(send); await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/server/mail-server/server')
    expect(status().dataset.state).toBe('drift')
    expect(status().textContent).toContain('3 values differ')
    expect(document.querySelector('[data-whm-mail-server-fact="observed-at"]')!.textContent).toBe('2026-10-27 10:00 UTC')
    expect(document.querySelector('[data-whm-mail-server-fact="desired"]')!.textContent).toBe('Rendered')
    const settings = rows('settings')
    expect(settings).toHaveLength(4)
    expect(settings[0]!.querySelector('bdi[dir="ltr"]')!.textContent).toBe('smtpd_milters')
    expect(settings[1]!.lastElementChild!.getAttribute('data-state')).toBe('drift')
    expect(settings[1]!.textContent).toContain('tempfail')
    expect(settings[2]!.textContent).toContain('Not set in main.cf'); expect(settings[2]!.textContent).toContain('Not managed by xPanel')
    expect(settings[3]!.textContent).toContain('Not returned by doveconf')
    const services = rows('services')
    expect(services.map(row => row.cells.length)).toEqual([5, 5, 5, 5])
    expect(services[0]!.textContent).toContain('127.0.0.1:587'); expect(services[1]!.textContent).toContain('-o smtpd_tls_auth_only')
    expect(services[2]!.textContent).toContain('Empty value'); expect(services[3]!.textContent).toContain('Other overrides')
  })
  it('paints the routing domain table and reports the not-connected state truthfully', async () => {
    mount('routing')
    const offline = { ...view('routing'), host: 'not-connected', observedAt: null, sources: { postfix: 'unavailable', master: 'unavailable', dovecot: 'unavailable', desired: 'rendered' },
      settings: [{ source: 'postfix', key: 'virtual_transport', observed: null, desired: 'lmtp:unix:private/dovecot-lmtp', state: 'unknown' }], truncated: true }
    boot(async () => offline); await tick()
    expect(status().dataset.state).toBe('unavailable')
    expect(status().textContent).toContain('No protected host agent is connected')
    expect(rows('settings')[0]!.textContent).toContain('Not read')
    expect(rows('settings')[0]!.lastElementChild!.textContent).toBe('Not verified')
    const domains = rows('domains')
    expect(domains).toHaveLength(3)
    expect(domains[0]!.textContent).toContain('10 mail.example.test'); expect(domains[0]!.textContent).toContain('MX saved')
    expect(domains[1]!.textContent).toContain('RFC 5321'); expect(domains[2]!.textContent).toContain('Unassigned')
    expect(document.querySelector<HTMLElement>('[data-whm-mail-server-truncated]')!.hidden).toBe(false)
  })
  it('keeps the last rows and reports failure when a reload is refused, in Arabic', async () => {
    mount('outbound', 'ar')
    let calls = 0
    boot(async () => { if (++calls > 1) throw Object.assign(new Error('denied'), { status: 403 }); return view('outbound', { settings: [view('outbound').settings[0]] }) })
    await tick()
    expect(status().dataset.state).toBe('drift')
    expect(status().textContent).toBe('قيمتان تختلفان عن الإعدادات التي يولّدها xPanel. استخدم سير عمل الإصلاح المراجَع.')
    document.querySelector<HTMLButtonElement>('[data-whm-mail-server-refresh]')!.click(); await tick()
    expect(status().dataset.state).toBe('failed'); expect(status().getAttribute('role')).toBe('alert')
    expect(rows('services')).toHaveLength(4)
    expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
  it('rejects a malformed response without painting it', async () => {
    boot(async () => ({ ...view('server'), page: 'routing' })); await tick()
    expect(status().dataset.state).toBe('failed')
    expect(rows('settings')[0]!.textContent).toBe('Nothing has been read.')
  })
})

describe('mail server timestamp precision', () => {
  it.each([
    ['server', 'en'], ['server', 'ar'], ['routing', 'en'], ['routing', 'ar'], ['outbound', 'en'], ['outbound', 'ar'],
  ] as const)('preserves the complete UTC observation timestamp for %s in %s', async (page, locale) => {
    const observedAt = '2026-10-27T12:34:56.789Z'
    mount(page, locale)
    const send = vi.fn(async (_method: string, _path: string) => view(page, { observedAt }))
    boot(send)
    await tick()
    const observed = document.querySelector<HTMLElement>('[data-whm-mail-server-fact="observed-at"]')!
    expect(observed.textContent).toBe('2026-10-27 12:34 UTC')
    expect(observed.getAttribute('dir')).toBe('ltr')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('GET', '/api/server/mail-server/' + page)
  })
})
