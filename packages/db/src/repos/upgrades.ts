import { and, desc, eq, inArray } from 'drizzle-orm'
import { fail } from '@xpanel/core'
import type { Id } from '@xpanel/core'
import type { Db } from '../client.ts'
import { withPgErrors } from '../pg-errors.ts'
import { UPGRADE_PHASES, UPGRADE_STATUSES, upgrades } from '../schema.ts'
import { assertAbsPath, assertLine } from '../validate.ts'
import { assertId, clampLimit, first, isUuid, mustExist } from './util.ts'

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

type Row = typeof upgrades.$inferSelect

const isoOrNull = (d: Date | null): string | null => (d ? d.toISOString() : null)

const fromRow = (r: Row): UpgradeRecord => ({
  id: r.id,
  fromVersion: r.fromVersion,
  toVersion: r.toVersion,
  fromSchemaVersion: r.fromSchemaVersion,
  toSchemaVersion: r.toSchemaVersion,
  status: r.status,
  phase: r.phase,
  healthReport: (r.healthReport as Record<string, unknown> | null) ?? null,
  snapshotPath: r.snapshotPath,
  error: r.error,
  actor: r.actor,
  createdAt: r.createdAt.toISOString(),
  startedAt: isoOrNull(r.startedAt),
  finishedAt: isoOrNull(r.finishedAt),
})

const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/

const assertSemver = (v: unknown, what: string): string =>
  typeof v === 'string' && v.length <= 64 && SEMVER_RE.test(v) ? v : fail('VALIDATION', `${what} must be SemVer`, { [what]: String(v) })

const schemaVersion = (v: unknown, what: string): number | null =>
  v === undefined || v === null ? null : Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : fail('VALIDATION', `${what} must be >= 0`)

const assertReport = (r: unknown): Record<string, unknown> | null => {
  if (r === undefined || r === null) return null
  if (typeof r !== 'object' || Array.isArray(r)) return fail('VALIDATION', 'healthReport must be an object')
  return r as Record<string, unknown>
}

const IN_FLIGHT: UpgradeStatus[] = ['pending', 'running']

/** The guarded update found the upgrade already settled (a concurrent finish won). */
const settledError = async (db: Db, id: Id): Promise<never> => {
  const current = mustExist(await getUpgrade(db, id), 'upgrade', id)
  return fail('PRECONDITION_FAILED', `upgrade is already ${current.status}`, { id, status: current.status })
}

/** Records a new upgrade. A second one while another is pending/running is refused (CONFLICT). */
export const createUpgrade = (
  db: Db,
  input: { fromVersion: string; toVersion: string; actor: string; fromSchemaVersion?: number; snapshotPath?: string },
): Promise<UpgradeRecord> =>
  withPgErrors(async () => {
    const fromVersion = assertSemver(input.fromVersion, 'fromVersion')
    const toVersion = assertSemver(input.toVersion, 'toVersion')
    if (fromVersion === toVersion) fail('VALIDATION', 'fromVersion and toVersion are the same')
    const inFlight = await inFlightUpgrade(db)
    if (inFlight) fail('CONFLICT', 'another upgrade is in progress', { id: inFlight.id })
    const [row] = await db
      .insert(upgrades)
      .values({
        fromVersion,
        toVersion,
        actor: assertLine(input.actor, 255, 'actor', { allowEmpty: false }),
        fromSchemaVersion: schemaVersion(input.fromSchemaVersion, 'fromSchemaVersion'),
        snapshotPath: input.snapshotPath === undefined ? null : assertAbsPath(input.snapshotPath, 'snapshotPath'),
      })
      .returning()
    return fromRow(row as Row)
  })

/** pending|running -> running at `phase`. */
export const setUpgradePhase = (db: Db, id: Id, phase: UpgradePhase, extra: { snapshotPath?: string } = {}): Promise<UpgradeRecord> =>
  withPgErrors(async () => {
    if (!UPGRADE_PHASES.includes(phase)) fail('VALIDATION', `phase must be one of ${UPGRADE_PHASES.join('|')}`)
    const current = mustExist(await getUpgrade(db, id), 'upgrade', id)
    if (current.status !== 'pending' && current.status !== 'running') {
      fail('PRECONDITION_FAILED', `upgrade is already ${current.status}`, { id, status: current.status })
    }
    const [row] = await db
      .update(upgrades)
      .set({
        status: 'running',
        phase,
        ...(current.startedAt === null && { startedAt: new Date() }),
        ...(extra.snapshotPath !== undefined && { snapshotPath: assertAbsPath(extra.snapshotPath, 'snapshotPath') }),
      })
      .where(and(eq(upgrades.id, current.id), inArray(upgrades.status, IN_FLIGHT)))
      .returning()
    return row ? fromRow(row) : settledError(db, id)
  })

export interface UpgradeOutcome {
  status: 'succeeded' | 'failed' | 'rolled_back'
  healthReport?: Record<string, unknown> | null
  error?: string | null
  toSchemaVersion?: number | null
}

/** Settles an in-flight upgrade. failed/rolled_back need an error. */
export const finishUpgrade = (db: Db, id: Id, outcome: UpgradeOutcome): Promise<UpgradeRecord> =>
  withPgErrors(async () => {
    const status = outcome.status
    if (status !== 'succeeded' && status !== 'failed' && status !== 'rolled_back') fail('VALIDATION', 'status must be succeeded|failed|rolled_back')
    const error = outcome.error ?? null
    if (status !== 'succeeded' && (typeof error !== 'string' || error.length === 0)) fail('VALIDATION', `${status} needs an error`)
    if (error !== null && (typeof error !== 'string' || error.length > 16000 || error.includes('\0'))) fail('VALIDATION', 'invalid error text')
    const current = mustExist(await getUpgrade(db, id), 'upgrade', id)
    if (current.status !== 'pending' && current.status !== 'running') {
      fail('PRECONDITION_FAILED', `upgrade is already ${current.status}`, { id, status: current.status })
    }
    const [row] = await db
      .update(upgrades)
      .set({
        status,
        error,
        healthReport: assertReport(outcome.healthReport),
        toSchemaVersion: schemaVersion(outcome.toSchemaVersion, 'toSchemaVersion'),
        finishedAt: new Date(),
        ...(current.startedAt === null && { startedAt: new Date() }),
      })
      .where(and(eq(upgrades.id, current.id), inArray(upgrades.status, IN_FLIGHT)))
      .returning()
    return row ? fromRow(row) : settledError(db, id)
  })

export const getUpgrade = async (db: Db, id: Id): Promise<UpgradeRecord | null> => {
  if (!isUuid(id)) return null
  const row = first(await db.select().from(upgrades).where(eq(upgrades.id, assertId(id, 'id'))))
  return row ? fromRow(row) : null
}

export const inFlightUpgrade = async (db: Db): Promise<UpgradeRecord | null> => {
  const row = first(await db.select().from(upgrades).where(inArray(upgrades.status, IN_FLIGHT)).limit(1))
  return row ? fromRow(row) : null
}

export const listUpgrades = async (db: Db, opts: { limit?: number } = {}): Promise<UpgradeRecord[]> =>
  (await db.select().from(upgrades).orderBy(desc(upgrades.createdAt), desc(upgrades.id)).limit(clampLimit(opts.limit, 50, 500))).map(fromRow)

export const latestUpgrade = async (db: Db): Promise<UpgradeRecord | null> => (await listUpgrades(db, { limit: 1 }))[0] ?? null
