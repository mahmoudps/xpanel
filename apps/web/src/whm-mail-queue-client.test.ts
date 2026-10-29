// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmMailQueueWorkspace } from './board-port/whm-mail-queue-workspace.ts'
import { readMailQueueActionResult, readMailQueueView, WHM_MAIL_QUEUE_CLIENT_BINDING } from './whm-mail-queue-client.ts'

const tick = async () => { for (let index = 0; index < 6; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const message = (queueId: string, queue: string, extra: Record<string, unknown> = {}) => ({ queueId, queue, arrivalTime: '2026-10-26T10:00:00.000Z', sizeBytes: 2048, sender: 'sender@example.test', recipients: [{ address: 'rcpt@example.net', delayReason: 'connect to mx.example.net: timed out' }], recipientCount: 1, forcedExpire: false, ...extra })
const view = (messages = [message('4F2A1B3C9D', 'deferred'), message('B0C1D2E3F4', 'hold', { sender: '', arrivalTime: '2026-10-27T09:30:00.000Z', recipients: [{ address: 'other@example.org', delayReason: null }, { address: 'x@example.org', delayReason: null }], recipientCount: 3 })]) => {
  const counts: Record<string, number> = { maildrop: 0, incoming: 0, active: 0, deferred: 0, hold: 0 }
  for (const item of messages) counts[item.queue as string]! += 1
  return { state: 'read', observedAt: '2026-10-27T10:00:00.000Z', revision: 'c'.repeat(64), truncated: false, counts, messages }
}
const result = (action: string, queueId: string, queue: string, outcome: string, after: { present: boolean | null; queue: string | null }) => ({ action, queueId, queue, outcome, verificationRequired: outcome === 'unknown', after, observedRevision: 'c'.repeat(64), revision: 'd'.repeat(64), observedAt: '2026-10-27T10:00:05.000Z' })
const status = () => document.querySelector<HTMLElement>('[data-whm-mail-queue-status]')!
const banner = () => document.querySelector<HTMLElement>('[data-whm-mail-queue-result]')!
const rowButton = (id: string, action: string) => document.querySelector<HTMLButtonElement>(`[data-queue-id="${id}"][data-whm-mail-queue-row-action="${action}"]`)!
const mount = (locale: 'en' | 'ar' = 'en', canRead = true, canManage = true) => { document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'; document.body.innerHTML = `<section data-whm-detail-route="/whm/email/queue" data-capability-state="authorized">${renderWhmMailQueueWorkspace({ locale, canRead, canManage })}</section>` }
const boot = (request?: (method: string, path: string, body?: unknown) => Promise<unknown>, ask?: (options: Record<string, unknown>) => Promise<unknown>) => {
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  new Function('return ' + WHM_MAIL_QUEUE_CLIENT_BINDING)()(ask)
}
beforeEach(() => { mount(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('mail queue client parsers', () => {
  it('accepts the projected queue and drops unknown fields', () => {
    const parsed = readMailQueueView({ ...view(), extra: 'x', messages: view().messages.map(item => ({ ...item, body: 'secret' })) })
    expect(parsed.messages).toHaveLength(2)
    expect(JSON.stringify(parsed)).not.toContain('secret')
    expect(readMailQueueView({ state: 'unavailable', observedAt: '2026-10-27T10:00:00.000Z', revision: null, truncated: false, counts: view([]).counts, messages: [], reason: 'command_failed' }).reason).toBe('command_failed')
  })
  it('refuses inconsistent counts, unsafe ids, oversized text and unread revisions', () => {
    for (const bad of [{ ...view(), counts: { ...view().counts, hold: 0 } }, view([message('ALL', 'deferred')]), view([message('4F2A1B3C9D', 'corrupt')]), view([message('4F2A1B3C9D', 'deferred', { sender: 'x'.repeat(600) })]),
      { ...view(), revision: null }, { ...view([]), state: 'unavailable' }, view([message('4F2A1B3C9D', 'deferred'), message('4F2A1B3C9D', 'deferred')]), view([message('4F2A1B3C9D', 'deferred', { recipientCount: 0 })])]) expect(() => readMailQueueView(bad)).toThrow()
  })
  it('never accepts deliver as confirmed or an outcome the re-read contradicts', () => {
    const input = { action: 'deliver', queueId: '4F2A1B3C9D', queue: 'deferred' }
    expect(readMailQueueActionResult(result('deliver', '4F2A1B3C9D', 'deferred', 'attempted', { present: true, queue: 'deferred' }), input).outcome).toBe('attempted')
    expect(() => readMailQueueActionResult(result('deliver', '4F2A1B3C9D', 'deferred', 'confirmed', { present: false, queue: null }), input)).toThrow()
    expect(() => readMailQueueActionResult(result('delete', '4F2A1B3C9D', 'deferred', 'confirmed', { present: true, queue: 'deferred' }), { ...input, action: 'delete' })).toThrow()
    expect(() => readMailQueueActionResult(result('delete', 'B0C1D2E3F4', 'deferred', 'confirmed', { present: false, queue: null }), { ...input, action: 'delete' })).toThrow()
  })
})

describe('mail queue client binding', () => {
  it('makes no request without transport or admission', async () => {
    boot(); expect(status().dataset.state).toBe('unavailable')
    mount('en', false); const send = vi.fn(); boot(send); await tick()
    expect(send).not.toHaveBeenCalled(); expect(status().dataset.state).toBe('unavailable')
    expect(WHM_MAIL_QUEUE_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_MAIL_QUEUE_CLIENT_BINDING).not.toContain('fetch(')
  })
  it('paints summary and rows, isolates technical values and filters client-side', async () => {
    const send = vi.fn(async () => view())
    boot(send); await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/server/mail-queue')
    expect(status().dataset.state).toBe('read')
    expect(document.querySelector('[data-whm-mail-queue-count="deferred"]')!.textContent).toBe('1')
    expect(document.querySelector('[data-whm-mail-queue-total-size]')!.textContent).toBe('4.0 KB')
    expect(document.querySelector('[data-whm-mail-queue-observed-at]')!.textContent).toBe('2026-10-27 10:00 UTC')
    const rows = document.querySelectorAll('[data-whm-mail-queue-rows] tr')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.querySelector('bdi[dir="ltr"]')!.textContent).toBe('4F2A1B3C9D')
    expect(rows[0]!.textContent).toContain('1 d')
    expect(rows[0]!.textContent).toContain('connect to mx.example.net: timed out')
    expect(rows[1]!.textContent).toContain('Null sender (bounce)')
    expect(rows[1]!.textContent).toContain('3 · other@example.org +2')
    expect(rowButton('4F2A1B3C9D', 'deliver').disabled).toBe(false)
    expect(rowButton('4F2A1B3C9D', 'release').disabled).toBe(true)
    expect(rowButton('B0C1D2E3F4', 'deliver').disabled).toBe(true)
    expect(rowButton('B0C1D2E3F4', 'release').disabled).toBe(false)
    const queue = document.querySelector<HTMLSelectElement>('[data-whm-mail-queue-filter="queue"]')!
    queue.value = 'hold'; queue.dispatchEvent(new Event('change'))
    expect(document.querySelectorAll('[data-whm-mail-queue-rows] tr')).toHaveLength(1)
    queue.value = ''; queue.dispatchEvent(new Event('change'))
    const text = document.querySelector<HTMLInputElement>('[data-whm-mail-queue-filter="text"]')!
    text.value = 'RCPT@'; text.dispatchEvent(new Event('input'))
    expect(document.querySelectorAll('[data-whm-mail-queue-rows] tr')).toHaveLength(1)
    text.value = ''; text.dispatchEvent(new Event('input'))
    const age = document.querySelector<HTMLSelectElement>('[data-whm-mail-queue-filter="age"]')!
    age.value = '86400'; age.dispatchEvent(new Event('change'))
    expect(document.querySelectorAll('[data-whm-mail-queue-rows] tr')).toHaveLength(1)
    age.value = '604800'; age.dispatchEvent(new Event('change'))
    expect(document.querySelector('[data-whm-mail-queue-rows]')!.textContent).toContain('No messages match the filters.')
  })
  it('shows truthful empty, unavailable and failed states', async () => {
    boot(async () => view([])); await tick()
    expect(status().dataset.state).toBe('empty'); expect(document.querySelector('[data-whm-mail-queue-rows]')!.textContent).toContain('The queue is empty.')
    mount(); boot(async () => ({ state: 'unavailable', observedAt: '2026-10-27T10:00:00.000Z', revision: null, truncated: false, counts: view([]).counts, messages: [], reason: 'malformed_output' })); await tick()
    expect(status().dataset.state).toBe('unavailable'); expect(status().textContent).toContain('could not be parsed')
    mount(); boot(async () => { throw new Error('down') }); await tick()
    expect(status().dataset.state).toBe('failed'); expect(status().getAttribute('role')).toBe('alert')
    mount(); boot(async () => ({ ...view(), truncated: true })); await tick()
    expect(document.querySelector<HTMLElement>('[data-whm-mail-queue-truncated]')!.hidden).toBe(false)
  })
  it('confirms delete, posts the exact intent and reports a confirmed re-read', async () => {
    const send = vi.fn(async (method: string, _path: string, body?: unknown) => method === 'GET' ? (send.mock.calls.length > 2 ? view([view().messages[1]!]) : view()) : result('delete', '4F2A1B3C9D', 'deferred', 'confirmed', { present: false, queue: null }))
    const ask = vi.fn(async () => true)
    boot(send, ask); await tick()
    rowButton('4F2A1B3C9D', 'delete').click(); await tick()
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ danger: true, title: 'Delete queued message?' }))
    expect(send).toHaveBeenCalledWith('POST', '/api/server/mail-queue/action', { action: 'delete', queueId: '4F2A1B3C9D', queue: 'deferred', expectedRevision: 'c'.repeat(64) })
    expect(banner().dataset.outcome).toBe('confirmed'); expect(banner().textContent).toContain('confirmed by a fresh queue read')
    expect(document.querySelectorAll('[data-whm-mail-queue-rows] tr')).toHaveLength(1)
  })
  it('sends nothing when hold or delete is not confirmed or no dialog exists', async () => {
    const send = vi.fn(async (_method: string, _path: string) => view())
    boot(send, async () => false); await tick()
    rowButton('4F2A1B3C9D', 'hold').click(); await tick()
    expect(send.mock.calls.every(call => call[0] === 'GET')).toBe(true)
    mount(); const second = vi.fn(async (_method: string, _path: string) => view()); boot(second); await tick()
    rowButton('4F2A1B3C9D', 'delete').click(); await tick()
    expect(second.mock.calls.every(call => call[0] === 'GET')).toBe(true)
    expect(banner().textContent).toContain('Confirmation is unavailable')
  })
  it('reports retry as attempted with the current queue, and conflicts and unknown outcomes truthfully', async () => {
    let reply: () => unknown = () => result('deliver', '4F2A1B3C9D', 'deferred', 'attempted', { present: true, queue: 'deferred' })
    boot(async method => method === 'GET' ? view() : reply()); await tick()
    rowButton('4F2A1B3C9D', 'deliver').click(); await tick()
    expect(banner().dataset.outcome).toBe('attempted'); expect(banner().textContent).toContain('now in the Deferred queue. Delivery is not verified.')
    expect(banner().textContent).not.toMatch(/delivered/i)
    reply = () => { throw Object.assign(new Error('moved'), { status: 409, code: 'CONFLICT', details: { stateChanged: false } }) }
    rowButton('4F2A1B3C9D', 'deliver').click(); await tick()
    expect(banner().dataset.outcome).toBe('conflict'); expect(banner().textContent).toContain('Nothing was changed')
    reply = () => { throw Object.assign(new Error('lost'), { status: 503, details: { stateChanged: true, unknownOutcome: true } }) }
    rowButton('4F2A1B3C9D', 'deliver').click(); await tick()
    expect(banner().dataset.outcome).toBe('unknown'); expect(banner().getAttribute('role')).toBe('alert')
    reply = () => ({ ...result('deliver', '4F2A1B3C9D', 'deferred', 'confirmed', { present: false, queue: null }) })
    rowButton('4F2A1B3C9D', 'deliver').click(); await tick()
    expect(banner().dataset.outcome).toBe('unknown')
  })
  it('runs bulk actions sequentially with per-row results, skipping inapplicable rows', async () => {
    const order: string[] = []
    const send = vi.fn(async (method: string, _path: string, body?: unknown) => {
      if (method === 'GET') return view()
      const queueId = (body as { queueId: string }).queueId
      order.push(queueId)
      return result('hold', queueId, 'deferred', 'confirmed', { present: true, queue: 'hold' })
    })
    const ask = vi.fn(async () => true)
    boot(send, ask); await tick()
    const all = document.querySelector<HTMLInputElement>('[data-whm-mail-queue-select-all]')!
    all.checked = true; all.dispatchEvent(new Event('change'))
    expect(document.querySelector('[data-whm-mail-queue-selected]')!.textContent).toBe('Selected: 2')
    document.querySelector<HTMLButtonElement>('[data-whm-mail-queue-bulk="hold"]')!.click(); await tick()
    expect(order).toEqual(['4F2A1B3C9D'])
    const items = document.querySelectorAll<HTMLElement>('[data-whm-mail-queue-results] li')
    expect([...items].map(item => item.dataset.outcome)).toEqual(['confirmed', 'skipped'])
    expect(banner().textContent).toContain('Bulk run finished: 1 confirmed, 0 attempted, 0 unknown, 1 refused or skipped.')
    expect(document.querySelector('[data-whm-mail-queue-selected]')!.textContent).toBe('Selected: 0')
  })
  it('stops a bulk run when authorization is lost and refuses more than 50 messages', async () => {
    const many = Array.from({ length: 51 }, (_, index) => message('ABCDEF' + String(index).padStart(2, '0'), 'deferred'))
    const send = vi.fn(async (method: string) => method === 'GET' ? view(many) : Promise.reject(Object.assign(new Error('forbidden'), { status: 403, details: {} })))
    boot(send, async () => true); await tick()
    const all = document.querySelector<HTMLInputElement>('[data-whm-mail-queue-select-all]')!
    all.checked = true; all.dispatchEvent(new Event('change'))
    document.querySelector<HTMLButtonElement>('[data-whm-mail-queue-bulk="delete"]')!.click(); await tick()
    expect(banner().textContent).toContain('at most 50')
    expect(send.mock.calls.filter(call => call[0] === 'POST')).toHaveLength(0)
    document.querySelectorAll<HTMLInputElement>('[data-whm-mail-queue-select]')[50]!.click()
    document.querySelector<HTMLButtonElement>('[data-whm-mail-queue-bulk="delete"]')!.click(); await tick()
    expect(send.mock.calls.filter(call => call[0] === 'POST')).toHaveLength(1)
    expect(banner().dataset.outcome).toBe('denied')
    expect(banner().textContent).toContain('Remaining messages were not sent.')
  })
  it('renders Arabic copy with ASCII digits', async () => {
    mount('ar'); boot(async () => view()); await tick()
    expect(status().textContent).toBe('قُرئ الطابور من Postfix.')
    expect(document.querySelector('[data-whm-mail-queue-rows]')!.textContent).toContain('مرسل فارغ (ارتداد)')
    expect(document.querySelector('[data-whm-mail-queue-rows]')!.textContent).toContain('يوم واحد')
    expect(document.querySelector('[data-whm-mail-queue-selected]')!.textContent).toBe('المحدد: 0')
    expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
})

describe('mail queue timestamp precision', () => {
  it.each(['en', 'ar'] as const)('preserves complete observation and arrival UTC timestamps in %s', async locale => {
    const observedAt = '2026-10-27T12:34:56.789Z', arrivalTime = '2026-10-26T10:01:02.345Z'
    mount(locale)
    const send = vi.fn(async (_method: string, _path: string) => ({ ...view([message('4F2A1B3C9D', 'deferred', { arrivalTime })]), observedAt }))
    boot(send)
    await tick()
    const observed = document.querySelector<HTMLElement>('[data-whm-mail-queue-observed-at]')!
    expect(observed.textContent).toBe('2026-10-27 12:34 UTC')
    expect(observed.getAttribute('dir')).toBe('ltr')
    const arrival = document.querySelector<HTMLTableRowElement>('[data-whm-mail-queue-rows] tr')!.cells[3]!.querySelector('bdi[dir="ltr"]')!
    expect(arrival.textContent).toBe('2026-10-26 10:01 UTC')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('GET', '/api/server/mail-queue')
  })
})
