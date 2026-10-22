import { asc, eq, isNull } from 'drizzle-orm'
import { fail } from '@xpanel/core'
import type { FeatureList, Id } from '@xpanel/core'
import type { Db } from '../client.ts'
import { withPgErrors } from '../pg-errors.ts'
import { featureLists } from '../schema.ts'
import { assertName } from '../validate.ts'
import { assertId, assertIdOrNull, defined, first, isUuid, mustExist } from './util.ts'

type Row = typeof featureLists.$inferSelect

const FEATURE_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

const fromRow = (r: Row): FeatureList => ({ id: r.id, name: r.name, ownerId: r.ownerId, disabled: r.disabled })

const assertKeys = (keys: unknown): string[] => {
  if (!Array.isArray(keys) || keys.length > 1024) return fail('VALIDATION', 'disabled must be a list of feature keys')
  for (const k of keys) {
    if (typeof k !== 'string' || !FEATURE_KEY_RE.test(k)) return fail('VALIDATION', 'invalid feature key', { key: String(k) })
  }
  return [...new Set(keys as string[])].sort()
}

export const createFeatureList = (db: Db, input: Omit<FeatureList, 'id'>): Promise<FeatureList> =>
  withPgErrors(async () => {
    const [row] = await db
      .insert(featureLists)
      .values({
        name: assertName(input.name),
        ownerId: assertIdOrNull(input.ownerId, 'ownerId'),
        disabled: assertKeys(input.disabled),
      })
      .returning()
    return fromRow(mustExist(row, 'feature list', input.name))
  })

export const getFeatureList = async (db: Db, id: Id): Promise<FeatureList | null> => {
  if (!isUuid(id)) return null
  const row = first(await db.select().from(featureLists).where(eq(featureLists.id, id)))
  return row ? fromRow(row) : null
}

/** ownerId: undefined = all, null = root-owned, id = that reseller's lists. */
export const listFeatureLists = async (db: Db, opts: { ownerId?: Id | null } = {}): Promise<FeatureList[]> => {
  const where =
    opts.ownerId === undefined ? undefined : opts.ownerId === null ? isNull(featureLists.ownerId) : eq(featureLists.ownerId, assertId(opts.ownerId, 'ownerId'))
  const rows = await db.select().from(featureLists).where(where).orderBy(asc(featureLists.name))
  return rows.map(fromRow)
}

export const updateFeatureList = (db: Db, id: Id, patch: Partial<Pick<FeatureList, 'name' | 'disabled'>>): Promise<FeatureList> =>
  withPgErrors(async () => {
    const values = defined({
      name: patch.name === undefined ? undefined : assertName(patch.name),
      disabled: patch.disabled === undefined ? undefined : assertKeys(patch.disabled),
    })
    if (Object.keys(values).length === 0) return mustExist(await getFeatureList(db, id), 'feature list', id)
    const [row] = await db.update(featureLists).set(values).where(eq(featureLists.id, assertId(id, 'id'))).returning()
    return fromRow(mustExist(row, 'feature list', id))
  })

/** Fails with CONFLICT while a plan still uses the list. */
export const deleteFeatureList = (db: Db, id: Id): Promise<boolean> =>
  withPgErrors(async () => {
    if (!isUuid(id)) return false
    const rows = await db.delete(featureLists).where(eq(featureLists.id, id)).returning({ id: featureLists.id })
    return rows.length > 0
  })
