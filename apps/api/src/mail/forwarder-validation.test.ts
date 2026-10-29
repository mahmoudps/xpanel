import { describe, expect, it } from 'vitest'
import { canonicalForwarderAddress, validateForwarderInput } from './forwarder-validation.ts'

describe('forwarder configuration validation', () => {
  it('canonicalizes and deduplicates addresses while retaining legacy single destinations', () => {
    expect(validateForwarderInput({ sourceAddress: '  TEAM@Example.TEST  ', destinations: ['OUT@Example.TEST', 'out@example.test'] })).toEqual({ sourceAddress: 'team@example.test', destinations: ['out@example.test'] })
    expect(validateForwarderInput({ sourceAddress: 'team@example.test', destination: 'out@example.test' }).destinations).toEqual(['out@example.test'])
  })
  it.each([null, 42, {}, [], '', 'a@@example.test', 'a b@example.test', 'a\n@example.test', '|command@example.test', 'a..b@example.test', '.a@example.test', 'a.@example.test', 'a@-example.test', 'a@example', 'a@example..test', `${'a'.repeat(65)}@example.test`])('rejects malformed primitive or mailbox %j', value => {
    expect(() => canonicalForwarderAddress(value)).toThrow()
  })
  it.each([null, [], { sourceAddress: 'a@example.test', destinations: 'b@example.test' }, { sourceAddress: 'a@example.test', destinations: [] }, { sourceAddress: 'a@example.test', destinations: [42] }, { sourceAddress: 'a@example.test', destinations: ['a@example.test'] }, { sourceAddress: 'a@example.test', destinations: Array(101).fill('b@example.test') }])('rejects invalid forwarder payload %j', input => {
    expect(() => validateForwarderInput(input)).toThrow()
  })
})
