// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmFtpLog } from './board-port/whm-ftp-log-workspace.ts'
import { readFtpLogView, WHM_FTP_LOG_CLIENT_BINDING } from './whm-ftp-log-client.ts'

const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const at = (minute: number) => `2026-10-27T10:${String(minute).padStart(2, '0')}:00.000Z`
const events = () => [
  { at: at(3), kind: 'login-failed', client: '198.51.100.7', user: 'root', account: null, path: null, pathBase: null, bytes: null },
  { at: at(2), kind: 'upload', client: '203.0.113.5', user: 'bob@example.com', account: 'acme', path: 'public_html/<img src=x onerror=alert(1)>.html', pathBase: 'home', bytes: 1234 },
  { at: at(1), kind: 'login', client: '203.0.113.5', user: 'bob@example.com', account: 'acme', path: null, pathBase: null, bytes: null },
  { at: at(0), kind: 'connect', client: '203.0.113.5', user: null, account: null, path: null, pathBase: null, bytes: null },
]
const summary = () => ({
  events: 4, connections: 1, logins: { succeeded: 1, failed: 1 }, transfers: { uploads: 1, uploadBytes: 1234, downloads: 0, downloadBytes: 0, deletes: 0 },
  topUsers: [{ user: 'bob@example.com', account: 'acme', events: 2, logins: 1, failures: 0, uploads: 1, downloads: 0, bytes: 1234 }, { user: 'root', account: null, events: 1, logins: 0, failures: 1, uploads: 0, downloads: 0, bytes: 0 }],
  topClients: [{ client: '203.0.113.5', events: 3, connections: 1, logins: 1, failures: 0 }, { client: '198.51.100.7', events: 1, connections: 0, logins: 0, failures: 1 }],
  failureBursts: [{ client: '198.51.100.7', failures: 6, users: 2, firstAt: at(3), lastAt: at(9) }],
})
const view = (extra: Record<string, unknown> = {}) => ({ scope: 'server', state: 'read', observedAt: '2026-10-27T12:00:01.000Z', window: { since: '2026-10-26T12:00:00Z', until: '2026-10-27T12:00:00Z' }, limit: 20000, lineLimitReached: false, accountMapping: 'read', counts: { records: 5, events: 4, skipped: 1, unparsed: 0, untrusted: 0 }, summary: summary(), filters: {}, matched: 4, matchedSummary: null, events: events(), omittedEvents: 0, ...extra })
const bobView = () => {
  const own = events().filter(event => event.user === 'bob@example.com')
  return view({ filters: { user: 'bob@example.com' }, matched: 2, events: own, matchedSummary: { ...summary(), events: 2, connections: 0, logins: { succeeded: 1, failed: 0 }, topUsers: [summary().topUsers[0]], topClients: [{ client: '203.0.113.5', events: 2, connections: 0, logins: 1, failures: 0 }], failureBursts: [] } })
}
const unavailable = () => view({ state: 'unavailable', reason: 'journal_unavailable', accountMapping: 'not-read', counts: { records: 0, events: 0, skipped: 0, unparsed: 0, untrusted: 0 }, summary: { ...summary(), events: 0, connections: 0, logins: { succeeded: 0, failed: 0 }, transfers: { uploads: 0, uploadBytes: 0, downloads: 0, downloadBytes: 0, deletes: 0 }, topUsers: [], topClients: [], failureBursts: [] }, matched: 0, events: [] })
const boot = (html: string, request?: (method: string, path: string) => Promise<unknown>, ar = false) => {
  document.documentElement.lang = ar ? 'ar' : 'en'; document.documentElement.dir = ar ? 'rtl' : 'ltr'
  document.body.innerHTML = `<section data-whm-detail-route="/whm/services/ftp-log-analysis" data-capability-state="authorized">${html}</section>`
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  new Function('return ' + WHM_FTP_LOG_CLIENT_BINDING)()()
}
const $ = (selector: string) => document.querySelector<HTMLElement>(selector)!
beforeEach(() => { document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'; delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('WHM FTP log parser', () => {
  it('accepts the agent contract and refuses unsafe or inconsistent observations', () => {
    expect(readFtpLogView(view()).events[1]).toMatchObject({ kind: 'upload', pathBase: 'home', bytes: 1234 })
    expect(readFtpLogView(bobView()).matchedSummary!.events).toBe(2)
    expect(readFtpLogView(unavailable()).state).toBe('unavailable')
    const event = (patch: Record<string, unknown>, index = 1) => view({ events: events().map((item, i) => i === index ? { ...item, ...patch } : item) })
    const bad: unknown[] = [
      view({ scope: 'mailbox' }), view({ matched: 5 }), view({ state: 'unavailable' }), view({ counts: { records: 9, events: 4, skipped: 1, unparsed: 0, untrusted: 0 } }), view({ accountMapping: 'maybe' }),
      view({ window: { since: '2026-10-01T00:00:00Z', until: '2026-10-27T00:00:00Z' } }), view({ matchedSummary: summary() }), view({ filters: { user: 'bob' } }), view({ filters: { kind: 'shell' }, matchedSummary: summary() }),
      view({ summary: { ...summary(), events: 3 } }), view({ summary: { ...summary(), topUsers: Array(11).fill(summary().topUsers[0]) } }), view({ summary: { ...summary(), connections: 9 } }),
      event({ kind: 'shell' }), event({ client: '203.0.113.5 <b>' }), event({ user: 'a\u0007b' }), event({ account: '../acme' }), event({ path: null }), event({ bytes: null }), event({ pathBase: 'disk' }),
      event({ path: 'x'.repeat(4097) }), event({ bytes: 5 }, 0), event({ path: '/x', pathBase: 'host' }, 0), event({ at: 'yesterday' }), { ...unavailable(), counts: { records: 1, events: 0, skipped: 1, unparsed: 0, untrusted: 0 } },
    ]
    for (const value of bad) expect(() => readFtpLogView(value)).toThrow()
  })
})

describe('WHM FTP log binding', () => {
  it('makes no request without transport or admission', async () => {
    boot(renderWhmFtpLog({ locale: 'en', canRead: true }))
    expect($('[data-ftp-log-status]').dataset.state).toBe('unavailable')
    const send = vi.fn()
    boot(renderWhmFtpLog({ locale: 'en', canRead: false }), send); await tick()
    expect(send).not.toHaveBeenCalled()
    expect(document.querySelector<HTMLButtonElement>('[data-ftp-log-submit]')!.disabled).toBe(true)
    boot(`<div data-capability-state="unavailable">${renderWhmFtpLog({ locale: 'en', canRead: true })}</div>`, send); await tick()
    expect(send).not.toHaveBeenCalled()
  })
  it('reads the latest 24 hours and paints the summary, tables and events as text', async () => {
    const send = vi.fn(async (_method: string, _path: string) => view())
    boot(renderWhmFtpLog({ locale: 'en', canRead: true }), send); await tick()
    const [method, path] = send.mock.calls[0]!
    expect(method).toBe('GET'); expect(path).toMatch(/^\/api\/server\/ftp-log\/activity\?since=\d{4}-\d{2}-\d{2}T\d{2}%3A\d{2}%3A\d{2}Z&until=[^&]+$/)
    const params = new URLSearchParams(path.split('?')[1]); expect(Date.parse(params.get('until')!) - Date.parse(params.get('since')!)).toBe(86400000)
    expect($('[data-ftp-log-status]').dataset.state).toBe('read')
    expect($('[data-ftp-log-count="succeeded"]').textContent).toBe('1'); expect($('[data-ftp-log-count="uploadBytes"]').textContent).toBe('1234')
    expect($('[data-ftp-log-table="users"]').textContent).toContain('bob@example.com'); expect($('[data-ftp-log-table="users"]').textContent).toContain('Not mapped')
    expect($('[data-ftp-log-table="bursts"]').textContent).toContain('198.51.100.7')
    expect($('[data-ftp-log-integrity]').textContent).toContain('Journal records read: 5')
    const rows = document.querySelectorAll('[data-ftp-log-rows] tr')
    expect(rows).toHaveLength(4); expect(rows[0]!.textContent).toContain('Sign-in failed'); expect(rows[1]!.textContent).toContain('~/public_html/<img src=x onerror=alert(1)>.html')
    expect(document.querySelector('[data-ftp-log-rows] img')).toBeNull()
    expect($('[data-ftp-log-detail-body]').hidden).toBe(true)
    expect(WHM_FTP_LOG_CLIENT_BINDING).not.toContain('innerHTML'); expect(WHM_FTP_LOG_CLIENT_BINDING).not.toContain('fetch(')
  })
  it('drills into one user from the top users table and paints the matched summary', async () => {
    const send = vi.fn(async (_method: string, path: string) => path.includes('user=') ? bobView() : view())
    boot(renderWhmFtpLog({ locale: 'en', canRead: true }), send); await tick()
    $('[data-ftp-log-table="users"] button').click(); await tick()
    expect(new URLSearchParams(send.mock.calls[1]![1].split('?')[1]).get('user')).toBe('bob@example.com')
    expect($('[data-ftp-log-detail-body]').hidden).toBe(false)
    expect($('[data-ftp-log-detail-facts]').textContent).toContain('acme')
    expect($('[data-ftp-log-detail-clients]').textContent).toContain('203.0.113.5')
    expect(document.querySelectorAll('[data-ftp-log-rows] tr')).toHaveLength(2)
    $('[data-ftp-log-table="clients"] button').click(); await tick()
    const query = new URLSearchParams(send.mock.calls[2]![1].split('?')[1])
    expect(query.get('client')).toBe('203.0.113.5'); expect(query.has('user')).toBe(false)
    expect($('[data-ftp-log-detail-body]').hidden).toBe(true)
  })
  it('sends filters and a custom UTC range, and refuses an invalid range locally', async () => {
    const send = vi.fn(async (_method: string, _path: string) => view({ filters: { kind: 'upload', text: 'public' }, matched: 0, events: [], matchedSummary: { ...unavailable().summary } }))
    boot(renderWhmFtpLog({ locale: 'en', canRead: true }), send); await tick()
    const form = document.querySelector<HTMLFormElement>('[data-ftp-log-form]')!
    const set = (name: string, value: string) => { const control = form.elements.namedItem(name) as HTMLInputElement; control.value = value; control.dispatchEvent(new Event('change')) }
    set('whm-ftp-log-range', 'custom'); set('since', '2026-10-27 08:00'); set('until', '2026-10-27 12:30'); set('kind', 'upload'); set('text', ' public '); set('user', 'two words')
    form.dispatchEvent(new Event('submit', { cancelable: true })); await tick()
    expect(send.mock.calls[1]![1]).toBe('/api/server/ftp-log/activity?since=2026-10-27T08%3A00%3A00Z&until=2026-10-27T12%3A30%3A00Z&user=two+words&kind=upload&text=public')
    expect($('[data-ftp-log-rows]').textContent).toContain('No FTP events match these filters')
    set('until', '2026-11-05 00:00'); form.dispatchEvent(new Event('submit', { cancelable: true })); await tick()
    expect(send).toHaveBeenCalledTimes(2)
    expect($('[data-ftp-log-status]').dataset.state).toBe('failed')
  })
  it('shows a truthful unavailable journal and a refused request without stale rows', async () => {
    boot(renderWhmFtpLog({ locale: 'ar', canRead: true }), vi.fn(async () => unavailable()), true); await tick()
    expect($('[data-ftp-log-status]').dataset.state).toBe('unavailable')
    expect($('[data-ftp-log-status]').textContent).toContain('يومية pure-ftpd غير متاحة')
    expect($('[data-ftp-log-integrity]').textContent).toContain('سجلات اليومية المقروءة: 0. أحداث النشاط: 0. أسطر pure-ftpd الأخرى المتجاوزة: 0.')
    expect($('[data-ftp-log-count="failed"]').textContent).toBe('غير متاح')
    boot(renderWhmFtpLog({ locale: 'en', canRead: true }), vi.fn(async () => { throw Object.assign(new Error('refused'), { status: 422 }) })); await tick()
    expect($('[data-ftp-log-status]').textContent).toContain('The filters were refused')
    expect($('[data-ftp-log-table="users"]').textContent).toContain('Unavailable')
    boot(renderWhmFtpLog({ locale: 'en', canRead: true }), vi.fn(async () => ({ ...view(), scope: 'other' }))); await tick()
    expect($('[data-ftp-log-status]').dataset.state).toBe('failed')
    expect(document.querySelectorAll('[data-ftp-log-rows] td[colspan]')).toHaveLength(1)
  })
})

describe('WHM FTP log full timestamp display', () => {
  it.each(['en', 'ar'] as const)('preserves complete observation, window, event and burst instants in %s', async locale => {
    const observedAt = '2026-10-27T12:00:01.987Z'
    const window = { since: '2026-10-26T12:00:00.123Z', until: '2026-10-27T12:00:00.456Z' }
    const payload = view({ observedAt, window })
    const canonicalPayload = JSON.stringify(payload)
    const send = vi.fn(async (_method: string, _path: string) => payload)
    boot(renderWhmFtpLog({ locale, canRead: true }), send, locale === 'ar'); await tick()
    expect($('[data-ftp-log-status]').dataset.state).toBe('read')
    expect($('[data-ftp-log-fact="observed"]').textContent).toBe('2026-10-27 12:00 UTC')
    expect($('[data-ftp-log-fact="window"]').textContent).toBe('2026-10-26 12:00 UTC – 2026-10-27 12:00 UTC')
    expect([...document.querySelectorAll('[data-ftp-log-rows] tr td:first-child bdi')].map(node => node.textContent)).toEqual(['2026-10-27 10:03 UTC', '2026-10-27 10:02 UTC', '2026-10-27 10:01 UTC', '2026-10-27 10:00 UTC'])
    expect([...document.querySelectorAll('[data-ftp-log-table="bursts"] td:nth-child(n+4) bdi')].map(node => node.textContent)).toEqual(['2026-10-27 10:03 UTC', '2026-10-27 10:09 UTC'])
    for (const node of document.querySelectorAll('[data-ftp-log-fact], [data-ftp-log-rows] bdi, [data-ftp-log-table="bursts"] bdi')) expect(node.getAttribute('dir')).toBe('ltr')
    expect(JSON.stringify(payload)).toBe(canonicalPayload)
    expect(send.mock.calls.map(([method]) => method)).toEqual(['GET'])
    expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
})
