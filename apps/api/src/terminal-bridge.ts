import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket, { WebSocketServer } from 'ws'
import {
  parseTerminalClientMessage, TERMINAL_MAX_FRAME_BYTES, TERMINAL_MAX_PENDING_INPUTS, TERMINAL_MAX_SOCKET_BUFFER_BYTES,
  TERMINAL_OPEN_DEADLINE_MS, TERMINAL_REAUTH_INTERVAL_MS,
} from './terminal-sessions.ts'
import type { TerminalGrant, TerminalRegistry, TerminalTickets } from './terminal-sessions.ts'

export const TERMINAL_WS_PATH = '/api/terminal/ws'
const MAX_PENDING_UPGRADES = 16
const MAX_AGENT_LINE_BYTES = 1024 * 1024

export interface TerminalIdentity { principalId: string; actor: string; panelSessionId: string; clientIp: string | null }
export interface AgentTerminalSession { id: string; startedAt: string; idleTimeoutSeconds: number; absoluteTimeoutSeconds: number }
/** The agent's terminal routes, called as the grant's principal over the authenticated agent socket. */
export interface TerminalAgentPort {
  open(grant: TerminalGrant, cols: number, rows: number): Promise<AgentTerminalSession>
  output(grant: TerminalGrant, id: string): Promise<ReadableStream<Uint8Array>>
  input(grant: TerminalGrant, id: string, data: string): Promise<void>
  resize(grant: TerminalGrant, id: string, cols: number, rows: number): Promise<void>
  close(grant: TerminalGrant, id: string): Promise<void>
}
export interface TerminalAuditEntry { actor: string; principalId: string; action: string; target: string; detail: Record<string, unknown>; outcome: 'ok' | 'failed'; ip: string | null }
export interface TerminalBridgeDeps {
  allowedOrigin(origin: string, req: IncomingMessage): boolean
  /** Fresh cookie authentication of the upgrade request: an interactive, verified panel session, or null. */
  authenticate(req: IncomingMessage): Promise<TerminalIdentity | null>
  tickets: TerminalTickets
  registry: TerminalRegistry
  agent: TerminalAgentPort
  audit(entry: TerminalAuditEntry): Promise<unknown>
  now?: () => number
  reauthIntervalMs?: number
}

const auditNames = (grant: TerminalGrant) => grant.kind === 'root'
  ? { opened: 'server.terminal.session_opened', closed: 'server.terminal.session_closed', target: 'server:terminal' }
  : { opened: 'account.terminal.session_opened', closed: 'account.terminal.session_closed', target: `account:${grant.accountUsername}` }

/**
 * Browser side of a terminal: one WebSocket per session on the panel listener. The socket carries the panel
 * session cookie, then spends a single-use ticket issued after the page's authorization; keystrokes and output
 * pass through and are never recorded.
 */
export function createTerminalBridge(deps: TerminalBridgeDeps): { handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean; close(): void } {
  const transport = new WebSocketServer({ noServer: true, clientTracking: false, perMessageDeflate: false, maxPayload: TERMINAL_MAX_FRAME_BYTES })
  const now = deps.now ?? Date.now
  const live = new Set<(reason: string) => void>()
  let pending = 0

  const run = (ws: WebSocket, req: IncomingMessage, identity: TerminalIdentity, origin: string): void => {
    const sessionId = randomUUID()
    let state: 'awaiting' | 'opening' | 'open' = 'awaiting'
    let grant: TerminalGrant | null = null, agentSession: AgentTerminalSession | null = null, startedAt = 0
    let release: (() => void) | null = null, audited = false, finishing = false
    const inputs: string[] = []
    let draining = false
    const send = (message: unknown): void => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)) }

    const finish = async (reason: string, code?: number | null): Promise<void> => {
      if (finishing) return
      finishing = true
      live.delete(finish)
      clearTimeout(openDeadline); clearInterval(reauth)
      send({ type: 'end', reason, ...(code !== undefined ? { code } : {}) })
      ws.close(1000)
      if (grant && agentSession) await deps.agent.close(grant, agentSession.id).catch(() => undefined)
      release?.()
      if (grant && audited) {
        const names = auditNames(grant)
        await deps.audit({ actor: grant.actor, principalId: grant.principalId, action: names.closed, target: names.target, outcome: 'ok', ip: identity.clientIp,
          detail: { sessionId, clientIp: identity.clientIp, account: grant.accountUsername, reason, durationSeconds: startedAt ? Math.max(0, Math.round((now() - startedAt) / 1000)) : 0 } }).catch(() => undefined)
      }
    }
    live.add(finish)
    const openDeadline = setTimeout(() => void finish('denied'), TERMINAL_OPEN_DEADLINE_MS)
    openDeadline.unref()
    const reauth = setInterval(() => {
      void deps.authenticate(req).catch(() => null).then(fresh => {
        if (!fresh || fresh.principalId !== identity.principalId || fresh.panelSessionId !== identity.panelSessionId) void finish('revoked')
      })
    }, deps.reauthIntervalMs ?? TERMINAL_REAUTH_INTERVAL_MS)
    reauth.unref()

    const drainInputs = async (): Promise<void> => {
      if (draining) return
      draining = true
      try {
        while (inputs.length && !finishing) await deps.agent.input(grant!, agentSession!.id, inputs.shift()!)
      } catch { void finish('error') } finally { draining = false }
    }

    const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const reader = stream.getReader(), text = new StringDecoder('utf8')
      let buffered = '', end: { reason?: unknown; code?: unknown } | null = null
      try {
        while (!finishing && !end) {
          const next = await reader.read()
          if (next.done) break
          buffered += Buffer.from(next.value).toString('utf8')
          if (buffered.length > MAX_AGENT_LINE_BYTES) break
          let newline = buffered.indexOf('\n')
          while (newline !== -1 && !end) {
            const line = JSON.parse(buffered.slice(0, newline)) as { o?: unknown; end?: { reason?: unknown; code?: unknown } }
            buffered = buffered.slice(newline + 1)
            if (typeof line.o === 'string') {
              const data = text.write(Buffer.from(line.o, 'base64'))
              if (data) send({ type: 'output', data })
            } else if (line.end && typeof line.end === 'object') end = line.end
            newline = buffered.indexOf('\n')
          }
          // The agent pauses the shell while this read waits: browser backpressure reaches the PTY.
          while (!finishing && ws.bufferedAmount > TERMINAL_MAX_SOCKET_BUFFER_BYTES) await delay(25)
        }
      } catch { end = null } finally { await reader.cancel().catch(() => undefined) }
      const reason = end && typeof end.reason === 'string' && /^[a-z_]{1,32}$/.test(end.reason) ? end.reason : 'error'
      void finish(reason, end && (typeof end.code === 'number' || end.code === null) ? end.code as number | null : undefined)
    }

    const start = async (ticket: string, cols: number, rows: number): Promise<void> => {
      grant = deps.tickets.consume(ticket, { principalId: identity.principalId, panelSessionId: identity.panelSessionId, origin })
      if (!grant) return void finish('denied')
      release = deps.registry.claim({ principalId: grant.principalId, panelSessionId: grant.panelSessionId, accountId: grant.accountId }, reason => void finish(reason))
      if (!release) { grant = null; return void finish('busy') }
      clearTimeout(openDeadline)
      const names = auditNames(grant)
      // A session that cannot be audited is never opened.
      try {
        await deps.audit({ actor: grant.actor, principalId: grant.principalId, action: names.opened, target: names.target, outcome: 'ok', ip: identity.clientIp,
          detail: { sessionId, clientIp: identity.clientIp, account: grant.accountUsername } })
        audited = true
      } catch { return void finish('audit_failed') }
      if (finishing) return
      try { agentSession = await deps.agent.open(grant, cols, rows) } catch { return void finish('unavailable') }
      if (finishing) { await deps.agent.close(grant, agentSession.id).catch(() => undefined); return }
      startedAt = now()
      let stream: ReadableStream<Uint8Array>
      try { stream = await deps.agent.output(grant, agentSession.id) } catch { return void finish('unavailable') }
      state = 'open'
      send({ type: 'ready', session: { id: sessionId, startedAt: new Date(startedAt).toISOString(), idleTimeoutSeconds: agentSession.idleTimeoutSeconds, absoluteTimeoutSeconds: agentSession.absoluteTimeoutSeconds } })
      void pump(stream)
    }

    ws.on('message', (data, isBinary) => {
      if (finishing) return
      const message = isBinary ? null : parseTerminalClientMessage(Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.concat(data as Buffer[]).toString('utf8'))
      if (!message) return void finish('protocol')
      if (state === 'awaiting' && message.type === 'open') { state = 'opening'; void start(message.ticket, message.cols, message.rows); return }
      if (state !== 'open') return void finish(message.type === 'close' ? 'closed' : 'protocol')
      if (message.type === 'input') {
        if (inputs.length >= TERMINAL_MAX_PENDING_INPUTS) return void finish('overflow')
        inputs.push(message.data); void drainInputs()
      } else if (message.type === 'resize') void deps.agent.resize(grant!, agentSession!.id, message.cols, message.rows).catch(() => undefined)
      else if (message.type === 'close') void finish('closed')
      else void finish('protocol')
    })
    ws.once('close', () => void finish('closed'))
    ws.on('error', () => void finish('error'))
  }

  return {
    handleUpgrade(req, socket, head) {
      let url: URL
      try { url = new URL(req.url ?? '/', 'http://localhost') } catch { return false }
      if (url.pathname !== TERMINAL_WS_PATH) return false
      const reject = (status: string): void => { socket.end(`HTTP/1.1 ${status}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n`, () => socket.destroy()) }
      socket.once('error', () => socket.destroy())
      if (pending >= MAX_PENDING_UPGRADES) { reject('503 Service Unavailable'); return true }
      if (url.search || req.headers['sec-websocket-version'] !== '13') { reject('400 Bad Request'); return true }
      const origin = req.headers.origin
      if (!origin || !deps.allowedOrigin(origin, req)) { reject('403 Forbidden'); return true }
      pending++
      void deps.authenticate(req).catch(() => null).then(identity => {
        if (socket.destroyed) return
        if (!identity) return reject('401 Unauthorized')
        transport.handleUpgrade(req, socket, head, ws => run(ws, req, identity, origin))
      }).finally(() => { pending-- })
      return true
    },
    close() {
      for (const finish of [...live]) void finish('closed')
      transport.close()
    },
  }
}
