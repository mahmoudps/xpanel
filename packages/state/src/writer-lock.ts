import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { assertInt, assertLine, fail } from '@xpanel/core'
import { atomicRemove, atomicWriteJson, readJsonIfExists } from './atomic.ts'
import type {
  AllocatedReferenceRecord,
  ReferenceKind,
  StateAuthorityMetadata,
  WriterLockHolder,
} from './types.ts'
import {
  formatShortReference,
  normalizeReferenceKind,
  validateStateAuthority,
} from './validate-state.ts'

export const AUTHORITY_FILE = 'authority.json'
export const LOCK_DIR = '.lock'
export const LOCK_OWNER_FILE = 'owner.json'
export const LOCK_INTENT_FILE = 'intent.json'

const DEFAULT_ACQUIRE_TIMEOUT_MS = 15_000
const DEFAULT_RETRY_INTERVAL_MS = 15
const DEFAULT_DEAD_OWNER_GRACE_MS = 1_500

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Checks whether an OS process with `pid` is currently alive.
 * Uses `process.kill(pid, 0)` which performs existence check without sending a signal.
 */
export const isProcessAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code === 'EPERM') return true
    return false
  }
}

export interface WriteIntentBackup {
  relPath: string
  existed: boolean
  contentBase64?: string
}

export interface WriteIntentRecord {
  op: string
  fencingToken: number
  baseRevision: number
  createdRelPaths: string[]
  backups: WriteIntentBackup[]
  recordedAt: string
}

export interface WriterLockOptions {
  acquireTimeoutMs?: number
  retryIntervalMs?: number
  deadOwnerGraceMs?: number
  isPidAlive?: (pid: number) => boolean
}

export interface WriterLease {
  readonly pid: number
  readonly fencingToken: number
  readonly leaseId: string
  readonly acquiredAt: string
  readonly initialAuthority: StateAuthorityMetadata
  readonly preAcquireAuthorityRaw: string | null
  assertFencingToken(expectedToken?: number): Promise<StateAuthorityMetadata>
  recordIntent(intent: Omit<WriteIntentRecord, 'fencingToken' | 'baseRevision' | 'recordedAt'>): Promise<void>
  clearIntent(): Promise<void>
  commitAuthority(patch?: {
    incrementRevision?: boolean
    revision?: number
    references?: Record<string, number>
    allocatedReferences?: Record<string, AllocatedReferenceRecord>
  }): Promise<StateAuthorityMetadata>
  restorePreAcquireAuthorityIfUncommitted(): Promise<void>
  release(): Promise<void>
}

const defaultAuthority = (): StateAuthorityMetadata => ({
  revision: 0,
  fencingToken: 0,
  updatedAt: new Date(0).toISOString(),
  references: {},
})

export class WriterLock {
  readonly stateDir: string
  private readonly acquireTimeoutMs: number
  private readonly retryIntervalMs: number
  private readonly deadOwnerGraceMs: number
  private readonly isPidAlive: (pid: number) => boolean

  constructor(stateDir: string, opts: WriterLockOptions = {}) {
    this.stateDir = stateDir
    this.acquireTimeoutMs = opts.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS
    this.retryIntervalMs = opts.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS
    this.deadOwnerGraceMs = opts.deadOwnerGraceMs ?? DEFAULT_DEAD_OWNER_GRACE_MS
    this.isPidAlive = opts.isPidAlive ?? isProcessAlive
  }

  get lockDirPath(): string {
    return join(this.stateDir, LOCK_DIR)
  }

  get ownerFilePath(): string {
    return join(this.lockDirPath, LOCK_OWNER_FILE)
  }

  get intentFilePath(): string {
    return join(this.lockDirPath, LOCK_INTENT_FILE)
  }

  get authorityFilePath(): string {
    return join(this.stateDir, AUTHORITY_FILE)
  }

  async readAuthority(): Promise<StateAuthorityMetadata> {
    const raw = await readJsonIfExists<unknown>(this.authorityFilePath)
    if (raw === null) return defaultAuthority()
    return validateStateAuthority(raw)
  }

  async readLockHolder(): Promise<WriterLockHolder | null> {
    const raw = await readJsonIfExists<unknown>(this.ownerFilePath)
    if (raw === null || typeof raw !== 'object') return null
    const o = raw as Record<string, unknown>
    if (
      typeof o.pid !== 'number' ||
      !Number.isSafeInteger(o.pid) ||
      typeof o.fencingToken !== 'number' ||
      !Number.isSafeInteger(o.fencingToken) ||
      typeof o.acquiredAt !== 'string' ||
      typeof o.leaseId !== 'string'
    ) {
      return null
    }
    return {
      pid: o.pid,
      fencingToken: o.fencingToken,
      acquiredAt: o.acquiredAt,
      leaseId: o.leaseId,
    }
  }

  /**
   * Verifies that `expectedToken` is still the active fencing token in both
   * `<stateDir>/authority.json` and `<stateDir>/.lock/owner.json`.
   * Throws `CONFLICT` if a newer writer has acquired the lock or superseded the token.
   */
  async assertFencingToken(expectedToken: number, expectedLeaseId?: string): Promise<StateAuthorityMetadata> {
    if (typeof expectedToken !== 'number' || !Number.isSafeInteger(expectedToken) || expectedToken < 1) {
      return fail('VALIDATION', 'fencingToken must be a positive safe integer', { fencingToken: expectedToken })
    }
    const [authority, holder] = await Promise.all([this.readAuthority(), this.readLockHolder()])
    if (authority.fencingToken !== expectedToken) {
      return fail(
        'CONFLICT',
        `stale writer fencing token ${expectedToken} rejected; current authority token is ${authority.fencingToken}`,
        { expectedFencingToken: expectedToken, currentFencingToken: authority.fencingToken },
      )
    }
    if (!holder || holder.fencingToken !== expectedToken) {
      return fail(
        'CONFLICT',
        `writer lock for fencing token ${expectedToken} is no longer held`,
        { expectedFencingToken: expectedToken, activeFencingToken: holder?.fencingToken ?? null },
      )
    }
    if (expectedLeaseId !== undefined && holder.leaseId !== expectedLeaseId) {
      return fail(
        'CONFLICT',
        `writer lease ${expectedLeaseId} was superseded by ${holder.leaseId}`,
        { expectedFencingToken: expectedToken },
      )
    }
    return authority
  }

  /**
   * Recovers any uncommitted write intent left behind by a crashed/terminated writer process.
   * Never rolls back `uid-allocator.json` so burned UIDs remain permanently reserved.
   */
  private async recoverUncommittedIntentIfNeeded(): Promise<void> {
    const intent = await readJsonIfExists<WriteIntentRecord>(this.intentFilePath).catch(() => null)
    if (!intent || typeof intent !== 'object') return
    const authority = await this.readAuthority().catch(() => defaultAuthority())
    // If authority.revision is still at baseRevision, the crashed writer never committed.
    if (authority.revision <= intent.baseRevision) {
      for (const relPath of intent.createdRelPaths ?? []) {
        if (!relPath || relPath === 'uid-allocator.json' || relPath === AUTHORITY_FILE) continue
        await atomicRemove(join(this.stateDir, relPath)).catch(() => undefined)
      }
      for (const backup of intent.backups ?? []) {
        if (!backup.relPath || backup.relPath === 'uid-allocator.json' || backup.relPath === AUTHORITY_FILE) continue
        const target = join(this.stateDir, backup.relPath)
        if (!backup.existed) {
          await atomicRemove(target).catch(() => undefined)
        } else if (typeof backup.contentBase64 === 'string') {
          const parsed = JSON.parse(Buffer.from(backup.contentBase64, 'base64').toString('utf8')) as unknown
          await atomicWriteJson(target, parsed).catch(() => undefined)
        }
      }
    }
    await rm(this.intentFilePath, { force: true }).catch(() => undefined)
  }

  /**
   * Atomically reclaims `<stateDir>/.lock` ONLY after verifying the lock owner PID is dead
   * (or when explicitly invoked via `forceRecoverLease`).
   */
  private async reclaimLockDir(): Promise<boolean> {
    await this.recoverUncommittedIntentIfNeeded()
    const reclaimPath = join(this.stateDir, `.lock-reclaim-${process.pid}-${randomUUID()}`)
    try {
      await rename(this.lockDirPath, reclaimPath)
    } catch {
      return false
    }
    await rm(reclaimPath, { recursive: true, force: true }).catch(() => undefined)
    return true
  }

  /**
   * Explicitly revokes the current lease and bumps the monotonic fencing token in `authority.json`.
   * Used when an operator or supervisor fences a paused/unresponsive writer so any delayed write
   * from the old lease is deterministically rejected by `assertFencingToken`.
   */
  async forceRecoverLease(): Promise<StateAuthorityMetadata> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o750 })
    await this.reclaimLockDir()
    const current = await this.readAuthority()
    const next: StateAuthorityMetadata = {
      ...current,
      fencingToken: current.fencingToken + 1,
      updatedAt: new Date().toISOString(),
    }
    await atomicWriteJson(this.authorityFilePath, next)
    return next
  }

  /**
   * Waits until no live external process holds `.lock`. If `.lock` belongs to a dead process,
   * recovers its uncommitted intent and cleans up the dead lock.
   */
  async waitForUnlocked(timeoutMs = this.acquireTimeoutMs): Promise<void> {
    const startMs = Date.now()
    while (true) {
      let lockStat
      try {
        lockStat = await stat(this.lockDirPath)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
        throw err
      }
      const holder = await this.readLockHolder().catch(() => null)
      if (holder) {
        if (!this.isPidAlive(holder.pid)) {
          await this.reclaimLockDir()
          return
        }
      } else if (Date.now() - lockStat.mtimeMs > this.deadOwnerGraceMs) {
        await this.reclaimLockDir()
        return
      }
      if (Date.now() - startMs >= timeoutMs) {
        return fail('CONFLICT', 'timed out waiting for active state writer lock to finish', {
          holderPid: holder?.pid ?? null,
          fencingToken: holder?.fencingToken ?? null,
        })
      }
      await sleepMs(this.retryIntervalMs)
    }
  }

  /**
   * Acquires the cross-process state writer lock using atomic `mkdir(<stateDir>/.lock)`,
   * issues a strictly increasing `fencingToken` persisted in `authority.json` and `.lock/owner.json`,
   * and never steals a lock while the owner PID is alive.
   */
  async acquire(opts?: { acquireTimeoutMs?: number }): Promise<WriterLease> {
    const timeoutMs = opts?.acquireTimeoutMs ?? this.acquireTimeoutMs
    const startMs = Date.now()
    await mkdir(this.stateDir, { recursive: true, mode: 0o750 })

    while (true) {
      try {
        await mkdir(this.lockDirPath, { mode: 0o700 })
        break
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | null)?.code
        if (code !== 'EEXIST' && code !== 'EACCES' && code !== 'EPERM' && code !== 'EBUSY') {
          throw err
        }

        const holder = await this.readLockHolder().catch(() => null)
        if (holder !== null) {
          // Never steal a lock based on wall-clock timeout while the owner PID is alive.
          if (!this.isPidAlive(holder.pid)) {
            await this.reclaimLockDir()
            continue
          }
        } else {
          // Owner file not yet written or process died immediately after mkdir('.lock')
          const lockStat = await stat(this.lockDirPath).catch(() => null)
          if (lockStat && Date.now() - lockStat.mtimeMs > this.deadOwnerGraceMs) {
            await this.reclaimLockDir()
            continue
          }
        }

        if (Date.now() - startMs >= timeoutMs) {
          return fail('CONFLICT', 'timed out waiting for cross-process state writer lock', {
            holderPid: holder?.pid ?? null,
            fencingToken: holder?.fencingToken ?? null,
            timeoutMs,
          })
        }

        const jitter = Math.floor(Math.random() * 8)
        await sleepMs(this.retryIntervalMs + jitter)
      }
    }

    // We now exclusively own `.lock`. Recover any leftover uncommitted intent if present.
    await this.recoverUncommittedIntentIfNeeded()

    const preAcquireAuthorityRaw = await readFile(this.authorityFilePath, 'utf8').catch((err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    })
    const currentAuthority =
      preAcquireAuthorityRaw === null ? defaultAuthority() : validateStateAuthority(JSON.parse(preAcquireAuthorityRaw))

    const fencingToken = currentAuthority.fencingToken + 1
    const acquiredAt = new Date().toISOString()
    const leaseId = randomUUID()
    const holder: WriterLockHolder = {
      pid: process.pid,
      fencingToken,
      acquiredAt,
      leaseId,
    }
    const nextAuthority: StateAuthorityMetadata = {
      ...currentAuthority,
      fencingToken,
      updatedAt: acquiredAt,
    }

    try {
      await atomicWriteJson(this.ownerFilePath, holder, 0o600)
      await atomicWriteJson(this.authorityFilePath, nextAuthority, 0o640)
    } catch (err) {
      await rm(this.lockDirPath, { recursive: true, force: true }).catch(() => undefined)
      throw err
    }

    let released = false
    let committed = false

    const assertLeaseToken = async (expectedToken = fencingToken): Promise<StateAuthorityMetadata> => {
      if (expectedToken !== fencingToken) {
        return fail(
          'CONFLICT',
          `fencing token mismatch: caller expected ${expectedToken}, active lease token is ${fencingToken}`,
          { expectedFencingToken: expectedToken, currentFencingToken: fencingToken },
        )
      }
      return this.assertFencingToken(fencingToken, leaseId)
    }

    const lease: WriterLease = {
      pid: process.pid,
      fencingToken,
      leaseId,
      acquiredAt,
      initialAuthority: currentAuthority,
      preAcquireAuthorityRaw,
      assertFencingToken: assertLeaseToken,
      recordIntent: async (intent) => {
        await assertLeaseToken()
        const record: WriteIntentRecord = {
          ...intent,
          fencingToken,
          baseRevision: currentAuthority.revision,
          recordedAt: new Date().toISOString(),
        }
        await atomicWriteJson(this.intentFilePath, record, 0o600)
      },
      clearIntent: async () => {
        await rm(this.intentFilePath, { force: true }).catch(() => undefined)
      },
      commitAuthority: async (patch = {}) => {
        const latest = await assertLeaseToken()
        const nextRevision =
          patch.revision !== undefined
            ? assertInt(patch.revision, latest.revision, Number.MAX_SAFE_INTEGER, 'revision')
            : patch.incrementRevision !== false
              ? latest.revision + 1
              : latest.revision
        const mergedReferences = patch.references
          ? { ...latest.references, ...patch.references }
          : { ...latest.references }
        const mergedAllocated =
          patch.allocatedReferences || latest.allocatedReferences
            ? { ...(latest.allocatedReferences ?? {}), ...(patch.allocatedReferences ?? {}) }
            : undefined
        const updated: StateAuthorityMetadata = {
          revision: nextRevision,
          fencingToken,
          updatedAt: new Date().toISOString(),
          references: mergedReferences,
          ...(mergedAllocated && Object.keys(mergedAllocated).length > 0
            ? { allocatedReferences: mergedAllocated }
            : {}),
        }
        await atomicWriteJson(this.authorityFilePath, updated, 0o640, async () => {
          await assertLeaseToken()
        })
        await rm(this.intentFilePath, { force: true }).catch(() => undefined)
        committed = true
        return updated
      },
      restorePreAcquireAuthorityIfUncommitted: async () => {
        if (committed) return
        const holderNow = await this.readLockHolder().catch(() => null)
        if (!holderNow || holderNow.leaseId !== leaseId || holderNow.fencingToken !== fencingToken) return
        if (preAcquireAuthorityRaw === null) {
          await rm(this.authorityFilePath, { force: true }).catch(() => undefined)
        } else {
          await atomicWriteJson(this.authorityFilePath, JSON.parse(preAcquireAuthorityRaw), 0o640).catch(() => undefined)
        }
      },
      release: async () => {
        if (released) return
        released = true
        const holderNow = await this.readLockHolder().catch(() => null)
        if (holderNow && holderNow.leaseId === leaseId) {
          await rm(this.intentFilePath, { force: true }).catch(() => undefined)
          await rm(this.ownerFilePath, { force: true }).catch(() => undefined)
          for (let attempt = 0; attempt < 5; attempt++) {
            try {
              await rm(this.lockDirPath, { recursive: true, force: true })
              break
            } catch {
              await sleepMs(5 * (attempt + 1))
            }
          }
        }
      },
    }

    return lease
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
