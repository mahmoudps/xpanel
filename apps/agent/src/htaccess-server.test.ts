import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Account, Domain } from '@xpanel/core'
import { createRootPrincipal, createTestDb, createUserPrincipal, setPrincipalDisabled } from '@xpanel/db'
import type { StateStore } from '@xpanel/state'
import { FakeHostExecutor } from './executor.ts'
import type { HostReconciler } from './reconciler.ts'
import type { AccountFileRequest, FileText } from './file-manager.ts'
import { agentCallerHeaders, createAgentApp } from './server.ts'
const transports = vi.hoisted(() => ({ history: new Map<string, unknown>() }))
// Route-only file/journal/parser ports are declared test transports. The
// workspace tests separately exercise actual private temporary journal files.
vi.mock('@xpanel/state', async importOriginal => ({ ...await importOriginal<typeof import('@xpanel/state')>(),
  readJsonIfExists: async (path: string) => structuredClone(transports.history.get(path) ?? null),
  atomicWriteJson: async (path: string, value: unknown) => { transports.history.set(path, structuredClone(value)) },
}))
vi.mock('./htaccess-native.ts', () => ({
  createNativeHtaccessValidator: () => ({ available: async () => true, check: async () => ({ valid: true, nativeChecked: true, issues: [], checkedAt: new Date().toISOString() }) }),
  probeHtaccessTarget: async () => 200,
}))

const TOKEN = 'a'.repeat(64)
const TEST_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNo'
const handles: Awaited<ReturnType<typeof createTestDb>>[] = []
afterEach(async () => { for (const handle of handles.splice(0)) await handle.close(); transports.history.clear() })
async function fixture(owned = false) {
  const handle = await createTestDb(); handles.push(handle)
  const account = { id: randomUUID(), username: 'alice', uid: 1001, gid: 1001, home: '/home/alice', status: 'active', planId: randomUUID(), ownerId: null } as Account
  const other = { ...account, id: randomUUID(), username: 'bob', uid: 1002, gid: 1002, home: '/home/bob' }
  const domain = { id: randomUUID(), accountId: owned ? account.id : other.id, kind: 'primary', name: owned ? 'alice.example.test' : 'bob.example.test', docRoot: owned ? '/home/alice/public_html' : '/home/bob/public_html', suspended: false, siteType: 'static' } as Domain
  const root = await createRootPrincipal(handle.db, { username: 'root', passwordHash: TEST_HASH })
  const user = await createUserPrincipal(handle.db, { username: 'bob', accountId: other.id, passwordHash: TEST_HASH })
  const disabled: string[] = []
  let tick = 0, file: FileText = { path: 'public_html/.htaccess', content: 'RewriteEngine Off\n', sizeBytes: 18, mtime: '2026-10-26T12:00:00.000Z' }
  const runner = { run: vi.fn(async (_context: unknown, request: Readonly<AccountFileRequest>) => {
    if (!owned || !('path' in request) || request.path !== file.path) throw new Error('must not reach an unowned file target')
    if (request.op === 'read') return { ...file }
    if (request.op !== 'write-checked' || request.remove || !request.expectedExists || request.expectedContent !== file.content || request.expectedMtime !== file.mtime) throw new Error('unverified test preimage')
    file = { path: file.path, content: request.content, sizeBytes: Buffer.byteLength(request.content), mtime: new Date(1793016000000 + ++tick * 1000).toISOString() }
    return { name: '.htaccess', path: file.path, kind: 'file', sizeBytes: file.sizeBytes, mode: request.mode, mtime: file.mtime }
  }) }
  let onLease: (() => Promise<void>) | undefined
  // Declared state port isolates route authorization. This does not prove a
  // native host operation or a cross-process lifecycle lock.
  const lease = vi.fn(async (_id: string, operation: (value: Account) => Promise<unknown>) => { await onLease?.(); return operation(account) })
  const store = { getAccount: async (id: string) => id === account.id ? account : id === other.id ? other : null,
    getAccountByUsername: async (username: string) => username === account.username ? account : null,
    withAccountLifecycleLease: lease, getPlan: async () => ({ id: account.planId, featureListId: 'features', resources: { diskMb: 512 } }),
    getFeatureList: async () => ({ disabled }), getDomain: async (id: string) => id === domain.id ? domain : null,
    getServerSettings: async () => ({ engine: 'apache', backendPort: 8080 }) } as unknown as StateStore
  const executor = new FakeHostExecutor(); executor.readFile = async path => path === '/etc/os-release' ? 'ID=ubuntu\nVERSION_ID="24.04"\n' : null
  const app = createAgentApp({ store, db: handle.db, executor, accountFileRunner: runner,
    reconciler: {} as HostReconciler, os: { id: 'ubuntu', versionId: '24.04', family: 'debian' }, agentToken: TOKEN })
  const send = (principalId = root.id, body: unknown = { op: 'read' }) => app.fetch(new Request('http://agent.local/accounts/alice/htaccess/' + domain.id,
    { method: 'POST', headers: { ...agentCallerHeaders({ principalId, token: TOKEN }), 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  return { handle, root, user, domain, runner, disabled, lease, send, revokeOnLease: () => { onLease = () => setPrincipalDisabled(handle.db, root.id, true) } }
}
describe('authenticated .htaccess agent dispatch', () => {
  it('reads the authorized file, saves exact content and restores the kept version across requests', async () => {
    const f = await fixture(true), read = await f.send(); expect(read.status).toBe(200)
    const before = await read.json() as { context: { domainId: string }; document: { content: string; revision: string } }
    expect(before.context.domainId).toBe(f.domain.id)
    const savedResponse = await f.send(f.root.id, { op: 'save', content: 'RewriteEngine On\n', expectedRevision: before.document.revision }); expect(savedResponse.status).toBe(200)
    const saved = await savedResponse.json() as { document: { content: string; revision: string }; versions: { id: string; state: string }[]; application: { status: string } }
    expect(saved.document.content).toBe('RewriteEngine On\n'); expect(saved.application.status).toBe('saved')
    const restoredResponse = await f.send(f.root.id, { op: 'restore', versionId: saved.versions.find(item => item.state === 'kept')!.id, expectedRevision: saved.document.revision }); expect(restoredResponse.status).toBe(200)
    expect(await restoredResponse.json()).toMatchObject({ document: { content: before.document.content }, application: { status: 'restored' } })
    expect(f.runner.run.mock.calls.filter(call => call[1].op === 'write-checked')).toHaveLength(2)
  })
  it('rejects client path/probe selectors before entering the account lease', async () => {
    const f = await fixture(); expect((await f.send(f.root.id, { op: 'read', path: '/etc/passwd' })).status).toBe(422)
    expect(f.lease).not.toHaveBeenCalled(); expect(f.runner.run).not.toHaveBeenCalled()
  })
  it('refuses a domain owned by another account', async () => {
    const f = await fixture(); expect((await f.send()).status).toBe(404); expect(f.runner.run).not.toHaveBeenCalled()
  })
  it('refuses another account owner even with forged role headers unavailable', async () => {
    const f = await fixture(); expect((await f.send(f.user.id)).status).toBe(403); expect(f.runner.run).not.toHaveBeenCalled()
  })
  it('enforces the current feature list and rechecks principal revocation under the lease', async () => {
    const f = await fixture(); f.disabled.push('aapanel-url-rewrite'); expect((await f.send()).status).toBe(403)
    f.disabled.splice(0); f.revokeOnLease(); expect((await f.send()).status).toBe(403); expect(f.runner.run).not.toHaveBeenCalled()
  })
})
