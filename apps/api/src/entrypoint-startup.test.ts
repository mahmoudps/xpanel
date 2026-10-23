import { createServer, type Server } from 'node:net'
import { request as httpRequest } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentApp } from '@xpanel/agent'
import { createDb, createRootPrincipal, createSession, findPrincipalByUsername, migrate, setTotpSecret } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { ENTRY_POINTS, sessionCookieName, sessionTokenHash, type EntryPoint } from './entry-points.ts'
import { resolvePanelEntrypoints, startPanelEntrypoints, type PanelEntryPointConfig } from './main.ts'
import { INGRESS_SECRET_HEADER } from './server.ts'

const names: EntryPoint[] = ['xpanel', 'xwhm', 'xmail']
const origins = {
  xpanel: 'https://panel.example.test:2083',
  xwhm: 'https://whm.panel.example.test:2087',
  xmail: 'https://mail.panel.example.test:2096',
}
const env = {
  XPANEL_PANEL_PUBLIC_ORIGIN: origins.xpanel,
  XPANEL_WHM_PUBLIC_ORIGIN: origins.xwhm,
  XPANEL_MAIL_PUBLIC_ORIGIN: origins.xmail,
}
const publicHash = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const ingressSecret = 'startup-ingress-fixture-only-credential-32-bytes'
const listen = async (port = 0): Promise<Server> => {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  return server
}
const portOf = (server: Server): number => (server.address() as { port: number }).port
const close = (server: Server): Promise<void> => new Promise(resolve => server.close(() => resolve()))
const configs = async (): Promise<Record<EntryPoint, PanelEntryPointConfig>> => {
  const reservations: Server[] = []
  try {
    for (const _name of names) reservations.push(await listen())
    return Object.fromEntries(names.map((name, index) => [name, { port: portOf(reservations[index]!), publicOrigin: origins[name] }])) as Record<EntryPoint, PanelEntryPointConfig>
  } finally { await Promise.all(reservations.map(close)) }
}

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const fixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xpanel-entrypoints-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'control.db')
  const handle = createDb(dbPath)
  try {
    await migrate(handle.runner)
    const root = await createRootPrincipal(handle.db, { username: 'root', passwordHash: publicHash, forcePasswordChange: false })
    await setTotpSecret(handle.db, root.id, new Uint8Array(32))
  } finally { await handle.close() }
  const subscriptions = { opened: 0, closed: 0 }
  const agentApp: AgentApp = {
    fetch: async () => new Response(null, { status: 503 }),
    subscribe: () => { subscriptions.opened++; return () => { subscriptions.closed++ } },
  }
  return {
    options: {
      dbPath, stateDir: join(dir, 'state'), agentApp,
      os: profileFor('ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble'),
      agentToken: 'a'.repeat(64), serverSecret: 'startup-fixture-server-secret-at-least-32-bytes', ingressSecret,
    },
    subscriptions,
  }
}

describe('three entrypoint production startup configuration', () => {
  it('requires all exact public HTTPS origins and reserves three distinct private loopback ports', () => {
    const result = resolvePanelEntrypoints({}, env)
    expect(result.host).toBe('127.0.0.1')
    expect(names.map(name => result.entryPoints[name].port)).toEqual([12083, 12087, 12096])
    expect(names.map(name => result.entryPoints[name].publicOrigin)).toEqual(names.map(name => origins[name]))
    expect(Object.isFrozen(result.entryPoints)).toBe(true)
    expect(Object.isFrozen(result.entryPoints.xpanel)).toBe(true)
    expect(() => resolvePanelEntrypoints({}, {})).toThrow(/exact HTTPS origin/)
  })

  it.each(['http://panel.example.test:2083', 'https://panel.example.test', 'https://panel.example.test:2087', 'https://panel.example.test:2083/', 'https://user@panel.example.test:2083', 'https://panel.example.test:2083/#x'])('rejects an ambiguous or wrong public origin %s', origin => {
    expect(() => resolvePanelEntrypoints({}, { ...env, XPANEL_PANEL_PUBLIC_ORIGIN: origin })).toThrow(/HTTPS origin/)
  })

  it.each(['0.0.0.0', '::', 'localhost', '192.0.2.10'])('rejects a non-explicit loopback bind %s', host => {
    expect(() => resolvePanelEntrypoints({ host }, env)).toThrow(/loopback/)
  })

  it.each(['0', '-1', '1.5', 'NaN', '65536', '12083'])('rejects invalid or colliding private ports %s', port => {
    expect(() => resolvePanelEntrypoints({}, { ...env, XPANEL_WHM_PORT: port })).toThrow(/port/)
  })

  it('fails before opening state when a production backend leaves the reserved port set', async () => {
    const entryPoints = await configs()
    await expect(startPanelEntrypoints({ entryPoints })).rejects.toThrow(/reserved ports/)
  })
})

describe('three real HTTP listeners with a fixture host agent, not public TLS qualification', () => {
  it('serves independent fixed login brands, confines HTML before snapshots, binds session audience and closes once', async () => {
    const { options, subscriptions } = await fixture()
    const entryPoints = await configs()
    const server = await startPanelEntrypoints({ ...options, entryPoints })
    cleanups.push(() => server.close())
    expect(subscriptions.opened).toBe(3)
    expect(new Set(names.map(name => server.listeners[name].port)).size).toBe(3)
    const readSnapshot = vi.spyOn(server.store, 'readSnapshot')
    const request = (name: EntryPoint, path: string, headers: Record<string, string> = {}): Promise<Response> => new Promise((resolve, reject) => {
      const outgoing = httpRequest({ hostname: '127.0.0.1', port: server.listeners[name].port, path,
        headers: { host: new URL(origins[name]).host, [INGRESS_SECRET_HEADER]: ingressSecret, 'x-forwarded-proto': 'https', 'x-forwarded-for': '192.0.2.20', ...headers },
      }, incoming => {
        const chunks: Buffer[] = []
        incoming.on('data', chunk => chunks.push(Buffer.from(chunk)))
        incoming.once('error', reject)
        incoming.once('end', () => {
          const responseHeaders = new Headers()
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value)
          }
          resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers: responseHeaders }))
        })
      })
      outgoing.once('error', reject)
      outgoing.end()
    })
    for (const name of names) {
      const login = await request(name, '/login?surface=xwhm&target=xwhm&audience=xwhm', { 'x-xpanel-entry-point': 'xwhm' })
      expect(login.status).toBe(200)
      const html = await login.text()
      expect(html).toContain(`data-login-audience="${name}"`)
      expect(html).not.toContain('data-action="switch-surface"')
      expect((await request(name, '/')).headers.get('location')).toBe('/login')
      for (const other of names.filter(candidate => candidate !== name)) {
        expect((await request(name, ENTRY_POINTS[other].home)).status).toBe(404)
      }
      expect((await request(name, '/login', { host: 'attacker.example.test:2083' })).status).toBe(421)
      const misdirected = await request(name, '/login?lang=ar', { host: '192.0.2.10', accept: 'text/html' })
      expect(misdirected.status).toBe(421)
      expect(misdirected.headers.get('content-type')).toContain('text/html')
      const misdirectedHtml = await misdirected.text()
      expect(misdirectedHtml).toContain('data-status-page="421"')
      expect(misdirectedHtml).toContain('dir="rtl"')
      for (const origin of Object.values(origins)) expect(misdirectedHtml).toContain(origin)
      expect(misdirectedHtml).not.toContain('MISDIRECTED_REQUEST')
    }
    expect(readSnapshot).not.toHaveBeenCalled()
    const root = await findPrincipalByUsername(server.db, 'root')
    expect(root).not.toBeNull()
    const token = 'startup-public-session-fixture'
    await createSession(server.db, { principalId: root!.id, tokenHash: sessionTokenHash(token, 'xwhm'), mfaVerified: true, expiresAt: new Date(Date.now() + 60_000).toISOString() })
    const cookie = `${sessionCookieName('xwhm', true)}=${token}`
    const redirect = await request('xwhm', '/?lang=ar&theme=dark&density=compact', { cookie })
    expect(redirect.status).toBe(303)
    expect(redirect.headers.get('location')).toBe('/whm?lang=ar&theme=dark&density=compact')
    for (const name of ['xpanel', 'xmail'] as const) {
      expect((await request(name, '/', { cookie: `${sessionCookieName(name, true)}=${token}` })).headers.get('location')).toBe('/login')
    }
    expect(readSnapshot).not.toHaveBeenCalled()
    await Promise.all([server.close(), server.close()])
    expect(subscriptions.closed).toBe(3)
    for (const name of names) {
      const rebound = await listen(server.listeners[name].port)
      await close(rebound)
    }
  })

  it('rolls back an already bound first listener and subscriptions if a later port is occupied', async () => {
    const { options, subscriptions } = await fixture()
    const entryPoints = await configs()
    const occupied = await listen(entryPoints.xwhm.port)
    cleanups.push(() => close(occupied))
    await expect(startPanelEntrypoints({ ...options, entryPoints })).rejects.toThrow(/EADDRINUSE/)
    expect(subscriptions.opened).toBe(2)
    expect(subscriptions.closed).toBe(2)
    const rebound = await listen(entryPoints.xpanel.port)
    await close(rebound)
    const reopened = createDb(options.dbPath)
    try { expect(await findPrincipalByUsername(reopened.db, 'root')).not.toBeNull() } finally { await reopened.close() }
  })
})
