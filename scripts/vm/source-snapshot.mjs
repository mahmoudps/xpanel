import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeSourceDigest } from '../evidence/shared.mjs'
export { computeSourceDigest } from '../evidence/shared.mjs'

// Explicit source roots prevent credentials, Git internals and local dependency
// caches from being copied to a disposable qualification host.
export const ALLOWED_SOURCE_DIRECTORIES = ['apps', 'packages', 'scripts', 'helpers', '.github']
export const ALLOWED_ROOT_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'vitest.config.ts',
  '.node-version',
  '.gitignore',
  'README.md',
  'CONTRIBUTING.md',
  'LICENSE',
]
export const ALLOWED_DOC_FILES = ['docs/STANDARDS.md', 'docs/ARCHITECTURE.md']
export const EXCLUDED_NAMES = new Set([
  'node_modules',
  '.tools',
  '.git',
  '.secrets',
  'dist',
  'coverage',
  '.vite',
  'test-results',
  'playwright-report',
])

const hash = value => createHash('sha256').update(value).digest('hex')

export function isAllowedSnapshotPath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 240) return false
  if (/[\x00-\x1f\x7f\\]/.test(path)) return false
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return false
  const segments = path.split('/')
  for (const [index, segment] of segments.entries()) {
    if (!segment || segment === '.' || segment === '..') return false
    if (EXCLUDED_NAMES.has(segment)) return false
    if (segment.startsWith('.') && !(index === 0 && segment === '.github') && !(segments.length === 1 && ALLOWED_ROOT_FILES.includes(path))) return false
    if (segment.startsWith('.env') || /\.(pem|key|log)$/i.test(segment)) return false
  }
  if (segments.length === 1) {
    return ALLOWED_ROOT_FILES.includes(path)
  }
  if (ALLOWED_DOC_FILES.includes(path)) return true
  return ALLOWED_SOURCE_DIRECTORIES.includes(segments[0])
}

export function collectSnapshotFiles(rootDir) {
  const files = []
  function collect(directory) {
    const absDir = resolve(rootDir, directory)
    if (!existsSync(absDir)) return
    for (const item of readdirSync(absDir, { withFileTypes: true })) {
      if (EXCLUDED_NAMES.has(item.name) || item.name.startsWith('.') || /\.(pem|key|log)$/i.test(item.name)) continue
      const relPath = `${directory}/${item.name}`
      if (item.isDirectory()) collect(relPath)
      else if (item.isFile()) files.push(relPath)
      // Links are deliberately not followed or archived.
    }
  }
  for (const directory of ALLOWED_SOURCE_DIRECTORIES) collect(directory)
  for (const rootFile of [...ALLOWED_ROOT_FILES, ...ALLOWED_DOC_FILES]) {
    if (existsSync(resolve(rootDir, rootFile))) files.push(rootFile)
  }
  files.sort()
  return files
}

export function createSourceSnapshot(root = fileURLToPath(new URL('../../', import.meta.url))) {
  const output = resolve(root, '.tools/source-snapshots')
  const files = collectSnapshotFiles(root)
  const entries = files.map(path => {
    if (!isAllowedSnapshotPath(path)) throw new Error(`Unsupported source filename: ${path}`)
    const content = readFileSync(resolve(root, path))
    return { path, bytes: content.length, sha256: hash(content) }
  })
  const sourceHash = computeSourceDigest(entries)
  const name = `source-${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`
  mkdirSync(output, { recursive: true })
  const listPath = resolve(output, `${name}.files.txt`)
  const archive = resolve(output, `${name}.tar.gz`)
  writeFileSync(listPath, `${files.join('\0')}\0`)
  const result = spawnSync('tar', ['-czf', archive, '-C', root, '--null', '-T', listPath], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
  })
  if (result.status !== 0) throw new Error(`Source archive failed: ${result.stderr || result.error?.message}`)
  for (const entry of entries) {
    if (hash(readFileSync(resolve(root, entry.path))) !== entry.sha256) {
      throw new Error(`Source changed while packaging: ${entry.path}`)
    }
  }
  const manifest = {
    schema_version: 1,
    created_at: new Date().toISOString(),
    scope: 'Explicit executable source/build/test roots plus selected documentation; excludes secrets, Git internals, dependencies, tools, archives and symlinks.',
    archive,
    archive_sha256: hash(readFileSync(archive)),
    source_sha256: sourceHash,
    file_count: entries.length,
    files: entries,
  }
  const manifestPath = resolve(output, `${name}.manifest.json`)
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return {
    archive,
    manifest: manifestPath,
    archive_sha256: manifest.archive_sha256,
    source_sha256: sourceHash,
    file_count: entries.length,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const summary = createSourceSnapshot()
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
}
