import { describe, expect, it } from 'vitest'
import { accountContactRevision, assertAccountContactRevision } from './account-contact.ts'
import { isXpanelError } from './errors.ts'
import type { Account } from './types.ts'

type ContactAccount = Pick<Account, 'id' | 'contactEmail' | 'planId' | 'ownerId' | 'status' | 'createdAt'>

const account: ContactAccount = {
  id: '11111111-1111-4111-8111-111111111111',
  contactEmail: 'Alice+hosting@example.com',
  planId: '22222222-2222-4222-8222-222222222222',
  ownerId: null,
  status: 'active',
  createdAt: '2026-10-26T00:00:00.000Z',
}

const codeOf = (fn: () => unknown): string => {
  try { fn(); return 'ok' } catch (error) { return isXpanelError(error) ? error.code : 'raw' }
}

describe('account contact representation revision', () => {
  it('returns a deterministic lowercase SHA256 tag without mutating its source', () => {
    const source = Object.freeze({ ...account })
    const first = accountContactRevision(source)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(accountContactRevision(source)).toBe(first)
    expect(source).toEqual(account)
  })

  it.each<[keyof ContactAccount, Partial<ContactAccount>]>([
    ['id', { id: '33333333-3333-4333-8333-333333333333' }],
    ['contactEmail', { contactEmail: 'Other@example.com' }],
    ['planId', { planId: '44444444-4444-4444-8444-444444444444' }],
    ['ownerId', { ownerId: '55555555-5555-4555-8555-555555555555' }],
    ['status', { status: 'suspended' }],
    ['createdAt', { createdAt: '2026-10-26T00:00:01.000Z' }],
  ])('changes when %s changes', (_field, patch) => {
    expect(accountContactRevision({ ...account, ...patch })).not.toBe(accountContactRevision(account))
  })

  it('uses a fixed projection regardless of source key order or unrelated metadata', () => {
    const reordered = {
      createdAt: account.createdAt,
      status: account.status,
      ownerId: account.ownerId,
      planId: account.planId,
      contactEmail: account.contactEmail,
      id: account.id,
      username: 'different-name',
      ipv4: '192.0.2.10',
      revision: 999,
      passwordHash: 'synthetic-ignored-value',
    }
    expect(accountContactRevision(reordered)).toBe(accountContactRevision(account))
  })

  it('normalizes the domain through assertEmail while preserving local-part case', () => {
    expect(accountContactRevision({ ...account, contactEmail: 'Alice+hosting@EXAMPLE.COM' }))
      .toBe(accountContactRevision(account))
    expect(accountContactRevision({ ...account, contactEmail: 'alice+hosting@example.com' }))
      .not.toBe(accountContactRevision(account))
  })

  it('is intentionally current-value CAS rather than a monotonic history counter', () => {
    const original = accountContactRevision(account)
    expect(accountContactRevision({ ...account, contactEmail: 'Other@example.com' })).not.toBe(original)
    expect(accountContactRevision({ ...account, contactEmail: account.contactEmail })).toBe(original)
  })

  it.each([
    '', null, undefined, 42, {}, [],
    ' Alice@example.com', 'Alice@example.com ', 'Alice\n@example.com',
    'Alice@@example.com', '.Alice@example.com', 'Alice.@example.com', 'Al..ice@example.com',
    'Alice@bad domain', 'Alice@-invalid.example', `${'a'.repeat(65)}@example.com`,
  ])('rejects invalid contact addresses without silently repairing %j', contactEmail => {
    expect(codeOf(() => accountContactRevision({ ...account, contactEmail: contactEmail as string }))).toBe('VALIDATION')
  })
})

describe('account contact revision input', () => {
  it.each(['0'.repeat(64), '0123456789abcdef'.repeat(4)])('accepts exact lowercase64hex %s', revision => {
    expect(assertAccountContactRevision(revision)).toBe(revision)
  })

  it.each([
    null, undefined, 42, {}, [], new String('a'.repeat(64)), '',
    'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64),
    ` ${'a'.repeat(64)}`, `${'a'.repeat(64)} `, `${'a'.repeat(64)}\n`,
    `${'a'.repeat(63)}\u0000`, String.fromCharCode(0xff10).repeat(64),
  ])('rejects malformed revision without normalization %j', revision => {
    expect(codeOf(() => assertAccountContactRevision(revision))).toBe('VALIDATION')
  })
})
