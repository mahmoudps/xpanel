import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXPORTFS_REEXPORT_ARGV, isOpsFileSharingCommand, NFS_SERVER_ACTIVE_ARGV, NFS_SERVER_ENABLE_ARGV } from '../../../packages/os/src/ops-file-sharing-command.ts'
import { FakeHostExecutor } from './executor.ts'
import { applyFileSharingConfig, renderManagedExports, shareConfigRevision } from './ops-file-sharing.ts'
import { createNativeFileSharingProvider, readAppliedNfsClients } from './ops-file-sharing-native.ts'

const share = { id: 'shr_' + 'a'.repeat(16), path: '/srv/shares/team', clients: [{ host: '10.0.0.0/24', permission: 'rw' as const, squashRoot: true, subtreeCheck: false }] }

describe('native file sharing provider', () => {
  let dir: string, paths: { managed: string; etab: string; exportfs: string }, commands: string[], running: boolean, reexportOk: boolean, startOk: boolean
  const run = async (argv: string[]) => {
    expect(isOpsFileSharingCommand(argv)).toBe(true)
    commands.push(argv.join(' '))
    if (argv.join(' ') === NFS_SERVER_ACTIVE_ARGV.join(' ')) return { ok: running }
    if (argv.join(' ') === NFS_SERVER_ENABLE_ARGV.join(' ')) { running = startOk; return { ok: startOk } }
    const managed = await readFile(paths.managed, 'utf8').catch(() => '')
    if (reexportOk) await writeFile(paths.etab, managed.split('\n').filter(line => line.startsWith('"')).map(line => line.split(' ')[0]!.replaceAll('"', '') + '\t10.0.0.0/24(rw)').join('\n'))
    return { ok: reexportOk }
  }
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nfs-')); commands = []; running = true; reexportOk = true; startOk = true
    paths = { managed: join(dir, 'exports.d', 'xpanel.exports'), etab: join(dir, 'etab'), exportfs: join(dir, 'exportfs') }
    await writeFile(paths.exportfs, ''); await writeFile(paths.etab, '')
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('gives the firewall the clients of the applied file only', async () => {
    expect(await readAppliedNfsClients(paths.managed)).toEqual([])
    await createNativeFileSharingProvider(run, paths).writeManaged(renderManagedExports({ shares: [share] }), async () => {})
    expect(await readAppliedNfsClients(paths.managed)).toEqual(['10.0.0.0/24'])
  })

  it('uses only commands the executor admits', async () => {
    for (const argv of [EXPORTFS_REEXPORT_ARGV, NFS_SERVER_ACTIVE_ARGV, NFS_SERVER_ENABLE_ARGV]) await expect(new FakeHostExecutor().runCommand([...argv])).resolves.toBeDefined()
  })

  it('reports no server when exportfs is absent and an empty table while the server is stopped', async () => {
    const provider = createNativeFileSharingProvider(run, paths)
    await writeFile(paths.etab, '/srv/shares/stale\t*(rw)\n')
    running = false
    expect(await provider.readEtab()).toBe('')
    running = true
    expect(await provider.readEtab()).toContain('/srv/shares/stale')
    await rm(paths.exportfs)
    expect(await provider.readEtab()).toBeNull()
  })

  it('writes the managed file, starts a stopped server and verifies the export', async () => {
    running = false
    const provider = createNativeFileSharingProvider(run, paths), config = { shares: [share] }
    const result = await applyFileSharingConfig(config, shareConfigRevision({ shares: [] }), provider, async () => {})
    expect(result.active.shares[0]!.exportState).toBe('exported')
    expect(await readFile(paths.managed, 'utf8')).toBe(renderManagedExports(config))
    expect(commands).toContain(NFS_SERVER_ENABLE_ARGV.join(' '))
    expect(await readdir(join(dir, 'exports.d'))).toEqual(['xpanel.exports'])
  })

  it('never starts the server for an empty configuration', async () => {
    running = false
    const provider = createNativeFileSharingProvider(run, paths)
    expect(await provider.reexport()).toBe(true)
    expect(commands).toEqual([EXPORTFS_REEXPORT_ARGV.join(' ')])
  })

  it('refuses the export when the server cannot start, and removes the new file', async () => {
    running = false; startOk = false
    const provider = createNativeFileSharingProvider(run, paths)
    await expect(applyFileSharingConfig({ shares: [share] }, shareConfigRevision({ shares: [] }), provider, async () => {})).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    await expect(readFile(paths.managed, 'utf8')).rejects.toThrow()
  })

  it('leaves no temporary file behind when authority is lost before the rename', async () => {
    await mkdir(join(dir, 'exports.d'))
    const provider = createNativeFileSharingProvider(run, paths)
    await expect(provider.writeManaged('x', async () => { throw new Error('denied') })).rejects.toThrow('denied')
    expect(await readdir(join(dir, 'exports.d'))).toEqual([])
  })
})
