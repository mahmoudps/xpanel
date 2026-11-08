import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applicationDigest } from '../../../packages/os/src/application-artifact.ts'
import { APPLICATION_WORKER_SCRIPT, runApplicationWorker } from './application-worker.ts'

// WordPress sized: 3300 files, 80 MiB, the case in docs/decisions/2026-11-07-site-applications.md.
describe('application worker at a real application size', () => {
  it('writes, verifies and commits within the stage deadlines', { timeout: 120_000, tags: ['slow'] }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'w8-sites-size-'))
    try {
      const size = Math.floor(80 * 1024 * 1024 / 3300), content = Buffer.alloc(size, 'x'), sha256 = applicationDigest(content)
      const files = Array.from({ length: 3300 }, (_, index) => ({ path: `dir${index % 40}/sub${index % 7}/file${index}.php`, sha256, bytes: size, mode: '0644' }))
      const manifest = JSON.stringify({ schemaVersion: 1, domain: 'a.example', path: '', appId: 'sample', version: '1.0.0', previousVersion: null, artifactSha256: sha256, database: null, config: null, updatedAt: '2026-11-07T12:00:00.000Z' }) + '\n' + JSON.stringify({ files, previous: null }) + '\n'
      const python = ['python3', '-I', '-c', APPLICATION_WORKER_SCRIPT]
      const place = { root: 'public_html', key: 'a'.repeat(32) }, transactionId = 'e0e0e0e0-0000-4000-8000-000000000000'
      const timed = async (request: Record<string, unknown>, payload: Uint8Array[] = []) => { const start = Date.now(); const result = await runApplicationWorker(python, home, request, payload, 110); return { ms: Date.now() - start, result } }
      const snapshot = await timed({ op: 'snapshot', ...place, transactionId, beforeRevision: 'b'.repeat(64), next: applicationDigest(manifest), database: null, paths: files.map(file => file.path), fresh: files.map(file => file.path) })
      const apply = await timed({ op: 'apply', ...place, transactionId, write: files, remove: [], manifest }, files.map(() => content))
      const read = await timed({ op: 'observe', ...place, active: transactionId })
      const commit = await timed({ op: 'commit', ...place, transactionId })
      expect(read.result).toMatchObject({ managedClean: true, recoveryRequired: false })
      expect([snapshot.ms, read.ms].every(ms => ms < 50_000) && apply.ms < 110_000 && commit.ms < 20_000).toBe(true)
    } finally { await rm(home, { recursive: true, force: true }) }
  })
})
