import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { Account } from '@xpanel/core'
import { createTestDb, type TestDbHandle } from '../client.ts'
import { prepareAccountContactIndexRollback } from './account-contact-checkpoint.ts'
import { syncAccountContactIndex } from './reindex.ts'

const handles: TestDbHandle[] = []
afterEach(async () => { await Promise.all(handles.splice(0).map(handle => handle.close())) })

const accountFixture = (username: string, uid: number): Account & { suspendedAt: string; updatedAt: string } => ({
  id: randomUUID(), username, uid, gid: uid, home: '/home/' + username,
  primaryDomain: username + '.example.test', planId: randomUUID(), ownerId: randomUUID(),
  status: 'suspended', suspendReason: 'Previous suspension', suspendedAt: '2020-02-03T04:05:06.000Z',
  contactEmail: username + '@example.test', ipv4: '192.0.2.' + (uid - 20000), shell: 'jailed',
  createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-02-03T04:05:06.000Z',
} as Account & { suspendedAt: string; updatedAt: string })

const fresh = async () => {
  const database = await createTestDb()
  handles.push(database)
  const target = accountFixture('checkpointowner', 20031)
  const neighbor = accountFixture('checkpointneighbor', 20032)
  await syncAccountContactIndex(database.db, neighbor)
  return { database, target, neighbor }
}

const snapshot = async (database: TestDbHandle) => ({
  accounts: await database.db.query('SELECT * FROM idx_accounts ORDER BY id'),
  search: await database.db.query('SELECT CAST(rowid AS TEXT) AS checkpoint_rowid, * FROM search_fts ORDER BY rowid'),
})

const addSearch = (database: TestDbHandle, rowid: string, account: Account, overrides: { kind?: string; title?: string; ownerId?: string } = {}) =>
  database.db.query(
    'INSERT INTO search_fts (rowid, kind, entity_id, account_id, owner_id, title, subtitle, keywords) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [rowid, overrides.kind ?? 'account', account.id, account.id, overrides.ownerId ?? account.ownerId,
      overrides.title ?? account.username, account.primaryDomain, 'Previous exact search terms'],
  )

describe('account contact index rollback checkpoint', () => {
  it('restores every account column, timestamps and search rowid after contact synchronization, preserving neighbors', async () => {
    const { database, target } = await fresh()
    await syncAccountContactIndex(database.db, target)
    await database.db.query('UPDATE idx_accounts SET updated_at = $1 WHERE id = $2', [target.updatedAt, target.id])
    const before = await snapshot(database)
    const rollback = await prepareAccountContactIndexRollback(database.db, target.id)
    await syncAccountContactIndex(database.db, { ...target, contactEmail: 'changed@example.test' })
    await database.db.query(
      `UPDATE idx_accounts SET username=$1,uid=$2,gid=$2,home=$3,primary_domain=$4,plan_id=$5,owner_id=NULL,
       status='active',suspend_reason=NULL,suspended_at=NULL,ipv4=$6,shell='none',created_at=$7,updated_at=$7 WHERE id=$8`,
      ['changedowner', 20033, '/home/changedowner', 'changedowner.example.test', randomUUID(), '192.0.2.33', '2021-01-01T00:00:00.000Z', target.id],
    )
    await rollback()
    expect(await snapshot(database)).toEqual(before)
  })

  it('restores a missing account and missing search preimage after synchronization inserted both', async () => {
    const { database, target } = await fresh()
    const before = await snapshot(database)
    const rollback = await prepareAccountContactIndexRollback(database.db, target.id)
    await syncAccountContactIndex(database.db, target)
    expect(await database.db.query('SELECT id FROM idx_accounts WHERE id=$1', [target.id])).toHaveLength(1)
    await rollback()
    expect(await snapshot(database)).toEqual(before)
  })

  it('preserves an existing account whose search preimage had no rows', async () => {
    const { database, target } = await fresh()
    await syncAccountContactIndex(database.db, target)
    await database.db.query("DELETE FROM search_fts WHERE kind='account' AND entity_id=$1", [target.id])
    const before = await snapshot(database)
    const rollback = await prepareAccountContactIndexRollback(database.db, target.id)
    await syncAccountContactIndex(database.db, { ...target, contactEmail: 'changed@example.test' })
    await rollback()
    expect(await snapshot(database)).toEqual(before)
  })

  it('restores all duplicate account search rows while preserving other kinds with the same entity id', async () => {
    const { database, target } = await fresh()
    await syncAccountContactIndex(database.db, target)
    await addSearch(database, '200', target, { title: 'Legacy duplicate', ownerId: '' })
    await addSearch(database, '201', target, { kind: 'domain', title: 'Different entity kind' })
    const before = await snapshot(database)
    const rollback = await prepareAccountContactIndexRollback(database.db, target.id)
    await syncAccountContactIndex(database.db, { ...target, contactEmail: 'changed@example.test' })
    await rollback()
    expect(await snapshot(database)).toEqual(before)
  })

  it('restores legacy search rows even when the original account index row was absent', async () => {
    const { database, target } = await fresh()
    await addSearch(database, '200', target)
    await addSearch(database, '201', target, { title: 'Second legacy row' })
    const before = await snapshot(database)
    const rollback = await prepareAccountContactIndexRollback(database.db, target.id)
    await syncAccountContactIndex(database.db, target)
    await rollback()
    expect(await snapshot(database)).toEqual(before)
  })

  it('preserves a search rowid beyond the JavaScript safe integer range exactly', async () => {
    const { database, target } = await fresh()
    await syncAccountContactIndex(database.db, target)
    await database.db.query("DELETE FROM search_fts WHERE kind='account' AND entity_id=$1", [target.id])
    await addSearch(database, '9007199254740993', target)
    const before = await snapshot(database)
    const rollback = await prepareAccountContactIndexRollback(database.db, target.id)
    await database.db.query("DELETE FROM search_fts WHERE kind='account' AND entity_id=$1", [target.id])
    await addSearch(database, '50', target, { title: 'Replacement' })
    await rollback()
    expect(await snapshot(database)).toEqual(before)
    await rollback()
    expect(await snapshot(database)).toEqual(before)
  })

  it('refuses a saved rowid collision and rolls back every attempted restoration without replacing the neighbor', async () => {
    const { database, target, neighbor } = await fresh()
    await syncAccountContactIndex(database.db, target)
    await database.db.query("DELETE FROM search_fts WHERE kind='account' AND entity_id=$1", [target.id])
    await addSearch(database, '100', target)
    const rollback = await prepareAccountContactIndexRollback(database.db, target.id)
    await syncAccountContactIndex(database.db, { ...target, contactEmail: 'changed@example.test' })
    await addSearch(database, '100', neighbor, { kind: 'domain', title: 'New neighbor row' })
    const beforeFailedRestore = await snapshot(database)
    await expect(rollback()).rejects.toThrow()
    expect(await snapshot(database)).toEqual(beforeFailedRestore)
  })
})
