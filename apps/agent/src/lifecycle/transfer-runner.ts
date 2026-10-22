import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { auditEntry, fail, isXpanelError } from '@xpanel/core'
import type { Engine, OsProfile, PhpSettings, Principal, ServiceRole } from '@xpanel/core'
import {
  assertNoSecrets,
  assertNoSharedRestart,
  buildApplyPlan,
  buildReview,
  countActiveTransfers,
  createTransferSession,
  importAccountArchive,
  reviewDigest,
  sharedUnits,
  transition,
} from '@xpanel/lifecycle'
import type {
  AccountPhase,
  AuditPort,
  Body,
  ByteSource,
  ChecksumEntry,
  ClockPort,
  FsPort,
  ImportedAccount,
  ImportSink,
  LocalInventory,
  Resolution,
  SinkItem,
  SourceAccount,
  SourcePlan,
  TransferEvent,
  TransferReview,
  TransferSession,
} from '@xpanel/lifecycle'

export type TransferCheckpointStage = 'export' | 'copy' | 'inspect' | 'import' | 'reconcile' | 'cutover'

export const TRANSFER_STAGE_ORDER: readonly TransferCheckpointStage[] = [
  'export',
  'copy',
  'inspect',
  'import',
  'reconcile',
  'cutover',
]

export interface AccountTransferCheckpoint {
  sourceUsername: string
  targetUsername: string
  completedStages: TransferCheckpointStage[]
  archivePath: string | null
  archiveSha256: string | null
  archiveBytes: number
  partChecksums: ChecksumEntry[]
  importedAccountId: string | null
  generationId: number | null
  cutoverAt: string | null
  postCutoverWrites: { kind: 'db' | 'mail' | 'file'; detail: string; at: string }[]
  rolledBackAt: string | null
}

export interface TransferLeaseState {
  leaseOwner: string | null
  fencingToken: number
  leaseExpiresAt: string | null
  attempt: number
}

export interface DurableTransferRecord {
  session: TransferSession
  lease: TransferLeaseState
  idempotencyKey: string | null
  accountCheckpoints: Record<string, AccountTransferCheckpoint>
}

export interface SourceNodePort {
  /** Returns the live SSH host key fingerprint or HTTPS TLS fingerprint of the source server. */
  probeSourceFingerprint(session: TransferSession): Promise<string>
  /** Verifies that the actor/token still owns the selected accounts on the source node. */
  verifySourceOwnership(session: TransferSession, accounts: readonly string[]): Promise<boolean>
  /** Queries the source server identity and inventory. */
  fetchInventory(session: TransferSession): Promise<{
    source: { hostname: string; version: string }
    accounts: SourceAccount[]
    plans: SourcePlan[]
  }>
  /** Exports and streams the account archive from the source server. */
  exportAndStreamAccount(session: TransferSession, sourceUsername: string): Promise<{
    stream: ByteSource
    expectedSha256: string
    partChecksums: ChecksumEntry[]
  }>
}

export interface DestinationApplyPort {
  getLiveLocalInventory(): Promise<LocalInventory>
  ensurePlan(sourcePlan: string, targetPlan: string): Promise<string>
  /**
   * Applies the imported account idempotently: if the account/DB rows/mail messages from
   * this transfer session were already written before a crash, updates in place without duplicating.
   */
  applyImportedAccountIdempotent(input: {
    sessionId: string
    imported: ImportedAccount
    stagedItems: readonly { item: SinkItem; content: Buffer; sha256: string }[]
  }): Promise<{ accountId: string; dbRowsApplied: number; mailMessagesApplied: number }>
  reconcileReloadOnly(reason: string, reloadUnits: readonly string[]): Promise<{ generationId: number }>
  switchCutover(sessionId: string, sourceUsername: string, targetUsername: string): Promise<void>
  revertCutover(sessionId: string, sourceUsername: string, targetUsername: string): Promise<void>
}

export interface DurableTransferRunnerPorts {
  fs: FsPort
  sourceNode: SourceNodePort
  destination: DestinationApplyPort
  os: OsProfile
  engine: Engine
  installedServices: readonly ServiceRole[]
  defaultPhp: PhpSettings
  serverIpv4: string
  stateDir?: string
  stagingDir?: string
  clock: ClockPort
  audit?: AuditPort
}

const DEFAULT_TRANSFER_STATE_DIR = '/var/lib/xpanel/transfers/sessions'
const DEFAULT_TRANSFER_STAGING_DIR = '/var/lib/xpanel/transfers/staging'
const DEFAULT_LEASE_MS = 30_000

class IdempotentTransferSink implements ImportSink {
  readonly items: { item: SinkItem; content: Buffer; sha256: string }[] = []
  private readonly seenKeys = new Set<string>()

  async put(item: SinkItem, body: Body): Promise<string> {
    const hash = createHash('sha256')
    const chunks: Buffer[] = []
    for await (const c of body) {
      const b = Buffer.from(c.buffer, c.byteOffset, c.byteLength)
      hash.update(b)
      chunks.push(b)
    }
    const content = Buffer.concat(chunks)
    const sha256 = hash.digest('hex')
    const dedupKey = `${item.part}:${item.path}`
    if (!this.seenKeys.has(dedupKey)) {
      this.seenKeys.add(dedupKey)
      this.items.push({ item: structuredClone(item), content, sha256 })
    }
    return `txsink-${this.items.length}`
  }

  async abort(): Promise<void> {
    this.items.length = 0
    this.seenKeys.clear()
  }
}

export class DurableTransferRunner {
  private readonly ports: DurableTransferRunnerPorts
  private readonly stateDir: string
  private readonly stagingDir: string
  /** Optional fault-injection hook triggered right after a stage checkpoint is persisted on disk. */
  onStageCheckpointed: ((sessionId: string, account: string, stage: TransferCheckpointStage) => Promise<void> | void) | null = null

  constructor(ports: DurableTransferRunnerPorts) {
    this.ports = ports
    this.stateDir = ports.stateDir ?? DEFAULT_TRANSFER_STATE_DIR
    this.stagingDir = ports.stagingDir ?? DEFAULT_TRANSFER_STAGING_DIR
  }

  private sessionFilePath(sessionId: string): string {
    return posix.join(this.stateDir, `${sessionId}.json`)
  }

  private async saveRecord(record: DurableTransferRecord): Promise<void> {
    assertNoSecrets(record.session.auth, 'session.auth')
    await this.ports.fs.mkdirp(this.stateDir, 0o700)
    const path = this.sessionFilePath(record.session.id)
    const tmp = `${path}.tmp-${this.ports.clock.now().getTime()}-${Math.random().toString(36).slice(2, 8)}`
    if (await this.ports.fs.exists(tmp)) await this.ports.fs.remove(tmp)
    await this.ports.fs.writeFileExclusive(tmp, `${JSON.stringify(record, null, 2)}\n`, 0o600)
    await this.ports.fs.rename(tmp, path)
  }

  async loadRecord(sessionId: string): Promise<DurableTransferRecord | null> {
    const raw = await this.ports.fs.readFile(this.sessionFilePath(sessionId))
    if (raw === null) return null
    return JSON.parse(raw) as DurableTransferRecord
  }

  async listRecords(): Promise<DurableTransferRecord[]> {
    const out: DurableTransferRecord[] = []
    if (!(await this.ports.fs.exists(this.stateDir))) return out
    return out
  }

  async countActive(knownSessionIds: readonly string[]): Promise<number> {
    const sessions: TransferSession[] = []
    for (const id of knownSessionIds) {
      const r = await this.loadRecord(id)
      if (r) sessions.push(r.session)
    }
    return countActiveTransfers(sessions)
  }

  private async verifySourceIdentityPin(session: TransferSession): Promise<void> {
    const actualFp = await this.ports.sourceNode.probeSourceFingerprint(session)
    if (session.auth.kind === 'ssh-key') {
      if (actualFp !== session.auth.hostKeyFingerprint) {
        fail('FORBIDDEN', `source SSH host key mismatch for ${session.auth.host}: expected ${session.auth.hostKeyFingerprint}, got ${actualFp}`)
      }
    } else if (session.auth.tlsFingerprint !== null && actualFp !== session.auth.tlsFingerprint) {
      fail('FORBIDDEN', `source TLS fingerprint mismatch for ${session.auth.url}: expected ${session.auth.tlsFingerprint}, got ${actualFp}`)
    }
  }

  /**
   * Creates or deduplicates a durable transfer session on disk.
   */
  async createSession(input: {
    id: string
    actor: Principal
    auth: unknown
    idempotencyKey?: string
  }): Promise<DurableTransferRecord> {
    if (input.actor.kind !== 'root' && input.actor.kind !== 'reseller') {
      fail('FORBIDDEN', 'only root or an authorized reseller may start a transfer session')
    }
    const existing = await this.loadRecord(input.id)
    if (existing) {
      if (input.idempotencyKey && existing.idempotencyKey === input.idempotencyKey) {
        return existing
      }
      fail('CONFLICT', `transfer session ${input.id} already exists`)
    }
    const now = this.ports.clock.now().toISOString()
    const session = createTransferSession({
      id: input.id,
      actor: input.actor.username,
      now,
      auth: input.auth,
    })
    const record: DurableTransferRecord = {
      session,
      lease: {
        leaseOwner: null,
        fencingToken: 0,
        leaseExpiresAt: null,
        attempt: 0,
      },
      idempotencyKey: input.idempotencyKey ?? null,
      accountCheckpoints: {},
    }
    await this.saveRecord(record)
    return record
  }

  /**
   * Connects to the source node after verifying its pinned host key / TLS fingerprint,
   * fetches inventory, and persists the updated session on disk.
   */
  async connectAndInventory(sessionId: string): Promise<DurableTransferRecord> {
    const rec = await this.mustLoad(sessionId)
    await this.verifySourceIdentityPin(rec.session)
    const inv = await this.ports.sourceNode.fetchInventory(rec.session)
    const now = this.ports.clock.now().toISOString()
    rec.session = transition(rec.session, { type: 'connected', source: inv.source }, now)
    rec.session = transition(rec.session, { type: 'inventory', accounts: inv.accounts, plans: inv.plans }, now)
    await this.saveRecord(rec)
    return rec
  }

  async selectAndReview(
    sessionId: string,
    input: {
      accounts: string[]
      plans: string[]
      resolutions?: Record<string, Resolution>
    },
  ): Promise<{ record: DurableTransferRecord; review: TransferReview; digest: string }> {
    const rec = await this.mustLoad(sessionId)
    const local = await this.ports.destination.getLiveLocalInventory()
    const now = this.ports.clock.now().toISOString()
    rec.session = transition(rec.session, { type: 'select', accounts: input.accounts, plans: input.plans, local }, now)
    if (input.resolutions) {
      for (const [conflictId, resolution] of Object.entries(input.resolutions)) {
        rec.session = transition(rec.session, { type: 'resolve', conflictId, resolution }, now)
      }
    }
    rec.session = transition(rec.session, { type: 'review' }, now)
    const review = buildReview(rec.session)
    const digest = rec.session.reviewDigest!
    await this.saveRecord(rec)
    return { record: rec, review, digest }
  }

  async confirmSession(sessionId: string, confirmDigest: string): Promise<DurableTransferRecord> {
    const rec = await this.mustLoad(sessionId)
    const liveLocal = await this.ports.destination.getLiveLocalInventory()
    // Re-verify against live destination inventory so new accounts/domains created after review are caught!
    const review = buildReview(rec.session)
    for (const a of review.accounts) {
      if (liveLocal.usernames.includes(a.target)) {
        fail('CONFLICT', `stale review: account ${a.target} was created on the destination since the review`)
      }
      for (const d of a.domains) {
        if (liveLocal.domains.includes(d)) {
          fail('CONFLICT', `stale review: domain ${d} was created on the destination since the review`)
        }
      }
    }
    const now = this.ports.clock.now().toISOString()
    rec.session = transition(rec.session, { type: 'confirm', digest: confirmDigest }, now)
    for (const a of review.accounts) {
      rec.accountCheckpoints[a.source] = {
        sourceUsername: a.source,
        targetUsername: a.target,
        completedStages: [],
        archivePath: null,
        archiveSha256: null,
        archiveBytes: 0,
        partChecksums: [],
        importedAccountId: null,
        generationId: null,
        cutoverAt: null,
        postCutoverWrites: [],
        rolledBackAt: null,
      }
    }
    await this.saveRecord(rec)
    return rec
  }

  /**
   * Acquires or steals an expired worker lease on the transfer session, incrementing
   * the monotonic `fencingToken`.
   */
  async acquireLease(sessionId: string, workerId: string, leaseDurationMs = DEFAULT_LEASE_MS): Promise<{ fencingToken: number; record: DurableTransferRecord }> {
    const rec = await this.mustLoad(sessionId)
    const nowDate = this.ports.clock.now()
    const nowIso = nowDate.toISOString()
    if (
      rec.lease.leaseOwner !== null &&
      rec.lease.leaseOwner !== workerId &&
      rec.lease.leaseExpiresAt !== null &&
      rec.lease.leaseExpiresAt > nowIso
    ) {
      fail('CONFLICT', `transfer session ${sessionId} already has an active lease owned by ${rec.lease.leaseOwner}`)
    }
    rec.lease.leaseOwner = workerId
    rec.lease.fencingToken += 1
    rec.lease.attempt += 1
    rec.lease.leaseExpiresAt = new Date(nowDate.getTime() + leaseDurationMs).toISOString()
    await this.saveRecord(rec)
    return { fencingToken: rec.lease.fencingToken, record: rec }
  }

  private assertValidLease(rec: DurableTransferRecord, workerId: string, fencingToken: number): void {
    const nowIso = this.ports.clock.now().toISOString()
    if (rec.lease.fencingToken !== fencingToken) {
      fail('CONFLICT', `stale fencing token ${fencingToken} rejected (current=${rec.lease.fencingToken})`)
    }
    if (rec.lease.leaseOwner !== workerId) {
      fail('CONFLICT', `lease for session ${rec.session.id} is owned by ${String(rec.lease.leaseOwner)}, not ${workerId}`)
    }
    if (!rec.lease.leaseExpiresAt || rec.lease.leaseExpiresAt <= nowIso) {
      fail('CONFLICT', `worker lease for session ${rec.session.id} has expired`)
    }
  }

  /**
   * Executes or resumes a confirmed transfer session under the given worker lease and fencing token.
   * Each stage (`export` -> `copy` -> `inspect` -> `import` -> `reconcile` -> `cutover`) is
   * checkpointed on disk after its side effect is verified.
   */
  async executeOrResumeTransfer(input: {
    sessionId: string
    workerId: string
    fencingToken: number
  }): Promise<DurableTransferRecord> {
    let rec = await this.mustLoad(input.sessionId)
    this.assertValidLease(rec, input.workerId, input.fencingToken)

    if (rec.session.state !== 'applying') {
      fail('PRECONDITION_FAILED', `session ${input.sessionId} is in state ${rec.session.state}, expected applying`)
    }

    // Build and verify the apply plan (enforces assertNoSharedRestart)
    const applySteps = buildApplyPlan(rec.session, {
      os: this.ports.os,
      engine: this.ports.engine,
      services: this.ports.installedServices,
      stagingRoot: this.stagingDir,
    })
    assertNoSharedRestart(applySteps, sharedUnits(this.ports.os))

    const review = buildReview(rec.session)
    if (reviewDigest(review) !== rec.session.reviewDigest) {
      fail('CONFLICT', 'transfer review digest changed since confirmation')
    }

    // Ensure plans exist on destination
    for (const p of review.plans) {
      if (p.action !== 'map') {
        await this.ports.destination.ensurePlan(p.source, p.target)
      }
    }

    const sessionStagingDir = posix.join(this.stagingDir, rec.session.id)
    await this.ports.fs.mkdirp(sessionStagingDir, 0o700)

    for (const acct of review.accounts) {
      rec = await this.mustLoad(input.sessionId)
      this.assertValidLease(rec, input.workerId, input.fencingToken)
      await this.verifySourceIdentityPin(rec.session)
      const owns = await this.ports.sourceNode.verifySourceOwnership(rec.session, [acct.source])
      if (!owns) {
        fail('FORBIDDEN', `source ownership of account ${acct.source} was revoked during transfer`)
      }

      const cp = rec.accountCheckpoints[acct.source]
      if (!cp) return fail('NOT_FOUND', `missing checkpoint record for ${acct.source}`)
      const archiveFile = posix.join(sessionStagingDir, `${acct.source}.tar.gz`)

      // Stage 1 & 2: export & copy (resumable if archiveFile on disk already matches recorded sha256)
      let needCopy = !cp.completedStages.includes('copy') || !(await this.ports.fs.exists(archiveFile))
      if (!needCopy && cp.archiveSha256) {
        const diskSha = await this.ports.fs.sha256(archiveFile)
        if (diskSha !== cp.archiveSha256) needCopy = true
      }

      if (needCopy) {
        await this.advancePhaseIfBehind(rec, acct.source, 'exporting')
        const exported = await this.ports.sourceNode.exportAndStreamAccount(rec.session, acct.source)
        await this.recordStageCheckpoint(rec, input.workerId, input.fencingToken, acct.source, 'export')

        const chunks: Buffer[] = []
        const hash = createHash('sha256')
        let bytes = 0
        for await (const chunk of exported.stream) {
          this.assertValidLease(rec, input.workerId, input.fencingToken)
          const b = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          bytes += b.length
          hash.update(b)
          chunks.push(b)
        }
        const actualSha = hash.digest('hex')
        if (actualSha !== exported.expectedSha256) {
          fail('VALIDATION', `copied archive checksum mismatch for ${acct.source}: expected ${exported.expectedSha256}, got ${actualSha}`)
        }
        if (await this.ports.fs.exists(archiveFile)) await this.ports.fs.remove(archiveFile)
        await this.ports.fs.writeFileExclusive(archiveFile, Buffer.concat(chunks).toString('base64'), 0o600)
        cp.archivePath = archiveFile
        cp.archiveSha256 = actualSha
        cp.archiveBytes = bytes
        cp.partChecksums = exported.partChecksums
        await this.advancePhaseIfBehind(rec, acct.source, 'copying', bytes)
        await this.recordStageCheckpoint(rec, input.workerId, input.fencingToken, acct.source, 'copy')
      }

      // Stage 3 & 4: inspect & import
      if (!cp.completedStages.includes('import')) {
        await this.advancePhaseIfBehind(rec, acct.source, 'importing')
        const rawBase64 = await this.ports.fs.readFile(archiveFile)
        if (!rawBase64) return fail('NOT_FOUND', `staged archive missing at ${archiveFile}`)
        const archiveBuf = Buffer.from(rawBase64, 'base64')
        const verifySha = createHash('sha256').update(archiveBuf).digest('hex')
        if (verifySha !== cp.archiveSha256) {
          fail('VALIDATION', `staged archive tampered before import for ${acct.source}`)
        }

        const sink = new IdempotentTransferSink()
        const liveLocal = await this.ports.destination.getLiveLocalInventory()
        // Exclude targetUsername if an interrupted earlier attempt already created it for THIS session
        const filteredLocal: LocalInventory = {
          ...liveLocal,
          usernames: liveLocal.usernames.filter((u) => u !== acct.target),
          domains: liveLocal.domains.filter((d) => !acct.domains.includes(d)),
        }
        let idCounter = 0
        const imported = await importAccountArchive(
          {
            async *[Symbol.asyncIterator]() {
              yield archiveBuf
            },
          },
          {
            local: filteredLocal,
            planId: `plan-${acct.plan}`,
            ownerId: null,
            ipv4: this.ports.serverIpv4,
            now: this.ports.clock.now().toISOString(),
            ids: () => `tx-${rec.session.id}-${acct.target}-${++idCounter}`,
            defaultPhp: this.ports.defaultPhp,
            targetUsername: acct.target,
            dropDomains: acct.droppedDomains,
            sink,
          },
        )
        await this.recordStageCheckpoint(rec, input.workerId, input.fencingToken, acct.source, 'inspect')

        const applied = await this.ports.destination.applyImportedAccountIdempotent({
          sessionId: rec.session.id,
          imported,
          stagedItems: sink.items,
        })
        cp.importedAccountId = applied.accountId
        await this.recordStageCheckpoint(rec, input.workerId, input.fencingToken, acct.source, 'import')
      }

      // Stage 5: reconcile (reload-only!)
      if (!cp.completedStages.includes('reconcile')) {
        await this.advancePhaseIfBehind(rec, acct.source, 'reconciling')
        const reloadList = applySteps
          .filter((s): s is Extract<typeof s, { kind: 'systemd' }> => s.kind === 'systemd' && s.verb === 'reload')
          .map((s) => s.unit)
        const recRes = await this.ports.destination.reconcileReloadOnly(
          `transfer ${rec.session.id}: ${acct.source} -> ${acct.target}`,
          [...new Set(reloadList)],
        )
        cp.generationId = recRes.generationId
        await this.recordStageCheckpoint(rec, input.workerId, input.fencingToken, acct.source, 'reconcile')
      }

      // Stage 6: cutover
      if (!cp.completedStages.includes('cutover')) {
        await this.ports.destination.switchCutover(rec.session.id, acct.source, acct.target)
        cp.cutoverAt = this.ports.clock.now().toISOString()
        await this.advancePhaseIfBehind(rec, acct.source, 'done')
        await this.recordStageCheckpoint(rec, input.workerId, input.fencingToken, acct.source, 'cutover')
        if (await this.ports.fs.exists(archiveFile)) {
          await this.ports.fs.remove(archiveFile)
        }
      }
    }

    rec = await this.mustLoad(input.sessionId)
    this.assertValidLease(rec, input.workerId, input.fencingToken)
    if (rec.session.state === 'applying') {
      rec.session = transition(rec.session, { type: 'complete' }, this.ports.clock.now().toISOString())
      await this.saveRecord(rec)
    }

    await this.ports.audit?.record(
      auditEntry({ kind: 'root', id: 'p-root', username: rec.session.actor }, 'transfer.completed', rec.session.id, {
        accounts: review.accounts.map((a) => `${a.source}->${a.target}`),
      }, 'ok', { now: this.ports.clock.now() }),
    )

    return rec
  }

  private async advancePhaseIfBehind(
    rec: DurableTransferRecord,
    sourceAccount: string,
    targetPhase: AccountPhase,
    bytes?: number,
  ): Promise<void> {
    const order: readonly AccountPhase[] = ['pending', 'exporting', 'copying', 'importing', 'reconciling', 'done']
    const cur = rec.session.progress[sourceAccount]?.phase ?? 'pending'
    if (order.indexOf(targetPhase) > order.indexOf(cur)) {
      rec.session = transition(
        rec.session,
        { type: 'progress', account: sourceAccount, phase: targetPhase, ...(bytes !== undefined ? { bytes } : {}) },
        this.ports.clock.now().toISOString(),
      )
      await this.saveRecord(rec)
    }
  }

  private async recordStageCheckpoint(
    rec: DurableTransferRecord,
    workerId: string,
    fencingToken: number,
    sourceAccount: string,
    stage: TransferCheckpointStage,
  ): Promise<void> {
    this.assertValidLease(rec, workerId, fencingToken)
    const cp = rec.accountCheckpoints[sourceAccount]!
    if (!cp.completedStages.includes(stage)) {
      cp.completedStages.push(stage)
    }
    await this.saveRecord(rec)
    if (this.onStageCheckpointed) {
      await this.onStageCheckpointed(rec.session.id, sourceAccount, stage)
    }
  }

  /**
   * Records a post-cutover write on the destination account (e.g., new database write or
   * incoming email after DNS/proxy cutover). Once recorded, automatic rollback is blocked
   * unless explicit reverse-sync / loss-acknowledgement is provided.
   */
  async recordDestinationWrite(
    sessionId: string,
    sourceAccount: string,
    write: { kind: 'db' | 'mail' | 'file'; detail: string },
  ): Promise<DurableTransferRecord> {
    const rec = await this.mustLoad(sessionId)
    const cp = rec.accountCheckpoints[sourceAccount]
    if (!cp) return fail('NOT_FOUND', `account ${sourceAccount} is not part of transfer ${sessionId}`)
    if (!cp.cutoverAt) return fail('PRECONDITION_FAILED', `account ${sourceAccount} has not completed cutover yet`)
    cp.postCutoverWrites.push({
      kind: write.kind,
      detail: write.detail,
      at: this.ports.clock.now().toISOString(),
    })
    await this.saveRecord(rec)
    return rec
  }

  /**
   * Rolls back cutover for an account. If post-cutover writes occurred on the destination,
   * refuses unsafe rollback (`CONFLICT`) unless `allowReverseSyncOrForceLoss: true` is passed.
   */
  async rollbackAccountCutover(
    sessionId: string,
    sourceAccount: string,
    opts?: { allowReverseSyncOrForceLoss?: boolean },
  ): Promise<DurableTransferRecord> {
    const rec = await this.mustLoad(sessionId)
    const cp = rec.accountCheckpoints[sourceAccount]
    if (!cp || !cp.cutoverAt) {
      return fail('PRECONDITION_FAILED', `account ${sourceAccount} has not been cut over`)
    }
    if (cp.postCutoverWrites.length > 0 && !opts?.allowReverseSyncOrForceLoss) {
      return fail(
        'CONFLICT',
        `unsafe rollback blocked: ${cp.postCutoverWrites.length} post-cutover write(s) occurred on destination for ${cp.targetUsername}; perform reverse sync or confirm loss window`,
        { postCutoverWrites: cp.postCutoverWrites },
      )
    }
    await this.ports.destination.revertCutover(sessionId, cp.sourceUsername, cp.targetUsername)
    cp.rolledBackAt = this.ports.clock.now().toISOString()
    await this.saveRecord(rec)
    return rec
  }

  private async mustLoad(sessionId: string): Promise<DurableTransferRecord> {
    const rec = await this.loadRecord(sessionId)
    if (!rec) return fail('NOT_FOUND', `transfer session ${sessionId} not found`)
    return rec
  }
}
