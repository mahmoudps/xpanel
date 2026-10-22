// nftables rule set and prefix lists. Validation, canonical form and the self-lockout rule
// are core's; this module stores them atomically. Every change runs under one advisory
// lock, re-validates the whole resulting set and refuses it (SELF_LOCKOUT) when the admin
// session saving it could no longer reach the panel or SSH port.
import { randomUUID } from 'node:crypto'
import { asc, eq, max, notInArray } from 'drizzle-orm'
import { assertNoSelfLockout, fail, validateFirewallRule, validateFirewallRules, validatePrefixList } from '@xpanel/core'
import type { FirewallRule, Id, LockoutContext } from '@xpanel/core'
import type { Db } from '../client.ts'
import { LOCKS } from '../locks.ts'
import { canonicalCidr, firewallRuleFromRow, firewallRuleToRow } from '../mappers.ts'
import { withPgErrors } from '../pg-errors.ts'
import { firewallPrefixLists, firewallRules } from '../schema.ts'
import { advisoryLock, first } from './util.ts'

/** `id` may be given (JSON import, default rules); otherwise a UUID is assigned. */
export type NewFirewallRule = Omit<FirewallRule, 'id'> & { id?: string }

export interface PrefixList {
  name: string
  /** canonical CIDRs */
  entries: string[]
}

/**
 * The admin session saving the change. `lockout: null` is an explicit statement that no
 * interactive session is involved (the agent's first boot, a root CLI), never a default.
 */
export interface FirewallGuard {
  lockout: Omit<LockoutContext, 'prefixLists'> | null
}

export interface FirewallState {
  rules: FirewallRule[]
  prefixLists: PrefixList[]
}

const RULE_ID_MAX = 64

const loadRules = async (db: Db): Promise<FirewallRule[]> =>
  (await db.select().from(firewallRules).orderBy(asc(firewallRules.sortOrder), asc(firewallRules.id))).map(firewallRuleFromRow)

const loadLists = async (db: Db): Promise<PrefixList[]> =>
  (await db.select().from(firewallPrefixLists).orderBy(asc(firewallPrefixLists.name))).map((r) => ({ name: r.name, entries: r.entries.map(canonicalCidr) }))

export const listFirewallRules = (db: Db): Promise<FirewallRule[]> => loadRules(db)

export const listPrefixLists = (db: Db): Promise<PrefixList[]> => loadLists(db)

export const getFirewallState = async (db: Db): Promise<FirewallState> => ({ rules: await loadRules(db), prefixLists: await loadLists(db) })

export const getFirewallRule = async (db: Db, id: Id): Promise<FirewallRule | null> => {
  if (typeof id !== 'string' || id.length === 0 || id.length > RULE_ID_MAX) return null
  const row = first(await db.select().from(firewallRules).where(eq(firewallRules.id, id)))
  return row ? firewallRuleFromRow(row) : null
}

const assertGuard = (guard: unknown): FirewallGuard => {
  const g = guard as FirewallGuard | null | undefined
  if (typeof g !== 'object' || g === null || !('lockout' in g)) {
    return fail('VALIDATION', 'firewall changes need the saving session for the lockout check (or lockout: null without one)')
  }
  return g
}

/** Every named list exists and, with a session, the session still reaches the panel (and SSH). */
const assertSafe = (state: FirewallState, guard: FirewallGuard): void => {
  const names = new Set(state.prefixLists.map((l) => l.name))
  for (const r of state.rules) {
    if (r.list !== null && !names.has(r.list)) fail('VALIDATION', `prefix list "${r.list}" does not exist`, { list: r.list, ruleId: r.id })
  }
  if (guard.lockout === null) return
  const prefixLists = Object.fromEntries(state.prefixLists.map((l) => [l.name, l.entries]))
  assertNoSelfLockout(state.rules, { ...guard.lockout, prefixLists })
}

const change = <T>(db: Db, guard: FirewallGuard, fn: (tx: Db, state: FirewallState, guard: FirewallGuard) => Promise<T>): Promise<T> =>
  withPgErrors(() => {
    const g = assertGuard(guard)
    return db.transaction(async (tx) => {
      await advisoryLock(tx, LOCKS.firewall)
      return fn(tx, await getFirewallState(tx), g)
    })
  })

/** Appends at the end of the rule order. */
export const createFirewallRule = (db: Db, input: NewFirewallRule, guard: FirewallGuard): Promise<FirewallRule> =>
  change(db, guard, async (tx, state, g) => {
    if (typeof input !== 'object' || input === null) fail('VALIDATION', 'rule must be an object')
    const rule = validateFirewallRule({ ...input, id: input.id ?? randomUUID() })
    if (state.rules.some((r) => r.id === rule.id)) fail('CONFLICT', `firewall rule "${rule.id}" already exists`, { id: rule.id })
    assertSafe({ ...state, rules: [...state.rules, rule] }, g)
    const [top] = await tx.select({ m: max(firewallRules.sortOrder) }).from(firewallRules)
    const [row] = await tx.insert(firewallRules).values(firewallRuleToRow(rule, (top?.m ?? -1) + 1)).returning()
    return firewallRuleFromRow(row as typeof firewallRules.$inferSelect)
  })

export const updateFirewallRule = (db: Db, id: Id, patch: Partial<Omit<FirewallRule, 'id'>>, guard: FirewallGuard): Promise<FirewallRule> =>
  change(db, guard, async (tx, state, g) => {
    const current = state.rules.find((r) => r.id === id) ?? fail('NOT_FOUND', 'firewall rule not found', { id: String(id).slice(0, RULE_ID_MAX) })
    if (typeof patch !== 'object' || patch === null || 'id' in patch) fail('VALIDATION', 'patch must be an object without id')
    const next = validateFirewallRule({ ...current, ...patch, id: current.id })
    assertSafe({ ...state, rules: state.rules.map((r) => (r.id === current.id ? next : r)) }, g)
    const { id: _id, sortOrder: _order, ...values } = firewallRuleToRow(next, 0)
    const [row] = await tx.update(firewallRules).set(values).where(eq(firewallRules.id, current.id)).returning()
    return firewallRuleFromRow(row as typeof firewallRules.$inferSelect)
  })

export const deleteFirewallRule = (db: Db, id: Id, guard: FirewallGuard): Promise<boolean> =>
  change(db, guard, async (tx, state, g) => {
    if (!state.rules.some((r) => r.id === id)) return false
    assertSafe({ ...state, rules: state.rules.filter((r) => r.id !== id) }, g)
    await tx.delete(firewallRules).where(eq(firewallRules.id, id))
    return true
  })

/** Moves a rule to `position` (0-based) and renumbers the set; order decides the first match. */
export const moveFirewallRule = (db: Db, id: Id, position: number, guard: FirewallGuard): Promise<FirewallRule[]> =>
  change(db, guard, async (tx, state, g) => {
    const rule = state.rules.find((r) => r.id === id) ?? fail('NOT_FOUND', 'firewall rule not found', { id: String(id).slice(0, RULE_ID_MAX) })
    if (!Number.isSafeInteger(position) || position < 0 || position >= state.rules.length) {
      fail('VALIDATION', `position must be 0..${state.rules.length - 1}`)
    }
    const rest = state.rules.filter((r) => r.id !== id)
    const rules = [...rest.slice(0, position), rule, ...rest.slice(position)]
    assertSafe({ ...state, rules }, g)
    // the unique sort_order constraint is deferred, so the renumbering may pass through duplicates
    for (const [i, r] of rules.entries()) await tx.update(firewallRules).set({ sortOrder: i }).where(eq(firewallRules.id, r.id))
    return loadRules(tx)
  })

const validLists = (lists: unknown): PrefixList[] => {
  if (!Array.isArray(lists) || lists.length > 256) return fail('VALIDATION', 'prefixLists must be an array of at most 256 lists')
  const out = lists.map((l: { name?: unknown; entries?: unknown }) => validatePrefixList(l?.name, l?.entries))
  const seen = new Set<string>()
  for (const l of out) {
    if (seen.has(l.name)) fail('VALIDATION', `duplicate prefix list "${l.name}"`, { name: l.name })
    seen.add(l.name)
  }
  return out
}

/** Replaces the whole rule set and the prefix lists (JSON import) atomically, in the given order. */
export const replaceFirewall = (db: Db, next: { rules: unknown; prefixLists: unknown }, guard: FirewallGuard): Promise<FirewallState> =>
  change(db, guard, async (tx, _state, g) => {
    if (typeof next !== 'object' || next === null) fail('VALIDATION', 'firewall import must be { rules, prefixLists }')
    const state: FirewallState = { rules: validateFirewallRules(next.rules), prefixLists: validLists(next.prefixLists) }
    assertSafe(state, g)
    await tx.delete(firewallRules)
    const names = state.prefixLists.map((l) => l.name)
    await tx.delete(firewallPrefixLists).where(names.length === 0 ? undefined : notInArray(firewallPrefixLists.name, names))
    for (const l of state.prefixLists) {
      await tx
        .insert(firewallPrefixLists)
        .values({ name: l.name, entries: l.entries })
        .onConflictDoUpdate({ target: firewallPrefixLists.name, set: { entries: l.entries } })
    }
    if (state.rules.length > 0) await tx.insert(firewallRules).values(state.rules.map((r, i) => firewallRuleToRow(r, i)))
    return getFirewallState(tx)
  })

/** Creates or replaces a list; rules naming it are re-checked against the new entries. */
export const savePrefixList = (db: Db, name: string, entries: string[], guard: FirewallGuard): Promise<PrefixList> =>
  change(db, guard, async (tx, state, g) => {
    const list = validatePrefixList(name, entries)
    assertSafe({ ...state, prefixLists: [...state.prefixLists.filter((l) => l.name !== list.name), list] }, g)
    await tx
      .insert(firewallPrefixLists)
      .values(list)
      .onConflictDoUpdate({ target: firewallPrefixLists.name, set: { entries: list.entries } })
    return list
  })

/** CONFLICT while a rule still names the list. */
export const deletePrefixList = (db: Db, name: string, guard: FirewallGuard): Promise<boolean> =>
  change(db, guard, async (tx, state) => {
    if (!state.prefixLists.some((l) => l.name === name)) return false
    const user = state.rules.find((r) => r.list === name)
    if (user) fail('CONFLICT', `prefix list "${name}" is used by rule "${user.id}"`, { name, ruleId: user.id })
    await tx.delete(firewallPrefixLists).where(eq(firewallPrefixLists.name, name))
    return true
  })
