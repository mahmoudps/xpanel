import type { Account, Id, Reseller } from '@xpanel/core'
import type { BandwidthReport } from '../../agent/src/metering.ts'
import type { AccountUsageObservation, ResellerUsageObservation } from '../../web/src/models/reseller-usage.ts'

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/

/** Strict reader for the agent's /host/quota/usage reply; null when it cannot be verified. */
export function readQuotaUsageReply(raw: unknown): { observedAt: string; used: ReadonlyMap<string, number> } | null {
  const r = raw as Record<string, unknown> | null
  if (!r || typeof r !== 'object' || r.state !== 'read' || typeof r.observedAt !== 'string' || !ISO.test(r.observedAt) || !Array.isArray(r.users) || r.users.length > 65536) return null
  const used = new Map<string, number>()
  for (const item of r.users as unknown[]) {
    const u = item as Record<string, unknown> | null
    if (!u || typeof u.username !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(u.username) || !Number.isSafeInteger(u.usedBytes) || (u.usedBytes as number) < 0 || used.has(u.username)) return null
    used.set(u.username, u.usedBytes as number)
  }
  return { observedAt: r.observedAt, used }
}

/** Each listed account's own disk and traffic from the same two sources; unmeasured only when a read source lacks it. */
export function accountUsage(accounts: readonly Pick<Account, 'id' | 'username'>[], quota: ReturnType<typeof readQuotaUsageReply>, bandwidth: BandwidthReport | null): Record<Id, AccountUsageObservation> {
  const traffic = bandwidth && bandwidth.state !== 'unavailable' ? new Map(bandwidth.accounts.map(row => [row.username, row.totalBytes])) : null
  const one = (read: boolean, value: number | null | undefined, observedAt: string | null) => !read ? { state: 'unavailable' as const, bytes: null, observedAt: null, unmeasured: 1 }
    : value == null ? { state: 'read' as const, bytes: null, observedAt, unmeasured: 1 } : { state: 'read' as const, bytes: value, observedAt, unmeasured: 0 }
  return Object.fromEntries(accounts.map(account => [account.id, {
    disk: one(quota !== null, quota?.used.get(account.username), quota?.observedAt ?? null),
    traffic: one(traffic !== null, traffic?.get(account.username), bandwidth?.updatedAt ?? null),
  }]))
}

/**
 * Totals each reseller's owned accounts from the user quota report (disk) and the bandwidth meter (this UTC month's
 * traffic). A missing source is unavailable, never zero; an account the source does not list is counted as unmeasured.
 */
export function resellerUsage(resellers: readonly Pick<Reseller, 'id'>[], accounts: readonly Pick<Account, 'ownerId' | 'username'>[],
  quota: ReturnType<typeof readQuotaUsageReply>, bandwidth: BandwidthReport | null): Record<Id, ResellerUsageObservation> {
  const traffic = bandwidth && bandwidth.state !== 'unavailable' ? new Map(bandwidth.accounts.map(row => [row.username, row.totalBytes])) : null
  return Object.fromEntries(resellers.map(reseller => {
    const owned = accounts.filter(account => account.ownerId === reseller.id)
    const disk = owned.map(account => quota?.used.get(account.username))
    const sent = owned.map(account => traffic?.get(account.username) ?? undefined)
    const total = (values: (number | null | undefined)[]) => values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    return [reseller.id, {
      accounts: owned.length,
      disk: quota ? { state: 'read', bytes: total(disk), observedAt: quota.observedAt, unmeasured: disk.filter(value => value === undefined).length }
        : { state: 'unavailable', bytes: null, observedAt: null, unmeasured: owned.length },
      traffic: traffic ? { state: 'read', bytes: total(sent), observedAt: bandwidth!.updatedAt, unmeasured: sent.filter(value => value == null).length, month: bandwidth!.month }
        : { state: 'unavailable', bytes: null, observedAt: null, unmeasured: owned.length, month: bandwidth?.month ?? null },
    } satisfies ResellerUsageObservation]
  }))
}
