import { afterEach, describe, expect, it, vi } from 'vitest'
import { canReceiveLiveEvent } from '@xpanel/core'
import { createLocalMailboxTransport } from './inbox.ts'
import {
  IMAP_BUFFER_MAX,
  IMAP_PENDING_MAX,
  imapDialPlan,
  mailboxLiveEvent,
  pushFromIdleLine,
  speakIdle,
  watchMailboxIdle,
  type IdleLink,
  type IdleSocket,
} from './idle.ts'

afterEach(() => { vi.useRealTimers() })

describe('IDLE protocol regressions', () => {
  it('tracks EXPUNGE so the next message is observable', () => {
    const removed = pushFromIdleLine('* 1 EXPUNGE', 2)
    expect(removed.exists).toBe(1)
    expect(pushFromIdleLine('* 2 EXISTS', removed.exists).push?.kind).toBe('new')
  })

  it('requires the matching tagged OK instead of an unsolicited OK', async () => {
    const link = scripted(['* OK ready', '* OK notice', 'a1 NO authentication failed', '* OK notice', 'a2 NO select failed'])
    await speakIdle(link, { mailbox: 'fixture@example.test', password: 'synthetic-password' }, () => {}, new AbortController().signal)
    expect(link.sent).toHaveLength(1)
  })

  it('never reports an invalid UID as a message identifier', () => {
    for (const uid of ['0', '4294967296', '9007199254740992']) {
      const result = pushFromIdleLine(`* 1 FETCH (UID ${uid} FLAGS (\\Seen))`, 1)
      expect(result.push?.uid).toBeUndefined()
    }
    expect(pushFromIdleLine('* 1 FETCH (FLAGS (UID 42) UID 99)', 1).push?.uid).toBe(99)
    expect(pushFromIdleLine('* 1 FETCH (FLAGS (UID 42))', 1).push?.uid).toBeUndefined()
  })

  it.each([0, 1, 2, 3])('bounds silent handshake stage %s and stops after abort', async stage => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const sockets: ReturnType<typeof fakeSocket>[] = []
    watchMailboxIdle({ host: '127.0.0.1', port: 143, mailbox: 'fixture@example.test', password: 'synthetic-password', signal: controller.signal, onPush() {}, connect: () => { const socket = fakeSocket(); sockets.push(socket); return socket } })
    if (stage >= 1) { sockets[0]!.emit('data', '* OK ready\r\n'); await vi.advanceTimersByTimeAsync(0) }
    if (stage >= 2) { sockets[0]!.emit('data', 'a1 OK logged in\r\n'); await vi.advanceTimersByTimeAsync(0) }
    if (stage >= 3) { sockets[0]!.emit('data', '* 1 EXISTS\r\na2 OK selected\r\n'); await vi.advanceTimersByTimeAsync(0) }
    await vi.advanceTimersByTimeAsync(15_001)
    expect(sockets[0]!.destroyed).toBe(true)
    controller.abort()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(sockets).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses invalidation events instead of inventing message data', () => {
    for (const push of [{ kind: 'new' as const, folder: 'INBOX' as const }, { kind: 'flags' as const, folder: 'INBOX' as const, flags: ['\\Seen'] }]) {
      const event = mailboxLiveEvent(push, { accountId: 'account', mailbox: 'fixture@example.test' })
      expect(event.kind).toBe('mail.changed')
      expect(event.data).toEqual({ folder: 'INBOX' })
    }
  })
})

const scripted = (lines: string[]): IdleLink & { sent: string[] } => {
  const sent: string[] = []
  const queue = [...lines]
  return {
    sent,
    send: (line) => { sent.push(line) },
    next: async () => queue.shift() ?? null,
  }
}

describe('IMAP IDLE mailbox pushes', () => {
  it('turns EXISTS and FLAGS lines into new-mail and flag events', () => {
    expect(pushFromIdleLine('* 2 EXISTS', 1).push).toEqual({ kind: 'new', folder: 'INBOX' })
    expect(pushFromIdleLine('* 2 EXISTS', 2).push).toBeNull()
    expect(pushFromIdleLine('* 1 FETCH (UID 9 FLAGS (\\Seen \\Flagged))', 2).push).toEqual({
      kind: 'flags',
      folder: 'INBOX',
      uid: 9,
      flags: ['\\Seen', '\\Flagged'],
    })
  })

  it('idles one mailbox and emits only after SELECT', async () => {
    const link = scripted([
      '* OK ready',
      'a1 OK logged in',
      '* 1 EXISTS',
      'a2 OK [READ-WRITE] selected',
      '+ idling',
      '* 2 EXISTS',
      '* 2 FETCH (UID 15 FLAGS (\\Seen))',
      'a3 OK idle done',
    ])
    const pushes: string[] = []
    await speakIdle(link, { mailbox: 'a@demo.example.test', password: 'secret' }, (push) => {
      pushes.push(push.kind)
    }, new AbortController().signal)
    expect(link.sent[0]).toContain('LOGIN')
    expect(link.sent[0]).not.toContain('\n')
    expect(link.sent.some(line => line.endsWith(' IDLE'))).toBe(true)
    expect(pushes).toEqual(['resync', 'new', 'flags'])
  })

  it('scopes a push to that mailbox and refuses another account', () => {
    const event = mailboxLiveEvent(
      { kind: 'new', folder: 'INBOX' },
      { accountId: 'acc-a', mailbox: 'a@demo.example.test' },
    )
    expect(canReceiveLiveEvent(
      { kind: 'user', accountId: 'acc-a', mailboxLogin: 'a@demo.example.test' },
      event,
    )).toBe(true)
    expect(canReceiveLiveEvent(
      { kind: 'user', accountId: 'acc-a', mailboxLogin: 'b@demo.example.test' },
      event,
    )).toBe(false)
    expect(canReceiveLiveEvent({ kind: 'user', accountId: 'acc-b' }, event)).toBe(false)
    expect(canReceiveLiveEvent({ kind: 'user', accountId: 'acc-a' }, event)).toBe(false)
    expect(canReceiveLiveEvent(
      { kind: 'reseller', id: 'res-1' },
      event,
      new Set(['acc-a']),
    )).toBe(false)
  })
})

const fakeSocket = (): IdleSocket & { writes: string[]; destroyed: boolean; emit(event: 'data', chunk: string): void; emit(event: 'error' | 'close'): void } => {
  const handlers: Record<string, Array<(...args: never[]) => void>> = {}
  const writes: string[] = []
  let destroyed = false
  return {
    writes,
    get destroyed() { return destroyed },
    setEncoding() {},
    write(data: string) { writes.push(data) },
    destroy() {
      destroyed = true
      for (const fn of handlers.close ?? []) fn()
    },
    on(event: 'data' | 'error' | 'close', fn: (...args: never[]) => void) {
      ;(handlers[event] ??= []).push(fn)
    },
    emit(event: 'data' | 'error' | 'close', chunk?: string) {
      for (const fn of handlers[event] ?? []) fn(chunk as never)
    },
  }
}

describe('IMAP IDLE reconnect and dial policy', () => {
  it('refuses cleartext off loopback and uses TLS on 993', async () => {
    expect(imapDialPlan('203.0.113.9', 143)).toBeNull()
    expect(imapDialPlan('127.0.0.1', 143)).toEqual({ tls: false })
    expect(imapDialPlan('203.0.113.9', 993)).toEqual({ tls: true })
    expect(imapDialPlan('203.0.113.9', 143, '1')).toEqual({ tls: true })
    let called = false
    watchMailboxIdle({
      host: '203.0.113.9',
      port: 143,
      mailbox: 'a@demo.example.test',
      password: 'secret',
      signal: new AbortController().signal,
      onPush: () => {},
      connect: () => { called = true; return fakeSocket() },
      schedule: () => 0 as unknown as ReturnType<typeof setTimeout>,
    })
    expect(called).toBe(false)
    let target: { host: string; port: number; tls: boolean } | undefined
    watchMailboxIdle({
      host: '203.0.113.9',
      port: 993,
      mailbox: 'a@demo.example.test',
      password: 'secret',
      signal: new AbortController().signal,
      onPush: () => {},
      connect: (next) => { target = next; return fakeSocket() },
      schedule: () => 0 as unknown as ReturnType<typeof setTimeout>,
    })
    expect(target).toEqual({ host: '203.0.113.9', port: 993, tls: true })
    const transport = createLocalMailboxTransport({ XPANEL_IMAP_HOST: '203.0.113.9', XPANEL_IMAP_PORT: '143' })
    await expect(transport.verify('a@demo.example.test', 'secret')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  it('reconnects with backoff when IMAP drops and stops when the signal aborts', () => {
    const sockets: ReturnType<typeof fakeSocket>[] = []
    const timers: { fn: () => void; ms: number }[] = []
    const signal = new AbortController()
    watchMailboxIdle({
      host: '127.0.0.1',
      port: 143,
      mailbox: 'a@demo.example.test',
      password: 'secret',
      signal: signal.signal,
      onPush: () => {},
      connect: () => {
        const socket = fakeSocket()
        sockets.push(socket)
        return socket
      },
      schedule: (fn, ms) => {
        timers.push({ fn, ms })
        return 0 as unknown as ReturnType<typeof setTimeout>
      },
    })
    expect(sockets).toHaveLength(1)
    sockets[0]!.emit('error')
    expect(sockets[0]!.destroyed).toBe(true)
    expect(timers.some(timer => timer.ms === 15_000)).toBe(true)
    expect(timers.filter(timer => timer.ms === 1000)).toHaveLength(1)
    timers.find(timer => timer.ms === 1000)!.fn()
    expect(sockets).toHaveLength(2)
    signal.abort()
    sockets[1]!.emit('error')
    expect(timers.filter(timer => timer.ms === 1000)).toHaveLength(1)
  })

  it('caps the unread IMAP buffer and the queued line list', () => {
    const sockets: ReturnType<typeof fakeSocket>[] = []
    const open = () => {
      const socket = fakeSocket()
      sockets.push(socket)
      watchMailboxIdle({
        host: '127.0.0.1',
        port: 143,
        mailbox: 'a@demo.example.test',
        password: 'secret',
        signal: new AbortController().signal,
        onPush: () => {},
        connect: () => socket,
        schedule: () => 0 as unknown as ReturnType<typeof setTimeout>,
      })
      return socket
    }
    const flooded = open()
    flooded.emit('data', 'x'.repeat(IMAP_BUFFER_MAX + 1))
    expect(flooded.destroyed).toBe(true)
    const queued = open()
    queued.emit('data', `${Array.from({ length: IMAP_PENDING_MAX + 2 }, (_, index) => `* ${index} EXISTS`).join('\n')}\n`)
    expect(queued.destroyed).toBe(true)
  })

  it('renews IDLE before the server idle timeout', async () => {
    const sockets: ReturnType<typeof fakeSocket>[] = []
    const timers: { fn: () => void; ms: number }[] = []
    watchMailboxIdle({
      host: '127.0.0.1',
      port: 143,
      mailbox: 'a@demo.example.test',
      password: 'secret',
      signal: new AbortController().signal,
      onPush: () => {},
      idleRenewMs: 25,
      connect: () => {
        const socket = fakeSocket()
        sockets.push(socket)
        return socket
      },
      schedule: (fn, ms) => {
        timers.push({ fn, ms })
        return 0 as unknown as ReturnType<typeof setTimeout>
      },
    })
    const flush = async () => {
      for (let i = 0; i < 8; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
    }
    sockets[0]!.emit('data', '* OK ready\r\n')
    await flush()
    sockets[0]!.emit('data', 'a1 OK logged in\r\n')
    await flush()
    sockets[0]!.emit('data', '* 1 EXISTS\r\na2 OK selected\r\n')
    await flush()
    expect(sockets[0]!.writes.some(line => line.endsWith(' IDLE\r\n'))).toBe(true)
    sockets[0]!.emit('data', '+ idling\r\n')
    await flush()
    const renew = timers.find(timer => timer.ms === 25)
    expect(renew).toBeTruthy()
    renew!.fn()
    expect(sockets).toHaveLength(2)
  })
})
