import { mkdtemp, rm, stat } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRootPrincipal, createTestDb, setPrincipalDisabled } from '@xpanel/db'
import type { AgentApp } from '@xpanel/agent'
import { evaluateServerHealth } from '../../agent/src/server-health.ts'
import { verifyWebhookSignature } from '../../agent/src/ops-webhooks.ts'
import { createLocalMtaEmailSender, readSavedDeliveryState } from './alert-delivery.ts'
import type { DeliveryTransports } from './alert-delivery.ts'
import { alertStateFiles, readServerHealthAsRoot, startAlertScheduler } from './alert-runtime.ts'

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const TOKEN = 'f'.repeat(64), KEY = 'whsec_' + 'k'.repeat(43), at = '2026-10-27T10:00:00.000Z'
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const task of cleanup.splice(0).reverse()) await task() })

/** A loopback SMTP sink that accepts everything and keeps each message's DATA. */
const sink = async (): Promise<{ port: number; messages: string[] }> => {
  const messages: string[] = []
  const server = net.createServer(socket => {
    let buffer = '', data: string | null = null
    socket.on('error', () => undefined)
    socket.write('220 sink ESMTP\r\n')
    socket.on('data', chunk => {
      buffer += chunk.toString('latin1')
      for (let index = buffer.indexOf('\r\n'); index >= 0; index = buffer.indexOf('\r\n')) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 2)
        if (data !== null) { if (line === '.') { messages.push(data); data = null; socket.write('250 queued\r\n') } else data += line + '\n'; continue }
        socket.write(line === 'DATA' ? (data = '', '354 go\r\n') : line === 'QUIT' ? '221 bye\r\n' : '250 ok\r\n')
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise(resolve => server.close(resolve)))
  return { port: (server.address() as net.AddressInfo).port, messages }
}

const setup = async () => {
  const database = await createTestDb()
  cleanup.push(() => database.close())
  const root = await createRootPrincipal(database.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })
  const rootDir = await mkdtemp(join(tmpdir(), 'xpanel-alerts-'))
  cleanup.push(() => rm(rootDir, { recursive: true, force: true }))
  const store = { rootDir, getServerSettings: async () => ({ hostname: 'srv1.example.test' }) } as never
  const callers: string[] = []
  // Host unobservable except saved certificates: an expired one makes the certificates rule fire.
  const report = await evaluateServerHealth({ executor: null, family: null, readDrift: null, now: () => new Date(at),
    saved: { certificates: [{ names: ['old.example.test'], notAfter: '2026-10-20T00:00:00.000Z', autoRenew: true, source: 'acme' }], accounts: [], plans: [] } })
  const agentApp = { fetch: async (request: Request) => { callers.push(request.headers.get('x-xpanel-principal-id') ?? ''); expect(new URL(request.url).pathname).toBe('/host/server-health'); return Response.json(report) }, subscribe: () => () => undefined } as unknown as AgentApp
  return { db: database.db, root, rootDir, store, agentApp, callers, files: alertStateFiles({ rootDir }) }
}

describe('alert runtime', () => {
  it('evaluates on its schedule and delivers a firing alert by email through the MTA and by signed webhook, logged', async () => {
    const { db, root, store, agentApp, callers, files, rootDir } = await setup()
    await files.writeSaved({ recipients: ['ops@example.com'], events: ['monitoring.alert'], webhook: { url: 'https://hooks.example.com/xpanel', enabled: true }, updatedAt: at, updatedBy: 'root' })
    await files.writeSigningKey({ key: KEY, createdAt: at, createdBy: 'root' })
    if (process.platform !== 'win32') expect((await stat(join(rootDir, 'extended', 'panel', 'notification-signing-key.json'))).mode & 0o777).toBe(0o600)
    const mta = await sink(), hooks: { body: string; headers: Record<string, string> }[] = []
    const transports: DeliveryTransports = { serverName: 'srv1.example.test', email: createLocalMtaEmailSender({ from: 'xpanel@srv1.example.test', helo: 'srv1.example.test', port: mta.port, timeoutMs: 2000 }),
      webhook: async request => { hooks.push(request); return { status: 202 } } }
    const scheduler = startAlertScheduler({ db, store, agentApp, agentToken: TOKEN, admit: task => task(), everyMs: 10, transports })
    cleanup.push(() => scheduler.stop())
    for (let waited = 0; waited < 3000 && !readSavedDeliveryState(await files.readDelivery())?.lastRun; waited += 20) await new Promise(resolve => setTimeout(resolve, 20))
    await scheduler.stop()
    const delivery = readSavedDeliveryState(await files.readDelivery())!
    expect(delivery.lastRun!.result).toBe('evaluated')
    expect(callers.every(id => id === root.id)).toBe(true)
    expect(mta.messages).toHaveLength(1)
    expect(mta.messages[0]).toMatch(/^Subject: \[xPanel\] Critical: Certificates expiring on srv1\.example\.test$/m)
    expect(hooks).toHaveLength(1)
    expect(verifyWebhookSignature(KEY, hooks[0]!.headers['x-xpanel-signature']!, hooks[0]!.body, Math.floor(Date.now() / 1000))).toBe(true)
    expect(JSON.parse(hooks[0]!.body)).toMatchObject({ event: 'monitoring.alert.firing', alert: { rule: 'certificates', matches: ['old.example.test'] } })
    expect(delivery.log.filter(entry => entry.ruleId === 'certificates').map(entry => [entry.channel, entry.result])).toEqual(expect.arrayContaining([['email', 'sent'], ['webhook', 'sent']]))
    expect(delivery.told.certificates).toBeDefined()
  })

  it('reads host health only as an enabled built-in root', async () => {
    const { db, root, agentApp } = await setup()
    expect(await readServerHealthAsRoot({ db, agentApp, agentToken: TOKEN })).toMatchObject({ host: 'unavailable' })
    await setPrincipalDisabled(db, root.id, true)
    await expect(readServerHealthAsRoot({ db, agentApp, agentToken: TOKEN })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})
