import { assertId, fail } from '@xpanel/core'
import type { Domain, DomainWorkspaceTransition as CoreDomainWorkspaceTransition, Id } from '@xpanel/core'
import type { Db } from '../client.ts'
import { withSqliteErrors } from '../sqlite-errors.ts'
import { nowIso } from './util.ts'

const domainColumns = [
  'id', 'account_id', 'name', 'kind', 'parent_id', 'doc_root', 'site_type', 'upstream',
  'redirect_to', 'redirect_code', 'php_version', 'php_handler', 'wildcard', 'certificate_id',
  'suspended', 'expires_at', 'path_quota_mb', 'created_at', 'updated_at',
] as const
const searchColumns = ['kind', 'entity_id', 'account_id', 'owner_id', 'title', 'subtitle', 'keywords'] as const
type DomainRow = Record<(typeof domainColumns)[number], unknown> & { checkpoint_rowid: string }
type SearchRow = Record<(typeof searchColumns)[number], unknown> & { checkpoint_rowid: string }
interface IndexSnapshot { domains: DomainRow[]; search: SearchRow[] }

const sameSnapshot = (a: IndexSnapshot, b: IndexSnapshot): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Read-only preparation for a transition already authorized under the StateStore lease. */
export const prepareDomainIndexTransition = async (
  db: Db, transition: CoreDomainWorkspaceTransition,
): Promise<{ apply(): Promise<void>; rollback(): Promise<void> }> => {
  const accountId = assertId(transition.account.id, 'accountId')
  const ids = transition.affectedIds.map(id => assertId(id, 'domainId')).sort()
  const affected = new Set(ids)
  if (affected.size !== ids.length) fail('VALIDATION', 'domain projection contains duplicate affected IDs')
  const seen = new Set<Id>()
  for (const records of [transition.before, transition.after]) {
    const local = new Set<Id>()
    for (const domain of records) {
      const id = assertId(domain.id, 'domainId')
      if (domain.accountId !== accountId) fail('FORBIDDEN', 'domain projection scope is unavailable')
      if (!affected.has(id) || local.has(id)) fail('VALIDATION', 'domain projection affected IDs do not match its records')
      local.add(id); seen.add(id)
    }
  }
  if (seen.size !== affected.size) fail('VALIDATION', 'domain projection affected IDs do not match its records')
  const names = transition.after.map(domain => domain.name.toLowerCase())
  if (new Set(names).size !== names.length) fail('VALIDATION', 'domain projection contains duplicate names')

  // Copy scalar projections before awaiting: callers cannot change the accepted
  // account/record/ID objects while preparation or SQL admission is pending.
  const account = transition.account
  const after = transition.after.map((domain: Domain) => ({
    id: domain.id,
    values: [domain.id, accountId, domain.name, domain.kind, domain.parentId, domain.docRoot, domain.siteType,
      domain.upstream, domain.redirect?.to ?? null, domain.redirect?.code ?? null, domain.php.version, domain.php.handler,
      domain.wildcard ? 1 : 0, domain.certificateId, domain.suspended ? 1 : 0, domain.expiresAt,
      domain.pathQuotaMb === undefined || domain.pathQuotaMb === 'unlimited' ? null : domain.pathQuotaMb, account.createdAt],
    search: ['domain', domain.id, accountId, account.ownerId ?? '', domain.name,
      `${account.username} (${domain.kind})`, `${domain.docRoot} ${domain.siteType} php${domain.php.version}`],
  }))
  const afterIds = new Set(after.map(row => row.id))

  const capture = async (tx: Db): Promise<IndexSnapshot> => {
    const domains: DomainRow[] = [], search: SearchRow[] = []
    for (const id of ids) {
      const rows = await tx.query<DomainRow>(
        `SELECT CAST(rowid AS TEXT) AS checkpoint_rowid, ${domainColumns.join(', ')} FROM idx_domains WHERE id = $1`, [id],
      )
      const entries = await tx.query<SearchRow>(
        `SELECT CAST(rowid AS TEXT) AS checkpoint_rowid, ${searchColumns.join(', ')}
         FROM search_fts WHERE kind = 'domain' AND entity_id = $1 ORDER BY rowid`, [id],
      )
      if (rows.some(row => row.account_id !== accountId) || entries.some(row => row.account_id !== accountId)) {
        fail('FORBIDDEN', 'domain projection scope is unavailable')
      }
      domains.push(...rows); search.push(...entries)
    }
    return { domains, search }
  }

  const before = await withSqliteErrors(() => db.transaction(async tx => {
    const snapshot = await capture(tx)
    for (const row of after) {
      const collisions = await tx.query<{ id: string }>('SELECT id FROM idx_domains WHERE lower(name) = lower($1) AND id <> $2', [row.values[2], row.id])
      if (collisions.some(collision => !affected.has(collision.id))) fail('CONFLICT', 'domain projection conflicts with an existing index entry')
    }
    return snapshot
  }))

  let attempted = false
  let postimage: IndexSnapshot | null = null
  return {
    async apply(): Promise<void> {
      if (attempted) fail('PRECONDITION_FAILED', 'domain projection was already attempted')
      attempted = true
      await withSqliteErrors(() => db.transaction(async tx => {
        if (!sameSnapshot(await capture(tx), before)) fail('CONFLICT', 'domain projection changed after preparation')
        for (const id of ids) {
          await tx.query("DELETE FROM search_fts WHERE kind = 'domain' AND entity_id = $1", [id])
          if (!afterIds.has(id)) await tx.query('DELETE FROM idx_domains WHERE id = $1', [id])
        }
        const at = nowIso()
        for (const row of after) {
          await tx.query(
            `INSERT INTO idx_domains (${domainColumns.join(', ')}) VALUES (${domainColumns.map((_, i) => '$' + (i + 1)).join(', ')})
             ON CONFLICT (id) DO UPDATE SET ${domainColumns.filter(column => column !== 'id').map(column => `${column} = excluded.${column}`).join(', ')}`,
            [...row.values, at],
          )
          await tx.query(`INSERT INTO search_fts (${searchColumns.join(', ')}) VALUES (${searchColumns.map((_, i) => '$' + (i + 1)).join(', ')})`, row.search)
        }
        postimage = await capture(tx)
      }))
    },
    async rollback(): Promise<void> {
      if (!attempted) return
      await withSqliteErrors(() => db.transaction(async tx => {
        const current = await capture(tx)
        if (sameSnapshot(current, before)) return
        if (!postimage || !sameSnapshot(current, postimage)) fail('CONFLICT', 'domain projection rollback requires verification')
        const originalIds = new Set(before.domains.map(row => row.id))
        for (const id of ids) {
          await tx.query("DELETE FROM search_fts WHERE kind = 'domain' AND entity_id = $1", [id])
          if (!originalIds.has(id)) await tx.query('DELETE FROM idx_domains WHERE id = $1', [id])
        }
        for (const row of before.domains) {
          await tx.query(
            `INSERT INTO idx_domains (rowid, ${domainColumns.join(', ')}) VALUES (${Array.from({ length: domainColumns.length + 1 }, (_, i) => '$' + (i + 1)).join(', ')})
             ON CONFLICT (id) DO UPDATE SET rowid = excluded.rowid, ${domainColumns.filter(column => column !== 'id').map(column => `${column} = excluded.${column}`).join(', ')}`,
            [row.checkpoint_rowid, ...domainColumns.map(column => row[column])],
          )
        }
        for (const row of before.search) {
          await tx.query(
            `INSERT INTO search_fts (rowid, ${searchColumns.join(', ')}) VALUES (${Array.from({ length: searchColumns.length + 1 }, (_, i) => '$' + (i + 1)).join(', ')})`,
            [row.checkpoint_rowid, ...searchColumns.map(column => row[column])],
          )
        }
      }))
      attempted = false; postimage = null
    },
  }
}
