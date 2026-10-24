import { createStrictTestDb } from './strict-test-db.ts'
import { describe, expect, it } from 'vitest'
import { createDb, type Db } from './client.ts'
import {
  HOST_OPERATION_GUARD_DIRECTORY,
  assertHostOperationGuardActive,
  assertHostOperationGuardHeld,
  withHostOperationGuard,
} from './host-operation-guard.ts'

const binding = {
  databaseFile: '/var/lib/xpanel/control.sqlite', databaseDevice: '1', databaseInode: '2',
  issuerId: '8dd100e4-665f-4c07-9a7e-fd88f8ec817c',
}

describe('host operation guard portable refusal boundary', () => {
  it.each([
    ['null', null], ['undefined', undefined], ['boolean', true], ['number', 1],
    ['lease string', '8dd100e4-665f-4c07-9a7e-fd88f8ec817c'], ['empty object', {}],
    ['frozen object', Object.freeze({})], ['null prototype', Object.create(null)],
    ['structural claim', { held: true, phase: 'held', ...binding }],
    ['symbol claim', { [Symbol('hostOperationGuardBrand')]: true }],
    ['copied claim', JSON.parse(JSON.stringify({ held: true, ...binding }))],
    ['proxy claim', new Proxy(Object.freeze({}), {})],
  ])('rejects %s as physical ownership in both assertion APIs', async (_name, forged) => {
    expect(() => assertHostOperationGuardActive(forged, binding))
      .toThrowError(expect.objectContaining({ code: 'PRECONDITION_FAILED' }))
    await expect(assertHostOperationGuardHeld(forged, binding))
      .rejects.toThrowError(expect.objectContaining({ code: 'PRECONDITION_FAILED' }))
  })

  it('does not evaluate caller binding accessors for an unrecognized capability', async () => {
    let reads = 0
    const claimedBinding = {
      get databaseFile(): string { reads++; throw new Error('untrusted getter') },
      get databaseDevice(): string { reads++; throw new Error('untrusted getter') },
      get databaseInode(): string { reads++; throw new Error('untrusted getter') },
      get issuerId(): string { reads++; throw new Error('untrusted getter') },
    }
    expect(() => assertHostOperationGuardActive({}, claimedBinding)).toThrow()
    await expect(assertHostOperationGuardHeld({}, claimedBinding)).rejects.toThrow()
    expect(reads).toBe(0)
  })

  it('rejects a structural transaction provider before invoking its callback or method', async () => {
    let transactions = 0, callbacks = 0
    const structuralDb = {
      transaction: async (fn: (tx: Db) => Promise<unknown>) => {
        transactions++
        return fn({} as Db)
      },
    } as unknown as Db
    await expect(withHostOperationGuard(structuralDb, {}, async () => { callbacks++ }))
      .rejects.toThrow('a registered public database runner is required')
    expect(callbacks).toBe(0)
    expect(transactions).toBe(0)
  })

  it('rejects a fake outer transaction that returns copied origin fields without running the genuine callback', async () => {
    let providerCalls = 0, callbacks = 0
    const fakeOuter = { transaction: async () => { providerCalls++; return { ...binding } } } as unknown as Db
    await expect(withHostOperationGuard(fakeOuter, {}, async () => { callbacks++ }))
      .rejects.toThrow('a registered public database runner is required')
    expect(providerCalls).toBe(0)
    expect(callbacks).toBe(0)
  })

  it('does not touch a fake provider transaction accessor during admission', async () => {
    let getters = 0
    const fakeOuter = { get transaction(): Db['transaction'] { getters++; throw new Error('untrusted transaction accessor') } } as Db
    await expect(withHostOperationGuard(fakeOuter, {}, async () => undefined))
      .rejects.toThrow('a registered public database runner is required')
    expect(getters).toBe(0)
  })

  it('rejects a proxy of a genuine public runner without treating object shape as registration', async () => {
    const handle = createDb(':memory:')
    try {
      await expect(withHostOperationGuard(new Proxy(handle.db, {}), {}, async () => undefined))
        .rejects.toThrow('a registered public database runner is required')
    } finally { await handle.close() }
  })

  it('rejects a closed registered runner before platform or provider work', async () => {
    const handle = createDb(':memory:')
    await handle.close()
    await expect(withHostOperationGuard(handle.db, {}, async () => undefined))
      .rejects.toThrow('database connection is closing or closed')
  })

  it('preserves actual platform/root refusal for a genuine runner without a physical test bypass', async () => {
    const handle = createDb(':memory:')
    let callbacks = 0
    try {
      const actualLinuxRoot = process.platform === 'linux' && process.getuid?.() === 0 && process.geteuid?.() === 0
      await expect(withHostOperationGuard(handle.db, {}, async () => { callbacks++ }))
        .rejects.toThrow(actualLinuxRoot ? 'a verified strict file-backed database transaction is required' : 'host operation ownership requires actual Linux root')
      expect(callbacks).toBe(0)
    } finally { await handle.close() }
  })

  it('keeps the physical namespace fixed outside the API state tree', () => {
    expect(HOST_OPERATION_GUARD_DIRECTORY).toBe('/var/lib/xpanel-agent/host-operations')
  })

  it('enforces no active DB transaction before attempting a physical ownership assertion', async () => {
    const handle = createDb(':memory:')
    try {
      await handle.db.transaction(async () => {
        await expect(assertHostOperationGuardHeld({}, binding))
          .rejects.toThrow('no active outer database transaction is allowed for this operation')
      })
    } finally { await handle.close() }
  })
})
