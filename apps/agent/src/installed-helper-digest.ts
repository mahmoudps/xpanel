import { lstat, readFile } from 'node:fs/promises'

export interface HelperDigestFiles {
  lstat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean; uid: number; mode: number; size: number } | null>
  read(path: string): Promise<Buffer>
}
export const hostHelperFiles: HelperDigestFiles = { lstat: path => lstat(path).catch(() => null), read: path => readFile(path) }

/**
 * The SHA-256 the installer recorded beside a native helper (`<helper>.sha256`), or null when that file is
 * missing, not a root-owned regular file, writable by group or others, or not a single hex digest. A helper is
 * trusted only while its bytes still match this digest.
 */
export async function readInstalledHelperDigest(helperPath: string, files: HelperDigestFiles = hostHelperFiles): Promise<string | null> {
  const info = await files.lstat(helperPath + '.sha256')
  if (!info || !info.isFile() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o6022) !== 0 || info.size > 128) return null
  try {
    const digest = (await files.read(helperPath + '.sha256')).toString('utf8').trim()
    return /^[0-9a-f]{64}$/.test(digest) ? digest : null
  } catch { return null }
}
