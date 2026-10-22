import { randomUUID } from 'node:crypto'
import { assertAbsPath, assertId, assertLine, assertSemver, fail, isUuid } from '@xpanel/core'
import type { Id } from '@xpanel/core'
import type { Db } from '../client.ts'
import { UPGRADE_PHASES, UPGRADE_STATUSES } from '../schema.ts'
import { withSqliteErrors } from '../sqlite-errors.ts'
import { clampLimit, first, mustExist, nowIso } from './util.ts'

export type UpgradeStatus = (typeof UPGRADE_STATUSES)[number]
export type UpgradePhase = (typeof UPGRADE_PHASES)[number]

export interface UpgradeRecord {
  id: Id
  fromVersion: string
  toVersion: string
  fromSchemaVersion: number | null
  toSchemaVersion: number | null
  status: UpgradeStatus
  phase: UpgradePhase | null
  healthReport: Record<string, unknown> | null
  snapshotPath: string | null
  error: string | null
  actor: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

interface UpgradeRow {
  id: string
  from_version: string
  to_version: string
  from_schema_version: number | null
  to_schema_version: number | null
  status: UpgradeStatus
  phase: UpgradePhase | null
  health_report: string | null
  snapshot_path: string | null
  error: string | null
  actor: string
  created_at: string
  started_at: string | null
  finished_at: string | null
  [k: string]: unknown
}

const fromRow = (r: UpgradeRow): UpgradeRecord => ({
  id: r.id,
  fromVersion: r.from_version,
  toVersion: r.to_version,
  fromSchemaVersion: r.from_schema_version,
  toSchemaVersion: r.to_schema_version,
  status: r.status,
  phase: r.phase,
  healthReport: r.health_report ? (JSON.parse(r.health_report) as Record<string, unknown>) : null,
  snapshotPath: r.snapshot_path,
  error: r.error,
  actor: r.actor,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
})

const schemaVersion = (v: unknown, what: string): number | null =>
  v === undefined || v === null
    ? null
    : Number.isSafeInteger(v) && (v as number) >= 0
      ? (v as number)
      : fail('VALIDATION', `${what} must be >= 0`)

const assertReport = (r: unknown): Record<string, unknown> | null => {
  if (r === undefined || r === null) return null
  if (typeof r !== 'object' || Array.isArray(r)) return fail('VALIDATION', 'healthReport must be an object')
  return r as Record<string, unknown>
}

const settledError = async (db: Db, id: Id): Promise<never> => {
  const current = mustExist(await getUpgrade(db, id), 'upgrade', id)
  return fail('PRECONDITION_FAILED', `upgrade is already ${current.status}`, { id, status: current.status })
}

/** Records a new upgrade. A second one while another is pending/running is refused (CONFLICT). */
export const createUpgrade = (
  db: Db,
  input: {
    fromVersion: string
    toVersion: string
    actor: string
    fromSchemaVersion?: number
    snapshotPath?: string
  },
): Promise<UpgradeRecord> =>
  withSqliteErrors(async () => {
    const fromVersion = assertSemver(input.fromVersion, 'fromVersion')
    const toVersion = assertSemver(input.toVersion, 'toVersion')
    if (fromVersion === toVersion) fail('VALIDATION', 'fromVersion and toVersion are the same')
    const inFlight = await inFlightUpgrade(db)
    if (inFlight) fail('CONFLICT', 'another upgrade is in progress', { id: inFlight.id })
    const id = randomUUID()
    const actor = assertLine(input.actor, 255, 'actor', { allowEmpty: false })
    const fromSchema = schemaVersion(input.fromSchemaVersion, 'fromSchemaVersion')
    const snapshotPath = input.snapshotPath === undefined ? null : assertAbsPath(input.snapshotPath, 'snapshotPath')
    const rows = await db.query<UpgradeRow>(
      `INSERT INTO upgrades (
        id, from_version, to_version, from_schema_version, status, snapshot_path, actor, created_at
      ) VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7)
      RETURNING *`,
      [id, fromVersion, toVersion, fromSchema, snapshotPath, actor, nowIso()],
    )
    return fromRow(rows[0]!)
  })

/** pending|running -> running at `phase`. */
export const setUpgradePhase = (
  db: Db,
  id: Id,
  phase: UpgradePhase,
  extra: { snapshotPath?: string } = {},
): Promise<UpgradeRecord> =>
  withSqliteErrors(async () => {
    if (!UPGRADE_PHASES.includes(phase)) fail('VALIDATION', `phase must be one of ${UPGRADE_PHASES.join('|')}`)
    const current = mustExist(await getUpgrade(db, id), 'upgrade', id)
    if (current.status !== 'pending' && current.status !== 'running') {
      fail('PRECONDITION_FAILED', `upgrade is already ${current.status}`, { id, status: current.status })
    }
    const startedAt = current.startedAt ?? nowIso()
    const snapshotPath =
      extra.snapshotPath !== undefined ? assertAbsPath(extra.snapshotPath, 'snapshotPath') : current.snapshotPath
    const rows = await db.query<UpgradeRow>(
      `UPDATE upgrades
       SET status = 'running', phase = $1, started_at = $2, snapshot_path = $3
       WHERE id = $4 AND status IN ('pending', 'running')
       RETURNING *`,
      [phase, startedAt, snapshotPath, current.id],
    )
    return rows[0] ? fromRow(rows[0]) : settledError(db, id)
  })

export interface UpgradeOutcome {
  status: 'succeeded' | 'failed' | 'rolled_back'
  healthReport?: Record<string, unknown> | null
  error?: string | null
  toSchemaVersion?: number | null
}

/** Settles an in-flight upgrade. failed/rolled_back need an error. */
export const finishUpgrade = (db: Db, id: Id, outcome: UpgradeOutcome): Promise<UpgradeRecord> =>
  withSqliteErrors(async () => {
    const status = outcome.status
    if (status !== 'succeeded' && status !== 'failed' && status !== 'rolled_back') {
      fail('VALIDATION', 'status must be succeeded|failed|rolled_back')
    }
    const error = outcome.error ?? null
    if (status !== 'succeeded' && (typeof error !== 'string' || error.length === 0)) {
      fail('VALIDATION', `${status} needs an error`)
    }
    if (error !== null && (typeof error !== 'string' || error.length > 16000 || error.includes('\0'))) {
      fail('VALIDATION', 'invalid error text')
    }
    const current = mustExist(await getUpgrade(db, id), 'upgrade', id)
    if (current.status !== 'pending' && current.status !== 'running') {
      fail('PRECONDITION_FAILED', `upgrade is already ${current.status}`, { id, status: current.status })
    }
    const reportObj = assertReport(outcome.healthReport)
    const toSchema = schemaVersion(outcome.toSchemaVersion, 'toSchemaVersion')
    const now = nowIso()
    const startedAt = current.startedAt ?? now
    const rows = await db.query<UpgradeRow>(
      `UPDATE upgrades
       SET status = $1,
           error = $2,
           health_report = $3,
           to_schema_version = $4,
           started_at = $5,
           finished_at = $6
       WHERE id = $7 AND status IN ('pending', 'running')
       RETURNING *`,
      [status, error, reportObj ? JSON.stringify(reportObj) : null, toSchema, startedAt, now, current.id],
    )
    return rows[0] ? fromRow(rows[0]) : settledError(db, id)
  })

export const getUpgrade = async (db: Db, id: Id): Promise<UpgradeRecord | null> => {
  if (!isUuid(id)) return null
  const rows = await db.query<UpgradeRow>(`SELECT * FROM upgrades WHERE id = $1`, [assertId(id, 'id')])
  const row = first(rows)
  return row ? fromRow(row) : null
}

export const inFlightUpgrade = async (db: Db): Promise<UpgradeRecord | null> => {
  const rows = await db.query<UpgradeRow>(
    `SELECT * FROM upgrades WHERE status IN ('pending', 'running') LIMIT 1`,
  )
  const row = first(rows)
  return row ? fromRow(row) : null
}

export const listUpgrades = async (db: Db, opts: { limit?: number } = {}): Promise<UpgradeRecord[]> => {
  const limit = clampLimit(opts.limit, 50, 500)
  const rows = await db.query<UpgradeRow>(
    `SELECT * FROM upgrades ORDER BY created_at DESC, id DESC LIMIT $1`,
    [limit],
  )
  return rows.map(fromRow)
}

export const latestUpgrade = async (db: Db): Promise<UpgradeRecord | null> =>
  (await listUpgrades(db, { limit: 1 }))[0] ?? null
