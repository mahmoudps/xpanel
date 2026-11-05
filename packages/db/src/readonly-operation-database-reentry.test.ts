import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('read-only operation database re-entry', () => {
  const source = readFileSync(new URL('./readonly-operation-database.ts', import.meta.url), 'utf8')
  const start = source.indexOf('export async function withVisibleReadonlyOperationDatabase')
  const end = source.indexOf('\nexport function getReadonlyOperationDatabaseOrigin', start)
  if (start < 0 || end <= start) throw new Error('reader re-entry source missing')
  const body = source.slice(start, end).replace('export async function', 'async function')
    .replace('withVisibleReadonlyOperationDatabase<T>(db: unknown, callback: () => T | Promise<T>): Promise<T>', 'withVisibleReadonlyOperationDatabase(db, callback)')

  function load() {
    const current = new AsyncLocalStorage<{ live: boolean }>()
    const scopes = new WeakMap<object, { live: boolean }>()
    const refused = (reason: string) => { throw new Error(reason) }
    const visible = new Function('scopes', 'current', 'refused', body + '\nreturn withVisibleReadonlyOperationDatabase')(
      scopes, current, refused,
    ) as (db: unknown, callback: () => unknown) => Promise<unknown>
    return { visible, current, scopes }
  }

  it('re-enters one live reader after the store is dropped and refuses a retired or foreign reader', async () => {
    const { visible, current, scopes } = load()
    const reader = {}
    const scope = { live: true }
    scopes.set(reader, scope)
    let seen: unknown
    await visible(reader, async () => { seen = current.getStore() })
    expect(seen).toBe(scope)
    const other = { live: true }
    await current.run(other, async () => {
      await expect(visible(reader, () => undefined)).rejects.toThrow('unissued_or_retired_reader')
    })
    scope.live = false
    await expect(visible(reader, () => undefined)).rejects.toThrow('unissued_or_retired_reader')
    await expect(visible({}, () => undefined)).rejects.toThrow('unissued_or_retired_reader')
  })
})
