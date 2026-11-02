import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentApp } from '@xpanel/agent'
import { defaultPlan, type FeatureList } from '@xpanel/core'
import { createApiToken, createDb, createRootPrincipal, migrate, syncAccountContactIndex, type Db, type DbHandle } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { StateStore, type StoredAccount } from '@xpanel/state'
import { sha256Hex } from './auth.ts'
import type { EntryPoint } from './entry-points.ts'
import { startPanelEntrypoints, type PanelEntryPointConfig } from './main.ts'
import { createApiApp } from './server.ts'
import { TEST_SERVER_SECRET } from './testing.ts'
import { WS_AUTHORIZATION_UNAVAILABLE } from './ws.ts'

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const TOKEN = 'public-contact-recovery-integration-fixture'
const NEW_EMAIL = 'newcontact@example.test'
const account: StoredAccount = {
  id: '8ed693da-74d1-4f27-9903-e252cd1d2094', username: 'contactowner', uid: 20001, gid: 20001,
  home: '/home/contactowner', primaryDomain: 'contactowner.example.test', planId: '166f276c-4d07-4a76-ae62-327c9f6c0c39',
  ownerId: null, status: 'active', suspendReason: null, suspendedAt: null, contactEmail: 'oldcontact@example.test',
  ipv4: '192.0.2.10', shell: 'none', createdAt: '2026-01-01T00:00:00.000Z',
}
const featureList: FeatureList = {
  id: '6978dbf5-c152-48da-8313-b4827bdf3c70', name: 'Contact recovery fixture', ownerId: null, disabled: [],
}
const plan = defaultPlan({ id: account.planId, featureListId: featureList.id, name: 'Contact recovery fixture' })
let base: string
let template: string
const handles = new Set<DbHandle>()
const directories: string[] = []
const children = new Set<ChildProcess>()
const shutdowns: Array<() => Promise<unknown>> = []

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'xpanel-api-contact-recovery-'))
  template = join(base, 'template.sqlite')
  const prepared = createDb(template)
  try {
    await migrate(prepared.db)
    const root = await createRootPrincipal(prepared.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })
    await createApiToken(prepared.db, { principalId: root.id, name: 'Public contact recovery fixture', tokenHash: sha256Hex(TOKEN),
      scopes: ['*'], expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() })
    await syncAccountContactIndex(prepared.db, account)
  } finally { await prepared.close() }
})

const stopChild = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode === null && child.signalCode === null) {
    const closed = new Promise<void>(done => child.once('close', () => done()))
    child.kill('SIGKILL')
    await closed
  }
  children.delete(child)
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const child of children) await stopChild(child)
  for (const close of shutdowns.splice(0).reverse()) await close()
  for (const handle of handles) { await handle.close(); handles.delete(handle) }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
afterAll(async () => { await rm(base, { recursive: true, force: true }) })

/**
 * Migrate once and copy only the closed database. These real process/barrier cases
 * cannot enclose API requests in an outer SQL transaction: state -> SQL is the
 * production lock order, and recovery must own its own bounded transaction.
 */
const fixture = async () => {
  const directory = await mkdtemp(join(base, 'case-'))
  directories.push(directory)
  const dbPath = join(directory, 'control.sqlite')
  await copyFile(template, dbPath)
  const database = createDb(dbPath)
  handles.add(database)
  const root = join(directory, 'state'), accountDir = join(root, 'accounts', account.username)
  await mkdir(accountDir, { recursive: true })
  // Domain listing validates each account's saved plan even when it has no
  // domain files. Seed the linked records without allocating a writer lease.
  await Promise.all(['plans', 'feature-lists'].map(name => mkdir(join(root, name), { recursive: true })))
  await writeFile(join(root, 'plans', plan.id + '.json'), JSON.stringify(plan))
  await writeFile(join(root, 'feature-lists', featureList.id + '.json'), JSON.stringify(featureList))
  const accountPath = join(accountDir, 'account.json')
  const raw = ' \n' + JSON.stringify(account, null, 3) + '\r\n'
  await writeFile(accountPath, raw)
  const store = new StateStore(root)
  // No test registration: the programmatic composition root must supply the port.
  const app = createApiApp({ db: database.db, store, serverSecret: TEST_SERVER_SECRET })
  shutdowns.push(async () => { app.terminals?.close() })
  const request = (path: string) => app.fetch(new Request('http://localhost' + path, { headers: { authorization: 'Bearer ' + TOKEN } }))
  return { directory, root, dbPath, database, accountPath, raw, store, app, request }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

/** Wait for the actual child handshake; no fixed observation delay or synthetic PID. */
const childMessage = async (script: string, expected: string): Promise<ChildProcess> => {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { cwd: resolve('.'), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  children.add(child)
  let diagnostics = ''
  child.stderr?.on('data', chunk => { diagnostics += String(chunk) })
  await new Promise<void>((done, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('contact recovery child timed out: ' + diagnostics)) }, 5000)
    const success = (value: unknown) => {
      if (value && typeof value === 'object' && 'phase' in value && value.phase === expected) {
        clearTimeout(timeout); done()
      }
    }
    child.on('message', success)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('contact recovery child exited before its handshake: ' + diagnostics)) })
  })
  return child
}

const interruptedSqlUpdate = async (f: Fixture): Promise<void> => {
  const state = pathToFileURL(resolve('packages/state/src/index.ts')).href
  const db = pathToFileURL(resolve('packages/db/src/index.ts')).href
  const core = pathToFileURL(resolve('packages/core/src/index.ts')).href
  const child = await childMessage(`
    import { StateStore } from ${JSON.stringify(state)};
    import { createDb, prepareAccountContactIndexRollback, syncAccountContactIndex } from ${JSON.stringify(db)};
    import { accountContactRevision } from ${JSON.stringify(core)};
    const store = new StateStore(${JSON.stringify(f.root)}), db = createDb(${JSON.stringify(f.dbPath)});
    const account = await store.getAccount(${JSON.stringify(account.id)});
    await store.updateAccountContactEmail(account.id, ${JSON.stringify(NEW_EMAIL)}, {
      expectedContactRevision: accountContactRevision(account), authorize: async () => {},
      prepareIndex: current => prepareAccountContactIndexRollback(db.db, current.id),
      synchronizeIndex: async current => {
        await syncAccountContactIndex(db.db, current);
        process.send({ phase: 'sql-published' });
        await new Promise(() => { globalThis.fixtureHold = setInterval(() => {}, 1000); });
      },
    });
  `, 'sql-published')
  await stopChild(child)
  expect(await f.database.db.query('SELECT contact_email FROM idx_accounts WHERE id=$1', [account.id])).toEqual([{ contact_email: NEW_EMAIL }])
  expect(await readFile(f.accountPath, 'utf8')).toContain(NEW_EMAIL)
  expect(await readFile(f.store.writerLock.intentFilePath, 'utf8')).toContain('updateAccountContactEmail')
}

const maybeRead = async (path: string): Promise<Buffer | null> => readFile(path).catch(error => {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
  throw error
})

const entrypointConfigs = async (): Promise<Record<EntryPoint, PanelEntryPointConfig>> => {
  const names: EntryPoint[] = ['xpanel', 'xwhm', 'xmail']
  const reservations: Server[] = []
  try {
    for (const _name of names) {
      const server = createServer()
      reservations.push(server)
      await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    }
    const ports = reservations.map(server => (server.address() as { port: number }).port)
    return {
      xpanel: { port: ports[0]!, publicOrigin: 'https://panel.example.test:2083' },
      xwhm: { port: ports[1]!, publicOrigin: 'https://whm.example.test:2087' },
      xmail: { port: ports[2]!, publicOrigin: 'https://mail.example.test:2096' },
    }
  } finally {
    await Promise.all(reservations.map(server => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))))
  }
}

describe('API contact projection recovery with actual SQLite and state mutexes', () => {
  it('repairs a later process crash in an already running programmatic API before returning contact or search results', async () => {
    const f = await fixture()
    expect((await f.request('/api/accounts')).status).toBe(200)
    await interruptedSqlUpdate(f)
    const response = await f.request('/api/accounts')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ accounts: [{ id: account.id, contactEmail: account.contactEmail }] })
    const item = await f.request('/api/accounts/' + account.id)
    expect(item.status).toBe(200)
    expect(await item.json()).toMatchObject({ account: { id: account.id, contactEmail: account.contactEmail } })
    const oldSearch = await f.request('/api/search?q=oldcontact&kind=account')
    expect(oldSearch.status).toBe(200)
    expect(await oldSearch.json()).toMatchObject({ hits: [{ entityId: account.id }] })
    expect(await (await f.request('/api/search?q=newcontact&kind=account')).json()).toEqual({ hits: [] })
    expect(await readFile(f.accountPath, 'utf8')).toBe(f.raw)
    await expect(readFile(f.store.writerLock.intentFilePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps failed recovery unavailable for HTTP and WS while retaining the exact intent and the health exception', async () => {
    const f = await fixture()
    await interruptedSqlUpdate(f)
    const intent = await readFile(f.store.writerLock.intentFilePath)
    f.store.registerAccountContactIndexRecovery(async () => { throw new Error('synthetic contact projection unavailable') })
    for (const path of ['/api/search?q=newcontact', '/api/accounts', '/api/accounts/' + account.id, '/login']) {
      const response = await f.request(path)
      expect(response.status).toBe(503)
      expect(response.headers.get('retry-after')).toBe('5')
      expect(response.headers.get('set-cookie')).toBeNull()
      expect(await readFile(f.store.writerLock.intentFilePath)).toEqual(intent)
    }
    expect(await f.app.authenticateUpgrade({ headers: { host: 'localhost' }, url: '/api/ws' } as IncomingMessage)).toBe(WS_AUTHORIZATION_UNAVAILABLE)
    expect(await readFile(f.store.writerLock.intentFilePath)).toEqual(intent)
    expect((await f.request('/api/health')).status).toBe(200)
  })

  it('retains the permanent mutex through the actual search query against a competing process', async () => {
    const f = await fixture()
    const query = f.database.db.query.bind(f.database.db)
    const stateUrl = pathToFileURL(resolve('packages/state/src/index.ts')).href
    let observedBlockedWriter = false
    // The production runner is frozen. Trace only the query boundary through a
    // forwarding dependency; all statements still execute on that real runner.
    const tracedDb: Db = { ...f.database.db, query: (async (text: string, params?: readonly unknown[]) => {
      if (/FROM search_fts\s+WHERE/.test(text)) {
        const child = await childMessage(`
          import { WriterLock } from ${JSON.stringify(stateUrl)};
          try {
            const lease = await new WriterLock(${JSON.stringify(f.root)}, { acquireTimeoutMs: 40, retryIntervalMs: 5 }).acquire();
            await lease.release();
            throw new Error('writer entered before the search observation completed');
          } catch (error) {
            if (error.code !== 'CONFLICT') throw error;
            process.send({ phase: 'writer-blocked' });
            await new Promise(() => { globalThis.fixtureHold = setInterval(() => {}, 1000); });
          }
        `, 'writer-blocked')
        observedBlockedWriter = true
        await stopChild(child)
      }
      return query(text, params)
    }) as Db['query'] }
    const application = createApiApp({ db: tracedDb, store: f.store, serverSecret: TEST_SERVER_SECRET })
    shutdowns.push(async () => { application.terminals?.close() })
    const response = await application.fetch(new Request('http://localhost/api/search?q=oldcontact&kind=account', {
      headers: { authorization: 'Bearer ' + TOKEN },
    }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ hits: [{ entityId: account.id }] })
    expect(observedBlockedWriter).toBe(true)
  })

  it('fails closed when a writer crashes after initial admission but before the held account read', async () => {
    const f = await fixture()
    const read = f.store.withRecoveredAccountProjection.bind(f.store)
    let intent: Buffer | undefined
    vi.spyOn(f.store, 'withRecoveredAccountProjection').mockImplementationOnce(async callback => {
      // The real request admission has completed. Publish a real interrupted
      // transaction in that exact interval, then let the real leaf barrier run.
      await interruptedSqlUpdate(f)
      intent = await readFile(f.store.writerLock.intentFilePath)
      f.store.registerAccountContactIndexRecovery(async () => { throw new Error('synthetic late projection repair failure') })
      return read(callback)
    })
    const response = await f.request('/api/accounts')
    expect(response.status).toBe(503)
    expect(intent).toBeDefined()
    expect(await readFile(f.store.writerLock.intentFilePath)).toEqual(intent)
    expect(await response.text()).not.toContain(NEW_EMAIL)
  })

  it('does not allocate state revisions or fencing epochs for clean account and search reads', async () => {
    const f = await fixture()
    await f.store.writerLock.waitForUnlocked()
    const before = await maybeRead(f.store.writerLock.authorityFilePath)
    for (const path of ['/api/accounts', '/api/accounts/' + account.username, '/api/search?q=oldcontact']) {
      expect((await f.request(path)).status).toBe(200)
    }
    expect((await f.request('/api/accounts/missingowner')).status).toBe(404)
    expect(await maybeRead(f.store.writerLock.authorityFilePath)).toEqual(before)
    expect(await readFile(f.accountPath, 'utf8')).toBe(f.raw)
  })

  it('repairs contact state before the production startup creates its first agent subscription or listener', async () => {
    const f = await fixture()
    await interruptedSqlUpdate(f)
    await f.database.close()
    handles.delete(f.database)
    let opened = 0
    const agentApp: AgentApp = {
      fetch: async () => new Response(null, { status: 503 }),
      subscribe: () => {
        expect(readFileSync(f.accountPath, 'utf8')).toBe(f.raw)
        expect(() => readFileSync(f.store.writerLock.intentFilePath)).toThrow(/ENOENT/)
        opened++
        return () => {}
      },
    }
    const server = await startPanelEntrypoints({ dbPath: f.dbPath, stateDir: f.root, agentApp,
      entryPoints: await entrypointConfigs(), os: profileFor('ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble'),
      agentToken: 'a'.repeat(64), serverSecret: TEST_SERVER_SECRET, ingressSecret: 'public-startup-ingress-fixture-32-bytes' })
    shutdowns.push(() => server.close())
    expect(server.quarantined).toBe(false)
    expect(opened).toBe(3)
    if (server.quarantined) throw new Error('Unexpected lifecycle quarantine')
    expect(await server.db.query('SELECT contact_email FROM idx_accounts WHERE id=$1', [account.id])).toEqual([{ contact_email: account.contactEmail }])
    expect(await readFile(f.accountPath, 'utf8')).toBe(f.raw)
  })
})
