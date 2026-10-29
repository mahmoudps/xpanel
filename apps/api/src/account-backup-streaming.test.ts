import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, request } from 'node:http'
import type { IncomingMessage, RequestListener, Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_AGENT_MESSAGE_BYTES } from '@xpanel/agent'
import { createAgentClient } from './agent-client.ts'
import { listenApiServer } from './server.ts'
import type { ApiApp } from './server.ts'
import { LiveEventHub } from './ws.ts'

// Real loopback sockets/HTTP framing and Windows IPC, with explicitly synthetic producers.
// This does not qualify Linux socket credentials, native archive execution or nginx capacity.
const token = randomBytes(32).toString('hex'), principalId = randomUUID()
const file = 'xpanel-backup-alice-20261026T100000Z.tar.gz'
const path = '/accounts/alice/backup-workspace/' + file + '/download'
const deferred = <T = void>() => { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const cleanup: (() => Promise<void>)[] = []
const within = async <T>(promise: Promise<T>, ms = 3000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('bounded stream fixture timed out')), ms) })]) }
  finally { if (timer) clearTimeout(timer) }
}
const gateway = async (fetcher: ApiApp['fetch'], ingress = false) => {
  const app: ApiApp = { fetch: fetcher, hub: new LiveEventHub(), authenticateUpgrade: async () => { throw new Error('no websocket fixture') }, watchMailbox: () => undefined }
  const socket = ingress && process.platform === 'win32' ? '\\\\.\\pipe\\xpanel-api-stream-' + randomUUID() : undefined
  const api = await listenApiServer(app, { port: 0, ...(socket ? { ingressSocketPath: socket } : {}) })
  cleanup.push(api.close)
  return { api, socket, url: 'http://127.0.0.1:' + api.port + '/fixture' }
}
const ipcServer = async (handler: RequestListener, timeoutMs = 1000) => {
  const socketPath = '\\\\.\\pipe\\xpanel-archive-stream-' + randomUUID(), server: Server = createServer(handler)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
  const client = createAgentClient({ socketPath, token, timeoutMs })
  cleanup.push(async () => { client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return client
}
const archiveHeaders = (res: import('node:http').ServerResponse, bytes: string | number): void => {
  res.setHeader('content-type', 'application/gzip'); res.setHeader('content-length', String(bytes)); res.setHeader('content-disposition', 'attachment; filename="' + file + '"')
}
const download = (signal?: AbortSignal): Request => new Request('http://agent.local' + path, { headers: { 'x-xpanel-principal-id': principalId }, signal })
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

describe('actual API HTTP streaming adapter', () => {
  it('delivers the first byte before producer completion and preserves repeated cookies', async () => {
    const gate = deferred(), headers = new Headers({ 'content-type': 'application/gzip', 'x-accel-buffering': 'no' })
    headers.append('set-cookie', 'first=one; HttpOnly'); headers.append('set-cookie', 'second=two; HttpOnly')
    let complete = false, pulls = 0
    const body = new ReadableStream<Uint8Array>({ async pull(controller) { if (pulls++ === 0) controller.enqueue(Buffer.from('first')); else { await gate.promise; complete = true; controller.enqueue(Buffer.from('last')); controller.close() } } })
    const { url } = await gateway(async () => new Response(body, { headers }))
    const response = await within(fetch(url)), reader = response.body!.getReader()
    expect(response.headers.getSetCookie()).toEqual(['first=one; HttpOnly', 'second=two; HttpOnly'])
    expect(response.headers.get('x-accel-buffering')).toBe('no')
    expect(Buffer.from((await within(reader.read())).value!).toString()).toBe('first'); expect(complete).toBe(false)
    gate.resolve(); expect(Buffer.from((await within(reader.read())).value!).toString()).toBe('last'); expect((await within(reader.read())).done).toBe(true)
    reader.releaseLock(); expect(complete).toBe(true)
  })
  it('cancels a producer on a disconnected consumer, including an already destroyed response', async () => {
    const entered = deferred(), release = deferred(), cancelled = deferred(), closed = deferred()
    const { api } = await gateway(async () => { entered.resolve(); await release.promise; return new Response(new ReadableStream({ cancel() { cancelled.resolve() } })) })
    const outgoing = request({ host: '127.0.0.1', port: api.port, path: '/delayed' }); outgoing.on('error', () => undefined); outgoing.once('close', () => closed.resolve()); outgoing.end()
    await within(entered.promise); outgoing.destroy(); await within(closed.promise); release.resolve(); await within(cancelled.promise)
  })
  it('cancels HEAD bodies without consuming or writing body bytes', async () => {
    const cancelled = deferred()
    const { url } = await gateway(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from('must-not-be-written')) }, cancel() { cancelled.resolve() } }), { headers: { 'content-type': 'text/plain' } }))
    const response = await within(fetch(url, { method: 'HEAD' })); expect(await response.text()).toBe(''); await within(cancelled.promise)
  })
  it('stops production when downstream closes during backpressure', async () => {
    const cancelled = deferred(), accepted = deferred<IncomingMessage>()
    let chunks = 0
    const { api } = await gateway(async () => new Response(new ReadableStream<Uint8Array>({ pull(controller) { chunks++; controller.enqueue(Buffer.alloc(256 * 1024)) }, cancel() { cancelled.resolve() } })))
    const outgoing = request({ host: '127.0.0.1', port: api.port, path: '/blocked' }, response => { response.pause(); accepted.resolve(response) }); outgoing.on('error', () => undefined); outgoing.end()
    const incoming = await within(accepted.promise); incoming.destroy(); outgoing.destroy(); await within(cancelled.promise)
    const stopped = chunks; await new Promise<void>(resolve => setImmediate(resolve)); expect(chunks).toBe(stopped)
  })
})

const windows = process.platform === 'win32' ? describe : describe.skip
windows('authenticated named-pipe archive transport and actual API/ingress sockets', () => {
  it('streams more than the JSON cap through IPC and API before completion', async () => {
    const gate = deferred(), length = MAX_AGENT_MESSAGE_BYTES + 32768
    let complete = false
    const ipc = await ipcServer(async (req, res) => {
      expect(req.url).toBe(path); expect(req.headers['x-xpanel-agent-token']).toBe(token); expect(req.headers['x-xpanel-principal-id']).toBe(principalId)
      archiveHeaders(res, length); res.write(Buffer.alloc(32768, 1)); await gate.promise; complete = true; res.end(Buffer.alloc(length - 32768, 2))
    })
    const { url } = await gateway(async () => ipc.fetch(download()))
    const response = await within(fetch(url)), reader = response.body!.getReader()
    const first = await within(reader.read()); expect(first.done).toBe(false); expect(first.value!.byteLength).toBeGreaterThan(0); expect(complete).toBe(false)
    gate.resolve(); let bytes = first.value!.byteLength
    for (;;) { const next = await within(reader.read()); if (next.done) break; bytes += next.value.byteLength }
    expect(bytes).toBe(length); expect(complete).toBe(true); reader.releaseLock()
  })
  it('streams through the trusted-ingress socket with the same adapter', async () => {
    const gate = deferred(), ipc = await ipcServer(async (_req, res) => { archiveHeaders(res, 8); res.write('head'); await gate.promise; res.end('tail') })
    const { socket } = await gateway(async () => ipc.fetch(download()), true), first = deferred<Buffer>(), complete = deferred<Buffer>()
    const outgoing = request({ socketPath: socket!, path: '/fixture' }, response => { const chunks: Buffer[] = []; response.on('data', chunk => { chunks.push(Buffer.from(chunk)); first.resolve(Buffer.from(chunk)) }); response.once('end', () => complete.resolve(Buffer.concat(chunks))) }); outgoing.end()
    expect((await within(first.promise)).toString()).toBe('head'); gate.resolve(); expect((await within(complete.promise)).toString()).toBe('headtail')
  })
  it.each([
    ['content-type', 'application/json'], ['content-length', '0'], ['content-length', '01'], ['content-length', String(2 * 1024 * 1024 * 1024 + 1)],
    ['content-disposition', 'attachment; filename="foreign.tar.gz"'], ['content-encoding', 'gzip'],
  ])('refuses an unverified archive response %s=%s', async (name, value) => {
    const ipc = await ipcServer((_req, res) => { archiveHeaders(res, 3); res.setHeader(name!, value!); res.flushHeaders(); res.end('abc') })
    await expect(ipc.fetch(download())).rejects.toMatchObject({ code: name === 'content-length' && Number(value) > 2 * 1024 * 1024 * 1024 ? 'LIMIT_EXCEEDED' : 'PRECONDITION_FAILED' })
  })
  it('rejects missing principal identity before any archive request', async () => {
    let requests = 0; const ipc = await ipcServer((_req, res) => { requests++; res.end() })
    await expect(ipc.fetch(new Request('http://agent.local' + path))).rejects.toMatchObject({ code: 'VALIDATION' }); expect(requests).toBe(0)
  })
  it('rejects truncated bytes rather than completing a partial archive', async () => {
    const ipc = await ipcServer((_req, res) => { archiveHeaders(res, 100); res.end('partial') })
    const response = await ipc.fetch(download()); await expect(response.arrayBuffer()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  })
  it('cancels IPC and closes the source connection when downstream cancels', async () => {
    const closed = deferred(), ipc = await ipcServer((_req, res) => { res.once('close', () => closed.resolve()); archiveHeaders(res, 100); res.write('partial') })
    const response = await ipc.fetch(download()); await response.body!.cancel(); await within(closed.promise)
  })
  it('times out stalled archive production after response headers', async () => {
    const closed = deferred(), ipc = await ipcServer((_req, res) => { res.once('close', () => closed.resolve()); archiveHeaders(res, 100); res.write('partial') }, 50)
    const response = await ipc.fetch(download()); await expect(within(response.arrayBuffer())).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' }); await within(closed.promise)
  })
  it('keeps the ordinary JSON response cap, including non-200 archive-route responses', async () => {
    const ipc = await ipcServer((req, res) => { if (req.url === path) res.statusCode = 403; res.end(Buffer.alloc(MAX_AGENT_MESSAGE_BYTES + 1)) })
    await expect(ipc.fetch(new Request('http://agent.local/ordinary'))).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    await expect(ipc.fetch(download())).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  })
})