import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { assertAgentPrivateStateMigrationScope, parseAgentPrivateStateMigrationArgs } from './agent-private-state-migration.mjs'
import { assertAgentPrivateStateMigrationExclusivePhysicalHeld, withAgentPrivateStateMigrationExclusiveAdmission } from './lifecycle-admission.mjs'

// Executes the production finite protocol with isolated storage/effect ports.
// These cases grant no native authority and do not touch a host or a database.
const source = await readFile(new URL('./agent-private-state-migration.mjs', import.meta.url), 'utf8')
const section = (from: string, to: string) => {
  const start = source.indexOf(from), end = source.indexOf(to, start)
  assert(start >= 0 && end > start)
  return source.slice(start, end)
}
const canonical = (value: unknown) => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const sha = (raw: string | Buffer) => createHash('sha256').update(raw).digest('hex')
const TARGET = '/var/lib/xpanel-agent', INTENT = '/var/lib/xpanel-lifecycle/agent-private-state-v1.intent.json'
const COMPLETE = '/var/lib/xpanel-lifecycle/agent-private-state-v1.complete.json'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const check = (value: unknown, code = 'AGENT_PRIVATE_STATE_UNCONFIRMED') => { if (!value) throw Object.assign(new Error(code), { code }) }

function harness(crash: 'intent' | 'chmod' | 'before-completion' | 'after-completion' | 'final-capture' | null = null) {
  let ordinal = 0, chmodCalls = 0, captureCalls = 0, crashRemaining = crash, bindingChanged = false
  const records = new Map<string, { value: any; sha256: string }>()
  const binding = { metadataSha256: { bootstrap: 'a'.repeat(64) }, state: 'b'.repeat(64),
    bootId: 'synthetic-boot', runtime: { nodePath: '/opt/node-v26.12.1/bin/node' } }
  const node: any = { dev: 1n, ino: 2n, uid: 0n, gid: 0n, mode: 0o40755n, nlink: 2n, size: 4096n, mtimeNs: 10n, ctimeNs: 10n }
  const original = { ...node }
  const directoryIdentity = (value: any) => Object.fromEntries(['dev', 'ino', 'uid', 'gid', 'nlink', 'size', 'mtimeNs'].map(key => [key, String(value[key])]))
  const metadata = (value: any) => Object.fromEntries(['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(value[key])]))
  const target = { original, async verify() { return { ...node } }, async unchanged(mode: number) {
    check(canonical(directoryIdentity(node)) === canonical(directoryIdentity(original)) && (node.mode & 0o7777n) === BigInt(mode), 'AGENT_PRIVATE_STATE_DIRECTORY_CHANGED')
    return { ...node }
  }, handle: { async chmod(mode: number) { chmodCalls++; node.mode = 0o40000n | BigInt(mode); node.ctimeNs++
    if (crashRemaining === 'chmod') { crashRemaining = null; throw new Error('simulated lost chmod acknowledgement') }
  }, async sync() {} } }
  const implementation = section('function validateIntent(', '\nexport async function runAgentPrivateStateMigration(')
  const api = new Function('capture', 'check', 'same', 'directoryIdentity', 'metadata', 'canonical', 'sha', 'UUID', 'TARGET', 'INTENT', 'COMPLETE',
    'optional', 'writeNew', 'randomUUID', 'readdir', 'LIFE', implementation + '\nreturn { migrate, validateIntent }')(
      async () => { captureCalls++; if (captureCalls === 4 && crashRemaining === 'final-capture') { crashRemaining = null; throw new Error('simulated final capture failure') }
        return bindingChanged ? { changed: true } : structuredClone(binding) }, check,
      (a: unknown, b: unknown) => canonical(a) === canonical(b), directoryIdentity, metadata, canonical, sha, UUID, TARGET, INTENT, COMPLETE,
      async (path: string) => records.get(path) ?? null,
      async (path: string, value: any, scope: any) => {
        check(!records.has(path), 'EXISTING_RECORD')
        if (path === COMPLETE && crashRemaining === 'before-completion') { crashRemaining = null; throw new Error('simulated completion interruption') }
        const raw = JSON.stringify(value) + '\n', record = { value: structuredClone(value), sha256: sha(raw) }
        records.set(path, record); scope.recordAttempted = true
        if (path === INTENT && crashRemaining === 'intent' || path === COMPLETE && crashRemaining === 'after-completion') {
          crashRemaining = null; throw new Error('simulated lost record acknowledgement')
        }
        return record.sha256
      }, () => '12345678-1234-4234-8234-' + String(++ordinal).padStart(12, '0'),
      async () => [...records.keys()].map(path => path.split('/').at(-1)), '/var/lib/xpanel-lifecycle')
  const run = async (mode: string, pid = 99) => {
    const scope = { mode, binding: structuredClone(binding), identity: { pid, start: '100', bootId: 'synthetic-boot', executable: binding.runtime.nodePath }, effectAttempted: false, recordAttempted: false }
    return api.migrate(scope, target)
  }
  return { run, records, node, target, get chmodCalls() { return chmodCalls }, get captureCalls() { return captureCalls },
    changeBinding() { bindingChanged = true } }
}

describe('agent private state migration syntax and opaque ingress', () => {
  const argv = ['--mode=apply', '--artifact=/root/releases/new.tar.gz', '--archive-sha256=' + 'a'.repeat(64)]
  it('accepts only fixed operation modes and prepared-release grammar', () => {
    expect(parseAgentPrivateStateMigrationArgs(argv).mode).toBe('apply')
    for (const bad of [[...argv, '--path=/tmp'], ['--mode=chmod', ...argv.slice(1)], [argv[0], '--artifact=/tmp/new.tar.gz', argv[2]],
      [argv[0], argv[1], '--archive-sha256=bad'], [argv[0], '--artifact=/root/../root/new.tar.gz', argv[2]]]) {
      expect(() => parseAgentPrivateStateMigrationArgs(bad)).toThrow()
    }
  })
  it('rejects copied or forged capabilities before an EX callback or native IO', async () => {
    let calls = 0
    for (const value of [null, {}, { root: true, phase: 'held' }]) {
      await expect(assertAgentPrivateStateMigrationScope(value, 'held')).rejects.toMatchObject({ code: 'AGENT_PRIVATE_STATE_NATIVE_SCOPE_REQUIRED' })
      await expect(withAgentPrivateStateMigrationExclusiveAdmission(value, async () => { calls++ })).rejects.toMatchObject({ code: 'AGENT_PRIVATE_STATE_NATIVE_SCOPE_REQUIRED' })
      await expect(assertAgentPrivateStateMigrationExclusivePhysicalHeld(value)).rejects.toMatchObject({ code: 'AGENT_PRIVATE_STATE_EXCLUSIVE_REQUIRED' })
    }
    expect(calls).toBe(0)
  })
})

describe('finite migration protocol with isolated effect/storage ports', () => {
  it('persists intent before exactly one narrowing and a bound completion', async () => {
    const h = harness(), result = await h.run('apply')
    expect(result.status).toBe('effect_verified'); expect(result.changed).toBe(true)
    expect(result.archiveScopeRetired).toBe(false)
    expect(h.chmodCalls).toBe(1); expect(h.node.mode & 0o7777n).toBe(0o700n)
    expect(h.records.get(COMPLETE)!.value.intentSha256).toBe(h.records.get(INTENT)!.sha256)
    expect(result.sqlAuditVerified).toBe(false); expect(result.installationFinalized).toBe(false)
    expect(result.releaseUpgraded).toBe(false); expect(result.nativeCapabilityAcceptance).toBe(false)
  })
  it('observes legacy mode without creating records or attempting a change', async () => {
    const h = harness(), result = await h.run('observe')
    expect(result.status).toBe('legacy_pending'); expect(h.records.size).toBe(0); expect(h.chmodCalls).toBe(0)
  })
  it('does not replay apply after any retained execution', async () => {
    const h = harness(); await h.run('apply')
    await expect(h.run('apply')).rejects.toMatchObject({ code: 'AGENT_PRIVATE_STATE_EXISTING_EXECUTION_REQUIRES_OBSERVATION' })
    expect(h.chmodCalls).toBe(1)
    expect((await h.run('observe')).status).toBe('effect_observed_retirement_unconfirmed')
  })
  it('requires an original intent for recover and preserves an already private directory', async () => {
    const h = harness(); h.node.mode = 0o40700n
    expect((await h.run('apply')).status).toBe('already_private'); expect(h.records.size).toBe(0)
    await expect(h.run('recover')).rejects.toMatchObject({ code: 'AGENT_PRIVATE_STATE_RECOVERY_INTENT_REQUIRED' })
    expect(h.chmodCalls).toBe(0)
  })
  it('recovers explicit interrupted boundaries without rewriting the original intent', async () => {
    for (const crash of ['intent', 'chmod', 'before-completion', 'after-completion', 'final-capture'] as const) {
      const h = harness(crash)
      await expect(h.run('apply')).rejects.toThrow('simulated')
      const original = structuredClone(h.records.get(INTENT))
      const result = await h.run('recover')
      expect(result.status, crash).toBe('effect_verified'); expect(h.chmodCalls, crash).toBe(1)
      expect(result.targetChanged, crash).toBe(crash === 'intent')
      expect(result.journalWritten, crash).toBe(true)
      expect(h.records.get(INTENT), crash).toEqual(original)
      expect(h.records.get(COMPLETE)!.value.intentSha256, crash).toBe(original!.sha256)
    }
  })
  it('never acknowledges a prior execution merely because its effect checkpoint exists', async () => {
    const h = harness('final-capture'); await expect(h.run('apply')).rejects.toThrow('simulated')
    expect(h.records.has(COMPLETE)).toBe(true)
    const result = await h.run('observe')
    expect(result.status).toBe('effect_observed_retirement_unconfirmed')
    expect(result.archiveScopeRetired).toBe(false); expect(h.chmodCalls).toBe(1)
  })
  it('retains the original PID as history while a different recovery process verifies the same boot and source', async () => {
    const h = harness('chmod'); await expect(h.run('apply', 99)).rejects.toThrow('simulated')
    const result = await h.run('recover', 100)
    expect(result.status).toBe('effect_verified'); expect(h.chmodCalls).toBe(1)
    expect(h.records.get(INTENT)!.value.execution.pid).toBe(99)
    const recovered = [...h.records.values()].find(value => value.value.kind === 'xpanel-agent-private-state-recovery')
    expect(recovered!.value.execution.pid).toBe(100)
  })
  it('refuses excess recovery claims before another record or directory effect, including a retained completion', async () => {
    for (const completed of [false, true]) {
      const h = harness(completed ? null : 'intent')
      if (completed) await h.run('apply')
      else await expect(h.run('apply')).rejects.toThrow('simulated')
      for (let index = 0; index < 16; index++) h.records.set('/var/lib/xpanel-lifecycle/agent-private-state-v1.recovery-'
        + '12345678-1234-4234-8234-' + String(index).padStart(12, '0') + '.json', { value: {}, sha256: 'c'.repeat(64) })
      const size = h.records.size, effects = h.chmodCalls
      await expect(h.run('recover')).rejects.toMatchObject({ code: 'AGENT_PRIVATE_STATE_RECOVERY_CAPACITY' })
      expect(h.records.size).toBe(size); expect(h.chmodCalls).toBe(effects)
    }
  })
  it('does not credit a completed record after metadata or source identity changes', async () => {
    const h = harness(); await h.run('apply'); h.node.ctimeNs++
    await expect(h.run('observe')).rejects.toMatchObject({ code: 'AGENT_PRIVATE_STATE_COMPLETION_CHANGED' })
    const changed = harness(); changed.changeBinding()
    await expect(changed.run('apply')).rejects.toMatchObject({ code: 'AGENT_PRIVATE_STATE_CAPTURE_CHANGED' })
    expect(changed.records.size).toBe(0); expect(changed.chmodCalls).toBe(0)
  })
  it('refuses an unrelated or damaged retained intent before narrowing', async () => {
    const h = harness('intent'); await expect(h.run('apply')).rejects.toThrow()
    h.records.get(INTENT)!.value.preimage.identity.ino = '999'
    await expect(h.run('recover')).rejects.toMatchObject({ code: 'AGENT_PRIVATE_STATE_INTENT_CHANGED' })
    expect(h.chmodCalls).toBe(0)
  })
})

describe('prepared archive retirement reporting with isolated entry ports', () => {
  it('keeps an uncertain outer archive retirement as attention after a native result', async () => {
    const entry = (await readFile(new URL('./agent-private-state-migration-entry.mjs', import.meta.url), 'utf8')).replace(/^import .+\n/gm, '')
    let output = '', code = 0
    const fakeProcess = { argv: ['node', 'entry'], stdout: { write(value: string) { output += value } }, get exitCode() { return code }, set exitCode(value: number) { code = value } }
    const execute = new Function('withExistingPreparedRelease', 'parseAgentPrivateStateMigrationArgs', 'runAgentPrivateStateMigration', 'process',
      'return (async()=>{' + entry + '})()')
    await execute(async (_input: unknown, callback: (value: unknown) => Promise<unknown>) => {
      await callback({}); throw Object.assign(new Error('retirement changed'), { code: 'ARCHIVE_USE_UNCERTAIN' })
    }, () => ({ artifact: {} }), async () => ({ status: 'verified_complete' }), fakeProcess)
    expect(code).toBe(6); expect(JSON.parse(output).status).toBe('attention')
    expect(JSON.parse(output).changed).toBe(null); expect(JSON.parse(output).preserveRetainedRecords).toBe(true)
  })
})

describe('retained target directory checks with isolated filesystem ports', () => {
  function targetFixture() {
    const initial = { dev: 1n, ino: 2n, uid: 0n, gid: 0n, mode: 0o40755n, nlink: 2n, size: 4096n, mtimeNs: 10n, ctimeNs: 10n, link: false }
    let opened = { ...initial }, named = { ...initial }, closes = 0
    const stat = (value: typeof initial) => ({ ...value, isDirectory: () => !value.link, isSymbolicLink: () => value.link })
    const implementation = section('async function pinTarget()', '\nfunction validateIntent(')
    const identity = (value: any) => Object.fromEntries(['dev', 'ino', 'uid', 'gid', 'nlink', 'size', 'mtimeNs'].map(key => [key, String(value[key])]))
    const metadata = (value: any) => Object.fromEntries(['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(value[key])]))
    const run = new Function('open', 'lstat', 'TARGET', 'constants', 'check', 'same', 'metadata', 'directoryIdentity', implementation + '\nreturn pinTarget')(
      async () => ({ stat: async () => stat(opened), close: async () => { closes++ } }), async () => stat(named), TARGET,
      { O_RDONLY: 0, O_DIRECTORY: 1, O_NOFOLLOW: 2 }, check, (a: unknown, b: unknown) => canonical(a) === canonical(b), metadata, identity)
    return { run, change(a: Partial<typeof initial>, b = a) { opened = { ...opened, ...a }; named = { ...named, ...b } }, get closes() { return closes } }
  }
  it('rejects foreign ownership, symbolic names and unrecognized permissions before returning an FD', async () => {
    for (const change of [{ uid: 1000n }, { gid: 1000n }, { mode: 0o40777n }, { link: true }]) {
      const h = targetFixture(); h.change(change)
      await expect(h.run()).rejects.toMatchObject({ code: 'AGENT_PRIVATE_STATE_DIRECTORY_UNSAFE' })
      expect(h.closes).toBe(1)
    }
  })
  it('refuses named replacement and directory-content metadata drift through the held FD', async () => {
    const h = targetFixture(), pin = await h.run()
    h.change({}, { ino: 99n })
    await expect(pin.unchanged(0o755)).rejects.toMatchObject({ code: 'AGENT_PRIVATE_STATE_DIRECTORY_UNSAFE' })
    await pin.handle.close(); expect(h.closes).toBe(1)
    const changed = targetFixture(), next = await changed.run(); changed.change({ mtimeNs: 99n })
    await expect(next.unchanged(0o755)).rejects.toMatchObject({ code: 'AGENT_PRIVATE_STATE_DIRECTORY_CHANGED' })
    await next.handle.close()
  })
})

function captureFixture() {
  const events: string[] = [], docs = new Map<string, Buffer>(), absentPaths = new Set<string>()
  const LIFE = '/var/lib/xpanel-lifecycle', DATABASE = '/var/lib/xpanel/control.db', nodePath = '/opt/node-v26.12.1/bin/node'
  const origin = { file: DATABASE, device: '1', inode: '2', issuerId: '12345678-1234-4234-8234-123456789abc' }
  const runtime = { nodePath, nodeSha256: sha('node'), nodeVersion: '26.12.1', systemctlSha256: 'c'.repeat(64), nginxSha256: 'd'.repeat(64) }
  const sourceIdentity = { root: '/opt/xpanel', version: '0.1.1', archiveSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), dependencyReceiptSha256: 'e'.repeat(64), controlDbSchemaVersion: 1 }
  const bootstrap = { schemaVersion: 1, status: 'bootstrap_pending', createdAt: '2026-11-03T00:00:00.000Z', version: sourceIdentity.version,
    releaseRoot: '/opt/xpanel/releases/0.1.1', archiveSha256: sourceIdentity.archiveSha256, manifestSha256: sourceIdentity.manifestSha256,
    dependencyReceiptSha256: sourceIdentity.dependencyReceiptSha256, controlDbSchemaVersion: 1, runtime: { nodePath, nodeSha256: runtime.nodeSha256 } }
  const receipt = { status: 'bootstrap_pending', source: sourceIdentity, runtime, lastLifecycleReference: null, files: [] }
  const head = { schemaVersion: 1, issuerId: origin.issuerId, sequence: 0, phase: 'idle', kind: 'adopt', reference: null,
    operationId: '12345678-1234-4234-8234-123456789abd', updatedAt: '2026-11-03T00:00:00.000Z',
    requestFingerprint: sha(JSON.stringify({ source: bootstrap.archiveSha256, manifest: bootstrap.manifestSha256, origin })) }
  const helper = { archiveSha256: 'f'.repeat(64), manifestSha256: '1'.repeat(64), releaseRoot: '/opt/xpanel/releases/0.1.8' }
  const acquisition = { schemaVersion: 1, kind: 'xpanel-prepared-release-intent', archiveSha256: helper.archiveSha256,
    manifestSha256: helper.manifestSha256, releaseRoot: helper.releaseRoot, installedArchiveSha256: sourceIdentity.archiveSha256 }
  const root: any = { id: '12345678-1234-4234-8234-123456789abe', kind: 'root', username: 'root', disabled: false, forcePasswordChange: false, passwordHash: 'synthetic-private-marker' }
  const snapshot: any = { revision: 1, checksum: '2'.repeat(64), accounts: [] }
  const scope: any = { live: true, phase: 'capturing', prepared: {}, capability: {}, helper, helperIdentity: { archiveSha256: helper.archiveSha256 }, identity: { bootId: 'synthetic-boot' } }
  let stateChanged = false, participantsChanged = false
  const refresh = () => {
    for (const [name, value] of [['bootstrap.json', bootstrap], ['installation.json', receipt], ['HEAD', head]] as const) docs.set(LIFE + '/' + name, Buffer.from(JSON.stringify(value) + '\n'))
    docs.set(LIFE + '/prepared/' + helper.archiveSha256 + '/intent.json', Buffer.from(JSON.stringify(acquisition)))
  }
  refresh(); docs.set(nodePath, Buffer.from('node')); docs.set('/etc/machine-id', Buffer.from('synthetic-machine-id'))
  const reader = { async query() { return [{ id: root.id }] } }
  const db = {
    async withReadonlyOperationDatabase(_path: string, callback: (value: unknown) => Promise<void>) { events.push('readonly-db'); await callback(reader) },
    getReadonlyOperationDatabaseOrigin() { return { ...origin } }, async getPrincipal() { return { ...root } }, async assertReadonlyOperationDatabaseCurrent() {},
  }
  const state = { StateStore: class { async withReadonlyObservation(callback: (value: any) => Promise<void>) {
    events.push('readonly-state'); await callback({ snapshot, async assertCurrent() { check(!stateChanged, 'STATE_CHANGED') } })
  } } }
  const readTrustedFile = async (path: string, options: any) => {
    const bytes = docs.get(path); check(bytes, 'UNEXPECTED_PATH'); const digest = sha(bytes!)
    if (options.sha256 !== undefined) check(digest === options.sha256, 'TRUSTED_FILE_HASH_DRIFT')
    return { bytes, sha256: digest, info: { dev: 1n, ino: 5n } }
  }
  const implementation = section('async function capture(scope)', '\nasync function pinTarget(')
    .replace("await import('../packages/db/src/index.ts')", 'fixtureDb').replace("await import('../packages/state/src/index.ts')", 'fixtureState')
  const run = new Function('assertScope', 'assertLifecycleWriterAdmissionHeld', 'assertAgentPrivateStateMigrationExclusivePhysicalHeld',
    'observePreparedAdoptionSource', 'readInstallationReceipt', 'readTrustedFile', 'LIFE', 'DATABASE', 'parse', 'check', 'same', 'sha', 'canonical', 'UUID',
    'absent', 'assertOwnedFile', 'fixtureDb', 'fixtureState', 'lstat', 'normalParticipants', 'lifetime', implementation + '\nreturn capture')(
      async () => { events.push('source-current') }, async () => { events.push('SH-current') }, async () => { events.push('EX-current') },
      async () => ({ bootstrap: structuredClone(bootstrap) }), async () => ({ receipt: structuredClone(receipt), sha256: sha(docs.get(LIFE + '/installation.json')!) }),
      readTrustedFile, LIFE, DATABASE, (raw: Buffer) => JSON.parse(raw.toString()), check, (a: unknown, b: unknown) => canonical(a) === canonical(b), sha, canonical, UUID,
      async (path: string) => check(!absentPaths.has(path), 'AGENT_PRIVATE_STATE_RETAINED_ATTENTION'), async () => {}, db, state,
      async () => ({ dev: 1n, ino: 2n, uid: 999n, gid: 988n, nlink: 1n, mode: 0o660n, isFile: () => true, isSymbolicLink: () => false }),
      async () => { check(!participantsChanged, 'AGENT_PRIVATE_STATE_PARTICIPANT_CHANGED'); return [{ role: 'api', pid: 500 }, { role: 'agent', pid: 501 }] },
      (account: unknown) => account)
  return { run: () => run(scope), events, receipt, bootstrap, head, root, origin, acquisition, snapshot, refresh,
    barrier() { absentPaths.add(LIFE + '/writer-barrier.json') }, changeState() { stateChanged = true }, changeParticipants() { participantsChanged = true } }
}

describe('native capture orchestration with isolated readonly/source ports', () => {
  it('keeps identity, database and state reads free of credential material in the binding', async () => {
    const h = captureFixture(), result = await h.run()
    expect(result.databaseState.state.accountCount).toBe(0)
    expect(JSON.stringify(result)).not.toContain('synthetic-private-marker')
    expect(JSON.stringify(result)).not.toContain('passwordHash')
    expect(h.events).toContain('SH-current'); expect(h.events).toContain('readonly-db')
  })
  it('refuses active metadata, retained intent, changed HEAD and a mismatched acquisition source', async () => {
    for (const mutate of [(h: ReturnType<typeof captureFixture>) => { h.bootstrap.status = 'active' },
      (h: ReturnType<typeof captureFixture>) => { (h.bootstrap as any).finalization = {} },
      (h: ReturnType<typeof captureFixture>) => { h.head.sequence = 1 },
      (h: ReturnType<typeof captureFixture>) => { h.acquisition.installedArchiveSha256 = '9'.repeat(64) }]) {
      const h = captureFixture(); mutate(h); h.refresh()
      await expect(h.run()).rejects.toThrow()
      expect(h.events).not.toContain('readonly-state')
    }
  })
  it('refuses root enrollment, a barrier, origin drift and changing state or participants', async () => {
    for (const mutate of [(h: ReturnType<typeof captureFixture>) => { h.root.forcePasswordChange = true },
      (h: ReturnType<typeof captureFixture>) => { h.barrier() },
      (h: ReturnType<typeof captureFixture>) => { h.origin.inode = '999' },
      (h: ReturnType<typeof captureFixture>) => { h.changeState() },
      (h: ReturnType<typeof captureFixture>) => { h.changeParticipants() }]) {
      const h = captureFixture(); mutate(h)
      await expect(h.run()).rejects.toThrow()
    }
  })
  it('preserves the count of populated pending accounts without invoking adoption', async () => {
    const h = captureFixture(); h.snapshot.accounts = [{ id: 'synthetic-account', username: 'qa1' }]
    const result = await h.run()
    expect(result.databaseState.state.accountCount).toBe(1)
    expect(result.databaseState.state.accountLifetimeDigest).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe('reciprocal admission conflicts with isolated branded and kernel ports', () => {
  async function admissionFixture() {
    const text = await readFile(new URL('./lifecycle-admission.mjs', import.meta.url), 'utf8')
    const cut = (from: string, to: string) => {
      const begin = text.indexOf(from), end = text.indexOf(to, begin)
      assert(begin >= 0 && end > begin)
      return text.slice(begin, end)
    }
    const program = [
      cut('async function admittedWriter(', '/** Tracks full admission retirement'),
      cut('export async function withLifecycleRecoveryObservationAdmission(', 'export async function assertLifecycleRecoveryObservationAdmissionHeld('),
      cut('export async function withLifecycleExclusiveAdmission(', '/** Initial native admission'),
      cut('export async function withLifecycleBootstrapExclusiveAdmission(', 'export async function assertLifecycleBootstrapExclusivePhysicalHeld('),
      cut('export async function withInstallFinalizationExclusiveAdmission(', 'export async function assertInstallFinalizationExclusivePhysicalHeld('),
      cut('export async function withAgentPrivateStateMigrationExclusiveAdmission(', 'export async function assertAgentPrivateStateMigrationExclusivePhysicalHeld('),
    ].join('\n').replace(/^export /gm, '').replace(/await import\('\.\/(?:lifecycle-root-safety|install-finalization-native|agent-private-state-migration)\.mjs'\)/g, 'nativeModel')
    let kernelCalls = 0, depth = 0
    const ports: Record<string, any> = { activeWriters: 0, LIFECYCLE_LOCK: 'isolated-existing-lock',
      fail: (code: string) => check(false, code), lstat: async () => ({}), assertLifecycleWritesAllowed: async () => {},
      assertLifecycleExclusivePhysicalHeld: async () => {}, assertLifecycleBootstrapExclusivePhysicalHeld: async () => {},
      nativeModel: { assertLifecycleRootSafetyHeld: async () => {}, assertLifecycleBootstrapHeld: async () => {},
        assertLifecycleRecoveryObservationHeld: async () => {}, assertInstallFinalizationNativeScope: async () => {}, assertAgentPrivateStateMigrationScope: async () => {} },
      async withKernelLock(_exclusive: boolean, callback: (value: unknown) => Promise<unknown>) {
        kernelCalls++; check(depth === 0, 'ISOLATED_NESTED_KERNEL_ATTEMPT'); depth++
        try { return await callback({ fd: 3, verify: async () => {} }) } finally { depth-- }
      },
    }
    for (const key of ['writerScope', 'exclusiveScope', 'bootstrapExclusiveScope', 'recoveryObservationScope', 'installExclusiveScope', 'agentPrivateExclusiveScope']) ports[key] = new AsyncLocalStorage()
    for (const key of ['exclusives', 'bootstrapExclusives', 'installExclusives', 'agentPrivateExclusives']) ports[key] = new WeakMap()
    const api = new Function('ports', 'with(ports){' + program + '\nreturn { admittedWriter, withLifecycleRecoveryObservationAdmission, withLifecycleExclusiveAdmission, withLifecycleBootstrapExclusiveAdmission, withInstallFinalizationExclusiveAdmission, withAgentPrivateStateMigrationExclusiveAdmission }}')(ports)
    return { api, ports, get kernelCalls() { return kernelCalls } }
  }
  it('prevents all existing admission ingresses from nesting in migration EX', async () => {
    const h = await admissionFixture(), capability = {}
    await h.api.withAgentPrivateStateMigrationExclusiveAdmission(capability, async () => {
      const noCallback = async () => { throw new Error('nested callback executed') }
      await expect(h.api.admittedWriter(noCallback)).rejects.toMatchObject({ code: 'AGENT_PRIVATE_STATE_NESTED_WRITER' })
      for (const name of ['withLifecycleRecoveryObservationAdmission', 'withLifecycleExclusiveAdmission', 'withLifecycleBootstrapExclusiveAdmission', 'withInstallFinalizationExclusiveAdmission']) {
        await expect(h.api[name]({}, noCallback)).rejects.toMatchObject({ code: 'LIFECYCLE_SCOPE_CONFLICT' })
      }
    })
    expect(h.kernelCalls).toBe(1)
    expect(h.ports.agentPrivateExclusives.has(capability)).toBe(false)
  })
  it('rejects migration EX from each existing active admission before kernel acquisition', async () => {
    const h = await admissionFixture()
    for (const key of ['writerScope', 'exclusiveScope', 'bootstrapExclusiveScope', 'recoveryObservationScope', 'installExclusiveScope', 'agentPrivateExclusiveScope']) {
      await h.ports[key].run({ active: true }, async () => {
        await expect(h.api.withAgentPrivateStateMigrationExclusiveAdmission({}, async () => { throw new Error('nested callback executed') }))
          .rejects.toMatchObject({ code: 'LIFECYCLE_SCOPE_CONFLICT' })
      })
    }
    expect(h.kernelCalls).toBe(0)
  })
})

describe('uncertain prior execution classification with isolated factory ports', () => {
  it('keeps capture failure and malformed retained evidence as attention before any known-effect flag', async () => {
    const implementation = source.slice(source.indexOf('export async function runAgentPrivateStateMigration('))
      .replace('export async function', 'async function').replace('fileURLToPath(import.meta.url)', 'modulePath')
    for (const boundary of ['capture', 'retained']) {
      const helperRoot = '/opt/xpanel/releases/0.1.8', node = '/opt/node-v26.12.1/bin/node'
      const request = { mode: 'apply', artifact: { artifactPath: '/root/release.tar.gz', expectedArchiveSha256: 'a'.repeat(64) } }
      const helper = { releaseRoot: helperRoot, runtime: { nodePath: node }, artifactPath: request.artifact.artifactPath,
        version: '0.1.8', archiveSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), dependencyReceiptSha256: 'c'.repeat(64), sourceFilesDigest: 'd'.repeat(64) }
      const models = new WeakMap(), active = new AsyncLocalStorage()
      let capturedScope: any, closed = 0
      const run = new Function('processIdentity', 'assertPreparedReleaseCurrent', 'preparedReleaseInfo', 'parseAgentPrivateStateMigrationArgs',
        'process', 'same', 'check', 'realpath', 'modulePath', 'scopes', 'current', 'withTrustedDirectory', 'withLifecycleWriterAdmission', 'LIFE',
        'capture', 'withAgentPrivateStateMigrationExclusiveAdmission', 'assertAgentPrivateStateMigrationExclusivePhysicalHeld', 'pinTarget', 'migrate',
        implementation + '\nreturn runAgentPrivateStateMigration')(
          async () => ({ pid: 99, start: '100', executable: node, bootId: 'synthetic-boot' }), async () => {}, () => helper, () => request,
          { argv: [node, helperRoot + '/scripts/agent-private-state-migration-entry.mjs'], execPath: node },
          (a: unknown, b: unknown) => canonical(a) === canonical(b), check, async (path: string) => path,
          helperRoot + '/scripts/agent-private-state-migration.mjs', models, active,
          async (_path: string, callback: (value: unknown) => Promise<unknown>) => callback({ verify: async () => {} }),
          async (callback: () => Promise<unknown>) => callback(), '/var/lib/xpanel-lifecycle', async (scope: unknown) => {
            capturedScope = scope
            if (boundary === 'capture') throw Object.assign(new Error('current observation failed'), { code: 'CURRENT_CAPTURE_FAILED' })
            return {}
          }, async (_capability: unknown, callback: () => Promise<unknown>) => callback(), async () => {},
          async () => ({ handle: { close: async () => { closed++ } } }),
          async () => { throw new SyntaxError('malformed retained record') })
      const result = await run({}, request)
      expect(result.status, boundary).toBe('attention'); expect(result.changed, boundary).toBe(null)
      expect(result.previousEffectsUnknown, boundary).toBe(true)
      expect(result.nativeCapabilityAcceptance, boundary).toBe(false)
      expect(capturedScope.retainedIntent, boundary).toBeUndefined()
      expect(capturedScope.live, boundary).toBe(false)
      expect(models.has(capturedScope.capability), boundary).toBe(false)
      expect(closed, boundary).toBe(boundary === 'retained' ? 1 : 0)
    }
  })
})
