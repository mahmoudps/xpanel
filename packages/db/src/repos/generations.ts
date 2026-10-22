import { assertLine, assertSha256Hex, fail } from '@xpanel/core'
import type { Db } from '../client.ts'
import { GENERATION_STATUSES } from '../schema.ts'
import { withSqliteErrors } from '../sqlite-errors.ts'
import { clampLimit, first, mustExist, nowIso } from './util.ts'

export type GenerationStatus = (typeof GENERATION_STATUSES)[number]

/**
 * One rendered config set. Lifecycle:
 * pending -> tested -> active -> superseded (-> active again on rollback)
 * pending|tested -> failed; active -> rolled_back. At most one is active.
 */
export interface ConfigGeneration {
  id: number
  createdAt: string
  status: GenerationStatus
  /** sha256 of the rendered file set */
  checksum: string
  error: string | null
  actor: string
  testedAt: string | null
  activatedAt: string | null
}

interface GenerationRow {
  id: number
  created_at: string
  status: GenerationStatus
  checksum: string
  error: string | null
  actor: string
  tested_at: string | null
  activated_at: string | null
  [k: string]: unknown
}

const fromRow = (r: GenerationRow): ConfigGeneration => ({
  id: r.id,
  createdAt: r.created_at,
  status: r.status,
  checksum: r.checksum,
  error: r.error,
  actor: r.actor,
  testedAt: r.tested_at,
  activatedAt: r.activated_at,
})

const assertGenId = (id: unknown): number =>
  typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : fail('VALIDATION', 'invalid generation id')

const assertError = (e: unknown): string => {
  if (typeof e !== 'string' || e.length === 0) return fail('VALIDATION', 'error text is required')
  if (e.includes('\0')) return fail('VALIDATION', 'error text contains NUL')
  return e.length > 16000 ? `${e.slice(0, 15990)}...[cut]` : e
}

export const getGeneration = async (db: Db, id: number): Promise<ConfigGeneration | null> => {
  if (!Number.isSafeInteger(id) || id <= 0) return null
  const rows = await db.query<GenerationRow>(`SELECT * FROM config_generations WHERE id = $1`, [id])
  const row = first(rows)
  return row ? fromRow(row) : null
}

const transitionError = async (db: Db, id: number, to: GenerationStatus): Promise<never> => {
  const g = mustExist(await getGeneration(db, id), 'config generation', id)
  return fail('PRECONDITION_FAILED', `config generation ${id} cannot go from ${g.status} to ${to}`, {
    id,
    status: g.status,
    to,
  })
}

export const createGeneration = (db: Db, input: { checksum: string; actor?: string }): Promise<ConfigGeneration> =>
  withSqliteErrors(async () => {
    const checksum = assertSha256Hex(input.checksum)
    const actor = assertLine(input.actor ?? 'system', 255, 'actor', { allowEmpty: false })
    const rows = await db.query<GenerationRow>(
      `INSERT INTO config_generations (created_at, status, checksum, actor)
       VALUES ($1, 'pending', $2, $3)
       RETURNING *`,
      [nowIso(), checksum, actor],
    )
    return fromRow(rows[0]!)
  })

/** pending -> tested, after nginx -t / apachectl configtest passed. */
export const markTested = (db: Db, id: number): Promise<ConfigGeneration> =>
  withSqliteErrors(async () => {
    const gid = assertGenId(id)
    const rows = await db.query<GenerationRow>(
      `UPDATE config_generations
       SET status = 'tested', tested_at = $1
       WHERE id = $2 AND status = 'pending'
       RETURNING *`,
      [nowIso(), gid],
    )
    return rows[0] ? fromRow(rows[0]) : transitionError(db, gid, 'tested')
  })

/** pending|tested -> failed. The active generation is untouched, so the host keeps serving it. */
export const markFailed = (db: Db, id: number, error: string): Promise<ConfigGeneration> =>
  withSqliteErrors(async () => {
    const gid = assertGenId(id)
    const rows = await db.query<GenerationRow>(
      `UPDATE config_generations
       SET status = 'failed', error = $1
       WHERE id = $2 AND status IN ('pending', 'tested')
       RETURNING *`,
      [assertError(error), gid],
    )
    return rows[0] ? fromRow(rows[0]) : transitionError(db, gid, 'failed')
  })

/**
 * tested -> active (or superseded -> active when going back), demoting the
 * current active generation to superseded in the same transaction.
 */
export const activate = (db: Db, id: number): Promise<ConfigGeneration> =>
  withSqliteErrors(() =>
    db.transaction(async (tx) => {
      const gid = assertGenId(id)
      const targetRows = await tx.query<GenerationRow>(`SELECT * FROM config_generations WHERE id = $1`, [gid])
      const target = mustExist(first(targetRows), 'config generation', gid)
      if (target.status === 'active') return fromRow(target)
      if (target.status !== 'tested' && target.status !== 'superseded') return transitionError(tx, gid, 'active')
      if (target.status === 'tested') {
        const activeRows = await tx.query<{ id: number }>(
          `SELECT id FROM config_generations WHERE status = 'active' LIMIT 1`,
        )
        const active = first(activeRows)
        if (active && active.id > target.id) {
          fail('PRECONDITION_FAILED', `config generation ${gid} is older than the active generation ${active.id}`, {
            id: gid,
            active: active.id,
          })
        }
      }
      await tx.query(
        `UPDATE config_generations SET status = 'superseded' WHERE status = 'active' AND id <> $1`,
        [gid],
      )
      const rows = await tx.query<GenerationRow>(
        `UPDATE config_generations SET status = 'active', activated_at = $1 WHERE id = $2 RETURNING *`,
        [nowIso(), gid],
      )
      return fromRow(rows[0]!)
    }),
  )

/**
 * The active generation failed after the switch (reload or health check):
 * mark it rolled_back and make `toId` (a superseded one) active again.
 */
export const rollbackTo = (db: Db, toId: number, error: string): Promise<ConfigGeneration> =>
  withSqliteErrors(() =>
    db.transaction(async (tx) => {
      const gid = assertGenId(toId)
      const reason = assertError(error)
      const targetRows = await tx.query<GenerationRow>(`SELECT * FROM config_generations WHERE id = $1`, [gid])
      const target = mustExist(first(targetRows), 'config generation', gid)
      if (target.status !== 'superseded') return transitionError(tx, gid, 'active')
      await tx.query(
        `UPDATE config_generations SET status = 'rolled_back', error = $1 WHERE status = 'active'`,
        [reason],
      )
      const rows = await tx.query<GenerationRow>(
        `UPDATE config_generations SET status = 'active', activated_at = $1 WHERE id = $2 RETURNING *`,
        [nowIso(), gid],
      )
      return fromRow(rows[0]!)
    }),
  )

/**
 * Atomically transitions a candidate generation (`pending`, `tested`, or `active`) to
 * `rolled_back` and restores `restoreToId` (if any) as the single `active` generation
 * inside one transaction, satisfying `config_generations_transition_guard` without
 * ever exposing a false `active` row outside the transaction.
 */
export const markGenerationRolledBack = (
  db: Db,
  candidateId: number,
  restoreToId: number | null,
  error: string,
): Promise<{ rolledBack: ConfigGeneration; active: ConfigGeneration | null }> =>
  withSqliteErrors(() =>
    db.transaction(async (tx) => {
      const cid = assertGenId(candidateId)
      const reason = assertError(error)
      const now = nowIso()

      const candRows = await tx.query<GenerationRow>(`SELECT * FROM config_generations WHERE id = $1`, [cid])
      let candidate = mustExist(first(candRows), 'config generation', cid)

      if (candidate.status === 'pending') {
        const testedRows = await tx.query<GenerationRow>(
          `UPDATE config_generations SET status = 'tested', tested_at = $1 WHERE id = $2 RETURNING *`,
          [now, cid],
        )
        candidate = mustExist(first(testedRows), 'config generation', cid)
      }

      if (candidate.status === 'tested') {
        await tx.query(
          `UPDATE config_generations SET status = 'superseded' WHERE status = 'active' AND id <> $1`,
          [cid],
        )
        await tx.query(
          `UPDATE config_generations SET status = 'active', activated_at = $1 WHERE id = $2`,
          [now, cid],
        )
        const rbRows = await tx.query<GenerationRow>(
          `UPDATE config_generations SET status = 'rolled_back', error = $1 WHERE id = $2 RETURNING *`,
          [reason, cid],
        )
        candidate = mustExist(first(rbRows), 'config generation', cid)
      } else if (candidate.status === 'active') {
        const rbRows = await tx.query<GenerationRow>(
          `UPDATE config_generations SET status = 'rolled_back', error = $1 WHERE id = $2 RETURNING *`,
          [reason, cid],
        )
        candidate = mustExist(first(rbRows), 'config generation', cid)
      } else if (candidate.status !== 'rolled_back') {
        return transitionError(tx, cid, 'rolled_back')
      }

      let activeGen: ConfigGeneration | null = null
      if (restoreToId !== null) {
        const rid = assertGenId(restoreToId)
        const targetRows = await tx.query<GenerationRow>(`SELECT * FROM config_generations WHERE id = $1`, [rid])
        const target = mustExist(first(targetRows), 'config generation', rid)
        if (target.status === 'active') {
          activeGen = fromRow(target)
        } else if (target.status === 'superseded' || target.status === 'tested') {
          await tx.query(
            `UPDATE config_generations SET status = 'superseded' WHERE status = 'active' AND id <> $1`,
            [rid],
          )
          const actRows = await tx.query<GenerationRow>(
            `UPDATE config_generations SET status = 'active', activated_at = $1 WHERE id = $2 RETURNING *`,
            [now, rid],
          )
          activeGen = fromRow(mustExist(first(actRows), 'config generation', rid))
        } else {
          return transitionError(tx, rid, 'active')
        }
      }

      return { rolledBack: fromRow(candidate), active: activeGen }
    }),
  )

export const latestActive = async (db: Db): Promise<ConfigGeneration | null> => {
  const rows = await db.query<GenerationRow>(`SELECT * FROM config_generations WHERE status = 'active' LIMIT 1`)
  const row = first(rows)
  return row ? fromRow(row) : null
}

/** Most recent superseded generation: the default rollback target. */
export const previousGeneration = async (db: Db): Promise<ConfigGeneration | null> => {
  const rows = await db.query<GenerationRow>(
    `SELECT * FROM config_generations
     WHERE status = 'superseded'
     ORDER BY activated_at DESC, id DESC
     LIMIT 1`,
  )
  const row = first(rows)
  return row ? fromRow(row) : null
}

export const listGenerations = async (db: Db, opts: { limit?: number } = {}): Promise<ConfigGeneration[]> => {
  const limit = clampLimit(opts.limit, 50, 1000)
  const rows = await db.query<GenerationRow>(
    `SELECT * FROM config_generations ORDER BY id DESC LIMIT $1`,
    [limit],
  )
  return rows.map(fromRow)
}
