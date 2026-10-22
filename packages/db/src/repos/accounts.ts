import { and, asc, count, eq, isNull, ne, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { defaultDocRoot, fail, validateDomainName, validateHome, validateUsername } from '@xpanel/core'
import type { Account, AccountStatus, Id, PhpSettings, Plan, ShellAccess } from '@xpanel/core'
import type { Db } from '../client.ts'
import { accountFromRow, domainFromRow, planFromRow } from '../mappers.ts'
import { withPgErrors } from '../pg-errors.ts'
import { accounts, domains, plans, principals, uidAllocator } from '../schema.ts'
import { assertArgon2Hash, assertBool, assertEmail, assertIpv4, assertLine, assertPhpSettings, oneOf } from '../validate.ts'
import { assertResellerHasRoom } from './capacity.ts'
import { assertNameFree, lockDomainNames } from './domain-names.ts'
import { assertId, assertIdOrNull, first, isUuid, mustExist } from './util.ts'

export interface NewAccount {
  username: string
  /** argon2id PHC hash for the owner's panel login */
  passwordHash: string
  forcePasswordChange?: boolean
  primaryDomain: string
  planId: Id
  /** reseller id, or null for root-owned */
  ownerId: Id | null
  contactEmail: string
  ipv4: string
  shell: ShellAccess
  /** parent of the home directory, default /home */
  homeBase?: string
  /** PHP settings of the primary domain, checked against the plan's worker and memory caps */
  php: PhpSettings
}

const SHELLS: readonly ShellAccess[] = ['none', 'jailed']

const STATUSES: readonly AccountStatus[] = ['active', 'suspended', 'terminating']

/** Reads a plan with a share lock, so it cannot change under a capacity check in flight. */
export const lockPlan = async (tx: Db, planId: unknown): Promise<Plan> =>
  planFromRow(mustExist(first(await tx.select().from(plans).where(eq(plans.id, assertId(planId, 'planId'))).for('share')), 'plan', planId))

/**
 * Locks the account row for a change: per-account cap checks (domains, mailboxes, databases)
 * queue behind it. A terminating account takes no more changes while the reconciler tears it down.
 */
export const lockAccount = async (tx: Db, id: unknown): Promise<Account> => {
  const row = mustExist(first(await tx.select().from(accounts).where(eq(accounts.id, assertId(id, 'accountId'))).for('update')), 'account', id)
  if (row.status === 'terminating') fail('PRECONDITION_FAILED', 'the account is being terminated', { id: row.id })
  return accountFromRow(row)
}

/** An account is on a root plan or on a plan of the reseller that owns it. */
const assertPlanUsable = (plan: Plan, ownerId: Id | null): void => {
  if (plan.ownerId !== null && plan.ownerId !== ownerId) fail('FORBIDDEN', 'the plan belongs to another reseller')
}

/**
 * Takes the next UID from the never-reusing allocator. Call inside the
 * transaction that creates the account: a rollback discards the row but the
 * sequence has moved on, so the number is still never handed out twice.
 */
export const allocateUid = async (db: Db, username: string): Promise<number> => {
  const [row] = await db.insert(uidAllocator).values({ username: validateUsername(username) }).returning({ uid: uidAllocator.uid })
  return mustExist(row, 'uid', username).uid
}

/**
 * Account + UID + primary domain + owner login, atomically. Refused when the primary domain
 * overlaps another account's names, the plan is not usable by the owner, the reseller would
 * break its account count or (overselling off) its disk/bandwidth totals, or the PHP pool
 * breaks the plan's caps.
 */
export const createAccount = (db: Db, input: NewAccount): Promise<Account> =>
  withPgErrors(() =>
    db.transaction(async (tx) => {
      const username = validateUsername(input.username)
      const home = validateHome(`${input.homeBase ?? '/home'}/${username}`)
      const primaryDomain = validateDomainName(input.primaryDomain)
      const ownerId = assertIdOrNull(input.ownerId, 'ownerId')
      const values = {
        username,
        home,
        primaryDomain,
        ownerId,
        contactEmail: assertEmail(input.contactEmail, 'contactEmail'),
        ipv4: assertIpv4(input.ipv4),
        shell: oneOf(input.shell, SHELLS, 'shell'),
      }
      const passwordHash = assertArgon2Hash(input.passwordHash)
      const forcePasswordChange = input.forcePasswordChange === undefined ? false : assertBool(input.forcePasswordChange, 'forcePasswordChange')

      await lockDomainNames(tx)
      const plan = await lockPlan(tx, input.planId)
      assertPlanUsable(plan, ownerId)
      const php = assertPhpSettings(input.php, { phpWorkers: plan.caps.phpWorkers, memoryMb: plan.resources.memoryMb })
      if (ownerId !== null) await assertResellerHasRoom(tx, ownerId, plan, { isNewAccount: true })
      await assertNameFree(tx, primaryDomain, undefined)

      const uid = await allocateUid(tx, username)
      const [row] = await tx
        .insert(accounts)
        .values({ ...values, planId: plan.id, uid, gid: uid })
        .returning()
      const account = accountFromRow(mustExist(row, 'account', username))
      await tx.insert(domains).values({
        accountId: account.id,
        name: primaryDomain,
        kind: 'primary',
        parentId: null,
        docRoot: defaultDocRoot(account, 'primary', primaryDomain),
        siteType: 'php',
        php,
      })
      await tx.insert(principals).values({ kind: 'user', username, passwordHash, forcePasswordChange, accountId: account.id })
      return account
    }),
  )

export const getAccount = async (db: Db, id: Id): Promise<Account | null> => {
  if (!isUuid(id)) return null
  const row = first(await db.select().from(accounts).where(eq(accounts.id, id)))
  return row ? accountFromRow(row) : null
}

export const getAccountByUsername = async (db: Db, username: string): Promise<Account | null> => {
  if (typeof username !== 'string' || username.length > 64) return null
  const row = first(await db.select().from(accounts).where(eq(sql`lower(${accounts.username})`, username.toLowerCase())))
  return row ? accountFromRow(row) : null
}

export interface AccountFilter {
  /** undefined = all, null = root-owned, id = that reseller's accounts */
  ownerId?: Id | null
  status?: AccountStatus
  planId?: Id
}

const filterWhere = (f: AccountFilter): SQL | undefined =>
  and(
    f.ownerId === undefined ? undefined : f.ownerId === null ? isNull(accounts.ownerId) : eq(accounts.ownerId, assertId(f.ownerId, 'ownerId')),
    f.status === undefined ? undefined : eq(accounts.status, oneOf(f.status, STATUSES, 'status')),
    f.planId === undefined ? undefined : eq(accounts.planId, assertId(f.planId, 'planId')),
  )

export const listAccounts = async (db: Db, f: AccountFilter = {}): Promise<Account[]> =>
  (await db.select().from(accounts).where(filterWhere(f)).orderBy(asc(accounts.username))).map(accountFromRow)

export const countAccounts = async (db: Db, f: AccountFilter = {}): Promise<number> => {
  const [row] = await db.select({ n: count() }).from(accounts).where(filterWhere(f))
  return row?.n ?? 0
}

const updateWhere = async (db: Db, id: Id, values: Partial<typeof accounts.$inferInsert>, guard?: SQL): Promise<Account | null> => {
  const [row] = await db
    .update(accounts)
    .set(values)
    .where(and(eq(accounts.id, assertId(id, 'id')), guard))
    .returning()
  return row ? accountFromRow(row) : null
}

const transitionFailed = async (db: Db, id: Id, what: string): Promise<never> => {
  const current = mustExist(await getAccount(db, id), 'account', id)
  return fail('PRECONDITION_FAILED', `cannot ${what} an account that is ${current.status}`, { id, status: current.status })
}

/** active|suspended -> suspended. One flag; the reconciler applies it to vhost, slice, cron, FTP and mail. */
export const suspendAccount = (db: Db, id: Id, reason: string): Promise<Account> =>
  withPgErrors(async () => {
    const r = assertLine(reason, 512, 'suspend reason', { allowEmpty: false })
    const row = await updateWhere(db, id, { status: 'suspended', suspendReason: r, suspendedAt: new Date() }, ne(accounts.status, 'terminating'))
    return row ?? transitionFailed(db, id, 'suspend')
  })

export const unsuspendAccount = (db: Db, id: Id): Promise<Account> =>
  withPgErrors(async () => {
    const row = await updateWhere(db, id, { status: 'active', suspendReason: null, suspendedAt: null }, eq(accounts.status, 'suspended'))
    return row ?? transitionFailed(db, id, 'unsuspend')
  })

/** First step of termination (confirmed by the caller); the reconciler tears down, then deleteAccount. */
export const markTerminating = (db: Db, id: Id): Promise<Account> =>
  withPgErrors(async () => {
    const row = await updateWhere(db, id, { status: 'terminating', suspendReason: null, suspendedAt: null })
    return row ?? transitionFailed(db, id, 'terminate')
  })

/**
 * Removes a terminating account and everything owned by it, after the reconciler tore the
 * host side down. Any other status is refused so no account skips that teardown.
 * The UID stays burnt in uid_allocator.
 */
export const deleteAccount = (db: Db, id: Id): Promise<boolean> =>
  withPgErrors(async () => {
    if (!isUuid(id)) return false
    const rows = await db
      .delete(accounts)
      .where(and(eq(accounts.id, id), eq(accounts.status, 'terminating')))
      .returning({ id: accounts.id })
    if (rows.length > 0) return true
    const current = await getAccount(db, id)
    return current === null ? false : fail('PRECONDITION_FAILED', 'only a terminating account can be deleted', { id, status: current.status })
  })

/** Every domain's PHP must still fit the caps of the plan the account moves to. */
const assertDomainsFit = async (tx: Db, accountId: Id, plan: Plan): Promise<void> => {
  const rows = await tx.select().from(domains).where(eq(domains.accountId, accountId))
  for (const d of rows.map(domainFromRow)) {
    assertPhpSettings(d.php, { phpWorkers: plan.caps.phpWorkers, memoryMb: plan.resources.memoryMb })
  }
}

/** Refused when the plan is not usable by the owner, a domain's PHP breaks its caps, or the reseller's totals would break. */
export const changePlan = (db: Db, id: Id, planId: Id): Promise<Account> =>
  withPgErrors(() =>
    db.transaction(async (tx) => {
      const account = await lockAccount(tx, id)
      const plan = await lockPlan(tx, planId)
      if (plan.id === account.planId) return account
      assertPlanUsable(plan, account.ownerId)
      await assertDomainsFit(tx, account.id, plan)
      if (account.ownerId !== null) await assertResellerHasRoom(tx, account.ownerId, plan, { isNewAccount: false, exceptAccountId: account.id })
      return mustExist(await updateWhere(tx, account.id, { planId: plan.id }), 'account', id)
    }),
  )

/** Moving to a reseller counts as a new account there, against its count and totals. */
export const changeOwner = (db: Db, id: Id, ownerId: Id | null): Promise<Account> =>
  withPgErrors(() =>
    db.transaction(async (tx) => {
      const account = await lockAccount(tx, id)
      const next = assertIdOrNull(ownerId, 'ownerId')
      if (next === account.ownerId) return account
      const plan = await lockPlan(tx, account.planId)
      assertPlanUsable(plan, next)
      if (next !== null) await assertResellerHasRoom(tx, next, plan, { isNewAccount: true, exceptAccountId: account.id })
      return mustExist(await updateWhere(tx, account.id, { ownerId: next }), 'account', id)
    }),
  )

export const updateAccount = (
  db: Db,
  id: Id,
  patch: { contactEmail?: string; ipv4?: string; shell?: ShellAccess },
): Promise<Account> =>
  withPgErrors(async () => {
    const values = {
      ...(patch.contactEmail !== undefined && { contactEmail: assertEmail(patch.contactEmail, 'contactEmail') }),
      ...(patch.ipv4 !== undefined && { ipv4: assertIpv4(patch.ipv4) }),
      ...(patch.shell !== undefined && { shell: oneOf(patch.shell, SHELLS, 'shell') }),
    }
    if (Object.keys(values).length === 0) return mustExist(await getAccount(db, id), 'account', id)
    return mustExist(await updateWhere(db, id, values), 'account', id)
  })
