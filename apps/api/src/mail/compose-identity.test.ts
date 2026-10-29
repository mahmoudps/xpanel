import { describe, expect, it } from 'vitest'
import { composeIdentityRevision, projectComposeIdentity, resolveComposeIdentity, type ComposeStoredIdentity } from './compose-identity.ts'

const mailbox = 'sender@example.test'
const identity = (patch: Partial<ComposeStoredIdentity> = {}): ComposeStoredIdentity => ({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', mailbox, email: mailbox, displayName: 'Customer team', replyTo: 'reply@example.test',
  textSignature: 'Regards,\nCustomer team', htmlSignature: '<img src=x onerror=alert(1)>', isDefault: true, createdAt: '2026-10-26T00:00:00Z', ...patch,
})
const selection = (record = identity()) => ({ identityId: record.id, expectedIdentityRevision: composeIdentityRevision(record) })

describe('trusted compose identity resolution', () => {
  it('projects a stable revision without changing the stored record', () => {
    const saved = identity(), before = JSON.stringify(saved)
    expect(projectComposeIdentity(saved)).toEqual({ ...saved, revision: composeIdentityRevision(saved) })
    expect(JSON.stringify(saved)).toBe(before)
    expect(composeIdentityRevision(saved)).toMatch(/^[0-9a-f]{64}$/)
  })
  it('preserves the mailbox-only send contract when no saved identity was selected', () => {
    expect(resolveComposeIdentity(mailbox, { to: 'recipient@example.test', fromName: 'untrusted', replyTo: 'untrusted@example.test' }, [identity()])).toBeNull()
  })
  it('resolves display name and Reply-To from the saved record and keeps the authorized mailbox', () => {
    const saved = identity()
    expect(resolveComposeIdentity(mailbox, { ...selection(saved), from: 'forged@example.test', fromName: 'forged', replyTo: 'forged@example.test' }, [saved])).toEqual({
      identityId: saved.id, identityRevision: composeIdentityRevision(saved), from: mailbox, fromName: saved.displayName, replyTo: saved.replyTo,
    })
  })
  it.each(['displayName', 'replyTo', 'textSignature', 'htmlSignature'] as const)('refuses a stale %s before submission', key => {
    const saved = identity()
    expect(() => resolveComposeIdentity(mailbox, selection(saved), [identity({ [key]: saved[key] + ' changed' })])).toThrowError(expect.objectContaining({ code: 'CONFLICT', detail: { stateChanged: false, identitySelectionRequired: true } }))
  })
  it('refuses deleted or foreign identity ids without leaking another mailbox', () => {
    for (const records of [[], [identity({ mailbox: 'foreign@example.test' })]]) {
      expect(() => resolveComposeIdentity(mailbox, selection(), records)).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }))
    }
  })
  it('does not treat an unverified saved email alias as sender authorization', () => {
    const saved = identity({ email: 'unverified-alias@example.test' })
    expect(() => resolveComposeIdentity(mailbox, selection(saved), [saved])).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
  })
  it.each([{}, { identityId: identity().id }, { expectedIdentityRevision: '0'.repeat(64) }, { identityId: '../foreign', expectedIdentityRevision: '0'.repeat(64) }, { identityId: identity().id, expectedIdentityRevision: 'invalid' }])('requires a complete bounded identity selection: %j', body => {
    if (!Object.keys(body).length) return expect(resolveComposeIdentity(mailbox, body, [identity()])).toBeNull()
    expect(() => resolveComposeIdentity(mailbox, body, [identity()])).toThrowError(expect.objectContaining({ code: 'VALIDATION' }))
  })
  it.each([
    { displayName: 'Header\r\nBcc: victim@example.test' }, { displayName: 'x'.repeat(201) },
    { replyTo: 'reply@example.test\r\nBcc: victim@example.test' }, { replyTo: '<reply@example.test>' },
    { displayName: '\u202ehidden' },
  ])('refuses invalid persisted header values before SMTP: %j', patch => {
    const saved = identity(patch)
    expect(() => resolveComposeIdentity(mailbox, selection(saved), [saved])).toThrowError(expect.objectContaining({ code: 'VALIDATION' }))
  })
})
