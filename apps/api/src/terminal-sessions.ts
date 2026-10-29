import { createHash, randomBytes } from 'node:crypto'

export const TERMINAL_TICKET_TTL_MS = 60_000
/** One terminal input message; larger pastes are split by the browser. The agent enforces the same bound. */
export const TERMINAL_MAX_INPUT_BYTES = 4096
export const TERMINAL_MAX_FRAME_BYTES = 8192
/** Input messages waiting for the agent; a client that floods past this is disconnected. */
export const TERMINAL_MAX_PENDING_INPUTS = 32
/** The panel session behind a live terminal is re-checked this often; a revoked session ends the terminal. */
export const TERMINAL_REAUTH_INTERVAL_MS = 30_000
export const TERMINAL_OPEN_DEADLINE_MS = 10_000
/** Output waits while the browser socket holds more than this. */
export const TERMINAL_MAX_SOCKET_BUFFER_BYTES = 512 * 1024

export type TerminalKind = 'root' | 'account'
export interface TerminalGrant {
  kind: TerminalKind
  principalId: string
  actor: string
  /** The interactive panel session that re-authenticated; the socket must present the same session. */
  panelSessionId: string
  /** The exact page origin that asked for the ticket; the socket must come from the same origin. */
  origin: string
  accountId: string | null
  accountUsername: string | null
}
export interface TerminalPresenter { principalId: string; panelSessionId: string; origin: string | null }

const digest = (ticket: string): string => createHash('sha256').update(ticket, 'utf8').digest('hex')

/** Short-lived, single-use tickets. Only a hash is held; a principal has at most one outstanding ticket. */
export class TerminalTickets {
  readonly #byHash = new Map<string, { grant: TerminalGrant; expiresAt: number }>()
  readonly #now: () => number
  readonly #ttlMs: number
  constructor(options: { now?: () => number; ttlMs?: number } = {}) {
    this.#now = options.now ?? (() => Date.now())
    this.#ttlMs = options.ttlMs ?? TERMINAL_TICKET_TTL_MS
  }

  issue(grant: TerminalGrant): { ticket: string; expiresAt: string } {
    this.#sweep()
    for (const [hash, entry] of this.#byHash) if (entry.grant.principalId === grant.principalId) this.#byHash.delete(hash)
    const ticket = randomBytes(32).toString('base64url'), expiresAt = this.#now() + this.#ttlMs
    this.#byHash.set(digest(ticket), { grant: { ...grant }, expiresAt })
    return { ticket, expiresAt: new Date(expiresAt).toISOString() }
  }

  /** Any presentation spends the ticket, matching or not; a mismatched one cannot be retried. */
  consume(ticket: unknown, presenter: TerminalPresenter): TerminalGrant | null {
    this.#sweep()
    if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) return null
    const hash = digest(ticket), entry = this.#byHash.get(hash)
    if (!entry) return null
    this.#byHash.delete(hash)
    const { grant } = entry
    if (entry.expiresAt <= this.#now() || grant.principalId !== presenter.principalId || grant.panelSessionId !== presenter.panelSessionId || grant.origin !== presenter.origin) return null
    return grant
  }

  get size(): number { this.#sweep(); return this.#byHash.size }

  #sweep(): void {
    const now = this.#now()
    for (const [hash, entry] of this.#byHash) if (entry.expiresAt <= now) this.#byHash.delete(hash)
  }
}

export type TerminalOwner = Pick<TerminalGrant, 'principalId' | 'panelSessionId' | 'accountId'>
/** Which live terminals a revocation ends; every given field must match. */
export interface TerminalRevocation { principalId?: string; panelSessionId?: string; exceptPanelSessionId?: string; accountId?: string }

/** One live terminal per user in this API process. The agent holds the same rule host-wide. */
export class TerminalRegistry {
  readonly #live = new Map<string, { token: symbol; owner: TerminalOwner; close: (reason: string) => void }>()

  has(principalId: string): boolean { return this.#live.has(principalId) }

  /** Returns a release function, or null when the user already has a live terminal. */
  claim(owner: TerminalOwner, close: (reason: string) => void): (() => void) | null {
    if (this.#live.has(owner.principalId)) return null
    const token = Symbol(owner.principalId)
    this.#live.set(owner.principalId, { token, owner: { ...owner }, close })
    return () => { if (this.#live.get(owner.principalId)?.token === token) this.#live.delete(owner.principalId) }
  }

  /** Explicit Close session from any tab of the same user. */
  close(principalId: string): boolean {
    const live = this.#live.get(principalId)
    if (!live) return false
    live.close('closed')
    return true
  }

  /** Ends, at once, every live terminal whose panel session or account just lost its authority. */
  revoke(match: TerminalRevocation): number {
    if (match.principalId === undefined && match.panelSessionId === undefined && match.accountId === undefined) return 0
    const ended = [...this.#live.values()].filter(({ owner }) => (match.principalId === undefined || owner.principalId === match.principalId)
      && (match.panelSessionId === undefined || owner.panelSessionId === match.panelSessionId)
      && (match.exceptPanelSessionId === undefined || owner.panelSessionId !== match.exceptPanelSessionId)
      && (match.accountId === undefined || owner.accountId === match.accountId))
    for (const live of ended) live.close('revoked')
    return ended.length
  }

  closeAll(): void { for (const live of [...this.#live.values()]) live.close('closed') }
}

export type TerminalClientMessage =
  | { type: 'open'; ticket: string; cols: number; rows: number }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'close' }

const integer = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max

/** Strict browser message grammar; anything else ends the session. */
export function parseTerminalClientMessage(raw: string): TerminalClientMessage | null {
  if (Buffer.byteLength(raw, 'utf8') > TERMINAL_MAX_FRAME_BYTES) return null
  let value: unknown
  try { value = JSON.parse(raw) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const message = value as Record<string, unknown>, keys = Object.keys(message).sort().join()
  if (message.type === 'open') return keys === 'cols,rows,ticket,type' && typeof message.ticket === 'string' && integer(message.cols, 20, 500) && integer(message.rows, 5, 200) ? { type: 'open', ticket: message.ticket, cols: message.cols, rows: message.rows } : null
  if (message.type === 'input') return keys === 'data,type' && typeof message.data === 'string' && message.data.length > 0 && Buffer.byteLength(message.data, 'utf8') <= TERMINAL_MAX_INPUT_BYTES ? { type: 'input', data: message.data } : null
  if (message.type === 'resize') return keys === 'cols,rows,type' && integer(message.cols, 20, 500) && integer(message.rows, 5, 200) ? { type: 'resize', cols: message.cols, rows: message.rows } : null
  if (message.type === 'close') return keys === 'type' ? { type: 'close' } : null
  return null
}
