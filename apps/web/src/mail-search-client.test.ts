// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderMailSearchWorkspace } from './board-port/xmail-search.ts'
import { MAIL_SEARCH_CLIENT_BINDING, mailSearchQuery, readMailSearchMessage, readMailSearchPage } from './mail-search-client.ts'

const mailbox = 'reader@example.test', folder = 'INBOX', uidValidity = 9
const summary = (uid = 13, patch: Record<string, unknown> = {}) => ({ uid, from: 'sender@example.test', fromName: 'Sender', to: mailbox, subject: 'Search result', receivedAt: '2026-10-26T12:00:00.000Z', preview: 'Matching text', unread: true, sizeBytes: 64, ...patch })
const page = (query = 'needle', messages = [summary()], patch: Record<string, unknown> = {}) => ({ context: { mailbox, folder, uidValidity, query }, messages, page: { limit: 20, totalMatches: messages.length, nextCursor: null }, ...patch })
const detail = (uid = 13, patch: Record<string, unknown> = {}) => ({ context: { mailbox, folder, uidValidity }, message: { ...summary(uid), body: 'Plain text body' }, bodyTruncated: false, ...patch })
const expected = { mailbox, folder, query: 'needle', limit: 20 }
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const query = () => document.querySelector<HTMLInputElement>('[data-mail-search-query]')!
const status = () => document.querySelector<HTMLElement>('[data-mail-search-status]')!
const results = () => document.querySelector<HTMLElement>('[data-mail-search-results]')!
const message = () => document.querySelector<HTMLElement>('[data-mail-search-message]')!
const button = (name: string) => document.querySelector<HTMLButtonElement>('[data-mail-search-' + name + ']')!
const input = (value: string) => { query().value = value; query().dispatchEvent(new Event('input')) }
const submit = () => document.querySelector<HTMLFormElement>('[data-mail-search-form]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
const boot = (transport?: ReturnType<typeof vi.fn>) => {
  if (transport) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = transport
  new Function('return ' + MAIL_SEARCH_CLIENT_BINDING)()(undefined)
}
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

beforeEach(() => {
  document.body.innerHTML = renderMailSearchWorkspace({ locale: 'en', mailbox, available: true })
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
})
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('mail search response boundaries', () => {
  it('normalizes valid Unicode queries and rejects empty, excessive and control-character input', () => {
    expect(mailSearchQuery('  cafe\u0301  ')).toBe('café')
    expect(mailSearchQuery('😀'.repeat(256))).toBe('😀'.repeat(256))
    for (const value of ['', ' ', 'a'.repeat(257), '😀'.repeat(257), 'a\u0000b', 'a\u0085b', '\ud800']) expect(() => mailSearchQuery(value)).toThrow()
  })
  it('checks the pinned mailbox, query, folder, validity and signed cursor without rewriting it', () => {
    const cursor = 'signed.cursor_value-1'
    expect(readMailSearchPage(page('needle', [summary()], { page: { limit: 20, totalMatches: 2, nextCursor: cursor } }), expected).page.nextCursor).toBe(cursor)
    for (const context of [{ ...page().context, mailbox: 'other@example.test' }, { ...page().context, folder: 'Trash' }, { ...page().context, query: 'other' }, { ...page().context, uidValidity: 0 }]) expect(() => readMailSearchPage({ ...page(), context }, expected)).toThrow()
    expect(() => readMailSearchPage(page(), { ...expected, uidValidity: 10 })).toThrow()
    expect(() => readMailSearchPage(page('needle', [summary(), summary()]), expected)).toThrow()
    expect(() => readMailSearchPage(page('needle', [], { page: { limit: 20, totalMatches: 0, nextCursor: cursor } }), expected)).toThrow()
  })
  it('distinguishes proven zero matches from changed or missing result pages', () => {
    expect(readMailSearchPage(page('needle', []), expected).page.totalMatches).toBe(0)
    expect(() => readMailSearchPage(page('needle', [], { page: { limit: 20, totalMatches: 3, nextCursor: null } }), expected)).toThrow('search_page_changed')
  })
  it('requires an exact native message identity and bounded plain text', () => {
    const selected = { mailbox, folder, uid: 13, uidValidity }
    expect(readMailSearchMessage(detail(), selected).message.body).toBe('Plain text body')
    for (const value of [detail(14), detail(13, { context: { mailbox, folder: 'Sent', uidValidity } }), detail(13, { context: { mailbox: 'other@example.test', folder, uidValidity } }), detail(13, { context: { mailbox, folder, uidValidity: 10 } }), detail(13, { message: { ...summary(), body: '😀'.repeat(65537) } }), { message: { id: 'json-message-fallback', body: 'wrong source' } }]) expect(() => readMailSearchMessage(value, selected)).toThrow()
    expect(() => readMailSearchMessage(detail(13, { context: { mailbox, folder, uidValidity: 0 } }), { ...selected, uidValidity: 0 })).toThrow()
  })
})

describe('mail search browser controller', () => {
  it('has no direct fetch, HTML insertion or automatic read before a query submit', () => {
    expect(() => new Function('return ' + MAIL_SEARCH_CLIENT_BINDING)()).not.toThrow()
    expect(MAIL_SEARCH_CLIENT_BINDING).not.toContain('fetch(')
    expect(MAIL_SEARCH_CLIENT_BINDING).not.toContain('innerHTML')
    const transport = vi.fn(); boot(transport)
    expect(transport).not.toHaveBeenCalled(); expect(status().dataset.state).toBe('idle')
  })
  it('sends only an encoded mailbox-scoped search and displays verified results as text', async () => {
    const transport = vi.fn(async (method: string, path: string) => {
      expect(method).toBe('GET')
      const url = new URL(path, 'http://localhost')
      expect(url.pathname).toBe('/api/webmail/search'); expect(url.searchParams.get('q')).toBe('café'); expect(url.searchParams.get('folder')).toBe(folder)
      expect(url.searchParams.get('limit')).toBe('20'); expect(url.searchParams.has('mailbox')).toBe(false)
      return page('café', [summary(13, { subject: '<img src=x>', fromName: '<script>bad()</script>' })])
    })
    boot(transport); input(' cafe\u0301 '); submit(); await tick()
    expect(status().dataset.state).toBe('read'); expect(transport).toHaveBeenCalledTimes(1)
    expect(results().textContent).toContain('<img src=x>'); expect(document.querySelector('img,script')).toBeNull()
    expect(results().querySelector('a')).toBeNull()
  })
  it('does not send invalid input or work in an unavailable inherited scope', async () => {
    const transport = vi.fn(); boot(transport); input('x\u0000y'); submit(); await tick()
    expect(transport).not.toHaveBeenCalled(); expect(status().dataset.state).toBe('failed')
    document.body.innerHTML = '<fieldset disabled>' + renderMailSearchWorkspace({ locale: 'en', mailbox, available: true }) + '</fieldset>'
    boot(transport); expect(status().dataset.state).toBe('unavailable'); expect(transport).not.toHaveBeenCalled()
  })
  it('paginates using the unchanged opaque cursor and does not append duplicate message identities', async () => {
    const cursor = 'signed.cursor_value-1'
    const transport = vi.fn(async (_method: string, path: string) => {
      const current = new URL(path, 'http://localhost').searchParams.get('cursor')
      return current === null ? page('needle', [summary()], { page: { limit: 20, totalMatches: 2, nextCursor: cursor } }) : (expect(current).toBe(cursor), page('needle', [summary(14)], { page: { limit: 20, totalMatches: 2, nextCursor: null } }))
    })
    boot(transport); input('needle'); submit(); await tick(); button('next').click(); await tick()
    expect(results().querySelectorAll('button')).toHaveLength(2); expect(button('next').disabled).toBe(true)
    expect(status().textContent).toContain('2 / 2')
  })
  it('requires a fresh search after an expired cursor and preserves the query and prior rows', async () => {
    const transport = vi.fn().mockResolvedValueOnce(page('needle', [summary()], { page: { limit: 20, totalMatches: 2, nextCursor: 'opaque-cursor' } })).mockRejectedValueOnce({ status: 409 })
    boot(transport); input('needle'); submit(); await tick(); button('next').click(); await tick()
    expect(status().dataset.state).toBe('stale'); expect(query().value).toBe('needle')
    expect(results().querySelectorAll('button')).toHaveLength(1); expect(button('next').disabled).toBe(true)
    expect(transport).toHaveBeenCalledTimes(2)
  })
  it('opens an exact native message and emits attachment identity only after verified detail', async () => {
    const events: unknown[] = []
    const listener = (event: Event) => events.push((event as CustomEvent).detail)
    document.addEventListener('xpanel:mail-search-selection', listener)
    try {
      const transport = vi.fn(async (_method: string, path: string) => path.startsWith('/api/webmail/search-message?') ? detail(13, { message: { ...summary(), body: '<img src=x>\nPlain text' }, bodyTruncated: true }) : page())
      boot(transport); input('needle'); submit(); await tick(); results().querySelector<HTMLButtonElement>('button')!.click(); await tick()
      expect(message().hidden).toBe(false); expect(document.querySelector('[data-mail-search-body]')!.textContent).toBe('<img src=x>\nPlain text')
      expect(document.querySelector('img')).toBeNull(); expect(document.querySelector<HTMLElement>('[data-mail-search-truncated]')!.hidden).toBe(false)
      expect(events).toEqual([{ mailbox, folder, uid: 13, uidValidity }])
      const request = new URL(transport.mock.calls[1]![1], 'http://localhost')
      expect(request.searchParams.get('uid')).toBe('13'); expect(request.searchParams.get('uidValidity')).toBe('9'); expect(request.searchParams.has('mailbox')).toBe(false)
    } finally { document.removeEventListener('xpanel:mail-search-selection', listener) }
  })
  it('refuses a wrong-UID detail without showing a prior body or selecting attachments', async () => {
    const selected = vi.fn(); document.addEventListener('xpanel:mail-search-selection', selected)
    try {
      const transport = vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(detail(14))
      boot(transport); input('needle'); submit(); await tick(); results().querySelector<HTMLButtonElement>('button')!.click(); await tick()
      expect(status().dataset.state).toBe('failed'); expect(message().hidden).toBe(true); expect(selected).not.toHaveBeenCalled()
      expect(document.querySelector('[data-mail-search-body]')!.textContent).toBe('')
    } finally { document.removeEventListener('xpanel:mail-search-selection', selected) }
  })
  it('prevents a delayed prior query from overwriting a later completed search', async () => {
    const old = deferred<ReturnType<typeof page>>()
    const transport = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(page('second', [summary(14, { subject: 'Newest result' })]))
    boot(transport); input('first'); submit(); input('second'); submit(); await tick()
    old.resolve(page('first', [summary(13, { subject: 'Old delayed result' })])); await tick()
    expect(results().textContent).toContain('Newest result'); expect(results().textContent).not.toContain('Old delayed result')
    expect(query().value).toBe('second'); expect(status().dataset.state).toBe('read')
  })
  it('clears and logically cancels pending reads so late results never reappear', async () => {
    const pending = deferred<ReturnType<typeof page>>(), transport = vi.fn().mockReturnValue(pending.promise)
    boot(transport); input('needle'); submit(); button('clear').click(); pending.resolve(page()); await tick()
    expect(results().textContent).toBe(''); expect(query().value).toBe(''); expect(message().hidden).toBe(true); expect(status().dataset.state).toBe('idle')
    expect(transport).toHaveBeenCalledTimes(1)
  })
  it('suppresses a late canceled detail response and its attachment-selection event', async () => {
    const pending = deferred<ReturnType<typeof detail>>(), selected = vi.fn()
    document.addEventListener('xpanel:mail-search-selection', selected)
    try {
      const transport = vi.fn().mockResolvedValueOnce(page()).mockReturnValueOnce(pending.promise)
      boot(transport); input('needle'); submit(); await tick(); results().querySelector<HTMLButtonElement>('button')!.click()
      button('clear').click(); pending.resolve(detail()); await tick()
      expect(message().hidden).toBe(true); expect(selected).not.toHaveBeenCalled(); expect(status().dataset.state).toBe('idle')
    } finally { document.removeEventListener('xpanel:mail-search-selection', selected) }
  })
  it('invalidates old-folder pagination and detail controls while preserving the query draft', async () => {
    const transport = vi.fn().mockResolvedValue(page('needle', [summary()], { page: { limit: 20, totalMatches: 2, nextCursor: 'opaque-cursor' } }))
    boot(transport); input('needle'); submit(); await tick()
    const select = document.querySelector<HTMLSelectElement>('[data-mail-search-folder]')!; select.value = 'Junk'; select.dispatchEvent(new Event('change'))
    expect(query().value).toBe('needle'); expect(button('next').disabled).toBe(true)
    expect(results().querySelector<HTMLButtonElement>('button')!.disabled).toBe(true)
    expect(message().hidden).toBe(true); expect(status().dataset.state).toBe('dirty'); expect(transport).toHaveBeenCalledTimes(1)
  })
  it('distinguishes empty matches from changed pages and keeps failures explicit', async () => {
    const transport = vi.fn().mockResolvedValueOnce(page('needle', [])).mockResolvedValueOnce(page('needle', [], { page: { limit: 20, totalMatches: 3, nextCursor: null } })).mockRejectedValueOnce(new Error('network'))
    boot(transport); input('needle'); submit(); await tick(); expect(status().dataset.state).toBe('no-matches')
    submit(); await tick(); expect(status().dataset.state).toBe('stale')
    submit(); await tick(); expect(status().dataset.state).toBe('failed'); expect(query().value).toBe('needle')
  })
})


describe('reachable metadata datetime', () => {
  it.each(['en', 'ar'] as const)('renders readable result and selected dates in %s while keeping raw queries and message source', async locale => {
    const receivedAt = '2026-10-27T12:34:56.123456Z', queryText = 'Date 2026-10-27T12:34:56.123456Z'
    const rawBody = 'Date: 2026-10-27T12:34:56.123456Z\r\nDTSTART:20261027T123456Z\r\nOriginal body'
    const item = summary(13, { receivedAt, subject: queryText })
    const wireDetail = detail(13, { message: { ...item, body: rawBody } })
    const transport = vi.fn(async (_method: string, path: string) => new URL(path, 'http://fixture.test').pathname === '/api/webmail/search-message' ? wireDetail : page(queryText, [item]))
    document.body.innerHTML = renderMailSearchWorkspace({ locale, mailbox, available: true })
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = transport
    new Function('return ' + MAIL_SEARCH_CLIENT_BINDING)()(undefined)
    input(queryText); submit(); await tick()
    const result = results().querySelector<HTMLButtonElement>('button')!
    expect(result.querySelectorAll('bdi')[1]!.textContent).toBe('2026-10-27 12:34 UTC')
    expect(result.querySelector('strong')!.textContent).toBe(queryText)
    result.click(); await tick()
    expect(document.querySelector('[data-mail-search-date]')!.textContent).toBe('2026-10-27 12:34 UTC')
    expect(document.querySelector('[data-mail-search-body]')!.textContent).toBe(rawBody)
    expect(readMailSearchMessage(wireDetail, { mailbox, folder, uid: 13, uidValidity }).message.receivedAt).toBe(receivedAt)
    const first = new URL(transport.mock.calls[0]![1], 'http://fixture.test'), second = new URL(transport.mock.calls[1]![1], 'http://fixture.test')
    expect(first.searchParams.get('q')).toBe(queryText)
    expect(second.searchParams.get('uid')).toBe('13')
    expect(second.searchParams.get('uidValidity')).toBe('9')
    expect(second.searchParams.get('folder')).toBe('INBOX')
    expect(transport.mock.calls.every(call => call[0] === 'GET')).toBe(true)
  })
})

describe('reachable metadata datetime external sources', () => {
  it.each((['en', 'ar'] as const).flatMap(locale => ([['Tue, 27 Oct 2026 12:34:56 GMT', '2026-10-27 12:34 UTC'], ['2026-10-27T12:34Z', '2026-10-27 12:34 UTC']] as const).map(([receivedAt, expected]) => [locale, receivedAt, expected] as const)))('formats accepted external result and selected dates in %s for %s without changing source', async (locale, receivedAt, expected) => {
    const queryText = 'Original query 2026-10-27T12:34Z', item = summary(13, { receivedAt })
    const wireDetail = detail(13, { message: { ...item, body: 'Original source DTSTART:20261027T123456Z' } })
    const transport = vi.fn(async (_method: string, path: string) => new URL(path, 'http://fixture.test').pathname === '/api/webmail/search-message' ? wireDetail : page(queryText, [item]))
    document.body.innerHTML = renderMailSearchWorkspace({ locale, mailbox, available: true })
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = transport
    new Function('return ' + MAIL_SEARCH_CLIENT_BINDING)()(undefined)
    input(queryText); submit(); await tick()
    const result = results().querySelector<HTMLButtonElement>('button')!
    expect(result.querySelectorAll('bdi')[1]!.textContent).toBe(expected)
    result.click(); await tick()
    expect(document.querySelector('[data-mail-search-date]')!.textContent).toBe(expected)
    expect(readMailSearchMessage(wireDetail, { mailbox, folder, uid: 13, uidValidity }).message.receivedAt).toBe(receivedAt)
    expect(document.querySelector('[data-mail-search-body]')!.textContent).toBe(wireDetail.message.body)
    expect(new URL(transport.mock.calls[0]![1], 'http://fixture.test').searchParams.get('q')).toBe(queryText)
    expect(transport.mock.calls.every(call => call[0] === 'GET')).toBe(true)
  })
})
