import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { atomicWriteJson } from './atomic.ts'
import { ExtendedFeaturesStore } from './extended-store.ts'
import { StateStore } from './store.ts'

describe('canonical DNS cleanup authority', () => {
  let rootDir: string
  let state: StateStore
  let extended: ExtendedFeaturesStore
  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'xpanel-zone-cleanup-consistency-'))
    state = new StateStore(rootDir)
    extended = new ExtendedFeaturesStore(rootDir)
    await atomicWriteJson(join(rootDir, 'zones', 'orphan.example.net.json'), { name: 'orphan.example.net' })
    await atomicWriteJson(join(rootDir, 'zones', 'keep.example.net.json'), { name: 'keep.example.net' })
    await atomicWriteJson(join(rootDir, 'extended', 'dns', 'zones', 'extended.example.net.json'), { name: 'extended.example.net' })
  })
  afterEach(async () => { await rm(rootDir, { recursive: true, force: true }) })

  it('does not remove a canonical zone while another writer owns the state tree', async () => {
    const lease = await state.writerLock.acquire()
    let settled = false
    const pending = extended.cleanupDnsZones(['keep.example.net']).finally(() => { settled = true })
    try {
      await delay(80)
      expect(settled).toBe(false)
      expect(await readFile(join(rootDir, 'zones', 'orphan.example.net.json'), 'utf8')).toContain('orphan.example.net')
    } finally {
      await lease.release()
      await pending
    }
    expect(await readFile(join(rootDir, 'zones', 'keep.example.net.json'), 'utf8')).toContain('keep.example.net')
    await expect(readFile(join(rootDir, 'zones', 'orphan.example.net.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('records each canonical removal as a source revision and retains the cleanup result', async () => {
    const before = await state.getAuthorityMetadata()
    expect(await extended.cleanupDnsZones(['keep.example.net'])).toEqual({ removedZones: ['extended.example.net', 'orphan.example.net'] })
    const after = await state.getAuthorityMetadata()
    expect(after.revision).toBe(before.revision + 1)
    expect(after.fencingToken).toBeGreaterThan(before.fencingToken)
  })
})
