import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestStateStore, type TestStateStoreHandle } from './store.ts'

describe('reseller ACL lists and IPv6 ranges in the state snapshot', { tags: ['feature'] }, () => {
  let state: TestStateStoreHandle
  const path = (...parts: string[]) => join(state.rootDir, ...parts)
  const save = async (value: unknown, ...parts: string[]) => {
    await mkdir(join(path(...parts), '..'), { recursive: true })
    await writeFile(path(...parts), JSON.stringify(value))
  }
  const read = async (...parts: string[]) => JSON.parse(await readFile(path(...parts), 'utf8')) as unknown
  const support = { name: 'support', acl: ['list-accounts', 'create-account'] }
  const range = { id: '00000000-0000-4000-8000-0000000000b1', cidr: '2001:db8:0:1::/64', ownerKind: 'root', ownerId: null, notes: '' }

  beforeEach(async () => { state = await createTestStateStore() })
  afterEach(async () => { await state.close() })

  it('leaves the snapshot and its checksum unchanged while neither file exists', async () => {
    const before = await state.store.readSnapshot()
    expect(before).not.toHaveProperty('aclLists')
    expect(before).not.toHaveProperty('ipv6Ranges')
    await mkdir(path('acl-lists'))
    expect((await state.store.readSnapshot()).checksum).toBe(before.checksum)
  })

  it('reads validated lists and ranges into the snapshot and its checksum', async () => {
    const before = await state.store.readSnapshot()
    await save(support, 'acl-lists', 'support.json')
    await save([range], 'ip-ranges.json')
    const snapshot = await state.store.readSnapshot()
    expect(snapshot.aclLists).toEqual([{ name: 'support', acl: ['create-account', 'list-accounts'] }])
    expect(snapshot.ipv6Ranges).toEqual([range])
    expect(snapshot.checksum).not.toBe(before.checksum)
  })

  it('refuses malformed files instead of dropping them', async () => {
    await save({ name: 'support', acl: ['everything'] }, 'acl-lists', 'support.json')
    await expect(state.store.readSnapshot()).rejects.toThrow(/privilege/)
    await save({ name: 'other', acl: [] }, 'acl-lists', 'support.json')
    await expect(state.store.readSnapshot()).rejects.toThrow(/named after its list/)
    await rm(path('acl-lists'), { recursive: true })
    await save([{ ...range, cidr: '2001:db8::1/64' }], 'ip-ranges.json')
    await expect(state.store.readSnapshot()).rejects.toThrow(/IPv6 network/)
  })

  it('restores both files exactly as they were in the generation', async () => {
    await save(support, 'acl-lists', 'support.json')
    await save([range], 'ip-ranges.json')
    const generation = await state.store.saveGenerationSnapshot(1)

    await save({ name: 'later', acl: [] }, 'acl-lists', 'later.json')
    await rm(path('ip-ranges.json'))

    const restored = await state.store.restoreGenerationSnapshot(1)
    expect(restored.checksum).toBe(generation.checksum)
    expect(await read('acl-lists', 'support.json')).toEqual({ name: 'support', acl: ['create-account', 'list-accounts'] })
    await expect(readFile(path('acl-lists', 'later.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await read('ip-ranges.json')).toEqual([range])
  })
})
