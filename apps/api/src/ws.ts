import { randomBytes } from 'node:crypto'
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import { canReceiveLiveEvent } from '@xpanel/core'
import type { Id, LiveEvent, LiveEventSubscriber } from '@xpanel/core'

export type EventSubscriber = LiveEventSubscriber & {
  ownedAccountIds?: ReadonlySet<Id> | readonly Id[]
}

export type SequencedLiveEvent = LiveEvent & {
  seq?: number
}

export interface EventResyncOptions {
  limit?: number
  afterSeq?: number
  afterId?: string
}

export interface EventResyncSnapshot {
  events: SequencedLiveEvent[]
  cursor: number
  oldestRetainedSeq: number | null
  resyncRequired: boolean
}

const MAX_FRAME_BYTES = 64 * 1024
const MAX_QUEUED_EVENTS = 32
const MAX_QUEUED_BYTES = 256 * 1024
const MAX_SOCKET_BUFFER_BYTES = 256 * 1024
const MAX_HISTORY_BYTES = 1024 * 1024
const MAX_NETWORK_CLIENTS = 256
const MAX_PENDING_UPGRADES = 32
const AUTHENTICATION_TIMEOUT_MS = 10_000

interface HubOptions {
  maxHistory?: number
  heartbeatIntervalMs?: number
  pongTimeoutMs?: number
}

interface RegisteredClient {
  id: number
  subscriber: EventSubscriber
  ownedAccountIds: ReadonlySet<Id>
  send: (event: SequencedLiveEvent) => void
}

interface QueuedEvent {
  event: SequencedLiveEvent
  payload: string
  bytes: number
}

// Internal availability result; client fields never create this authority.
export const WS_AUTHORIZATION_UNAVAILABLE = Symbol('websocket-authorization-unavailable')
export type UpgradeAuthorization = EventSubscriber | null | typeof WS_AUTHORIZATION_UNAVAILABLE
type AuthenticateUpgrade = (req: IncomingMessage) => Promise<UpgradeAuthorization>
type ConnectedHook = (req: IncomingMessage, subscriber: EventSubscriber, signal: AbortSignal) => void | Promise<void>
/** Another upgrade endpoint on the same listener claims its own path first; true means it took the socket. */
type UpgradeClaim = (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean

const accountSet = (subscriber: EventSubscriber): ReadonlySet<Id> =>
  new Set(subscriber.ownedAccountIds ?? [])

const positiveInterval = (value: number | undefined, fallback: number): number => {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 10 || value > 120_000) {
    throw new RangeError('WebSocket interval must be an integer between 10 and 120000 ms')
  }
  return value
}

const authorizeBeforeDeadline = async (
  req: IncomingMessage,
  authenticate: AuthenticateUpgrade,
): Promise<UpgradeAuthorization> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), AUTHENTICATION_TIMEOUT_MS)
    timer.unref()
  })
  try {
    return await Promise.race([authenticate(req), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Role-scoped event history plus a bounded, continuously authorized network feed. */
export class LiveEventHub {
  readonly #maxHistory: number
  readonly #heartbeatIntervalMs: number
  readonly #pongTimeoutMs: number
  readonly #history: Array<{ seq: number; event: SequencedLiveEvent; bytes: number }> = []
  readonly #clients = new Map<number, RegisteredClient>()
  readonly #networkClosers = new Set<() => void>()
  #historyBytes = 0
  #pendingUpgrades = 0
  #nextClientId = 1
  #lastSeq = 0

  constructor(opts: HubOptions = {}) {
    if (opts.maxHistory !== undefined && (!Number.isSafeInteger(opts.maxHistory) || opts.maxHistory < 1)) {
      throw new RangeError('WebSocket history limit must be a positive integer')
    }
    this.#maxHistory = Math.max(1, Math.min(100, Math.floor(opts.maxHistory ?? 100)))
    this.#heartbeatIntervalMs = positiveInterval(opts.heartbeatIntervalMs, 30_000)
    this.#pongTimeoutMs = positiveInterval(opts.pongTimeoutMs, 10_000)
  }

  get clientCount(): number {
    return this.#clients.size
  }

  get latestSeq(): number {
    return this.#lastSeq
  }

  #register(subscriber: EventSubscriber, send: (event: SequencedLiveEvent) => void) {
    const client: RegisteredClient = {
      id: this.#nextClientId++, subscriber, ownedAccountIds: accountSet(subscriber), send,
    }
    this.#clients.set(client.id, client)
    return { client, unregister: () => { this.#clients.delete(client.id) } }
  }

  registerClient(subscriber: EventSubscriber, send: (event: SequencedLiveEvent) => void): () => void {
    return this.#register(subscriber, send).unregister
  }

  /** Returns scheduled local deliveries; network clients must still pass fresh authorization. */
  broadcast(event: LiveEvent): number {
    const seq = ++this.#lastSeq
    const sequenced: SequencedLiveEvent = { ...event, seq }
    const bytes = Buffer.byteLength(JSON.stringify(sequenced))
    if (bytes <= MAX_FRAME_BYTES) {
      this.#history.push({ seq, event: sequenced, bytes })
      this.#historyBytes += bytes
      while (this.#history.length > this.#maxHistory || this.#historyBytes > MAX_HISTORY_BYTES) {
        this.#historyBytes -= this.#history.shift()!.bytes
      }
    }
    let scheduled = 0
    for (const client of this.#clients.values()) {
      if (!canReceiveLiveEvent(client.subscriber, sequenced, client.ownedAccountIds)) continue
      try {
        client.send(sequenced)
        scheduled++
      } catch {
        this.#clients.delete(client.id)
      }
    }
    return scheduled
  }

  recentEventsFor(
    subscriber: EventSubscriber,
    limit = 100,
    opts?: { afterSeq?: number; afterId?: string },
  ): SequencedLiveEvent[] {
    return this.resyncFor(subscriber, {
      limit,
      ...(opts?.afterSeq !== undefined && { afterSeq: opts.afterSeq }),
      ...(opts?.afterId !== undefined && { afterId: opts.afterId }),
    }).events
  }

  resyncFor(subscriber: EventSubscriber, opts: EventResyncOptions = {}): EventResyncSnapshot {
    const limit = opts.limit ?? 100
    const max = Number.isFinite(limit) ? Math.max(0, Math.min(100, Math.floor(limit))) : 100
    const oldestRetainedSeq = this.#history[0]?.seq ?? null
    const afterSeq =
      opts.afterSeq !== undefined && Number.isSafeInteger(opts.afterSeq) && opts.afterSeq >= 0
        ? opts.afterSeq
        : undefined
    const afterId = typeof opts.afterId === 'string' && opts.afterId.length > 0 ? opts.afterId : undefined

    let resyncRequired = false
    if (afterSeq !== undefined) {
      if (oldestRetainedSeq !== null && afterSeq > 0 && afterSeq < oldestRetainedSeq - 1) {
        resyncRequired = true
      } else if (oldestRetainedSeq === null && afterSeq > 0 && this.#lastSeq > afterSeq) {
        resyncRequired = true
      } else if (afterSeq > this.#lastSeq) {
        resyncRequired = true
      }
    }

    let startIndex = 0
    if (afterId !== undefined) {
      const idx = this.#history.findIndex(({ event }) => event.id === afterId)
      if (idx === -1) {
        resyncRequired = true
      } else {
        startIndex = idx + 1
      }
    }

    if (max === 0) {
      return {
        events: [],
        cursor: this.#lastSeq,
        oldestRetainedSeq,
        resyncRequired,
      }
    }

    const owned = accountSet(subscriber)
    const events = this.#history
      .slice(startIndex)
      .filter(({ seq, event }) => {
        if (afterSeq !== undefined && seq <= afterSeq) return false
        return canReceiveLiveEvent(subscriber, event, owned)
      })
      .slice(-max)
      .map(({ event }) => event)

    return {
      events,
      cursor: this.#lastSeq,
      oldestRetainedSeq,
      resyncRequired,
    }
  }

  attachToServer(server: HttpServer, authenticate: AuthenticateUpgrade, onConnected?: ConnectedHook, claimUpgrade?: UpgradeClaim): void {
    const transport = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      perMessageDeflate: false,
      maxPayload: MAX_FRAME_BYTES,
      skipUTF8Validation: false,
    })
    const ownConnections = new Set<() => void>()
    server.once('close', () => {
      for (const close of ownConnections) close()
      transport.close()
    })
    server.on('upgrade', (req, socket, head) => {
      if (claimUpgrade?.(req, socket, head)) return
      if (this.#pendingUpgrades >= MAX_PENDING_UPGRADES || this.#networkClosers.size + this.#pendingUpgrades >= MAX_NETWORK_CLIENTS) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n', () => socket.destroy())
        return
      }
      this.#pendingUpgrades++
      void this.#upgrade(req, socket, head, authenticate, transport, ownConnections, onConnected)
        .catch(() => socket.destroy())
        .finally(() => { this.#pendingUpgrades-- })
    })
  }

  async #upgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    authenticate: AuthenticateUpgrade,
    transport: WebSocketServer,
    ownConnections: Set<() => void>,
    onConnected?: ConnectedHook,
  ): Promise<void> {
    socket.once('error', () => socket.destroy())
    const deadline = setTimeout(() => socket.destroy(), AUTHENTICATION_TIMEOUT_MS)
    deadline.unref()
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== '/api/ws') {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n', () => socket.destroy())
        return
      }
      if (req.headers['sec-websocket-version'] !== '13') {
        socket.end('HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Version: 13\r\nConnection: close\r\n\r\n', () => socket.destroy())
        return
      }
      const subscriber = await authorizeBeforeDeadline(req, authenticate)
      if (socket.destroyed) return
      if (subscriber === WS_AUTHORIZATION_UNAVAILABLE) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n', () => socket.destroy())
        return
      }
      if (!subscriber) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n', () => socket.destroy())
        return
      }
      transport.handleUpgrade(req, socket, head, (ws) => {
        const session = new AbortController()
        const close = this.#connect(ws, req, subscriber, authenticate, () => session.abort())
        void Promise.resolve(onConnected?.(req, subscriber, session.signal)).catch(close)
        ownConnections.add(close)
        ws.once('close', () => ownConnections.delete(close))
        const afterSeqParam = url.searchParams.get('afterSeq') ?? url.searchParams.get('cursor')
        const afterSeq = afterSeqParam !== null && /^\d+$/.test(afterSeqParam) ? Number(afterSeqParam) : undefined
        const afterId = url.searchParams.get('afterId') ?? undefined
        if (url.searchParams.get('replay') === '1' || afterSeq !== undefined || afterId !== undefined) {
          for (const event of this.recentEventsFor(subscriber, MAX_QUEUED_EVENTS, {
            ...(afterSeq !== undefined && { afterSeq }),
            ...(afterId !== undefined && { afterId }),
          })) {
            close.enqueue(event)
          }
        }
      })
    } finally {
      clearTimeout(deadline)
    }
  }

  #connect(ws: WebSocket, req: IncomingMessage, initial: EventSubscriber, authenticate: AuthenticateUpgrade, onEnd?: () => void) {
    const queue: QueuedEvent[] = []
    let queuedBytes = 0
    let flushing = false
    let checkingHeartbeat = false
    let closed = false
    let expectedPong: Buffer | null = null
    let pongDeadline: ReturnType<typeof setTimeout> | undefined
    const registration = this.#register(initial, enqueue)
    const heartbeat = setInterval(() => { void checkHeartbeat() }, this.#heartbeatIntervalMs)
    heartbeat.unref()

    const cleanup = () => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      clearTimeout(pongDeadline)
      queue.length = 0
      queuedBytes = 0
      registration.unregister()
      this.#networkClosers.delete(disconnect)
      onEnd?.()
    }
    const disconnect = () => {
      cleanup()
      ws.terminate()
    }
    this.#networkClosers.add(disconnect)

    const refresh = async (): Promise<EventSubscriber | null> => {
      const current = await authorizeBeforeDeadline(req, authenticate)
      if (closed || !current || current === WS_AUTHORIZATION_UNAVAILABLE) return null
      if (
        current.kind !== initial.kind ||
        (initial.id !== undefined && current.id !== initial.id) ||
        (initial.kind === 'user' && current.kind === 'user' && (current.accountId !== initial.accountId || current.mailboxLogin?.toLowerCase() !== initial.mailboxLogin?.toLowerCase())) ||
        (initial.kind === 'service' && current.kind === 'service' && current.login.toLowerCase() !== initial.login.toLowerCase())
      ) {
        return null
      }
      const owned = accountSet(current)
      registration.client.subscriber = current
      registration.client.ownedAccountIds = owned
      return current
    }

    const flush = async () => {
      if (flushing || closed) return
      flushing = true
      try {
        while (queue.length > 0 && !closed) {
          const current = await refresh()
          if (!current) return disconnect()
          const owned = accountSet(current)
          let writeIdx = 0
          for (let i = 0; i < queue.length; i++) {
            const candidate = queue[i]!
            if (canReceiveLiveEvent(current, candidate.event, owned)) {
              queue[writeIdx++] = candidate
            } else {
              queuedBytes -= candidate.bytes
            }
          }
          queue.length = writeIdx
          if (queue.length === 0) {
            if (current.kind === 'user') return disconnect()
            break
          }
          const item = queue.shift()!
          queuedBytes -= item.bytes
          if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount + item.bytes > MAX_SOCKET_BUFFER_BYTES) {
            return disconnect()
          }
          ws.send(item.payload, { binary: false, compress: false }, (error) => { if (error) disconnect() })
        }
      } catch {
        disconnect()
      } finally {
        flushing = false
      }
    }

    function enqueue(event: SequencedLiveEvent): void {
      if (closed) return
      const payload = JSON.stringify(event)
      const bytes = Buffer.byteLength(payload)
      if (bytes > MAX_FRAME_BYTES || queue.length >= MAX_QUEUED_EVENTS || queuedBytes + bytes > MAX_QUEUED_BYTES) {
        disconnect()
        return
      }
      queue.push({ event, payload, bytes })
      queuedBytes += bytes
      void flush()
    }

    const checkHeartbeat = async () => {
      if (closed || checkingHeartbeat) return
      checkingHeartbeat = true
      try {
        if (!await refresh() || ws.readyState !== WebSocket.OPEN) return disconnect()
        if (expectedPong) return
        expectedPong = randomBytes(8)
        ws.ping(expectedPong)
        pongDeadline = setTimeout(disconnect, this.#pongTimeoutMs)
        pongDeadline.unref()
      } catch {
        disconnect()
      } finally {
        checkingHeartbeat = false
      }
    }
    ws.on('pong', (payload) => {
      if (expectedPong?.equals(payload)) {
        expectedPong = null
        clearTimeout(pongDeadline)
      }
    })
    // Reject fragmented client data frames immediately rather than buffering incomplete fragments.
    const rawSocket = (ws as unknown as { _socket?: Duplex })._socket ?? req.socket
    const checkFragmentedData = () => {
      const receiver = (ws as unknown as { _receiver?: { _fragmented?: number } })._receiver
      if (receiver && receiver._fragmented) disconnect()
    }
    rawSocket?.on('data', checkFragmentedData)
    ws.once('close', () => rawSocket?.off('data', checkFragmentedData))
    // This endpoint is a server event feed. It accepts control frames, not client commands.
    ws.on('message', disconnect)
    ws.on('error', disconnect)
    ws.once('close', cleanup)
    return Object.assign(disconnect, { enqueue })
  }
}
