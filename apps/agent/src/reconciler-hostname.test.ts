import { open, type FileHandle } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { suggestServerSettings } from '@xpanel/core'
import type { HostAction } from '@xpanel/core'
import { createTestDb, type TestDbHandle } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { createTestStateStore, type TestStateStoreHandle } from '@xpanel/state'
import { createProductionHostTargetMatcher, FakeHostExecutor, type HostTargetOperation } from './executor.ts'
import { compileDesiredGeneration, HostReconciler } from './reconciler.ts'

const KERNEL = '/proc/sys/kernel/hostname'
const HOSTNAMECTL = ['/usr/bin/hostnamectl', 'set-hostname', 'srv1.example.com']
const ORIGINAL_HOSTS = '127.0.0.1 localhost\n127.0.1.1 old-vm\n10.0.0.5 db.internal\n'
const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
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
  await state.store.saveServerIp({ address: '203.0.113.10', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
})
afterEach(async () => { await state.close(); await db.close() })

/** hostnamectl stand-in: the kernel name follows a successful set-hostname. */
class HostnamedExecutor extends FakeHostExecutor {
  override async runAction(action: HostAction): Promise<void> {
    await super.runAction(action)
    if (action.kind === 'exec' && action.argv[0] === '/usr/bin/hostnamectl') this.files.set(KERNEL, { path: KERNEL, content: `${action.argv[2]}\n`, mode: 0o444 })
  }
}
const seedHost = (executor: FakeHostExecutor): void => {
  executor.files.set(KERNEL, { path: KERNEL, content: 'old-vm\n', mode: 0o444 })
  executor.files.set('/etc/hosts', { path: '/etc/hosts', content: ORIGINAL_HOSTS, mode: 0o644, owner: 'root', group: 'root' })
}
const hostnamectlRuns = (executor: FakeHostExecutor): number => executor.executedActions.filter(action => action.kind === 'exec' && action.argv[0] === '/usr/bin/hostnamectl').length

describe('saved server host name', { tags: ['feature'] }, () => {
  it('renders /etc/hostname and the hosts mapping, and runs hostnamectl only when the kernel name differs', async () => {
    const snapshot = await state.store.readSnapshot()
    const unobserved = compileDesiredGeneration(snapshot, { os })
    expect(unobserved.files.find(file => file.path === '/etc/hostname')?.content).toBe('srv1.example.com\n')
    expect(unobserved.postActions).not.toContainEqual({ kind: 'exec', argv: HOSTNAMECTL })
    expect(unobserved.hostname).toBeUndefined()
    const renamed = compileDesiredGeneration(snapshot, { os, etcHosts: ORIGINAL_HOSTS, observedHostname: 'old-vm\n' })
    expect(renamed.postActions).toContainEqual({ kind: 'exec', argv: HOSTNAMECTL })
    expect(renamed.hostname).toBe('srv1.example.com')
    expect(renamed.files.find(file => file.path === '/etc/hosts')?.content).toBe('# Managed by xPanel\n::1 localhost ip6-localhost ip6-loopback\n127.0.0.1 localhost\n10.0.0.5 db.internal\n203.0.113.10 srv1.example.com srv1\n')
    const current = compileDesiredGeneration(snapshot, { os, observedHostname: 'srv1.example.com\n' })
    expect(current.postActions).not.toContainEqual({ kind: 'exec', argv: HOSTNAMECTL })
    expect(current.hostname).toBeUndefined()
  })

  it('admits exactly the host name files, the kernel name read and the hostnamectl argv', async () => {
    const matcher = createProductionHostTargetMatcher()
    const operations: HostTargetOperation[] = ['read', 'write', 'remove', 'ensure-directory']
    for (const path of ['/etc/hostname', '/etc/hosts']) expect(operations.map(op => matcher(path, op))).toEqual([true, true, true, false])
    expect(operations.map(op => matcher(KERNEL, op))).toEqual([true, false, false, false])
    for (const path of ['/etc/hosts.allow', '/etc/hostname/extra', '/proc/sys/kernel/domainname']) expect(matcher(path, 'write')).toBe(false)
    const fake = new FakeHostExecutor()
    await fake.runCommand([...HOSTNAMECTL])
    await expect(fake.runCommand(['/usr/bin/hostnamectl', 'set-hostname', 'srv1.example.com;reboot'])).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('applies the name, keeps unrelated hosts lines and verifies the kernel name', async () => {
    const executor = new HostnamedExecutor()
    seedHost(executor)
    const reconciler = new HostReconciler({ store: state.store, db: db.db, executor, os })
    expect((await reconciler.reconcile({ actor: 'root', mailAuth: null })).status).toBe('applied')
    expect(hostnamectlRuns(executor)).toBe(1)
    expect(executor.files.get(KERNEL)?.content).toBe('srv1.example.com\n')
    expect(executor.files.get('/etc/hostname')?.content).toBe('srv1.example.com\n')
    expect(executor.files.get('/etc/hosts')?.content).toContain('10.0.0.5 db.internal\n')
    expect(executor.files.get('/etc/hosts')?.content).not.toContain('old-vm')
    await reconciler.reconcile({ actor: 'root', mailAuth: null })
    expect(hostnamectlRuns(executor)).toBe(1)
  })

  it('fails and restores the previous files when the kernel name does not follow', async () => {
    const executor = new FakeHostExecutor()
    seedHost(executor)
    const reconciler = new HostReconciler({ store: state.store, db: db.db, executor, os })
    const result = await reconciler.reconcile({ actor: 'root', mailAuth: null })
    expect(result).toMatchObject({ status: 'failed', failedTest: 'hostname', rolledBack: true })
    expect(result.status === 'failed' && result.error).toContain('expected srv1.example.com, observed old-vm')
    expect(executor.files.get('/etc/hosts')?.content).toBe(ORIGINAL_HOSTS)
    expect(executor.files.has('/etc/hostname')).toBe(false)
  })
})
