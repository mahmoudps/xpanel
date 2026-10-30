import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { constants } from 'node:fs'
import { chmod, chown, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { assertInt, assertLine, fail } from '@xpanel/core'
import { atomicRemove, atomicWriteJson, fsyncDir, isStateDirectoryDurabilityError, readJsonIfExists } from './atomic.ts'
import { acquireWriterMutex, WRITER_MUTEX_FILE, type WriterMutexGuard } from './writer-mutex.ts'
import type { AllocatedReferenceRecord, ReferenceKind, StateAuthorityMetadata, WriterLockHolder } from './types.ts'
import { formatShortReference, normalizeReferenceKind, validateStateAuthority, validateUidAllocator } from './validate-state.ts'

export const AUTHORITY_FILE = 'authority.json'
export const LOCK_DIR = '.lock'
export const LOCK_OWNER_FILE = 'owner.json'
export const LOCK_INTENT_FILE = 'intent.json'
const PROTOCOL = 'sqlite-v1'
const RESTORE_ENTRIES = ['feature-lists', 'plans', 'resellers', 'accounts', 'certificates', 'zones', 'server.json', 'firewall.json', 'uid-allocator.json', 'ip-pool.json', 'mail-ips.json',
  // saved mail routing (StateStore MAIL_ROUTING_FILES) and mailbox autoresponders, below extended/
  'extended/mail/forwarders.json', 'extended/mail/domain-forwarders.json', 'extended/mail/default-addresses.json', 'extended/mail/filters.json', 'extended/mail/autoresponders.json', 'extended/webmail/vacation'] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Shared across WriterLock instances so callbacks cannot recursively take a
// state guard through another store and wait on their own retained OS mutex.
const projectionReadScope = new AsyncLocalStorage<{ active: boolean }>()

export const isProcessAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}
export interface WriteIntentBackup { relPath: string; existed: boolean; contentBase64?: string }
export interface RestoreIntentInput { stageName: string; backupName: string; entries: readonly string[] }
export interface RestoreIntentPlan { cleanup?: { canonicalHashes: (string | null)[] }; stageName: string; backupName: string; entries: { name: string; originalHash: string | null; stagedHash: string | null }[] }
export interface WriteIntentRecord {
  restore?: RestoreIntentPlan
  op: string
  leaseId?: string
  fencingToken: number
  baseRevision: number
  createdRelPaths: string[]
  backups: WriteIntentBackup[]
  recordedAt: string
}
export interface AccountContactProjectionRecovery {
  readonly accountId: string
  readonly username: string
  readonly relPath: string
  readonly committed: boolean
}
export interface WriterLockOptions {
  acquireTimeoutMs?: number
  retryIntervalMs?: number
  deadOwnerGraceMs?: number
  isPidAlive?: (pid: number) => boolean
  /** Runs under the permanent writer mutex after selecting the surviving canonical account. */
  recoverAccountContactProjection?: (recovery: AccountContactProjectionRecovery) => Promise<void>
}
export interface WriterLease {
  readonly pid: number
  readonly fencingToken: number
  readonly leaseId: string
  readonly acquiredAt: string
  readonly initialAuthority: StateAuthorityMetadata
  readonly preAcquireAuthorityRaw: string | null
  assertFencingToken(expectedToken?: number): Promise<StateAuthorityMetadata>
  recordIntent(intent: Omit<WriteIntentRecord, 'leaseId' | 'fencingToken' | 'baseRevision' | 'recordedAt'>): Promise<void>
  recordRestoreIntent(input: RestoreIntentInput): Promise<void>
  rollbackRestoreIntent(): Promise<void>
  rollbackIntent(): Promise<void>
  clearIntent(): Promise<void>
  /** Preserve externally replaced account bytes and quarantine only the exact remote-access preimage. */
  quarantineExternalAccountIntent(relativeAccountPath: string, expectedSha256?: string): Promise<void>
  commitAuthority(patch?: { incrementRevision?: boolean; revision?: number; references?: Record<string, number>; allocatedReferences?: Record<string, AllocatedReferenceRecord> }): Promise<StateAuthorityMetadata>
  restorePreAcquireAuthorityIfUncommitted(): Promise<void>
  release(): Promise<void>
}
type Holder = WriterLockHolder & { protocol?: string; mutexIdentity?: string }
const defaultAuthority = (): StateAuthorityMetadata => ({ revision: 0, fencingToken: 0, updatedAt: new Date(0).toISOString(), references: {} })

export class WriterLock {
  readonly stateDir: string
  private readonly acquireTimeoutMs: number
  private readonly retryIntervalMs: number
  private readonly isPidAlive: (pid: number) => boolean
  private recoverAccountContactProjection: WriterLockOptions['recoverAccountContactProjection']
  constructor(stateDir: string, opts: WriterLockOptions = {}) {
    this.stateDir = resolve(stateDir)
    this.acquireTimeoutMs = assertInt(opts.acquireTimeoutMs ?? 15_000, 0, 600_000, 'acquireTimeoutMs')
    this.retryIntervalMs = assertInt(opts.retryIntervalMs ?? 15, 1, 60_000, 'retryIntervalMs')
    this.isPidAlive = opts.isPidAlive ?? isProcessAlive
    this.recoverAccountContactProjection = opts.recoverAccountContactProjection
  }
  /** Trusted startup wiring; installing a port does not itself acquire or recover a lease. */
  registerAccountContactProjectionRecovery(repair: NonNullable<WriterLockOptions['recoverAccountContactProjection']>): void {
    this.recoverAccountContactProjection = repair
  }
  get lockDirPath(): string { return join(this.stateDir, LOCK_DIR) }
  get ownerFilePath(): string { return join(this.lockDirPath, LOCK_OWNER_FILE) }
  get intentFilePath(): string { return join(this.lockDirPath, LOCK_INTENT_FILE) }
  get authorityFilePath(): string { return join(this.stateDir, AUTHORITY_FILE) }
  get mutexFilePath(): string { return join(this.stateDir, WRITER_MUTEX_FILE) }
  async readAuthority(): Promise<StateAuthorityMetadata> { const raw = await readJsonIfExists<unknown>(this.authorityFilePath); return raw === null ? defaultAuthority() : validateStateAuthority(raw) }
  async readLockHolder(): Promise<Holder | null> {
    const raw = await readJsonIfExists<unknown>(this.ownerFilePath)
    if (raw === null) return null
    if (typeof raw !== 'object' || Array.isArray(raw)) return fail('VALIDATION', 'invalid state writer owner')
    const value = raw as Record<string, unknown>
    if (!Number.isSafeInteger(value.pid) || Number(value.pid) < 1 || !Number.isSafeInteger(value.fencingToken) || Number(value.fencingToken) < 1
      || typeof value.leaseId !== 'string' || !UUID.test(value.leaseId) || typeof value.acquiredAt !== 'string' || !Number.isFinite(Date.parse(value.acquiredAt))
      || (value.protocol !== undefined && value.protocol !== PROTOCOL) || value.protocol === PROTOCOL && (typeof value.mutexIdentity !== 'string' || !/^[0-9]+:[0-9]+$/.test(value.mutexIdentity))) return fail('VALIDATION', 'invalid state writer owner')
    return { pid: Number(value.pid), fencingToken: Number(value.fencingToken), leaseId: value.leaseId, acquiredAt: value.acquiredAt, ...(value.protocol ? { protocol: PROTOCOL, mutexIdentity: String(value.mutexIdentity) } : {}) }
  }
  async assertFencingToken(expectedToken: number, expectedLeaseId?: string): Promise<StateAuthorityMetadata> {
    assertInt(expectedToken, 1, Number.MAX_SAFE_INTEGER, 'fencingToken')
    const [authority, holder] = await Promise.all([this.readAuthority(), this.readLockHolder()])
    if (authority.fencingToken !== expectedToken || !holder || holder.fencingToken !== expectedToken || (expectedLeaseId !== undefined && holder.leaseId !== expectedLeaseId)) {
      return fail('CONFLICT', 'state writer lease is no longer current', { expectedFencingToken: expectedToken, currentFencingToken: authority.fencingToken })
    }
    return authority
  }
  private async guard(timeoutMs = this.acquireTimeoutMs): Promise<WriterMutexGuard> {
    if (projectionReadScope.getStore()?.active) return fail('PRECONDITION_FAILED', 'a recovered projection read cannot reenter a state barrier or mutation')
    await mkdir(this.stateDir, { recursive: true, mode: 0o750 })
    return acquireWriterMutex(this.mutexFilePath, timeoutMs, this.retryIntervalMs)
  }
  private async confinedPath(relPath: unknown): Promise<string> {
    if (typeof relPath !== 'string' || relPath.length < 1 || relPath.length > 4096 || isAbsolute(relPath) || /[\\:\0~]/.test(relPath)) return fail('VALIDATION', 'invalid recovery relative path')
    const parts = relPath.split('/')
    if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.') || /[ .]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || [AUTHORITY_FILE, WRITER_MUTEX_FILE].includes(parts[0]!.toLowerCase()) || parts[0]!.startsWith(WRITER_MUTEX_FILE + '-')) return fail('VALIDATION', 'protected or noncanonical recovery path')
    const target = resolve(this.stateDir, ...parts)
    if (!target.startsWith(this.stateDir + sep)) return fail('VALIDATION', 'recovery path escapes state directory')
    let path = this.stateDir
    for (let index = 0; index < parts.length; index++) {
      path = join(path, parts[index]!)
      const info = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
      if (info?.isSymbolicLink() || (info && index < parts.length - 1 && !info.isDirectory())) return fail('VALIDATION', 'recovery path crosses a link or non-directory')
    }
    return target
  }
  private async treeHash(path: string): Promise<string | null> {
    const info = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
    if (!info) return null
    if (info.isSymbolicLink()) return fail('VALIDATION', 'restore artifact crosses a symbolic link')
    const hash = createHash('sha256')
    if (info.isFile()) {
      if (info.nlink !== 1) return fail('VALIDATION', 'restore artifact has multiple links')
      return hash.update('file\0').update(await readFile(path)).digest('hex')
    }
    if (!info.isDirectory()) return fail('VALIDATION', 'unsupported restore artifact')
    for (const name of (await readdir(path)).sort()) {
      if (name === WRITER_MUTEX_FILE || name.startsWith(WRITER_MUTEX_FILE + '-')) return fail('VALIDATION', 'operational mutex cannot be read as a restore payload')
      hash.update(JSON.stringify(name)).update(':').update((await this.treeHash(join(path, name)))!).update('\0')
    }
    return hash.update('directory').digest('hex')
  }
  private async validateRestorePlan(raw: unknown): Promise<RestoreIntentPlan> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('VALIDATION', 'invalid restore recovery plan')
    const plan = raw as RestoreIntentPlan
    if (typeof plan.stageName !== 'string' || !/^\.restore-stage-[a-zA-Z0-9-]+$/.test(plan.stageName) || typeof plan.backupName !== 'string' || !/^\.restore-backup-[a-zA-Z0-9-]+$/.test(plan.backupName)
      || !Array.isArray(plan.entries) || plan.entries.length !== RESTORE_ENTRIES.length) return fail('VALIDATION', 'invalid restore artifact names or entries')
    for (const name of [plan.stageName, plan.backupName]) {
      const info = await lstat(join(this.stateDir, name)).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
      if (info && (!info.isDirectory() || info.isSymbolicLink())) return fail('VALIDATION', 'restore artifact root must be a real directory')
    }
    for (let index = 0; index < RESTORE_ENTRIES.length; index++) {
      const entry = plan.entries[index]
      if (!entry || entry.name !== RESTORE_ENTRIES[index] || ![entry.originalHash, entry.stagedHash].every(value => value === null || typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) return fail('VALIDATION', 'invalid restore entry identity')
    }
    if (plan.cleanup !== undefined && (!plan.cleanup || !Array.isArray(plan.cleanup.canonicalHashes) || plan.cleanup.canonicalHashes.length !== RESTORE_ENTRIES.length || !plan.cleanup.canonicalHashes.every(value => value === null || typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)))) return fail('VALIDATION', 'invalid restore cleanup proof')
    return plan
  }
  private async recoverRestore(plan: RestoreIntentPlan, committed: boolean, journal: WriteIntentRecord): Promise<void> {
    const stage = join(this.stateDir, plan.stageName), backup = join(this.stateDir, plan.backupName)
    if (plan.cleanup) {
      // The complete canonical result was proved before garbage collection began; artifact trees may now be partial.
      for (let index = 0; index < plan.entries.length; index++) if (await this.treeHash(join(this.stateDir, plan.entries[index]!.name)) !== plan.cleanup.canonicalHashes[index]) return fail('VALIDATION', 'restore cleanup canonical proof no longer matches')
      validateUidAllocator(await readJsonIfExists(join(this.stateDir, 'uid-allocator.json')))
      await rm(stage, { recursive: true, force: true }); await rm(backup, { recursive: true, force: true })
      return
    }
    // Validate all phases before removing or replacing a single canonical entry.
    const phases = []
    for (const entry of plan.entries) {
      const currentHash = await this.treeHash(join(this.stateDir, entry.name))
      const backupHash = await this.treeHash(join(backup, entry.name))
      const stageHash = await this.treeHash(join(stage, entry.name))
      if (backupHash !== null && backupHash !== entry.originalHash || stageHash !== null && stageHash !== entry.stagedHash) return fail('VALIDATION', 'restore artifact does not match its recovery manifest')
      if (entry.name !== 'uid-allocator.json') {
        if (committed) {
          if (currentHash !== entry.stagedHash) return fail('VALIDATION', 'committed restore tree does not match its manifest')
        } else if (backupHash !== null) {
          if (currentHash !== null && currentHash !== entry.originalHash && currentHash !== entry.stagedHash) return fail('VALIDATION', 'restore canonical entry has an unknown value')
        } else if (entry.originalHash !== null ? currentHash !== entry.originalHash : currentHash !== null && currentHash !== entry.stagedHash) return fail('VALIDATION', 'restore original entry is unavailable')
      }
      phases.push({ entry, currentHash, backupHash })
    }
    const allocatorPaths = [join(this.stateDir, 'uid-allocator.json'), join(backup, 'uid-allocator.json'), join(stage, 'uid-allocator.json')]
    const allocators = []
    for (const path of allocatorPaths) {
      const raw = await readJsonIfExists(path)
      if (raw !== null) allocators.push(validateUidAllocator(raw))
    }
    if (!allocators.length) return fail('VALIDATION', 'restore recovery has no surviving UID allocator; evidence retained')
    const allocations = new Map<number, (typeof allocators)[number]['allocated'][number]>()
    for (const allocator of allocators) for (const allocation of allocator.allocated) {
      const old = allocations.get(allocation.uid)
      if (old && old.username !== allocation.username) return fail('VALIDATION', 'restore recovery conflicts with a burned UID allocation')
      if (!old) allocations.set(allocation.uid, allocation)
    }
    const merged = validateUidAllocator({ nextUid: Math.max(...allocators.map(value => value.nextUid)), allocated: [...allocations.values()].sort((a, b) => a.uid - b.uid) })
    await atomicWriteJson(join(this.stateDir, 'uid-allocator.json'), merged)
    if (!committed) for (const { entry, backupHash } of phases.toReversed()) {
      if (entry.name === 'uid-allocator.json') continue
      const live = join(this.stateDir, entry.name)
      if (backupHash !== null) {
        await atomicRemove(live)
        await mkdir(dirname(live), { recursive: true })
        await rename(join(backup, entry.name), live)
      } else if (entry.originalHash === null) await atomicRemove(live)
    }
    // Persist canonical proof before recursive cleanup can partially erase artifact manifests.
    const canonicalHashes = []
    for (const entry of plan.entries) {
      const hash = await this.treeHash(join(this.stateDir, entry.name))
      if (entry.name !== 'uid-allocator.json' && hash !== (committed ? entry.stagedHash : entry.originalHash)) return fail('VALIDATION', 'restored canonical result could not be proved')
      canonicalHashes.push(hash)
    }
    await atomicWriteJson(this.intentFilePath, { ...journal, restore: { ...plan, cleanup: { canonicalHashes } } }, 0o640)
    await rm(stage, { recursive: true, force: true })
    await rm(backup, { recursive: true, force: true })
  }
  private async validatedIntent(holder: Holder, prospective?: unknown): Promise<WriteIntentRecord | null> {
    const raw = prospective === undefined ? await readJsonIfExists<unknown>(this.intentFilePath) : prospective
    if (raw === null) return null
    if (typeof raw !== 'object' || Array.isArray(raw)) return fail('VALIDATION', 'invalid state write intent')
    const value = raw as Record<string, unknown>
    if (typeof value.op !== 'string' || !value.op || value.op.length > 256 || !Number.isSafeInteger(value.fencingToken) || value.fencingToken !== holder.fencingToken
      || !Number.isSafeInteger(value.baseRevision) || Number(value.baseRevision) < 0 || typeof value.recordedAt !== 'string' || !Number.isFinite(Date.parse(value.recordedAt))
      || !Array.isArray(value.createdRelPaths) || !Array.isArray(value.backups) || value.createdRelPaths.length + value.backups.length > 100_000
      || (value.leaseId !== undefined && (typeof value.leaseId !== 'string' || value.leaseId !== holder.leaseId || !UUID.test(value.leaseId)))
      || (holder.protocol === PROTOCOL && value.leaseId !== holder.leaseId)) return fail('VALIDATION', 'invalid state write intent identity')
    if (value.restore !== undefined) {
      if (value.createdRelPaths.length || value.backups.length) return fail('VALIDATION', 'restore plan cannot mix generic rollback paths')
      await this.validateRestorePlan(value.restore)
    }
    const seen = new Set<string>()
    const pathKey = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
    const overlaps = (value: string) => [...seen].some(old => old === value || old.startsWith(value + '/') || value.startsWith(old + '/'))
    for (const rel of value.createdRelPaths) {
      await this.confinedPath(rel)
      if (overlaps(pathKey(rel))) return fail('VALIDATION', 'duplicate recovery path')
      seen.add(pathKey(rel))
    }
    for (const item of value.backups) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return fail('VALIDATION', 'invalid recovery backup')
      const backup = item as Record<string, unknown>
      await this.confinedPath(backup.relPath)
      if (overlaps(pathKey(String(backup.relPath))) || typeof backup.existed !== 'boolean') return fail('VALIDATION', 'invalid or duplicate recovery backup')
      seen.add(pathKey(String(backup.relPath)))
      if (backup.existed) {
        if (typeof backup.contentBase64 !== 'string' || Buffer.from(backup.contentBase64, 'base64').toString('base64') !== backup.contentBase64) return fail('VALIDATION', 'invalid recovery backup encoding')
        try { JSON.parse(Buffer.from(backup.contentBase64, 'base64').toString('utf8')) } catch { return fail('VALIDATION', 'invalid recovery JSON backup') }
      } else if (backup.contentBase64 !== undefined) return fail('VALIDATION', 'unexpected content for absent recovery backup')
    }
    return value as unknown as WriteIntentRecord
  }
  private async writeBackupBytes(path: string, contentBase64: string): Promise<void> {
    const temp = join(dirname(path), '.rollback-' + process.pid + '-' + randomUUID() + '.tmp')
    await mkdir(dirname(path), { recursive: true, mode: 0o750 })
    let handle
    try {
      handle = await open(temp, 'wx', 0o640)
      await handle.writeFile(Buffer.from(contentBase64, 'base64'))
      await handle.sync()
      await handle.close(); handle = undefined
      await rename(temp, path)
      await fsyncDir(dirname(path))
    } catch (error) { await handle?.close().catch(() => undefined); await rm(temp, { force: true }).catch(() => undefined); throw error }
  }
  private async recoverGeneric(journal: WriteIntentRecord): Promise<void> {
    // A crash journal that only lists the allocator as a created path keeps that burn.
    // A journaled preimage is restored so a failed account create releases its reservation.
    for (const rel of journal.createdRelPaths) if (rel.toLowerCase() !== 'uid-allocator.json') await atomicRemove(await this.confinedPath(rel))
    for (const backup of journal.backups) {
      const target = await this.confinedPath(backup.relPath)
      if (!backup.existed) await atomicRemove(target)
      else await this.writeBackupBytes(target, backup.contentBase64!)
    }
    for (const rel of journal.createdRelPaths) if (rel.toLowerCase() !== 'uid-allocator.json' && await lstat(await this.confinedPath(rel)).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })) return fail('CONFLICT', 'rollback removal could not be verified')
    for (const backup of journal.backups) {
      const target = await this.confinedPath(backup.relPath)
      if (backup.existed) { if (!(await readFile(target)).equals(Buffer.from(backup.contentBase64!, 'base64'))) return fail('CONFLICT', 'rollback preimage could not be verified') }
      else if (await lstat(target).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })) return fail('CONFLICT', 'rollback absence could not be verified')
    }
  }
  private contactProjection(journal: WriteIntentRecord, committed: boolean): AccountContactProjectionRecovery | null {
    if (journal.op !== 'updateAccountContactEmail') return null
    // The existing contact intent is also the durable projection-repair marker,
    // including intents left by versions predating projection recovery.
    const backup = journal.backups[0]
    if (journal.restore || journal.createdRelPaths.length || journal.backups.length !== 1 || !backup?.existed
      || !/^accounts\/[a-z][a-z0-9_]{0,31}\/account\.json$/.test(backup.relPath)) {
      return fail('VALIDATION', 'contact projection intent must identify one canonical account')
    }
    const preimage = JSON.parse(Buffer.from(backup.contentBase64!, 'base64').toString('utf8')) as Record<string, unknown> | null
    const username = backup.relPath.split('/')[1]!
    if (!preimage || Array.isArray(preimage) || typeof preimage.id !== 'string' || !UUID.test(preimage.id)
      || preimage.username !== username) return fail('VALIDATION', 'contact projection intent identity is invalid')
    return { accountId: preimage.id, username, relPath: backup.relPath, committed }
  }
  /** Must be called only while holding the OS guard, before ANY rollback or owner cleanup. */
  private async recoverOrphan(guard: WriterMutexGuard): Promise<void> {
    await guard.assertStable()
    const info = await lstat(this.lockDirPath).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
    if (!info) return
    if (!info.isDirectory() || info.isSymbolicLink()) return fail('VALIDATION', 'state writer lock must be a real directory')
    const holder = await this.readLockHolder()
    if (!holder) return fail('CONFLICT', 'state writer owner is unknown; stopped-writer inspection is required')
    if (holder.protocol === PROTOCOL && holder.mutexIdentity !== guard.identity) return fail('CONFLICT', 'orphan owner is bound to another mutex inode; evidence retained')
    // Legacy processes do not take the new kernel guard. Upgrade requires all such writers stopped.
    if (holder.protocol !== PROTOCOL && this.isPidAlive(holder.pid)) return fail('CONFLICT', 'legacy state writer is alive; coordinated stopped-writer upgrade is required')
    const authority = await this.readAuthority()
    const journal = await this.validatedIntent(holder)
    if (journal) {
      if (journal.op === 'databaseRemoteAccess' && journal.leaseId && await readJsonIfExists(join(this.stateDir, '.remote-access-review-' + journal.leaseId + '.json')) !== null) return fail('CONFLICT', 'external account conflict requires stopped-writer review; automatic preimage replay is refused')
      if (authority.fencingToken !== journal.fencingToken) return fail('VALIDATION', 'recovery intent epoch does not match state authority')
      const committed = journal.leaseId !== undefined && authority.committedLeaseId === journal.leaseId
      if (!committed && authority.revision !== journal.baseRevision) return fail('VALIDATION', 'recovery intent commit status is inconsistent; evidence retained')
      if (committed && authority.revision < journal.baseRevision) return fail('VALIDATION', 'committed recovery revision is inconsistent')
      const contactProjection = this.contactProjection(journal, committed)
      // Never clear the marker or alter the surviving source without a trusted
      // projection port: a state-only recovery would conceal stale SQLite data.
      if (contactProjection && !this.recoverAccountContactProjection) return fail('PRECONDITION_FAILED', 'contact projection recovery requires a registered index repair port')
      if (contactProjection) {
        const source = await readJsonIfExists<Record<string, unknown>>(await this.confinedPath(contactProjection.relPath))
        if (!source || source.id !== contactProjection.accountId || source.username !== contactProjection.username) return fail('CONFLICT', 'contact projection source identity changed; recovery evidence retained')
      }
      if (journal.restore) await this.recoverRestore(journal.restore, committed, journal)
      else if (!committed) await this.recoverGeneric(journal)
      if (contactProjection) {
        await guard.assertStable()
        await this.recoverAccountContactProjection!(contactProjection)
        await guard.assertStable()
      }
      // Retain the complete intent if any validation/rollback write above fails.
      await rm(this.intentFilePath)
    } else if (holder.fencingToken < authority.fencingToken) {
      return fail('VALIDATION', 'orphan owner epoch is older than state authority; evidence retained')
    } else if (holder.fencingToken > authority.fencingToken) {
      if (holder.protocol !== PROTOCOL || holder.fencingToken !== authority.fencingToken + 1) return fail('VALIDATION', 'orphan owner epoch is inconsistent')
      await atomicWriteJson(this.authorityFilePath, { ...authority, fencingToken: holder.fencingToken, updatedAt: new Date().toISOString() }, 0o640)
    }
    await rm(this.lockDirPath, { recursive: true })
  }
  /** Stable barrier: clean reads never allocate a revision, epoch, UID or public reference. */
  async readAuthorityAtBarrier(): Promise<StateAuthorityMetadata> {
    const guard = await this.guard()
    try { await this.recoverOrphan(guard); return await this.readAuthority() } finally { await guard.release() }
  }
  async waitForUnlocked(timeoutMs = this.acquireTimeoutMs): Promise<void> {
    const guard = await this.guard(timeoutMs)
    try { await this.recoverOrphan(guard) } finally { await guard.release() }
  }
  /**
   * Recover and execute one bounded derived SQL read under the SAME OS mutex.
   * Unlike a wait-then-read barrier, a writer cannot publish an uncommitted SQL
   * projection between recovery and observation. No state lease/epoch is issued.
   * The callback must not acquire state guards, authenticate or render a request.
   */
  async readUnderRecoveryLock<T>(read: () => Promise<T>): Promise<T> {
    const guard = await this.guard()
    const context = { active: true }
    try {
      return await projectionReadScope.run(context, async () => {
        await this.recoverOrphan(guard)
        const result = await read()
        await guard.assertStable()
        return result
      })
    } finally { context.active = false; await guard.release() }
  }
  /** Explicit recovery cannot revoke a live/paused kernel owner. Terminate it and await OS release first. */
  async forceRecoverLease(): Promise<StateAuthorityMetadata> {
    const guard = await this.guard()
    try {
      await this.recoverOrphan(guard)
      const current = await this.readAuthority()
      const next = { ...current, fencingToken: assertInt(current.fencingToken + 1, 1, Number.MAX_SAFE_INTEGER, 'fencingToken'), updatedAt: new Date().toISOString() }
      await atomicWriteJson(this.authorityFilePath, next, 0o640)
      return next
    } finally { await guard.release() }
  }
  async acquire(opts?: { acquireTimeoutMs?: number }): Promise<WriterLease> {
    const guard = await this.guard(opts?.acquireTimeoutMs)
    let leaseOwnsGuard = false
    let prepared: string | undefined
    let publishedLease: string | undefined
    try {
      await this.recoverOrphan(guard)
      const preAcquireAuthorityRaw = await readFile(this.authorityFilePath, 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
      const current = preAcquireAuthorityRaw === null ? defaultAuthority() : validateStateAuthority(JSON.parse(preAcquireAuthorityRaw))
      const fencingToken = assertInt(current.fencingToken + 1, 1, Number.MAX_SAFE_INTEGER, 'fencingToken')
      const leaseId = randomUUID(), acquiredAt = new Date().toISOString()
      const holder: Holder = { protocol: PROTOCOL, mutexIdentity: guard.identity, pid: process.pid, fencingToken, leaseId, acquiredAt }
      prepared = join(this.stateDir, '.lock-prepared-' + process.pid + '-' + leaseId)
      await mkdir(prepared, { mode: 0o700 })
      if (process.platform !== 'win32') { const parent = await lstat(this.stateDir); await chown(prepared, -1, parent.gid); await chmod(prepared, 0o2770) }
      await atomicWriteJson(join(prepared, LOCK_OWNER_FILE), holder, 0o640)
      await rename(prepared, this.lockDirPath)
      prepared = undefined
      publishedLease = leaseId
      await atomicWriteJson(this.authorityFilePath, { ...current, fencingToken, updatedAt: acquiredAt }, 0o640)
      let committed = false, commitDurabilityUncertain = false, closing = false, released = false
      let tail: Promise<unknown> = Promise.resolve()
      let releasePromise: Promise<void> | undefined
      const assertCurrent = async (expected = fencingToken): Promise<StateAuthorityMetadata> => {
        await guard.assertStable()
        if (released || expected !== fencingToken) return fail('CONFLICT', 'state writer lease is closed or fencing token mismatched')
        return this.assertFencingToken(fencingToken, leaseId)
      }
      const run = <T>(fn: () => Promise<T>): Promise<T> => {
        if (closing) return Promise.resolve().then(() => fail('CONFLICT', 'state writer lease is closing'))
        const result = tail.then(fn)
        tail = result.catch(() => undefined)
        return result
      }
      const rollbackCurrent = async (restoreOnly = false): Promise<void> => {
        const authority = await assertCurrent()
        const journal = await this.validatedIntent(holder)
        if (!journal) return
        if (committed || authority.committedLeaseId === leaseId || authority.revision !== journal.baseRevision || restoreOnly && !journal.restore) return fail('CONFLICT', 'rollback cannot disprove a committed or changed authority')
        if (journal.restore) await this.recoverRestore(journal.restore, false, journal)
        else await this.recoverGeneric(journal)
        await rm(this.intentFilePath)
      }
      const lease: WriterLease = {
        pid: process.pid, fencingToken, leaseId, acquiredAt, initialAuthority: current, preAcquireAuthorityRaw,
        assertFencingToken: expected => run(() => assertCurrent(expected)),
        recordIntent: value => run(async () => {
          await assertCurrent()
          if (committed || commitDurabilityUncertain) return fail('CONFLICT', 'cannot journal after authority commit or uncertain durability')
          if (await readJsonIfExists(this.intentFilePath) !== null) return fail('CONFLICT', 'an uncommitted state journal already exists')
          const record: WriteIntentRecord = { ...value, leaseId, fencingToken, baseRevision: current.revision, recordedAt: new Date().toISOString() }
          // Validate the full prospective journal before publication, without canonical file effects.
          await this.validatedIntent(holder, record)
          await atomicWriteJson(this.intentFilePath, record, 0o640)
        }),
        recordRestoreIntent: input => run(async () => {
          await assertCurrent()
          if (committed || commitDurabilityUncertain || await readJsonIfExists(this.intentFilePath) !== null) return fail('CONFLICT', 'cannot replace active recovery evidence')
          if (!Array.isArray(input.entries) || input.entries.length !== RESTORE_ENTRIES.length || input.entries.some((name, index) => name !== RESTORE_ENTRIES[index])) return fail('VALIDATION', 'restore entries must be the complete canonical allowlist')
          await this.validateRestorePlan({ stageName: input.stageName, backupName: input.backupName, entries: input.entries.map(name => ({ name, originalHash: null, stagedHash: null })) })
          const entries = []
          for (const name of input.entries) entries.push({ name, originalHash: await this.treeHash(join(this.stateDir, name)), stagedHash: await this.treeHash(join(this.stateDir, input.stageName, name)) })
          const record: WriteIntentRecord = { op: 'restoreGenerationSnapshot', leaseId, fencingToken, baseRevision: current.revision, recordedAt: new Date().toISOString(), createdRelPaths: [], backups: [], restore: { stageName: input.stageName, backupName: input.backupName, entries } }
          await this.validatedIntent(holder, record)
          await atomicWriteJson(this.intentFilePath, record, 0o640)
        }),
        rollbackIntent: () => run(() => rollbackCurrent()),
        quarantineExternalAccountIntent: (relativeAccountPath, expectedSha256) => run(async () => {
          const authority = await assertCurrent()
          const journal = await readJsonIfExists<WriteIntentRecord>(this.intentFilePath)
          if (committed || commitDurabilityUncertain || authority.committedLeaseId === leaseId || !journal || journal.restore
            || journal.op !== 'databaseRemoteAccess' || journal.leaseId !== leaseId || journal.fencingToken !== fencingToken || authority.revision !== journal.baseRevision
            || !Array.isArray(journal.createdRelPaths) || journal.createdRelPaths.length !== 0 || !Array.isArray(journal.backups)
            || journal.backups.length !== 1 || !journal.backups[0] || journal.backups[0].relPath !== relativeAccountPath || journal.backups[0].existed !== true
            || typeof journal.backups[0].contentBase64 !== 'string' || Buffer.from(journal.backups[0].contentBase64, 'base64').toString('base64') !== journal.backups[0].contentBase64
            || !/^accounts\/[a-z][a-z0-9_]{0,31}\/account\.json$/.test(relativeAccountPath) || expectedSha256 !== undefined && !/^[0-9a-f]{64}$/.test(expectedSha256)) return fail('CONFLICT', 'only an exact uncommitted external account conflict may be quarantined')
          const fingerprint = async (): Promise<string> => {
            const path = await this.confinedPath(relativeAccountPath)
            const before = await lstat(path, { bigint: true })
            if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 1024n * 1024n) return fail('CONFLICT', 'external account source requires stopped-writer review')
            const identity = (value: typeof before) => `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`
            const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
            try {
              const opened = await handle.stat({ bigint: true })
              const bytes = await handle.readFile(), after = await handle.stat({ bigint: true }), named = await lstat(path, { bigint: true })
              const digest = createHash('sha256').update(bytes).digest('hex')
              if (!named.isFile() || named.isSymbolicLink() || identity(opened) !== identity(before) || identity(after) !== identity(before) || identity(named) !== identity(before) || expectedSha256 !== undefined && digest !== expectedSha256) return fail('CONFLICT', 'external account source changed during preservation')
              return identity(before) + ':' + digest
            } finally { await handle.close() }
          }
          const reviewPath = join(this.stateDir, '.remote-access-review-' + leaseId + '.json')
          if (await lstat(reviewPath).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })) return fail('CONFLICT', 'remote-access review evidence already exists')
          await atomicWriteJson(reviewPath, { schemaVersion: 1, reason: 'external_account_source_preserved', expectedSha256: expectedSha256 ?? null, journal }, 0o600, () => assertCurrent())
          const identity = await fingerprint()
          await atomicWriteJson(reviewPath, { schemaVersion: 1, reason: 'external_account_source_preserved', preservedFingerprint: identity, journal }, 0o600, () => assertCurrent())
          if (await fingerprint() !== identity) return fail('CONFLICT', 'external account inode changed before intent quarantine')
          await rm(this.intentFilePath)
          await fsyncDir(this.lockDirPath)
        }),
        rollbackRestoreIntent: () => run(() => rollbackCurrent(true)),
        clearIntent: () => run(async () => {
          await assertCurrent()
          if (commitDurabilityUncertain) return fail('CONFLICT', 'uncertain authority durability requires guarded recovery')
          if (!committed && (await this.readAuthority()).committedLeaseId !== leaseId) return fail('CONFLICT', 'uncommitted recovery evidence cannot be cleared')
          const journal = await this.validatedIntent(holder)
          if (journal?.restore) await this.recoverRestore(journal.restore, true, journal)
          if (journal) await rm(this.intentFilePath)
        }),
        commitAuthority: (patch = {}) => run(async () => {
          const latest = await assertCurrent()
          if (committed || commitDurabilityUncertain) return fail('CONFLICT', 'state writer lease already committed or durability is uncertain')
          const revision = patch.revision !== undefined ? assertInt(patch.revision, latest.revision, Number.MAX_SAFE_INTEGER, 'revision') : patch.incrementRevision === false ? latest.revision : assertInt(latest.revision + 1, latest.revision, Number.MAX_SAFE_INTEGER, 'revision')
          const updated = validateStateAuthority({ ...latest, committedLeaseId: leaseId, revision, fencingToken, updatedAt: new Date().toISOString(), references: { ...latest.references, ...patch.references }, ...(latest.allocatedReferences || patch.allocatedReferences ? { allocatedReferences: { ...latest.allocatedReferences, ...patch.allocatedReferences } } : {}) })
          try { await atomicWriteJson(this.authorityFilePath, updated, 0o640, () => assertCurrent()) }
          catch (error) {
            if (isStateDirectoryDurabilityError(error)) commitDurabilityUncertain = true
            throw error
          }
          committed = true
          const journal = await this.validatedIntent(holder)
          if (journal && !journal.restore) await rm(this.intentFilePath)
          return updated
        }),
        // Acquire changed only the epoch: retain it even when the operation aborts, preventing ABA.
        restorePreAcquireAuthorityIfUncommitted: () => run(async () => { await assertCurrent() }),
        release: () => {
          if (releasePromise) return releasePromise
          closing = true
          releasePromise = tail.then(async () => {
            try {
              const finalAuthority = await assertCurrent()
              const info = await lstat(this.intentFilePath).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
              // Readable post-rename authority is not a durable commit receipt.
              // Preserve this lease's evidence on uncertainty while still releasing
              // the kernel guard. Later guarded recovery remains a separate path.
              if (!commitDurabilityUncertain) {
                if (info && (committed || finalAuthority.committedLeaseId === leaseId)) await this.recoverOrphan(guard)
                else if (!info) await rm(this.lockDirPath, { recursive: true })
              }
              // Any journal, including malformed bytes/failed rollback evidence, remains for guarded recovery.
            } finally { released = true; await guard.release() }
          })
          return releasePromise
        },
      }
      leaseOwnsGuard = true
      return lease
    } finally {
      if (!leaseOwnsGuard) {
        try {
          if (prepared) await rm(prepared, { recursive: true, force: true })
          if (publishedLease && (await this.readLockHolder())?.leaseId === publishedLease) await rm(this.lockDirPath, { recursive: true, force: true })
        } finally { await guard.release() }
      }
    }
  }

  /**
   * Allocates a permanent, monotonic ASCII reference (`JOB-000001`, `BKP-000001`, `MIG-000001`, `GEN-000001`)
   * persisted in `<stateDir>/authority.json` under the cross-process writer lock (A58).
   */
  async allocateReference(
    kind: ReferenceKind,
    opts: { entityId?: string; expectedRevision?: number; fencingToken?: number } = {},
  ): Promise<string> {
    const prefix = normalizeReferenceKind(kind)
    const entityId =
      opts.entityId === undefined || opts.entityId === null
        ? null
        : assertLine(opts.entityId, 128, 'entityId', { allowEmpty: false })

    const lease = await this.acquire()
    try {
      if (opts.fencingToken !== undefined) {
        await lease.assertFencingToken(opts.fencingToken)
      }
      const current = await this.readAuthority()
      if (opts.expectedRevision !== undefined) {
        const expected = assertInt(opts.expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'expectedRevision')
        if (current.revision !== expected) {
          return fail(
            'CONFLICT',
            `revision conflict: expected revision ${expected}, current revision is ${current.revision}`,
            { expectedRevision: expected, currentRevision: current.revision },
          )
        }
      }

      const bindingKey = entityId !== null ? `${prefix}:${entityId}` : null
      if (bindingKey !== null && current.allocatedReferences?.[bindingKey]) {
        return current.allocatedReferences[bindingKey]!.ref
      }

      const nextSeq = (current.references[prefix] ?? 0) + 1
      const ref = formatShortReference(prefix, nextSeq)
      const now = new Date().toISOString()
      const record: AllocatedReferenceRecord = {
        ref,
        kind: prefix,
        sequence: nextSeq,
        entityId,
        allocatedAt: now,
      }
      await lease.commitAuthority({
        incrementRevision: false,
        references: { [prefix]: nextSeq },
        ...(bindingKey !== null ? { allocatedReferences: { [bindingKey]: record } } : {}),
      })
      return ref
    } finally {
      await lease.release()
    }
  }

  /**
   * Reads a previously allocated reference for `(kind, entityId)` without ever allocating on read
   * or falling back to a truncated UUID (A58).
   */
  async getAllocatedReference(kind: ReferenceKind, entityId: string): Promise<string | null> {
    const prefix = normalizeReferenceKind(kind)
    const cleanId = assertLine(entityId, 128, 'entityId', { allowEmpty: false })
    const authority = await this.readAuthority()
    return authority.allocatedReferences?.[`${prefix}:${cleanId}`]?.ref ?? null
  }
}
