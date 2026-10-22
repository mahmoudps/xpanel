// Wakes the reconciler when desired state changes. One dedicated connection (never a
// pooled one: a pool would hand the LISTEN session to other queries and drop it on
// release). Notifications sent while disconnected are lost, so every (re)connect is
// followed by a full reconcile; a notification's payload is only a hint.
import pg from 'pg'
import { fail } from '@xpanel/core'
import { DB_URL_RE } from './client.ts'

/** Channel the 0001_init NOTIFY triggers write to; the payload is the changed table's name. */
export const DESIRED_STATE_CHANNEL = 'xpanel_desired_state'

const TABLE_RE = /^[a-z_][a-z0-9_]{0,62}$/

export type ReconcileReason = 'connected' | 'reconnected'

/** The part of pg.Client the listener uses. */
export interface ListenerClient {
  connect(): Promise<unknown>
  query(text: string): Promise<unknown>
  end(): Promise<void>
  on(event: 'notification', fn: (n: { channel: string; payload?: string | undefined }) => void): unknown
  on(event: 'error', fn: (e: Error) => void): unknown
  on(event: 'end', fn: () => void): unknown
  removeAllListeners(): unknown
}

export interface DesiredStateListenerOptions {
  /** postgres:// URL of the control database; the listener opens its own connection */
  url?: string
  /** connection factory instead of `url` */
  client?: () => ListenerClient
  /** full reconcile; runs after every successful LISTEN */
  onReconcile: (reason: ReconcileReason) => void | Promise<void>
  /** a desired-state table changed (hint only: re-read the tables) */
  onHint?: (table: string) => void
  /** connection failures and reconcile errors; the listener keeps retrying */
  onError?: (e: unknown) => void
  /** capped exponential backoff, defaults 500 ms doubling up to 30 s */
  initialDelayMs?: number
  maxDelayMs?: number
  /** jitter source in [0, 1), injectable for tests */
  random?: () => number
}

export interface DesiredStateListener {
  close(): Promise<void>
}

const delayBounds = (v: number | undefined, def: number, what: string): number => {
  if (v === undefined) return def
  return Number.isSafeInteger(v) && v >= 1 && v <= 3_600_000 ? v : fail('VALIDATION', `${what} must be 1..3600000 ms`)
}

const urlClient = (url: string) => (): ListenerClient =>
  new pg.Client({ connectionString: url, application_name: 'xpanel-listener', connectionTimeoutMillis: 10_000, keepAlive: true })

/** Equal jitter: half the capped exponential step fixed, half random, so retries never collapse to 0. */
export const backoffDelay = (attempt: number, initialMs: number, maxMs: number, random: () => number): number => {
  const step = Math.min(maxMs, initialMs * 2 ** Math.min(attempt, 30))
  return step / 2 + (step / 2) * Math.min(Math.max(random(), 0), 1)
}

export const listenDesiredState = (opts: DesiredStateListenerOptions): DesiredStateListener => {
  if (typeof opts.onReconcile !== 'function') fail('VALIDATION', 'onReconcile is required')
  let make: () => ListenerClient
  if (opts.client) make = opts.client
  else if (typeof opts.url === 'string' && DB_URL_RE.test(opts.url)) make = urlClient(opts.url)
  else return fail('VALIDATION', 'listener needs a postgres:// url or a client factory')
  const initialMs = delayBounds(opts.initialDelayMs, 500, 'initialDelayMs')
  const maxMs = Math.max(initialMs, delayBounds(opts.maxDelayMs, 30_000, 'maxDelayMs'))
  const random = opts.random ?? Math.random
  const report = (e: unknown): void => opts.onError?.(e)

  let closed = false
  let connectedOnce = false
  let attempt = 0
  let current: ListenerClient | null = null
  let timer: ReturnType<typeof setTimeout> | undefined

  const discard = (c: ListenerClient): void => {
    c.removeAllListeners()
    // a dead socket can still emit; without a listener that would crash the process
    c.on('error', () => {})
    void c.end().catch(() => {})
  }

  const schedule = (): void => {
    if (closed || timer !== undefined) return
    const delay = backoffDelay(attempt, initialMs, maxMs, random)
    attempt += 1
    timer = setTimeout(() => {
      timer = undefined
      void open()
    }, delay)
  }

  const open = async (): Promise<void> => {
    if (closed) return
    const c = make()
    current = c
    let down = false
    const lost = (e?: unknown): void => {
      if (down) return
      down = true
      if (current === c) current = null
      discard(c)
      if (closed) return
      if (e !== undefined) report(e)
      schedule()
    }
    c.on('error', (e) => lost(e))
    c.on('end', () => lost())
    c.on('notification', (n) => {
      if (n.channel === DESIRED_STATE_CHANNEL && typeof n.payload === 'string' && TABLE_RE.test(n.payload)) opts.onHint?.(n.payload)
    })
    try {
      await c.connect()
      await c.query(`LISTEN ${DESIRED_STATE_CHANNEL}`)
    } catch (e) {
      lost(e)
      return
    }
    if (down || closed) return
    attempt = 0
    const reason: ReconcileReason = connectedOnce ? 'reconnected' : 'connected'
    connectedOnce = true
    try {
      await opts.onReconcile(reason)
    } catch (e) {
      report(e)
    }
  }

  void open()

  return {
    async close(): Promise<void> {
      closed = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      const c = current
      current = null
      if (c) {
        c.removeAllListeners()
        c.on('error', () => {})
        await c.end().catch(() => {})
      }
    },
  }
}
