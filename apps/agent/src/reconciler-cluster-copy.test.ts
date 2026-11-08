import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { profileFor } from '@xpanel/os'
import { createTestStateStore } from '@xpanel/state'
import type { TestStateStoreHandle } from '@xpanel/state'
import { compileDesiredGeneration } from './reconciler.ts'

const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
const path = '/var/lib/powerdns/zones/copy.test.zone'
const record = (content: string) => ({ id: crypto.randomUUID(), zone: 'copy.test', name: '@', type: 'A' as const, ttl: 300, content, priority: null })
const mark = { peer: 'ns1.alpha.test', digest: 'a'.repeat(64), at: '2026-11-07T12:00:00.000Z' }
let state: TestStateStoreHandle
beforeEach(async () => { state = await createTestStateStore() })
afterEach(async () => { await state.close() })
const compile = async (previous: string | null) => {
  const compiled = compileDesiredGeneration(await state.store.readSnapshot(), { os, quotaFilesystem: '/home', now: new Date('2026-11-07T12:00:00.000Z'), ...(previous === null ? {} : { previousZones: new Map([[path, previous]]) }) })
  return compiled.files.find(file => file.path === path)!.content
}

describe('a DNS cluster copy in a generation', () => {
  it('publishes the serial its source sent, where a local zone would bump', async () => {
    const id = crypto.randomUUID()
    await state.store.saveDnsZone({ id, accountId: null, name: 'copy.test', serial: 2026110709, records: [record('192.0.2.1')], replica: mark })
    const first = await compile(null)
    expect(first).toMatch(/2026110709\s*;\s*serial/)
    await state.store.saveDnsZone({ id, accountId: null, name: 'copy.test', serial: 2026110710, records: [record('192.0.2.2')], replica: mark })
    expect(await compile(first)).toMatch(/2026110710\s*;\s*serial/)
    await state.store.saveDnsZone({ id, accountId: null, name: 'copy.test', serial: 2026110710, records: [record('192.0.2.3')] })
    expect(await compile(first)).toMatch(/2026110711\s*;\s*serial/)
  })
  it('keeps the replica mark through validation', async () => {
    await state.store.saveDnsZone({ id: crypto.randomUUID(), accountId: null, name: 'copy.test', serial: 5, records: [], replica: mark })
    expect((await state.store.getDnsZone('copy.test'))?.replica).toEqual(mark)
    await expect(state.store.saveDnsZone({ id: crypto.randomUUID(), accountId: null, name: 'bad.test', serial: 5, records: [], replica: { ...mark, digest: 'short' } })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})
