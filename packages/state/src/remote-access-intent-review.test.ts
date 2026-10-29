import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestStateStore } from './store.ts'
import type { TestStateStoreHandle } from './store.ts'
const handles: TestStateStoreHandle[] = []
afterEach(async () => { for (const handle of handles.splice(0)) await handle.close() })
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
async function setup(op = 'databaseRemoteAccess') {
  const handle = await createTestStateStore(); handles.push(handle)
  const relPath = 'accounts/review9/account.json', source = join(handle.rootDir, relPath), original = Buffer.from('{"source":"original"}\n')
  await mkdir(join(handle.rootDir, 'accounts', 'review9'), { recursive: true }); await writeFile(source, original)
  const lock = handle.store.getWriterLock(), lease = await lock.acquire()
  await lease.recordIntent({ op, createdRelPaths: [], backups: [{ relPath, existed: true, contentBase64: original.toString('base64') }] })
  return { handle, relPath, source, original, lock, lease }
}
describe('remote-access external intent preservation', () => {
  it('retains complete evidence and blocks obsolete auto-rollback after the current source fingerprint fails', async () => {
    const ctx = await setup(), external = Buffer.from('{"source":"external replacement"}\n')
    await writeFile(ctx.source, external)
    await expect(ctx.lease.quarantineExternalAccountIntent(ctx.relPath, digest(ctx.original))).rejects.toMatchObject({ code: 'CONFLICT' })
    await ctx.lease.release()
    const markers = (await readdir(ctx.handle.rootDir)).filter(name => name.startsWith('.remote-access-review-'))
    expect(markers).toHaveLength(1)
    const review = JSON.parse(await readFile(join(ctx.handle.rootDir, markers[0]!), 'utf8'))
    expect(review.journal.backups[0].contentBase64).toBe(ctx.original.toString('base64'))
    expect(review.journal.leaseId).toBe(ctx.lease.leaseId)
    await expect(ctx.lock.acquire()).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await readFile(ctx.source)).toEqual(external)
  })
  it('quarantines an exact stable external source and permits later clean reads without replaying the old preimage', async () => {
    const ctx = await setup(), external = Buffer.from('{"source":"stable external"}\n')
    await writeFile(ctx.source, external)
    await ctx.lease.quarantineExternalAccountIntent(ctx.relPath, digest(external)); await ctx.lease.release()
    const next = await ctx.lock.acquire(); await next.release()
    expect(await readFile(ctx.source)).toEqual(external)
    expect((await readdir(ctx.handle.rootDir)).filter(name => name.startsWith('.remote-access-review-'))).toHaveLength(1)
  })
  it('refuses to discard another operation intent and keeps generic clearIntent protection intact', async () => {
    const ctx = await setup('otherMutation')
    await expect(ctx.lease.quarantineExternalAccountIntent(ctx.relPath, digest(ctx.original))).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(ctx.lease.clearIntent()).rejects.toMatchObject({ code: 'CONFLICT' })
    expect((await readdir(ctx.handle.rootDir)).filter(name => name.startsWith('.remote-access-review-'))).toEqual([])
    await ctx.lease.rollbackIntent(); await ctx.lease.release()
  })
})
