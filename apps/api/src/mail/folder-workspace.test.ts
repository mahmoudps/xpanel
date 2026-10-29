import { describe, expect, it, vi } from 'vitest'
import { XpanelError } from '@xpanel/core'
import type { InboxMessage, InboxSummary, MailboxTransport } from './inbox.ts'
import {
  listMailboxFolder, mailboxFolderUid, moveMailboxFolder, parseMailboxFolderMove,
  readMailboxFolder, selectedMailboxFolder,
} from './folder-workspace.ts'
import type { FolderWorkspaceAuthorization, FolderWorkspaceDependencies } from './folder-workspace.ts'

const mailbox = 'reader@example.test'
const message = (uid = 7): InboxMessage => ({
  uid, uidValidity: 17, uidValidityObserved: true, from: 'sender@example.test', fromName: 'Sender', to: mailbox, cc: 'team@example.test',
  subject: 'Fixture message', receivedAt: 'Unparsed original date', unread: true,
  sizeBytes: 42, preview: 'Preview', attachments: [{ name: 'note.txt', sizeBytes: 3 }], body: 'Plain body\r\n',
})
function fixture(overrides: Partial<MailboxTransport> = {}): FolderWorkspaceDependencies {
  return {
    opened: { record: { mailbox }, password: '' },
    transport: { async verify() {}, async list() { return [message()] }, async read(_mailbox, _credential, uid) { return message(uid) },
      async remove() { throw new Error('permanent removal is outside this helper') },
      async send() { throw new Error('sending is outside this helper') }, ...overrides },
  }
}
const failure = async (operation: Promise<unknown>): Promise<XpanelError> => {
  try { await operation } catch (error) { expect(error).toBeInstanceOf(XpanelError);return error as XpanelError }
  throw new Error('Expected a bounded refusal')
}

describe('mail folder request and selected-result boundary', () => {
  it('retains existing defaults, trimmed folder input and custom folder grammar', () => {
    expect(selectedMailboxFolder()).toBe('INBOX')
    expect(selectedMailboxFolder(null)).toBe('INBOX')
    for (const folder of ['Sent', 'Drafts', 'Trash', 'Archive', 'Customers_2026.Archive', 'INBOX.Custom-1']) {
      expect(selectedMailboxFolder(' '+folder+' ')).toBe(folder)
    }
    expect(parseMailboxFolderMove('7', { folder: 'Trash', uidValidity: 17 })).toEqual({ uid: 7, from: 'INBOX', to: 'Trash', uidValidity: 17 })
  })
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER+1, '', '0', '07', '7\n', '7x', null, [], {}].map(value => ({ value })))('rejects an invalid UID before transport (%j)', ({ value }) => {
    expect(() => mailboxFolderUid(value)).toThrow(XpanelError)
  })
  it('preserves the existing positive-safe-integer range instead of adding a new UID cap', () => {
    expect(mailboxFolderUid(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
  })
  it.each([null, [], {}, { folder: 7 }, { from: 7, folder: 'Trash' }, { folder: 'Trash', mailbox: 'other@example.test' }, { folder: 'Trash', permanent: true }].map(input => ({ input })))('refuses malformed move payloads without a different action (%j)', ({ input }) => {
    expect(() => parseMailboxFolderMove(7, input)).toThrow(XpanelError)
  })
  it('returns a complete selected-folder list with a real move capability and no arbitrary transport fields', async () => {
    const list = vi.fn(async () => [{ ...message(), folder: 'Sent', password: '' }])
    const deps = fixture({ list, async move() { return { uid: 91 } } })
    const result = await listMailboxFolder(deps, 'Sent')
    expect(list).toHaveBeenCalledWith(mailbox, '', 'Sent')
    expect(result).toEqual({ mailbox, folder: 'Sent', complete: true, capabilities: { move: true }, messages: [
      { uid: 7, uidValidity: 17, uidValidityObserved: true, from: 'sender@example.test', fromName: 'Sender', to: mailbox, cc: 'team@example.test', subject: 'Fixture message',
        receivedAt: 'Unparsed original date', unread: true, sizeBytes: 42, preview: 'Preview', attachments: [{ name: 'note.txt', sizeBytes: 3 }] },
    ] })
    expect(JSON.stringify(result)).not.toContain('password')
  })
  it('distinguishes an observed empty folder from a failed list and unsupported move', async () => {
    expect(await listMailboxFolder(fixture({ async list() { return [] } }), 'Drafts')).toEqual({
      mailbox, folder: 'Drafts', complete: true, capabilities: { move: false }, messages: [],
    })
    const error = await failure(listMailboxFolder(fixture({ async list() { throw new Error('raw transport diagnostic') } }), 'Drafts'))
    expect(error.message).not.toContain('raw transport diagnostic')
    expect(error.detail.reason).toBe('mail_read_failed')
  })
  it.each([
    [{ ...message(), folder: 'Trash' }],
    [message(), message()],
    [{ ...message(), uid: 0 }],
    [{ ...message(), sizeBytes: Number.NaN }],
    [{ ...message(), attachments: [{ name: 'file', sizeBytes: -1 }] }],
    [{ ...message(), unread: 'yes' }],
  ].map(values => ({ values })))('rejects inconsistent list identity/shape rather than publishing complete (%j)', async ({ values }) => {
    const error = await failure(listMailboxFolder(fixture({ async list() { return values as unknown as InboxSummary[] } }), 'Sent'))
    expect(error.detail.reason).toBe('invalid_mail_result')
  })
  it('pins reads to the exact selected folder and UID and preserves body/date text', async () => {
    const read = vi.fn(async () => ({ ...message(91), folder: 'Trash' }))
    const result = await readMailboxFolder(fixture({ read }), '91', 'Trash')
    expect(read).toHaveBeenCalledWith(mailbox, '', 91, 'Trash', { authorize: expect.any(Function) })
    expect(result).toEqual({ mailbox, folder: 'Trash', message: message(91) })
  })
  it.each([{ ...message(8) }, { ...message(), folder: 'Sent' }, { ...message(), body: null }])('refuses a stale/malformed selected message (%j)', async value => {
    const error = await failure(readMailboxFolder(fixture({ async read() { return value as InboxMessage } }), 7, 'Trash'))
    expect(error.detail.reason).toBe('invalid_mail_result')
  })
  it('rechecks trusted authorization without exposing or dispatching session material', async () => {
    const list = vi.fn(async () => [message()]), authorize = vi.fn(async (context: Readonly<FolderWorkspaceAuthorization>) => {
      expect(Object.isFrozen(context)).toBe(true)
      expect(context).toEqual({ operation: 'list', mailbox, folder: 'Sent' })
      throw new XpanelError('FORBIDDEN', 'private authorization diagnostic')
    })
    const error = await failure(listMailboxFolder({ ...fixture({ list }), authorize }, 'Sent'))
    expect(list).not.toHaveBeenCalled()
    expect(error.code).toBe('FORBIDDEN');expect(error.detail.stateChanged).toBe(false)
    expect(error.message).not.toContain('private authorization diagnostic')
  })
})

describe('reversible selected-folder move boundary', () => {
  it('binds the mailbox, from folder, original UID and distinct transport destination UID', async () => {
    const move = vi.fn(async () => ({ uid: 91, uidValidity: 23, uidValidityObserved: true, sourceUidValidity: 17, sourceUidValidityObserved: true, mailbox, from: 'Sent', sourceUid: 7, folder: 'Trash' }))
    const result = await moveMailboxFolder(fixture({ move }), 7, { from: 'Sent', folder: 'Trash', uidValidity: 17 })
    expect(move).toHaveBeenCalledWith(mailbox, '', 7, 'Sent', 'Trash', { uidValidity: 17 })
    expect(result).toEqual({ ok: true, mailbox, from: 'Sent', sourceUid: 7, folder: 'Trash', uid: 91, sourceUidValidity: 17, uidValidity: 23, uidValidityObserved: true, destinationUidKnown: true, stateChanged: true })
    const restored = await moveMailboxFolder(fixture({ async move() { return { uid: 104, uidValidity: 17, uidValidityObserved: true, sourceUidValidity: 23, sourceUidValidityObserved: true } } }), 91, { from: 'Trash', folder: 'Sent', uidValidity: 23 })
    expect(restored).toMatchObject({ from: 'Trash', sourceUid: 91, folder: 'Sent', uid: 104, stateChanged: true })
  })
  it('keeps a same-folder request an explicit unchanged no-op without transport support', async () => {
    const result = await moveMailboxFolder(fixture(), 7, { from: 'Archive', folder: 'Archive', uidValidity: 17 })
    expect(result).toMatchObject({ from: 'Archive', folder: 'Archive', uid: 7, sourceUid: 7, sourceUidValidity: 17, uidValidityObserved: false, destinationUidKnown: false, stateChanged: false })
  })
  it('refuses unsupported move safely before a dispatch', async () => {
    const error = await failure(moveMailboxFolder(fixture(), 7, { from: 'Sent', folder: 'Trash', uidValidity: 17 }))
    expect(error.detail).toMatchObject({ stateChanged: false, unsupported: true, reason: 'mail_move_unsupported' })
  })
  it.each([undefined, {}, { uid: undefined }].map(result => ({ result })))('does not invent a destination UID when the command has no mapping (%j)', async ({ result }) => {
    const moved = await moveMailboxFolder(fixture({ async move() { return result } }), 7, { from: 'Drafts', folder: 'Trash', uidValidity: 17 })
    expect(moved).toMatchObject({ uid: null, destinationUidKnown: false, stateChanged: true, sourceUid: 7 })
  })
  it.each([null, false, [], { uid: 0 }, { uid: Number.NaN }, { uid: '91' }, { uid: 91, folder: 'Drafts' }, { uid: 91, from: 'INBOX' }, { uid: 91, sourceUid: 8 }, { uid: 91, mailbox: 'other@example.test' }, { uid: 91, verificationRequired: true }, { ok: false }, { uid: 91, stateChanged: 'yes' }].map(result => ({ result })))('requires review of a malformed/inconsistent dispatched receipt (%j)', async ({ result }) => {
    const error = await failure(moveMailboxFolder(fixture({ async move() { return result as unknown as { uid?: number } } }), 7, { from: 'Sent', folder: 'Trash', uidValidity: 17 }))
    expect(error.detail).toMatchObject({ unknownOutcome: true, verificationRequired: true })
    expect(error.detail.stateChanged).not.toBe(false)
  })
  it('distinguishes explicit safe refusal from ambiguous and verification-required failures', async () => {
    const refused = await failure(moveMailboxFolder(fixture({ async move() { throw new XpanelError('NOT_FOUND', 'raw source diagnostic', { stateChanged: false }) } }), 7, { from: 'Sent', folder: 'Trash', uidValidity: 17 }))
    expect(refused.code).toBe('NOT_FOUND');expect(refused.detail).toMatchObject({ stateChanged: false, reason: 'mail_move_refused' })
    for (const error of [new Error('raw transport diagnostic'), new XpanelError('FORBIDDEN', 'raw diagnostic'), new XpanelError('PRECONDITION_FAILED', 'raw diagnostic', { stateChanged: false, verificationRequired: true })]) {
      const uncertain = await failure(moveMailboxFolder(fixture({ async move() { throw error } }), 7, { from: 'Sent', folder: 'Trash', uidValidity: 17 }))
      expect(uncertain.detail).toMatchObject({ unknownOutcome: true, verificationRequired: true })
      expect(uncertain.message).not.toContain('raw')
    }
  })
  it('captures the original context before an asynchronous trusted authorization', async () => {
    let resume!: () => void
    const move = vi.fn(async () => ({ uid: 91, uidValidity: 23, uidValidityObserved: true, sourceUidValidity: 17, sourceUidValidityObserved: true })), deps = fixture({ move })
    deps.authorize = () => new Promise<void>(resolve => { resume = resolve })
    const request = { from: 'Sent', folder: 'Trash', uidValidity: 17 }
    const pending = moveMailboxFolder(deps, 7, request)
    request.from = 'Drafts';request.folder = 'Archive';request.uidValidity = 99
    resume()
    expect(await pending).toMatchObject({ from: 'Sent', folder: 'Trash', sourceUid: 7, uid: 91 })
    expect(move).toHaveBeenCalledWith(mailbox, '', 7, 'Sent', 'Trash', { uidValidity: 17 })
  })
})
