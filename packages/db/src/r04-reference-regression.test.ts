import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createDb, createTestDb } from './client.ts'
import { enqueueDurableJob, getDurableJob, requestJobCancellation } from './repos/jobs.ts'

describe('R04 official reference regressions', () => {
  it('does not reuse an issued reference after pruning every job and lease row', async () => {
    const h = await createTestDb()
    try {
      const first = await enqueueDurableJob(h.db, { kind: 'backup.create', actor: 'root' })
      await h.db.query('DELETE FROM jobs WHERE id = $1', [first.id])
      const second = await enqueueDurableJob(h.db, { kind: 'backup.create', actor: 'root' })
      expect(second.referenceCode).not.toBe(first.referenceCode)
      expect(second.referenceCode).toMatch(/^XP-JOB-[0-9]{4}-[0-9]{6,16}$/)
    } finally { await h.close() }
  })

  it('does not invent a placeholder or allocate a number while reading an unnumbered legacy job', async () => {
    const h = await createTestDb()
    try {
      const id = randomUUID()
      const now = new Date().toISOString()
      await h.db.query(`INSERT INTO jobs(id,kind,actor,created_at,updated_at) VALUES($1,'backup.create','root',$2,$2)`, [id, now])
      expect((await getDurableJob(h.db, id))?.referenceCode).toBeNull()
      expect(await h.db.query('SELECT * FROM job_runtime_leases WHERE job_id = $1', [id])).toHaveLength(0)
    } finally { await h.close() }
  })

  it('can cancel an unnumbered queued legacy job without issuing a reference', async () => {
    const h = await createTestDb()
    try {
      const id = randomUUID()
      const now = new Date().toISOString()
      await h.db.query(`INSERT INTO jobs(id,kind,actor,created_at,updated_at) VALUES($1,'backup.create','root',$2,$2)`, [id, now])
      const cancelled = await requestJobCancellation(h.db, { jobId: id, actor: 'root' })
      expect(cancelled.status).toBe('cancelled')
      expect(cancelled.referenceCode).toBeNull()
      expect(await h.db.query('SELECT * FROM job_runtime_leases WHERE job_id = $1', [id])).toHaveLength(0)
    } finally { await h.close() }
  })

  it('sets FULL durability only through an explicitly verified file connection policy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xpanel-r04-policy-'))
    const h = createDb(join(dir, 'db.sqlite'), { durability: 'strict' })
    try {
      expect((await h.db.query<{ synchronous: number }>('PRAGMA synchronous'))[0]?.synchronous).toBe(2)
    } finally {
      await h.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
