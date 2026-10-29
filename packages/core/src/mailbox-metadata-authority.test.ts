import { describe, expect, it } from 'vitest'
import {
  assessMailboxMetadataAuthority,
  normalizeMailboxMetadataAddress,
  parseMailboxMetadataAuthority,
  type MailboxMetadataAuthority,
} from './mailbox-metadata-authority.ts'

const accountId = '11111111-1111-4111-8111-111111111111'
const serviceUserId = '22222222-2222-4222-8222-222222222222'
const current: MailboxMetadataAuthority = { accountId, serviceUserId, mailbox: 'info@example.test' }

describe('immutable mailbox metadata ownership', () => {
  it('requires the address and both immutable IDs to match', () => {
    expect(assessMailboxMetadataAuthority(current.mailbox, { ...current }, current)).toBe('match')
    expect(assessMailboxMetadataAuthority(current.mailbox, { ...current, serviceUserId: '33333333-3333-4333-8333-333333333333' }, current)).toBe('mismatch')
    expect(assessMailboxMetadataAuthority(current.mailbox, { ...current, accountId: '44444444-4444-4444-8444-444444444444' }, current)).toBe('mismatch')
    expect(assessMailboxMetadataAuthority('other@example.test', current, current)).toBe('mismatch')
  })

  it('does not adopt an address-only legacy owner or grant', () => {
    for (const value of [undefined, null]) {
      expect(assessMailboxMetadataAuthority(current.mailbox, value, current)).toBe('unbound')
    }
    expect(assessMailboxMetadataAuthority('old@example.test', undefined, current)).toBe('mismatch')
  })

  it('refuses incomplete, altered, or address-inconsistent bindings', () => {
    for (const value of [
      {}, { accountId, mailbox: current.mailbox }, { ...current, accountId: 'not-an-id' },
      { ...current, mailbox: 'other@example.test' }, { ...current, adopted: true }, [],
    ]) expect(assessMailboxMetadataAuthority(current.mailbox, value, current)).toBe('invalid')
    expect(assessMailboxMetadataAuthority('../info@example.test', current, current)).toBe('invalid')
  })

  it('returns a canonical frozen copy without changing preserved source data', () => {
    const source = { ...current, mailbox: 'INFO@EXAMPLE.TEST' }
    const parsed = parseMailboxMetadataAuthority(source)
    expect(parsed).toEqual(current)
    expect(parsed).not.toBe(source)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(source.mailbox).toBe('INFO@EXAMPLE.TEST')
    expect(normalizeMailboxMetadataAddress('info@example.test')).toBe(current.mailbox)
  })

  it('does not execute getters or accept prototype authority fields', () => {
    let read = false
    const getter = Object.defineProperty({ accountId, serviceUserId }, 'mailbox', { get() { read = true; return current.mailbox } })
    expect(parseMailboxMetadataAuthority(getter)).toBeNull()
    expect(read).toBe(false)
    expect(parseMailboxMetadataAuthority(Object.create(current))).toBeNull()
    expect(parseMailboxMetadataAuthority({ ...current, [Symbol('extra')]: true })).toBeNull()
  })
})
