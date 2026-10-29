import { afterEach, describe, expect, it } from 'vitest'
import { createDb, type DbHandle } from './client.ts'

const handles: DbHandle[] = []
afterEach(async () => { await Promise.all(handles.splice(0).map(handle => handle.close())) })

const largeRowid = '9007199254740993'
const fresh = async () => {
  const handle = createDb(':memory:')
  handles.push(handle)
  await handle.db.exec('CREATE TABLE synthetic_metadata (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT')
  return handle
}

describe('SQL runner ignored statement metadata', () => {
  it('executes a bound non-returning insert with a 64-bit rowid and returns no metadata', async () => {
    const handle = await fresh()
    await expect(handle.db.query('INSERT INTO synthetic_metadata (id, value) VALUES ($1, $2)', [largeRowid, 'before'])).resolves.toEqual([])
    expect(await handle.db.query('SELECT CAST(id AS TEXT) AS id, value FROM synthetic_metadata')).toEqual([{ id: largeRowid, value: 'before' }])
  })

  it.each(['DELETE', 'UPDATE', 'UPSERT'] as const)('discards unsafe last-insert metadata during a later %s', async operation => {
    const handle = await fresh()
    // Native script execution seeds the connection without passing through query's
    // statement-run metadata path, so each later operation is tested independently.
    await handle.db.exec("INSERT INTO synthetic_metadata (id, value) VALUES (9007199254740993, 'before')")
    const sql = operation === 'DELETE'
      ? 'DELETE FROM synthetic_metadata WHERE id = $1'
      : operation === 'UPDATE'
        ? "UPDATE synthetic_metadata SET value = 'after' WHERE id = $1"
        : "INSERT INTO synthetic_metadata (id, value) VALUES ($1, 'after') ON CONFLICT (id) DO UPDATE SET value = excluded.value"
    await expect(handle.db.query(sql, [largeRowid])).resolves.toEqual([])
    const rows = await handle.db.query('SELECT CAST(id AS TEXT) AS id, value FROM synthetic_metadata')
    expect(rows).toEqual(operation === 'DELETE' ? [] : [{ id: largeRowid, value: 'after' }])
  })

  it('preserves ordinary SELECT number types after ignoring large write metadata', async () => {
    const handle = await fresh()
    await handle.db.exec("INSERT INTO synthetic_metadata (id, value) VALUES (9007199254740993, 'before')")
    await handle.db.query("UPDATE synthetic_metadata SET value = 'after' WHERE id = $1", [largeRowid])
    const rows = await handle.db.query('SELECT 42 AS integer_value, 1.25 AS real_value, COUNT(*) AS count_value FROM synthetic_metadata')
    expect(rows).toEqual([{ integer_value: 42, real_value: 1.25, count_value: 1 }])
    for (const value of Object.values(rows[0]!)) expect(typeof value).toBe('number')
  })
})
