import { and, asc, count, eq, sql } from 'drizzle-orm'
import { assertCapAvailable, fail, isUnlimited, limitLte, parseServiceLogin } from '@xpanel/core'
import type { Id, Limit, Plan, PlanCapKey, ServiceUser } from '@xpanel/core'
import type { Db } from '../client.ts'
import { limitToDb, serviceUserFromRow } from '../mappers.ts'
import { withPgErrors } from '../pg-errors.ts'
import { domains, serviceUsers } from '../schema.ts'
import { assertRelPath, assertServiceHash } from '../validate.ts'
import { lockAccount, lockPlan } from './accounts.ts'
import { first, isUuid, mustExist } from './util.ts'

export type NewServiceUser = Omit<ServiceUser, 'id'> & {
  /** scheme-tagged hash for dovecot/FTP, e.g. {ARGON2ID}$argon2id$... */
  passwordHash: string
}

export interface ServiceUserPatch {
  services?: ServiceUser['services']
  mailboxQuotaMb?: Limit
  ftpDir?: string
  passwordHash?: string
}

type Services = ServiceUser['services']

const assertServices = (s: unknown): Services => {
  const o = s as Services
  if (typeof o !== 'object' || o === null || ![o.email, o.ftp, o.webdisk].every((b) => typeof b === 'boolean')) {
    return fail('VALIDATION', 'services must be { email, ftp, webdisk } booleans')
  }
  if (!o.email && !o.ftp && !o.webdisk) return fail('VALIDATION', 'a service user needs at least one service')
  return { email: o.email, ftp: o.ftp, webdisk: o.webdisk }
}

/** A finite mailbox quota is part of the account quota, so it may not exceed a finite disk cap. */
const assertMailboxQuota = (q: Limit, plan: Plan): number | null => {
  const stored = limitToDb(q, 'mailboxQuotaMb')
  if (stored === 0) fail('VALIDATION', 'mailboxQuotaMb must be at least 1 MB or unlimited')
  if (!isUnlimited(q) && !limitLte(q, plan.resources.diskMb)) fail('VALIDATION', 'mailboxQuotaMb may not exceed the account disk quota')
  return stored
}

const CAPS: { service: 'email' | 'ftp'; cap: PlanCapKey }[] = [
  { service: 'email', cap: 'mailboxes' },
  { service: 'ftp', cap: 'ftpAccounts' },
]

/** Mailboxes and FTP logins count against the plan as soon as the service is switched on. */
const assertServiceCaps = async (tx: Db, accountId: Id, plan: Plan, next: Services, before: Services | null): Promise<void> => {
  for (const { service, cap } of CAPS) {
    if (!next[service] || before?.[service]) continue
    const [row] = await tx
      .select({ n: count() })
      .from(serviceUsers)
      .where(and(eq(serviceUsers.accountId, accountId), eq(serviceUsers[service], true)))
    assertCapAvailable(plan, { [cap]: row?.n ?? 0 }, cap)
  }
}

const selectWithDomain = (db: Db) =>
  db.select({ u: serviceUsers, domainName: domains.name }).from(serviceUsers).innerJoin(domains, eq(domains.id, serviceUsers.domainId))

const toUser = (x: { u: typeof serviceUsers.$inferSelect; domainName: string }): ServiceUser =>
  serviceUserFromRow({ ...x.u, domainName: x.domainName })

/** The login (core's serviceLogin rules) must be on one of the account's own domains. */
export const createServiceUser = (db: Db, input: NewServiceUser): Promise<ServiceUser> =>
  withPgErrors(() =>
    db.transaction(async (tx) => {
      if (typeof input !== 'object' || input === null) fail('VALIDATION', 'service user must be an object')
      const { local, domain: domainName } = parseServiceLogin(input.login)
      const services = assertServices(input.services)
      const passwordHash = assertServiceHash(input.passwordHash)
      const ftpDir = assertRelPath(input.ftpDir, 'ftpDir')
      const account = await lockAccount(tx, input.accountId)
      const plan = await lockPlan(tx, account.planId)
      const domain = first(
        await tx
          .select({ id: domains.id })
          .from(domains)
          .where(and(eq(sql`lower(${domains.name})`, domainName), eq(domains.accountId, account.id))),
      )
      if (!domain) return fail('VALIDATION', 'login domain is not a domain of this account', { domain: domainName })
      await assertServiceCaps(tx, account.id, plan, services, null)
      const [row] = await tx
        .insert(serviceUsers)
        .values({
          accountId: account.id,
          domainId: domain.id,
          localPart: local,
          passwordHash,
          ...services,
          mailboxQuotaMb: assertMailboxQuota(input.mailboxQuotaMb, plan),
          ftpDir,
        })
        .returning()
      return serviceUserFromRow({ ...mustExist(row, 'service user', input.login), domainName })
    }),
  )

export const getServiceUser = async (db: Db, id: Id): Promise<ServiceUser | null> => {
  if (!isUuid(id)) return null
  const row = first(await selectWithDomain(db).where(eq(serviceUsers.id, id)))
  return row ? toUser(row) : null
}

/** Case-insensitive like mail lookups; a malformed login finds nothing. */
export const getServiceUserByLogin = async (db: Db, login: string): Promise<ServiceUser | null> => {
  let parsed: { local: string; domain: string }
  try {
    parsed = parseServiceLogin(login)
  } catch {
    return null
  }
  const row = first(
    await selectWithDomain(db).where(and(eq(serviceUsers.localPart, parsed.local), eq(sql`lower(${domains.name})`, parsed.domain))),
  )
  return row ? toUser(row) : null
}

/** For the mail/FTP renderers, which need the hash. */
export const getServiceUserHash = async (db: Db, id: Id): Promise<string | null> => {
  if (!isUuid(id)) return null
  const row = first(await db.select({ h: serviceUsers.passwordHash }).from(serviceUsers).where(eq(serviceUsers.id, id)))
  return row?.h ?? null
}

export const listServiceUsers = async (db: Db, accountId: Id): Promise<ServiceUser[]> => {
  if (!isUuid(accountId)) return []
  const rows = await selectWithDomain(db)
    .where(eq(serviceUsers.accountId, accountId))
    .orderBy(asc(domains.name), asc(serviceUsers.localPart))
  return rows.map(toUser)
}

export const updateServiceUser = (db: Db, id: Id, patch: ServiceUserPatch): Promise<ServiceUser> =>
  withPgErrors(() =>
    db.transaction(async (tx) => {
      if (typeof patch !== 'object' || patch === null) fail('VALIDATION', 'service user patch must be an object')
      const found = mustExist(await getServiceUser(tx, id), 'service user', id)
      const account = await lockAccount(tx, found.accountId)
      const plan = await lockPlan(tx, account.planId)
      const current = mustExist(await getServiceUser(tx, found.id), 'service user', id)
      const services = patch.services === undefined ? undefined : assertServices(patch.services)
      if (services) await assertServiceCaps(tx, account.id, plan, services, current.services)
      const values = {
        ...services,
        ...(patch.mailboxQuotaMb !== undefined && { mailboxQuotaMb: assertMailboxQuota(patch.mailboxQuotaMb, plan) }),
        ...(patch.ftpDir !== undefined && { ftpDir: assertRelPath(patch.ftpDir, 'ftpDir') }),
        ...(patch.passwordHash !== undefined && { passwordHash: assertServiceHash(patch.passwordHash) }),
      }
      if (Object.keys(values).length > 0) await tx.update(serviceUsers).set(values).where(eq(serviceUsers.id, current.id))
      return mustExist(await getServiceUser(tx, current.id), 'service user', id)
    }),
  )

export const deleteServiceUser = (db: Db, id: Id): Promise<boolean> =>
  withPgErrors(async () => {
    if (!isUuid(id)) return false
    const rows = await db.delete(serviceUsers).where(eq(serviceUsers.id, id)).returning({ id: serviceUsers.id })
    return rows.length > 0
  })
