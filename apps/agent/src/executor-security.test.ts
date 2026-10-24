import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'vitest'
import { isXpanelError, suggestServerSettings } from '@xpanel/core'
import type { HostAction, RenderedFile } from '@xpanel/core'
import { createTestDb, listGenerations } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { createTestStateStore } from '@xpanel/state'
import { createProductionHostTargetMatcher, LinuxHostExecutor } from './executor.ts'
import type { HostTargetOperation } from './executor.ts'
import { compileDesiredGeneration, HostReconciler } from './reconciler.ts'

const preconditionFailure = (error: unknown): boolean => isXpanelError(error) && error.code === 'PRECONDITION_FAILED'

describe('Linux executor capability boundaries', () => {
  it('rejects target grants using another platform path syntax', () => {
    const foreignPath = process.platform === 'win32' ? '/var/tmp/xpanel-fixture.conf' : 'C:\\xpanel-fixture.conf'
    assert.throws(
      () => new LinuxHostExecutor({ trustedHostTargets: [{ path: foreignPath, operations: ['read'] }] }),
      (error: unknown) => isXpanelError(error) && error.code === 'VALIDATION',
    )
  })

  it.each(['mariadb', 'postgresql'] as const)('refuses %s SQL without a configured runner', async (engine) => {
    const executor = new LinuxHostExecutor()
    await assert.rejects(
      () => executor.runAction({ kind: 'sql', engine, statements: ['CREATE DATABASE tenant_fixture'] }),
      preconditionFailure,
    )
  })

  it('executes SQL only through the injected runner', async () => {
    const calls: { engine: string; statements: string[] }[] = []
    const executor = new LinuxHostExecutor({
      sqlRunner: async (engine, statements) => { calls.push({ engine, statements }) },
    })
    await executor.runAction({ kind: 'sql', engine: 'mariadb', statements: ['CREATE DATABASE tenant_fixture'] })
    assert.deepEqual(calls, [{ engine: 'mariadb', statements: ['CREATE DATABASE tenant_fixture'] }])
  })

  it('does not report SQL provisioning success after a runner failure', async () => {
    let provisioned = false
    const failure = new Error('fixture runner rejected provisioning')
    const executor = new LinuxHostExecutor({ sqlRunner: async () => { throw failure } })
    await assert.rejects(async () => {
      await executor.runAction({ kind: 'sql', engine: 'mariadb', statements: ['CREATE DATABASE tenant_fixture'] })
      provisioned = true
    }, (error) => error === failure)
    assert.equal(provisioned, false)
  })
})

describe('generated host file target authorization', () => {
  let fixture: string
  let marker: string

  beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), 'xpanel-executor-security-'))
    marker = join(fixture, '.user.ini')
    await writeFile(marker, 'protected-original')
  })

  afterEach(async () => {
    await rm(fixture, { recursive: true, force: true })
  })

  it('rejects a generated tenant read before opening an ungranted target', async () => {
    const executor = new LinuxHostExecutor()
    await assert.rejects(() => executor.readFile(marker), preconditionFailure)
  })

  it('rejects a generated tenant write before publishing any bytes', async () => {
    const executor = new LinuxHostExecutor()
    await assert.rejects(() => executor.writeFile({ path: marker, content: 'changed', mode: 0o640 }), preconditionFailure)
    assert.equal(await readFile(marker, 'utf8'), 'protected-original')
  })

  it('rejects generated-path removal before deleting an ungranted file', async () => {
    const executor = new LinuxHostExecutor()
    await assert.rejects(() => executor.removePath(marker), preconditionFailure)
    assert.equal(await readFile(marker, 'utf8'), 'protected-original')
  })

  it('rejects ungranted directory provisioning before creating it', async () => {
    const executor = new LinuxHostExecutor()
    const directory = join(fixture, 'new-directory')
    await assert.rejects(() => executor.runAction({
      kind: 'ensure-dir', path: directory, mode: 0o750, owner: 'root', group: 'root',
    }), preconditionFailure)
    await assert.rejects(() => stat(directory), { code: 'ENOENT' })
  })

  it('permits only explicitly reviewed exact fixture targets', async () => {
    const sibling = marker + '.other'
    await writeFile(sibling, 'ungranted-neighbor')
    const executor = new LinuxHostExecutor({ trustedHostTargets: [{ path: marker, operations: ['read', 'write', 'remove'] }] })
    assert.equal(await executor.readFile(marker), 'protected-original')
    await executor.writeFile({ path: marker, content: 'reviewed-fixture', mode: 0o600 })
    assert.equal(await executor.readFile(marker), 'reviewed-fixture')
    await assert.rejects(() => executor.readFile(sibling), preconditionFailure)
    await assert.rejects(() => executor.removePath(sibling), preconditionFailure)
    await executor.removePath(marker)
    assert.equal(await executor.readFile(marker), null)
    assert.equal(await readFile(sibling, 'utf8'), 'ungranted-neighbor')
  })

  it('does not infer write or remove permission from a read grant', async () => {
    const executor = new LinuxHostExecutor({ trustedHostTargets: [{ path: marker, operations: ['read'] }] })
    await assert.rejects(() => executor.writeFile({ path: marker, content: 'changed', mode: 0o600 }), preconditionFailure)
    await assert.rejects(() => executor.removePath(marker), preconditionFailure)
    assert.equal(await executor.readFile(marker), 'protected-original')
  })

  it('admits the managed account paths without granting arbitrary tenant content', () => {
    const permits = createProductionHostTargetMatcher()
    for (const operation of ['read', 'write', 'remove'] as const) {
      assert.equal(permits('/home/fixture/public_html/.user.ini', operation), true)
      assert.equal(permits('/home/fixture/cgi-bin/php.cgi', operation), true)
      assert.equal(permits('/home/fixture/public_html/private.txt', operation), false)
    }
  })

  for (const [directory, filename] of [['public_html', '.user.ini'], ['cgi-bin', 'php.cgi']] as const) {
    it.each(['read', 'write', 'remove'] as const)(`refuses %s through a substituted ${directory} ancestor of ${filename}`, async (operation) => {
      const accountRoot = join(fixture, 'account')
      const parent = join(accountRoot, directory)
      const retiredParent = join(accountRoot, `${directory}-original`)
      const outside = join(fixture, 'outside-account')
      const target = join(parent, filename)
      const outsideTarget = join(outside, filename)
      await mkdir(parent, { recursive: true })
      await mkdir(outside)
      await writeFile(target, 'original-account-content')
      await writeFile(outsideTarget, 'protected-outside-content')
      const executor = new LinuxHostExecutor({ trustedHostTargets: [{ path: target, operations: ['read', 'write', 'remove'] }] })
      assert.equal(await executor.readFile(target), 'original-account-content')

      // A tenant substitutes the parent after the exact target was granted.
      await rename(parent, retiredParent)
      await symlink(outside, parent, process.platform === 'win32' ? 'junction' : 'dir')
      let failure: unknown
      let observed: unknown
      try {
        if (operation === 'read') observed = await executor.readFile(target)
        else if (operation === 'write') await executor.writeFile({ path: target, content: 'replacement-account-content', mode: 0o600 })
        else await executor.removePath(target)
      } catch (error) {
        failure = error
      }
      const outsideContent = await readFile(outsideTarget, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      assert.equal(outsideContent, 'protected-outside-content')
      assert.equal(await readFile(join(retiredParent, filename), 'utf8'), 'original-account-content')
      assert.equal(observed, undefined, 'a substituted parent must not expose the outside file')
      assert.notEqual(failure, undefined, 'the granted path must fail closed after parent substitution')
    })
  }

  it('copies target grants so later caller mutation cannot mint permissions', async () => {
    const operations: HostTargetOperation[] = ['read']
    const executor = new LinuxHostExecutor({ trustedHostTargets: [{ path: marker, operations }] })
    operations.push('write')
    await assert.rejects(() => executor.writeFile({ path: marker, content: 'changed', mode: 0o600 }), preconditionFailure)
  })

  it('creates a missing systemd slice drop-in directory and publishes the file without a temp leftover', async () => {
    if (process.platform === 'win32') return
    const dir = join(fixture, 'user-20003.slice.d')
    const target = join(dir, '50-xpanel.conf')
    const executor = new LinuxHostExecutor({
      trustedHostTargets: [
        { path: target, operations: ['read', 'write'] },
        { path: dir, operations: ['ensure-directory'] },
      ],
    })
    await executor.writeFile({ path: target, content: '[Slice]\nTasksMax=10\n', mode: 0o644 })
    assert.equal(await readFile(target, 'utf8'), '[Slice]\nTasksMax=10\n')
    assert.deepEqual(await readdir(dir), ['50-xpanel.conf'])
  })

  it('does not create ungranted missing parents for an approved file', async () => {
    const parent = join(fixture, 'missing-parent')
    const target = join(parent, 'config.conf')
    const executor = new LinuxHostExecutor({ trustedHostTargets: [{ path: target, operations: ['write'] }] })
    await assert.rejects(() => executor.writeFile({ path: target, content: 'content', mode: 0o600 }), { code: 'ENOENT' })
    await assert.rejects(() => stat(parent), { code: 'ENOENT' })
  })

  it('does not recursively remove ungranted children of an approved directory', async () => {
    const directory = join(fixture, 'managed-directory')
    await mkdir(directory)
    const child = join(directory, 'ungranted-child')
    await writeFile(child, 'preserved')
    const executor = new LinuxHostExecutor({ trustedHostTargets: [{ path: directory, operations: ['remove'] }] })
    await assert.rejects(() => executor.removePath(directory))
    assert.equal(await readFile(child, 'utf8'), 'preserved')
  })

  it('requires rollback permission before admitting a generated file plan', async () => {
    const executor = new LinuxHostExecutor({ trustedHostTargets: [{ path: marker, operations: ['read', 'write'] }] })
    await assert.rejects(() => executor.preflight({
      files: [{ path: marker, content: 'changed', mode: 0o600 }], preActions: [], postActions: [],
    }), preconditionFailure)
    assert.equal(await readFile(marker, 'utf8'), 'protected-original')
  })

  it('checks all generated targets and directories without granting paths from a plan', async () => {
    const tenantTarget = join(fixture, 'tenant', 'public_html', '.user.ini')
    const executor = new LinuxHostExecutor({ trustedHostTargets: [{ path: marker, operations: ['read', 'write', 'remove'] }] })
    await assert.rejects(() => executor.preflight({
      files: [{ path: marker, content: 'changed', mode: 0o600 }, { path: tenantTarget, content: 'memory_limit=1G', mode: 0o640 }],
      preActions: [], postActions: [],
    }), preconditionFailure)
    await assert.rejects(() => executor.preflight({
      files: [], preActions: [{ kind: 'ensure-dir', path: join(fixture, 'tenant'), mode: 0o750, owner: 'root', group: 'root' }], postActions: [],
    }), preconditionFailure)
    assert.equal(await readFile(marker, 'utf8'), 'protected-original')
  })
})

class ObservedLinuxExecutor extends LinuxHostExecutor {
  readonly hostCalls: string[] = []
  override async readFile(path: string): Promise<string | null> { this.hostCalls.push('read'); return super.readFile(path) }
  override async writeFile(file: RenderedFile): Promise<void> { this.hostCalls.push('write'); return super.writeFile(file) }
  override async removePath(path: string): Promise<void> { this.hostCalls.push('remove'); return super.removePath(path) }
  override async runAction(action: HostAction): Promise<void> { this.hostCalls.push(action.kind); return super.runAction(action) }
}

describe('reconciler capability preflight ordering', () => {
  it.each(['sql', 'tenant-file'] as const)('rejects unavailable %s before snapshots, generations or provisioning', async (capability) => {
    const state = await createTestStateStore()
    const db = await createTestDb()
    const fixture = await mkdtemp(join(tmpdir(), 'xpanel-reconciler-preflight-'))
    const tenantTarget = join(fixture, '.user.ini')
    const reviewedTarget = join(fixture, 'host.conf')
    try {
      await writeFile(tenantTarget, 'protected-tenant-original')
      await writeFile(reviewedTarget, 'protected-host-original')
      const suggested = suggestServerSettings({ cores: 4, memoryMb: 8192 })
      await state.store.saveServerSettings({
        hostname: 'fixture.example.com', nameservers: ['ns1.example.com', 'ns2.example.com'], adminEmail: 'ops@example.com',
        engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 22,
        nginx: suggested.nginx, apache: suggested.apache, backendPort: 8080, backendTlsPort: 8443,
      })
      const features = await state.store.createFeatureList({ name: 'Fixture', ownerId: null, disabled: [] })
      const plan = await state.store.createPlan({
        name: 'Fixture', ownerId: null, featureListId: features.id,
        resources: { diskMb: 1024, bandwidthMbMonth: 10240, ioReadBps: 10_000_000, ioWriteBps: 10_000_000,
          ioReadIops: 1000, ioWriteIops: 1000, memoryMb: 1024, maxProcesses: 64, cpuPercent: 100 },
        caps: { addonDomains: 10, aliasDomains: 10, subdomains: 10, mailboxes: 10, forwarders: 10,
          mailingLists: 5, ftpAccounts: 10, databases: 10, phpWorkers: 4 },
        dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 1024,
      })
      // Shape-only state fixture; these tests never authenticate a password.
      const passwordHash = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNo'
      await state.store.saveServerIp({ address: '203.0.113.10', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
      const account = await state.store.createAccount({
        username: 'alice', passwordHash, primaryDomain: 'alice.example.com', planId: plan.id,
        ownerId: null, contactEmail: 'alice@example.com', ipv4: '203.0.113.10', shell: 'none',
        php: { version: '8.3', handler: 'fpm', ini: {}, fpm: { mode: 'ondemand', maxChildren: 4,
          startServers: 1, minSpareServers: 1, maxSpareServers: 3, maxRequests: 500, processIdleTimeoutSec: 10 } },
      })
      if (capability === 'sql') await state.store.createDatabase({ accountId: account.id, name: 'alice_fixture' })
      else {
        const domain = (await state.store.listDomains({ accountId: account.id }))[0]!
        await state.store.saveDomainCustomConfig({ domainId: domain.id, accountId: account.id,
          nginxInclude: '', apacheInclude: '', userIni: { memory_limit: '256M' }, customHeaders: {}, cacheBypassPaths: [] })
      }
      const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
      const compiled = compileDesiredGeneration(await state.store.readSnapshot(), { os, quotaFilesystem: '/home' })
      if (capability === 'sql') assert.equal(compiled.postActions.some((action) => action.kind === 'sql'), true)
      else assert.equal(compiled.files.some((file) => file.path.endsWith('/public_html/.user.ini')), true)
      assert.equal(compiled.preActions.some((action) => action.kind === 'ensure-user'), true)
      let snapshots = 0
      const originalSave = state.store.saveGenerationSnapshot.bind(state.store)
      state.store.saveGenerationSnapshot = async (id: number) => { snapshots++; return originalSave(id) }
      const executor = new ObservedLinuxExecutor({
        trustedHostTargets: [{ path: reviewedTarget, operations: ['read', 'write', 'remove'] }],
      })
      if (capability === 'tenant-file') {
        const preflight = executor.preflight.bind(executor)
        executor.preflight = async (executionPlan) => {
          const tenantFile = executionPlan.files.find((file) => file.path.endsWith('/public_html/.user.ini'))
          assert.ok(tenantFile, 'the Linux compiler must supply the tenant .user.ini target')
          // Exercise the real target guard with native fixture paths before Linux-only paths
          // or ownership checks. The tenant path receives no grant; the reviewed sibling does.
          await preflight({
            ...executionPlan,
            files: [
              { path: reviewedTarget, content: 'candidate-host-content', mode: 0o600 },
              { ...tenantFile, path: tenantTarget },
              ...executionPlan.files.filter((file) => file !== tenantFile),
            ],
          })
        }
      }
      const reconciler = new HostReconciler({ store: state.store, db: db.db, executor, os, quotaFilesystem: '/home' })
      await assert.rejects(() => reconciler.reconcile({ force: true }), (error: unknown) => {
        if (!preconditionFailure(error)) return false
        if (capability === 'sql') assert.match((error as Error).message, /SQL execution requires/)
        else assert.match((error as Error).message, /reviewed exact host target capability is required; tenant I\/O requires its confined runner/)
        return true
      })
      assert.deepEqual(executor.hostCalls, [])
      assert.equal(snapshots, 0)
      assert.deepEqual(await listGenerations(db.db), [])
      assert.equal(await readFile(tenantTarget, 'utf8'), 'protected-tenant-original')
      assert.equal(await readFile(reviewedTarget, 'utf8'), 'protected-host-original')
    } finally {
      await state.close()
      await db.close()
      await rm(fixture, { recursive: true, force: true })
    }
  })
})
