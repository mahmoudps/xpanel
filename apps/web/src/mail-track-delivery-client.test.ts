// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderMailTrackDelivery } from './board-port/xmail-track-delivery.ts'
import { MAIL_TRACK_DELIVERY_CLIENT_BINDING, readTrackDeliveryView } from './mail-track-delivery-client.ts'

const MAILBOX = 'alice@example.com'
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const received = () => ({ queueId: '7A8B9C0D1E', role: 'recipient', firstSeen: '2026-10-27T10:02:00.000Z', lastSeen: '2026-10-27T10:02:00.000Z', sender: 'dave@remote.test', size: 900, status: 'sent', dsn: '2.0.0',
  recipients: [{ address: MAILBOX, status: 'sent', dsn: '2.0.0', relay: 'mail.example.com[private/dovecot-lmtp]', response: '250 2.0.0 <alice@example.com> Saved', at: '2026-10-27T10:02:00.000Z', attempts: 1 }],
  otherRecipients: 1, events: [{ at: '2026-10-27T10:02:00.000Z', kind: 'queued' }, { at: '2026-10-27T10:02:00.000Z', kind: 'delivery', status: 'sent', dsn: '2.0.0' }], eventsOmitted: 0 })
const sent = () => ({ queueId: 'B1C2D3E4F5', role: 'sender', firstSeen: '2026-10-27T10:03:00.000Z', lastSeen: '2026-10-27T10:03:00.000Z', sender: MAILBOX, size: 500, status: 'bounced', dsn: '5.1.1', recipients: [], otherRecipients: 2, events: [{ at: '2026-10-27T10:03:00.000Z', kind: 'notification' }], eventsOmitted: 0 })
const view = (messages: unknown[] = [sent(), received()], extra: Record<string, unknown> = {}) => ({ scope: 'mailbox', mailbox: MAILBOX, state: 'read', observedAt: '2026-10-27T12:00:01.000Z', window: { since: '2026-10-26T12:00:00Z', until: '2026-10-27T12:00:00Z' }, complete: true, messages, omittedMessages: 0, ...extra })
const boot = (html: string, request?: (method: string, path: string) => Promise<unknown>, ar = false) => {
  document.documentElement.lang = ar ? 'ar' : 'en'; document.documentElement.dir = ar ? 'rtl' : 'ltr'
  document.body.innerHTML = html
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  new Function('return ' + MAIL_TRACK_DELIVERY_CLIENT_BINDING)()()
}
beforeEach(() => { document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'; delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('xMail track delivery reader', () => {
  it('accepts only the sealed mailbox scope and its own recipient rows', () => {
    expect(readTrackDeliveryView(view(), MAILBOX).messages).toHaveLength(2)
    const bad: unknown[] = [
      view(undefined, { mailbox: 'bob@example.com' }), view(undefined, { scope: 'server' }),
      view([{ ...received(), recipients: [{ ...received().recipients[0], address: 'bob@example.com' }] }]),
      view([{ ...sent(), sender: 'bob@example.com' }]), view([{ ...sent(), role: 'recipient' }]), view([{ ...received(), role: 'sender' }]),
      view([{ ...received(), events: [{ at: '2026-10-27T10:02:00.000Z', kind: 'client' }] }]), view([{ ...received(), status: 'ok' }]),
      view([], { state: 'unavailable', reason: 'journal_unavailable' }), view([received()], { state: 'unavailable', reason: 'journal_unavailable', complete: false }), view([], { reason: 'output_limit' }),
    ]
    for (const value of bad) expect(() => readTrackDeliveryView(value, MAILBOX)).toThrow()
    expect(readTrackDeliveryView(view([], { state: 'unavailable', reason: 'journal_unavailable', complete: false }), MAILBOX).state).toBe('unavailable')
  })
})

describe('xMail track delivery workspace', () => {
  it('renders English and Arabic with the mailbox isolated as LTR and ASCII digits', () => {
    for (const locale of ['en', 'ar'] as const) {
      const html = renderMailTrackDelivery({ locale, mailbox: MAILBOX, canRead: true })
      expect(html).toContain(`dir="${locale === 'ar' ? 'rtl' : 'ltr'}"`)
      expect(html).toContain('<bdi dir="ltr">alice@example.com</bdi>')
      expect(html).toContain(locale === 'ar' ? 'محاولات التسليم' : 'Delivery attempts')
      expect(html).not.toMatch(/[٠-٩۰-۹]/)
    }
    expect(renderMailTrackDelivery({ locale: 'en', mailbox: '"><x>', canRead: false })).not.toContain('"><x>')
  })
  it('makes no request without transport, admission or a mailbox', async () => {
    boot(renderMailTrackDelivery({ locale: 'en', mailbox: MAILBOX, canRead: true }))
    expect(document.querySelector<HTMLElement>('[data-mail-track-status]')!.dataset.state).toBe('unavailable')
    const send = vi.fn()
    boot(renderMailTrackDelivery({ locale: 'en', mailbox: MAILBOX, canRead: false }), send); await tick()
    boot(renderMailTrackDelivery({ locale: 'en', mailbox: '', canRead: true }), send); await tick()
    expect(send).not.toHaveBeenCalled()
  })
  it('reads the session mailbox without an address selector and shows counts instead of other recipients', async () => {
    const send = vi.fn(async () => view())
    boot(renderMailTrackDelivery({ locale: 'en', mailbox: MAILBOX, canRead: true }), send); await tick()
    const path = (send.mock.calls[0] as unknown as [string, string])[1]
    expect(path).toMatch(/^\/api\/webmail\/track-delivery\?since=[^&]+&until=[^&]+$/)
    expect(path).not.toContain('alice')
    const rows = document.querySelectorAll('[data-mail-track-rows] tr')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('2 other recipients'); expect(rows[0]!.textContent).toContain('Bounced')
    expect(rows[1]!.textContent).toContain('dave@remote.test'); expect(rows[1]!.textContent).toContain('Received')
    rows[0]!.querySelector('button')!.click()
    expect(document.querySelector<HTMLElement>('[data-mail-track-detail]')!.hidden).toBe(false)
    expect(document.querySelector('[data-mail-track-detail-recipients]')!.textContent).toContain('Delivery details for other recipients are not shown')
    rows[1]!.querySelector('button')!.click()
    expect(document.querySelector('[data-mail-track-detail-recipients]')!.textContent).toContain('dovecot-lmtp')
    expect(document.querySelector('[data-mail-track-detail-events]')!.textContent).toContain('Delivery attempt to this mailbox')
    const filter = document.querySelector<HTMLSelectElement>('[name="status"]')!; filter.value = 'bounced'; filter.dispatchEvent(new Event('change'))
    expect(document.querySelectorAll('[data-mail-track-rows] tr')).toHaveLength(1)
    expect(MAIL_TRACK_DELIVERY_CLIENT_BINDING).not.toContain('innerHTML')
  })
  it('states unavailable, incomplete and refused reads truthfully in Arabic', async () => {
    boot(renderMailTrackDelivery({ locale: 'ar', mailbox: MAILBOX, canRead: true }), vi.fn(async () => view([], { state: 'unavailable', reason: 'journal_unavailable', complete: false })), true); await tick()
    expect(document.querySelector('[data-mail-track-status]')!.textContent).toBe('سجل بريد الخادم غير متاح. لا يُعرض شيء.')
    boot(renderMailTrackDelivery({ locale: 'ar', mailbox: MAILBOX, canRead: true }), vi.fn(async () => view()), true); await tick()
    expect(document.querySelector('[data-mail-track-status]')!.textContent).toBe('محاولات التسليم المقروءة: 2')
    expect(document.querySelector('[data-mail-track-rows] tr')!.textContent).toContain('مستلمان آخران')
    expect(document.querySelector('[data-mail-track-page-label]')!.textContent).toBe('الصفحة 1 من 1')
    boot(renderMailTrackDelivery({ locale: 'en', mailbox: MAILBOX, canRead: true }), vi.fn(async () => view([received()], { complete: false }))); await tick()
    expect(document.querySelector<HTMLElement>('[data-mail-track-incomplete]')!.hidden).toBe(false)
    boot(renderMailTrackDelivery({ locale: 'en', mailbox: MAILBOX, canRead: true }), vi.fn(async () => { throw Object.assign(new Error('forbidden'), { status: 403 }) })); await tick()
    expect(document.querySelector<HTMLElement>('[data-mail-track-status]')!.dataset.state).toBe('failed')
    expect(document.querySelectorAll('[data-mail-track-rows] button')).toHaveLength(0)
  })
})

describe('mailbox delivery timestamp precision', () => {
  it.each(['en', 'ar'] as const)('preserves complete observation, window, message and event UTC timestamps in %s', async locale => {
    const observedAt = '2026-10-27T12:34:56.789Z'
    const window = { since: '2026-10-26T12:00:00.123Z', until: '2026-10-27T12:00:00.456Z' }
    const firstSeen = '2026-10-27T10:01:02.345Z', lastSeen = '2026-10-27T10:02:03.456Z', eventAt = '2026-10-27T10:02:01.234Z'
    const item = { ...received(), firstSeen, lastSeen, events: [{ at: eventAt, kind: 'queued' }] }
    const send = vi.fn(async (_method: string, _path: string) => view([item], { observedAt, window }))
    boot(renderMailTrackDelivery({ locale, mailbox: MAILBOX, canRead: true }), send, locale === 'ar')
    await tick()
    expect(document.querySelector('[data-mail-track-fact="observed"]')!.textContent).toBe('2026-10-27 12:34 UTC')
    expect(document.querySelector('[data-mail-track-fact="window"]')!.textContent).toBe('2026-10-26 12:00 UTC – 2026-10-27 12:00 UTC')
    const row = document.querySelector<HTMLTableRowElement>('[data-mail-track-rows] tr')!
    expect(row.cells[0]!.querySelector('bdi[dir="ltr"]')!.textContent).toBe('2026-10-27 10:02 UTC')
    row.querySelector('button')!.click()
    const details = [...document.querySelectorAll('[data-mail-track-detail-facts] bdi[dir="ltr"]')].map(node => node.textContent)
    expect(details).toContain('2026-10-27 10:01 UTC')
    expect(details).toContain('2026-10-27 10:02 UTC')
    expect(document.querySelector('[data-mail-track-detail-events] strong bdi[dir="ltr"]')!.textContent).toBe('2026-10-27 10:02 UTC')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('GET', expect.stringMatching(/^\/api\/webmail\/track-delivery\?/))
  })
})
