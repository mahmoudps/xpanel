import { open, type FileHandle } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { suggestServerSettings } from '@xpanel/core'
import { createTestDb, listGenerations, type TestDbHandle } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { createTestStateStore, type TestStateStoreHandle } from '@xpanel/state'
import { FakeHostExecutor } from './executor.ts'
import { compileDesiredGeneration, HostReconciler } from './reconciler.ts'

const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
const KERNEL = '/proc/sys/kernel/hostname'
const NGINX_V = ['/usr/sbin/nginx', '-v']
let state: TestStateStoreHandle
let db: TestDbHandle
// Device flushes, not these contracts, set the wall time; flush durability is proven by packages/state atomic-durability tests.
let restoreFileSync = (): void => {}
beforeAll(async () => {
  const probe = await open(fileURLToPath(import.meta.url), 'r')
  try {
    const sync = vi.spyOn(Object.getPrototypeOf(probe) as FileHandle, 'sync').mockResolvedValue(undefined)
    restoreFileSync = () => sync.mockRestore()
  } finally { await probe.close() }
})
afterAll(() => restoreFileSync())
beforeEach(async () => {
  state = await createTestStateStore()
  db = await createTestDb()
  const suggested = suggestServerSettings({ cores: 2, memoryMb: 2048 })
  await state.store.saveServerSettings({ hostname: 'srv1.example.com', nameservers: ['ns1.example.com', 'ns2.example.com'], adminEmail: 'ops@example.com', engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 22, nginx: suggested.nginx, apache: suggested.apache, backendPort: 8080, backendTlsPort: 8443 })
})
afterEach(async () => { await state.close(); await db.close() })

const host = (): FakeHostExecutor => {
  const executor = new FakeHostExecutor()
  executor.files.set(KERNEL, { path: KERNEL, content: 'srv1.example.com\n', mode: 0o444 })
  return executor
}
const defaultSite = (files: Iterable<{ path: string; content: string }>): string | undefined => [...files].find(file => file.path.endsWith('/000-xpanel-default.conf'))?.content

describe('edge HTTP/2 style from the installed nginx', { tags: ['feature'] }, () => {
  it('renders the shared 443 servers in the observed style', async () => {
    const snapshot = await state.store.readSnapshot()
    expect(defaultSite(compileDesiredGeneration(snapshot, { os, nginxHttp2: 'listen' }).files)).toContain('listen 443 ssl http2 default_server;')
    const directive = defaultSite(compileDesiredGeneration(snapshot, { os, nginxHttp2: 'directive' }).files)
    expect(directive).toContain('listen 443 ssl default_server;')
    expect(directive).toContain('http2 on;')
  })

  it('reads the version from the config-test binary after preflight and applies the directive style for 1.26', async () => {
    const executor = host()
    executor.nginxVersion = 'nginx version: nginx/1.26.3\n'
    const reconciler = new HostReconciler({ store: state.store, db: db.db, executor, os })
    expect(await reconciler.reconcile({ actor: 'root', mailAuth: null })).toMatchObject({ status: 'applied' })
    expect(executor.executedCommands).toContainEqual(NGINX_V)
    const site = defaultSite(executor.files.values())
    expect(site).toContain('listen 443 ssl default_server;')
    expect(site).toContain('http2 on;')
    expect(site).not.toContain(' http2 default_server;')
  })

  it.each([
    ['a failing binary', (executor: FakeHostExecutor) => executor.failCommand(NGINX_V.join(' '), 127, 'nginx: not found\n')],
    ['output without a version', (executor: FakeHostExecutor) => { executor.nginxVersion = 'nginx: unexpected\n' }],
  ])('refuses before any host change on %s', async (_label, breakNginx) => {
    const executor = host()
    breakNginx(executor)
    const reconciler = new HostReconciler({ store: state.store, db: db.db, executor, os })
    await expect(reconciler.reconcile({ actor: 'root', mailAuth: null })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED', message: 'the installed nginx version could not be observed', detail: { stateChanged: false },
    })
    expect(defaultSite(executor.files.values())).toBeUndefined()
    expect(executor.executedActions).toEqual([])
    expect(await listGenerations(db.db)).toEqual([])
  })
})
