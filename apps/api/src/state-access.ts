import { mkdir, open, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fail } from '@xpanel/core'

const STATE_CHILDREN = ['plans', 'accounts', 'feature-lists', 'zones', 'generations', 'resellers', 'certificates'] as const

/**
 * Proves the current process can create a file in the state tree.
 * Existing root-owned 2750 directories pass `mkdir` and then fail every write.
 */
export const assertStateWritable = async (stateDir: string): Promise<void> => {
  await mkdir(stateDir, { recursive: true, mode: 0o750 })
  const targets = [stateDir]
  for (const name of STATE_CHILDREN) {
    const path = join(stateDir, name)
    try {
      const info = await stat(path)
      if (info.isDirectory()) targets.push(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const uid = process.getuid?.() ?? 'unknown'
  for (const dir of targets) {
    const probe = join(dir, `.xpanel-writable-${process.pid}`)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(probe, 'wx', 0o640)
      await handle.close()
      handle = undefined
      await rm(probe, { force: true })
    } catch (error) {
      await handle?.close().catch(() => undefined)
      await rm(probe, { force: true }).catch(() => undefined)
      const code = (error as NodeJS.ErrnoException).code ?? 'unknown'
      return fail(
        'PRECONDITION_FAILED',
        `state directory is not writable by uid ${uid}: ${dir} (${code}). Run \`xpanel repair-state-ownership\` as root so the xpanel service user owns this tree.`,
        { reason: 'state_not_writable', path: dir },
      )
    }
  }
}
