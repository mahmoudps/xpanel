import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserPrincipal, createSession, createTestDb } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { createDefaultWebRenderer } from './main.ts'
import { SESSION_COOKIE_NAME, sha256Hex } from './auth.ts'
import { mailboxPrincipalUsername } from './mail/inbox.ts'

const probe = vi.hoisted(() => ({ mode: 'ok', events: [] as string[], started: null as (() => void) | null, calls: [] as unknown[][], mail: [] as Array<{ postfixMain?: string | null }> }))
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual,
    spawnSync: (...args: unknown[]) => {
      if (args[0] !== '/usr/sbin/postconf') throw new Error('Unexpected synchronous native command in renderer fixture')
      probe.calls.push(args); probe.started?.()
      const until = Date.now() + 80
      while (Date.now() < until) { /* Model the existing synchronous native wait. */ }
      probe.events.push('completed')
      return { status: ['error', 'timeout', 'overflow'].includes(probe.mode) ? 1 : 0, stdout: probe.mode === 'invalid' ? 'unread' : '10240000\n' }
    },
    execFile: (...args: unknown[]) => {
      probe.calls.push(args.slice(0, 3)); probe.started?.()
      const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void
      setTimeout(() => { probe.events.push('completed'); callback(probe.mode === 'error' || probe.mode === 'timeout' || probe.mode === 'overflow' ? Object.assign(new Error('synthetic postconf unread'), { code: probe.mode === 'overflow' ? 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' : 'ETIMEDOUT' }) : null, probe.mode === 'invalid' ? 'unread' : '10240000\n', '') }, 80)
      return {} as import('node:child_process').ChildProcess
    },
  }
})
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
    if (args[0] === '/etc/postfix/main.cf') return 'smtpd_milters = local:opendkim/opendkim.sock\n'
    if (args[0] === '/etc/opendkim/signing.json') throw Object.assign(new Error('absent'), { code: 'ENOENT' })
    return actual.readFileSync(...args)
  } }
})
vi.mock('./host-catalog.ts', async () => {
  const { tools } = await import('@xpanel/catalog')
  return { loadQualifiedCatalog: async () => tools.map(tool => ({ ...tool, status: 'verified', delivery: { ...tool.delivery, status: 'verified' } })) }
})
vi.mock('../../web/src/index.ts', async original => {
  const actual = await original<typeof import('../../web/src/index.ts')>()
  return { ...actual, serveWebUi: async (_req: Request, provider: () => unknown) => new Response(JSON.stringify(await provider()), { headers: { 'content-type': 'application/json' } }) }
})
vi.mock('./mail/document.ts', async original => {
  const actual = await original<typeof import('./mail/document.ts')>()
  return { ...actual, loadMailDocument: async (input: { postfixMain?: string | null }) => { probe.mail.push(input); return { mailbox: '' } } }
})
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const renderer = async () => {
  probe.events = []; probe.calls = []; probe.mail = []; probe.mode = 'ok'; probe.started = null
  const database = await createTestDb(), state = await createTestStateStore()
  cleanup.push(() => database.close(), () => state.close())
  const passwordHash = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
  const features = await state.store.createFeatureList({ name: 'Postconf fixture', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Postconf fixture', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 'unlimited', ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 1, aliasDomains: 1, subdomains: 1, mailboxes: 1, forwarders: 1, mailingLists: 1, ftpAccounts: 1, databases: 1, phpWorkers: 1 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100,
  })
  await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const account = await state.store.createAccount({ username: 'postconf7', primaryDomain: 'postconf7.example.test', passwordHash, planId: plan.id, ownerId: null, contactEmail: 'postconf@example.test', ipv4: '192.0.2.10', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 1, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} },
  })
  // The xMail document opens only for a mailbox identity of the account.
  const inbox = await state.store.createServiceUser({ accountId: account.id, login: 'inbox@postconf7.example.test', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html', passwordHash })
  const principal = await createUserPrincipal(database.db, { username: mailboxPrincipalUsername(inbox.login), accountId: account.id, passwordHash })
  const token = 'synthetic-postconf-renderer-session'
  await createSession(database.db, { principalId: principal.id, tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + 60000).toISOString(), mfaVerified: true })
  const render = await createDefaultWebRenderer({ db: database.db, store: state.store, serverSecret: 'synthetic-renderer-' + 'fixture-value-at-least-32-bytes' })
  return () => render(new Request('http://localhost/mail/inbox', { headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } }))
}
describe('bounded nonblocking Postfix default lookup in the actual HTML renderer', () => {
  it('lets the event loop progress while a slow lookup is pending and uses fixed bounded argv', async () => {
    const render = await renderer()
    const started = new Promise<void>(resolve => { probe.started = resolve })
    const pending = Promise.resolve(render())
    await Promise.race([started, pending.then(response => { throw new Error(`renderer settled before lookup: ${response.status}`) })])
    await new Promise<void>(resolve => setImmediate(() => { probe.events.push('heartbeat'); resolve() }))
    expect(probe.events).toEqual(['heartbeat'])
    expect((await pending).status).toBe(200)
    expect(probe.events).toEqual(['heartbeat', 'completed'])
    expect(probe.calls).toEqual([['/usr/sbin/postconf', ['-h', 'message_size_limit'], { encoding: 'utf8', timeout: 2000, maxBuffer: 1024, windowsHide: true }]])
    expect(probe.mail[0]?.postfixMain).toContain('message_size_limit = 10240000')
  })
  it.each(['error', 'timeout', 'overflow', 'invalid'])('keeps unread default lookup as unread without inventing a value: %s', async mode => {
    const render = await renderer(); probe.mode = mode
    expect((await render()).status).toBe(200)
    expect(probe.mail).toHaveLength(1)
    expect(probe.mail[0]?.postfixMain).toBe('smtpd_milters = local:opendkim/opendkim.sock\n')
  })
})
