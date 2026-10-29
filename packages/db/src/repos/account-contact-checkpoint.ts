import type { Id } from '@xpanel/core'
import type { Db } from '../client.ts'
import { withSqliteErrors } from '../sqlite-errors.ts'

const accountColumns = [
  'id', 'username', 'uid', 'gid', 'home', 'primary_domain', 'plan_id', 'owner_id',
  'status', 'suspend_reason', 'suspended_at', 'contact_email', 'ipv4', 'shell',
  'created_at', 'updated_at',
] as const

const searchColumns = ['kind', 'entity_id', 'account_id', 'owner_id', 'title', 'subtitle', 'keywords'] as const
type AccountIndexRow = Record<(typeof accountColumns)[number], unknown>
type SearchIndexRow = Record<(typeof searchColumns)[number], unknown> & { checkpoint_rowid: string }

/**
 * Captures a target's derived contact index before a writer-lease-protected change.
 * This is an in-process rollback preimage, not durable cross-store crash recovery.
 */
export const prepareAccountContactIndexRollback = async (db: Db, accountId: Id): Promise<() => Promise<void>> => {
  const preimage = await withSqliteErrors(() => db.transaction(async tx => {
    const accounts = await tx.query<AccountIndexRow>(
      `SELECT ${accountColumns.join(', ')} FROM idx_accounts WHERE id = $1`, [accountId],
    )
    const search = await tx.query<SearchIndexRow>(
      `SELECT CAST(rowid AS TEXT) AS checkpoint_rowid, ${searchColumns.join(', ')}
       FROM search_fts WHERE kind = 'account' AND entity_id = $1 ORDER BY rowid`, [accountId],
    )
    return { account: accounts[0] ?? null, search }
  }))

  return () => withSqliteErrors(() => db.transaction(async tx => {
    await tx.query(`DELETE FROM search_fts WHERE kind = 'account' AND entity_id = $1`, [accountId])
    if (preimage.account) {
      await tx.query(
        `INSERT INTO idx_accounts (${accountColumns.join(', ')})
         VALUES (${accountColumns.map((_, i) => '$' + (i + 1)).join(', ')})
         ON CONFLICT (id) DO UPDATE SET ${accountColumns.filter(column => column !== 'id').map(column => `${column} = excluded.${column}`).join(', ')}`,
        accountColumns.map(column => preimage.account![column]),
      )
    } else {
      await tx.query('DELETE FROM idx_accounts WHERE id = $1', [accountId])
    }
    for (const row of preimage.search) {
      // Plain INSERT refuses a rowid now owned by another entity; the transaction
      // rolls back rather than replacing that neighbor's search entry.
      await tx.query(
        `INSERT INTO search_fts (rowid, ${searchColumns.join(', ')})
         VALUES (${Array.from({ length: searchColumns.length + 1 }, (_, i) => '$' + (i + 1)).join(', ')})`,
        [row.checkpoint_rowid, ...searchColumns.map(column => row[column])],
      )
    }
  }))
}
