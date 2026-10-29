// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmMailDelivery, renderWhmMailMonitor } from './board-port/whm-mail-log-workspace.ts'
import { readMailDeliveryView, readMailMonitorView, WHM_MAIL_LOG_CLIENT_BINDING } from './whm-mail-log-client.ts'

const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const base = () => ({ scope: 'server', state: 'read', observedAt: '2026-10-27T12:00:01.000Z', window: { since: '2026-10-26T12:00:00Z', until: '2026-10-27T12:00:00Z' }, limit: 20000, lineLimitReached: false, counts: { records: 6, events: 5, skipped: 1, unparsed: 0, untrusted: 0 } })
const message = (queueId: string | null = '4F2A1B3C9D') => ({
  queueId, firstSeen: '2026-10-27T10:00:00.000Z', lastSeen: '2026-10-27T10:01:00.000Z', sender: 'alice@example.com', size: 1234, recipientCount: 1, messageId: '<m1@example.com>', client: 'mail.example.net[203.0.113.5]', saslUsername: 'alice@example.com', status: 'deferred', dsn: '4.4.1',
  recipients: [{ address: 'carol@example.net', originalAddress: null, status: 'deferred', dsn: '4.4.1', relay: 'none', response: 'connect to mx.example.net[192.0.2.9]:25: Connection timed out', at: '2026-10-27T10:01:00.000Z', attempts: 1 }], recipientsOmitted: 0,
  events: [{ at: '2026-10-27T10:00:00.000Z', source: 'qmgr', kind: 'queued', text: 'from=<alice@example.com>, size=1234, nrcpt=1 (queue active)' }, { at: '2026-10-27T10:01:00.000Z', source: 'smtp', kind: 'delivery', text: 'to=<carol@example.net>, relay=none, ... status=deferred (<img src=x onerror=alert(1)>)' }], eventsOmitted: 0,
})
const delivery = (messages = [message()]) => ({ ...base(), summary: {}, filters: {}, matched: messages.length, messages, omittedMessages: 0 })
const monitor = () => ({ ...base(), summary: { messages: 3, statuses: { sent: 1, deferred: 1, bounced: 0, expired: 0, rejected: 1, queued: 0 }, deliveries: { sent: 1, deferred: 1, bounced: 0, expired: 0 }, topSenders: [{ address: 'alice@example.com', messages: 2 }], topRecipientDomains: [{ domain: 'example.net', recipients: 1 }], deferralReasons: [{ dsn: '4.4.1', reason: 'Connection timed out', count: 1 }] } })
const boot = (html: string, request?: (method: string, path: string) => Promise<unknown>, ar = false) => {
  document.documentElement.lang = ar ? 'ar' : 'en'; document.documentElement.dir = ar ? 'rtl' : 'ltr'
  document.body.innerHTML = `<section data-whm-detail-route="/whm/email/delivery" data-capability-state="authorized">${html}</section>`
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  new Function('return ' + WHM_MAIL_LOG_CLIENT_BINDING)()()
}
beforeEach(() => { document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'; delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('WHM mail log parsers', () => {
  it('accepts the agent contract and refuses unsafe or inconsistent observations', () => {
    expect(readMailDeliveryView(delivery()).messages[0]!.recipients[0]!.status).toBe('deferred')
    expect(readMailMonitorView(monitor()).summary.statuses.rejected).toBe(1)
    const bad: unknown[] = [
      { ...delivery(), scope: 'mailbox' }, { ...delivery(), matched: 2 }, { ...delivery(), state: 'unavailable' }, { ...delivery(), counts: { ...base().counts, records: 9 } },
      { ...delivery(), window: { since: '2026-10-01T00:00:00Z', until: '2026-10-27T00:00:00Z' } }, delivery([{ ...message(), status: 'ok' }]), delivery([{ ...message(), queueId: '../x' }]),
      delivery([{ ...message(), dsn: '9.9.9' }]), delivery([{ ...message(), sender: 'a\u0007b' }]), delivery([{ ...message(), recipients: [{ ...message().recipients[0]!, attempts: 0 }] }]),
      delivery([{ ...message(), events: [{ ...message().events[0]!, kind: 'shell' }] }]), delivery([{ ...message(), events: [{ ...message().events[0]!, text: 'x'.repeat(1025) }] }]),
      { ...monitor(), summary: { ...monitor().summary, messages: 4 } }, { ...monitor(), summary: { ...monitor().summary, topSenders: Array(11).fill({ address: 'a', messages: 1 }) } },
    ]
    for (const value of bad) expect(() => (value as { summary?: { statuses?: unknown } }).summary && 'statuses' in ((value as { summary: object }).summary) ? readMailMonitorView(value) : readMailDeliveryView(value)).toThrow()
    expect(readMailDeliveryView({ ...base(), state: 'unavailable', reason: 'journal_unavailable', counts: { records: 0, events: 0, skipped: 0, unparsed: 0, untrusted: 0 }, matched: 0, messages: [], omittedMessages: 0 }).state).toBe('unavailable')
    expect(() => readMailDeliveryView({ ...base(), state: 'unavailable', matched: 0, messages: [], omittedMessages: 0 })).toThrow()
  })
})

describe('WHM delivery report binding', () => {
  it('renders the complete workspace in English and Arabic with LTR technical fields', () => {
    for (const locale of ['en', 'ar'] as const) {
      const html = renderWhmMailDelivery({ locale, canRead: true }) + renderWhmMailMonitor({ locale, canRead: true })
      expect(html).toContain(`dir="${locale === 'ar' ? 'rtl' : 'ltr'}"`)
      expect(html).toContain(locale === 'ar' ? 'البحث في عمليات التسليم' : 'Search deliveries')
      expect(html).toContain(locale === 'ar' ? 'أسباب التأجيل' : 'Deferral reasons')
      expect(html).not.toMatch(/[٠-٩۰-۹]/)
      expect(html).toContain('data-mail-log-rows'); expect(html).toContain('data-mail-log-detail-events')
    }
    expect(renderWhmMailDelivery({ locale: 'en', canRead: false })).toContain('Delivery reports are unavailable here')
  })
  it('makes no request without transport or admission', async () => {
    boot(renderWhmMailDelivery({ locale: 'en', canRead: true }))
    expect(document.querySelector<HTMLElement>('[data-mail-log-status]')!.dataset.state).toBe('unavailable')
    const send = vi.fn()
    boot(renderWhmMailDelivery({ locale: 'en', canRead: false }), send); await tick()
    expect(send).not.toHaveBeenCalled()
    expect(document.querySelector<HTMLButtonElement>('[data-mail-log-submit]')!.disabled).toBe(true)
  })
  it('reads the latest 24 hours, paints rows as text and opens the timeline panel', async () => {
    const send = vi.fn(async () => delivery([message(), message(null)]))
    boot(renderWhmMailDelivery({ locale: 'en', canRead: true }), send); await tick()
    const [method, path] = send.mock.calls[0] as unknown as [string, string]
    expect(method).toBe('GET'); expect(path).toMatch(/^\/api\/server\/mail-log\/delivery\?since=\d{4}-\d{2}-\d{2}T\d{2}%3A\d{2}%3A\d{2}Z&until=/)
    const params = new URLSearchParams(path.split('?')[1]); expect(Date.parse(params.get('until')!) - Date.parse(params.get('since')!)).toBe(86400000)
    expect(document.querySelector<HTMLElement>('[data-mail-log-status]')!.dataset.state).toBe('read')
    const rows = document.querySelectorAll('[data-mail-log-rows] tr')
    expect(rows).toHaveLength(2); expect(rows[0]!.textContent).toContain('carol@example.net'); expect(rows[1]!.textContent).toContain('Not queued')
    expect(document.querySelector('[data-mail-log-integrity]')!.textContent).toContain('Journal records read: 6')
    rows[0]!.querySelector('button')!.click()
    expect(document.querySelector<HTMLElement>('[data-mail-log-detail-body]')!.hidden).toBe(false)
    expect(document.querySelector('[data-mail-log-detail-facts]')!.textContent).toContain('<m1@example.com>')
    expect(document.querySelector('[data-mail-log-detail-events]')!.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(document.querySelector('[data-mail-log-detail-events] img')).toBeNull()
    expect(WHM_MAIL_LOG_CLIENT_BINDING).not.toContain('innerHTML'); expect(WHM_MAIL_LOG_CLIENT_BINDING).not.toContain('fetch(')
  })
  it('sends filters and a custom UTC range, and refuses an invalid range locally', async () => {
    const send = vi.fn(async (_method: string, _path: string) => delivery([]))
    boot(renderWhmMailDelivery({ locale: 'en', canRead: true }), send); await tick()
    const form = document.querySelector<HTMLFormElement>('[data-mail-log-form]')!
    const set = (name: string, value: string) => { const control = form.elements.namedItem(name) as HTMLInputElement; control.value = value; control.dispatchEvent(new Event('change')) }
    set('whm-mail-delivery-range', 'custom'); set('since', '2026-10-27 08:00'); set('until', '2026-10-27 12:30'); set('sender', 'alice'); set('status', 'bounced'); set('dsn', '5.1')
    form.dispatchEvent(new Event('submit', { cancelable: true })); await tick()
    expect(send.mock.calls[1]![1]).toBe('/api/server/mail-log/delivery?since=2026-10-27T08%3A00%3A00Z&until=2026-10-27T12%3A30%3A00Z&sender=alice&status=bounced&dsn=5.1')
    expect(document.querySelector('[data-mail-log-rows]')!.textContent).toContain('No messages match these filters')
    set('until', '2026-11-05 00:00'); form.dispatchEvent(new Event('submit', { cancelable: true })); await tick()
    expect(send).toHaveBeenCalledTimes(2)
    expect(document.querySelector<HTMLElement>('[data-mail-log-status]')!.dataset.state).toBe('failed')
  })
  it('shows a truthful unavailable journal and a refused request without stale rows', async () => {
    const send = vi.fn(async () => ({ ...base(), state: 'unavailable', reason: 'journal_unavailable', counts: { records: 0, events: 0, skipped: 0, unparsed: 0, untrusted: 0 }, matched: 0, messages: [], omittedMessages: 0 }))
    boot(renderWhmMailDelivery({ locale: 'ar', canRead: true }), send, true); await tick()
    expect(document.querySelector<HTMLElement>('[data-mail-log-status]')!.dataset.state).toBe('unavailable')
    expect(document.querySelector('[data-mail-log-status]')!.textContent).toContain('يومية البريد غير متاحة')
    expect(document.querySelector('[data-mail-log-integrity]')!.textContent).toContain('سجلات اليومية المقروءة: 0. أحداث التسليم: 0. أسطر Postfix الأخرى المتجاوزة: 0.')
    boot(renderWhmMailDelivery({ locale: 'en', canRead: true }), vi.fn(async () => { throw Object.assign(new Error('refused'), { status: 422 }) })); await tick()
    expect(document.querySelector('[data-mail-log-status]')!.textContent).toContain('The filters were refused')
    expect(document.querySelectorAll('[data-mail-log-rows] button')).toHaveLength(0)
  })
})

describe('WHM mail monitor binding', () => {
  it('paints counts and top tables from the monitor aggregate', async () => {
    const send = vi.fn(async () => monitor())
    boot(renderWhmMailMonitor({ locale: 'en', canRead: true }), send); await tick()
    expect((send.mock.calls[0] as unknown as [string, string])[1]).toMatch(/^\/api\/server\/mail-log\/monitor\?since=/)
    expect(document.querySelector('[data-mail-monitor-count="rejected"]')!.textContent).toBe('1')
    expect(document.querySelector('[data-mail-monitor-table="senders"]')!.textContent).toContain('alice@example.com')
    expect(document.querySelector('[data-mail-monitor-table="deferrals"]')!.textContent).toContain('Connection timed out')
    expect(document.querySelector('[data-mail-log-fact="messages"]')!.textContent).toBe('3')
  })
  it('marks every count unavailable when the read fails', async () => {
    boot(renderWhmMailMonitor({ locale: 'en', canRead: true }), vi.fn(async () => ({ ...monitor(), scope: 'other' }))); await tick()
    expect(document.querySelector<HTMLElement>('[data-mail-log-status]')!.dataset.state).toBe('failed')
    expect(document.querySelector('[data-mail-monitor-count="sent"]')!.textContent).toBe('Unavailable')
  })
})

describe('mail delivery report timestamp precision', () => {
  it.each(['en', 'ar'] as const)('preserves complete observation, window, message and event UTC timestamps in %s', async locale => {
    const observedAt = '2026-10-27T12:34:56.789Z'
    const window = { since: '2026-10-26T12:00:00.123Z', until: '2026-10-27T12:00:00.456Z' }
    const firstSeen = '2026-10-27T10:01:02.345Z', lastSeen = '2026-10-27T10:02:03.456Z', eventAt = '2026-10-27T10:02:01.234Z'
    const item = { ...message(), firstSeen, lastSeen, events: [{ ...message().events[0]!, at: eventAt }] }
    const send = vi.fn(async (_method: string, _path: string) => ({ ...delivery([item]), observedAt, window }))
    boot(renderWhmMailDelivery({ locale, canRead: true }), send, locale === 'ar')
    await tick()
    expect(document.querySelector('[data-mail-log-fact="observed"]')!.textContent).toBe('2026-10-27 12:34 UTC')
    expect(document.querySelector('[data-mail-log-fact="window"]')!.textContent).toBe('2026-10-26 12:00 UTC – 2026-10-27 12:00 UTC')
    const row = document.querySelector<HTMLTableRowElement>('[data-mail-log-rows] tr')!
    expect(row.cells[0]!.querySelector('bdi[dir="ltr"]')!.textContent).toBe('2026-10-27 10:02 UTC')
    row.querySelector('button')!.click()
    const details = [...document.querySelectorAll('[data-mail-log-detail-facts] bdi[dir="ltr"]')].map(node => node.textContent)
    expect(details).toContain('2026-10-27 10:01 UTC')
    expect(details).toContain('2026-10-27 10:02 UTC')
    expect(document.querySelector('[data-mail-log-detail-events] strong bdi[dir="ltr"]')!.textContent).toBe('2026-10-27 10:02 UTC')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('GET', expect.stringMatching(/^\/api\/server\/mail-log\/delivery\?/))
  })
  it.each(['en', 'ar'] as const)('preserves complete monitor observation and window UTC timestamps in %s', async locale => {
    const observedAt = '2026-10-27T12:34:56.789Z'
    const window = { since: '2026-10-26T12:00:00.123Z', until: '2026-10-27T12:00:00.456Z' }
    const send = vi.fn(async (_method: string, _path: string) => ({ ...monitor(), observedAt, window }))
    boot(renderWhmMailMonitor({ locale, canRead: true }), send, locale === 'ar')
    await tick()
    expect(document.querySelector('[data-mail-log-fact="observed"]')!.textContent).toBe('2026-10-27 12:34 UTC')
    expect(document.querySelector('[data-mail-log-fact="window"]')!.textContent).toBe('2026-10-26 12:00 UTC – 2026-10-27 12:00 UTC')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('GET', expect.stringMatching(/^\/api\/server\/mail-log\/monitor\?/))
  })
})
