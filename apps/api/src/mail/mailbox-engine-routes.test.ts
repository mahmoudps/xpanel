import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import { handleMailboxEngineRoute } from './mailbox-engine-routes.ts'
import type { MailboxEnginePorts } from './mailbox-engine-routes.ts'

const session = { caller: { principal: { id: 'p' } } as never, mailbox: 'info@alice.test' }
const moved = { ok: true, uid: 9, destinationUidKnown: true, stateChanged: true, folder: 'Junk' }
const ports = (overrides: Partial<MailboxEnginePorts> = {}): MailboxEnginePorts & { audits: string[] } => {
  const audits: string[] = []
  return { audits, open: async () => session, callHost: vi.fn(async () => ({ learned: true, reason: null })), move: async () => ({ ...moved }), readBody: async () => ({ folder: 'Junk', from: 'INBOX', uidValidity: 1 }),
    audit: async (_session, action) => { audits.push(action) }, ...overrides }
}
const call = (path: string, method: string, port: MailboxEnginePorts) => { const request = new Request('http://localhost' + path, { method }); return handleMailboxEngineRoute(request, new URL(request.url), method, port) }

describe('mailbox spam report', () => {
  it('moves the message and records one training sample for the destination uid', async () => {
    const port = ports()
    expect(await (await call('/api/webmail/inbox/5/report', 'POST', port))!.json()).toMatchObject({ uid: 9, training: 'recorded' })
    expect(port.callHost).toHaveBeenCalledWith(session.caller, '/host/mail/learn-message', { address: 'info@alice.test', folder: 'Junk', uid: 9, direction: 'spam' })
    expect(port.audits).toEqual(['webmail.spam_report'])
  })
  it('treats a move out of Junk to Inbox as not spam', async () => {
    const port = ports({ readBody: async () => ({ folder: 'INBOX', from: 'Junk', uidValidity: 1 }) })
    await call('/api/webmail/inbox/5/report', 'POST', port)
    expect(port.callHost).toHaveBeenCalledWith(session.caller, '/host/mail/learn-message', expect.objectContaining({ direction: 'ham', folder: 'INBOX' }))
  })
  it('keeps the move and reports a training failure truthfully', async () => {
    const lost = ports({ callHost: async () => { throw new Error('lost') } })
    expect(await (await call('/api/webmail/inbox/5/report', 'POST', lost))!.json()).toMatchObject({ uid: 9, training: 'unavailable' })
    const refused = ports({ callHost: async () => ({ learned: false, reason: 'no_spam_filter' }) })
    expect(await (await call('/api/webmail/inbox/5/report', 'POST', refused))!.json()).toMatchObject({ training: 'no_spam_filter' })
    const unknown = ports({ move: async () => ({ ok: true, uid: null, destinationUidKnown: false, stateChanged: true }) })
    expect(await (await call('/api/webmail/inbox/5/report', 'POST', unknown))!.json()).toMatchObject({ training: 'unavailable' })
    expect(unknown.callHost).not.toHaveBeenCalled()
  })
  it('refuses any other folder pair', async () => {
    await expect(call('/api/webmail/inbox/5/report', 'POST', ports({ readBody: async () => ({ folder: 'Archive', from: 'INBOX' }) }))).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('/api/webmail/inbox/5/report', 'POST', ports({ readBody: async () => ({ folder: 'INBOX', from: 'Sent' }) }))).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('/api/webmail/inbox/5/report?x=1', 'POST', ports())).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

describe('mailbox search index', () => {
  it('reads and rebuilds only the sealed mailbox', async () => {
    const port = ports({ callHost: vi.fn(async () => ({ fts: 'configured', job: null })) })
    await call('/api/webmail/search-index', 'GET', port)
    expect(port.callHost).toHaveBeenCalledWith(session.caller, '/host/mail/search-index?address=info%40alice.test')
    expect((await call('/api/webmail/search-index', 'POST', port))!.status).toBe(202)
    expect(port.callHost).toHaveBeenLastCalledWith(session.caller, '/host/mail/search-index', { address: 'info@alice.test' })
    expect(port.audits).toEqual(['webmail.search_index.rebuild_requested'])
  })
  it('answers a second rebuild with REINDEX_IN_PROGRESS and audits nothing', async () => {
    const port = ports({ callHost: async () => fail('CONFLICT', 'refused', { stateChanged: false }) })
    await expect(call('/api/webmail/search-index', 'POST', port)).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'REINDEX_IN_PROGRESS' } })
    expect(port.audits).toEqual([])
  })
  it('accepts no selector and ignores other paths', async () => {
    await expect(call('/api/webmail/search-index?address=other@x.test', 'GET', ports())).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await call('/api/webmail/inbox/5', 'GET', ports())).toBeNull()
  })
})
