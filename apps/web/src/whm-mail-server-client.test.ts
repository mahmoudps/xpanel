// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmMailServerWorkspace } from './board-port/whm-mail-server-workspace.ts'
import type { WhmMailServerPage } from './board-port/whm-mail-server-workspace.ts'
import { readMailServerView, WHM_MAIL_SERVER_CLIENT_BINDING } from './whm-mail-server-client.ts'

const tick = async () => { for (let index = 0; index < 6; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const sources = { postfix: 'read', master: 'read', dovecot: 'read', desired: 'rendered' }
const view = (page: WhmMailServerPage, extra: Record<string, unknown> = {}) => ({
  page, host: 'connected', observedAt: '2026-10-27T10:00:00.000Z', sources, truncated: false, editable: true,
  settings: [
    { source: 'postfix', key: 'smtpd_milters', observed: 'local:opendkim/opendkim.sock', desired: 'local:opendkim/opendkim.sock', state: 'match' },
    { source: 'postfix', key: 'milter_default_action', observed: 'tempfail', desired: 'accept', state: 'drift' },
    { source: 'postfix', key: 'myhostname', observed: null, desired: null, state: 'not-managed' },
    { source: 'dovecot', key: 'mail_location', observed: null, desired: null, state: 'not-managed' },
  ],
  services: page === 'routing' ? [] : [{ service: '127.0.0.1:587', observed: 'inet n - n - - smtpd', desired: 'inet n - n - - smtpd', state: 'drift', otherOptions: 2,
    options: [{ key: 'smtpd_tls_auth_only', observed: 'no', desired: 'yes', state: 'drift' }, { key: 'syslog_name', observed: '', desired: null, state: 'not-managed' }] }],
  domains: page !== 'routing' ? [] : [
    { domain: 'example.test', account: 'alice', mailboxes: 2, zone: 'example.test', mx: [{ priority: 10, host: 'mail.example.test' }], state: 'mx-saved', mode: 'local' },
    { domain: 'shop.example.test', account: 'alice', mailboxes: 1, zone: 'example.test', mx: [], state: 'mx-missing', mode: 'backup' },
    { domain: 'nozone.test', account: null, mailboxes: 1, zone: null, mx: [], state: 'zone-missing', mode: 'local' }],
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
      [view('server'), 'routing'], [{ ...view('server'), editable: false }, 'server'], [{ ...view('routing'), domains: [{ ...view('routing').domains[0], mode: 'relay' }] }, 'routing'], [{ ...view('server'), host: 'not-connected' }, 'server'],
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
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledWith('GET', '/api/server/mail-server/' + page)
    expect(send).toHaveBeenLastCalledWith('GET', '/api/server/mailx/' + (page === 'routing' ? 'routing' : 'server'))
  })
})

describe('mail server settings editor', () => {
  const revision = 'b'.repeat(64)
  const serverPolicy = { section: 'server', saved: true, revision, state: 'applied', host: 'connected', policy: { postfix: { myhostname: 'mail.example.test', smtpd_tls_protocols: '!SSLv2, !SSLv3, !TLSv1, !TLSv1.1' },
    dovecot: { ssl_min_protocol: 'TLSv1.2' }, rbl: null, certificates: { smtp: null, submission: null, imap: null } }, choices: { certificates: [{ id: 'c1', names: ['mail.example.test'], notAfter: '2027-01-01T00:00:00.000Z' }] } }
  /** Answers each path like the API; preview and save outcomes come from `reply`. */
  const api = (page: WhmMailServerPage, reply: Record<string, unknown> = {}) => vi.fn(async (method: string, path: string, _body?: unknown) => {
    if (path.startsWith('/api/server/mail-server/')) return view(page)
    if (method === 'GET' && path === '/api/server/mailx/server') return serverPolicy
    if (method === 'GET' && path === '/api/server/mailx/routing') return { section: 'routing', saved: true, revision, state: 'pending', host: 'connected', policy: { domains: [{ domain: 'hidden.test', mode: 'remote' }, { domain: 'shop.example.test', mode: 'backup' }] } }
    if (path.endsWith('/preview')) { if (reply.previewError) throw reply.previewError; return { section: path.split('/')[4], changes: [{ target: 'postfix', key: 'myhostname', before: 'mail.example.test', after: 'mx.example.test' }] } }
    return { application: reply.application ?? { outcome: 'applied', verificationRequired: false, spam: 'not-saved', reconcile: 'applied' } }
  })
  const field = (key: string) => document.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-mail-setting="${key}"]`)!
  const button = (name: string) => document.querySelector<HTMLButtonElement>(`[data-whm-mail-settings-${name}]`)!
  const formStatus = () => document.querySelector<HTMLElement>('[data-whm-mail-settings-status]')!
  const edit = (control: HTMLInputElement | HTMLSelectElement, value: string) => { control.value = value; control.dispatchEvent(new Event('input', { bubbles: true })) }
  const submit = () => document.querySelector<HTMLFormElement>('[data-whm-mail-settings]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

  it('fills the saved policy, previews the exact change and saves only what was previewed', async () => {
    const send = api('server'); boot(send); await tick()
    expect(field('myhostname').value).toBe('mail.example.test'); expect(field('ssl_min_protocol').value).toBe('TLSv1.2'); expect(field('mydomain').value).toBe('')
    expect(document.querySelector<HTMLSelectElement>('[data-mail-certificate="imap"]')!.options).toHaveLength(2)
    expect(button('save').disabled).toBe(true); expect(button('preview-button').disabled).toBe(false)
    edit(field('myhostname'), 'mx.example.test'); edit(field('mynetworks'), '127.0.0.0/8,[::1]/128'); edit(field('smtpd_tls_protocols'), '')
    button('preview-button').click(); await tick()
    const policy = { postfix: { myhostname: 'mx.example.test', mynetworks: '127.0.0.0/8, [::1]/128' }, dovecot: { ssl_min_protocol: 'TLSv1.2' }, rbl: null, certificates: { smtp: null, submission: null, imap: null } }
    expect(send).toHaveBeenCalledWith('POST', '/api/server/mailx/server/preview', { policy, expectedRevision: revision })
    expect(rows('changes')[0]!.textContent).toContain('mx.example.test'); expect(button('save').disabled).toBe(false)
    edit(field('mydomain'), 'example.test')
    expect(button('save').disabled).toBe(true)
    submit(); await tick()
    expect(send.mock.calls.some(([method]) => method === 'PUT')).toBe(false)
    edit(field('mydomain'), '')
    button('preview-button').click(); await tick()
    submit(); await tick()
    expect(send).toHaveBeenCalledWith('PUT', '/api/server/mailx/server', { policy, expectedRevision: revision })
    expect(formStatus().textContent).toBe('Saved and applied. Postfix confirmed the change.')
  })
  it('names the failed configuration test after a rollback and the invalid field after a refusal', async () => {
    boot(api('server', { application: { outcome: 'rolled-back', verificationRequired: false, spam: 'not-saved', failedCheck: 'dovecot' } })); await tick()
    edit(field('ssl_min_protocol'), 'TLSv1.3'); button('preview-button').click(); await tick()
    submit(); await tick()
    expect(formStatus().textContent).toContain('the previous settings were restored'); expect(formStatus().textContent).toContain('doveconf -n')
    mount('server')
    boot(api('server', { previewError: Object.assign(new Error('invalid'), { status: 422, code: 'VALIDATION', details: { field: 'mynetworks' } }) })); await tick()
    edit(field('mynetworks'), 'everyone'); button('preview-button').click(); await tick()
    expect(formStatus().dataset.state).toBe('failed'); expect(formStatus().textContent).toBe('mynetworks is not valid. Nothing was saved.')
    expect(button('save').disabled).toBe(true)
  })
  it('edits routes in the domain table and keeps saved routes of domains not listed', async () => {
    mount('routing')
    const send = api('routing'); boot(send); await tick()
    const select = document.querySelector<HTMLSelectElement>('[data-mail-route="example.test"]')!
    expect(select.disabled).toBe(false); expect(document.querySelector<HTMLSelectElement>('[data-mail-route="shop.example.test"]')!.value).toBe('backup')
    select.value = 'remote'; select.dispatchEvent(new Event('change', { bubbles: true }))
    button('preview-button').click(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/mailx/routing/preview', { expectedRevision: revision,
      policy: { domains: [{ domain: 'example.test', mode: 'remote' }, { domain: 'hidden.test', mode: 'remote' }, { domain: 'shop.example.test', mode: 'backup' }] } })
  })
  it('renders no editor without manage authority', async () => {
    document.body.innerHTML = renderWhmMailServerWorkspace({ locale: 'en', page: 'server', canRead: true, canManage: false })
    const send = api('server'); boot(send); await tick()
    expect(document.querySelector('[data-whm-mail-settings]')).toBeNull()
    expect(send).toHaveBeenCalledTimes(1)
  })
})
