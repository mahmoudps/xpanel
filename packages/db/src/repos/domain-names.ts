// Server-wide domain name ownership. The unique index only catches an exact clash; core's
// assertDomainUnique also refuses `www.` collisions and names above or below another
// account's domain (zone or subdomain takeover). Every writer of domain names takes one
// advisory lock first, so two overlapping names cannot be checked and inserted concurrently.
import { inArray, like, or, sql } from 'drizzle-orm'
import { assertDomainUnique } from '@xpanel/core'
import type { DomainKind, Id } from '@xpanel/core'
import type { Db } from '../client.ts'
import { LOCKS } from '../locks.ts'
import { domains } from '../schema.ts'
import { advisoryLock, escapeLike } from './util.ts'

export const lockDomainNames = (tx: Db): Promise<void> => advisoryLock(tx, LOCKS.domainNames)

/** The name itself, every parent (which also covers `www.` stripped) and everything below it. */
export const overlappingDomains = async (tx: Db, name: string): Promise<{ id: Id; name: string; accountId: Id; kind: DomainKind }[]> => {
  const labels = name.split('.')
  const selfAndParents = labels.map((_, i) => labels.slice(i).join('.'))
  const lower = sql<string>`lower(${domains.name})`
  return tx
    .select({ id: domains.id, name: domains.name, accountId: domains.accountId, kind: domains.kind })
    .from(domains)
    .where(or(inArray(lower, selfAndParents), like(lower, `%.${escapeLike(name)}`)))
}

/**
 * CONFLICT unless `name` (canonical) is free for `accountId`; undefined means a new account,
 * for which every overlap is foreign. Rows in `ignore` (being renamed) do not count.
 */
export const assertNameFree = async (tx: Db, name: string, accountId: Id | undefined, ignore: ReadonlySet<Id> = new Set()): Promise<void> => {
  const rows = (await overlappingDomains(tx, name)).filter((d) => !ignore.has(d.id))
  assertDomainUnique(name, rows, accountId)
}
