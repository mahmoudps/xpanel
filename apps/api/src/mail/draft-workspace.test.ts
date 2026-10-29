import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import { DRAFT_MIME_MAX_BYTES, parseExpectedDraft, saveMailboxDraft, type DraftContent, type DraftIdentity, type DraftObservation, type DraftTransport, type DraftWorkspaceDependencies } from './draft-workspace.ts'

// Native MIME encoding with an explicitly fake IMAP port. No mailbox/server work is executed.
const mailbox = 'sender@example.test'
const content: DraftContent = { to: ['recipient@example.test'], cc: ['copy@example.test'], bcc: ['hidden@example.test'], subject: 'Draft subject', textBody: 'Draft body' }
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const fixture = () => {
  let validity = 7, nextUid = 10, observed = true
  const messages = new Map<number, Uint8Array>()
  const observe = vi.fn(async (uid: number): Promise<DraftObservation> => ({ mailbox, folder: 'Drafts', uidValidity: validity, uidValidityObserved: observed, message: messages.has(uid) ? { mailbox, folder: 'Drafts', uid, uidValidity: validity, sizeBytes: messages.get(uid)!.byteLength, rfc822SizeObserved: true, bodyComplete: true, rawMimeBytes: messages.get(uid)! } : null }))
  const append = vi.fn<DraftTransport['appendDraft']>(async (bytes, _flags) => { const uid = nextUid++; messages.set(uid, Buffer.from(bytes)); return { appendedUid: uid, appendedUidValidity: validity } })
  const retire = vi.fn(async (identity: DraftIdentity) => { messages.delete(identity.uid) })
  const authorize = vi.fn(async () => {})
  const transport: DraftTransport = { appendDraft: append, observeDraft: observe, retireDraft: retire }
  const deps: DraftWorkspaceDependencies = { mailbox, authorize, transport, now: () => new Date('2026-10-26T00:00:00Z'), newMessageId: () => '<generated-draft@example.test>' }
  const old = (): DraftIdentity => { const bytes = Buffer.from('Saved previous draft\r\n'); messages.set(3, bytes); return { uid: 3, uidValidity: validity, revision: sha(bytes) } }
  return { deps, messages, append, observe, retire, authorize, old, validity: (value: number) => { validity = value }, observed: (value: boolean) => { observed = value }, nextUid: (value: number) => { nextUid = value } }
}

describe('native draft APPEND and exact observed readback boundary', () => {
  it('builds real MIME, appends once with the draft flag and returns only observed provider identity', async () => {
    const f = fixture(), result = await saveMailboxDraft(f.deps, content)
    expect(result).toMatchObject({ mailbox, folder: 'Drafts', status: 'saved', previousDraft: 'none', reviewRequired: false, draft: { uid: 10, uidValidity: 7, messageId: '<generated-draft@example.test>' } })
    expect(f.append).toHaveBeenCalledTimes(1); expect(f.append.mock.calls[0]![1]).toEqual(['\\Draft'])
    const bytes = f.messages.get(10)!
    expect(result.draft.revision).toBe(sha(bytes)); expect(Buffer.from(bytes).toString()).toContain('Message-ID: <generated-draft@example.test>')
    expect(Buffer.from(bytes).toString()).toContain('Bcc: hidden@example.test\r\n')
    expect(f.observe).toHaveBeenCalledExactlyOnceWith(10); expect(f.retire).not.toHaveBeenCalled()
  })
  it('allows a useful body-only draft without requiring an SMTP recipient', async () => {
    const f = fixture(); expect((await saveMailboxDraft(f.deps, { to: [], subject: '', textBody: 'Unfinished message' })).status).toBe('saved')
  })
  it.each([
    { uid: 0, uidValidity: 7, revision: '0'.repeat(64) }, { uid: 3, uidValidity: 0, revision: '0'.repeat(64) },
    { uid: 3, uidValidity: 7, revision: 'invalid' }, { uid: 3, uidValidity: 7, revision: '0'.repeat(64), mailbox: 'foreign@example.test' },
  ])('refuses invalid or foreign selectors before any IMAP append: %j', async expected => {
    const f = fixture(); await expect(saveMailboxDraft(f.deps, content, expected)).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } })
    expect(f.append).not.toHaveBeenCalled(); expect(f.observe).not.toHaveBeenCalled()
  })
  it.each([
    { ...content, bcc: ['hidden@example.test\r\nBcc: victim@example.test'] }, { ...content, subject: 'Subject\r\nBcc: victim@example.test' },
    { ...content, textBody: '\u0000' }, { to: [], subject: '', textBody: '' },
  ])('refuses invalid draft content without writing: %j', async draft => {
    const f = fixture(); await expect(saveMailboxDraft(f.deps, draft)).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } }); expect(f.append).not.toHaveBeenCalled()
  })
  it('refuses an oversized encoded MIME before APPEND', async () => {
    const f = fixture(); await expect(saveMailboxDraft(f.deps, { ...content, textBody: 'x'.repeat(DRAFT_MIME_MAX_BYTES) })).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } }); expect(f.append).not.toHaveBeenCalled()
  })
  it('requires an unchanged previous draft and genuinely observed UIDVALIDITY', async () => {
    const f = fixture(), expected = f.old(); f.messages.set(expected.uid, Buffer.from('Changed outside this draft'))
    await expect(saveMailboxDraft(f.deps, content, expected)).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } }); expect(f.append).not.toHaveBeenCalled()
    f.messages.delete(expected.uid)
    await expect(saveMailboxDraft(f.deps, content, expected)).rejects.toMatchObject({ code: 'CONFLICT' }); expect(f.append).not.toHaveBeenCalled()
    const current = f.old(); f.observed(false)
    await expect(saveMailboxDraft(f.deps, content, current)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false, draftVerificationRequired: true } }); expect(f.append).not.toHaveBeenCalled()
  })
  it('does not append a replacement when targeted retirement is unavailable', async () => {
    const f = fixture(), expected = f.old(); delete f.deps.transport.retireDraft
    await expect(saveMailboxDraft(f.deps, content, expected)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } }); expect(f.append).not.toHaveBeenCalled()
  })
  it.each([
    { appendedUid: null, appendedUidValidity: null }, { appendedUid: 10, appendedUidValidity: null },
    { appendedUid: 0, appendedUidValidity: 7 }, { appendedUid: 4294967296, appendedUidValidity: 7 },
  ])('keeps missing or invalid APPENDUID identity unknown: %j', async ack => {
    const f = fixture(); f.append.mockResolvedValue(ack)
    await expect(saveMailboxDraft(f.deps, content)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: true, unknownOutcome: true, verificationRequired: true } })
    expect(f.append).toHaveBeenCalledTimes(1); expect(f.retire).not.toHaveBeenCalled()
  })
  it('refuses a fabricated readback hash or unobserved read identity after APPEND', async () => {
    for (const unobserved of [false, true]) {
      const f = fixture(); f.observe.mockImplementation(async uid => ({ mailbox, folder: 'Drafts', uidValidity: 7, uidValidityObserved: !unobserved, message: { mailbox, folder: 'Drafts', uid, uidValidity: 7, sizeBytes: 11, rfc822SizeObserved: true, bodyComplete: true, rawMimeBytes: Buffer.from('wrong bytes') } }))
      await expect(saveMailboxDraft(f.deps, content)).rejects.toMatchObject({ detail: { stateChanged: true, unknownOutcome: true } }); expect(f.retire).not.toHaveBeenCalled()
    }
  })
  it('keeps definite pre-append refusal separate from a lost APPEND outcome', async () => {
    const f = fixture(); f.append.mockImplementation(async () => fail('PRECONDITION_FAILED', 'Synthetic tagged NO', { stateChanged: false }))
    await expect(saveMailboxDraft(f.deps, content)).rejects.toMatchObject({ detail: { stateChanged: false } })
    f.append.mockRejectedValue(new Error('Synthetic connection lost'))
    await expect(saveMailboxDraft(f.deps, content)).rejects.toMatchObject({ detail: { stateChanged: true, unknownOutcome: true } })
  })
  it.each([
    { rfc822SizeObserved: false }, { bodyComplete: false }, { sizeBytes: 1 },
    { mailbox: 'foreign@example.test' }, { folder: 'INBOX' }, { uidValidity: 8 },
  ])('never treats incomplete or incorrectly scoped source as a verified draft: %j', async patch => {
    const f = fixture(), original = f.observe.getMockImplementation()!
    f.observe.mockImplementation(async uid => { const value = await original(uid); return { ...value, message: value.message ? { ...value.message, ...patch } : null } })
    await expect(saveMailboxDraft(f.deps, content)).rejects.toMatchObject({ detail: { stateChanged: true, unknownOutcome: true } })
    expect(f.append).toHaveBeenCalledTimes(1); expect(f.retire).not.toHaveBeenCalled()
  })
  it('retires the exact previous copy only after new bytes are observed and verifies absence', async () => {
    const f = fixture(), expected = f.old(), result = await saveMailboxDraft(f.deps, content, expected)
    expect(result).toMatchObject({ status: 'saved', previousDraft: 'retired', reviewRequired: false })
    expect(f.messages.has(expected.uid)).toBe(false); expect(f.messages.has(result.draft.uid)).toBe(true)
    expect(f.retire).toHaveBeenCalledExactlyOnceWith(expected)
    expect(f.observe.mock.invocationCallOrder[1]!).toBeLessThan(f.retire.mock.invocationCallOrder[0]!)
  })
  it.each(['throw', 'retained'])('preserves the verified new draft and reports partial %s cleanup', async mode => {
    const f = fixture(), expected = f.old()
    if (mode === 'throw') f.retire.mockRejectedValue(new Error('Synthetic move outcome unknown'))
    else f.retire.mockImplementation(async () => {})
    const result = await saveMailboxDraft(f.deps, content, expected)
    expect(result).toMatchObject({ status: 'partial', previousDraft: 'review_required', reviewRequired: true })
    expect(f.messages.has(expected.uid)).toBe(true); expect(f.messages.has(result.draft.uid)).toBe(true)
    expect(f.append).toHaveBeenCalledTimes(1); expect(f.retire).toHaveBeenCalledTimes(1)
  })
  it('never retargets a previous UID after mailbox validity changes', async () => {
    const f = fixture(), expected = f.old(), original = f.append.getMockImplementation()!
    f.append.mockImplementation(async (bytes, flags) => { f.validity(8); return original(bytes, flags) })
    const result = await saveMailboxDraft(f.deps, content, expected)
    expect(result).toMatchObject({ status: 'partial', draft: { uidValidity: 8 }, reviewRequired: true }); expect(f.retire).not.toHaveBeenCalled()
  })
  it('rechecks authorization immediately before appending and leaves old data unchanged on refusal', async () => {
    const f = fixture(), expected = f.old(); f.authorize.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => fail('FORBIDDEN', 'Synthetic access revoked', { stateChanged: false }))
    await expect(saveMailboxDraft(f.deps, content, expected)).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: false } })
    expect(f.messages.has(expected.uid)).toBe(true); expect(f.append).not.toHaveBeenCalled()
  })
  it('parses expected provider references without allocating or mutating them', () => {
    const ref = { uid: 3, uidValidity: 7, revision: '0'.repeat(64) }
    expect(parseExpectedDraft(ref)).toEqual(ref); expect(parseExpectedDraft(undefined)).toBeNull()
  })
})
