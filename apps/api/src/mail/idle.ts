import { randomUUID } from 'node:crypto'
import net from 'node:net'
import tls from 'node:tls'
import type { LiveEvent } from '@xpanel/core'

export interface MailPush {
  kind: 'new' | 'flags'
  folder: 'INBOX'
  uid?: number
  flags?: string[]
}

const EXISTS_RE = /^\* (\d+) EXISTS$/i
const FETCH_RE = /^\* \d+ FETCH \((.*)\)$/i

/** One IMAP IDLE line. EXISTS above the selected count is new mail. FETCH FLAGS is a flag change. */
export const pushFromIdleLine = (line: string, exists: number): { exists: number; push: MailPush | null } => {
  const trimmed = line.trim()
  const existsMatch = EXISTS_RE.exec(trimmed)
  if (existsMatch?.[1]) {
    const count = Number(existsMatch[1])
    if (!Number.isSafeInteger(count) || count < 0) return { exists, push: null }
    if (count > exists) return { exists: count, push: { kind: 'new', folder: 'INBOX' } }
    return { exists: count, push: null }
  }
  const fetchMatch = FETCH_RE.exec(trimmed)
  if (!fetchMatch?.[1]) return { exists, push: null }
  const body = fetchMatch[1]
  const flags = /\bFLAGS \(([^)]*)\)/i.exec(body)
  if (!flags) return { exists, push: null }
  const uid = /\bUID (\d+)/i.exec(body)
  const uidValue = uid?.[1] ? Number(uid[1]) : undefined
  return {
    exists,
    push: {
      kind: 'flags',
      folder: 'INBOX',
      ...(uidValue !== undefined && Number.isSafeInteger(uidValue) ? { uid: uidValue } : {}),
      flags: (flags[1] ?? '').split(/\s+/).filter(Boolean),
    },
  }
}

export const mailboxLiveEvent = (
  push: MailPush,
  scope: { accountId: string; mailbox: string },
): LiveEvent => {
  const id = randomUUID()
  const at = new Date().toISOString()
  const base = { accountId: scope.accountId, mailboxLogin: scope.mailbox }
  if (push.kind === 'flags') {
    return {
      id,
      at,
      kind: 'mail.flags',
      scope: base,
      data: { mailbox: scope.mailbox, folder: 'INBOX', uid: push.uid ?? 0, flags: push.flags ?? [] },
    }
  }
  return {
    id,
    at,
    kind: 'mail.received',
    scope: base,
    data: {
      mailbox: scope.mailbox,
      folder: 'INBOX',
      uid: push.uid ?? 0,
      from: '',
      subject: '',
      sizeBytes: 0,
      unreadCount: 0,
    },
  }
}

const quoteImap = (value: string): string => {
  if (/[\r\n\u0000]/.test(value)) throw new Error('IMAP string contains a forbidden character')
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export interface IdleLink {
  send(line: string): void
  next(): Promise<string | null>
}

/**
 * LOGIN, SELECT INBOX, IDLE. Untagged EXISTS and FLAGS become pushes.
 * The link closes the dialogue; this function does not open a second mailbox.
 */
export const speakIdle = async (
  link: IdleLink,
  login: { mailbox: string; password: string },
  onPush: (push: MailPush) => void,
  signal: AbortSignal,
): Promise<void> => {
  if (signal.aborted) return
  const greeting = await link.next()
  if (!greeting?.startsWith('* OK')) return
  let tag = 0
  const round = async (command: string): Promise<string[]> => {
    const id = `a${++tag}`
    link.send(`${id} ${command}`)
    const lines: string[] = []
    while (!signal.aborted) {
      const line = await link.next()
      if (line === null) return lines
      lines.push(line)
      if (line.startsWith(`${id} `)) return lines
    }
    return lines
  }
  const logged = await round(`LOGIN ${quoteImap(login.mailbox)} ${quoteImap(login.password)}`)
  if (!logged.some(line => /\sOK\b/i.test(line))) return
  const selected = await round('SELECT INBOX')
  if (!selected.some(line => /\sOK\b/i.test(line))) return
  let exists = 0
  for (const line of selected) {
    const parsed = pushFromIdleLine(line, exists)
    exists = parsed.exists
  }
  const idleTag = `a${++tag}`
  link.send(`${idleTag} IDLE`)
  while (!signal.aborted) {
    const line = await link.next()
    if (line === null) return
    if (line.startsWith(`${idleTag} `)) return
    const parsed = pushFromIdleLine(line, exists)
    exists = parsed.exists
    if (parsed.push) onPush(parsed.push)
  }
}

export interface MailboxIdleOptions {
  host: string
  port: number
  mailbox: string
  password: string
  signal: AbortSignal
  onPush: (push: MailPush) => void
  /** Port 993 uses TLS. Any other cleartext dial is refused unless the host is loopback. */
  tls?: boolean
  /** How long to IDLE before DONE and a fresh session. RFC 2177 servers drop a silent IDLE. */
  idleRenewMs?: number
  connect?: (target: { host: string; port: number; tls: boolean }) => IdleSocket
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
}

/** Cleartext IMAP stays on the local listener. Port 143 is loopback-only. */
export const imapCleartextAllowed = (host: string): boolean => {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return value === '127.0.0.1' || value === '::1' || value === 'localhost' || value === '0:0:0:0:0:0:0:1'
}

/**
 * TLS when the port is 993 or the operator set XPANEL_IMAP_TLS. Cleartext is
 * refused for every other host. Port 143 remains the loopback default.
 */
export const imapDialPlan = (host: string, port: number, tlsFlag?: string): { tls: boolean } | null => {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  const secure = port === 993 || tlsFlag === '1' || tlsFlag === 'true'
  if (!secure && !imapCleartextAllowed(host)) return null
  return { tls: secure }
}

export const IMAP_BUFFER_MAX = 64 * 1024
export const IMAP_PENDING_MAX = 256
export const IMAP_IDLE_RENEW_MS = 29 * 60 * 1000
const BACKOFF_START_MS = 1000
const BACKOFF_CAP_MS = 30_000

export interface IdleSocket {
  write(data: string): void
  destroy(): void
  setEncoding(encoding: 'utf8'): void
  on(event: 'data', listener: (chunk: string) => void): void
  on(event: 'error' | 'close', listener: () => void): void
}

const defaultConnect = (target: { host: string; port: number; tls: boolean }): IdleSocket => {
  if (target.tls) {
    return tls.connect({ host: target.host, port: target.port, servername: target.host, rejectUnauthorized: true })
  }
  return net.connect({ host: target.host, port: target.port })
}

/**
 * Keeps one mailbox in IDLE while the websocket abort signal is clear.
 * A dropped socket reconnects with backoff. Abort closes the socket and stops.
 * Cleartext to a non-loopback host does not connect. Port 143 is loopback-only;
 * port 993, or tls, uses TLS.
 */
export const watchMailboxIdle = (opts: MailboxIdleOptions): void => {
  if (opts.signal.aborted) return
  const secure = opts.tls === true || opts.port === 993
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) return
  if (!secure && !imapCleartextAllowed(opts.host)) return
  const connect = opts.connect ?? defaultConnect
  const schedule = opts.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const renewMs = opts.idleRenewMs ?? IMAP_IDLE_RENEW_MS
  let attempt = 0
  let stopped = false
  let currentStop: (() => void) | null = null
  let backoffTimer: ReturnType<typeof setTimeout> | null = null

  const clearBackoff = (): void => {
    if (backoffTimer !== null) {
      clearTimeout(backoffTimer)
      backoffTimer = null
    }
  }

  const shutdown = (): void => {
    stopped = true
    clearBackoff()
    currentStop?.()
  }
  opts.signal.addEventListener('abort', shutdown, { once: true })

  const openSession = (): void => {
    if (stopped || opts.signal.aborted) return
    let socket: IdleSocket
    try {
      socket = connect({ host: opts.host, port: opts.port, tls: secure })
    } catch {
      const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** Math.min(attempt, 10))
      attempt += 1
      backoffTimer = schedule(() => {
        backoffTimer = null
        openSession()
      }, delay)
      return
    }
    const pending: string[] = []
    let waiter: ((line: string | null) => void) | null = null
    let buffer = ''
    let settled = false
    let renewTimer: ReturnType<typeof setTimeout> | null = null
    const clearRenew = (): void => {
      if (renewTimer !== null) {
        clearTimeout(renewTimer)
        renewTimer = null
      }
    }
    const deliver = (line: string | null): void => {
      if (waiter) {
        const next = waiter
        waiter = null
        next(line)
        return
      }
      if (line !== null) pending.push(line)
    }
    const finish = (mode: 'drop' | 'renew' | 'stop'): void => {
      if (settled) return
      settled = true
      clearRenew()
      deliver(null)
      try { socket.destroy() } catch { /* Already closed. */ }
      if (mode === 'stop' || stopped || opts.signal.aborted) return
      if (mode === 'renew') {
        attempt = 0
        openSession()
        return
      }
      const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** Math.min(attempt, 10))
      attempt += 1
      backoffTimer = schedule(() => {
        backoffTimer = null
        openSession()
      }, delay)
    }
    const stop = (): void => {
      try { socket.write('DONE\r\n') } catch { /* The socket is already gone. */ }
      finish('stop')
    }
    currentStop = stop
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      if (settled) return
      if (Buffer.byteLength(buffer, 'utf8') + Buffer.byteLength(chunk, 'utf8') > IMAP_BUFFER_MAX || pending.length >= IMAP_PENDING_MAX) {
        buffer = ''
        finish('drop')
        return
      }
      buffer += chunk
      let split = buffer.indexOf('\n')
      while (split >= 0) {
        const line = buffer.slice(0, split).replace(/\r$/, '')
        buffer = buffer.slice(split + 1)
        deliver(line)
        if (pending.length >= IMAP_PENDING_MAX) {
          buffer = ''
          finish('drop')
          return
        }
        split = buffer.indexOf('\n')
      }
    })
    socket.on('error', () => finish('drop'))
    socket.on('close', () => finish('drop'))
    const link: IdleLink = {
      send: (line) => {
        socket.write(`${line}\r\n`)
        if (line.endsWith(' IDLE')) {
          attempt = 0
          clearRenew()
          renewTimer = schedule(() => finish('renew'), renewMs)
        }
      },
      next: () => pending.length > 0
        ? Promise.resolve(pending.shift() ?? null)
        : new Promise(resolve => { waiter = resolve }),
    }
    void speakIdle(link, { mailbox: opts.mailbox, password: opts.password }, opts.onPush, opts.signal)
      .catch(() => undefined)
      .finally(() => {
        if (!settled) finish('drop')
      })
  }

  openSession()
}
