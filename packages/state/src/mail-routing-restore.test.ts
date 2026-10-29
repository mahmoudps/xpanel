import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestStateStore, type TestStateStoreHandle } from './store.ts'

describe('generation restore of saved mail routing', () => {
  let state: TestStateStoreHandle
  const file = (...parts: string[]) => join(state.rootDir, 'extended', ...parts)
  const save = async (value: unknown, ...parts: string[]) => {
    await mkdir(join(file(...parts), '..'), { recursive: true })
    await writeFile(file(...parts), JSON.stringify(value))
  }
  const read = async (...parts: string[]) => JSON.parse(await readFile(file(...parts), 'utf8')) as unknown

  beforeEach(async () => { state = await createTestStateStore() })
  afterEach(async () => { await state.close() })

  it('puts forwarders, filters and autoresponders back as they were in the generation', async () => {
    const forwarders = [{ id: 'f1', accountId: 'a1', sourceAddress: 'info@shop.test', destinations: ['owner@else.test'] }]
    const vacation = { mailbox: 'sales@shop.test', enabled: true, subject: 'Away' }
    await save(forwarders, 'mail', 'forwarders.json')
    await save(vacation, 'webmail', 'vacation', `${encodeURIComponent(vacation.mailbox)}.json`)
    await save({ keep: true }, 'webmail', 'signatures.json')
    const generation = await state.store.saveGenerationSnapshot(1)
    expect(generation.mailRouting?.forwarders).toEqual(forwarders)

    await save([{ id: 'f2', accountId: 'a1', sourceAddress: 'new@shop.test', destinations: ['x@else.test'] }], 'mail', 'forwarders.json')
    await save([{ id: 'r1', accountId: 'a1', name: 'later' }], 'mail', 'filters.json')
    await rm(file('webmail', 'vacation'), { recursive: true })

    const restored = await state.store.restoreGenerationSnapshot(1)
    expect(restored.checksum).toBe(generation.checksum)
    expect(await read('mail', 'forwarders.json')).toEqual(forwarders)
    await expect(readFile(file('mail', 'filters.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await read('webmail', 'vacation', 'sales%40shop.test.json')).toEqual(vacation)
    // files beside the routing entries are not part of the restore
    expect(await read('webmail', 'signatures.json')).toEqual({ keep: true })
    expect((await readdir(state.rootDir)).filter((name) => name.startsWith('.restore-'))).toEqual([])
  })

  it('refuses a generation whose saved routing was unreadable and changes nothing', async () => {
    await mkdir(file('mail'), { recursive: true })
    await writeFile(file('mail', 'forwarders.json'), '{ not json')
    await state.store.saveGenerationSnapshot(1)
    await save([], 'mail', 'forwarders.json')
    await expect(state.store.restoreGenerationSnapshot(1)).rejects.toThrow(/unreadable mail routing/)
    expect(await read('mail', 'forwarders.json')).toEqual([])
  })
})
