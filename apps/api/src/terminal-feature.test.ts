import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { createRootPrincipal, createSession, createTestDb, createUserPrincipal } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import type { AgentApp } from '@xpanel/agent'
import { handleTerminalRoute, TerminalSessionManager } from '../../agent/src/terminal-sessions.ts'
import type { PtyProcess, TerminalLaunch } from '../../agent/src/terminal-sessions.ts'
import type { AgentCallerIdentity } from '../../agent/src/server.ts'
import { deriveCsrfToken, hashPasswordArgon2id } from './auth.ts'
import { sessionCookieName, sessionTokenHash } from './entry-points.ts'
import type { EntryPoint } from './entry-points.ts'
import { createApiApp, listenApiServer } from './server.ts'
import { TEST_AGENT_TOKEN, TEST_SERVER_SECRET } from './testing.ts'

// Real API listeners, sessions, CSRF, tickets and WebSocket bridge; the agent is its real terminal route and
// session manager over an in-process fetch, with a fake PTY in place of systemd-run. No host process runs.
const PANEL = 'https://panel.example.test:2083', WHM = 'https://whm.example.test:2087'
const ROOT_PASSWORD = 'correct-horse-battery'
const cleanup: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })

class FakePty implements PtyProcess {
  writes: Buffer[] = []; hungUp = false
  #data: Array<(chunk: Buffer) => void> = []; #exit: Array<(code: number | null) => void> = []
  readonly launch: TerminalLaunch
  constructor(launch: TerminalLaunch) { this.launch = launch }
  write(data: Buffer) { this.writes.push(data) }
  resize() {}
  pause() {}
  resume() {}
  hangup() { this.hungUp = true; queueMicrotask(() => { for (const listener of this.#exit) listener(129) }) }
  onData(listener: (chunk: Buffer) => void) { this.#data.push(listener) }
  onExit(listener: (code: number | null) => void) { this.#exit.push(listener) }
  emit(text: string) { for (const listener of this.#data) listener(Buffer.from(text)) }
}

const fixture = async () => {
  const database = await createTestDb(); cleanup.push(() => database.close())
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const featureList = await state.store.createFeatureList({ name: 'Terminal fixture', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Terminal fixture', ownerId: null, featureListId: featureList.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 4, forwarders: 4, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 }, dedicatedIp: false, shell: 'jailed', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.55', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const passwordHash = await hashPasswordArgon2id(ROOT_PASSWORD)
  const account = (username: string) => state.store.createAccount({ username, passwordHash, primaryDomain: `${username}.example.test`, planId: plan.id, ownerId: null,
    contactEmail: `owner@${username}.example.test`, ipv4: '192.0.2.55', shell: 'jailed', php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  const alice = await account('termalice'), bob = await account('termbob')
  const alicePrincipal = await createUserPrincipal(database.db, { username: alice.username, accountId: alice.id, passwordHash })
  const bobPrincipal = await createUserPrincipal(database.db, { username: bob.username, accountId: bob.id, passwordHash })
  const rootPrincipal = await createRootPrincipal(database.db, { username: 'root', passwordHash, forcePasswordChange: false })

  // The agent side: its real terminal route and manager, the caller identity taken from the principal header.
  const ptys: FakePty[] = []
  const terminals = new TerminalSessionManager(launch => { const pty = new FakePty(launch); ptys.push(pty); return pty })
  cleanup.push(() => terminals.closeAll())
  const identities = new Map<string, AgentCallerIdentity>([
    [alicePrincipal.id, { principalId: alicePrincipal.id, actor: alice.username, role: 'user', accountId: alice.id, resellerId: null }],
    [bobPrincipal.id, { principalId: bobPrincipal.id, actor: bob.username, role: 'user', accountId: bob.id, resellerId: null }],
    [rootPrincipal.id, { principalId: rootPrincipal.id, actor: 'root', role: 'root', accountId: null, resellerId: null }],
  ])
  const agentApp: AgentApp = { subscribe: () => () => {}, fetch: async req => {
    const url = new URL(req.url), caller = identities.get(req.headers.get('x-xpanel-principal-id') ?? '')
    if (req.headers.get('x-xpanel-agent-token') !== TEST_AGENT_TOKEN || !caller) return new Response(null, { status: 401 })
    try {
      return await handleTerminalRoute(req, url, req.method, { caller, terminals, store: state.store,
        assertRootCaller: async who => { if (who.role !== 'root') throw Object.assign(new Error('root required'), { code: 'FORBIDDEN' }) } }) ?? new Response(null, { status: 404 })
    } catch (error) { return Response.json({ error: String(error) }, { status: (error as { code?: string }).code === 'FORBIDDEN' ? 403 : 412 }) }
  } }

  const listen = async (entryPoint: EntryPoint, origin: string) => {
    const app = createApiApp({ db: database.db, store: state.store, serverSecret: TEST_SERVER_SECRET, entryPoint, allowedOrigins: [origin], secureCookies: true, agentToken: TEST_AGENT_TOKEN, agentApp })
    const server = await listenApiServer(app); cleanup.push(() => server.close())
    return server.port
  }
  const panelPort = await listen('xpanel', PANEL), whmPort = await listen('xwhm', WHM)
  const session = async (principalId: string, entryPoint: EntryPoint) => {
    const raw = 'terminal-session-' + randomUUID()
    await createSession(database.db, { principalId, tokenHash: sessionTokenHash(raw, entryPoint), expiresAt: new Date(Date.now() + 600_000).toISOString(), mfaVerified: true })
    return { cookie: sessionCookieName(entryPoint, true) + '=' + raw, csrf: deriveCsrfToken(raw, TEST_SERVER_SECRET, entryPoint) }
  }
  const call = (port: number, origin: string, who: { cookie: string; csrf: string }, method: string, path: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { origin, cookie: who.cookie, 'x-csrf-token': who.csrf, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const connect = (port: number, origin: string, who: { cookie: string }) => new Promise<{ ws: WebSocket; next: () => Promise<Record<string, any>> }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/ws`, { headers: { origin, cookie: who.cookie } })
    cleanup.push(() => ws.terminate())
    const queue: Array<Record<string, any>> = [], waiters: Array<(message: Record<string, any>) => void> = []
    ws.on('message', data => { const message = JSON.parse(String(data)); const waiter = waiters.shift(); if (waiter) waiter(message); else queue.push(message) })
    ws.once('open', () => resolve({ ws, next: () => queue.length ? Promise.resolve(queue.shift()!) : new Promise(done => waiters.push(done)) }))
    ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error('upgrade refused'), { status: res.statusCode })))
    ws.once('error', reject)
  })
  const audits = async () => (await database.db.query<{ action: string; detail: string; outcome: string }>('SELECT action, detail, outcome FROM audit_log ORDER BY id ASC')).filter(row => row.action.includes('terminal'))
  return { alice, alicePrincipal, bobPrincipal, rootPrincipal, ptys, panelPort, whmPort, session, call, connect, audits }
}

describe('terminal sessions over the panel listeners (loopback)', () => {
  it('opens the owner jailed shell, relays input and UTF-8 output, closes explicitly and audits start and stop without keystrokes', async () => {
    const f = await fixture(), owner = await f.session(f.alicePrincipal.id, 'xpanel')
    const read = await f.call(f.panelPort, PANEL, owner, 'GET', '/api/account/terminal')
    expect(await read.json()).toMatchObject({ account: { username: 'termalice', home: '/home/termalice', slice: `xpanel-${f.alice.uid}.slice` }, shell: 'jailed', execution: { state: 'available' }, session: { open: false } })
    const issued = await f.call(f.panelPort, PANEL, owner, 'POST', '/api/account/terminal', {})
    expect(issued.status).toBe(201)
    const { ticket } = (await issued.json() as { ticket: { ticket: string } }).ticket
    const { ws, next } = await f.connect(f.panelPort, PANEL, owner)
    ws.send(JSON.stringify({ type: 'open', ticket, cols: 100, rows: 30 }))
    expect(await next()).toMatchObject({ type: 'ready', session: { idleTimeoutSeconds: 900, absoluteTimeoutSeconds: 3600 } })
    const pty = f.ptys[0]!
    expect(pty.launch).toMatchObject({ cols: 100, rows: 30, target: { kind: 'account', account: { id: f.alice.id, username: 'termalice' } } })
    ws.send(JSON.stringify({ type: 'input', data: 'echo secret-keystrokes\r' }))
    await vi.waitFor(() => expect(Buffer.concat(pty.writes).toString('utf8')).toContain('echo secret-keystrokes'))
    pty.emit('héllo wörld\r\n')
    expect(await next()).toEqual({ type: 'output', data: 'héllo wörld\r\n' })
    const second = await f.call(f.panelPort, PANEL, owner, 'POST', '/api/account/terminal', {})
    expect(second.status).toBe(409)
    ws.send(JSON.stringify({ type: 'close' }))
    expect(await next()).toMatchObject({ type: 'end', reason: 'closed' })
    await vi.waitFor(async () => expect((await f.audits()).map(row => row.action)).toEqual(['account.terminal.session_opened', 'account.terminal.session_closed']))
    const rows = await f.audits()
    expect(JSON.parse(rows[1]!.detail)).toMatchObject({ account: 'termalice', reason: 'closed', durationSeconds: expect.any(Number), clientIp: expect.any(String) })
    expect(JSON.stringify(rows)).not.toContain('secret-keystrokes')
    expect(JSON.stringify(rows)).not.toContain('wörld')
    expect(pty.hungUp).toBe(true)
  })

  it('denies an account owner the root terminal on both listeners', async () => {
    const f = await fixture()
    const owner = await f.session(f.alicePrincipal.id, 'xpanel')
    expect((await f.call(f.panelPort, PANEL, owner, 'POST', '/api/server/terminal', { password: ROOT_PASSWORD })).status).toBe(404)
    const crossed = await f.session(f.alicePrincipal.id, 'xwhm')
    expect([401, 403]).toContain((await f.call(f.whmPort, WHM, crossed, 'POST', '/api/server/terminal', { password: ROOT_PASSWORD })).status)
    await expect(f.connect(f.whmPort, WHM, crossed)).rejects.toMatchObject({ status: 401 })
    expect(f.ptys).toHaveLength(0)
  })

  it('denies a ticket presented by another account, a reused ticket and an expired ticket', async () => {
    const f = await fixture()
    const alice = await f.session(f.alicePrincipal.id, 'xpanel'), bob = await f.session(f.bobPrincipal.id, 'xpanel')
    const ticketFor = async () => ((await (await f.call(f.panelPort, PANEL, alice, 'POST', '/api/account/terminal', {})).json()) as { ticket: { ticket: string } }).ticket.ticket
    const stolen = await ticketFor()
    const asBob = await f.connect(f.panelPort, PANEL, bob)
    asBob.ws.send(JSON.stringify({ type: 'open', ticket: stolen, cols: 80, rows: 24 }))
    expect(await asBob.next()).toMatchObject({ type: 'end', reason: 'denied' })
    const reused = await f.connect(f.panelPort, PANEL, alice)
    reused.ws.send(JSON.stringify({ type: 'open', ticket: stolen, cols: 80, rows: 24 }))
    expect(await reused.next()).toMatchObject({ type: 'end', reason: 'denied' })
    const late = await ticketFor(), now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000)
    const expired = await f.connect(f.panelPort, PANEL, alice)
    expired.ws.send(JSON.stringify({ type: 'open', ticket: late, cols: 80, rows: 24 }))
    expect(await expired.next()).toMatchObject({ type: 'end', reason: 'denied' })
    expect(f.ptys).toHaveLength(0)
    await expect(f.connect(f.panelPort, 'https://hostile.example.test', alice)).rejects.toMatchObject({ status: 403 })
  })

  it('ends a live shell at once when its panel session signs out, and audits the revocation', async () => {
    const f = await fixture(), owner = await f.session(f.alicePrincipal.id, 'xpanel')
    const { ticket } = (await (await f.call(f.panelPort, PANEL, owner, 'POST', '/api/account/terminal', {})).json() as { ticket: { ticket: string } }).ticket
    const { ws, next } = await f.connect(f.panelPort, PANEL, owner)
    ws.send(JSON.stringify({ type: 'open', ticket, cols: 80, rows: 24 }))
    expect(await next()).toMatchObject({ type: 'ready' })
    expect((await f.call(f.panelPort, PANEL, owner, 'POST', '/api/auth/logout')).status).toBe(200)
    expect(await next()).toMatchObject({ type: 'end', reason: 'revoked' })
    expect(f.ptys[0]!.hungUp).toBe(true)
    await vi.waitFor(async () => expect(JSON.parse((await f.audits()).at(-1)!.detail)).toMatchObject({ reason: 'revoked' }))
  })

  it('opens the root terminal only after password re-authentication on the xWHM listener', async () => {
    const f = await fixture(), root = await f.session(f.rootPrincipal.id, 'xwhm')
    expect((await f.call(f.whmPort, WHM, root, 'POST', '/api/server/terminal', { password: 'wrong-password' })).status).toBe(401)
    const issued = await f.call(f.whmPort, WHM, root, 'POST', '/api/server/terminal', { password: ROOT_PASSWORD })
    expect(issued.status).toBe(201)
    const { ticket } = (await issued.json() as { ticket: { ticket: string } }).ticket
    const { ws, next } = await f.connect(f.whmPort, WHM, root)
    ws.send(JSON.stringify({ type: 'open', ticket, cols: 80, rows: 24 }))
    expect(await next()).toMatchObject({ type: 'ready' })
    expect(f.ptys[0]!.launch.target).toEqual({ kind: 'root' })
    expect((await f.call(f.whmPort, WHM, root, 'DELETE', '/api/server/terminal')).status).toBe(200)
    expect(await next()).toMatchObject({ type: 'end', reason: 'closed' })
    await vi.waitFor(async () => expect((await f.audits()).map(row => row.action)).toEqual(['server.terminal.reauthentication_failed', 'server.terminal.session_opened', 'server.terminal.session_closed']))
  })
})
