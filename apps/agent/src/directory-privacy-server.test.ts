import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { fail } from '@xpanel/core'
import type { Account, Domain } from '@xpanel/core'
import { createRootPrincipal, createTestDb, createUserPrincipal } from '@xpanel/db'
import type { StateStore } from '@xpanel/state'
import { FakeHostExecutor } from './executor.ts'
import type { HostReconciler } from './reconciler.ts'
import type { AccountFileRequest, FileText } from './file-manager.ts'
import { sha512Crypt } from './directory-privacy.ts'
import { agentCallerHeaders, createAgentApp } from './server.ts'
// The loopback Apache probe is a declared test transport; the confined runner is an in-memory double.
vi.mock('./htaccess-native.ts', () => ({
  createNativeHtaccessValidator: () => ({ available: async () => true, check: async () => ({ valid: true, nativeChecked: true, issues: [], checkedAt: new Date().toISOString() }) }),
  probeHtaccessTarget: async () => 401,
}))

const TOKEN = 'a'.repeat(64)
const TEST_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNo'
const handles: Awaited<ReturnType<typeof createTestDb>>[] = []
afterEach(async () => { for (const handle of handles.splice(0)) await handle.close() })

async function fixture() {
  const handle = await createTestDb(); handles.push(handle)
  const account = { id: randomUUID(), username: 'alice', uid: 1001, gid: 1001, home: '/home/alice', status: 'active', planId: randomUUID(), ownerId: null } as Account
  const other = { ...account, id: randomUUID(), username: 'bob', uid: 1002, gid: 1002, home: '/home/bob' }
  const domain = { id: randomUUID(), accountId: account.id, kind: 'primary', name: 'alice.example.test', docRoot: '/home/alice/public_html', suspended: false, siteType: 'static' } as Domain
  const root = await createRootPrincipal(handle.db, { username: 'root', passwordHash: TEST_HASH })
  const neighbor = await createUserPrincipal(handle.db, { username: 'bob', accountId: other.id, passwordHash: TEST_HASH })
  const owner = await createUserPrincipal(handle.db, { username: account.username, accountId: account.id, passwordHash: TEST_HASH })
  const disabled: string[] = []
  const files = new Map<string, FileText>(), folders = new Set(['public_html', 'public_html/private'])
  let tick = 0
  const parent = (path: string) => path.split('/').slice(0, -1).join('/')
  const stamp = () => new Date(1_793_016_000_000 + ++tick * 1000).toISOString()
  const runner = { run: vi.fn(async (context: { account: { username: string } }, request: Readonly<AccountFileRequest>) => {
    if (context.account.username !== 'alice') throw new Error('must not reach another account')
    if (request.op === 'list') return folders.has(request.path) ? [...[...folders].filter(dir => parent(dir) === request.path).map(dir => ({ name: dir.split('/').at(-1), path: dir, kind: 'directory', sizeBytes: 0, mode: 0o750, mtime: stamp() })),
      ...[...files.values()].filter(file => parent(file.path) === request.path).map(file => ({ name: file.path.split('/').at(-1), path: file.path, kind: 'file', sizeBytes: file.sizeBytes, mode: 0o640, mtime: file.mtime }))] : fail('NOT_FOUND', 'missing', { stateChanged: false })
    if (request.op === 'read') return files.get(request.path) ?? fail('NOT_FOUND', 'missing', { stateChanged: false })
    if (request.op === 'mkdir') { if (folders.has(request.path)) return fail('CONFLICT', 'exists', { stateChanged: false }); folders.add(request.path); return { name: request.path.split('/').at(-1), path: request.path, kind: 'directory', sizeBytes: 0, mode: request.mode, mtime: stamp() } }
    if (request.op !== 'write-checked') throw new Error('unexpected operation')
    const current = files.get(request.path)
    if (request.expectedExists !== !!current || current && (current.content !== request.expectedContent || current.mtime !== request.expectedMtime)) return fail('CONFLICT', 'changed', { stateChanged: false })
    if (request.remove) { files.delete(request.path); return null }
    const file = { path: request.path, content: request.content, sizeBytes: Buffer.byteLength(request.content), mtime: stamp() }
    files.set(request.path, file)
    return { name: request.path.split('/').at(-1), path: request.path, kind: 'file', sizeBytes: file.sizeBytes, mode: request.mode, mtime: file.mtime }
  }) }
  const store = { getAccount: async (id: string) => id === account.id ? account : id === other.id ? other : null,
    getAccountByUsername: async (username: string) => username === account.username ? account : null,
    withAccountLifecycleLease: async (_id: string, operation: (value: Account) => Promise<unknown>) => operation(account),
    getPlan: async () => ({ id: account.planId, featureListId: 'features', resources: { diskMb: 512 } }), getFeatureList: async () => ({ disabled }),
    listDomains: async () => [domain], getServerSettings: async () => ({ engine: 'apache', backendPort: 8080 }) } as unknown as StateStore
  const executor = new FakeHostExecutor(); executor.readFile = async path => path === '/etc/os-release' ? 'ID=ubuntu\nVERSION_ID="24.04"\n' : null
  const app = createAgentApp({ store, db: handle.db, executor, accountFileRunner: runner, reconciler: {} as HostReconciler, os: { id: 'ubuntu', versionId: '24.04', family: 'debian' }, agentToken: TOKEN })
  const send = (principalId: string, body: unknown) => app.fetch(new Request('http://agent.local/accounts/alice/directory-privacy',
    { method: 'POST', headers: { ...agentCallerHeaders({ principalId, token: TOKEN }), 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  return { handle, root, neighbor, owner, runner, disabled, files, send }
}

describe('authenticated directory privacy agent dispatch', { tags: ['feature'] }, () => {
  it('reads and saves a folder for its owner through the confined runner and audits the save', async () => {
    const t = await fixture()
    const read = await t.send(t.owner.id, { op: 'read', path: 'public_html/private' })
    expect(read.status).toBe(200)
    const folder = (await read.json() as { directories: { revision: string }[] }).directories[0]!
    const saved = await t.send(t.owner.id, { op: 'save', path: 'public_html/private', expectedRevision: folder.revision, enabled: true, authName: 'Members', users: [{ username: 'bob', passwordHash: sha512Crypt('correct horse battery') }] })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ application: { status: 'saved', httpStatus: 401, protectionVerified: true }, directories: [{ path: 'public_html/private', enabled: true, users: ['bob'] }] })
    expect(t.files.get('public_html/private/.htaccess')!.content).toContain('Require valid-user')
    const rows = await t.handle.db.query<{ action: string; outcome: string }>('SELECT action, outcome FROM audit_log WHERE action = $1', ['account.directory_privacy.saved'])
    expect(rows).toEqual([{ action: 'account.directory_privacy.saved', outcome: 'ok' }])
  })

  it('refuses a neighbor and a disabled plan feature before any file is touched', async () => {
    const t = await fixture()
    expect((await t.send(t.neighbor.id, { op: 'read', path: null })).status).toBe(403)
    t.disabled.push('directory-privacy')
    expect((await t.send(t.owner.id, { op: 'read', path: null })).status).toBe(403)
    expect((await t.send(t.root.id, { op: 'delete', path: 'public_html/private' })).status).toBe(422)
    expect(t.runner.run).not.toHaveBeenCalled()
  })
})
