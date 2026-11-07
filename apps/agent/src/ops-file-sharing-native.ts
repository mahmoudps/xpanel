import { randomUUID } from 'node:crypto'
import { access, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { EXPORTFS_BINARY, EXPORTFS_REEXPORT_ARGV, MANAGED_EXPORTS_PATH, NFS_ETAB_PATH, NFS_SERVER_ACTIVE_ARGV, NFS_SERVER_ENABLE_ARGV } from '../../../packages/os/src/ops-file-sharing-command.ts'
import { parseManagedExports } from './ops-file-sharing.ts'
import type { FileSharingNativeProvider } from './ops-file-sharing.ts'

export interface FileSharingNativePaths { managed: string; etab: string; exportfs: string }
const NATIVE_PATHS: FileSharingNativePaths = { managed: MANAGED_EXPORTS_PATH, etab: NFS_ETAB_PATH, exportfs: EXPORTFS_BINARY }

const readOptional = (path: string): Promise<string | null> => readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })

/** Client hosts of the applied exports, for the firewall. Host names are left out: nftables takes addresses only. */
export const readAppliedNfsClients = async (path = MANAGED_EXPORTS_PATH): Promise<string[]> => {
  const text = await readOptional(path).catch(() => null)
  return [...new Set(parseManagedExports(text).shares.flatMap(share => share.clients.map(client => client.host)))]
}

/** The kernel NFS server behind the managed exports file. Commands go through the reviewed executor. */
export function createNativeFileSharingProvider(run: (argv: string[]) => Promise<{ ok: boolean }>, paths: FileSharingNativePaths = NATIVE_PATHS): FileSharingNativeProvider {
  const active = async (): Promise<boolean> => (await run([...NFS_SERVER_ACTIVE_ARGV])).ok
  return {
    readManaged: () => readOptional(paths.managed),
    readEtab: async () => {
      if (!await access(paths.exportfs).then(() => true, () => false)) return null
      // A stopped server serves nothing, whatever the table file still lists.
      return await active() ? await readOptional(paths.etab) ?? '' : ''
    },
    writeManaged: async (content, beforeCommit) => {
      await mkdir(dirname(paths.managed), { recursive: true, mode: 0o755 })
      // exports(5) reads only *.exports, so the temporary name is never picked up.
      const temporary = `${paths.managed}.${randomUUID()}.tmp`, handle = await open(temporary, 'wx', 0o644)
      try {
        try { await handle.writeFile(content, 'utf8'); await handle.sync() } finally { await handle.close() }
        await beforeCommit()
        await rename(temporary, paths.managed)
      } catch (error) { await rm(temporary, { force: true }); throw error }
    },
    removeManaged: () => rm(paths.managed, { force: true }),
    reexport: async () => {
      // Shares exist, so the server has to run. An empty configuration never starts it.
      if (await readOptional(paths.managed) !== null && !await active() && !(await run([...NFS_SERVER_ENABLE_ARGV])).ok) return false
      return (await run([...EXPORTFS_REEXPORT_ARGV])).ok
    },
  }
}
