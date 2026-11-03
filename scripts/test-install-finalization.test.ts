import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'vitest'
import { runPreparedInstallFinalization, inspectInstallFinalizationRecovery, INSTALL_FINALIZATION_PATHS as paths } from './install-finalization.mjs'
import type { InstallFinalizationContext, InstallFinalizationIntent, InstallFinalizationObservation, InstallFinalizationPorts } from './install-finalization.mjs'
import { assertInstallOwnershipCompletionProof } from './install-finalization-native.mjs'

// Isolated in-memory FsPort/ClockPort contracts only. No Linux, services, keys, real paths or authority.
const id = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const bytes = (value: unknown) => JSON.stringify(value) + '\n'
const broken = (code: string): never => { throw Object.assign(new Error('isolated finalization fault'), { code }) }

interface Hooks {
  beforeExclusive?(): void | Promise<void>
  afterCurrent?(): void | Promise<void>
  afterBegin?(): void | Promise<void>
  afterRename?(path: string, count: number): void | Promise<void>
  afterComplete?(): void | Promise<void>
  beforeExclusiveExit?(): void | Promise<void>
}

function fixture() {
  let now = Date.parse('2026-10-30T18:00:00.000Z'), phase: 'idle' | 'shared' | 'exclusive' = 'idle'
  let rootCurrent = true, activeWrites = 0, allocatedJobs = 0, completedJobs = 0
  let job: { id: string; referenceCode: string; createdAt: string; fingerprint: string; complete: boolean } | null = null
  const hooks: Hooks = {}, events: string[] = [], memory = new Map<string, string>(), renames = new Map<string, number>()
  const source = { root: '/opt/xpanel' as const, version: '0.1.0', archiveSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), dependencyReceiptSha256: 'c'.repeat(64), controlDbSchemaVersion: 6 }
  const runtime = { nodePath: '/usr/bin/node', nodeVersion: '26.12.1' as const, nodeSha256: 'd'.repeat(64), systemctlSha256: 'e'.repeat(64), nginxSha256: 'f'.repeat(64) }
  const context: InstallFinalizationContext = { source, runtime, database: { file: '/var/lib/xpanel/control.db', device: '1', inode: '2', issuerId: id('1') }, rootPrincipalId: id('2'), state: { revision: 0, checksum: hash('empty desired state'), accountCount: 0 }, admissionFingerprint: hash('existing native admission fingerprint') }
  const units = ['xpanel-api.service', 'xpanel-agent.service', 'xpanel-management-tls.service', 'xpanel-management-tls.timer']
  const links = ['/usr/local/bin/xpanel-ctl', '/etc/systemd/system/multi-user.target.wants/xpanel-api.service', '/etc/systemd/system/multi-user.target.wants/xpanel-agent.service', '/etc/systemd/system/timers.target.wants/xpanel-management-tls.timer']
  const files = ['/usr/local/bin/xpanel-ctl', '/opt/xpanel/bin/xpanel-ctl', ...units.map(unit => '/etc/systemd/system/' + unit), ...links.slice(1), '/etc/nginx/conf.d/xpanel-management.conf', '/etc/nginx/conf.d/xpanel-management-challenge.conf', '/etc/nginx/xpanel-management/ingress-secret.conf'].map((path, index) => ({
    path, kind: links.includes(path) ? 'symlink' : 'file', device: '1', inode: String(index + 10), size: 100,
    mode: links.includes(path) ? 0o777 : path === '/opt/xpanel/bin/xpanel-ctl' ? 0o755 : path.endsWith('ingress-secret.conf') ? 0o600 : 0o644,
    sha256: links.includes(path) ? null : hash(path), target: links.includes(path) ? path === '/usr/local/bin/xpanel-ctl' ? '/opt/xpanel/bin/xpanel-ctl' : '/etc/systemd/system/' + path.split('/').at(-1) : null,
  }))
  const receipt = { schemaVersion: 1, product: 'xpanel', status: 'bootstrap_pending', officialReference: null, lastLifecycleReference: null, createdAt: new Date(now).toISOString(), source, runtime, writerProtocol: 'lifecycle-admission-v1', units, files }
  const bootstrap = { schemaVersion: 1, status: 'bootstrap_pending', createdAt: receipt.createdAt, version: source.version, releaseRoot: '/opt/xpanel/releases/' + source.version, archiveSha256: source.archiveSha256, manifestSha256: source.manifestSha256, dependencyReceiptSha256: source.dependencyReceiptSha256, controlDbSchemaVersion: 6, runtime: { nodePath: runtime.nodePath, nodeSha256: runtime.nodeSha256 } }
  const head = { schemaVersion: 1, issuerId: context.database.issuerId, sequence: 0, phase: 'idle', operationId: id('3'), reference: null, kind: 'adopt', requestFingerprint: context.admissionFingerprint, updatedAt: receipt.createdAt }
  memory.set(paths.receipt, bytes(receipt)); memory.set(paths.bootstrap, bytes(bootstrap)); memory.set(paths.head, bytes(head))
  const read = (path: string) => { const value = memory.get(path); assert(value !== undefined); return value }
  const readJson = (path: string): Record<string, unknown> => JSON.parse(read(path))
  const observation = (subjectDigest: string): InstallFinalizationObservation => ({
    subjectDigest, observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 20_000).toISOString(), mode: 'normal',
    processes: ['api', 'agent'].map((value, index) => {
      const role: 'api' | 'agent' = value === 'api' ? 'api' : 'agent'
      return { role, pid: 100 + index, start: String(1000 + index), uid: role === 'api' ? 1000 : 0, executable: runtime.nodePath, cwd: bootstrap.releaseRoot, cgroup: '/system.slice/xpanel-' + role + '.service', invocationId: String(index + 1).repeat(32), socketDevice: '1', socketInode: String(index + 100) }
    }),
    ingress: { configSha256: hash('configured ingress'), certificateSha256: hash('served certificate'), audiences: ['xwhm', 'xpanel', 'xmail'] },
  })
  const ports: InstallFinalizationPorts = {
    fs: {
      async readFile(path) { return memory.get(path) ?? null },
      async writeFileExclusive(path, content, mode) {
        assert.equal(phase, 'exclusive'); assert.equal(mode, 0o600)
        assert(path.startsWith('/var/lib/xpanel-lifecycle/') && path.includes('.install-') && path.endsWith('.tmp'))
        if (memory.has(path)) return broken('EEXIST')
        events.push('temporary:' + path.split('/').at(-1)); memory.set(path, content)
      },
      async rename(from, to) {
        assert.equal(phase, 'exclusive'); assert(Object.values(paths).includes(to)); assert(memory.has(from))
        memory.set(to, read(from)); memory.delete(from)
        const count = (renames.get(to) ?? 0) + 1; renames.set(to, count)
        if (to === paths.receipt) activeWrites++
        events.push('rename:' + to.split('/').at(-1))
        await hooks.afterRename?.(to, count)
      },
    },
    clock: { now: () => new Date(now) },
    async syncPath(path) { assert.equal(phase, 'exclusive'); events.push('sync:' + path.split('/').at(-1)) },
    async withSharedAdmission(callback) {
      assert.equal(phase, 'idle'); phase = 'shared'; events.push('shared-enter')
      try { return await callback() } finally { phase = 'idle'; events.push('shared-retired') }
    },
    async withExclusiveAdmission(callback) {
      assert.equal(phase, 'idle'); events.push('exclusive-wait'); await hooks.beforeExclusive?.()
      phase = 'exclusive'; events.push('exclusive-enter')
      try { return await callback() } finally { await hooks.beforeExclusiveExit?.(); phase = 'idle'; events.push('exclusive-retired') }
    },
    async capturePrepared() { assert.equal(phase, 'shared'); events.push('capture'); return structuredClone(context) },
    async observeReady(_context, subjectDigest) { assert.equal(phase, 'shared'); events.push('http-readiness'); return observation(subjectDigest) },
    async assertCurrent(captured, _observation, intent) {
      assert.equal(phase, 'exclusive'); events.push('current')
      if (!rootCurrent) return broken('INSTALL_ROOT_AUTHORIZATION_CHANGED')
      if (JSON.stringify(captured) !== JSON.stringify(context)) return broken('INSTALL_CURRENT_SOURCE_CHANGED')
      if (intent && (!job || job.id !== intent.jobId || job.fingerprint !== intent.subjectDigest)) return broken('INSTALL_JOB_BINDING_CHANGED')
      await hooks.afterCurrent?.()
    },
    jobs: {
      async begin(input) {
        assert.equal(phase, 'exclusive'); assert.equal(input.kind, 'lifecycle.adopt'); assert.equal(input.rootPrincipalId, context.rootPrincipalId)
        events.push('job-intent')
        if (!job) { allocatedJobs++; job = { id: id('4'), referenceCode: 'XP-JOB-2026-000001', createdAt: new Date(now).toISOString(), fingerprint: input.requestFingerprint, complete: false } }
        assert.equal(job.fingerprint, input.requestFingerprint)
        const selected = job
        await hooks.afterBegin?.()
        return { id: selected.id, referenceCode: selected.referenceCode, createdAt: selected.createdAt }
      },
      async complete(intent, proof) {
        assert.equal(phase, 'exclusive'); assert(job && job.id === intent.jobId); assert.equal(hash(read(paths.receipt)), proof.receiptSha256)
        assert.equal(readJson(paths.receipt).status, 'active'); assert.equal(proof.observationDigest, intent.observationDigest)
        if (!job.complete) { completedJobs++; job.complete = true; events.push('job-complete') }
        await hooks.afterComplete?.()
      },
      async assertComplete(intent, subjectDigest) {
        assert.equal(phase, 'exclusive'); assert(job && job.complete && job.id === intent.jobId && job.fingerprint === subjectDigest)
        events.push('job-readback')
      },
    },
  }
  return { ports, hooks, memory, context, events, read, readJson, observation,
    advance: (ms: number) => { now += ms }, revokeRoot: () => { rootCurrent = false }, dropJob: () => { job = null },
    counts: () => ({ activeWrites, allocatedJobs, completedJobs }), run: () => runPreparedInstallFinalization(ports),
    intent: (): InstallFinalizationIntent => { const parsed = readJson(paths.bootstrap).finalization; assert(parsed && typeof parsed === 'object'); return JSON.parse(JSON.stringify(parsed)) },
  }
}

describe('fresh-install finalization protocol; isolated ports are not native authority', () => {
  it('keeps new helper execution evidence outside the unchanged old target context and completion format', async () => {
    const f = fixture(), source = await readFile(new URL('./install-finalization-native.mjs', import.meta.url), 'utf8')
    const begin = source.indexOf('function installFinalizationEvidence('), end = source.indexOf('\nfunction checkJob(', begin)
    assert(begin >= 0 && end > begin)
    const buildEvidence = new Function(source.slice(begin, end) + '\nreturn installFinalizationEvidence')()
    const executionHelper = { version: '0.1.8', archiveSha256: '9'.repeat(64), manifestSha256: '8'.repeat(64),
      dependencyReceiptSha256: '7'.repeat(64), sourceFilesDigest: '6'.repeat(64) }
    let persisted: any
    const complete = f.ports.jobs.complete
    f.ports.jobs.complete = async (intent, proof) => {
      await complete(intent, proof)
      persisted = { detail: { installFinalization: proof }, checkpointData: {
        installFinalization: { subjectDigest: intent.subjectDigest, ...proof },
        installFinalizationEvidence: buildEvidence({ context: f.context, observation: f.observation(intent.subjectDigest), executionHelper }),
      } }
    }
    assert.equal((await f.run()).exitCode, 0)
    const observed = inspectInstallFinalizationRecovery({ bootstrapBytes: f.read(paths.bootstrap), receiptBytes: f.read(paths.receipt), headBytes: f.read(paths.head) })
    assert.equal(observed.intent.phase, 'complete')
    assert.deepEqual(Object.keys(persisted.checkpointData.installFinalizationEvidence.context).sort(),
      ['source', 'runtime', 'database', 'rootPrincipalId', 'state', 'admissionFingerprint'].sort())
    assert.equal(persisted.checkpointData.installFinalizationEvidence.executionHelper.version, '0.1.8')
    assert.equal(observed.receipt.source.version, '0.1.0')
    assert.doesNotThrow(() => assertInstallOwnershipCompletionProof('install', f.intent().subjectDigest, f.intent(), persisted))
    // This reader proves target completion only; helper qualification also needs the actual sealed execution/terminal binding.
  })
  it('retires SH and HTTP before EX, records intent before publication and acknowledges only exact readback', async () => {
    const f = fixture(), outcome = await f.run()
    assert.equal(outcome.exitCode, 0); assert.equal(outcome.outcome, 'committed'); assert.equal(outcome.details.qualified, false)
    assert.equal(f.readJson(paths.receipt).status, 'active'); assert.equal(f.readJson(paths.head).phase, 'retired'); assert.equal(f.intent().phase, 'complete')
    assert.deepEqual(f.counts(), { activeWrites: 1, allocatedJobs: 1, completedJobs: 1 })
    assert(f.events.indexOf('http-readiness') < f.events.indexOf('shared-retired'))
    assert(f.events.indexOf('shared-retired') < f.events.indexOf('exclusive-enter'))
    assert(f.events.indexOf('job-intent') < f.events.indexOf('rename:installation.json'))
    assert(f.events.indexOf('rename:installation.json') < f.events.indexOf('job-complete'))
    assert.equal(f.events.at(-1), 'exclusive-retired')
  })

  it('refuses a root revocation while waiting for EX before any job or active write', async () => {
    const f = fixture(), before = f.read(paths.receipt); f.hooks.beforeExclusive = () => f.revokeRoot()
    const outcome = await f.run()
    assert.equal(outcome.exitCode, 3); assert.equal(outcome.code, 'INSTALL_ROOT_AUTHORIZATION_CHANGED'); assert.equal(outcome.details.changed, false)
    assert.equal(f.read(paths.receipt), before); assert.deepEqual(f.counts(), { activeWrites: 0, allocatedJobs: 0, completedJobs: 0 })
  })

  it('rejects changed current source after the queue instead of publishing the captured source', async () => {
    const f = fixture(), before = f.read(paths.receipt)
    f.hooks.beforeExclusive = () => { f.memory.set(paths.head, bytes({ ...f.readJson(paths.head), issuerId: id('9') })) }
    const outcome = await f.run()
    assert.equal(outcome.exitCode, 3); assert.equal(outcome.code, 'INSTALL_FINALIZATION_HEAD_CHANGED'); assert.equal(f.read(paths.receipt), before)
    assert.equal(f.counts().activeWrites, 0); assert.equal(f.counts().allocatedJobs, 0)
  })

  it('checks the final clock after an awaited guard before the first job or publication', async () => {
    const f = fixture(); f.hooks.afterCurrent = () => { f.advance(20_001); delete f.hooks.afterCurrent }
    const outcome = await f.run()
    assert.equal(outcome.exitCode, 3); assert.equal(outcome.code, 'INSTALL_FINALIZATION_OBSERVATION_EXPIRED')
    assert.deepEqual(f.counts(), { activeWrites: 0, allocatedJobs: 0, completedJobs: 0 })
  })

  it('does not accept an active receipt without its protected finalization intent', async () => {
    const f = fixture(); f.memory.set(paths.receipt, bytes({ ...f.readJson(paths.receipt), status: 'active' }))
    const before = f.read(paths.receipt), outcome = await f.run()
    assert.equal(outcome.exitCode, 3); assert.equal(f.read(paths.receipt), before); assert.equal(f.counts().allocatedJobs, 0)
  })

  it('refuses a populated installation instead of silently broadening fresh finalization to adopt', async () => {
    const f = fixture()
    f.ports.capturePrepared = async () => ({ ...structuredClone(f.context), state: { ...f.context.state, accountCount: 1 } })
    const outcome = await f.run(); assert.equal(outcome.code, 'INSTALL_FINALIZATION_FRESH_INSTALL_REQUIRED'); assert.equal(outcome.exitCode, 3)
    assert.equal(f.counts().allocatedJobs, 0)
  })

  for (const shape of ['quarantined', 'wrong-audience', 'wrong-pid-owner', 'wrong-executable', 'expired']) {
    it('refuses ' + shape + ' observations before metadata effects', async () => {
      const f = fixture(), original = f.ports.observeReady
      f.ports.observeReady = async (context, subject) => {
        await original(context, subject)
        const observed = f.observation(subject)
        if (shape === 'quarantined') return { ...observed, mode: 'quarantined' }
        if (shape === 'wrong-audience') return { ...observed, ingress: { ...observed.ingress, audiences: ['xwhm'] } }
        if (shape === 'expired') return { ...observed, expiresAt: observed.observedAt }
        return { ...observed, processes: observed.processes.map(process => process.role === 'agent'
          ? { ...process, ...(shape === 'wrong-pid-owner' ? { uid: 1000 } : { executable: '/tmp/node' }) } : process) }
      }
      const outcome = await f.run(); assert.equal(outcome.exitCode, 3); assert.equal(f.counts().activeWrites, 0); assert.equal(f.counts().allocatedJobs, 0)
    })
  }

  it('retains a lost durable-intent reply and resumes through the same deduplicated job', async () => {
    const f = fixture(); f.hooks.afterBegin = () => broken('SIMULATED_LOST_JOB_REPLY')
    const first = await f.run(); assert.equal(first.exitCode, 6); assert.equal(first.details.changed, true)
    assert.equal(f.counts().allocatedJobs, 1); assert.equal(f.counts().activeWrites, 0)
    delete f.hooks.afterBegin; f.advance(1)
    const second = await f.run(); assert.equal(second.exitCode, 0); assert.deepEqual(f.counts(), { activeWrites: 1, allocatedJobs: 1, completedJobs: 1 })
  })

  const windows = [
    { name: 'intent checkpoint', path: paths.bootstrap, count: 1 },
    { name: 'pending HEAD', path: paths.head, count: 1 },
    { name: 'verified checkpoint', path: paths.bootstrap, count: 2 },
    { name: 'active receipt rename', path: paths.receipt, count: 1 },
    { name: 'publication checkpoint', path: paths.bootstrap, count: 3 },
    { name: 'retired HEAD', path: paths.head, count: 2 },
    { name: 'completed bootstrap', path: paths.bootstrap, count: 4 },
  ]
  for (const window of windows) {
    it('reobserves after a lost reply at ' + window.name + ' without repeating active publication', async () => {
      const f = fixture()
      f.hooks.afterRename = (path, count) => { if (path === window.path && count === window.count) broken('SIMULATED_CRASH_AFTER_WRITE') }
      const first = await f.run(); assert.equal(first.exitCode, 6); assert.equal(first.outcome, 'attention')
      delete f.hooks.afterRename; f.advance(1)
      const second = await f.run(); assert.equal(second.exitCode, 0)
      assert.deepEqual(f.counts(), { activeWrites: 1, allocatedJobs: 1, completedJobs: 1 })
      assert.equal(f.intent().phase, 'complete'); assert.equal(f.readJson(paths.head).phase, 'retired')
    })
  }

  it('resumes acknowledgement after a lost successful database reply without replaying receipt publication', async () => {
    const f = fixture(); f.hooks.afterComplete = () => broken('SIMULATED_LOST_ACK')
    const first = await f.run(); assert.equal(first.exitCode, 6); assert.equal(f.counts().completedJobs, 1)
    delete f.hooks.afterComplete; f.advance(1)
    assert.equal((await f.run()).exitCode, 0); assert.deepEqual(f.counts(), { activeWrites: 1, allocatedJobs: 1, completedJobs: 1 })
  })

  it('preserves an independently changed post-publication receipt and refuses automatic replay', async () => {
    const f = fixture(); f.hooks.afterRename = path => { if (path === paths.receipt) { f.memory.set(paths.receipt, f.read(paths.receipt) + ' '); broken('SIMULATED_FOREIGN_RECEIPT') } }
    assert.equal((await f.run()).exitCode, 6); const changed = f.read(paths.receipt)
    delete f.hooks.afterRename; f.advance(1)
    const retry = await f.run(); assert.equal(retry.exitCode, 6); assert.equal(retry.code, 'INSTALL_FINALIZATION_RECEIPT_CHANGED')
    assert.equal(f.read(paths.receipt), changed); assert.equal(f.counts().activeWrites, 1); assert.equal(f.counts().completedJobs, 0)
  })

  it('requires fresh reobservation after authority expires during active publication', async () => {
    const f = fixture(); f.hooks.afterRename = path => { if (path === paths.receipt) f.advance(20_001) }
    const first = await f.run(); assert.equal(first.exitCode, 6); assert.equal(first.code, 'INSTALL_FINALIZATION_OBSERVATION_EXPIRED')
    assert.equal(f.readJson(paths.receipt).status, 'active'); assert.equal(f.counts().completedJobs, 0)
    delete f.hooks.afterRename; assert.equal((await f.run()).exitCode, 0); assert.equal(f.counts().activeWrites, 1)
  })

  it('treats FD/admission cleanup failure as attention and leaves actual successful publication intact', async () => {
    const f = fixture(); f.hooks.beforeExclusiveExit = () => broken('SIMULATED_FD_RETIREMENT_FAILURE')
    const first = await f.run(); assert.equal(first.exitCode, 6); assert.equal(first.details.changed, true)
    assert.equal(f.readJson(paths.receipt).status, 'active'); assert.equal(f.counts().completedJobs, 1)
    // The isolated wrapper's failure does not prove a real FD is retired; operator recovery is required.
  })

  it('reobserves an already completed same-intent retry without duplicating jobs, references or active writes', async () => {
    const f = fixture(); assert.equal((await f.run()).exitCode, 0); const original = f.read(paths.receipt)
    f.advance(1); const second = await f.run()
    assert.equal(second.exitCode, 0); assert.equal(second.details.changed, false); assert.equal(second.details.officialReference, 'XP-JOB-2026-000001')
    assert.equal(f.read(paths.receipt), original); assert.deepEqual(f.counts(), { activeWrites: 1, allocatedJobs: 1, completedJobs: 1 })
  })

  it('does not infer success from active/complete files when the actual canonical job acknowledgement is absent', async () => {
    const f = fixture(); assert.equal((await f.run()).exitCode, 0); f.dropJob(); f.advance(1)
    const second = await f.run(); assert.equal(second.exitCode, 6); assert.equal(second.details.changed, false); assert.equal(f.counts().activeWrites, 1)
  })

  it('validates completed bootstrap recovery against the exact receipt and HEAD bytes', async () => {
    const f = fixture(); assert.equal((await f.run()).exitCode, 0)
    const raw = { bootstrapBytes: f.read(paths.bootstrap), receiptBytes: f.read(paths.receipt), headBytes: f.read(paths.head) }
    const observed = inspectInstallFinalizationRecovery(raw)
    assert.equal(observed.intent.phase, 'complete'); assert.equal(observed.receipt.status, 'active')
    assert.equal(observed.head.operationId, observed.intent.jobId)
    assert.throws(() => inspectInstallFinalizationRecovery({ ...raw, receiptBytes: raw.receiptBytes + ' ' }))
    assert.equal(f.read(paths.receipt), raw.receiptBytes)
  })

  it('admits a retained first-intent checkpoint without inventing an active receipt', async () => {
    const f = fixture()
    f.hooks.afterRename = (path, count) => { if (path === paths.bootstrap && count === 1) broken('SIMULATED_INTENT_STOP') }
    assert.equal((await f.run()).exitCode, 6)
    const observed = inspectInstallFinalizationRecovery({ bootstrapBytes: f.read(paths.bootstrap), receiptBytes: f.read(paths.receipt), headBytes: f.read(paths.head) })
    assert.equal(observed.intent.phase, 'intent'); assert.equal(observed.receipt.status, 'bootstrap_pending')
    assert.equal(observed.head.phase, 'idle'); assert.equal(f.counts().activeWrites, 0)
  })

  it('refuses a foreign operation HEAD without modifying the retained completed records', async () => {
    const f = fixture(); assert.equal((await f.run()).exitCode, 0)
    const bootstrapBytes = f.read(paths.bootstrap), receiptBytes = f.read(paths.receipt), headBytes = f.read(paths.head)
    const head = { ...JSON.parse(headBytes), operationId: id('9') }
    assert.throws(() => inspectInstallFinalizationRecovery({ bootstrapBytes, receiptBytes, headBytes: bytes(head) }))
    assert.equal(f.read(paths.bootstrap), bootstrapBytes); assert.equal(f.read(paths.receipt), receiptBytes)
  })
})
