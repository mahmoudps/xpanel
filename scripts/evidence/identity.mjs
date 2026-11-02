import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { collectSnapshotFiles, computeSourceDigest, isAllowedSnapshotPath } from '../vm/source-snapshot.mjs'
import { assertRegularPath, readBoundedFile } from './files.mjs'
import { SOURCE_ALGORITHM, sha256 } from './shared.mjs'

export { assertRegularPath, readBoundedFile } from './files.mjs'
export { SOURCE_ALGORITHM, REQUIRED_PROFILES, sha256 } from './shared.mjs'
const ACCEPTANCE_INPUTS = ['docs/planning/ACCEPTANCE-MATRIX.md', 'docs/planning/acceptance-scenario-mapping.json']
const EXTRA_SOURCE_DIRECTORIES = ['bin', 'deploy']
export function isAllowedEvidenceInput(path) {
  if (isAllowedSnapshotPath(path) || ACCEPTANCE_INPUTS.includes(path)) return true
  const [directory, ...rest] = path.split('/')
  return EXTRA_SOURCE_DIRECTORIES.includes(directory) && rest.length > 0 && isAllowedSnapshotPath(`scripts/${rest.join('/')}`)
}

function collectExtraSourceFiles(root) {
  const paths = []
  const visit = path => {
    for (const item of readdirSync(resolve(root, path), { withFileTypes: true })) {
      const child = `${path}/${item.name}`
      if (!isAllowedEvidenceInput(child)) continue
      if (item.isSymbolicLink()) throw new Error('Release inputs may not contain symbolic links')
      if (item.isDirectory()) visit(child)
      else if (item.isFile()) paths.push(child)
    }
  }
  for (const directory of EXTRA_SOURCE_DIRECTORIES) if (existsSync(resolve(root, directory))) visit(directory)
  return paths
}

export function hashArtifact(path) {
  const absolute = assertRegularPath(path)
  const before = lstatSync(absolute)
  if (before.size <= 0) throw new Error('Release artifact is empty')
  const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024)
  const fd = openSync(absolute, 'r')
  let count = 0
  try {
    while (true) {
      const length = readSync(fd, buffer)
      if (length === 0) break
      digest.update(buffer.subarray(0, length)); count += length
    }
  } finally { closeSync(fd) }
  const after = lstatSync(absolute)
  if (count !== before.size || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== after[key])) throw new Error('Release artifact changed while hashing')
  return { sha256: digest.digest('hex'), bytes: count }
}

export function gitValue(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000 })
  if (result.status !== 0) throw new Error('Unable to identify the source checkout')
  return result.stdout.trim()
}

export function identifySource(root, { requireClean = true } = {}) {
  root = realpathSync(root)
  const commit = gitValue(root, ['rev-parse', 'HEAD'])
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Invalid source commit')
  const tree = gitValue(root, ['rev-parse', 'HEAD^{tree}'])
  const dirty = gitValue(root, ['status', '--porcelain', '--untracked-files=all']) !== ''
  if (requireClean && dirty) throw new Error('A clean committed source is required for a release target')
  const paths = [...new Set([...collectSnapshotFiles(root), ...collectExtraSourceFiles(root), ...ACCEPTANCE_INPUTS])].sort()
  const files = paths.map(path => {
    if (!isAllowedEvidenceInput(path)) throw new Error('Unsupported source input')
    const bytes = readBoundedFile(resolve(root, path), { root, maxBytes: 64 * 1024 * 1024, minBytes: 0 })
    return { path, bytes: bytes.length, sha256: sha256(bytes) }
  })
  return {
    algorithm: SOURCE_ALGORITHM, commit, tree, dirty,
    sourceFingerprint: computeSourceDigest(files), files,
    node: readFileSync(resolve(root, '.node-version'), 'utf8').trim(),
    lockfileSha256: files.find(file => file.path === 'pnpm-lock.yaml')?.sha256,
  }
}

export function assertSameSource(before, after) {
  if (before.algorithm !== after.algorithm || before.commit !== after.commit || before.tree !== after.tree || before.sourceFingerprint !== after.sourceFingerprint || before.dirty !== after.dirty) throw new Error('Source changed during evidence processing')
}

export function assertDetachedOutput(root, output, artifact) {
  const absolute = resolve(output)
  let current = resolve(absolute, '..')
  while (true) {
    try { if (lstatSync(current).isSymbolicLink()) throw new Error('Evidence output parents may not be symbolic links') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    const parent = resolve(current, '..')
    if (parent === current) break
    current = parent
  }
  if (artifact !== undefined && absolute === resolve(artifact)) throw new Error('Evidence output must not overwrite its artifact')
  const rel = relative(resolve(root), absolute).split(sep).join('/')
  if (isAllowedEvidenceInput(rel)) throw new Error('Evidence output must be detached from source/build inputs')
  return absolute
}
