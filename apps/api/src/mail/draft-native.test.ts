import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import { createNativeDraftTransport } from './draft-native.ts'
import type { DraftNativeSession } from './draft-native.ts'
import { DRAFT_MIME_MAX_BYTES, saveMailboxDraft } from './draft-workspace.ts'
import type { ImapConnectionConfig, ImapFetchedMessage, ImapSelectedMailboxState } from './imap.ts'
import { MimeCodecAndSanitizer } from './mime.ts'

// Declared IMAP/session ports; these tests do not qualify a native mail service.
const mailbox = 'reader@example.test'
const revision = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
function fixture() {
  let session: DraftNativeSession = { record: { sessionId: 'draft-session', mailbox, accountId: 'draft-account', serviceUserId: 'draft-service' }, password: randomBytes(24).toString('hex') }
  const bytes = Buffer.from('From: reader@example.test\r\nTo: target@example.test\r\nSubject: Draft\r\n\r\nSaved content\r\n')
  let sourceBytes: Buffer = bytes, nextUid = 9, sourcePresent = true
  const folders = new Map<string, Map<number, Buffer>>([['Drafts', new Map([[1, bytes]])], ['Trash', new Map()]])
  const state = (folder: string): ImapSelectedMailboxState => ({ folder, exists: folders.get(folder)!.size, recent: 0, uidValidity: folder === 'Drafts' ? 17 : 41,
    uidValidityObserved: true, uidNext: 100, flags: [], resynced: false, previousUidValidity: null })
  const asMessage = (folder: string, uid: number, raw: Buffer): ImapFetchedMessage => ({ mailbox, folder, uid, uidValidity: state(folder).uidValidity,
    flags: ['\\Draft'], internalDate: null, sizeBytes: raw.byteLength, rawMime: raw.toString('utf8'), rawMimeBytes: raw, rfc822SizeObserved: true, bodyComplete: true,
    parsed: new MimeCodecAndSanitizer().parseMimeMessage(raw), attachmentTokens: [] })
  const client = {
    connect: vi.fn(async () => '* OK synthetic'), login: vi.fn(async (): Promise<void> => undefined), logout: vi.fn(async (): Promise<void> => undefined),
    selectFolder: vi.fn(async (folder: string, _mailbox?: string) => state(folder)),
    fetchMessagesByUid: vi.fn(async (folder: string, uid: string | number, _options?: unknown) => {
      const raw = folder === 'Drafts' && Number(uid) === 1 ? (sourcePresent ? sourceBytes : undefined) : folders.get(folder)!.get(Number(uid))
      return { state: state(folder), messages: raw ? [asMessage(folder, Number(uid), raw)] : [] }
    }),
    appendMessage: vi.fn(async (_folder: string, raw: string | Buffer, _flags?: readonly string[], _mailbox?: string): Promise<{ appendedUid: number | null; appendedUidValidity: number | null; statusText: string }> => {
      const uid = nextUid++; folders.get('Drafts')!.set(uid, typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.from(raw))
      return { appendedUid: uid, appendedUidValidity: 17, statusText: '[APPENDUID 17 ' + uid + '] stored' }
    }),
    moveByUidWithIdentity: vi.fn(async (_source: string, uid: number, _target: string, _validity: number, _mailbox?: string) => {
      sourcePresent = false; folders.get('Drafts')!.delete(uid); folders.get('Trash')!.set(23, sourceBytes)
      return { sourceUid: uid, destinationUid: 23, destinationUidValidity: 41 }
    }),
  }
  const clientFactory = vi.fn((_config: ImapConnectionConfig) => client)
  const openSession = vi.fn(async () => session)
  const transport = createNativeDraftTransport({ env: { XPANEL_IMAP_HOST: '127.0.0.1', XPANEL_IMAP_PORT: '143' }, openSession, clientFactory })
  return { transport, client, clientFactory, openSession, state, asMessage, bytes, folders,
    changeSession: (patch: Partial<DraftNativeSession['record']>) => { session = { ...session, record: { ...session.record, ...patch } } },
    changeSource: (raw: Buffer) => { sourceBytes = raw }, keepSource: () => { sourcePresent = true },
  }
}

describe('real Draft IMAP adapter boundaries', () => {
  it('appends exact bytes and returns only the observed APPENDUID pair under explicit bounds', async () => {
    const f = fixture()
    expect(await f.transport.appendDraft(f.bytes, ['\\Draft'])).toEqual({ appendedUid: 9, appendedUidValidity: 17 })
    expect(f.client.appendMessage).toHaveBeenCalledWith('Drafts', f.bytes, ['\\Draft'], mailbox)
    expect(f.clientFactory).toHaveBeenCalledWith(expect.objectContaining({ host: '127.0.0.1', port: 143, tls: false, rejectUnauthorized: true, maxLiteralBytes: DRAFT_MIME_MAX_BYTES, maxResponseLineBytes: 1024 * 1024 }))
    expect(f.client.logout).toHaveBeenCalledTimes(1)
  })
  it.each([0, DRAFT_MIME_MAX_BYTES + 1])('refuses outbound MIME byte size %s before authentication or mutation', async size => {
    const f = fixture()
    await expect(f.transport.appendDraft(Buffer.alloc(size), ['\\Draft'])).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } })
    expect(f.openSession).not.toHaveBeenCalled(); expect(f.client.appendMessage).not.toHaveBeenCalled()
  })
  it('accepts the exact outbound MIME size limit', async () => {
    const f = fixture()
    await f.transport.appendDraft(Buffer.alloc(DRAFT_MIME_MAX_BYTES, 0x78), ['\\Draft'])
    expect((f.client.appendMessage.mock.calls[0]![1] as Buffer).byteLength).toBe(DRAFT_MIME_MAX_BYTES)
  })
  it.each([{ flags: [] }, { flags: ['\\Draft', '\\Deleted'] }, { flags: ['\\Draft)\r\nEXPUNGE'] }])('refuses unsupported or injected append flags $flags', async ({ flags }) => {
    const f = fixture()
    await expect(f.transport.appendDraft(f.bytes, flags)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(f.clientFactory).not.toHaveBeenCalled()
  })
  it('never infers an APPENDUID pair from selected-folder defaults', async () => {
    const f = fixture(); f.client.appendMessage.mockResolvedValueOnce({ appendedUid: null, appendedUidValidity: null, statusText: 'stored' })
    expect(await f.transport.appendDraft(f.bytes, ['\\Draft'])).toEqual({ appendedUid: null, appendedUidValidity: null })
  })
  it('marks an append with mismatched observed generation as uncertain', async () => {
    const f = fixture(); f.client.appendMessage.mockResolvedValueOnce({ appendedUid: 9, appendedUidValidity: 18, statusText: 'stored' })
    await expect(f.transport.appendDraft(f.bytes, ['\\Draft'])).rejects.toMatchObject({ detail: { stateChanged: true, unknownOutcome: true } })
  })
  it('observes only complete actual bytes and genuine UIDVALIDITY', async () => {
    const f = fixture(), observed = await f.transport.observeDraft(1)
    expect(observed).toMatchObject({ mailbox, folder: 'Drafts', uidValidity: 17, uidValidityObserved: true, message: { uid: 1, uidValidity: 17, sizeBytes: f.bytes.length, rfc822SizeObserved: true, bodyComplete: true } })
    expect(observed.message?.rawMimeBytes).toEqual(f.bytes)
    expect(f.client.fetchMessagesByUid).toHaveBeenCalledWith('Drafts', 1, { requestedMailbox: mailbox, mimeLimits: { maxTotalBytes: DRAFT_MIME_MAX_BYTES } })
  })
  it.each([{ uidValidityObserved: false }, { uidValidity: 0 }])('refuses missing native identity proof %s', async patch => {
    const f = fixture(); f.client.fetchMessagesByUid.mockResolvedValueOnce({ state: { ...f.state('Drafts'), ...patch }, messages: [] })
    await expect(f.transport.observeDraft(1)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it.each([{ rfc822SizeObserved: false }, { bodyComplete: false }, { sizeBytes: 1 }, { mailbox: 'other@example.test' }, { folder: 'Trash' }, { uidValidity: 18 }, { uid: 2 }])('refuses contradictory fetched source proof %s', async patch => {
    const f = fixture(); f.client.fetchMessagesByUid.mockResolvedValueOnce({ state: f.state('Drafts'), messages: [{ ...f.asMessage('Drafts', 1, f.bytes), ...patch }] })
    await expect(f.transport.observeDraft(1)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it.each(['rfc822SizeObserved', 'bodyComplete', 'rawMimeBytes'] as const)('refuses an omitted actual source field %s', async field => {
    const f = fixture(), source = f.asMessage('Drafts', 1, f.bytes)
    delete source[field]
    f.client.fetchMessagesByUid.mockResolvedValueOnce({ state: f.state('Drafts'), messages: [source] })
    await expect(f.transport.observeDraft(1)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('verifies observed absence and refuses generation changes after a read', async () => {
    const f = fixture()
    expect(await f.transport.observeDraft(8)).toMatchObject({ uidValidity: 17, uidValidityObserved: true, message: null })
    f.client.selectFolder.mockResolvedValueOnce({ ...f.state('Drafts'), uidValidity: 18 })
    await expect(f.transport.observeDraft(1)).rejects.toMatchObject({ code: 'CONFLICT' })
  })
  it('pins the sealed session across all operations', async () => {
    const f = fixture(); await f.transport.observeDraft(1); f.changeSession({ mailbox: 'other@example.test' })
    await expect(f.transport.appendDraft(f.bytes, ['\\Draft'])).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: false } })
    expect(f.client.appendMessage).not.toHaveBeenCalled()
  })
  it('rechecks fresh authorization after login before any append', async () => {
    const f = fixture(); f.client.login.mockImplementationOnce(async () => { f.changeSession({ serviceUserId: 'changed-service' }) })
    await expect(f.transport.appendDraft(f.bytes, ['\\Draft'])).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: false } })
    expect(f.client.appendMessage).not.toHaveBeenCalled()
  })
  it('does not return verified success if authorization changes after APPEND', async () => {
    const f = fixture(); f.client.appendMessage.mockImplementationOnce(async () => { f.changeSession({ accountId: 'changed-account' }); return { appendedUid: 9, appendedUidValidity: 17, statusText: 'stored' } })
    await expect(f.transport.appendDraft(f.bytes, ['\\Draft'])).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { unknownOutcome: true } })
  })
  it('moves only the exact prior draft and verifies recoverable Trash bytes plus source absence', async () => {
    const f = fixture(), identity = { uid: 1, uidValidity: 17, revision: revision(f.bytes) }
    expect(await f.transport.retireDraft!(identity)).toEqual({ destinationUid: 23, destinationUidValidity: 41 })
    expect(f.client.moveByUidWithIdentity).toHaveBeenCalledWith('Drafts', 1, 'Trash', 17, mailbox)
    expect(f.client.fetchMessagesByUid.mock.calls.map(call => [call[0], call[1]])).toEqual([['Drafts', 1], ['Trash', 23], ['Drafts', 1]])
  })
  it.each(['hash', 'validity'] as const)('refuses a stale prior %s before issuing native MOVE', async stale => {
    const f = fixture()
    await expect(f.transport.retireDraft!({ uid: 1, uidValidity: stale === 'validity' ? 18 : 17, revision: stale === 'hash' ? '0'.repeat(64) : revision(f.bytes) })).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    expect(f.client.moveByUidWithIdentity).not.toHaveBeenCalled()
  })
  it.each(['bytes', 'validity', 'source_remains'] as const)('refuses unverified retirement result %s', async fault => {
    const f = fixture()
    f.client.moveByUidWithIdentity.mockImplementationOnce(async () => {
      f.folders.get('Trash')!.set(23, fault === 'bytes' ? Buffer.from('Different source') : f.bytes)
      if (fault !== 'source_remains') f.changeSource(Buffer.alloc(0))
      return { sourceUid: 1, destinationUid: 23, destinationUidValidity: fault === 'validity' ? 42 : 41 }
    })
    await expect(f.transport.retireDraft!({ uid: 1, uidValidity: 17, revision: revision(f.bytes) })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { unknownOutcome: true } })
  })
  it('sanitizes native failures without exposing raw status, credentials or MIME', async () => {
    const f = fixture(); f.client.appendMessage.mockImplementationOnce(async () => fail('PRECONDITION_FAILED', 'IMAP SYNTHETIC-PRIVATE-MARKER'))
    await expect(f.transport.appendDraft(f.bytes, ['\\Draft'])).rejects.toMatchObject({ message: 'draft mail server operation could not be verified', detail: { unknownOutcome: true } })
    expect(f.client.logout).toHaveBeenCalledTimes(1)
  })
  it.each([{ XPANEL_IMAP_HOST: 'mail.example.test', XPANEL_IMAP_PORT: '143' }, { XPANEL_IMAP_PORT: '0' }, { XPANEL_IMAP_TIMEOUT_MS: '0' }])('refuses invalid or remote cleartext trusted config %s', env => {
    expect(() => createNativeDraftTransport({ env, openSession: fixture().openSession })).toThrow()
  })
  it('supports trusted verified TLS with certificate validation', async () => {
    const f = fixture(), transport = createNativeDraftTransport({ env: { XPANEL_IMAP_HOST: 'mail.example.test', XPANEL_IMAP_PORT: '993' }, openSession: f.openSession, clientFactory: f.clientFactory })
    await transport.observeDraft(1)
    expect(f.clientFactory).toHaveBeenCalledWith(expect.objectContaining({ tls: true, rejectUnauthorized: true }))
  })
  it('integrates real adapter ports with the Draft helper for append, full readback and retirement', async () => {
    const f = fixture(), authorize = vi.fn(async () => undefined)
    const saved = await saveMailboxDraft({ mailbox, transport: f.transport, authorize }, { to: [], subject: 'Replacement', textBody: 'Actual adapter contract' }, { uid: 1, uidValidity: 17, revision: revision(f.bytes) })
    expect(saved).toMatchObject({ status: 'saved', draft: { uid: 9, uidValidity: 17 }, previousDraft: 'retired', reviewRequired: false })
    expect(f.folders.get('Trash')!.get(23)).toEqual(f.bytes)
  })
  it('preserves the verified new draft and requires review if native retirement is uncertain', async () => {
    const f = fixture()
    f.client.moveByUidWithIdentity.mockImplementationOnce(async () => fail('PRECONDITION_FAILED', 'synthetic native MOVE refused'))
    const saved = await saveMailboxDraft({ mailbox, transport: f.transport, authorize: async () => undefined }, { to: [], subject: 'Replacement', textBody: 'Keep this verified draft' }, { uid: 1, uidValidity: 17, revision: revision(f.bytes) })
    expect(saved).toMatchObject({ status: 'partial', draft: { uid: 9, uidValidity: 17 }, previousDraft: 'review_required', reviewRequired: true })
    expect(f.folders.get('Drafts')!.has(9)).toBe(true)
    expect(f.folders.get('Drafts')!.get(1)).toEqual(f.bytes)
  })
})
