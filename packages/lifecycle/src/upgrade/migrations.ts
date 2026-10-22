import { fail } from '@xpanel/core'

/**
 * A pending control-DB migration as the db runner reports it. SQL-level expand-only rules
 * (no DROP, RENAME, type change) are enforced by that runner on every non-contract file;
 * the upgrade adds the hot-path rule on top: contract migrations never run during a switch.
 */
export interface PendingMigration {
  version: number
  /** file name, e.g. 0005_accounts_note.sql */
  name: string
  /** *_contract.sql: drops and renames, allowed only in a later cold-path release */
  contract: boolean
}

/** Versions must run exactly from+1 .. to with no gap, and none may be a contract step. */
export const assertHotPathMigrations = (pending: readonly PendingMigration[], from: number, to: number): void => {
  if (!Array.isArray(pending)) fail('PRECONDITION_FAILED', 'migrator returned no migration list')
  let expected = from + 1
  for (const m of pending) {
    if (!Number.isSafeInteger(m?.version) || m.version !== expected) {
      fail('PRECONDITION_FAILED', `migration ${String(m?.name)} is out of sequence: expected ${expected}`, { version: m?.version, expected })
    }
    if (m.version > to) fail('PRECONDITION_FAILED', `migration ${m.name} is newer than the release schema ${to}`, { version: m.version, to })
    if (m.contract !== false) {
      fail('PRECONDITION_FAILED', `migration ${m.name} is a contract step; it cannot run while switching releases`, { version: m.version })
    }
    expected++
  }
  if (expected - 1 !== to) fail('PRECONDITION_FAILED', `pending migrations end at ${expected - 1}, release expects schema ${to}`, { from, to, last: expected - 1 })
}
