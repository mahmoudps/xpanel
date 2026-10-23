import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { atomicWriteJson } from './atomic.ts'
import { claimStateOwnership, setStateOwnershipDepsForTests } from './ownership.ts'

describe('state file ownership', () => {
  afterEach(() => {
    setStateOwnershipDepsForTests(null)
  })

  it('chowns a root-written state file to xpanel before the name is published', async () => {
    const calls: { path: string; uid: number; gid: number }[] = []
    setStateOwnershipDepsForTests({
      euid: () => 0,
      lookup: name => (name === 'xpanel' ? { uid: 42, gid: 43 } : null),
      chown: async (path, uid, gid) => {
        calls.push({ path, uid, gid })
      },
    })
    const dir = await mkdtemp(join(tmpdir(), 'xpanel-state-owner-'))
    try {
      const file = join(dir, 'accounts', 'alice.json')
      await atomicWriteJson(file, { username: 'alice' })
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ username: 'alice' })
      expect(calls.some(call => call.path === file && call.uid === 42 && call.gid === 43)).toBe(true)
      expect(calls.some(call => call.path.endsWith('.tmp') && call.uid === 42 && call.gid === 43)).toBe(true)
      expect(calls.some(call => call.path === join(dir, 'accounts') && call.uid === 42)).toBe(true)
      const stat = await lstat(file)
      expect(stat.isFile()).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('leaves a file owned by the current user when the process is not root', async () => {
    let chowned = false
    setStateOwnershipDepsForTests({
      euid: () => 1000,
      lookup: () => ({ uid: 42, gid: 43 }),
      chown: async () => {
        chowned = true
      },
    })
    const dir = await mkdtemp(join(tmpdir(), 'xpanel-state-owner-'))
    const file = join(dir, 'server.json')
    try {
      await atomicWriteJson(file, { ok: true })
      await claimStateOwnership(file)
      expect(chowned).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
