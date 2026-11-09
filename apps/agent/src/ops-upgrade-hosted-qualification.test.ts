import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { XpanelError } from '@xpanel/core'
const seams = vi.hoisted(() => ({
  settle: vi.fn(), openFailures: [] as unknown[], owned: vi.fn(), shared: vi.fn(), current: vi.fn(), dbClose: vi.fn(), dbOpen: vi.fn(), heldClose: vi.fn(), heldCurrent: vi.fn(), open: vi.fn(),
  normal: vi.fn(), recovery: vi.fn(), closedHeld: vi.fn(), dispatchHeld: vi.fn(), procClose: vi.fn(), procCurrent: vi.fn(),
  account: { id: '11111111-1111-4111-8111-111111111111', username: 'alice', uid: 1001, gid: 1001, home: '/home/alice', primaryDomain: 'alice.example.test', status: 'active' },
  empty: false, observedUid: 1001, currentChecksum: 'd'.repeat(64), activeChecksum: 'd'.repeat(64), dbActive: false,
  request: { phase: 'apply', kind: 'recover', operationId: '33333333-3333-4333-8333-333333333333', expectedArchiveSha256: 'e'.repeat(64), nonce: '44444444-4444-4444-8444-444444444444' },
}))
const snapshot = (checksum: string) => ({ checksum, accounts: seams.empty ? [] : [seams.account], domains: [{ accountId: seams.account.id, kind: 'primary', name: seams.account.primaryDomain,
  siteType: 'php', php: { handler: 'fpm', version: '8.3' }, suspended: false, expiresAt: null }] })
const activeSource = () => ({ generation: { id: 3, status: 'active', checksum: 'c'.repeat(64) }, snapshot: snapshot(seams.activeChecksum), sourceChecksum: seams.activeChecksum })
const observed = () => ({ pid: 42, parentPid: 41, startTime: '123', state: 'S', uids: [seams.observedUid, seams.observedUid, seams.observedUid, seams.observedUid],
  gids: [1001, 1001, 1001, 1001], cgroup: '/xpanel.slice/xpanel-1001.slice/xpanel-php-fpm-alice-8.3.service' })
vi.mock('../../../scripts/coordinator-ownership.mjs', () => ({
  coordinatorOwnershipInfo: () => ({ receiptSha256: 'a'.repeat(64), helper: { archiveSha256: 'e'.repeat(64) } }),
  assertCoordinatorOwnershipCurrent: seams.owned,
  withVisibleCoordinatorOwnership: async (_capability: unknown, work: () => unknown) => work(),
}))
vi.mock('../../../scripts/lifecycle-root-safety.mjs', () => ({ assertNativeLifecyclePrerequisites: seams.normal,
  assertNativeClosedDatabaseRecoveryScopeHeld: seams.closedHeld,
  withNativeLifecycleRecoveryObservation: async (work: (scope: unknown) => unknown) => { await seams.recovery(); return work({ signal: AbortSignal.timeout(60000), assertCurrent: seams.current, activeGenerationSource: async () => activeSource() }) },
}))
vi.mock('./ops-upgrade-root-dispatch.ts', () => ({ assertNativeRootOperatorDispatchHeld: seams.dispatchHeld,
  getNativeRootOperatorDispatchInfo: () => ({ request: seams.request, coordinatorReceiptSha256: 'a'.repeat(64) }),
}))
vi.mock('../../../scripts/lifecycle-admission.mjs', () => ({ withLifecycleWriterAdmission: (run: () => unknown) => run(), assertLifecycleWriterAdmissionHeld: seams.shared, currentLifecycleWriterAdmission: () => ({}), withVisibleLifecycleWriterAdmission: async (_capability: unknown, work: () => unknown) => work() }))
vi.mock('../../../scripts/lifecycle-ownership.mjs', () => ({
  withTrustedFile: (_path: string, _options: unknown, callback: (pin: unknown) => unknown) => callback({ bytes: Buffer.from('xpanel:x:992:992:xPanel:/var/lib/xpanel:/usr/sbin/nologin\n'), fd: 40, verify: vi.fn() }),
  readTrustedFile: async () => ({ bytes: Buffer.from('ID=ubuntu\nVERSION_ID=24.04\n') }),
}))
vi.mock('../../../scripts/install-finalization-native.mjs', () => ({ withInstallFinalizationStateDirectories: (_uid: number, _gid: number, callback: (pin: unknown) => unknown) => callback({ verify: vi.fn() }) }))
vi.mock('node:fs/promises', () => ({ realpath: async (path: string) => path, lstat: async () => ({ dev: 1n, ino: 2n, uid: 992n, gid: 992n,
  mode: 0o100660n, nlink: 1n, isFile: () => true, isSymbolicLink: () => false }) }))
vi.mock('node:timers/promises', () => ({ setTimeout: seams.settle }))
vi.mock('node:child_process', () => ({ spawn: () => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() })
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from('Id=xpanel-php-fpm-alice-8.3.service\nUser=alice\nGroup=alice\nMainPID=41\nControlGroup=/xpanel.slice/xpanel-1001.slice/xpanel-php-fpm-alice-8.3.service\nActiveState=active\n'))
    child.emit('close', 0, null)
  })
  return child
} }))
vi.mock('@xpanel/db', () => ({
  latestActive: async () => ({ id: 3, status: 'active', checksum: 'c'.repeat(64) }),
  getReadonlyOperationDatabaseOrigin: () => ({ file: '/var/lib/xpanel/control.db', device: '1', inode: '2', issuerId: '22222222-2222-4222-8222-222222222222' }),
  assertReadonlyOperationDatabaseCurrent: async () => { if (!seams.dbActive) throw new Error('reader retired') },
  withReadonlyOperationDatabase: async (path: string, callback: (db: unknown) => unknown) => {
    seams.dbOpen(path); seams.dbActive = true
    try { return await callback({ query: vi.fn() }) } finally { seams.dbActive = false; seams.dbClose() }
  },
  withReobservedReadonlyOperationDatabase: async (path: string, callback: (db: unknown) => unknown) => {
    seams.dbOpen(path); seams.dbActive = true
    try { return await callback({ query: vi.fn() }) } finally { seams.dbActive = false; seams.dbClose() }
  },
  withVisibleReadonlyOperationDatabase: async (_db: unknown, work: () => unknown) => work(),
}))
vi.mock('@xpanel/state', () => ({ StateStore: class {
  withReadonlyObservation(callback: (observation: unknown) => unknown) { return callback({ authority: { revision: 7 }, assertCurrent: seams.current, snapshot: snapshot(seams.currentChecksum) }) }
} }))
vi.mock('./reconciler-journal.ts', () => ({ ReconcilerJournal: class { readManifest() { return { generationId: 3, filesChecksum: 'c'.repeat(64), stateChecksum: seams.activeChecksum } } } }))
vi.mock('./peer-identity.ts', () => ({ loadInstalledPeerIdentityAddon: async () => Object.fromEntries(['openListener','acceptPeer','verifyListenerSocket','closeListener','closeFd','getSocketPeerCred','getUnixSocketPeer'].map(name => [name, vi.fn()])) }))
vi.mock('./account-provisioning-observer.ts', () => ({ assertProvisioningProcessBinding: vi.fn(), unitIdentityShowArgv: (unit: string) => ['/usr/bin/systemctl', 'show', '--', unit],
  openNativeProvisioningProcess: async () => ({ read: async () => 'kernel fixture', assertCurrent: seams.procCurrent, close: seams.procClose }), parseProvisioningProcessFiles: () => observed(),
}))
vi.mock('./account-provisioning-http.ts', () => ({ createNativeHeldAccountHttp: () => ({ assertAvailable: vi.fn(), open: async (input: { binding: string; challenge: string }) => {
  seams.open(input)
  const failure = seams.openFailures.shift()
  if (failure) throw failure
  return { requestBinding: input.binding, challenge: input.challenge, status: 200, pid: 42, unit: 'xpanel-php-fpm-alice-8.3.service', mainPid: 41,
    observedProcess: observed(), close: seams.heldClose, assertCurrent: seams.heldCurrent }
} }) }))
import { withReadonlyOperationDatabase, type ReadonlyOperationDatabase } from '@xpanel/db'
import { withNativeHostedUidQualification, withNativeRootOperatorHostedUidQualification, createNativeClosedRecoveryHostedUidQualification,
  assertNativeHostedUidQualificationCurrent, consumeNativeHostedUidQualification, retireNativeHostedUidQualification } from './ops-upgrade-hosted-qualification.ts'
import type { CoordinatorOwnershipCapability } from '../../../scripts/coordinator-ownership.mjs'
import type { NativeRootOperatorDispatch } from './ops-upgrade-root-dispatch.ts'
import { rootOperatorServerRefusal } from './ops-upgrade-operator-refusal.ts'
const capability = {} as CoordinatorOwnershipCapability, dispatch = {} as NativeRootOperatorDispatch
const closedScope = () => ({ signal: AbortSignal.timeout(60000), assertCurrent: seams.current, activeGenerationSource: async () => activeSource(),
  withReadonlyDatabase: <T>(work: (db: ReadonlyOperationDatabase) => Promise<T>) => withReadonlyOperationDatabase('/var/lib/xpanel/control.db', work) })
beforeEach(() => {
  vi.clearAllMocks(); seams.owned.mockReset(); seams.shared.mockReset(); seams.current.mockReset(); seams.closedHeld.mockReset(); seams.dispatchHeld.mockReset();
  seams.settle.mockImplementation(async () => undefined); seams.openFailures = []
  seams.empty = false; seams.observedUid = 1001; seams.currentChecksum = 'd'.repeat(64); seams.activeChecksum = 'd'.repeat(64); seams.dbActive = false
})
afterEach(() => vi.restoreAllMocks())

// Synthetic protocol/resource-ordering tests only; no Linux UID, physical EX/SH or installed source acceptance.
describe('fixed native hosted UID composition', () => {
  it('refuses an unissued ownership or missing physical SH before opening the canonical reader', async () => {
    seams.owned.mockRejectedValueOnce(new Error('unissued'))
    await expect(withNativeHostedUidQualification(capability, { kind: 'hello', nonce: randomUUID() }, async () => true)).rejects.toThrow('unissued')
    seams.shared.mockRejectedValueOnce(new Error('physical SH required'))
    await expect(withNativeHostedUidQualification(capability, { kind: 'hello', nonce: randomUUID() }, async () => true)).rejects.toThrow('physical SH required')
    expect(seams.normal).toHaveBeenCalledExactlyOnceWith(capability)
    expect(seams.dbOpen).not.toHaveBeenCalled(); expect(seams.open).not.toHaveBeenCalled()
  })
  it('does not fabricate hosted UID on an empty host and retires the read-only connection', async () => {
    seams.empty = true
    await expect(withNativeHostedUidQualification(capability, { kind: 'hello', nonce: randomUUID() }, async () => true)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    // The live path opens short readers (origin, then generation) and closes every one before refusing.
    expect(seams.dbOpen).toHaveBeenCalledWith('/var/lib/xpanel/control.db'); expect(seams.dbClose).toHaveBeenCalledTimes(seams.dbOpen.mock.calls.length)
    expect(seams.dbActive).toBe(false); expect(seams.open).not.toHaveBeenCalled()
  })
  it('binds each nonce to a producer call and closes HTTP and SQLite before returning proof', async () => {
    const run = () => withNativeHostedUidQualification(capability, { kind: 'hello', nonce: randomUUID() }, async proof => {
      expect(seams.heldClose).toHaveBeenCalled(); expect(seams.dbActive).toBe(false); return proof
    })
    const first = await run(), second = await run()
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/); expect(first.digest).not.toBe(second.digest)
    // Every short live reader opened for the two observations is closed again; none stays open past a proof.
    expect(seams.open).toHaveBeenCalledTimes(2); expect(seams.dbClose).toHaveBeenCalledTimes(seams.dbOpen.mock.calls.length); expect(seams.dbActive).toBe(false)
  })
  it('rejects wrong worker UID and releases held HTTP', async () => {
    seams.observedUid = 1002
    const callback = vi.fn()
    await expect(withNativeHostedUidQualification(capability, { kind: 'hello', nonce: randomUUID() }, callback)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(callback).not.toHaveBeenCalled(); expect(seams.heldClose).toHaveBeenCalledOnce()
  })
  it('uses authenticated active generation source during recovery when desired state differs', async () => {
    seams.currentChecksum = 'f'.repeat(64)
    await withNativeRootOperatorHostedUidQualification(capability, { phase: 'observe', kind: 'recover', operationId: randomUUID(), expectedArchiveSha256: 'e'.repeat(64), nonce: randomUUID() }, async proof => proof)
    expect(seams.recovery).toHaveBeenCalledOnce(); expect(seams.normal).not.toHaveBeenCalled(); expect(seams.shared).not.toHaveBeenCalled()
    expect(seams.open).toHaveBeenCalledWith(expect.objectContaining({ sourceChecksum: 'd'.repeat(64) }))
  })
  it('requires native dispatch and closed scope proof before opening observation resources', async () => {
    seams.closedHeld.mockRejectedValueOnce(new Error('unissued native EX'))
    await expect(createNativeClosedRecoveryHostedUidQualification(capability, dispatch, closedScope() as never)).rejects.toThrow('unissued native EX')
    expect(seams.dbOpen).not.toHaveBeenCalled()
  })
  it('transfers only a live proc lease after HTTP/SQLite close and consumes it once before RW', async () => {
    const proof = await createNativeClosedRecoveryHostedUidQualification(capability, dispatch, closedScope() as never)
    expect(seams.dbActive).toBe(false); expect(seams.heldClose).toHaveBeenCalledOnce(); expect(seams.procClose).not.toHaveBeenCalled()
    for (const fake of [{ ...proof }, new Proxy(proof, {}), JSON.parse(JSON.stringify(proof))]) await expect(assertNativeHostedUidQualificationCurrent(fake, dispatch)).rejects.toThrow()
    await expect(assertNativeHostedUidQualificationCurrent(proof, {})).rejects.toThrow()
    const result = await consumeNativeHostedUidQualification(proof, dispatch)
    expect(result.digest).toBe(proof.digest); expect(seams.procClose).toHaveBeenCalledOnce()
    await expect(consumeNativeHostedUidQualification(proof, dispatch)).rejects.toThrow()
    await retireNativeHostedUidQualification(proof); expect(seams.procClose).toHaveBeenCalledOnce()
  })
  it('rejects expired or changed worker proof and still permits cleanup after lost authority', async () => {
    const proof = await createNativeClosedRecoveryHostedUidQualification(capability, dispatch, closedScope() as never)
    seams.procCurrent.mockRejectedValueOnce(new Error('worker changed'))
    await expect(assertNativeHostedUidQualificationCurrent(proof, dispatch)).rejects.toThrow('worker changed')
    const future = performance.now() + 60001; vi.spyOn(performance, 'now').mockReturnValue(future)
    await expect(consumeNativeHostedUidQualification(proof, dispatch)).rejects.toThrow()
    await retireNativeHostedUidQualification(proof); expect(seams.procClose).toHaveBeenCalledOnce()
  })
})

describe('pre-switch canary across a transport reset', () => {
  const held = (detail: Record<string, unknown>) => new XpanelError('PRECONDITION_FAILED', 'the held account HTTP request did not verify', { verificationRequired: true, reason: 'held_http_correlation_not_verified', ...detail })
  const reset = () => held({ transportReset: true })
  const hello = () => withNativeHostedUidQualification(capability, { kind: 'hello', nonce: randomUUID() }, async proof => proof)
  const opened = () => seams.open.mock.calls.map(([input]) => input as { binding: string; challenge: string })

  it('retries once after the delay, with the same binding and a new challenge', async () => {
    seams.openFailures = [reset()]
    await expect(hello()).resolves.toMatchObject({ digest: expect.stringMatching(/^[a-f0-9]{64}$/) })
    const [first, second] = opened()
    expect(opened()).toHaveLength(2); expect(second!.binding).toBe(first!.binding); expect(second!.challenge).not.toBe(first!.challenge)
    expect(seams.settle).toHaveBeenCalledExactlyOnceWith(5000, undefined, { signal: expect.any(AbortSignal) })
    expect(seams.heldClose).toHaveBeenCalledOnce()
  })
  it('refuses when the retry is reset as well', async () => {
    seams.openFailures = [reset(), reset()]
    await expect(hello()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'held_http_correlation_not_verified' } })
    expect(opened()).toHaveLength(2)
  })
  it.each([[{}], [{ transportReset: false }], [{ reason: 'held_http_release_not_verified' }]])('keeps any other refusal %j without a retry', async detail => {
    const failure = held(detail)
    seams.openFailures = [failure]
    await expect(hello()).rejects.toBe(failure)
    expect(opened()).toHaveLength(1); expect(seams.settle).not.toHaveBeenCalled()
  })
  it('does not retry a plain socket error that never became a verified refusal', async () => {
    const failure = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    seams.openFailures = [failure]
    await expect(hello()).rejects.toBe(failure)
    expect(opened()).toHaveLength(1)
  })
  it('refuses without a second exchange when the observation moved during the delay', async () => {
    seams.openFailures = [reset()]
    seams.settle.mockImplementationOnce(async () => { seams.owned.mockRejectedValueOnce(new Error('ownership changed')) })
    await expect(hello()).rejects.toThrow('ownership changed')
    expect(opened()).toHaveLength(1)
  })
  it('keeps the original refusal when the deadline ends the delay', async () => {
    const failure = reset()
    seams.openFailures = [failure]
    seams.settle.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'))
    await expect(hello()).rejects.toBe(failure)
    expect(opened()).toHaveLength(1)
  })
  it('never retries inside closed recovery, which retains a worker pin', async () => {
    const failure = reset()
    seams.openFailures = [failure]
    await expect(createNativeClosedRecoveryHostedUidQualification(capability, dispatch, closedScope() as never)).rejects.toBe(failure)
    expect(opened()).toHaveLength(1); expect(seams.settle).not.toHaveBeenCalled()
  })
})

describe('each hosted UID refusal names the check that refused', () => {
  const hello = () => withNativeHostedUidQualification(capability, { kind: 'hello', nonce: randomUUID() }, async proof => proof)
  const reasonOf = async (work: Promise<unknown>) => work.then(() => 'NO_REFUSAL', (error: { code?: string; detail?: { reason?: string } }) => `${error.code}:${error.detail?.reason}`)

  it('names an empty host, an unconverged desired state, a foreign worker and a different archive', async () => {
    seams.empty = true
    expect(await reasonOf(hello())).toBe('PRECONDITION_FAILED:no_eligible_account')
    seams.empty = false; seams.currentChecksum = 'f'.repeat(64)
    expect(await reasonOf(hello())).toBe('PRECONDITION_FAILED:desired_state_not_applied')
    seams.currentChecksum = seams.activeChecksum; seams.observedUid = 1002
    expect(await reasonOf(hello())).toBe('PRECONDITION_FAILED:hosted_exchange_mismatch')
    seams.observedUid = 1001
    expect(await reasonOf(withNativeRootOperatorHostedUidQualification(capability, { phase: 'observe', kind: 'upgrade', operationId: randomUUID(),
      expectedArchiveSha256: 'f'.repeat(64), nonce: randomUUID() }, async proof => proof))).toBe('PRECONDITION_FAILED:archive_mismatch')
  })
  it('carries the reason into the root journal line, never into the client frame', async () => {
    seams.currentChecksum = 'f'.repeat(64)
    const refusal = rootOperatorServerRefusal(await hello().catch((error: unknown) => error))
    expect(refusal.journalLine).toBe('xpanel-root-operator-refused code=PRECONDITION_FAILED detail="native hosted UID qualification is unavailable" reason=desired_state_not_applied\n')
    expect(refusal.frame.toString('utf8')).toBe('{"refused":"PRECONDITION_FAILED"}\n')
  })
  it('gives every refusal site its own stable reason', () => {
    const source = readFileSync(new URL('./ops-upgrade-hosted-qualification.ts', import.meta.url), 'utf8')
    const sites = [...source.matchAll(/\brefuse\(([^)]*)\)/g)].map(match => match[1]!).filter(argument => argument !== 'reason: string')
    expect(sites.length).toBeGreaterThan(25)
    const reasons = sites.map(argument => /^'([a-z][a-z0-9_]{0,63})'$/.exec(argument)?.[1])
    expect(reasons.filter(reason => reason === undefined)).toEqual([])
    expect(new Set(reasons).size).toBe(reasons.length)
  })
})
