import { describe, expect, it } from 'vitest'
import type { LiveEvent } from '../types.ts'
import { canReceiveLiveEvent } from './events.ts'

describe('canReceiveLiveEvent RBAC scoping', () => {
  const serverEvent: LiveEvent = {
    id: 'evt-1',
    at: '2026-10-22T06:00:00Z',
    kind: 'reconcile.applied',
    scope: { accountId: null, resellerId: null },
    data: { generationId: 143, stateChecksum: 'abc', filesCount: 12, durationMs: 48 },
  }

  const accountAEvent: LiveEvent = {
    id: 'evt-2',
    at: '2026-10-22T06:00:01Z',
    kind: 'metrics.tick',
    scope: { accountId: 'acc-a', resellerId: 'res-1' },
    data: {
      uid: 20000,
      cpuUsageUsec: 12000,
      memoryCurrentBytes: 64 * 1024 * 1024,
      ioReadBytes: 4096,
      ioWriteBytes: 8192,
      pidsCurrent: 4,
    },
  }

  const mailEvent: LiveEvent = {
    id: 'evt-3',
    at: '2026-10-22T06:00:02Z',
    kind: 'mail.received',
    scope: { accountId: 'acc-a', mailboxLogin: 'billing@alice-shop.com' },
    data: {
      mailbox: 'billing@alice-shop.com',
      folder: 'INBOX',
      uid: 42,
      from: 'orders@stripe.com',
      subject: 'Invoice paid',
      sizeBytes: 4120,
      unreadCount: 3,
    },
  }

  it('allows root to receive all events', () => {
    const root = { kind: 'root' as const, id: 'root' }
    expect(canReceiveLiveEvent(root, serverEvent)).toBe(true)
    expect(canReceiveLiveEvent(root, accountAEvent)).toBe(true)
    expect(canReceiveLiveEvent(root, mailEvent)).toBe(true)
  })

  it('scopes reseller events to owned accounts and own resellerId', () => {
    const res1 = { kind: 'reseller' as const, id: 'res-1', username: 'reseller1' }
    const res2 = { kind: 'reseller' as const, id: 'res-2', username: 'reseller2' }
    const owned = new Set(['acc-a'])
    expect(canReceiveLiveEvent(res1, serverEvent, owned)).toBe(false)
    expect(canReceiveLiveEvent(res1, accountAEvent, owned)).toBe(true)
    expect(canReceiveLiveEvent(res1, mailEvent, owned)).toBe(false)
    expect(canReceiveLiveEvent(res2, accountAEvent, new Set(['acc-b']))).toBe(false)
  })

  it('scopes user events strictly to their own accountId', () => {
    const alice = { kind: 'user' as const, id: 'u-1', accountId: 'acc-a', username: 'alice' }
    const bob = { kind: 'user' as const, id: 'u-2', accountId: 'acc-b', username: 'bob' }
    expect(canReceiveLiveEvent(alice, serverEvent)).toBe(false)
    expect(canReceiveLiveEvent(alice, accountAEvent)).toBe(true)
    expect(canReceiveLiveEvent(alice, mailEvent)).toBe(false)
    expect(canReceiveLiveEvent({ ...alice, mailboxLogin: 'billing@alice-shop.com' }, mailEvent)).toBe(true)
    expect(canReceiveLiveEvent({ ...alice, mailboxLogin: 'sales@alice-shop.com' }, mailEvent)).toBe(false)
    expect(canReceiveLiveEvent({ ...alice, mailboxLogin: 'billing@alice-shop.com' }, accountAEvent)).toBe(false)
    expect(canReceiveLiveEvent(bob, accountAEvent)).toBe(false)
  })

  it('keeps mailbox invalidations scoped during live delivery and replay', () => {
    const event: LiveEvent = { id: 'changed', at: mailEvent.at, kind: 'mail.changed', scope: mailEvent.scope, data: { folder: 'INBOX' } }
    expect(canReceiveLiveEvent({ kind: 'user', accountId: 'acc-a', mailboxLogin: 'billing@alice-shop.com' }, event)).toBe(true)
    expect(canReceiveLiveEvent({ kind: 'user', accountId: 'acc-a' }, event)).toBe(false)
    expect(canReceiveLiveEvent({ kind: 'reseller', id: 'res-1' }, event, new Set(['acc-a']))).toBe(false)
    expect(canReceiveLiveEvent({ kind: 'root' }, { ...event, scope: { accountId: 'acc-a' } })).toBe(false)
  })

  it('refuses invalid UID and mismatched mailbox flag events even for root', () => {
    const event: LiveEvent = { id: 'flags', at: mailEvent.at, kind: 'mail.flags', scope: mailEvent.scope, data: { mailbox: 'billing@alice-shop.com', folder: 'INBOX', uid: 42, flags: ['\\Seen'] } }
    expect(canReceiveLiveEvent({ kind: 'root' }, event)).toBe(true)
    for (const uid of [0, -1, 0x1_0000_0000, 1.5, Number.NaN]) expect(canReceiveLiveEvent({ kind: 'root' }, { ...event, data: { ...event.data, uid } })).toBe(false)
    expect(canReceiveLiveEvent({ kind: 'root' }, { ...event, data: { ...event.data, mailbox: 'other@example.test' } })).toBe(false)
    expect(canReceiveLiveEvent({ kind: 'root' }, { ...event, data: null } as unknown as LiveEvent)).toBe(false)
    expect(canReceiveLiveEvent({ kind: 'root' }, { ...event, data: { ...event.data, unexpected: 'synthetic' } } as unknown as LiveEvent)).toBe(false)
  })

  it('scopes service (xMail) events strictly to their own mailbox login', () => {
    const mailbox = { kind: 'service' as const, id: 'su-1', accountId: 'acc-a', login: 'billing@alice-shop.com' }
    const otherMailbox = { kind: 'service' as const, id: 'su-2', accountId: 'acc-a', login: 'sales@alice-shop.com' }
    expect(canReceiveLiveEvent(mailbox, mailEvent)).toBe(true)
    expect(canReceiveLiveEvent(mailbox, accountAEvent)).toBe(false)
    expect(canReceiveLiveEvent(otherMailbox, mailEvent)).toBe(false)
  })
})
