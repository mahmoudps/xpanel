import { randomUUID } from 'node:crypto'
import { asc, count, eq, isNull } from 'drizzle-orm'
import { fail, planErrors } from '@xpanel/core'
import type { Id, Plan, PlanCaps, ResourceLimits, ShellAccess } from '@xpanel/core'
import type { Db } from '../client.ts'
import { planFromRow, planToRow } from '../mappers.ts'
import { withPgErrors } from '../pg-errors.ts'
import { accounts, featureLists, plans } from '../schema.ts'
import { assertId, assertIdOrNull, first, isUuid, mustExist, rejectErrors } from './util.ts'
import { assertResellersStillFit } from './capacity.ts'

export type NewPlan = Omit<Plan, 'id'>

export interface PlanPatch {
  name?: string
  featureListId?: Id
  resources?: Partial<ResourceLimits>
  caps?: Partial<PlanCaps>
  dedicatedIp?: boolean
  shell?: ShellAccess
  defaultMailboxQuotaMb?: Plan['defaultMailboxQuotaMb']
}

/** A plan uses a root-owned feature list or one of its own owner. */
const assertFeatureListUsable = async (tx: Db, plan: Pick<Plan, 'featureListId' | 'ownerId'>): Promise<void> => {
  const fl = mustExist(
    first(await tx.select({ ownerId: featureLists.ownerId }).from(featureLists).where(eq(featureLists.id, plan.featureListId))),
    'feature list',
    plan.featureListId,
  )
  if (fl.ownerId !== null && fl.ownerId !== plan.ownerId) fail('FORBIDDEN', 'the feature list belongs to another reseller')
}

/** Structural rules from core (field ranges, unknown keys, mailbox quota within disk). */
const validated = (plan: Plan): Plan => {
  rejectErrors('plan', planErrors(plan))
  return { ...plan, ownerId: assertIdOrNull(plan.ownerId, 'ownerId'), featureListId: assertId(plan.featureListId, 'featureListId') }
}

export const createPlan = (db: Db, input: NewPlan): Promise<Plan> =>
  withPgErrors(() =>
    db.transaction(async (tx) => {
      const plan = validated({ ...input, id: randomUUID() })
      await assertFeatureListUsable(tx, plan)
      const [row] = await tx.insert(plans).values(planToRow(plan)).returning()
      return planFromRow(mustExist(row, 'plan', plan.name))
    }),
  )

export const getPlan = async (db: Db, id: Id): Promise<Plan | null> => {
  if (!isUuid(id)) return null
  const row = first(await db.select().from(plans).where(eq(plans.id, id)))
  return row ? planFromRow(row) : null
}

/** ownerId: undefined = all, null = root-owned, id = that reseller's plans. */
export const listPlans = async (db: Db, opts: { ownerId?: Id | null } = {}): Promise<Plan[]> => {
  const where =
    opts.ownerId === undefined ? undefined : opts.ownerId === null ? isNull(plans.ownerId) : eq(plans.ownerId, assertId(opts.ownerId, 'ownerId'))
  const rows = await db.select().from(plans).where(where).orderBy(asc(plans.name))
  return rows.map(planFromRow)
}

/**
 * Validates the merged plan as a whole. Raising disk or bandwidth is refused while it would
 * push a reseller with overselling off past its totals.
 */
export const updatePlan = (db: Db, id: Id, patch: PlanPatch): Promise<Plan> =>
  withPgErrors(() =>
    db.transaction(async (tx) => {
      const row = mustExist(first(await tx.select().from(plans).where(eq(plans.id, assertId(id, 'id'))).for('update')), 'plan', id)
      const current = planFromRow(row)
      if (typeof patch !== 'object' || patch === null) fail('VALIDATION', 'plan patch must be an object')
      const next = validated({
        ...current,
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.featureListId !== undefined && { featureListId: patch.featureListId }),
        ...(patch.resources !== undefined && { resources: { ...current.resources, ...patch.resources } }),
        ...(patch.caps !== undefined && { caps: { ...current.caps, ...patch.caps } }),
        ...(patch.dedicatedIp !== undefined && { dedicatedIp: patch.dedicatedIp }),
        ...(patch.shell !== undefined && { shell: patch.shell }),
        ...(patch.defaultMailboxQuotaMb !== undefined && { defaultMailboxQuotaMb: patch.defaultMailboxQuotaMb }),
      })
      if (next.featureListId !== current.featureListId) await assertFeatureListUsable(tx, next)
      await assertResellersStillFit(tx, next)
      const { id: _id, ...values } = planToRow(next)
      const [updated] = await tx.update(plans).set(values).where(eq(plans.id, current.id)).returning()
      return planFromRow(mustExist(updated, 'plan', id))
    }),
  )

export const countAccountsOnPlan = async (db: Db, id: Id): Promise<number> => {
  if (!isUuid(id)) return 0
  const [row] = await db.select({ n: count() }).from(accounts).where(eq(accounts.planId, id))
  return row?.n ?? 0
}

/** Fails with CONFLICT while an account is still on the plan. */
export const deletePlan = (db: Db, id: Id): Promise<boolean> =>
  withPgErrors(async () => {
    if (!isUuid(id)) return false
    const rows = await db.delete(plans).where(eq(plans.id, id)).returning({ id: plans.id })
    return rows.length > 0
  })
