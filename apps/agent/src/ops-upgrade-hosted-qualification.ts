import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { fail, type Account, type Domain } from '@xpanel/core'
import { latestActive, withReadonlyOperationDatabase, getReadonlyOperationDatabaseOrigin, assertReadonlyOperationDatabaseCurrent, type ReadonlyOperationDatabase } from '@xpanel/db'
import { StateStore, type StateSnapshot } from '@xpanel/state'
import { detectOs } from '@xpanel/os'
import { system } from '@xpanel/render'
import { assertNativeLifecyclePrerequisites, withNativeLifecycleRecoveryObservation, assertNativeClosedDatabaseRecoveryScopeHeld } from '../../../scripts/lifecycle-root-safety.mjs'
import { withLifecycleWriterAdmission, assertLifecycleWriterAdmissionHeld } from '../../../scripts/lifecycle-admission.mjs'
import { readTrustedFile, withTrustedFile } from '../../../scripts/lifecycle-ownership.mjs'
import { withInstallFinalizationStateDirectories } from '../../../scripts/install-finalization-native.mjs'
import { assertCoordinatorOwnershipCurrent, coordinatorOwnershipInfo, type CoordinatorOwnershipCapability } from '../../../scripts/coordinator-ownership.mjs'
import { createNativeHeldAccountHttp } from './account-provisioning-http.ts'
import { assertProvisioningProcessBinding, unitIdentityShowArgv, openNativeProvisioningProcess, parseProvisioningProcessFiles, type ProvisioningProcessIdentity } from './account-provisioning-observer.ts'
import { loadInstalledPeerIdentityAddon, type NativePeerIdentityAddon } from './peer-identity.ts'
import { ReconcilerJournal } from './reconciler-journal.ts'
import { parseUpgradeIpcRequest, type UpgradeIpcRequest } from './ops-upgrade-ipc.ts'
import { parseRootOperatorRequest, type RootOperatorRequest } from './ops-upgrade-operator-protocol.ts'
import { assertNativeRootOperatorDispatchHeld, getNativeRootOperatorDispatchInfo, type NativeRootOperatorDispatch } from './ops-upgrade-root-dispatch.ts'
import type { AgentExecutor } from './executor.ts'
import type { HostEffectAuthority } from './host-effect-authority.ts'

const refuse = (): never => fail('PRECONDITION_FAILED', 'native hosted UID qualification is unavailable', { stateChanged: false })
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const DATABASE = '/var/lib/xpanel/control.db'
const STATE = '/var/lib/xpanel/state'
const STATE_PROPERTIES = ['Id', 'LoadState', 'ActiveState', 'SubState', 'ActiveEnterTimestampMonotonic', 'MemoryCurrent', 'CPUUsageNSec', 'NRestarts']
const eligibleAccounts = (accounts: readonly Account[], domains: readonly Domain[]): Account[] => accounts.filter(account => {
  const primary = domains.filter(domain => domain.accountId === account.id && domain.kind === 'primary' && domain.name === account.primaryDomain)
  const domain = primary[0]
  return account.status === 'active' && account.bandwidthLimitedMonth === undefined && primary.length === 1 && domain !== undefined
    && domain.siteType === 'php' && domain.php.handler === 'fpm' && !domain.suspended
    && (domain.expiresAt === null || Date.parse(domain.expiresAt) > Date.now())
}).sort((a, b) => a.id.localeCompare(b.id))
const lifetime = (account: Account) => ({ id: account.id, username: account.username, uid: account.uid, gid: account.gid,
  home: account.home, createdAt: account.createdAt, primaryDomain: account.primaryDomain, ownerId: account.ownerId, planId: account.planId })
export interface HostedUidQualification { readonly digest: string; readonly observedAt: string }
interface ActiveGenerationSource { generation: { id: number; status: 'active'; checksum: string }; snapshot: StateSnapshot; sourceChecksum: string }
interface ObservationAuthority { assertCurrent(): Promise<void>; signal: AbortSignal; activeGenerationSource?(): Promise<ActiveGenerationSource> }
interface ClosedRecoveryScope extends ObservationAuthority {
  withReadonlyDatabase<T>(callback: (db: ReadonlyOperationDatabase) => Promise<T>): Promise<T>
  activeGenerationSource(): Promise<ActiveGenerationSource>
}
type NativeProcessPin = Awaited<ReturnType<typeof openNativeProvisioningProcess>>
interface Capture { proof: HostedUidQualification; observedMonotonic: number; account: Account; unit: string; mainPid: number; observed: ProvisioningProcessIdentity; process?: NativeProcessPin }
const processIdentity = (value: ProvisioningProcessIdentity) => ({ pid: value.pid, parentPid: value.parentPid, startTime: value.startTime,
  uids: value.uids, gids: value.gids, cgroup: value.cgroup })
async function readPinnedProcess(pin: NativeProcessPin, expected: ProvisioningProcessIdentity, account: Account, unit: string, mainPid: number) {
  await pin.assertCurrent()
  const [stat, status, cgroup] = await Promise.all([pin.read('stat'), pin.read('status'), pin.read('cgroup')])
  const value = parseProvisioningProcessFiles(expected.pid, { stat, status, cgroup })
  assertProvisioningProcessBinding(value, account, unit, mainPid)
  if (JSON.stringify(processIdentity(value)) !== JSON.stringify(processIdentity(expected))) return refuse()
  await pin.assertCurrent()
}

/** Finite read-only systemctl grammar. No caller command, executable path, shell or host-effect port. */
function readonlyExecutor(tool: { fd: number; verify(): Promise<void> }, guard: () => Promise<void>, fpmUnit: string): AgentExecutor {
  return {
    preflight: async () => refuse(), writeFile: async () => refuse(), readFile: async () => refuse(), removePath: async () => refuse(),
    runTest: async () => refuse(), runAction: async () => refuse(), readSliceMetrics: async () => refuse(),
    async runCommand(argv) {
      const unit = argv.at(-1)
      if (!unit || !['nginx.service', fpmUnit].includes(unit)) return refuse()
      const state = ['/usr/bin/systemctl', 'show', ...STATE_PROPERTIES.flatMap(p => ['-p', p]), '--', unit]
      if (![JSON.stringify(state), JSON.stringify(unitIdentityShowArgv(unit))].includes(JSON.stringify(argv))) return refuse()
      await guard(); await tool.verify()
      const result = await new Promise<{ ok: boolean; code: number; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn('/proc/self/fd/3', argv.slice(1), { env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe', tool.fd] })
        let stdout = '', stderr = '', bytes = 0, failure: Error | undefined
        const timer = setTimeout(() => { failure = new Error('UPGRADE_OBSERVATION_TIMEOUT'); child.kill('SIGKILL') }, 3000)
        const collect = (chunk: Buffer, error: boolean) => { bytes += chunk.length; if (bytes > 65536) { failure = new Error('UPGRADE_OBSERVATION_LIMIT'); child.kill('SIGKILL'); return }; if (error) stderr += chunk.toString('utf8'); else stdout += chunk.toString('utf8') }
        child.stdout?.on('data', (chunk: Buffer) => collect(chunk, false)); child.stderr?.on('data', (chunk: Buffer) => collect(chunk, true))
        child.once('error', error => { failure = error })
        child.once('close', (code, signal) => { clearTimeout(timer); if (failure || code !== 0 || signal) reject(failure ?? new Error('UPGRADE_OBSERVATION_FAILED')); else resolve({ ok: true, code: 0, stdout, stderr }) })
      })
      await tool.verify(); await guard(); return result
    },
  }
}

/** Ordinary observation preserves physical SH and opens only the separately branded live reader. */
export async function withNativeHostedUidQualification<T>(ownership: CoordinatorOwnershipCapability, input: UpgradeIpcRequest,
  callback: (proof: HostedUidQualification) => Promise<T>): Promise<T> {
  const captured = await ordinaryObservation(ownership, parseUpgradeIpcRequest(input), false)
  return callback(captured.proof)
}
export async function withNativeRootOperatorHostedUidQualification<T>(ownership: CoordinatorOwnershipCapability, input: RootOperatorRequest,
  callback: (proof: HostedUidQualification) => Promise<T>): Promise<T> {
  const request = parseRootOperatorRequest(input)
  if (request.expectedArchiveSha256 !== coordinatorOwnershipInfo(ownership).helper.archiveSha256) return refuse()
  const captured = await ordinaryObservation(ownership, request, request.kind === 'recover')
  return callback(captured.proof)
}
async function ordinaryObservation(ownership: CoordinatorOwnershipCapability, request: UpgradeIpcRequest | RootOperatorRequest, recovery: boolean): Promise<Capture> {
  await assertCoordinatorOwnershipCurrent(ownership)
  const work = async (authority: ObservationAuthority) => { await authority.assertCurrent(); return withReadonlyOperationDatabase(DATABASE, db => collectHostedObservation(ownership, request, authority, db, false)) }
  if (recovery) return withNativeLifecycleRecoveryObservation(work)
  await assertNativeLifecyclePrerequisites()
  return withLifecycleWriterAdmission(() => work({ assertCurrent: assertLifecycleWriterAdmissionHeld, signal: AbortSignal.timeout(60000) }))
}

/** All SQL/StateStore/held-HTTP resources close before the returned evidence can be used for native admission. */
async function collectHostedObservation(ownership: CoordinatorOwnershipCapability, request: UpgradeIpcRequest | RootOperatorRequest,
  authority: ObservationAuthority, db: ReadonlyOperationDatabase, retainProcess: boolean): Promise<Capture> {
  const owner = coordinatorOwnershipInfo(ownership)
  await assertCoordinatorOwnershipCurrent(ownership); await authority.assertCurrent()
  let process: NativeProcessPin | undefined
  try {
    return await withTrustedFile('/etc/passwd', { maxBytes: 1024 * 1024 }, async passwd => {
      const accounts = passwd.bytes.toString('utf8').split('\n').filter(line => line.startsWith('xpanel:')).map(line => line.split(':'))
      const uid = Number(accounts[0]?.[2]), gid = Number(accounts[0]?.[3])
      if (accounts.length !== 1 || !Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0) return refuse()
      return withInstallFinalizationStateDirectories(uid, gid, async parent => {
        const origin = getReadonlyOperationDatabaseOrigin(db), store = new StateStore(STATE)
        const originCurrent = async () => {
          await parent.verify(); await passwd.verify(); await assertReadonlyOperationDatabaseCurrent(db)
          const file = await lstat(DATABASE, { bigint: true })
          if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1n || file.uid !== BigInt(uid) || file.gid !== BigInt(gid)
            || (file.mode & 0o7777n) !== 0o660n || String(file.dev) !== origin.device || String(file.ino) !== origin.inode
            || JSON.stringify(getReadonlyOperationDatabaseOrigin(db)) !== JSON.stringify(origin)) return refuse()
        }
        await originCurrent()
        return store.withReadonlyObservation(async observation => {
          const currentSnapshot = observation.snapshot
          const retained = authority.activeGenerationSource ? await authority.activeGenerationSource() : undefined
          const source = retained?.snapshot ?? currentSnapshot, sourceChecksum = retained?.sourceChecksum ?? currentSnapshot.checksum
          const generation = retained?.generation ?? await latestActive(db), journal = new ReconcilerJournal(STATE)
          if (!generation || generation.status !== 'active' || source.checksum !== sourceChecksum) return refuse()
          const currentEligible = eligibleAccounts(currentSnapshot.accounts, currentSnapshot.domains)
          const account = eligibleAccounts(source.accounts, source.domains).find(value => currentEligible.some(current => JSON.stringify(lifetime(current)) === JSON.stringify(lifetime(value)))) ?? refuse()
          const domain = source.domains.find(value => value.accountId === account.id && value.kind === 'primary')!
          const currentDomain = currentSnapshot.domains.find(value => value.accountId === account.id && value.kind === 'primary')!
          const domainDeadline = Math.min(...[domain, currentDomain].map(value => value.expiresAt === null ? Infinity : Date.parse(value.expiresAt)))
          const signal = AbortSignal.any([authority.signal, AbortSignal.timeout(60000)])
          const manifest = await journal.readManifest(generation.id)
          if (!manifest || manifest.generationId !== generation.id || manifest.filesChecksum !== generation.checksum || manifest.stateChecksum !== sourceChecksum) return refuse()
          const retainedIdentity = retained ? digest(retained) : null
          const guard = async () => {
            if (signal.aborted || Date.now() >= domainDeadline) return refuse()
            await assertCoordinatorOwnershipCurrent(ownership); await authority.assertCurrent(); await observation.assertCurrent(); await originCurrent()
            const active = await latestActive(db)
            if (active?.id !== generation.id || active.status !== 'active' || active.checksum !== generation.checksum || signal.aborted) return refuse()
            if (retainedIdentity !== null && (!authority.activeGenerationSource || digest(await authority.activeGenerationSource()) !== retainedIdentity)) return refuse()
            const now = await journal.readManifest(generation.id)
            if (digest(now) !== digest(manifest)) return refuse()
          }
          const loaded = await loadInstalledPeerIdentityAddon()
          for (const method of ['openListener', 'acceptPeer', 'verifyListenerSocket', 'closeListener', 'closeFd', 'getSocketPeerCred', 'getUnixSocketPeer']) {
            if (typeof Reflect.get(loaded, method) !== 'function') return refuse()
          }
          const addon = loaded as NativePeerIdentityAddon
          const osText = (await readTrustedFile(await realpath('/etc/os-release'), { maxBytes: 65536 })).bytes.toString('utf8')
          const os = detectOs(path => path === '/etc/os-release' ? osText : null)
          return withTrustedFile('/usr/bin/systemctl', { sha256: owner.systemctlSha256, maxBytes: 16 * 1024 * 1024 }, async tool => {
            const executor = readonlyExecutor(tool, guard, system.fpmUnitName(account.username, domain.php.version)), context: HostEffectAuthority = { readOnly: true, signal, assertAuthority: guard }
            const exchange = createNativeHeldAccountHttp({ db, store: { listDomains: async () => { await guard(); return source.domains } }, reconciler: { journal }, executor, os, addon })
            const binding = digest({ purpose: 'xpanel-upgrade-pre-admission-hosted-uid-v1', request, coordinatorReceipt: owner.receiptSha256,
              sourceChecksum, currentDesiredChecksum: currentSnapshot.checksum, authority: observation.authority, databaseOrigin: origin, account, generationId: generation.id, filesChecksum: generation.checksum })
            const challenge = randomBytes(32).toString('hex')
            await guard(); await exchange.assertAvailable(account, context); await guard()
            const held = await exchange.open({ account, sourceChecksum, binding, challenge }, context)
            let closed = false
            try {
              await guard(); await held.assertCurrent(); await guard()
              const observed = held.observedProcess
              assertProvisioningProcessBinding(observed, account, held.unit, held.mainPid)
              if (held.requestBinding !== binding || held.challenge !== challenge || held.status !== 200 || held.pid !== observed.pid
                || observed.uids[0] !== account.uid || observed.cgroup.split('/').at(-2) !== system.accountSliceName(account.uid)) return refuse()
              if (retainProcess) { process = await openNativeProvisioningProcess(observed.pid); await readPinnedProcess(process, observed, account, held.unit, held.mainPid) }
              const proof = Object.freeze({ digest: digest({ binding, challenge, observed, unit: held.unit, mainPid: held.mainPid }), observedAt: new Date().toISOString() })
              const observedMonotonic = performance.now()
              await held.close(); closed = true; await guard()
              return { proof, observedMonotonic, account, unit: held.unit, mainPid: held.mainPid, observed, ...(process ? { process } : {}) }
            } finally { if (!closed) await held.close() }
          })
        })
      })
    })
  } catch (error) { await process?.close(); throw error }
}

declare const nativeHostedBrand: unique symbol
export interface NativeHostedUidQualification extends HostedUidQualification { readonly [nativeHostedBrand]: true }
interface QualificationLease {
  active: boolean; consumed: boolean; processClosed: boolean; dispatch: NativeRootOperatorDispatch; captured: Capture
  scope: ClosedRecoveryScope; ownership: CoordinatorOwnershipCapability; expiresAt: number
}
const qualifications = new WeakMap<object, QualificationLease>()
const qualificationState = (value: unknown): QualificationLease => {
  const state = value && typeof value === 'object' ? qualifications.get(value) : undefined
  if (!state?.active || state.consumed || state.processClosed || performance.now() >= state.expiresAt) return refuse()
  return state
}
/** Only the native stopped/EX producer's real scope is accepted. No callback port or ready flag supplies authority. */
export async function createNativeClosedRecoveryHostedUidQualification(ownership: CoordinatorOwnershipCapability,
  dispatch: NativeRootOperatorDispatch, scope: ClosedRecoveryScope): Promise<NativeHostedUidQualification> {
  await assertNativeRootOperatorDispatchHeld(dispatch); await assertNativeClosedDatabaseRecoveryScopeHeld(scope)
  const info = getNativeRootOperatorDispatchInfo(dispatch), request = info.request
  if (request.kind !== 'recover' || request.phase !== 'apply' || coordinatorOwnershipInfo(ownership).receiptSha256 !== info.coordinatorReceiptSha256) return refuse()
  let captured: Capture | undefined
  try {
    const result = await scope.withReadonlyDatabase(async db => {
      captured = await collectHostedObservation(ownership, request, scope, db, true)
      return captured
    })
    if (!result.process) return refuse()
    await assertNativeClosedDatabaseRecoveryScopeHeld(scope); await assertNativeRootOperatorDispatchHeld(dispatch)
    const proof = Object.freeze({ ...result.proof }) as NativeHostedUidQualification
    qualifications.set(proof, { active: true, consumed: false, processClosed: false, dispatch, captured: result, scope, ownership, expiresAt: result.observedMonotonic + 60000 })
    try { await assertNativeHostedUidQualificationCurrent(proof, dispatch); return proof }
    catch (error) { await retireNativeHostedUidQualification(proof); captured = undefined; throw error }
  } catch (error) { await captured?.process?.close(); throw error }
}
/** Retains only a proc-directory descriptor after HTTP/SQLite/StateStore have retired.
 * Rechecks use kernel/unit/source/dispatch/native EX proof; they never reopen SQL. */
export async function assertNativeHostedUidQualificationCurrent(value: unknown, dispatch: unknown): Promise<void> {
  const state = qualificationState(value)
  if (state.dispatch !== dispatch) return refuse()
  await assertNativeRootOperatorDispatchHeld(dispatch); await assertNativeClosedDatabaseRecoveryScopeHeld(state.scope)
  await assertCoordinatorOwnershipCurrent(state.ownership); await state.scope.assertCurrent()
  const captured = state.captured
  await readPinnedProcess(captured.process!, captured.observed, captured.account, captured.unit, captured.mainPid)
  const owner = coordinatorOwnershipInfo(state.ownership)
  await withTrustedFile('/usr/bin/systemctl', { sha256: owner.systemctlSha256, maxBytes: 16 * 1024 * 1024 }, async tool => {
    const guard = async () => { qualificationState(value); await assertNativeRootOperatorDispatchHeld(dispatch); await assertNativeClosedDatabaseRecoveryScopeHeld(state.scope) }
    const result = await readonlyExecutor(tool, guard, captured.unit).runCommand(unitIdentityShowArgv(captured.unit))
    const fields = new Map<string, string>()
    for (const line of result.stdout.trim().split('\n')) { const index = line.indexOf('='); if (index < 1 || fields.has(line.slice(0, index))) return refuse(); fields.set(line.slice(0, index), line.slice(index + 1)) }
    if (!result.ok || result.code !== 0 || result.stderr.trim() || fields.size !== 6 || fields.get('Id') !== captured.unit
      || fields.get('User') !== captured.account.username || fields.get('Group') !== captured.account.username || fields.get('ActiveState') !== 'active'
      || Number(fields.get('MainPID')) !== captured.mainPid || fields.get('ControlGroup') !== '/xpanel.slice/' + system.accountSliceName(captured.account.uid) + '/' + captured.unit) return refuse()
    await tool.verify()
  })
  await readPinnedProcess(captured.process!, captured.observed, captured.account, captured.unit, captured.mainPid)
  await assertCoordinatorOwnershipCurrent(state.ownership); await assertNativeRootOperatorDispatchHeld(dispatch)
  if (qualificationState(value) !== state) return refuse()
}
/** One-shot bridge to fresh admission. A JSON digest or replay cannot consume this identity. */
export async function consumeNativeHostedUidQualification(value: unknown, dispatch: unknown): Promise<HostedUidQualification> {
  await assertNativeHostedUidQualificationCurrent(value, dispatch)
  const state = qualificationState(value); state.consumed = true
  await state.captured.process!.close(); state.processClosed = true
  const proof = value as NativeHostedUidQualification
  return Object.freeze({ digest: proof.digest, observedAt: proof.observedAt })
}
/** Cleanup never grants authority; allowed after a lost peer or retired native scope. */
export async function retireNativeHostedUidQualification(value: unknown): Promise<void> {
  const state = value && typeof value === 'object' ? qualifications.get(value) : undefined
  if (!state) return refuse()
  state.active = false; qualifications.delete(value as object)
  if (!state.processClosed) { await state.captured.process!.close(); state.processClosed = true }
}
