import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { Account, Database } from '@xpanel/core'
import { createTestDb, type Db, type TestDbHandle } from '../client.ts'
import type { Row } from '../sql-runner.ts'
import { prepareDatabaseIndexCreation, prepareDatabaseIndexTransition } from './database-workspace-index.ts'
import { syncAccountContactIndex } from './reindex.ts'

const handles: TestDbHandle[] = []
afterEach(async () => { await Promise.all(handles.splice(0).map(handle => handle.close())) })
const accountFixture = (username: string, uid: number): Account => ({
  id: randomUUID(), username, uid, gid: uid, home: `/home/${username}`, primaryDomain: `${username}.example.test`,
  planId: randomUUID(), ownerId: randomUUID(), status: 'active', suspendReason: null, contactEmail: `${username}@example.test`,
  ipv4: '192.0.2.10', shell: 'none', createdAt: '2020-01-01T00:00:00.000Z',
})
const databaseFixture = (account: Account, suffix: string): Database => ({
  id: randomUUID(), accountId: account.id, engine: 'mariadb', name: `${account.username}_${suffix}`, trashedAt: null,
})
const seedDatabase = (db: Db, database: Database, rowid?: string) => db.query(
  'INSERT INTO idx_databases (rowid,id,account_id,engine,name,trashed_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
  [rowid ?? null, database.id, database.accountId, database.engine, database.name, database.trashedAt, '2018-01-01T00:00:00.000Z'],
)
const seedSearch = (db: Db, database: Database, rowid?: string, kind = 'database') => db.query(
  'INSERT INTO search_fts (rowid,kind,entity_id,account_id,owner_id,title,subtitle,keywords) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
  [rowid ?? null, kind, database.id, database.accountId, 'unchanged-owner', database.name, 'Unchanged subtitle', 'Unchanged keywords'],
)
const snapshot = async (db: Db) => ({
  databases: await db.query('SELECT CAST(rowid AS TEXT) AS checkpoint_rowid,* FROM idx_databases ORDER BY rowid'),
  search: await db.query('SELECT CAST(rowid AS TEXT) AS checkpoint_rowid,* FROM search_fts ORDER BY rowid'),
  accounts: await db.query('SELECT CAST(rowid AS TEXT) AS checkpoint_rowid,* FROM idx_accounts ORDER BY rowid'),
  domains: await db.query('SELECT CAST(rowid AS TEXT) AS checkpoint_rowid,* FROM idx_domains ORDER BY rowid'),
})
const fresh = async () => {
  const handle = await createTestDb(); handles.push(handle)
  const account = accountFixture('dbowner', 20041), neighbor = accountFixture('dbneighbor', 20042)
  const target = databaseFixture(account, 'blog'), other = databaseFixture(neighbor, 'existing')
  await syncAccountContactIndex(handle.db, neighbor)
  await seedDatabase(handle.db, other, '9007199254740993')
  await seedSearch(handle.db, other, '9007199254740995')
  await handle.db.query(
    `INSERT INTO idx_domains (id,account_id,name,kind,doc_root,site_type,php_version,php_handler,wildcard,suspended,created_at,updated_at)
     VALUES ($1,$2,$3,'addon',$4,'static','8.3','fpm',0,0,$5,$5)`,
    [randomUUID(), neighbor.id, 'neighbor.example.test', `${neighbor.home}/public_html`, neighbor.createdAt],
  )
  return { ...handle, account, neighbor, target, other }
}

const afterCommitFailure = (db: Db, failAt: number): Db => {
  let transactions = 0
  return {
    query: db.query, exec: db.exec,
    transaction: async work => {
      const result = await db.transaction(work)
      if (++transactions === failAt) throw new Error('synthetic acknowledgement failure after commit')
      return result
    },
  }
}

describe('creation-only database workspace index projection', () => {
  it('prepares read-only and makes rollback before apply a no-op', async () => {
    const f = await fresh(), before = await snapshot(f.db)
    const port = await prepareDatabaseIndexCreation(f.db, f.account, f.target)
    expect(await snapshot(f.db)).toEqual(before)
    await port.rollback()
    expect(await snapshot(f.db)).toEqual(before)
  })

  it.each([false, true])('projects six fields/search text without changing missing/existing account state: %s', async indexed => {
    const f = await fresh()
    await seedSearch(f.db, f.target, undefined, 'domain')
    if (indexed) {
      await syncAccountContactIndex(f.db, f.account)
      await f.db.query('UPDATE idx_accounts SET contact_email=$1,updated_at=$2 WHERE id=$3', ['cached@example.test', '2017-01-01T00:00:00.000Z', f.account.id])
    }
    const before = await snapshot(f.db), port = await prepareDatabaseIndexCreation(f.db, f.account, f.target)
    await port.apply()
    expect(await f.db.query('SELECT id,account_id,engine,name,trashed_at,created_at FROM idx_databases WHERE id=$1', [f.target.id])).toEqual([{
      id: f.target.id, account_id: f.account.id, engine: 'mariadb', name: f.target.name, trashed_at: null, created_at: f.account.createdAt,
    }])
    expect(await f.db.query("SELECT kind,entity_id,account_id,owner_id,title,subtitle,keywords FROM search_fts WHERE kind='database' AND entity_id=$1", [f.target.id])).toEqual([{
      kind: 'database', entity_id: f.target.id, account_id: f.account.id, owner_id: f.account.ownerId,
      title: f.target.name, subtitle: f.account.username, keywords: 'mariadb',
    }])
    const current = await snapshot(f.db)
    expect(current.accounts).toEqual(before.accounts)
    expect(current.domains).toEqual(before.domains)
    expect(current.databases.filter(row => row.id !== f.target.id)).toEqual(before.databases)
    expect(current.search.filter(row => !(row.kind === 'database' && row.entity_id === f.target.id))).toEqual(before.search)
    expect(current.databases.find(row => row.id === f.target.id)?.checkpoint_rowid).toBe('9007199254740994')
    expect(typeof current.search.find(row => row.kind === 'database' && row.entity_id === f.target.id)?.checkpoint_rowid).toBe('string')
    await expect(port.apply()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await port.rollback()
    expect(await snapshot(f.db)).toEqual(before)
  })

  it('pins accepted scalar inputs against caller mutation after preparation', async () => {
    const f = await fresh(), original = { ...f.target }, owner = { ...f.account }
    const port = await prepareDatabaseIndexCreation(f.db, f.account, f.target)
    f.target.id = randomUUID(); f.target.name = 'unreviewed_name'; f.target.accountId = f.neighbor.id
    f.account.username = 'unreviewed'; f.account.ownerId = f.neighbor.id; f.account.createdAt = '2030-01-01T00:00:00.000Z'
    await port.apply()
    expect(await f.db.query('SELECT account_id,name,created_at FROM idx_databases WHERE id=$1', [original.id])).toEqual([{
      account_id: owner.id, name: original.name, created_at: owner.createdAt,
    }])
    expect(await f.db.query("SELECT owner_id,subtitle FROM search_fts WHERE kind='database' AND entity_id=$1", [original.id])).toEqual([{
      owner_id: owner.ownerId, subtitle: owner.username,
    }])
  })

  it.each(['foreign', 'engine', 'trashed', 'name'] as const)('rejects invalid creation scope/state before effects: %s', async invalid => {
    const f = await fresh(), before = await snapshot(f.db)
    const candidate = { ...f.target }
    if (invalid === 'foreign') candidate.accountId = f.neighbor.id
    if (invalid === 'engine') (candidate as unknown as { engine: string }).engine = 'postgres'
    if (invalid === 'trashed') candidate.trashedAt = '2020-01-01T00:00:00.000Z'
    if (invalid === 'name') candidate.name = 'foreign_blog'
    const codes = { foreign: 'FORBIDDEN', engine: 'VALIDATION', trashed: 'PRECONDITION_FAILED', name: 'VALIDATION' }
    await expect(prepareDatabaseIndexCreation(f.db, f.account, candidate)).rejects.toMatchObject({ code: codes[invalid] })
    expect(await snapshot(f.db)).toEqual(before)
  })

  it.each(['id', 'name', 'search-id', 'search-title'] as const)('refuses a pre-existing collision without mutation: %s', async collision => {
    const f = await fresh()
    if (collision === 'id') await seedDatabase(f.db, { ...f.target, accountId: f.neighbor.id, name: 'dbneighbor_collision' })
    if (collision === 'name') await seedDatabase(f.db, { ...f.target, id: randomUUID(), accountId: f.neighbor.id, name: f.target.name.toUpperCase() })
    if (collision === 'search-id') await seedSearch(f.db, { ...f.target, accountId: f.neighbor.id, name: 'Different title' })
    if (collision === 'search-title') await seedSearch(f.db, { ...f.target, id: randomUUID(), accountId: f.neighbor.id, name: f.target.name.toUpperCase() })
    const before = await snapshot(f.db)
    await expect(prepareDatabaseIndexCreation(f.db, f.account, f.target)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await snapshot(f.db)).toEqual(before)
  })

  it('refuses apply and rollback over an entry introduced after preparation', async () => {
    const f = await fresh(), port = await prepareDatabaseIndexCreation(f.db, f.account, f.target)
    await seedDatabase(f.db, f.target)
    const current = await snapshot(f.db)
    await expect(port.apply()).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(port.rollback()).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await snapshot(f.db)).toEqual(current)
  })

  it.each(['database', 'search', 'rowid'] as const)('does not overwrite an intervening postimage change: %s', async changed => {
    const f = await fresh(), port = await prepareDatabaseIndexCreation(f.db, f.account, f.target)
    await port.apply()
    if (changed === 'database') await f.db.query('UPDATE idx_databases SET created_at=$1 WHERE id=$2', ['2030-01-01T00:00:00.000Z', f.target.id])
    if (changed === 'search') await f.db.query("UPDATE search_fts SET keywords=$1 WHERE kind='database' AND entity_id=$2", ['intervening terms', f.target.id])
    if (changed === 'rowid') await f.db.query('UPDATE idx_databases SET rowid=$1 WHERE id=$2', ['9007199254740999', f.target.id])
    const current = await snapshot(f.db)
    await expect(port.rollback()).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await snapshot(f.db)).toEqual(current)
  })

  it('rolls back the database insertion when the search insertion fails inside the transaction', async () => {
    const f = await fresh(), before = await snapshot(f.db)
    const wrapped: Db = {
      query: f.db.query, exec: f.db.exec,
      transaction: work => f.db.transaction(tx => work({
        query: async <T extends Row = Row>(sql: string, params?: readonly unknown[]): Promise<T[]> => {
          if (sql.startsWith('INSERT INTO search_fts')) throw new Error('synthetic search insertion failure')
          return tx.query<T>(sql, params)
        },
        exec: tx.exec, transaction: tx.transaction,
      })),
    }
    const port = await prepareDatabaseIndexCreation(wrapped, f.account, f.target)
    await expect(port.apply()).rejects.toThrow('synthetic search insertion failure')
    expect(await snapshot(f.db)).toEqual(before)
    await port.rollback()
    expect(await snapshot(f.db)).toEqual(before)
  })

  it('propagates uncertain apply acknowledgement and compensates only its exact committed postimage', async () => {
    const f = await fresh(), before = await snapshot(f.db)
    const port = await prepareDatabaseIndexCreation(afterCommitFailure(f.db, 2), f.account, f.target)
    await expect(port.apply()).rejects.toThrow('synthetic acknowledgement failure after commit')
    expect(await f.db.query('SELECT id FROM idx_databases WHERE id=$1', [f.target.id])).toHaveLength(1)
    await port.rollback()
    expect(await snapshot(f.db)).toEqual(before)
  })

  it('propagates uncertain rollback acknowledgement and subsequently recognizes proven absence', async () => {
    const f = await fresh(), before = await snapshot(f.db)
    const port = await prepareDatabaseIndexCreation(afterCommitFailure(f.db, 3), f.account, f.target)
    await port.apply()
    await expect(port.rollback()).rejects.toThrow('synthetic acknowledgement failure after commit')
    expect(await snapshot(f.db)).toEqual(before)
    await port.rollback()
    expect(await snapshot(f.db)).toEqual(before)
  })

  it('preserves the complete postimage on rollback SQL failure rather than deleting only search', async () => {
    const f = await fresh(), before = await snapshot(f.db)
    const port = await prepareDatabaseIndexCreation(f.db, f.account, f.target)
    await port.apply()
    await f.db.exec("CREATE TRIGGER reject_database_rollback BEFORE DELETE ON idx_databases BEGIN SELECT RAISE(ABORT,'Synthetic database rollback refusal'); END")
    const current = await snapshot(f.db)
    await expect(port.rollback()).rejects.toThrow()
    expect(await snapshot(f.db)).toEqual(current)
    await f.db.exec('DROP TRIGGER reject_database_rollback')
    await port.rollback()
    expect(await snapshot(f.db)).toEqual(before)
  })
})

const trashTimestamp = '2026-10-26T12:34:56.789Z'
const transitionFixture = async (trashed = false, withSearch = true) => {
  const f = await fresh()
  const before = { ...f.target, trashedAt: trashed ? trashTimestamp : null }
  const after = { ...before, trashedAt: trashed ? null : trashTimestamp }
  await seedDatabase(f.db, before, '9007199254740997')
  if (withSearch) await seedSearch(f.db, before, '9007199254740999')
  return { ...f, before, after }
}

describe('trash/restore database workspace index projection', () => {
  it('prepares read-only and makes rollback before apply a no-op', async () => {
    const f = await transitionFixture(), original = await snapshot(f.db)
    const port = await prepareDatabaseIndexTransition(f.db, f.account, f.before, f.after)
    expect(await snapshot(f.db)).toEqual(original)
    await port.rollback()
    expect(await snapshot(f.db)).toEqual(original)
  })

  it.each([false, true])('changes only trashed_at and restores exact rows including TEXT rowids: restore=%s', async trashed => {
    const f = await transitionFixture(trashed), original = await snapshot(f.db)
    const port = await prepareDatabaseIndexTransition(f.db, f.account, f.before, f.after)
    await port.apply()
    const current = await snapshot(f.db)
    expect(current).toEqual({ ...original, databases: original.databases.map(row => row.id === f.before.id ? { ...row, trashed_at: f.after.trashedAt } : row) })
    expect(current.databases.find(row => row.id === f.before.id)?.checkpoint_rowid).toBe('9007199254740997')
    await expect(port.apply()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await port.rollback()
    expect(await snapshot(f.db)).toEqual(original)
  })

  it('preserves a missing search projection without repairing it', async () => {
    const f = await transitionFixture(false, false), original = await snapshot(f.db)
    const port = await prepareDatabaseIndexTransition(f.db, f.account, f.before, f.after)
    await port.apply()
    expect((await snapshot(f.db)).search).toEqual(original.search)
    await port.rollback()
    expect(await snapshot(f.db)).toEqual(original)
  })

  it('pins accepted inputs before awaiting preparation', async () => {
    const f = await transitionFixture(), id = f.before.id
    const port = await prepareDatabaseIndexTransition(f.db, f.account, f.before, f.after)
    f.before.id = randomUUID(); f.before.trashedAt = trashTimestamp
    f.after.id = randomUUID(); f.after.trashedAt = null
    f.account.id = randomUUID(); f.account.username = 'unreviewed'
    await port.apply()
    expect(await f.db.query('SELECT trashed_at FROM idx_databases WHERE id=$1', [id])).toEqual([{ trashed_at: trashTimestamp }])
    await port.rollback()
    expect(await f.db.query('SELECT trashed_at FROM idx_databases WHERE id=$1', [id])).toEqual([{ trashed_at: null }])
  })

  it('rejects foreign scope, changed identities, unsupported engine and unowned names before effects', async () => {
    const f = await transitionFixture(), original = await snapshot(f.db)
    const invalid: { before: Database; after: Database; code: string }[] = [
      { before: { ...f.before, accountId: f.neighbor.id }, after: f.after, code: 'FORBIDDEN' },
      { before: f.before, after: { ...f.after, accountId: f.neighbor.id }, code: 'FORBIDDEN' },
      { before: f.before, after: { ...f.after, id: randomUUID() }, code: 'VALIDATION' },
      { before: f.before, after: { ...f.after, name: 'dbowner_other' }, code: 'VALIDATION' },
      { before: f.before, after: { ...f.after, name: 'foreign_other' }, code: 'VALIDATION' },
      { before: f.before, after: { ...f.after, engine: 'postgres' } as unknown as Database, code: 'VALIDATION' },
    ]
    for (const entry of invalid) {
      await expect(prepareDatabaseIndexTransition(f.db, f.account, entry.before, entry.after)).rejects.toMatchObject({ code: entry.code })
      expect(await snapshot(f.db)).toEqual(original)
    }
  })

  it('rejects no-op/live-to-live and timestamp-to-timestamp transitions', async () => {
    const f = await transitionFixture(), original = await snapshot(f.db)
    for (const [before, after] of [[f.before, f.before], [f.after, f.after], [f.after, { ...f.after, trashedAt: '2026-10-27T00:00:00.000Z' }]] as const) {
      await expect(prepareDatabaseIndexTransition(f.db, f.account, before, after)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    }
    expect(await snapshot(f.db)).toEqual(original)
  })

  it('requires canonical valid ISO timestamps on either side', async () => {
    const f = await transitionFixture(), original = await snapshot(f.db)
    for (const value of [undefined, 42, '', 'yesterday', '2026-10-26', '2026-02-30T00:00:00.000Z', `${trashTimestamp}\n`]) {
      await expect(prepareDatabaseIndexTransition(f.db, f.account, f.before, { ...f.after, trashedAt: value } as Database)).rejects.toMatchObject({ code: 'VALIDATION' })
      await expect(prepareDatabaseIndexTransition(f.db, f.account, { ...f.before, trashedAt: value } as Database, { ...f.after, trashedAt: null })).rejects.toMatchObject({ code: 'VALIDATION' })
    }
    expect(await snapshot(f.db)).toEqual(original)
  })

  it('refuses missing or mismatched existing database rows without changes', async () => {
    const f = await transitionFixture()
    const original = await snapshot(f.db)
    await expect(prepareDatabaseIndexTransition(f.db, f.account, { ...f.before, engine: 'postgres' } as unknown as Database, f.after)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await snapshot(f.db)).toEqual(original)
    for (const [column, value] of [['account_id', f.neighbor.id], ['name', 'dbowner_DIFFERENT'], ['trashed_at', trashTimestamp]] as const) {
      await f.db.query(`UPDATE idx_databases SET ${column}=$1 WHERE id=$2`, [value, f.before.id])
      const current = await snapshot(f.db)
      await expect(prepareDatabaseIndexTransition(f.db, f.account, f.before, f.after)).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(await snapshot(f.db)).toEqual(current)
      await f.db.query(`UPDATE idx_databases SET ${column}=$1 WHERE id=$2`, [{ account_id: f.before.accountId, name: f.before.name, trashed_at: f.before.trashedAt }[column], f.before.id])
    }
    await f.db.query('DELETE FROM idx_databases WHERE id=$1', [f.before.id])
    const current = await snapshot(f.db)
    await expect(prepareDatabaseIndexTransition(f.db, f.account, f.before, f.after)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await snapshot(f.db)).toEqual(current)
  })

  it('refuses case-insensitive database-name collisions', async () => {
    const f = await transitionFixture()
    await seedDatabase(f.db, { ...f.other, id: randomUUID(), name: f.before.name.toUpperCase() })
    const current = await snapshot(f.db)
    await expect(prepareDatabaseIndexTransition(f.db, f.account, f.before, f.after)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await snapshot(f.db)).toEqual(current)
  })

  it('refuses foreign, duplicate and colliding search rows', async () => {
    const f = await transitionFixture()
    for (const candidate of [
      { ...f.before, accountId: f.neighbor.id },
      { ...f.before },
      { ...f.before, id: randomUUID(), name: f.before.name.toUpperCase() },
    ]) {
      await seedSearch(f.db, candidate)
      const current = await snapshot(f.db)
      await expect(prepareDatabaseIndexTransition(f.db, f.account, f.before, f.after)).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(await snapshot(f.db)).toEqual(current)
      await f.db.query("DELETE FROM search_fts WHERE kind='database' AND rowid<>$1 AND (entity_id=$2 OR lower(title)=lower($3))", ['9007199254740999', f.before.id, f.before.name])
    }
    await f.db.query("UPDATE search_fts SET account_id=$1 WHERE entity_id=$2 AND kind='database'", [f.neighbor.id, f.before.id])
    const current = await snapshot(f.db)
    await expect(prepareDatabaseIndexTransition(f.db, f.account, f.before, f.after)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await snapshot(f.db)).toEqual(current)
  })

  it.each(['database', 'search'] as const)('fences intervening preimage changes at apply: %s', async changed => {
    const f = await transitionFixture(), port = await prepareDatabaseIndexTransition(f.db, f.account, f.before, f.after)
    if (changed === 'database') await f.db.query('UPDATE idx_databases SET created_at=$1 WHERE id=$2', ['2030-01-01T00:00:00.000Z', f.before.id])
    else await f.db.query("UPDATE search_fts SET keywords=$1 WHERE kind='database' AND entity_id=$2", ['intervening', f.before.id])
    const current = await snapshot(f.db)
    await expect(port.apply()).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(port.rollback()).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await snapshot(f.db)).toEqual(current)
  })

  it.each(['database', 'search', 'rowid'] as const)('does not overwrite an intervening postimage change: %s', async changed => {
    const f = await transitionFixture(), port = await prepareDatabaseIndexTransition(f.db, f.account, f.before, f.after)
    await port.apply()
    if (changed === 'database') await f.db.query('UPDATE idx_databases SET created_at=$1 WHERE id=$2', ['2030-01-01T00:00:00.000Z', f.before.id])
    if (changed === 'search') await f.db.query("UPDATE search_fts SET keywords=$1 WHERE kind='database' AND entity_id=$2", ['intervening', f.before.id])
    if (changed === 'rowid') await f.db.query('UPDATE idx_databases SET rowid=$1 WHERE id=$2', ['9007199254741001', f.before.id])
    const current = await snapshot(f.db)
    await expect(port.rollback()).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await snapshot(f.db)).toEqual(current)
  })

  it('preserves the preimage on an update SQL failure and recognizes proven rollback', async () => {
    const f = await transitionFixture(), original = await snapshot(f.db)
    const port = await prepareDatabaseIndexTransition(f.db, f.account, f.before, f.after)
    await f.db.exec("CREATE TRIGGER reject_transition BEFORE UPDATE ON idx_databases BEGIN SELECT RAISE(ABORT,'Synthetic transition refusal'); END")
    await expect(port.apply()).rejects.toThrow()
    expect(await snapshot(f.db)).toEqual(original)
    await port.rollback()
    expect(await snapshot(f.db)).toEqual(original)
  })

  it('rolls back trigger side effects instead of accepting more than trashed_at', async () => {
    const f = await transitionFixture(), original = await snapshot(f.db)
    const port = await prepareDatabaseIndexTransition(f.db, f.account, f.before, f.after)
    await f.db.exec("CREATE TRIGGER alter_transition AFTER UPDATE OF trashed_at ON idx_databases BEGIN UPDATE idx_databases SET created_at='2030-01-01T00:00:00.000Z' WHERE id=NEW.id; END")
    await expect(port.apply()).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await snapshot(f.db)).toEqual(original)
    await port.rollback()
    expect(await snapshot(f.db)).toEqual(original)
  })

  it('retains exact postimage compensation across an uncertain apply acknowledgement', async () => {
    const f = await transitionFixture(), original = await snapshot(f.db)
    const port = await prepareDatabaseIndexTransition(afterCommitFailure(f.db, 2), f.account, f.before, f.after)
    await expect(port.apply()).rejects.toThrow('synthetic acknowledgement failure after commit')
    expect(await f.db.query('SELECT trashed_at FROM idx_databases WHERE id=$1', [f.before.id])).toEqual([{ trashed_at: trashTimestamp }])
    await port.rollback()
    expect(await snapshot(f.db)).toEqual(original)
  })

  it('recognizes an exact preimage after uncertain rollback acknowledgement', async () => {
    const f = await transitionFixture(), original = await snapshot(f.db)
    const port = await prepareDatabaseIndexTransition(afterCommitFailure(f.db, 3), f.account, f.before, f.after)
    await port.apply()
    await expect(port.rollback()).rejects.toThrow('synthetic acknowledgement failure after commit')
    expect(await snapshot(f.db)).toEqual(original)
    await port.rollback()
    expect(await snapshot(f.db)).toEqual(original)
  })

  it('preserves the accepted postimage on rollback SQL failure, then compensates after repair', async () => {
    const f = await transitionFixture(), original = await snapshot(f.db)
    const port = await prepareDatabaseIndexTransition(f.db, f.account, f.before, f.after)
    await port.apply()
    await f.db.exec("CREATE TRIGGER reject_restore BEFORE UPDATE OF trashed_at ON idx_databases WHEN NEW.trashed_at IS NULL BEGIN SELECT RAISE(ABORT,'Synthetic restore refusal'); END")
    const current = await snapshot(f.db)
    await expect(port.rollback()).rejects.toThrow()
    expect(await snapshot(f.db)).toEqual(current)
    await f.db.exec('DROP TRIGGER reject_restore')
    await port.rollback()
    expect(await snapshot(f.db)).toEqual(original)
  })
})
