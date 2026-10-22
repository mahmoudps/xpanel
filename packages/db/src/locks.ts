/**
 * Transaction-scoped advisory lock keys serialising writers that check before they write
 * (migrations, name overlaps, rule sets). Constants only: nothing user-supplied reaches SQL.
 */
export const LOCKS = {
  migrations: 7_390_262_001,
  generations: 7_390_262_002,
  domainNames: 7_390_262_003,
  firewall: 7_390_262_004,
} as const

export type LockKey = (typeof LOCKS)[keyof typeof LOCKS]
