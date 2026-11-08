import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backgroundStateWrite, HOST_OPERATION_IN_FLIGHT } from './background-write.ts'
import { createTestStateStore, type TestStateStoreHandle } from './store.ts'

let state: TestStateStoreHandle
beforeEach(async () => { state = await createTestStateStore() })
afterEach(async () => { await state.close() })
const ip = (address: string) => ({ address, version: 4 as const, prefixLength: 24, interfaceName: 'test0', role: 'shared' as const, ownerKind: 'root' as const, ownerId: null, ptrHostname: null, isPrimary: false, notes: '' })

describe('background desired-state writes', { tags: ['feature'] }, () => {
  it('wait while a host operation is bound to the revision; request writes and later background writes proceed', async () => {
    let busy = true
    state.store.registerHostOperationProbe(async () => busy)
    const revision = await state.store.getRevision()
    await expect(backgroundStateWrite(() => state.store.saveServerIp(ip('192.0.2.10')))).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: HOST_OPERATION_IN_FLIGHT, stateChanged: false } })
    await expect(backgroundStateWrite(async () => (await state.store.getWriterLock().acquire()).release())).rejects.toMatchObject({ detail: { reason: HOST_OPERATION_IN_FLIGHT } })
    expect(await state.store.getRevision()).toBe(revision)
    await state.store.saveServerIp(ip('192.0.2.11'))
    busy = false
    await backgroundStateWrite(() => state.store.saveServerIp(ip('192.0.2.12')))
    expect(await state.store.getRevision()).toBe(revision + 2)
  })
  it('release the writer mutex when the probe fails', async () => {
    state.store.registerHostOperationProbe(async () => { throw new Error('control database unavailable') })
    await expect(backgroundStateWrite(() => state.store.saveServerIp(ip('192.0.2.10')))).rejects.toThrow('control database unavailable')
    await state.store.saveServerIp(ip('192.0.2.11'))
  })
})
