import { createHash } from 'node:crypto'

export const SOURCE_ALGORITHM = 'xpanel-executable-inputs-v1'
export const REQUIRED_PROFILES = Object.freeze(['ubuntu-22.04', 'ubuntu-24.04', 'almalinux-9', 'rocky-9', 'centos-stream-9'])
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

/** Historical snapshot digest recipe. Scope/domain is identified separately by its caller. */
export function computeSourceDigest(entries) {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return sha256(sorted.map(file => `${file.path}\0${file.sha256}\n`).join(''))
}
