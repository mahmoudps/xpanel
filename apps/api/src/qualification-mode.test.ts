import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'vitest'
import type { AgentApp } from '@xpanel/agent'
import { admitForQualification, PHASE1_TOOL_PROBES, qualifyHostTools, unqualifiedTools, type HostQualificationReport } from '@xpanel/catalog'
import { createRootPrincipal, createTestDb, listAudit, type TestDbHandle } from '@xpanel/db'
import { createTestStateStore, type TestStateStoreHandle } from '@xpanel/state'
import { HOST_PROBES } from '../../../packages/catalog/src/host-qualification.ts'
import { hashPasswordArgon2id } from './auth.ts'
import { createQualifiedCatalogProvider, type HostCatalogSource } from './host-catalog.ts'
import { QUALIFICATION_MODE_FILE, readQualificationMode, type QualificationHostFacts } from './qualification-mode.ts'
import { createDefaultWebRenderer } from './main.ts'
import { createApiApp } from './server.ts'
import { TEST_SERVER_SECRET } from './testing.ts'

const id = 'a'.repeat(32)
const valid = (): QualificationHostFacts => ({
  directory: { directory: true, uid: 0, mode: 0o750 },
  file: { regular: true, uid: 0, mode: 0o444, links: 1 },
  content: `${id}\n`, machineId: `${id}\n`,
})
const on = (change: (facts: QualificationHostFacts) => void = () => undefined, published = false): boolean => {
  const facts = valid()
  change(facts)
  return readQualificationMode(() => facts, published)
}

describe('qualification mode switch', () => {
  it('opens for the root-owned read-only file that names this machine', () => assert.equal(on(), true))

  const refusals: Record<string, (facts: QualificationHostFacts) => void> = {
    'a file owned by another user': facts => { facts.file.uid = 1001 },
    'a group-writable file': facts => { facts.file.mode = 0o464 },
    'a world-writable file': facts => { facts.file.mode = 0o446 },
    'an owner-writable file': facts => { facts.file.mode = 0o644 },
    'a file the API cannot read': facts => { facts.file.mode = 0o400 },
    'a setuid file': facts => { facts.file.mode = 0o4444 },
    'a hard link': facts => { facts.file.links = 2 },
    'something other than a regular file': facts => { facts.file.regular = false },
    'a directory owned by another user': facts => { facts.directory.uid = 999 },
    'a group-writable directory': facts => { facts.directory.mode = 0o770 },
    'a world-writable directory': facts => { facts.directory.mode = 0o757 },
    'a parent that is not a directory': facts => { facts.directory.directory = false },
    'a file naming another machine': facts => { facts.content = `${'b'.repeat(32)}\n` },
    'an empty file': facts => { facts.content = '' },
    'free text in the file': facts => { facts.content = 'yes\n'; facts.machineId = 'yes\n' },
  }
  for (const [name, change] of Object.entries(refusals)) it(`refuses ${name}`, () => assert.equal(on(change), false))

  it('refuses a missing file, and every other read failure', () => {
    assert.equal(readQualificationMode(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }, false), false)
    assert.equal(readQualificationMode(() => { throw Object.assign(new Error('symlink'), { code: 'ELOOP' }) }, false), false)
    assert.equal(readQualificationMode(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) }, false), false)
  })

  it('refuses on a published release even with a perfect file', () => assert.equal(on(undefined, true), false))

  it('stays off on this checkout, whose real path has no switch', () => assert.equal(readQualificationMode(), false))

  it('is never created by the installer, a package or a release script', () => {
    const root = resolve(import.meta.dirname, '../../..')
    const walk = (path: string): string[] => statSync(path).isDirectory() ? readdirSync(path).flatMap(name => walk(join(path, name))) : [path]
    const shipped = ['packages/os/src', 'deploy', 'bin', 'scripts'].flatMap(path => walk(join(root, path)))
    assert.deepEqual(shipped.filter(path => readFileSync(path, 'latin1').includes(QUALIFICATION_MODE_FILE)), [])
  })
})

const report = (probes: Record<string, string>, executor: HostQualificationReport['executor'] = 'linux'): HostQualificationReport => ({ executor, probes: probes as HostQualificationReport['probes'] })
const ready = () => report({ audit_log: 'passed' })
const admitted = (next: HostQualificationReport | null, toolId: string) => admitForQualification(qualifyHostTools(unqualifiedTools, next, true), next).find(tool => tool.id === toolId)!

describe('qualification admission', () => {
  it('opens a ready tool as an admission that carries no evidence', () => {
    const tool = admitted(ready(), 'audit-log')
    assert.equal(tool.status, 'verified')
    assert.equal(tool.delivery.admission, 'qualification')
    assert.deepEqual(tool.delivery.evidence, [])
  })

  it('keeps a tool closed when a prerequisite failed or the report is missing or not from Linux', () => {
    assert.equal(admitted(report({ audit_log: 'failed' }), 'audit-log').status, 'researched')
    assert.equal(admitted(report({}), 'audit-log').status, 'researched')
    assert.equal(admitted(report({ audit_log: 'passed' }, 'fake'), 'audit-log').status, 'researched')
    assert.equal(admitted(null, 'audit-log').status, 'researched')
  })

  it('keeps a tool without declared prerequisites and an out-of-scope tool closed', () => {
    const everything = report(Object.fromEntries(HOST_PROBES.map(probe => [probe, 'passed'])))
    const unprobed = unqualifiedTools.find(tool => tool.status === 'researched' && !Object.hasOwn(PHASE1_TOOL_PROBES, tool.id))!
    assert.equal(admitted(everything, unprobed.id).status, 'researched')
    const outside = unqualifiedTools.find(tool => tool.status === 'out-of-scope')!
    assert.equal(admitted(everything, outside.id).status, 'out-of-scope')
  })
})

describe('qualified catalog provider', () => {
  const host = (): HostCatalogSource => ({ token: 'b'.repeat(64), identity: {}, fetch: async () => Response.json(ready()) })
  const auditLog = (catalog: readonly { id: string; status: string }[]) => catalog.find(tool => tool.id === 'audit-log')?.status

  it('stays closed without the switch and closes the moment the switch goes', async () => {
    let mode = false
    const provider = createQualifiedCatalogProvider(undefined, () => mode, unqualifiedTools), agent = host()
    assert.equal(auditLog(await provider.load(agent)), 'researched')
    mode = true
    assert.equal(auditLog(await provider.load(agent)), 'verified')
    mode = false
    assert.equal(auditLog(await provider.load(agent)), 'researched')
  })

  it('refuses admission without a connected agent or with host qualification off', async () => {
    const provider = createQualifiedCatalogProvider(undefined, () => true, unqualifiedTools)
    assert.equal(auditLog(await provider.load(null)), 'researched')
    process.env.XPANEL_HOST_QUALIFICATION = 'off'
    try { assert.equal(auditLog(await provider.load(host())), 'researched') }
    finally { delete process.env.XPANEL_HOST_QUALIFICATION }
  })
})

describe('qualification mode requests', () => {
  let db: TestDbHandle
  let state: TestStateStoreHandle

  beforeEach(async () => {
    db = await createTestDb()
    state = await createTestStateStore()
    await createRootPrincipal(db.db, { username: 'root', passwordHash: await hashPasswordArgon2id('RootPassword!2026'), forcePasswordChange: false })
  })
  afterEach(async () => {
    await state.close()
    await db.close()
  })

  const agent: AgentApp = { fetch: async () => Response.json(ready()), subscribe: () => () => undefined }
  const app = (mode?: () => boolean) => createApiApp({ db: db.db, store: state.store, serverSecret: TEST_SERVER_SECRET, agentApp: agent, agentToken: 'b'.repeat(64),
    ...(mode ? { catalogProvider: createQualifiedCatalogProvider(undefined, mode) } : {}) })
  const login = (api: ReturnType<typeof app>, path = '/api/auth/login', headers: Record<string, string> = {}) => api.fetch(new Request(`http://localhost${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ username: 'root', password: 'RootPassword!2026' }),
  }), { remoteAddress: '192.0.2.40' })
  const rows = async () => (await listAudit(db.db, { action: 'qualification.operation' })).map(entry => ({ actor: entry.actor, target: entry.target, outcome: entry.outcome }))

  it('records a request in the mode before it runs, and no request outside it', async () => {
    assert.equal((await login(app(() => false))).status, 200)
    assert.deepEqual(await rows(), [])
    assert.equal((await login(app(() => true))).status, 200)
    assert.deepEqual(await rows(), [{ actor: 'anonymous', target: 'POST /api/auth/login', outcome: 'ok' }])
  })

  it('names the signed-in actor, and records dynamic DNS updates that arrive as GET', async () => {
    const api = app(() => true), signedIn = await login(api)
    const cookie = signedIn.headers.get('set-cookie')!.split(';')[0]!, csrf = (await signedIn.json() as { csrfToken: string }).csrfToken
    await api.fetch(new Request('http://localhost/api/auth/logout', { method: 'POST', headers: { cookie, 'x-csrf-token': csrf } }), { remoteAddress: '192.0.2.40' })
    await api.fetch(new Request('http://localhost/nic/update?hostname=a.example'), { remoteAddress: '192.0.2.40' })
    assert.deepEqual((await rows()).map(row => `${row.actor} ${row.target}`).sort(), ['anonymous GET /nic/update', 'anonymous POST /api/auth/login', 'root POST /api/auth/logout'])
  })

  it('refuses the operation when the audit row cannot be written', async () => {
    await db.db.exec("CREATE TRIGGER refuse_qualification_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'qualification.operation' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END")
    const response = await login(app(() => true))
    assert.ok(response.status >= 500)
    assert.equal(response.headers.get('set-cookie'), null)
  })

  it('shows the banner on rendered documents only while the switch is on', async () => {
    const page = async (mode: boolean) => {
      const render = await createDefaultWebRenderer({ store: state.store, db: db.db, serverSecret: TEST_SERVER_SECRET, catalogProvider: createQualifiedCatalogProvider(undefined, () => mode) })
      return (await render(new Request('http://localhost/login', { headers: { accept: 'text/html' } }))).text()
    }
    assert.equal((await page(true)).includes('data-qualification-mode'), true)
    assert.equal((await page(false)).includes('data-qualification-mode'), false)
  })

  it('cannot be turned on by a request', async () => {
    const api = app(), headers = { 'x-qualification-mode': '1', 'x-xpanel-qualification': 'on', 'x-forwarded-host': 'lab' }
    const signedIn = await login(api, '/api/auth/login?qualification=1&qualificationMode=on', headers)
    assert.equal(signedIn.status, 200)
    assert.deepEqual(await rows(), [])
    const cookie = signedIn.headers.get('set-cookie')!.split(';')[0]!
    const catalog = await api.fetch(new Request('http://localhost/api/catalog?qualification=1', { headers: { cookie, ...headers } }), { remoteAddress: '192.0.2.40' })
    assert.equal(((await catalog.json()) as { tools: { delivery?: { admission?: string } }[] }).tools.some(tool => tool.delivery?.admission), false)
  })
})
