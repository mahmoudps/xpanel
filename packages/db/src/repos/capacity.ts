// Reseller capacity (account count, no-oversell disk and bandwidth totals) checked under a
// row lock on the reseller, so concurrent creations under one reseller cannot both pass.
// The rule itself is core's assertResellerCapacity; this module only gathers the inputs.
import { and, eq, isNotNull, ne } from 'drizzle-orm'
import { assertResellerCapacity } from '@xpanel/core'
import type { Id, Plan, Reseller } from '@xpanel/core'
import type { Db } from '../client.ts'
import { planFromRow, resellerFromRow } from '../mappers.ts'
import { accounts, plans, principals, resellers } from '../schema.ts'
import { first, mustExist } from './util.ts'

const lockReseller = async (tx: Db, id: Id): Promise<Reseller> => {
  const row = first(
    await tx
      .select({ r: resellers, username: principals.username })
      .from(resellers)
      .innerJoin(principals, eq(principals.id, resellers.id))
      .where(eq(resellers.id, id))
      .for('update', { of: resellers }),
  )
  const found = mustExist(row, 'reseller', id)
  return resellerFromRow({ ...found.r, username: found.username })
}

const ownedPlans = async (tx: Db, resellerId: Id, exceptAccountId?: Id): Promise<{ accountPlanId: Id; plan: Plan }[]> => {
  const rows = await tx
    .select({ planRow: plans })
    .from(accounts)
    .innerJoin(plans, eq(plans.id, accounts.planId))
    .where(and(eq(accounts.ownerId, resellerId), exceptAccountId === undefined ? undefined : ne(accounts.id, exceptAccountId)))
  return rows.map((r) => ({ accountPlanId: r.planRow.id, plan: planFromRow(r.planRow) }))
}

/** An account joins `resellerId` on `plan` (new, moved in, or `exceptAccountId` changing plan). */
export const assertResellerHasRoom = async (
  tx: Db,
  resellerId: Id,
  plan: Plan,
  opts: { isNewAccount: boolean; exceptAccountId?: Id },
): Promise<void> => {
  const reseller = await lockReseller(tx, resellerId)
  const owned = await ownedPlans(tx, resellerId, opts.exceptAccountId)
  assertResellerCapacity({ reseller, ownedAccounts: owned, newPlan: plan, isNewAccount: opts.isNewAccount })
}

/** After `plan` (already merged) is edited, every reseller with accounts on it must still fit its totals. */
export const assertResellersStillFit = async (tx: Db, plan: Plan): Promise<void> => {
  const owners = await tx
    .selectDistinct({ ownerId: accounts.ownerId })
    .from(accounts)
    .where(and(eq(accounts.planId, plan.id), isNotNull(accounts.ownerId)))
  for (const { ownerId } of owners) {
    const reseller = await lockReseller(tx, ownerId as Id)
    const owned = (await ownedPlans(tx, reseller.id)).map((o) => (o.accountPlanId === plan.id ? { ...o, plan } : o))
    // core always counts `newPlan` once more, so one account on this plan stands in for it
    const standIn = owned.findIndex((o) => o.accountPlanId === plan.id)
    const others = owned.filter((_, i) => i !== standIn)
    assertResellerCapacity({ reseller, ownedAccounts: others, newPlan: plan, isNewAccount: false })
  }
}
