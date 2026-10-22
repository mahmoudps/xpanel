import { asc, count, eq, sql } from 'drizzle-orm'
import { fail, sumLimits, validateDomainName, validateUsername } from '@xpanel/core'
import type { Id, Limit, Reseller, ResellerAcl } from '@xpanel/core'
import type { Db } from '../client.ts'
import { limitFromDb, resellerFromRow, resellerToRow } from '../mappers.ts'
import { withPgErrors } from '../pg-errors.ts'
import { accounts, plans, principals, resellers } from '../schema.ts'
import { assertArgon2Hash, assertBool, assertIp } from '../validate.ts'
import { first, isUuid, mustExist } from './util.ts'

// a Record over the core union: adding a privilege to ResellerAcl fails to compile until it is listed here
const ACL_SET: Record<ResellerAcl, true> = {
  'create-account': true,
  'edit-account': true,
  'suspend-account': true,
  'terminate-account': true,
  'change-plan': true,
  'manage-plans': true,
  'manage-feature-lists': true,
  'manage-dns': true,
  'manage-ssl': true,
  'change-password': true,
  'list-accounts': true,
  'allow-unlimited-plans': true,
  'allow-oversell': true,
  transfer: true,
}

/** Every reseller privilege; the resellers.acl CHECK in 0001_init.sql lists the same values. */
export const RESELLER_ACLS = Object.keys(ACL_SET) as readonly ResellerAcl[]

export type NewReseller = Omit<Reseller, 'id'> & { passwordHash: string; forcePasswordChange?: boolean }
export type ResellerPatch = Partial<Omit<Reseller, 'id' | 'username'>>

const assertAcl = (acl: unknown): ResellerAcl[] => {
  if (!Array.isArray(acl)) return fail('VALIDATION', 'acl must be a list')
  for (const a of acl) if (typeof a !== 'string' || !Object.hasOwn(ACL_SET, a)) fail('VALIDATION', 'unknown reseller privilege', { acl: String(a).slice(0, 64) })
  return [...new Set(acl as ResellerAcl[])].sort()
}

const assertNameservers = (ns: unknown): string[] => {
  if (!Array.isArray(ns) || ns.length > 8) return fail('VALIDATION', 'nameservers: at most 8 host names')
  const out = ns.map((n) => validateDomainName(n))
  return new Set(out).size === out.length ? out : fail('VALIDATION', 'nameservers must be distinct')
}

/** Delegated addresses are single hosts (no prefixes), stored canonical and distinct. */
const assertIps = (ips: unknown): string[] => {
  if (!Array.isArray(ips) || ips.length > 4096) return fail('VALIDATION', 'delegatedIps must be a list')
  const out = ips.map((ip) => (typeof ip === 'string' && ip.includes('/') ? fail('VALIDATION', 'delegated ip must be a single address') : assertIp(ip, 'delegated ip')))
  return [...new Set(out)]
}

const selectReseller = (db: Db) =>
  db
    .select({ r: resellers, username: principals.username })
    .from(resellers)
    .innerJoin(principals, eq(principals.id, resellers.id))

const toReseller = (x: { r: typeof resellers.$inferSelect; username: string }): Reseller => resellerFromRow({ ...x.r, username: x.username })

/**
 * Creates the reseller's panel principal and its reseller row in one transaction. Reseller
 * logins share the account namespace and core's username rules (no system or role names).
 */
export const createReseller = (db: Db, input: NewReseller): Promise<Reseller> =>
  withPgErrors(() =>
    db.transaction(async (tx) => {
      const username = validateUsername(input.username)
      const passwordHash = assertArgon2Hash(input.passwordHash)
      // validate everything before the first write
      const { id: _placeholder, ...values } = resellerToRow({
        ...input,
        id: '',
        username,
        acl: assertAcl(input.acl),
        nameservers: assertNameservers(input.nameservers),
        delegatedIps: assertIps(input.delegatedIps),
        oversell: assertBool(input.oversell, 'oversell'),
      })
      const [p] = await tx
        .insert(principals)
        .values({
          kind: 'reseller',
          username,
          passwordHash,
          forcePasswordChange: input.forcePasswordChange === undefined ? false : assertBool(input.forcePasswordChange, 'forcePasswordChange'),
        })
        .returning({ id: principals.id })
      const id = mustExist(p, 'principal', username).id
      const [row] = await tx
        .insert(resellers)
        .values({ id, ...values })
        .returning()
      return resellerFromRow({ ...mustExist(row, 'reseller', username), username })
    }),
  )

export const getReseller = async (db: Db, id: Id): Promise<Reseller | null> => {
  if (!isUuid(id)) return null
  const row = first(await selectReseller(db).where(eq(resellers.id, id)))
  return row ? toReseller(row) : null
}

export const getResellerByUsername = async (db: Db, username: string): Promise<Reseller | null> => {
  if (typeof username !== 'string' || username.length > 64) return null
  const row = first(await selectReseller(db).where(eq(sql`lower(${principals.username})`, username.toLowerCase())))
  return row ? toReseller(row) : null
}

export const listResellers = async (db: Db): Promise<Reseller[]> =>
  (await selectReseller(db).orderBy(asc(principals.username))).map(toReseller)

export const updateReseller = (db: Db, id: Id, patch: ResellerPatch): Promise<Reseller> =>
  withPgErrors(async () => {
    const current = mustExist(await getReseller(db, id), 'reseller', id)
    const next = resellerToRow({
      ...current,
      ...patch,
      id: current.id,
      username: current.username,
      acl: patch.acl === undefined ? current.acl : assertAcl(patch.acl),
      nameservers: patch.nameservers === undefined ? current.nameservers : assertNameservers(patch.nameservers),
      delegatedIps: patch.delegatedIps === undefined ? current.delegatedIps : assertIps(patch.delegatedIps),
      oversell: patch.oversell === undefined ? current.oversell : assertBool(patch.oversell, 'oversell'),
    })
    const { id: _id, ...values } = next
    await db.update(resellers).set(values).where(eq(resellers.id, current.id))
    return mustExist(await getReseller(db, current.id), 'reseller', id)
  })

/** Fails with CONFLICT while the reseller still owns accounts. Owned plans and feature lists go with it. */
export const deleteReseller = (db: Db, id: Id): Promise<boolean> =>
  withPgErrors(async () => {
    if (!isUuid(id)) return false
    const r = await getReseller(db, id)
    if (!r) return false
    await db.delete(principals).where(eq(principals.id, id))
    return true
  })

export interface ResellerUsage {
  accounts: number
  /** sum of the disk limits of the plans of owned accounts; unlimited if any is */
  diskMb: Limit
  bandwidthMb: Limit
}

/** What the reseller has handed out, for maxAccounts and no-oversell checks. */
export const resellerUsage = async (db: Db, id: Id): Promise<ResellerUsage> => {
  if (!isUuid(id)) return { accounts: 0, diskMb: 0, bandwidthMb: 0 }
  const rows = await db
    .select({ n: count(), disk: plans.diskMb, bw: plans.bandwidthMbMonth })
    .from(accounts)
    .innerJoin(plans, eq(plans.id, accounts.planId))
    .where(eq(accounts.ownerId, id))
    .groupBy(plans.id, plans.diskMb, plans.bandwidthMbMonth)
  const expand = (pick: (r: (typeof rows)[number]) => number | null): Limit =>
    sumLimits(rows.map((r) => {
      const l = limitFromDb(pick(r))
      return l === 'unlimited' ? l : l * r.n
    }))
  return { accounts: rows.reduce((a, r) => a + r.n, 0), diskMb: expand((r) => r.disk), bandwidthMb: expand((r) => r.bw) }
}
