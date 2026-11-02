import { chmod, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { ApiApp } from '../server.ts'
import type { CliActAs } from './identity.ts'

export const CLI_ACT_AS_HEADER = 'x-xpanel-act-as'
export const MAX_CLI_CONNECTIONS = 32
export const MAX_CLI_REQUESTS_PER_UID = 4
const MAX_BODY_BYTES = 1024 * 1024
// Everything else (cookies, Authorization, forwarding and ingress headers) never reaches the app.
const FORWARDED_HEADERS = ['accept', 'accept-language', 'content-type', 'idempotency-key', 'user-agent'] as const

/** `user:<name>` or `reseller:<name>`; null when absent, undefined when malformed. */
export const parseActAs = (value: string | string[] | undefined): CliActAs | null | undefined => {
  if (value === undefined) return null
  const match = typeof value === 'string' ? /^(user|reseller):([a-z][a-z0-9_-]{0,63})$/.exec(value) : null
  return match ? { kind: match[1] as CliActAs['kind'], name: match[2]! } : undefined
}

const problem = (res: ServerResponse, status: number, code: string, detail: string): void => {
  res.writeHead(status, { 'content-type': 'application/problem+json; charset=utf-8' })
  res.end(JSON.stringify({ type: 'about:blank', title: code, status, code, detail }))
}

const readBody = async (req: IncomingMessage): Promise<Buffer<ArrayBuffer> | null> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength
    if (size > MAX_BODY_BYTES) return null
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks, size)
}

const writeResponse = async (res: ServerResponse, response: Response): Promise<void> => {
  res.statusCode = response.status
  response.headers.forEach((value, key) => { if (key !== 'set-cookie') res.setHeader(key, value) })
  const reader = response.body?.getReader()
  try {
    while (reader && !res.destroyed) {
      const next = await reader.read()
      if (next.done) break
      if (!res.write(next.value)) await new Promise(resolve => { res.once('drain', resolve); res.once('close', resolve) })
    }
  } finally {
    await reader?.cancel().catch(() => undefined)
  }
  res.end()
}

/**
 * Local socket of xuapi (xPanel app) or xwhmapi (xWHM app). It dispatches into the running app instance of that
 * listener, so route confinement, authorization, job serialization and audit are the ones of the panel itself.
 * The caller is the kernel peer UID of the connection; the app resolves and authorizes it (cli-api/identity.ts).
 */
export const listenCliApiSocket = async (app: ApiApp, opts: {
  socketPath: string
  /** Public origin of the listener this socket serves; requests carry it as their URL. */
  origin: string
  /** Kernel peer UID of an accepted connection; throwing refuses the connection. */
  peerUid: (socket: Socket) => number
}): Promise<{ server: Server; close: () => Promise<void> }> => {
  const peers = new WeakMap<Socket, number>()
  const inFlight = new Map<number, number>()
  const server = createServer(async (req, res) => {
    const uid = peers.get(req.socket)
    if (uid === undefined) { res.destroy(); return }
    const path = req.url ?? ''
    const actAs = parseActAs(req.headers[CLI_ACT_AS_HEADER])
    if (!path.startsWith('/api/')) { req.resume(); return problem(res, 404, 'NOT_FOUND', 'only /api/ routes are served here') }
    if (actAs === undefined) { req.resume(); return problem(res, 422, 'VALIDATION', `${CLI_ACT_AS_HEADER} must be user:<name> or reseller:<name>`) }
    if (req.headers.cookie !== undefined || req.headers.authorization !== undefined) {
      req.resume()
      return problem(res, 403, 'FORBIDDEN', 'the command-line API takes no session or token credentials')
    }
    const running = inFlight.get(uid) ?? 0
    if (running >= MAX_CLI_REQUESTS_PER_UID) { req.resume(); return problem(res, 429, 'LIMIT_EXCEEDED', 'too many command-line API calls are running for this user') }
    inFlight.set(uid, running + 1)
    try {
      const body = await readBody(req)
      if (body === null) return problem(res, 413, 'LIMIT_EXCEEDED', 'request body exceeds 1 MiB')
      const headers = new Headers()
      for (const name of FORWARDED_HEADERS) {
        const value = req.headers[name]
        if (typeof value === 'string') headers.set(name, value)
      }
      const method = req.method ?? 'GET'
      const request = new Request(`${opts.origin}${path}`, { method, headers, ...(body.byteLength && method !== 'GET' && method !== 'HEAD' ? { body } : {}) })
      await writeResponse(res, await app.fetch(request, { remoteAddress: '127.0.0.1', socketRemoteAddress: null, cliPeer: { uid, actAs } }))
    } catch {
      if (res.headersSent) res.destroy()
      else problem(res, 503, 'SERVICE_UNAVAILABLE', 'the command-line API call failed')
    } finally {
      const left = (inFlight.get(uid) ?? 1) - 1
      if (left > 0) inFlight.set(uid, left)
      else inFlight.delete(uid)
    }
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  server.maxConnections = MAX_CLI_CONNECTIONS
  server.on('connection', (socket: Socket) => {
    try { peers.set(socket, opts.peerUid(socket)) } catch { socket.destroy() }
  })
  const pipe = opts.socketPath.startsWith('\\\\.\\pipe\\')
  if (!pipe) await rm(opts.socketPath, { force: true })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(opts.socketPath, () => { server.off('error', reject); resolve() }) })
  // Any local user may connect; the kernel UID, not the socket mode, decides who the caller is.
  if (!pipe) await chmod(opts.socketPath, 0o666)
  return {
    server,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      if (!pipe) await rm(opts.socketPath, { force: true })
    },
  }
}
