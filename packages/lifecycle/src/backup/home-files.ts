import { createHash } from 'node:crypto'
import { hashing, walkTar } from '../archive/reader.ts'
import type { ByteSource } from '../archive/reader.ts'
import type { ManifestFile } from './manifest.ts'

/**
 * Manifest entries for the content of a home tar.gz, keyed `home/<rel>`. The backup side
 * (computeManifest) and the verify side (inspectBackupArchive) both use this one walk, so
 * they always agree on what is listed. Symlinks are data here: the home is tarred and
 * extracted as the account itself, so any target the account could create is recorded
 * (digest of the target string). A hardlink carries the digest of the file it links to.
 */
export const homeTarFiles = async (source: ByteSource): Promise<Map<string, ManifestFile>> => {
  const files = new Map<string, ManifestFile>()
  await walkTar(source, async (e, body) => {
    const path = `home/${e.path}`
    if (e.type === 'file') {
      files.set(path, { path, part: 'home', type: 'file', ...(await hashing(body).finish()) })
    } else if (e.type === 'symlink') {
      files.set(path, { path, part: 'home', type: 'symlink', size: 0, sha256: createHash('sha256').update(e.linkTarget ?? '').digest('hex') })
    } else if (e.type === 'hardlink') {
      const target = files.get(`home/${e.linkTarget ?? ''}`)
      if (target?.type === 'file') files.set(path, { ...target, path })
    }
  }, { symlinks: 'any' })
  return files
}
