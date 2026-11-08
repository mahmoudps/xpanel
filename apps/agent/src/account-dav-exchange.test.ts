import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Account } from '@xpanel/core'
import { davExchangePathAllowed, handleDavExchange, parseDavExchange } from './account-dav-exchange.ts'

const ID = '11111111-1111-4111-8111-111111111111', SIBLING = '22222222-2222-4222-8222-222222222222'
const account = { id: 'account-1', username: 'alice' } as Account
const listServiceUsers = async () => [{ id: ID, services: { email: true } }, { id: SIBLING, services: { email: false } }]
const request = (body: unknown) => new Request('http://agent/accounts/alice/dav-exchange', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

const store = async (status = 201, etag = '"abc"') => {
  const dir = await mkdtemp(join(tmpdir(), 'xpanel-dav-exchange-')), socketPath = join(dir, 'store.sock'), seen: { method?: string; url?: string; user?: string | string[]; ifMatch?: string | string[]; ifNone?: string | string[]; type?: string | string[]; body: string }[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, user: req.headers['x-remote-user'], ifMatch: req.headers['if-match'], ifNone: req.headers['if-none-match'], type: req.headers['content-type'], body: Buffer.concat(chunks).toString() })
      res.writeHead(status, { etag }); res.end('stored body')
    })
  })
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
  cleanup.push(() => rm(dir, { recursive: true, force: true }), () => new Promise(resolve => server.close(resolve)))
  return { socketPath, seen }
}

describe('dav exchange paths', () => {
  it('admits a page of the store read and nothing else in its query', () => {
    expect(davExchangePathAllowed(ID, 'GET', '/.xpanel/store?after=616263')).toBe(true)
    for (const path of ['/.xpanel/store?after=', '/.xpanel/store?after=XYZ', '/.xpanel/store?other=1', '/.xpanel/store?after=61&x=1']) expect(davExchangePathAllowed(ID, 'GET', path)).toBe(false)
    expect(davExchangePathAllowed(ID, 'PUT', '/.xpanel/store?after=616263')).toBe(false)
  })
  it('admits the store read and paths in the principal\'s own tree', () => {
    expect(davExchangePathAllowed(ID, 'GET', '/.xpanel/store')).toBe(true)
    expect(davExchangePathAllowed(ID, 'PUT', `/${ID}/calendar/event.ics`)).toBe(true)
    expect(davExchangePathAllowed(ID, 'PROPPATCH', `/${ID}/calendar/`)).toBe(true)
    expect(davExchangePathAllowed('main', 'MKCOL', '/main/book/')).toBe(true)
  })
  it.each([
    ['another principal', 'PUT', `/${SIBLING}/calendar/event.ics`], ['the principal root', 'PROPPATCH', `/${ID}/`], ['a dot segment', 'GET', `/${ID}/../${SIBLING}/x.ics`], ['an encoded dot segment', 'GET', `/${ID}/%2e%2e/x.ics`],
    ['an encoded slash', 'GET', `/${ID}/calendar/..%2Fx.ics`], ['a deeper path', 'GET', `/${ID}/calendar/a/b.ics`], ['a write to the store read', 'PUT', '/.xpanel/store'], ['a bad escape', 'GET', `/${ID}/calendar/%zz.ics`],
  ])('refuses %s', (_name, method, path) => { expect(davExchangePathAllowed(ID, method, path)).toBe(false) })
})

describe('dav exchange requests', () => {
  const good = { principal: ID, method: 'GET', path: '/.xpanel/store' }
  it('accepts the fields it knows', () => { expect(parseDavExchange({ principal: ID, method: 'PUT', path: `/${ID}/calendar/e.ics`, body: 'x', contentType: 'text/calendar', ifMatch: '"abc"' })).toMatchObject({ method: 'PUT' }) })
  it.each([
    ['an array', []], ['an unknown field', { ...good, extra: 1 }], ['an unknown method', { ...good, method: 'PROPFIND' }], ['a bad principal', { ...good, principal: '../root' }], ['a bad content type', { ...good, contentType: 'text/html' }],
    ['a body that is not text', { ...good, body: 1 }], ['a bad precondition', { ...good, ifMatch: 'abc' }], ['a false if-none-match', { ...good, ifNoneMatch: false }],
  ])('refuses %s', (_name, body) => { expect(() => parseDavExchange(body)).toThrow() })
})

describe('dav exchange', () => {
  it('names the identity as the edge does and returns the store status, ETag and body', async () => {
    const socket = await store()
    const response = await handleDavExchange(request({ principal: ID, method: 'PUT', path: `/${ID}/calendar/e.ics`, body: 'event text', contentType: 'text/calendar', ifMatch: '"old"' }), { account, listServiceUsers, socketPath: socket.socketPath })
    expect(response.headers.get('x-xpanel-dav-status')).toBe('201')
    expect(response.headers.get('x-xpanel-dav-etag')).toBe('"abc"')
    expect(await response.text()).toBe('stored body')
    expect(socket.seen).toEqual([{ method: 'PUT', url: `/${ID}/calendar/e.ics`, user: ID, ifMatch: '"old"', ifNone: undefined, type: 'text/calendar', body: 'event text' }])
  })
  it('keeps a stale ETag\'s answer for the API and leaves out a malformed ETag', async () => {
    const socket = await store(412, 'not an etag')
    const response = await handleDavExchange(request({ principal: 'main', method: 'PUT', path: '/main/calendar/e.ics', ifNoneMatch: true, body: '' }), { account, listServiceUsers, socketPath: socket.socketPath })
    expect(response.headers.get('x-xpanel-dav-status')).toBe('412')
    expect(response.headers.has('x-xpanel-dav-etag')).toBe(false)
    expect(socket.seen[0]).toMatchObject({ user: 'main', ifNone: '*' })
  })
  it('refuses a principal that is not a mailbox of this account before touching the store', async () => {
    const socket = await store()
    for (const principal of [SIBLING, '33333333-3333-4333-8333-333333333333']) {
      await expect(handleDavExchange(request({ principal, method: 'GET', path: '/.xpanel/store' }), { account, listServiceUsers, socketPath: socket.socketPath })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    }
    expect(socket.seen).toEqual([])
  })
  it('reports a stopped store with a stable reason and refuses a body that is not JSON', async () => {
    await expect(handleDavExchange(request({ principal: ID, method: 'GET', path: '/.xpanel/store' }), { account, listServiceUsers, socketPath: join(tmpdir(), 'xpanel-no-such-store.sock') })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { reason: 'dav_store_unavailable', stateChanged: false } })
    await expect(handleDavExchange(request('{bad'), { account, listServiceUsers, socketPath: 'unused' })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})
