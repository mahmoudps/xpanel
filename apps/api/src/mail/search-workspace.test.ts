import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { Db } from '@xpanel/db'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from '../auth.ts'
import { MimeCodecAndSanitizer } from './mime.ts'
import type { ImapConnectionConfig, ImapFetchedMessage, ImapSelectedMailboxState } from './imap.ts'
import { createMailSearchWorkspace, parseMailSearch } from './search-workspace.ts'
import type { MailSearchClient, MailSearchSession } from './search-workspace.ts'

// Declared native-transport/session doubles isolate search authority and data contracts.
// Real sealed-session HTTP admission is covered by the API composition acceptance.
const mailbox = 'reader@example.test', caller = {} as AuthenticatedCaller
const codec = new MimeCodecAndSanitizer()
function message(uid: number, body = 'Synthetic plain text'): ImapFetchedMessage {
  const rawMime = 'From: sender@example.test\r\nTo: reader@example.test\r\nSubject: Synthetic search message\r\nDate: Mon, 26 Oct 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n' + body
  return { mailbox, folder: 'INBOX', uid, uidValidity: 17, flags: [], internalDate: null, sizeBytes: Buffer.byteLength(rawMime), rawMime,
    rawMimeBytes: Buffer.from(rawMime), rfc822SizeObserved: true, bodyComplete: true, parsed: codec.parseMimeMessage(rawMime), attachmentTokens: [] }
}
function fixture() {
  const session: MailSearchSession = { record: { sessionId: 'synthetic-session', mailbox, accountId: 'synthetic-account', serviceUserId: 'synthetic-service' }, password: randomBytes(24).toString('hex') }
  let messages = [message(1), message(9), message(5), message(7)], validity = 17, observed = true, clock = Date.parse('2026-10-26T10:00:00Z')
  const state = (folder = 'INBOX'): ImapSelectedMailboxState => ({ folder, exists: messages.length, recent: 0, uidValidity: validity,
    uidValidityObserved: observed, uidNext: 10, flags: [], resynced: false, previousUidValidity: null })
  const client = {
    connect: vi.fn(async () => '* OK synthetic transport'), login: vi.fn(async () => undefined), logout: vi.fn(async () => undefined),
    selectFolder: vi.fn(async (folder: string) => state(folder)), searchByUtf8Query: vi.fn(async () => messages.map(item => item.uid)),
    fetchMessagesByUid: vi.fn(async (folder: string, uid: string | number) => ({ state: state(folder), messages: messages.filter(item => item.uid === Number(uid)).map(item => ({ ...item, folder })) })),
  } satisfies MailSearchClient
  const openSession = vi.fn(async () => structuredClone(session))
  const clientFactory = vi.fn((_config: ImapConnectionConfig) => client)
  const workspace = createMailSearchWorkspace({ db: {} as Db, store: {} as StateStore, serverSecret: randomBytes(32).toString('hex'),
    env: { XPANEL_IMAP_HOST: '127.0.0.1', XPANEL_IMAP_PORT: '143', XPANEL_IMAP_TIMEOUT_MS: '500' }, openSession, clientFactory, now: () => clock })
  return { workspace, client, clientFactory, openSession, session, state, setMessages: (value: ImapFetchedMessage[]) => { messages = value },
    setValidity: (value: number) => { validity = value }, setObserved: (value: boolean) => { observed = value }, advance: (ms: number) => { clock += ms } }
}
const query = (extra = '') => new URLSearchParams('q=invoice&limit=2' + extra)

describe('native mailbox search workspace', () => {
  it.each(['', 'q=', 'q=x&limit=0', 'q=x&limit=51', 'q=x&limit=1e1', 'q=x&q=y', 'q=x&mailbox=other%40example.test', 'q=x&accountId=other', 'q=x&cursor=', 'q=x%0d%0aLOGIN'])('refuses invalid or selector-bearing query %s before transport access', async input => {
    const f = fixture()
    await expect(f.workspace.search(caller, new URLSearchParams(input))).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(f.openSession).not.toHaveBeenCalled(); expect(f.clientFactory).not.toHaveBeenCalled()
  })
  it('normalizes bounded UTF-8 search text without changing the authoritative folder grammar', () => {
    expect(parseMailSearch(new URLSearchParams({ q: '  فاتورة 42 ', folder: 'Archive', limit: '50' }))).toEqual({ query: 'فاتورة 42', folder: 'Archive', limit: 50, cursor: null })
    expect(() => parseMailSearch(new URLSearchParams({ q: 'x'.repeat(257) }))).toThrow()
  })
  it('uses real-provider query arguments and bounded config, with safe public projection', async () => {
    const f = fixture(), result = await f.workspace.search(caller, query())
    expect(result.messages.map(item => item.uid)).toEqual([9, 7])
    expect(result.context).toEqual({ mailbox, folder: 'INBOX', uidValidity: 17, query: 'invoice' })
    expect(result.page).toMatchObject({ limit: 2, totalMatches: 4, nextCursor: expect.any(String) })
    expect(f.clientFactory.mock.calls[0]?.[0]).toMatchObject({ tls: false, rejectUnauthorized: true, maxLiteralBytes: 8 * 1024 * 1024, maxResponseLineBytes: 1024 * 1024, maxSearchResults: 50000 })
    expect(f.client.searchByUtf8Query).toHaveBeenCalledWith('INBOX', 'invoice', mailbox)
    expect(JSON.stringify(result)).not.toMatch(/rawMime|attachmentTokens|synthetic-session/)
    expect(JSON.stringify(result)).not.toContain(f.session.password)
    expect(f.openSession).toHaveBeenCalledTimes(3); expect(f.client.logout).toHaveBeenCalledTimes(1)
  })
  it('paginates by a signed mailbox/query/UIDVALIDITY-bound cursor without repeating rows', async () => {
    const f = fixture(), first = await f.workspace.search(caller, query())
    const next = query(); next.set('cursor', first.page.nextCursor!)
    const second = await f.workspace.search(caller, next)
    expect(second.messages.map(item => item.uid)).toEqual([5, 1]); expect(second.page.nextCursor).toBeNull()
    const wrong = new URLSearchParams(next); wrong.set('q', 'different')
    await expect(f.workspace.search(caller, wrong)).rejects.toMatchObject({ code: 'VALIDATION' })
    f.session.record.mailbox = 'foreign@example.test'
    await expect(f.workspace.search(caller, next)).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('refuses tampered, expired and stale-generation cursors', async () => {
    const f = fixture(), first = await f.workspace.search(caller, query()), params = query()
    params.set('cursor', 'x' + first.page.nextCursor!.slice(1))
    await expect(f.workspace.search(caller, params)).rejects.toMatchObject({ code: 'VALIDATION' })
    params.set('cursor', first.page.nextCursor!); f.setValidity(18)
    await expect(f.workspace.search(caller, params)).rejects.toMatchObject({ code: 'CONFLICT' })
    f.setValidity(17); f.advance(15 * 60 * 1000 + 1)
    await expect(f.workspace.search(caller, params)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'mail_search_cursor_expired' } })
  })
  it('returns observed empty results only after a completed search and final identity check', async () => {
    const f = fixture(); f.setMessages([])
    expect(await f.workspace.search(caller, query())).toMatchObject({ messages: [], page: { totalMatches: 0, nextCursor: null } })
    expect(f.client.searchByUtf8Query).toHaveBeenCalledTimes(1); expect(f.client.selectFolder).toHaveBeenCalledTimes(2)
  })
  it('refuses a missing identity observation before issuing a search', async () => {
    const f = fixture(); f.setObserved(false)
    await expect(f.workspace.search(caller, query())).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'mail_search_identity_unobserved' } })
    expect(f.client.searchByUtf8Query).not.toHaveBeenCalled()
  })
  it('refuses UIDVALIDITY changes even when the search returned no messages', async () => {
    const f = fixture(); f.setMessages([])
    f.client.selectFolder.mockResolvedValueOnce(f.state()).mockResolvedValueOnce({ ...f.state(), uidValidity: 18 })
    await expect(f.workspace.search(caller, query())).rejects.toMatchObject({ code: 'CONFLICT' })
  })
  it('refuses mismatched or changed identities from a fetched message', async () => {
    const f = fixture(); f.setMessages([{ ...message(9), mailbox: 'foreign@example.test' }])
    await expect(f.workspace.search(caller, query())).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    f.setMessages([{ ...message(9), uidValidity: 18 }])
    await expect(f.workspace.search(caller, query())).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('does not return results after current mailbox authority changed', async () => {
    const f = fixture()
    f.openSession.mockImplementationOnce(async () => structuredClone(f.session)).mockImplementationOnce(async () => structuredClone(f.session)).mockImplementationOnce(async () => {
      return { ...structuredClone(f.session), record: { ...f.session.record, serviceUserId: 'replacement-service' } }
    })
    await expect(f.workspace.search(caller, query())).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('sanitizes native transport errors instead of fabricating empty results', async () => {
    const f = fixture(); f.client.searchByUtf8Query.mockImplementationOnce(async () => fail('PRECONDITION_FAILED', 'IMAP SEARCH failed: SYNTHETIC-PRIVATE-MARKER'))
    await expect(f.workspace.search(caller, query())).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'mail search could not read the mail server' })
    expect(f.client.logout).toHaveBeenCalledTimes(1)
  })
  it('bounds cumulative fetched bytes before returning a page', async () => {
    const f = fixture()
    f.setMessages([1, 2, 3].map(uid => ({ ...message(uid), sizeBytes: 6 * 1024 * 1024, rawMimeBytes: Buffer.alloc(6 * 1024 * 1024) })))
    await expect(f.workspace.search(caller, new URLSearchParams('q=invoice&limit=3'))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'mail_search_capacity' } })
  })
  it('reads an exact selected message without marking it seen or exposing MIME/attachment bytes', async () => {
    const f = fixture(), result = await f.workspace.read(caller, new URLSearchParams('uid=9&folder=INBOX&uidValidity=17'))
    expect(result.context).toEqual({ mailbox, folder: 'INBOX', uidValidity: 17 })
    expect(result.message).toMatchObject({ uid: 9, body: 'Synthetic plain text', unread: true })
    expect(result.bodyTruncated).toBe(false)
    expect(JSON.stringify(result)).not.toMatch(/rawMime|attachmentTokens/)
    expect(JSON.stringify(result)).not.toContain(f.session.password)
  })
  it('truncates UTF-8 preview bytes without splitting a character and labels that limit', async () => {
    const f = fixture(), body = 'x' + 'ن'.repeat(200000); f.setMessages([message(1, body)])
    const result = await f.workspace.read(caller, new URLSearchParams('uid=1&uidValidity=17'))
    expect(result.bodyTruncated).toBe(true); expect(Buffer.byteLength(result.message.body)).toBe(256 * 1024 - 1)
    expect(body.startsWith(result.message.body)).toBe(true); expect(result.message.body).not.toContain('\ufffd')
  })
  it('refuses a stale detail generation, absent message and sealed selector', async () => {
    const f = fixture()
    await expect(f.workspace.read(caller, new URLSearchParams('uid=9&uidValidity=18'))).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(f.workspace.read(caller, new URLSearchParams('uid=8&uidValidity=17'))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(f.workspace.read(caller, new URLSearchParams('uid=9&uidValidity=17&mailbox=foreign%40example.test'))).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it.each([{ rfc822SizeObserved: false }, { bodyComplete: false }, { sizeBytes: 0 }])('refuses absent or contradictory complete-source proof %s', async patch => {
    const f = fixture(); f.setMessages([{ ...message(1), ...patch }])
    await expect(f.workspace.read(caller, new URLSearchParams('uid=1&uidValidity=17'))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'mail_search_source_unverified' } })
  })
  it.each(['rfc822SizeObserved', 'bodyComplete', 'rawMimeBytes'] as const)('refuses an omitted full-source proof field %s', async field => {
    const f = fixture(), source = message(1)
    delete source[field]
    f.setMessages([source])
    await expect(f.workspace.read(caller, new URLSearchParams('uid=1&uidValidity=17'))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'mail_search_source_unverified' } })
  })
})
