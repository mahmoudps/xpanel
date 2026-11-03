import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'vitest'
import {
  assertInstallAdoptionState, installAdoptionAccountLifetimeDigest, installAdoptionSubjectDigest,
  installFinalizationSubjectDigest, runPreparedInstallAdoption, runPreparedInstallFinalization,
  INSTALL_FINALIZATION_PATHS as paths,
} from './install-finalization.mjs'
import type { InstallAdoptionAccountLifetime, InstallAdoptionContext, InstallAdoptionPorts, InstallAdoptionState, InstallFinalizationObservation } from './install-finalization.mjs'
import { parseNativeInstallFinalizationRequest, assertInstallFinalizationNativeScope } from './install-finalization-native.mjs'

// In-memory protocol regressions only. These ports cannot establish native readiness or authority.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const bytes = (v: unknown) => JSON.stringify(v) + '\n'
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }) }
const now = '2026-11-03T00:00:00.000Z'
const accounts = (): InstallAdoptionAccountLifetime[] => [1, 2].map(n => ({
  id: id(n), username: `qa${n}`, uid: 20000 + n, gid: 20000 + n, home: `/home/qa${n}`, createdAt: now, primaryDomain: `qa${n}.example.test`, ownerId: null, planId: id(30),
}))

function fixture() {
  const source = { root: '/opt/xpanel' as const, version: '0.1.0', archiveSha256: hash('archive'), manifestSha256: hash('manifest'), dependencyReceiptSha256: hash('dependencies'), controlDbSchemaVersion: 6 }
  const runtime = { nodePath: '/usr/bin/node', nodeVersion: '26.12.1' as const, nodeSha256: hash('node'), systemctlSha256: hash('systemctl'), nginxSha256: hash('nginx') }
  let state: InstallAdoptionState = { revision: 7, checksum: hash('populated desired state'), accounts: accounts() }
  const context: InstallAdoptionContext = { source, runtime, helperIdentity: { version: '0.1.1', archiveSha256: hash('new-helper-archive'), manifestSha256: hash('new-helper-manifest'), dependencyReceiptSha256: hash('new-helper-dependencies'), sourceFilesDigest: hash('new-helper-files') }, database: { file: '/var/lib/xpanel/control.db', device: '1', inode: '2', issuerId: id(10) },
    rootPrincipalId: id(11), state: { revision: state.revision, checksum: state.checksum, accountCount: state.accounts.length, accountLifetimeDigest: installAdoptionAccountLifetimeDigest(state.accounts) }, admissionFingerprint: hash('existing prepared admission') }
  const units = ['xpanel-api.service', 'xpanel-agent.service', 'xpanel-management-tls.service', 'xpanel-management-tls.timer']
  const links = ['/usr/local/bin/xpanel-ctl', '/etc/systemd/system/multi-user.target.wants/xpanel-api.service', '/etc/systemd/system/multi-user.target.wants/xpanel-agent.service', '/etc/systemd/system/timers.target.wants/xpanel-management-tls.timer']
  const files = ['/usr/local/bin/xpanel-ctl', '/opt/xpanel/bin/xpanel-ctl', ...units.map(u => '/etc/systemd/system/' + u), ...links.slice(1), '/etc/nginx/conf.d/xpanel-management.conf', '/etc/nginx/conf.d/xpanel-management-challenge.conf', '/etc/nginx/xpanel-management/ingress-secret.conf'].map((path, i) => ({
    path, kind: links.includes(path) ? 'symlink' : 'file', device: '1', inode: String(i + 100), size: 20,
    mode: links.includes(path) ? 0o777 : path === '/opt/xpanel/bin/xpanel-ctl' ? 0o755 : path.endsWith('ingress-secret.conf') ? 0o600 : 0o644,
    sha256: links.includes(path) ? null : hash(path), target: links.includes(path) ? path === '/usr/local/bin/xpanel-ctl' ? '/opt/xpanel/bin/xpanel-ctl' : '/etc/systemd/system/' + path.split('/').at(-1) : null,
  }))
  const receipt = { schemaVersion: 1, product: 'xpanel', status: 'bootstrap_pending', officialReference: null, lastLifecycleReference: null, createdAt: now, source, runtime, writerProtocol: 'lifecycle-admission-v1', units, files }
  const bootstrap = { schemaVersion: 1, status: 'bootstrap_pending', createdAt: now, version: source.version, releaseRoot: '/opt/xpanel/releases/' + source.version,
    archiveSha256: source.archiveSha256, manifestSha256: source.manifestSha256, dependencyReceiptSha256: source.dependencyReceiptSha256, controlDbSchemaVersion: 6, runtime: { nodePath: runtime.nodePath, nodeSha256: runtime.nodeSha256 } }
  const memory = new Map<string, string>([
    [paths.receipt, bytes(receipt)], [paths.bootstrap, bytes(bootstrap)],
    [paths.head, bytes({ schemaVersion: 1, issuerId: context.database.issuerId, sequence: 0, phase: 'idle', operationId: id(12), reference: null, kind: 'adopt', requestFingerprint: context.admissionFingerprint, updatedAt: now })],
    ['/var/lib/xpanel/state/accounts/qa1/account.json', 'unchanged account record'],
    ['/var/lib/xpanel/state/accounts/qa2/mailboxes.json', 'unchanged mailbox records'],
    ['/home/qa1/public_html/index.php', 'unchanged hosted data'], ['/home/qa2/private.txt', 'unchanged neighbor data'],
  ])
  const events: string[] = []
  let phase = 'idle', subject: string | null = null, completed = false, jobs = 0
  const hooks: { beforeExclusive?(): void; afterRename?(path: string): void; afterBegin?(): void; afterComplete?(): void } = {}
  const observe = (subjectDigest: string): InstallFinalizationObservation => ({ subjectDigest, observedAt: now, expiresAt: '2026-11-03T00:00:20.000Z', mode: 'normal',
    processes: (['api', 'agent'] as const).map((role, i) => ({ role, pid: 100 + i, start: String(100 + i), uid: role === 'api' ? 1000 : 0, executable: runtime.nodePath, cwd: bootstrap.releaseRoot,
      cgroup: '/system.slice/xpanel-' + role + '.service', invocationId: String(i + 1).repeat(32), socketDevice: '1', socketInode: String(i + 1) })),
    ingress: { configSha256: hash('ingress'), certificateSha256: hash('certificate'), audiences: ['xpanel', 'xwhm', 'xmail'] } })
  const ports: InstallAdoptionPorts = {
    clock: { now: () => new Date(now) },
    fs: {
      async readFile(path) { return memory.get(path) ?? null },
      async writeFileExclusive(path, content, mode) {
        assert.equal(phase, 'exclusive'); assert.equal(mode, 0o600)
        assert(Object.values(paths).some(target => path.startsWith(target + '.install-') && path.endsWith('.tmp')))
        if (memory.has(path)) fail('EEXIST')
        events.push('write:' + path); memory.set(path, content)
      },
      async rename(from, to) {
        assert.equal(phase, 'exclusive'); assert(Object.values(paths).includes(to)); assert(memory.has(from))
        memory.set(to, memory.get(from)!); memory.delete(from); events.push('rename:' + to); hooks.afterRename?.(to)
      },
    },
    async syncPath() { assert.equal(phase, 'exclusive') },
    async withSharedAdmission(run) { assert.equal(phase, 'idle'); phase = 'shared'; try { return await run() } finally { phase = 'idle' } },
    async withExclusiveAdmission(run) { assert.equal(phase, 'idle'); hooks.beforeExclusive?.(); phase = 'exclusive'; try { return await run() } finally { phase = 'idle' } },
    async capturePrepared() { assert.equal(phase, 'shared'); return structuredClone(context) },
    async readAdoptionState() { assert(['shared', 'exclusive'].includes(phase)); events.push('census:' + phase); return structuredClone(state) },
    async observeReady(_context, digest) { assert.equal(phase, 'shared'); return observe(digest) },
    async assertCurrent(captured) { assert.equal(phase, 'exclusive'); assert.deepEqual(captured, context) },
    jobs: {
      async begin(input) {
        assert.equal(phase, 'exclusive'); assert.equal(input.kind, 'lifecycle.adopt'); assert.equal(input.rootPrincipalId, context.rootPrincipalId)
        if (subject === null) { jobs++; subject = input.requestFingerprint }
        assert.equal(input.requestFingerprint, subject); hooks.afterBegin?.()
        return { id: id(20), referenceCode: 'XP-JOB-2026-000001', createdAt: now }
      },
      async complete(intent, proof) { assert.equal(intent.subjectDigest, subject); assert.equal(hash(memory.get(paths.receipt)!), proof.receiptSha256); completed = true; hooks.afterComplete?.() },
      async assertComplete(intent, digest) { assert(completed); assert.equal(intent.subjectDigest, subject); assert.equal(digest, subject) },
    },
  }
  return { ports, context, memory, events, hooks, observe, state: () => state, changeState: (next: InstallAdoptionState) => { state = next }, jobs: () => jobs,
    run: () => runPreparedInstallAdoption(ports), read: (path: string) => JSON.parse(memory.get(path)!) }
}

describe('populated prepared-install adoption protocol; no native qualification', () => {
  it('has a deterministic order-independent lifetime digest without mutating its inputs', () => {
    const a = accounts(), before = bytes(a), original = installAdoptionAccountLifetimeDigest(a)
    assert.equal(installAdoptionAccountLifetimeDigest([...a].reverse()), original); assert.equal(bytes(a), before)
    for (const patch of [{ id: id(9) }, { username: 'other', home: '/home/other' }, { uid: 20009, gid: 20009 }, { home: '/home2/qa1' }, { home: '/srv/hosting/qa1' }, { createdAt: '2026-11-03T00:00:01.000Z' }, { primaryDomain: 'other.example.test' }, { ownerId: id(31) }, { planId: id(32) }]) {
      assert.notEqual(installAdoptionAccountLifetimeDigest([{ ...a[0]!, ...patch }, a[1]!]), original)
    }
  })

  it('rejects duplicates, sparse rows, noncanonical identities and extra fields in the allowlisted census', () => {
    const a = accounts()
    for (const value of [[], [a[0], a[0]], new Array(2), [{ ...a[0], uid: 0, gid: 0 }], [{ ...a[0], uid: 999, gid: 999 }], [{ ...a[0], uid: 65534, gid: 65534 }], [{ ...a[0], home: '/home/qa1/../qa2' }], [{ ...a[0], unexpected: 'field' }]]) {
      assert.throws(() => installAdoptionAccountLifetimeDigest(value as InstallAdoptionAccountLifetime[]))
    }
  })

  it('binds the adoption subject to the exact state and prior receipt independently of fresh install', () => {
    const f = fixture(), prior = hash(f.memory.get(paths.receipt)!), subject = installAdoptionSubjectDigest(f.context, prior)
    for (const state of [{ ...f.context.state, revision: 8 }, { ...f.context.state, checksum: hash('other state') }, { ...f.context.state, accountCount: 3 }, { ...f.context.state, accountLifetimeDigest: hash('other lifetimes') }]) {
      assert.notEqual(installAdoptionSubjectDigest({ ...f.context, state }, prior), subject)
    }
    assert.notEqual(installAdoptionSubjectDigest(f.context, hash('other receipt')), subject)
    for (const field of ['version', 'archiveSha256', 'manifestSha256', 'dependencyReceiptSha256', 'sourceFilesDigest'] as const) {
      assert.notEqual(installAdoptionSubjectDigest({ ...f.context, helperIdentity: { ...f.context.helperIdentity, [field]: field === 'version' ? '0.1.2' : hash('other helper') } }, prior), subject)
    }
    assert.throws(() => installFinalizationSubjectDigest(f.context as never, prior), /INSTALL_FINALIZATION_(STATE|CONTEXT)_INVALID/)
    const { helperIdentity: _helper, ...base } = f.context
    const fresh = { ...base, state: { revision: 0, checksum: hash('empty'), accountCount: 0 as const } }
    assert.throws(() => installAdoptionSubjectDigest(fresh as never, prior), /INSTALL_FINALIZATION_(STATE|CONTEXT)_INVALID/)
    assert.match(installFinalizationSubjectDigest(fresh, prior), /^[a-f0-9]{64}$/)
  })

  it('retains the zero-account install gate and refuses an empty adoption context before effects', async () => {
    const f = fixture()
    const fresh = await runPreparedInstallFinalization({ ...f.ports, observeReady: async (_context, digest) => f.observe(digest), assertCurrent: async () => fail('UNEXPECTED_EFFECT') })
    assert.equal(fresh.exitCode, 3); assert.equal(f.jobs(), 0)
    f.ports.capturePrepared = async () => ({ ...f.context, state: { ...f.context.state, accountCount: 0 } })
    const adoption = await f.run(); assert.equal(adoption.code, 'INSTALL_ADOPTION_POPULATED_STATE_REQUIRED'); assert.equal(f.jobs(), 0)
    assert.equal(f.events.filter(e => e.startsWith('write:')).length, 0)
  })

  it('activates only lifecycle metadata without rewriting accounts, hosted data, identities or source receipts', async () => {
    const f = fixture(), state = bytes(f.state()), preserved = [...f.memory].filter(([path]) => !Object.values(paths).includes(path)), receipt = f.read(paths.receipt)
    const outcome = await f.run()
    assert.equal(outcome.exitCode, 0); assert.equal(outcome.details.nativeQualified, false); assert.equal(outcome.details.installReady, false)
    assert.equal(bytes(f.state()), state); for (const [path, data] of preserved) assert.equal(f.memory.get(path), data)
    assert.deepEqual(f.read(paths.receipt), { ...receipt, status: 'active', lastLifecycleReference: 'XP-JOB-2026-000001' })
    assert(f.events.includes('census:shared')); assert(f.events.filter(e => e === 'census:exclusive').length > 1)
    const again = await f.run(); assert.equal(again.exitCode, 0); assert.equal(again.details.changed, false); assert.equal(f.jobs(), 1)
  })

  for (const change of ['revision', 'checksum', 'same-name-new-lifetime', 'removed-account'] as const) {
    it('refuses ' + change + ' after SH retires and before any EX effect', async () => {
      const f = fixture(), original = [...f.memory]
      f.hooks.beforeExclusive = () => {
        const previous = f.state()
        f.changeState(change === 'revision' ? { ...previous, revision: previous.revision + 1 }
          : change === 'checksum' ? { ...previous, checksum: hash('changed quotas or other desired state') }
          : { ...previous, accounts: change === 'removed-account' ? [previous.accounts[0]!] : [{ ...previous.accounts[0]!, id: id(99) }, previous.accounts[1]!] })
      }
      const outcome = await f.run(); assert.equal(outcome.exitCode, 3); assert.equal(outcome.code, 'INSTALL_ADOPTION_STATE_CHANGED')
      assert.deepEqual([...f.memory], original); assert.equal(f.jobs(), 0)
    })
  }

  it('rechecks lifetime state after a durable-job effect and retains uncertainty without publishing', async () => {
    const f = fixture(), receipt = f.memory.get(paths.receipt)
    f.hooks.afterBegin = () => f.changeState({ ...f.state(), checksum: hash('changed after job') })
    const outcome = await f.run(); assert.equal(outcome.exitCode, 6); assert.equal(outcome.code, 'INSTALL_ADOPTION_STATE_CHANGED')
    assert.equal(f.memory.get(paths.receipt), receipt); assert.equal(f.jobs(), 1)
  })

  it('recovers a lost active-receipt reply through the same engine and subject without another job', async () => {
    const f = fixture(), state = bytes(f.state())
    f.hooks.afterRename = path => { if (path === paths.receipt) fail('SIMULATED_LOST_REPLY') }
    assert.equal((await f.run()).exitCode, 6); delete f.hooks.afterRename
    assert.equal((await f.run()).exitCode, 0); assert.equal(f.jobs(), 1); assert.equal(bytes(f.state()), state)
    assert.equal(f.events.filter(e => e === 'rename:' + paths.receipt).length, 1)
  })

  it('preserves retained intent when the account census changes after receipt publication', async () => {
    const f = fixture()
    f.hooks.afterRename = path => { if (path === paths.receipt) fail('SIMULATED_LOST_REPLY') }
    assert.equal((await f.run()).exitCode, 6); delete f.hooks.afterRename
    const before = [...f.memory]; f.changeState({ ...f.state(), checksum: hash('changed after publication') })
    const outcome = await f.run(); assert.equal(outcome.exitCode, 6); assert.equal(outcome.code, 'INSTALL_ADOPTION_STATE_CHANGED')
    assert.deepEqual([...f.memory], before)
  })

  it('does not turn the pure context, state digest or successful fixture into a native capability', async () => {
    const f = fixture(); assertInstallAdoptionState(f.context, f.state())
    assert.equal((await f.run()).exitCode, 0)
    await assert.rejects(assertInstallFinalizationNativeScope(f.context, 'held'), /INSTALL_FINALIZATION_NATIVE_SCOPE_REQUIRED/)
    assert.throws(() => parseNativeInstallFinalizationRequest({ schemaVersion: 1, command: 'adopt', mode: 'apply', json: true, assumeYes: true,
      artifact: { path: '/root/releases/xpanel-0.1.0.tar.gz', expectedArchiveSha256: hash('archive'), keyId: 'archive-key', signingKeyPath: '/etc/xpanel/release-hmac.key' } }), /INSTALL_FINALIZATION_REQUEST_INVALID/)
  })
})
