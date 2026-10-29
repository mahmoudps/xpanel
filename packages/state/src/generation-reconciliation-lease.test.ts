import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { lstat, readdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createTestStateStore } from './store.ts'
import type { TestStateStoreHandle } from './store.ts'
import { generationReconciliationMutexPath, readGenerationReconciliationLeaseAvailable, withGenerationReconciliationLease } from './generation-reconciliation-lease.ts'

const handles: TestStateStoreHandle[] = []
afterEach(async () => { for (const handle of handles.splice(0)) await handle.close() })
describe('shared physical generation reconciliation lease', () => {
  it('performs no initialization on admission reads and preserves the permanent inode across scopes', async () => {
    const handle = await createTestStateStore(); handles.push(handle)
    const before = await readdir(handle.rootDir)
    expect(await readGenerationReconciliationLeaseAvailable(handle.rootDir)).toBe(false)
    expect(await readdir(handle.rootDir)).toEqual(before)
    await withGenerationReconciliationLease(handle.rootDir, async () => undefined)
    const path = generationReconciliationMutexPath(handle.rootDir), first = await lstat(path, { bigint: true })
    expect(await readGenerationReconciliationLeaseAvailable(handle.rootDir)).toBe(true)
    const read = await lstat(path, { bigint: true })
    expect([read.ino, read.dev, read.size, read.mtimeNs]).toEqual([first.ino, first.dev, first.size, first.mtimeNs])
    await withGenerationReconciliationLease(handle.rootDir, async () => undefined)
    const next = await lstat(path, { bigint: true })
    expect([next.ino, next.dev]).toEqual([first.ino, first.dev])
  })
  it('holds a real SQLite OS lock across an independent process and releases it only when scope completes', async () => {
    const handle = await createTestStateStore(); handles.push(handle)
    const moduleUrl = new URL('./generation-reconciliation-lease.ts', import.meta.url).href
    const script = 'import {withGenerationReconciliationLease} from ' + JSON.stringify(moduleUrl) + '; await withGenerationReconciliationLease(process.argv[1],async()=>{process.send({held:true});await new Promise(resolve=>process.once("message",resolve))});process.disconnect();'
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script, handle.rootDir], { cwd: dirname(fileURLToPath(import.meta.url)), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    const closed = once(child, 'close')
    let errorOutput = ''; child.stderr!.on('data', chunk => { errorOutput += String(chunk) })
    let database: DatabaseSync | undefined
    try {
      const message = await Promise.race([once(child, 'message'), closed.then(([code]) => { throw new Error('lease child exited early: ' + String(code) + ': ' + errorOutput) })])
      expect(message[0]).toEqual({ held: true })
      database = new DatabaseSync(generationReconciliationMutexPath(handle.rootDir), { timeout: 0 })
      expect(() => database!.exec('BEGIN IMMEDIATE')).toThrow(/locked|busy/i)
      child.send('release')
      expect((await closed)[0]).toBe(0)
      database.exec('BEGIN IMMEDIATE'); database.exec('ROLLBACK')
    } finally {
      database?.close()
      if (child.exitCode === null) { child.kill(); await closed }
    }
  })
})
