import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fail } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { handleTransferArchiveRoute } from './lifecycle-transfer-archives.ts'
import type { TransferArchiveDeps } from './lifecycle-transfer-archives.ts'

// Portable fixture: a temporary archive root and an executor that only creates directories. No tar, no host paths.
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const alice = { id: '11111111-1111-4111-8111-111111111111', username: 'alice', uid: 20001, gid: 20001, home: '/home/alice', status: 'active', planId: 'p' } as unknown as Account
const fixture = async (overrides: Partial<TransferArchiveDeps> = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'xpanel-transfer-')); roots.push(root)
  const deps: TransferArchiveDeps = {
    authorize: async () => undefined, root, now: () => new Date('2026-10-28T12:00:00.000Z'),
    executor: { runAction: async (action: { kind: string; path?: string }) => { if (action.kind === 'ensure-dir') await mkdir(action.path!, { recursive: true }) } } as never,
    store: { getAccountByUsername: async name => name === 'alice' ? alice : null },
    ...overrides,
  }
  const call = (path: string, method: string, init: RequestInit = {}) => { const url = new URL('http://agent.local' + path); return handleTransferArchiveRoute(new Request(url, { method, ...init, ...(init.body ? { duplex: 'half' } as RequestInit : {}) }), url, method, deps) }
  return { root, deps, call }
}
const archive = Buffer.from([0x1f, 0x8b, 1, 2, 3, 4, 5])
const upload = (bytes: Buffer, headers: Record<string, string> = {}): RequestInit => ({ body: new Uint8Array(bytes), headers: { 'content-type': 'application/gzip', 'x-xpanel-archive-bytes': String(bytes.length), 'x-xpanel-archive-sha256': sha(bytes), ...headers } })

describe('transfer archive routes', () => {
  it('stores a streamed archive for a free destination name only when its size and SHA-256 match', async () => {
    const f = await fixture()
    const stored = await f.call('/transfers/destination/accounts/bob/archives', 'POST', upload(archive))
    expect(stored!.status).toBe(201)
    const receipt = await stored!.json() as { file: string; bytes: number; sha256: string }
    expect(receipt).toMatchObject({ bytes: archive.length, sha256: sha(archive) })
    expect(receipt.file).toMatch(/^xpanel-backup-bob-20261028T120000Z-[0-9a-f]{12}\.tar\.gz$/)
    expect(await readFile(join(f.root, 'bob', receipt.file))).toEqual(archive)
    await expect(f.call('/transfers/destination/accounts/bob/archives', 'POST', upload(archive, { 'x-xpanel-archive-sha256': '0'.repeat(64) }))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    await expect(f.call('/transfers/destination/accounts/bob/archives', 'POST', upload(archive, { 'x-xpanel-archive-bytes': '3' }))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('refuses an existing account name, missing digests, non-root callers and hosts without the executor', async () => {
    const f = await fixture()
    await expect(f.call('/transfers/destination/accounts/alice/archives', 'POST', upload(archive))).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(f.call('/transfers/destination/accounts/bob/archives', 'POST', upload(archive, { 'x-xpanel-archive-sha256': 'nope' }))).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(f.call('/transfers/destination/accounts/bob/archives', 'POST', upload(archive, { 'content-type': 'application/json' }))).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect((await fixture({ authorize: async () => fail('FORBIDDEN', 'root required') })).call('/transfers/destination/accounts/bob/archives', 'POST', upload(archive))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect((await fixture({ executor: null })).call('/transfers/destination/accounts/bob/archives', 'POST', upload(archive))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect((await f.call('/transfers/destination/accounts/bob/archives', 'GET'))!.status).toBe(405)
    expect(await f.call('/transfers/destination/accounts/bob/archives/x', 'GET')).toBeNull()
    await expect(f.call('/transfers/source/accounts/alice/archives?all=1', 'POST')).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('streams an existing source archive by its exact name and refuses other names', async () => {
    const f = await fixture(), name = 'xpanel-backup-alice-20261028T000000Z.tar.gz'
    await mkdir(join(f.root, 'alice'), { recursive: true }); await writeFile(join(f.root, 'alice', name), archive)
    const response = await f.call('/transfers/source/accounts/alice/archives/' + name, 'GET')
    expect(response!.headers.get('content-type')).toBe('application/gzip')
    expect(Buffer.from(await response!.arrayBuffer())).toEqual(archive)
    await expect(f.call('/transfers/source/accounts/alice/archives/xpanel-backup-bob-20261028T000000Z.tar.gz', 'GET')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(f.call('/transfers/source/accounts/ghost/archives', 'POST')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
