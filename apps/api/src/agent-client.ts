import { request } from 'node:http'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { dirname, isAbsolute } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { lstat } from 'node:fs/promises'
import { assertAgentCredential, assertRootOwnedAgentPath, MAX_AGENT_MESSAGE_BYTES } from '@xpanel/agent'
import type { AgentApp } from '@xpanel/agent'
import { fail, XpanelError } from '@xpanel/core'
import type { LiveEvent } from '@xpanel/core'

export interface AgentClientOptions {
  socketPath: string
  token: string
  timeoutMs?: number
}

const unavailable = () => new XpanelError('SERVICE_UNAVAILABLE', 'privileged host agent is unavailable')

const boundedBody = async (body: ReadableStream<Uint8Array> | null): Promise<Buffer> => {
  const reader = body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) return Buffer.concat(chunks)
      bytes += next.value.byteLength
      if (bytes > MAX_AGENT_MESSAGE_BYTES) fail('LIMIT_EXCEEDED', 'agent message exceeds the transport limit')
      chunks.push(next.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

const assertSocketPath = async (path: string): Promise<void> => {
  if (process.platform !== 'linux') {
    if (!path.startsWith('\\\\.\\pipe\\')) fail('PRECONDITION_FAILED', 'local agent IPC path is required')
    return
  }
  if (!isAbsolute(path)) fail('PRECONDITION_FAILED', 'agent socket path must be absolute')
  await assertRootOwnedAgentPath(dirname(path))
  const socket = await lstat(path)
  if (!socket.isSocket() || socket.uid !== 0 || socket.gid === 0 || (socket.mode & 0o7777) !== 0o660) {
    fail('PRECONDITION_FAILED', 'agent socket must be root-owned with dedicated group and mode 0660')
  }
}

const responseHeaders = (response: IncomingMessage): Headers => {
  const headers = new Headers()
  for (const [key, value] of Object.entries(response.headers)) {
    if (typeof value === 'string') headers.set(key, value)
    else if (Array.isArray(value)) for (const item of value) headers.append(key, item)
  }
  return headers
}

/** A bounded local IPC client. It never creates a host executor or falls back to TCP. */
export const createAgentClient = (options: AgentClientOptions): AgentApp & { close(): void } => {
  const token = assertAgentCredential(options.token)
  const timeout = options.timeoutMs ?? 30_000
  if (!options.socketPath || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000) {
    fail('PRECONDITION_FAILED', 'valid agent socket and timeout are required')
  }
  const requests = new Set<ClientRequest>()
  const subscribers = new Set<(event: LiveEvent) => void>()
  let closed = false
  let streamRequest: ClientRequest | null = null
  let reconnect: ReturnType<typeof setTimeout> | null = null
  let retryMs = 1_000

  const stopEvents = () => {
    if (reconnect) clearTimeout(reconnect)
    reconnect = null
    streamRequest?.destroy()
    streamRequest = null
  }

  const remember = (req: ClientRequest) => {
    requests.add(req)
    req.once('close', () => requests.delete(req))
  }

  const fetch = async (req: Request): Promise<Response> => {
    if (closed) throw unavailable()
    const url = new URL(req.url)
    if (url.origin !== 'http://agent.local') fail('VALIDATION', 'agent client accepts internal agent requests only')
    try { await assertSocketPath(options.socketPath) } catch { throw unavailable() }
    const body = await boundedBody(req.body)
    if (closed) throw unavailable()
    const headers: Record<string, string> = {}
    for (const name of ['content-type', 'x-xpanel-principal-id']) {
      const value = req.headers.get(name)
      if (value !== null) headers[name] = value
    }
    headers['x-xpanel-agent-token'] = token
    headers['content-length'] = String(body.byteLength)
    return new Promise<Response>((resolveResponse, rejectResponse) => {
      const outgoing = request({
        socketPath: options.socketPath, path: `${url.pathname}${url.search}`,
        method: req.method, headers, timeout, signal: req.signal,
      }, response => {
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.byteLength
          if (bytes > MAX_AGENT_MESSAGE_BYTES) {
            rejectResponse(new XpanelError('LIMIT_EXCEEDED', 'agent response exceeds the transport limit'))
            response.destroy()
            return
          }
          chunks.push(Buffer.from(chunk))
        })
        response.once('error', () => rejectResponse(unavailable()))
        response.once('aborted', () => rejectResponse(unavailable()))
        response.once('end', () => {
          const status = response.statusCode ?? 502
          resolveResponse(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), {
            status, headers: responseHeaders(response),
          }))
        })
      })
      remember(outgoing)
      outgoing.once('timeout', () => outgoing.destroy(unavailable()))
      outgoing.once('error', () => rejectResponse(unavailable()))
      outgoing.end(body)
    })
  }

  const scheduleReconnect = () => {
    if (closed || subscribers.size === 0 || reconnect) return
    reconnect = setTimeout(() => {
      reconnect = null
      void connectEvents()
    }, retryMs)
    reconnect.unref()
    retryMs = Math.min(retryMs * 2, 30_000)
  }

  const connectEvents = async () => {
    if (closed || subscribers.size === 0 || streamRequest) return
    try { await assertSocketPath(options.socketPath) } catch { scheduleReconnect(); return }
    if (closed || subscribers.size === 0 || streamRequest) return
    const outgoing = request({
      socketPath: options.socketPath, path: '/internal/events', method: 'GET',
      headers: { 'x-xpanel-agent-token': token }, timeout: 45_000,
    }, response => {
      if (response.statusCode !== 200 || !response.headers['content-type']?.startsWith('application/x-ndjson')) {
        response.resume()
        if (response.statusCode === 401 || response.statusCode === 403) {
          streamRequest = null
          return
        }
        response.once('end', disconnected)
        return
      }
      retryMs = 1_000
      const decoder = new StringDecoder('utf8')
      let pending = ''
      response.on('data', (chunk: Buffer) => {
        pending += decoder.write(chunk)
        if (Buffer.byteLength(pending) > 256 * 1024) { response.destroy(); return }
        let newline = pending.indexOf('\n')
        while (newline !== -1) {
          const line = pending.slice(0, newline)
          pending = pending.slice(newline + 1)
          if (Buffer.byteLength(line) > 128 * 1024) { response.destroy(); return }
          let item: unknown
          try { item = JSON.parse(line) } catch { response.destroy(); return }
          if (!item || typeof item !== 'object' || Array.isArray(item)) { response.destroy(); return }
          const event = (item as { event?: unknown }).event
          if (event !== undefined) {
            if (!event || typeof event !== 'object' || typeof (event as LiveEvent).kind !== 'string' ||
              !(event as LiveEvent).scope || typeof (event as LiveEvent).scope !== 'object') {
              response.destroy(); return
            }
            for (const subscriber of subscribers) {
              try { subscriber(event as LiveEvent) } catch {
                subscribers.delete(subscriber)
                process.emitWarning('Agent event subscriber failed and was disconnected', { code: 'XPANEL_AGENT_SUBSCRIBER' })
              }
            }
            if (subscribers.size === 0) stopEvents()
          }
          newline = pending.indexOf('\n')
        }
      })
      response.once('error', disconnected)
      response.once('end', disconnected)
      response.once('close', disconnected)
      response.setTimeout(45_000, () => response.destroy())
    })
    const disconnected = () => {
      if (streamRequest !== outgoing) return
      streamRequest = null
      scheduleReconnect()
    }
    streamRequest = outgoing
    remember(outgoing)
    outgoing.once('timeout', () => outgoing.destroy())
    outgoing.once('error', disconnected)
    outgoing.end()
  }

  return {
    fetch,
    subscribe(subscriber) {
      if (closed) throw unavailable()
      subscribers.add(subscriber)
      void connectEvents()
      return () => {
        subscribers.delete(subscriber)
        if (subscribers.size === 0) stopEvents()
      }
    },
    close() {
      closed = true
      subscribers.clear()
      stopEvents()
      for (const pending of requests) pending.destroy()
      streamRequest = null
    },
  }
}
