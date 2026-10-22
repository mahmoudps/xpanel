import { and, desc, eq, inArray, ne } from 'drizzle-orm'
import { fail } from '@xpanel/core'
import type { Db } from '../client.ts'
import { LOCKS } from '../locks.ts'
import { withPgErrors } from '../pg-errors.ts'
import { configGenerations, GENERATION_STATUSES } from '../schema.ts'
import { assertLine, assertSha256Hex } from '../validate.ts'
import { advisoryLock, clampLimit, first, mustExist } from './util.ts'

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

type Row = typeof configGenerations.$inferSelect

const fromRow = (r: Row): ConfigGeneration => ({
  id: r.id,
  createdAt: r.createdAt.toISOString(),
  status: r.status,
  checksum: r.checksum,
  error: r.error,
  actor: r.actor,
  testedAt: r.testedAt ? r.testedAt.toISOString() : null,
  activatedAt: r.activatedAt ? r.activatedAt.toISOString() : null,
})

const assertGenId = (id: unknown): number =>
  typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : fail('VALIDATION', 'invalid generation id')

const assertError = (e: unknown): string => {
  if (typeof e !== 'string' || e.length === 0) return fail('VALIDATION', 'error text is required')
  // test output is multi-line; only NUL is refused
  if (e.includes('\0')) return fail('VALIDATION', 'error text contains NUL')
  return e.length > 16000 ? `${e.slice(0, 15990)}...[cut]` : e
}

export const getGeneration = async (db: Db, id: number): Promise<ConfigGeneration | null> => {
  if (!Number.isSafeInteger(id) || id <= 0) return null
  const row = first(await db.select().from(configGenerations).where(eq(configGenerations.id, id)))
  return row ? fromRow(row) : null
}

const transitionError = async (db: Db, id: number, to: GenerationStatus): Promise<never> => {
  const g = mustExist(await getGeneration(db, id), 'config generation', id)
  return fail('PRECONDITION_FAILED', `config generation ${id} cannot go from ${g.status} to ${to}`, { id, status: g.status, to })
}

export const createGeneration = (db: Db, input: { checksum: string; actor?: string }): Promise<ConfigGeneration> =>
  withPgErrors(async () => {
    const [row] = await db
      .insert(configGenerations)
      .values({
        checksum: assertSha256Hex(input.checksum),
        actor: assertLine(input.actor ?? 'system', 255, 'actor', { allowEmpty: false }),
      })
      .returning()
    return fromRow(row as Row)
  })

/** pending -> tested, after nginx -t / apachectl configtest passed. */
export const markTested = (db: Db, id: number): Promise<ConfigGeneration> =>
  withPgErrors(async () => {
    const gid = assertGenId(id)
    const [row] = await db
      .update(configGenerations)
      .set({ status: 'tested', testedAt: new Date() })
      .where(and(eq(configGenerations.id, gid), eq(configGenerations.status, 'pending')))
      .returning()
    return row ? fromRow(row) : transitionError(db, gid, 'tested')
  })

/** pending|tested -> failed. The active generation is untouched, so the host keeps serving it. */
export const markFailed = (db: Db, id: number, error: string): Promise<ConfigGeneration> =>
  withPgErrors(async () => {
    const gid = assertGenId(id)
    const [row] = await db
      .update(configGenerations)
      .set({ status: 'failed', error: assertError(error) })
      .where(and(eq(configGenerations.id, gid), inArray(configGenerations.status, ['pending', 'tested'])))
      .returning()
    return row ? fromRow(row) : transitionError(db, gid, 'failed')
  })

/**
 * tested -> active (or superseded -> active when going back), demoting the
 * current active generation to superseded in the same transaction. A tested generation
 * older than the active one is stale (rendered from older desired state) and is refused;
 * going back to an earlier configuration goes through its superseded row.
 */
export const activate = (db: Db, id: number): Promise<ConfigGeneration> =>
  withPgErrors(() =>
    db.transaction(async (tx) => {
      const gid = assertGenId(id)
      await advisoryLock(tx, LOCKS.generations)
      const target = mustExist(first(await tx.select().from(configGenerations).where(eq(configGenerations.id, gid)).for('update')), 'config generation', gid)
      if (target.status === 'active') return fromRow(target)
      if (target.status !== 'tested' && target.status !== 'superseded') return transitionError(tx, gid, 'active')
      if (target.status === 'tested') {
        const active = first(await tx.select({ id: configGenerations.id }).from(configGenerations).where(eq(configGenerations.status, 'active')))
        if (active && active.id > target.id) {
          fail('PRECONDITION_FAILED', `config generation ${gid} is older than the active generation ${active.id}`, { id: gid, active: active.id })
        }
      }
      await tx
        .update(configGenerations)
        .set({ status: 'superseded' })
        .where(and(eq(configGenerations.status, 'active'), ne(configGenerations.id, gid)))
      const [row] = await tx
        .update(configGenerations)
        .set({ status: 'active', activatedAt: new Date() })
        .where(eq(configGenerations.id, gid))
        .returning()
      return fromRow(row as Row)
    }),
  )

/**
 * The active generation failed after the switch (reload or health check):
 * mark it rolled_back and make `toId` (a superseded one) active again.
 */
export const rollbackTo = (db: Db, toId: number, error: string): Promise<ConfigGeneration> =>
  withPgErrors(() =>
    db.transaction(async (tx) => {
      const gid = assertGenId(toId)
      const reason = assertError(error)
      await advisoryLock(tx, LOCKS.generations)
      const target = mustExist(first(await tx.select().from(configGenerations).where(eq(configGenerations.id, gid)).for('update')), 'config generation', gid)
      if (target.status !== 'superseded') return transitionError(tx, gid, 'active')
      await tx.update(configGenerations).set({ status: 'rolled_back', error: reason }).where(eq(configGenerations.status, 'active'))
      const [row] = await tx
        .update(configGenerations)
        .set({ status: 'active', activatedAt: new Date() })
        .where(eq(configGenerations.id, gid))
        .returning()
      return fromRow(row as Row)
    }),
  )

export const latestActive = async (db: Db): Promise<ConfigGeneration | null> => {
  const row = first(await db.select().from(configGenerations).where(eq(configGenerations.status, 'active')).limit(1))
  return row ? fromRow(row) : null
}

/** Most recent superseded generation: the default rollback target. */
export const previousGeneration = async (db: Db): Promise<ConfigGeneration | null> => {
  const row = first(
    await db
      .select()
      .from(configGenerations)
      .where(eq(configGenerations.status, 'superseded'))
      .orderBy(desc(configGenerations.activatedAt), desc(configGenerations.id))
      .limit(1),
  )
  return row ? fromRow(row) : null
}

export const listGenerations = async (db: Db, opts: { limit?: number } = {}): Promise<ConfigGeneration[]> =>
  (await db.select().from(configGenerations).orderBy(desc(configGenerations.id)).limit(clampLimit(opts.limit, 50, 1000))).map(fromRow)
