import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  assertIdOrNull,
  assertIp,
  cleanString,
  fail,
  isXpanelError,
  redactInlineSecrets,
  redactSecrets,
} from '@xpanel/core'
import type { AuditEntry, Id } from '@xpanel/core'
import type { Db } from '../client.ts'
import { withSqliteErrors } from '../sqlite-errors.ts'
import { clampLimit, nowIso } from './util.ts'

/** What core's auditEntry builds, minus its id and time: the database assigns both. */
export interface NewAuditEntry {
  actor: string
  /** a code-defined verb such as account.suspend */
  action: string
  target: string
  detail?: Record<string, unknown>
  outcome: AuditEntry['outcome']
  principalId?: Id | null
  ip?: string | null
}

export interface DurableAuditEntry extends AuditEntry {
  seq?: number
  prevHash?: string
  entryHash?: string
  eventUid?: string
}

export interface AuditWriteOptions {
  auditLogFilePath?: string
  /** When true, missing `auditLogFilePath` fails closed with PRECONDITION_FAILED. */
  requireDurableFile?: boolean
  /** Default true: any write/fsync failure on the durable audit file aborts before DB insert or acknowledgement. */
  failClosed?: boolean
  /** When true, if durable file fsync succeeds but SQLite index insert fails, returns the durable file entry so replay can index it later. */
  allowSpoolOnIndexFailure?: boolean
  /** Fault-injection hook for testing ENOSPC / EIO / fsync failures on the durable sink. */
  simulateSinkError?: Error | NodeJS.ErrnoException
  /** Fault-injection hook for testing SQLite index outage after durable file fsync. */
  simulateIndexError?: Error
}

interface AuditRow {
  id: number
  at: string
  actor: string
  principal_id: string | null
  ip: string | null
  action: string
  target: string
  detail: string
  outcome: AuditEntry['outcome']
  [k: string]: unknown
}

export interface AuditFileRecord {
  seq: number
  eventUid: string
  id: string
  at: string
  actor: string
  principalId: string | null
  ip: string | null
  action: string
  target: string
  detail: Record<string, unknown>
  outcome: AuditEntry['outcome']
  prevHash: string
  entryHash: string
}

export interface AuditChainAnchor {
  schemaVersion: 1
  rotatedAt: string
  archivePath: string
  lastSeq: number
  lastEntryHash: string
}

export interface AuditChainVerificationResult {
  valid: boolean
  entriesVerified: number
  lastSeq: number
  lastEntryHash: string
  tamperedAtSeq: number | null
  error: string | null
  quarantinedTail: string | null
}

export interface AuditRotationResult {
  archivePath: string
  anchorPath: string
  rotatedEntries: number
  lastSeq: number
  lastEntryHash: string
}

const ACTION_RE = /^[a-z][a-z0-9_.:-]{0,127}$/
const OUTCOMES: readonly AuditEntry['outcome'][] = ['ok', 'denied', 'failed']
const MAX_DETAIL_BYTES = 64 * 1024
const ACTOR_MAX = 128
const TARGET_MAX = 480
export const GENESIS_AUDIT_HASH = '0'.repeat(64)

const stripInternalAuditMeta = (detail: Record<string, unknown>): Record<string, unknown> => {
  const copy = { ...detail }
  delete copy._auditEventUid
  delete copy._auditEntryHash
  delete copy._auditPrevHash
  delete copy._auditSeq
  return copy
}

const fromRow = (r: AuditRow): DurableAuditEntry => {
  const parsed = JSON.parse(r.detail) as Record<string, unknown>
  const seq = typeof parsed._auditSeq === 'number' ? parsed._auditSeq : undefined
  const prevHash = typeof parsed._auditPrevHash === 'string' ? parsed._auditPrevHash : undefined
  const entryHash = typeof parsed._auditEntryHash === 'string' ? parsed._auditEntryHash : undefined
  const eventUid = typeof parsed._auditEventUid === 'string' ? parsed._auditEventUid : undefined
  return {
    id: String(r.id),
    at: r.at,
    actor: r.actor,
    action: r.action,
    target: r.target,
    detail: stripInternalAuditMeta(parsed),
    outcome: r.outcome,
    ...(seq !== undefined && { seq }),
    ...(prevHash !== undefined && { prevHash }),
    ...(entryHash !== undefined && { entryHash }),
    ...(eventUid !== undefined && { eventUid }),
  }
}

const canonicalizeObject = (val: unknown): unknown => {
  if (val === null || typeof val !== 'object') return val
  if (Array.isArray(val)) return val.map(canonicalizeObject)
  const rec = val as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(rec)
      .sort()
      .map((k) => [k, canonicalizeObject(rec[k])]),
  )
}

export const computeAuditEntryHash = (record: {
  seq: number
  eventUid: string
  at: string
  actor: string
  principalId: string | null
  ip: string | null
  action: string
  target: string
  detail: Record<string, unknown>
  outcome: AuditEntry['outcome']
  prevHash: string
}): string => {
  const payload = canonicalizeObject({
    seq: record.seq,
    eventUid: record.eventUid,
    at: record.at,
    actor: record.actor,
    principalId: record.principalId ?? null,
    ip: record.ip ?? null,
    action: record.action,
    target: record.target,
    detail: stripInternalAuditMeta(record.detail),
    outcome: record.outcome,
    prevHash: record.prevHash,
  })
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex')
}

const anchorPathFor = (auditLogFilePath: string): string => `${auditLogFilePath}.anchor.json`
const quarantinePathFor = (auditLogFilePath: string): string => `${auditLogFilePath}.quarantine`

const readAnchorIfExists = async (auditLogFilePath: string): Promise<AuditChainAnchor | null> => {
  try {
    const raw = await readFile(anchorPathFor(auditLogFilePath), 'utf8')
    const parsed = JSON.parse(raw) as AuditChainAnchor
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.lastSeq === 'number' &&
      typeof parsed.lastEntryHash === 'string' &&
      /^[0-9a-f]{64}$/.test(parsed.lastEntryHash)
    ) {
      return parsed
    }
    return null
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

const readLastChainTip = async (
  auditLogFilePath: string,
): Promise<{ seq: number; entryHash: string }> => {
  let content = ''
  try {
    content = await readFile(auditLogFilePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const lines = content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  if (lines.length === 0) {
    const anchor = await readAnchorIfExists(auditLogFilePath)
    if (anchor) {
      return { seq: anchor.lastSeq, entryHash: anchor.lastEntryHash }
    }
    return { seq: 0, entryHash: GENESIS_AUDIT_HASH }
  }

  const lastLine = lines[lines.length - 1]!
  let parsed: Partial<AuditFileRecord>
  try {
    parsed = JSON.parse(lastLine) as Partial<AuditFileRecord>
  } catch {
    return fail('PRECONDITION_FAILED', 'audit log contains a corrupt or truncated tail line; run verifyAuditChain to recover')
  }
  if (
    typeof parsed.seq !== 'number' ||
    typeof parsed.entryHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(parsed.entryHash)
  ) {
    return fail('PRECONDITION_FAILED', 'audit log tail entry is missing hash-chain metadata')
  }
  return { seq: parsed.seq, entryHash: parsed.entryHash }
}

const fsyncWriteLine = async (filePath: string, line: string): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true })
  const fh = await open(filePath, 'a', 0o600)
  try {
    await fh.writeFile(line, 'utf8')
    await fh.sync()
  } finally {
    await fh.close()
  }
}

const fsyncWriteFullFile = async (filePath: string, content: string): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${randomUUID()}.tmp`
  const fh = await open(tmpPath, 'w', 0o600)
  try {
    await fh.writeFile(content, 'utf8')
    await fh.sync()
  } finally {
    await fh.close()
  }
  await rename(tmpPath, filePath)
}

/**
 * Appends one entry to the durable hash-chained JSONL audit log (with explicit `fsync` before
 * acknowledgement) and indexes it into the SQLite `audit_log` table (which rejects UPDATE/DELETE via trigger).
 *
 * When `opts.auditLogFilePath` is provided (or `requireDurableFile: true`), the file write + `fsync`
 * executes BEFORE the SQLite index insert. Under the default fail-closed policy, any disk write error
 * (`ENOSPC`, `EIO`, `EACCES`) throws `SERVICE_UNAVAILABLE` before acknowledging the operation.
 */
export const appendAudit = (
  db: Db,
  e: NewAuditEntry,
  opts: AuditWriteOptions = {},
): Promise<DurableAuditEntry> =>
  withSqliteErrors(async () => {
    if (typeof e !== 'object' || e === null) fail('VALIDATION', 'audit entry must be an object')
    if (typeof e.action !== 'string' || !ACTION_RE.test(e.action)) {
      fail('VALIDATION', 'audit action must look like account.create')
    }
    if (!OUTCOMES.includes(e.outcome)) fail('VALIDATION', 'audit outcome must be ok|denied|failed')
    if (typeof e.actor !== 'string' || e.actor.length === 0) fail('VALIDATION', 'audit actor is required')
    if (typeof e.target !== 'string') fail('VALIDATION', 'audit target must be a string')
    const raw = e.detail ?? {}
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      fail('VALIDATION', 'audit detail must be an object')
    }
    if (opts.requireDurableFile && !opts.auditLogFilePath) {
      fail('PRECONDITION_FAILED', 'durable audit log file path is required for this operation')
    }

    const detail = stripInternalAuditMeta(redactSecrets(raw))
    const actor = cleanString(redactInlineSecrets(e.actor), ACTOR_MAX)
    const target = cleanString(redactInlineSecrets(e.target.slice(0, TARGET_MAX * 4)), TARGET_MAX)
    const principalId = assertIdOrNull(e.principalId ?? null, 'principalId')
    const ip = e.ip == null ? null : assertIp(e.ip, 'ip')
    const at = nowIso()
    const eventUid = randomUUID()

    let seq: number | undefined
    let prevHash: string | undefined
    let entryHash: string | undefined

    if (opts.auditLogFilePath || opts.simulateSinkError) {
      const failClosed = opts.failClosed !== false
      try {
        if (opts.simulateSinkError) {
          throw opts.simulateSinkError
        }
        const tip = await readLastChainTip(opts.auditLogFilePath!)
        seq = tip.seq + 1
        prevHash = tip.entryHash
        entryHash = computeAuditEntryHash({
          seq,
          eventUid,
          at,
          actor,
          principalId,
          ip,
          action: e.action,
          target,
          detail,
          outcome: e.outcome,
          prevHash,
        })
        const fileRecord: AuditFileRecord = {
          seq,
          eventUid,
          id: String(seq),
          at,
          actor,
          principalId,
          ip,
          action: e.action,
          target,
          detail,
          outcome: e.outcome,
          prevHash,
          entryHash,
        }
        const serializedLine = JSON.stringify(fileRecord)
        if (serializedLine.includes('\n') || serializedLine.includes('\r')) {
          fail('VALIDATION', 'serialized audit line must not contain raw newline characters')
        }
        await fsyncWriteLine(opts.auditLogFilePath!, `${serializedLine}\n`)
      } catch (sinkErr) {
        if (failClosed) {
          if (isXpanelError(sinkErr)) throw sinkErr
          const errCode = (sinkErr as NodeJS.ErrnoException)?.code ?? 'AUDIT_SINK_ERROR'
          fail(
            'SERVICE_UNAVAILABLE',
            `durable audit sink failed (${errCode}): ${(sinkErr as Error).message}`,
            { errno: errCode },
          )
        }
      }
    }

    const dbDetailPayload: Record<string, unknown> = {
      ...detail,
      ...(eventUid && { _auditEventUid: eventUid }),
      ...(seq !== undefined && { _auditSeq: seq }),
      ...(prevHash !== undefined && { _auditPrevHash: prevHash }),
      ...(entryHash !== undefined && { _auditEntryHash: entryHash }),
    }
    const detailJson = JSON.stringify(dbDetailPayload)
    if (Buffer.byteLength(detailJson, 'utf8') > MAX_DETAIL_BYTES) {
      fail('VALIDATION', 'audit detail too large')
    }

    try {
      if (opts.simulateIndexError) {
        throw opts.simulateIndexError
      }
      const rows = await db.query<AuditRow>(
        `INSERT INTO audit_log (at, actor, principal_id, ip, action, target, detail, outcome)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [at, actor, principalId, ip, e.action, target, detailJson, e.outcome],
      )
      return fromRow(rows[0]!)
    } catch (indexErr) {
      if (opts.allowSpoolOnIndexFailure && opts.auditLogFilePath && entryHash && prevHash && seq !== undefined) {
        return {
          id: String(seq),
          at,
          actor,
          action: e.action,
          target,
          detail,
          outcome: e.outcome,
          seq,
          prevHash,
          entryHash,
          eventUid,
        }
      }
      throw indexErr
    }
  })

/**
 * Verifies the SHA-256 hash chain (`prevHash` -> `entryHash`) and contiguous sequence numbers
 * across optional rotated archive segments and the active JSONL audit log.
 *
 * When `quarantineTruncatedTail: true`, a partially written final line (caused by an abrupt
 * crash/power loss before `\n`) is quarantined into `<auditLogFilePath>.quarantine`, while any
 * corruption or tampering in complete lines is reported as `valid: false`.
 */
export const verifyAuditChain = async (
  auditLogFilePath: string,
  opts: { archivePaths?: string[]; quarantineTruncatedTail?: boolean } = {},
): Promise<AuditChainVerificationResult> => {
  const archivePaths = opts.archivePaths ?? []
  let expectedSeq = 0
  let expectedPrevHash = GENESIS_AUDIT_HASH
  let entriesVerified = 0
  let quarantinedTail: string | null = null

  if (archivePaths.length === 0) {
    const anchor = await readAnchorIfExists(auditLogFilePath)
    if (anchor) {
      expectedSeq = anchor.lastSeq
      expectedPrevHash = anchor.lastEntryHash
    }
  }

  const allFiles = [...archivePaths, auditLogFilePath]
  for (let fileIdx = 0; fileIdx < allFiles.length; fileIdx++) {
    const filePath = allFiles[fileIdx]!
    const isActiveFile = fileIdx === allFiles.length - 1
    let raw = ''
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }
    if (raw.length === 0) continue

    const segments = raw.split('\n')
    const endsWithNewline = raw.endsWith('\n')
    const nonEmptyLines: string[] = []

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!.replace(/\r$/, '')
      if (seg.length === 0) continue
      const isLastSegment = i === segments.length - 1
      if (isActiveFile && isLastSegment && !endsWithNewline && opts.quarantineTruncatedTail) {
        try {
          JSON.parse(seg)
          nonEmptyLines.push(seg)
        } catch {
          quarantinedTail = seg
          await fsyncWriteLine(quarantinePathFor(auditLogFilePath), `${seg}\n`)
          const cleanContent = nonEmptyLines.length > 0 ? `${nonEmptyLines.join('\n')}\n` : ''
          await fsyncWriteFullFile(auditLogFilePath, cleanContent)
          continue
        }
      } else {
        nonEmptyLines.push(seg)
      }
    }

    for (const line of nonEmptyLines) {
      const candidateSeq = expectedSeq + 1
      let parsed: AuditFileRecord
      try {
        parsed = JSON.parse(line) as AuditFileRecord
      } catch {
        return {
          valid: false,
          entriesVerified,
          lastSeq: expectedSeq,
          lastEntryHash: expectedPrevHash,
          tamperedAtSeq: candidateSeq,
          error: `malformed JSON in audit log at sequence ${candidateSeq}`,
          quarantinedTail,
        }
      }

      if (parsed.seq !== candidateSeq) {
        return {
          valid: false,
          entriesVerified,
          lastSeq: expectedSeq,
          lastEntryHash: expectedPrevHash,
          tamperedAtSeq: parsed.seq ?? candidateSeq,
          error: `sequence gap or reorder detected: expected seq ${candidateSeq}, got ${String(parsed.seq)}`,
          quarantinedTail,
        }
      }

      if (parsed.prevHash !== expectedPrevHash) {
        return {
          valid: false,
          entriesVerified,
          lastSeq: expectedSeq,
          lastEntryHash: expectedPrevHash,
          tamperedAtSeq: candidateSeq,
          error: `broken prevHash link at seq ${candidateSeq}`,
          quarantinedTail,
        }
      }

      const recomputed = computeAuditEntryHash({
        seq: parsed.seq,
        eventUid: parsed.eventUid,
        at: parsed.at,
        actor: parsed.actor,
        principalId: parsed.principalId ?? null,
        ip: parsed.ip ?? null,
        action: parsed.action,
        target: parsed.target,
        detail: parsed.detail ?? {},
        outcome: parsed.outcome,
        prevHash: parsed.prevHash,
      })

      if (recomputed !== parsed.entryHash) {
        return {
          valid: false,
          entriesVerified,
          lastSeq: expectedSeq,
          lastEntryHash: expectedPrevHash,
          tamperedAtSeq: candidateSeq,
          error: `entryHash mismatch at seq ${candidateSeq}: content tampered`,
          quarantinedTail,
        }
      }

      expectedSeq = parsed.seq
      expectedPrevHash = parsed.entryHash
      entriesVerified++
    }
  }

  return {
    valid: true,
    entriesVerified,
    lastSeq: expectedSeq,
    lastEntryHash: expectedPrevHash,
    tamperedAtSeq: null,
    error: null,
    quarantinedTail,
  }
}

/**
 * Rotates the active JSONL audit log into an archive file while preserving unbroken
 * SHA-256 hash-chain continuity (`lastSeq` and `lastEntryHash`) via a durable sidecar anchor.
 */
export const rotateAuditLog = async (
  auditLogFilePath: string,
  opts: { archivePath?: string; archivePaths?: string[]; now?: Date } = {},
): Promise<AuditRotationResult> => {
  const verification = await verifyAuditChain(auditLogFilePath, {
    ...(opts.archivePaths && { archivePaths: opts.archivePaths }),
  })
  if (!verification.valid) {
    fail('PRECONDITION_FAILED', `cannot rotate tampered or invalid audit log: ${verification.error}`, {
      tamperedAtSeq: verification.tamperedAtSeq,
    })
  }

  const now = (opts.now ?? new Date()).toISOString()
  const safeTs = now.replace(/[:.]/g, '-')
  const archivePath = opts.archivePath ?? `${auditLogFilePath}.${verification.lastSeq}.${safeTs}.jsonl`
  const anchorPath = anchorPathFor(auditLogFilePath)

  await mkdir(dirname(archivePath), { recursive: true })
  try {
    await stat(auditLogFilePath)
    await rename(auditLogFilePath, archivePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await writeFile(archivePath, '', { encoding: 'utf8', mode: 0o600 })
    } else {
      throw err
    }
  }

  const anchor: AuditChainAnchor = {
    schemaVersion: 1,
    rotatedAt: now,
    archivePath,
    lastSeq: verification.lastSeq,
    lastEntryHash: verification.lastEntryHash,
  }
  await fsyncWriteFullFile(anchorPath, JSON.stringify(anchor, null, 2))
  await fsyncWriteFullFile(auditLogFilePath, '')

  return {
    archivePath,
    anchorPath,
    rotatedEntries: verification.entriesVerified,
    lastSeq: verification.lastSeq,
    lastEntryHash: verification.lastEntryHash,
  }
}

/**
 * Replays verified JSONL audit log entries into the SQLite `audit_log` index idempotently.
 * Re-running replay multiple times never duplicates entries already present in `audit_log`.
 */
export const replayAuditLogToIndex = async (
  db: Db,
  opts: {
    auditLogFilePath: string
    archivePaths?: string[]
    quarantineTruncatedTail?: boolean
  },
): Promise<{ indexed: number; skipped: number; quarantinedTail: string | null }> => {
  const verification = await verifyAuditChain(opts.auditLogFilePath, {
    ...(opts.archivePaths && { archivePaths: opts.archivePaths }),
    ...(opts.quarantineTruncatedTail !== undefined && {
      quarantineTruncatedTail: opts.quarantineTruncatedTail,
    }),
  })
  if (!verification.valid) {
    fail('PRECONDITION_FAILED', `refusing to replay corrupt audit log: ${verification.error}`, {
      tamperedAtSeq: verification.tamperedAtSeq,
    })
  }

  const existingRows = await db.query<{ detail: string }>(`SELECT detail FROM audit_log`)
  const knownEntryHashes = new Set<string>()
  const knownEventUids = new Set<string>()
  for (const row of existingRows) {
    try {
      const parsed = JSON.parse(row.detail) as Record<string, unknown>
      if (typeof parsed._auditEntryHash === 'string') knownEntryHashes.add(parsed._auditEntryHash)
      if (typeof parsed._auditEventUid === 'string') knownEventUids.add(parsed._auditEventUid)
    } catch {
      // ignore legacy rows without metadata
    }
  }

  let indexed = 0
  let skipped = 0
  const allFiles = [...(opts.archivePaths ?? []), opts.auditLogFilePath]

  for (const filePath of allFiles) {
    let raw = ''
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }
    const lines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)

    for (const line of lines) {
      const rec = JSON.parse(line) as AuditFileRecord
      if (knownEntryHashes.has(rec.entryHash) || knownEventUids.has(rec.eventUid)) {
        skipped++
        continue
      }
      const dbDetail: Record<string, unknown> = {
        ...rec.detail,
        _auditEventUid: rec.eventUid,
        _auditSeq: rec.seq,
        _auditPrevHash: rec.prevHash,
        _auditEntryHash: rec.entryHash,
      }
      await db.query(
        `INSERT INTO audit_log (at, actor, principal_id, ip, action, target, detail, outcome)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          rec.at,
          rec.actor,
          rec.principalId ?? null,
          rec.ip ?? null,
          rec.action,
          rec.target,
          JSON.stringify(dbDetail),
          rec.outcome,
        ],
      )
      knownEntryHashes.add(rec.entryHash)
      knownEventUids.add(rec.eventUid)
      indexed++
    }
  }

  return { indexed, skipped, quarantinedTail: verification.quarantinedTail }
}

/**
 * Prunes expired operational records (`metrics_history`, `login_attempts`, and old terminal `jobs`
 * that do not require operator attention) while NEVER deleting `audit_log` history.
 */
export const pruneExpiredOperationalRecords = async (
  db: Db,
  opts: {
    now?: Date
    metricsRetentionDays?: number
    loginAttemptsRetentionDays?: number
    finishedJobsRetentionDays?: number
  } = {},
): Promise<{
  metricsDeleted: number
  loginAttemptsDeleted: number
  jobsDeleted: number
  auditDeleted: 0
}> =>
  withSqliteErrors(async () => {
    const nowMs = (opts.now ?? new Date()).getTime()
    const metricsDays = opts.metricsRetentionDays ?? 30
    const loginDays = opts.loginAttemptsRetentionDays ?? 90
    const jobsDays = opts.finishedJobsRetentionDays ?? 30

    const metricsCutoff = new Date(nowMs - metricsDays * 86_400_000).toISOString()
    const loginCutoff = new Date(nowMs - loginDays * 86_400_000).toISOString()
    const jobsCutoff = new Date(nowMs - jobsDays * 86_400_000).toISOString()

    return db.transaction(async (tx) => {
      const mRows = await tx.query<{ id: number }>(
        `DELETE FROM metrics_history WHERE at < $1 RETURNING id`,
        [metricsCutoff],
      )
      const lRows = await tx.query<{ id: number }>(
        `DELETE FROM login_attempts WHERE at < $1 RETURNING id`,
        [loginCutoff],
      )
      const leaseTableExists = await tx.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'job_runtime_leases'`,
      )
      const jRows =
        leaseTableExists.length > 0
          ? await tx.query<{ id: string }>(
              `DELETE FROM jobs
               WHERE status IN ('succeeded', 'failed', 'cancelled')
                 AND finished_at IS NOT NULL
                 AND finished_at < $1
                 AND id NOT IN (SELECT job_id FROM job_runtime_leases WHERE needs_attention = 1)
                  AND NOT EXISTS (SELECT 1 FROM reconcile_operations o WHERE o.job_id = jobs.id)
                  AND NOT EXISTS (SELECT 1 FROM legacy_reference_repairs r WHERE r.job_id = jobs.id AND r.state = 'awaiting_intent')
               RETURNING id`,
              [jobsCutoff],
            )
          : await tx.query<{ id: string }>(
              `DELETE FROM jobs
               WHERE status IN ('succeeded', 'failed', 'cancelled')
                 AND finished_at IS NOT NULL
                 AND finished_at < $1
               RETURNING id`,
              [jobsCutoff],
            )

      return {
        metricsDeleted: mRows.length,
        loginAttemptsDeleted: lRows.length,
        jobsDeleted: jRows.length,
        auditDeleted: 0,
      }
    })
  })

export interface AuditQuery {
  /** page size, default 100, max 1000 */
  limit?: number
  /** entries older than this id (keyset pagination) */
  beforeId?: string
  actor?: string
  target?: string
  action?: string
  outcome?: AuditEntry['outcome']
  /** Inclusive UTC instant; timezone-free datetime-local values are interpreted as UTC. */
  from?: string
  /** Inclusive UTC instant; timezone-free datetime-local values are interpreted as UTC. */
  to?: string
  /** Exact actor username, or canonical account:<username>[:subresource] target. */
  mentions?: string
}

/** Strict millisecond-precision date-time normalization, independent of host timezone. */
const auditFilterInstant = (value: string, name: 'from' | 'to'): string => {
  if (typeof value !== 'string') return fail('VALIDATION', `${name} must be a date-time`)
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value)
  if (!match || Number(match[1]) < 1) return fail('VALIDATION', `${name} must be a valid UTC date-time`)
  const wallTime = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] ?? '00'}.${(match[7] ?? '').padEnd(3, '0')}Z`
  const wallMillis = Date.parse(wallTime)
  if (!Number.isFinite(wallMillis) || new Date(wallMillis).toISOString() !== wallTime) {
    return fail('VALIDATION', `${name} must be a real calendar date-time`)
  }
  const zone = match[8] ?? 'Z'
  const hours = zone === 'Z' ? 0 : Number(zone.slice(1, 3))
  const minutes = zone === 'Z' ? 0 : Number(zone.slice(4, 6))
  if (hours > 23 || minutes > 59) return fail('VALIDATION', `${name} has an invalid timezone offset`)
  const offset = (hours * 60 + minutes) * 60_000 * (zone.startsWith('-') ? -1 : 1)
  const normalized = new Date(wallMillis - offset).toISOString()
  if (!/^\d{4}-/.test(normalized) || normalized.startsWith('0000-')) {
    return fail('VALIDATION', `${name} is outside the supported calendar range`)
  }
  return normalized
}

/** Shared validation for API and repository callers. Bounds are inclusive instants. */
export const normalizeAuditFilters = (
  q: Pick<AuditQuery, 'outcome' | 'from' | 'to'>,
): Pick<AuditQuery, 'outcome' | 'from' | 'to'> => {
  if (q.outcome !== undefined && !OUTCOMES.includes(q.outcome)) {
    return fail('VALIDATION', 'outcome must be ok, denied or failed')
  }
  const from = q.from === undefined ? undefined : auditFilterInstant(q.from, 'from')
  const to = q.to === undefined ? undefined : auditFilterInstant(q.to, 'to')
  if (from !== undefined && to !== undefined && from > to) {
    return fail('VALIDATION', 'from must not be later than to')
  }
  return {
    ...(q.outcome !== undefined ? { outcome: q.outcome } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
  }
}

/** Newest first. */
export const listAudit = async (db: Db, q: AuditQuery = {}): Promise<AuditEntry[]> => {
  const limit = clampLimit(q.limit, 100, 1000)
  const filters = normalizeAuditFilters(q)
  const before =
    q.beforeId === undefined
      ? undefined
      : /^[1-9][0-9]{0,14}$/.test(q.beforeId)
        ? Number(q.beforeId)
        : fail('VALIDATION', 'beforeId must be an entry id')

  const clauses: string[] = []
  const params: unknown[] = []
  if (before !== undefined) {
    clauses.push(`id < $${params.length + 1}`)
    params.push(before)
  }
  if (q.actor !== undefined) {
    clauses.push(`actor = $${params.length + 1}`)
    params.push(q.actor)
  }
  if (q.target !== undefined) {
    clauses.push(`target = $${params.length + 1}`)
    params.push(q.target)
  }
  if (q.action !== undefined) {
    clauses.push(`action = $${params.length + 1}`)
    params.push(q.action)
  }
  if (filters.outcome !== undefined) {
    clauses.push(`outcome = $${params.length + 1}`)
    params.push(filters.outcome)
  }
  // Compare instants, including historical ISO rows without a millisecond fraction.
  if (filters.from !== undefined) {
    clauses.push(`julianday(at) >= julianday($${params.length + 1})`)
    params.push(filters.from)
  }
  if (filters.to !== undefined) {
    clauses.push(`julianday(at) <= julianday($${params.length + 1})`)
    params.push(filters.to)
  }
  if (q.mentions !== undefined && q.mentions.length > 0 && q.mentions.length <= 64) {
    clauses.push(`(actor = $${params.length + 1} OR target = $${params.length + 2} OR instr(target, $${params.length + 3}) = 1)`)
    params.push(q.mentions, `account:${q.mentions}`, `account:${q.mentions}:`)
  }
  params.push(limit)
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = await db.query<AuditRow>(
    `SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT $${params.length}`,
    params,
  )
  return rows.map(fromRow)
}
