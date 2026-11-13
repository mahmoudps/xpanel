import { createReadStream } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, cp, utimes, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { Account } from '@xpanel/core'
import { createTransferTaskController, spawnTransferCommand } from './lifecycle-transfer-tasks.ts'
import type { TransferCommand, TransferTask, TransferTaskDeps } from './lifecycle-transfer-tasks.ts'

// Native layer: real GNU tar and gzip against a real directory tree, as an unprivileged user. runuser, install -o and the
// database are replaced, because they need root and a server; the home path is rewritten to the temporary tree.
const cleanup: string[] = []
afterEach(async () => { for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true }) })

const account = (username: string): Account => ({ id: randomUUID(), username, uid: 20001, gid: 20001, home: '/home/' + username, primaryDomain: username + '.example.test', status: 'active' } as unknown as Account)

const rig = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xp-live-sync-')); cleanup.push(dir)
  const homes = { source: join(dir, 'home-source'), dest: join(dir, 'home-dest') }
  await mkdir(homes.source, { recursive: true }); await mkdir(homes.dest, { recursive: true })
  const real = spawnTransferCommand(60_000)
  let home = homes.source
  const run = async (command: TransferCommand) => {
    const argv = command.argv.map(arg => arg.replaceAll('/home/alice', home))
    if (argv[0] === '/usr/bin/install') { await cp(argv.at(-2)!, argv.at(-1)!); return { code: 0, stdout: '', stderr: '' } }
    if (argv[0] === '/bin/chgrp') return { code: 0, stdout: '', stderr: '' }
    return real({ ...command, argv, asUser: undefined as never })
  }
  const alice = account('alice'), artifactDir = () => join(dir, 'transfers', 'source')
  const deps: TransferTaskDeps = {
    root: join(dir, 'transfers'), restoreStaging: join(dir, 'restores'), stateRoot: join(dir, 'state'),
    store: { getAccountByUsername: async username => username === 'alice' ? alice : null, readSnapshot: async () => ({ databases: [], certificates: [], domains: [] }) },
    run,
    mariadb: { adminDefaultsFile: '/x', mariadbBinary: '/x', mariadbDumpBinary: '/x', verifyAdminConfig: async () => undefined, verifyDatabaseObjects: async () => ({ tables: [] }) },
    installCertificate: async () => ({ certificate: {} }),
    download: async ({ url }) => createReadStream(url.replace('https://source.test/', '')) as never,
  }
  const controller = createTransferTaskController(deps)
  const settled = async (task: TransferTask): Promise<TransferTask> => {
    for (let i = 0; i < 2000; i++) { const current = await controller.get(task.id); if (current.state !== 'queued' && current.state !== 'running') return current; await new Promise(resolve => setTimeout(resolve, 5)) }
    throw new Error('task did not settle')
  }
  const restore = async (task: TransferTask, incremental: boolean): Promise<TransferTask> => {
    home = homes.dest
    const artifacts = task.result!.artifacts as { name: string; bytes: number; sha256: string }[]
    const fetched = await settled(await controller.start({ kind: 'fetch', username: 'alice', url: 'https://source.test/' + join(artifactDir(), task.id).replaceAll('\\', '/'), token: 't', tlsFingerprint: null, artifacts }))
    expect(fetched.state).toBe('succeeded')
    const done = await settled(await controller.start({ kind: 'restore', username: 'alice', fetch: fetched.id, databases: [], certificates: [], ...(incremental ? { incremental: true } : {}) }))
    home = homes.source
    return done
  }
  return { dir, homes, controller, settled, restore }
}
const tree = async (root: string, prefix = ''): Promise<Record<string, string>> => {
  const out: Record<string, string> = {}
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? prefix + '/' + entry.name : entry.name
    if (entry.isDirectory()) { out[relative + '/'] = ''; Object.assign(out, await tree(root, relative)) } else out[relative] = await readFile(join(root, relative), 'utf8')
  }
  return out
}

describe('final sync of a live transfer', () => {
  it('carries what changed since the first copy and removes what the source removed', { tags: ['slow'], timeout: 30_000 }, async () => {
    const t = await rig()
    await mkdir(join(t.homes.source, 'public_html', 'old'), { recursive: true }); await mkdir(join(t.homes.source, 'mail', 'cur'), { recursive: true })
    await writeFile(join(t.homes.source, 'public_html', 'index.php'), 'first')
    await writeFile(join(t.homes.source, 'public_html', 'keep.txt'), 'same')
    await writeFile(join(t.homes.source, 'public_html', 'old', 'gone.txt'), 'gone')
    await writeFile(join(t.homes.source, 'mail', 'cur', 'one'), 'message one')
    const first = await t.settled(await t.controller.start({ kind: 'package', username: 'alice', live: true }))
    expect(first.state).toBe('succeeded')
    expect((first.result!.artifacts as { name: string }[]).map(artifact => artifact.name)).toEqual(['home.tar.gz'])
    expect((await t.restore(first, false)).state).toBe('succeeded')
    expect(await tree(t.homes.dest)).toEqual(await tree(t.homes.source))

    // the site and the mail keep working during the copy
    await new Promise(resolve => setTimeout(resolve, 1100))
    await writeFile(join(t.homes.source, 'public_html', 'index.php'), 'second, and longer')
    await writeFile(join(t.homes.source, 'mail', 'cur', 'two'), 'message two')
    await rm(join(t.homes.source, 'public_html', 'old'), { recursive: true })
    const final = await t.settled(await t.controller.start({ kind: 'package', username: 'alice', live: true, base: first.id }))
    expect(final.state).toBe('succeeded')
    const fullBytes = (first.result!.artifacts as { bytes: number }[])[0]!.bytes
    expect((final.result!.artifacts as { bytes: number }[])[0]!.bytes).toBeGreaterThan(0)
    expect(fullBytes).toBeGreaterThan(0)
    const synced = await t.restore(final, true)
    expect([synced.state, synced.error]).toEqual(['succeeded', null])
    expect(await tree(t.homes.dest)).toEqual(await tree(t.homes.source))
    expect(await readFile(join(t.homes.dest, 'public_html', 'keep.txt'), 'utf8')).toBe('same')
  })
  it('reports whether the customer changed the copy, ignoring what the server writes itself', async () => {
    const t = await rig()
    await mkdir(join(t.homes.source, 'public_html'), { recursive: true }); await mkdir(join(t.homes.source, 'logs'), { recursive: true })
    await writeFile(join(t.homes.source, 'public_html', 'index.php'), 'x')
    await writeFile(join(t.homes.source, 'logs', 'access.log'), 'x')
    await utimes(join(t.homes.source, 'public_html', 'index.php'), new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))
    const since = (await stat(join(t.homes.source, 'logs', 'access.log'))).mtime
    since.setMinutes(since.getMinutes() - 5)
    const before = await t.settled(await t.controller.start({ kind: 'home-changes', username: 'alice', since: since.toISOString() }))
    expect(before.result).toEqual({ files: 0, mail: [] })
    await writeFile(join(t.homes.source, 'public_html', 'upload.jpg'), 'x')
    const after = await t.settled(await t.controller.start({ kind: 'home-changes', username: 'alice', since: since.toISOString() }))
    expect(after.result).toEqual({ files: 1, mail: [] })
  }, 30_000)
})
