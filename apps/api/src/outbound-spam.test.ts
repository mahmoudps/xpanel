import { describe, expect, it } from 'vitest'
import { OUTBOUND_SPAM_DEFAULT } from '../../agent/src/mail-cert-policy.ts'
import { applyOutboundUsage, EMPTY_OUTBOUND_STATE, outboundHoldMaps, outboundLimits } from './outbound-spam.ts'
import type { OutboundSnapshot, OutboundState } from './outbound-spam.ts'

const NOW = new Date('2026-11-07T10:30:00.000Z')
const policy = { ...OUTBOUND_SPAM_DEFAULT, enabled: true, mailboxHourly: 10, mailboxDaily: 50, accountHourly: 100, accountDaily: 500 }
const snapshot: OutboundSnapshot = { accounts: [{ id: 'a', username: 'alice', planId: 'p', contactEmail: 'owner@alice.test' }], domains: [{ name: 'alice.test', accountId: 'a' }], plans: [{ id: 'p', name: 'Basic' }] }
const fresh = (): OutboundState => structuredClone(EMPTY_OUTBOUND_STATE)
const usage = (recipients: number, user = 'sales@alice.test') => [{ user, domain: 'alice.test', recipients }]

describe('outbound limits', { tags: ['unit'] }, () => {
  it('resolves mailbox, account and plan rules in order', () => {
    const rules = { ...policy, rules: [{ scope: 'mailbox' as const, target: 'sales@alice.test', hourly: 1, daily: 2 }, { scope: 'plan' as const, target: 'basic', hourly: 3, daily: 4 }, { scope: 'account' as const, target: 'alice', hourly: 5, daily: 6 }] }
    expect(outboundLimits(rules, { mailbox: 'sales@alice.test' })).toMatchObject({ hourly: 1, daily: 2 })
    expect(outboundLimits(rules, { mailbox: 'other@alice.test' })).toEqual({ hourly: 10, daily: 50 })
    expect(outboundLimits(rules, { account: 'alice', plan: 'Basic' })).toMatchObject({ hourly: 5, daily: 6 })
    expect(outboundLimits(rules, { account: 'bob', plan: 'Basic' })).toMatchObject({ hourly: 3, daily: 4 })
    expect(outboundLimits(policy, { account: 'bob', plan: null })).toEqual({ hourly: 100, daily: 500 })
  })
  it('holds a mailbox over its hourly limit once', () => {
    const state = fresh()
    expect(applyOutboundUsage(state, usage(10), policy, snapshot, NOW)).toEqual([])
    expect(applyOutboundUsage(state, usage(1), policy, snapshot, NOW)).toEqual([expect.objectContaining({ key: 'sales@alice.test', scope: 'mailbox', window: 'hourly', count: 11, limit: 10 })])
    expect(applyOutboundUsage(state, usage(5), policy, snapshot, NOW)).toEqual([])
    expect(state.holds).toHaveLength(1)
  })
  it('sums mailboxes for the account limit, and 0 means no limit', () => {
    const state = fresh(), open = { ...policy, mailboxHourly: 0, mailboxDaily: 0 }
    expect(applyOutboundUsage(state, usage(60), open, snapshot, NOW)).toEqual([])
    expect(applyOutboundUsage(state, usage(60, 'other@alice.test'), open, snapshot, NOW)).toEqual([expect.objectContaining({ key: 'alice', scope: 'account', count: 120 })])
  })
  it('starts a new hour but keeps the day', () => {
    const state = fresh()
    applyOutboundUsage(state, usage(9), policy, snapshot, NOW)
    expect(applyOutboundUsage(state, usage(9), policy, snapshot, new Date('2026-11-07T11:01:00.000Z'))).toEqual([])
    expect(state.mailboxes['sales@alice.test']).toEqual({ hourly: 9, daily: 18 })
    applyOutboundUsage(state, usage(1), policy, snapshot, new Date('2026-11-08T00:01:00.000Z'))
    expect(state.mailboxes['sales@alice.test']).toEqual({ hourly: 1, daily: 1 })
  })
  it('ignores a sender outside the hosted domains', () => {
    const state = fresh()
    expect(applyOutboundUsage(state, [{ user: 'x@remote.test', domain: 'remote.test', recipients: 900 }], policy, snapshot, NOW)).toEqual([])
    expect(state.accounts).toEqual({})
  })
})

describe('hold tables', { tags: ['unit'] }, () => {
  const view = { accounts: [{ id: 'a', username: 'alice', uid: 1001 }], domains: [{ name: 'alice.test', accountId: 'a' }, { name: 'shop.test', accountId: 'a' }] }
  const hold = (key: string, scope: 'mailbox' | 'account') => ({ key, scope, window: 'hourly' as const, count: 1, limit: 1, at: '' })
  it('holds a mailbox by address and an account by every domain and its UID', () => {
    expect(outboundHoldMaps([hold('sales@alice.test', 'mailbox')], view)).toEqual({ senders: ['sales@alice.test'], uids: [] })
    expect(outboundHoldMaps([hold('alice', 'account')], view)).toEqual({ senders: ['alice.test', 'shop.test'], uids: [1001] })
  })
  it('drops an account that no longer exists', () => expect(outboundHoldMaps([hold('gone', 'account')], view)).toEqual({ senders: [], uids: [] }))
})

describe('domain limits', () => {
  it('holds a domain over its hourly limit and maps the hold to its sender domain', () => {
    const policy = { enabled: true, mailboxHourly: 0, mailboxDaily: 0, accountHourly: 0, accountDaily: 0, domainHourly: 2, domainDaily: 0, rules: [] }
    const state = structuredClone(EMPTY_OUTBOUND_STATE)
    const snapshot = { accounts: [{ id: 'a', username: 'alice', planId: 'p', contactEmail: '' }], domains: [{ name: 'example.test', accountId: 'a' }], plans: [{ id: 'p', name: 'Basic' }] }
    const added = applyOutboundUsage(state, [{ domain: 'example.test', user: 'a@example.test', recipients: 3 }] as never, policy, snapshot as never, new Date('2026-11-07T10:00:00.000Z'))
    expect(added.map(hold => [hold.scope, hold.key, hold.window])).toEqual([['domain', 'example.test', 'hourly']])
    expect(outboundHoldMaps(added, snapshot as never).senders).toEqual(['example.test'])
  })
})

