import { afterEach, describe, expect, it } from 'vitest'
import { createTestDb, type TestDbHandle } from '../client.ts'
import { createUpgrade, finishUpgrade, getUpgrade } from './upgrades.ts'

const handles: TestDbHandle[] = []
const database = async () => { const handle = await createTestDb(); handles.push(handle); return handle.db }
afterEach(async () => { await Promise.all(handles.splice(0).map(handle => handle.close())) })

describe('upgrade row identity allocated before native effects', () => {
  it('persists the supplied validated record ID without changing existing default allocation', async () => {
    const db = await database(), id = '12345678-1234-1234-1234-123456789abc'
    const planned = await createUpgrade(db, { id, fromVersion: '0.1.0', toVersion: '0.1.1', actor: 'root', fromSchemaVersion: 1 })
    expect(planned.id).toBe(id)
    expect((await getUpgrade(db, id))?.status).toBe('pending')
    await finishUpgrade(db, id, { status: 'rolled_back', error: 'Initial installation verified unchanged', toSchemaVersion: 1 })
    const generated = await createUpgrade(db, { fromVersion: '0.1.0', toVersion: '0.1.2', actor: 'root', fromSchemaVersion: 1 })
    expect(generated.id).toMatch(/^[a-f0-9-]{36}$/)
    expect(generated.id).not.toBe(id)
  })
  it('rejects malformed planned IDs and cannot overwrite a completed upgrade row', async () => {
    const db = await database(), input = { fromVersion: '0.1.0', toVersion: '0.1.1', actor: 'root', fromSchemaVersion: 1 }
    await expect(createUpgrade(db, { ...input, id: '../other' })).rejects.toThrow()
    const id = '12345678-1234-1234-1234-123456789abc'
    await createUpgrade(db, { ...input, id })
    await finishUpgrade(db, id, { status: 'succeeded', toSchemaVersion: 1 })
    await expect(createUpgrade(db, { ...input, id })).rejects.toThrow()
    expect((await getUpgrade(db, id))?.status).toBe('succeeded')
  })
})
