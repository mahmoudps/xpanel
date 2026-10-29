import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, posix, relative, resolve } from 'node:path'
import { isBuiltin, stripTypeScriptTypes } from 'node:module'
import { gunzipSync, gzipSync } from 'node:zlib'
import { init, parse as parseModules } from 'es-module-lexer'
import { withAuthenticatedReleaseArchive, stageAuthenticatedReleaseArchive } from './release-verifier.mjs'
import { REQUIRED_LIFECYCLE_CONTROL_FILES } from './release-verifier.mjs'

// The parser is a pinned development dependency; no parser or test tool enters the release.
await init()

export const REQUIRED_RELEASE_ENTRYPOINTS = Object.freeze([
  'apps/api/src/main.ts',
  'apps/agent/src/main.ts',
  'apps/api/src/cli.ts',
  'apps/web/src/index.ts',
])

export const REQUIRED_SYSTEMD_UNITS = Object.freeze([
  'deploy/systemd/xpanel-agent.service',
  'deploy/systemd/xpanel-api.service',
])

export const REQUIRED_ROOT_FILES = Object.freeze([
  '.node-version',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'CLA.md',
  'scripts/install.sh',
  'scripts/management-tls.mjs',
  'scripts/release-verifier.mjs',
  'scripts/release-verifier.d.mts',
  'helpers/account-files/build.mjs',
  'helpers/account-files/xpanel-account-files.c',
])

// These files are visual references, never production modules or served assets.
// Keep the renderer boundary explicit: a runtime import must fail closure validation.
export const DESIGN_REFERENCE_INPUTS = Object.freeze({
  directories: Object.freeze(['apps/web/src/design-boards/']),
  files: Object.freeze(['apps/web/src/live-boards.ts']),
})

const isDesignReference = (relPath) =>
  DESIGN_REFERENCE_INPUTS.files.includes(relPath) ||
  DESIGN_REFERENCE_INPUTS.directories.some((prefix) => relPath === prefix.slice(0, -1) || relPath.startsWith(prefix))

export const EXCLUDED_DIR_NAMES = new Set([
  '.git',
  '.github',
  '.secrets',
  '.tools',
  '.pnpm-store',
  '.xpanel-data',
  'node_modules',
  'coverage',
  'dist',
  'tmp',
  'docs',
])

export const FORBIDDEN_RELEASE_PATTERNS = Object.freeze([
  /(?:^|\/)\.[^/]+\//,
  /(?:^|\/)\.secrets(?:\/|$)/i,
  /(?:^|\/)\.git(?:\/|$)/i,
  /(?:^|\/)\.tools(?:\/|$)/i,
  /(?:^|\/)\.pnpm-store(?:\/|$)/i,
  /(?:^|\/)(?:agent\.token|server\.secret)$/i,
  /(?:^|\/)\.env(?:\..+)?$/i,
  /\.(?:pem|key|p12|pfx)$/i,
  /\.(?:exe|dll|dylib)$/i,
  /(?:win32-x64|win32-arm64|darwin-x64|darwin-arm64)/i,
])

export const DEV_ONLY_PACKAGES = new Set([
  'vitest',
  'vite',
  'typescript',
  'lightningcss',
  '@playwright/test',
  'playwright',
  'axe-core',
  'jsdom',
  'es-module-lexer',
])

export class ReleaseArtifactError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [detail]
   */
  constructor(code, message, detail = {}) {
    super(message)
    this.name = 'ReleaseArtifactError'
    this.code = code
    this.detail = detail
  }
}

const failRelease = (code, message, detail = {}) => {
  throw new ReleaseArtifactError(code, message, detail)
}

const toPosix = (p) => p.replaceAll('\\', '/')

/**
 * Normalizes text files (strip UTF-8 BOM, CRLF -> LF) so Windows and Linux checkouts produce
 * identical deterministic SHA-256 digests and tar archives.
 * @param {string} relPath
 * @param {Buffer} raw
 * @returns {Buffer}
 */
export const normalizeArtifactBytes = (relPath, raw) => {
  const isText = /\.(?:ts|js|mjs|cjs|c|h|json|yaml|yml|sql|sh|service|conf|slice|md|css|html|txt)$|^\.node-version$|^VERSION$/.test(relPath)
  if (!isText) return raw
  const text = raw.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  return Buffer.from(text, 'utf8')
}

export const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex')

export const signManifestPayload = (canonicalJson, signingKey) =>
  createHmac('sha256', signingKey).update(canonicalJson, 'utf8').digest('hex')

/**
 * Parses key directives from a systemd unit file for manifest recording and contract verification.
 * @param {string} unitName
 * @param {string} content
 */
export const parseSystemdUnitContract = (unitName, content) => {
  const get = (key) => {
    const m = new RegExp(`^${key}=(.*)$`, 'm').exec(content)
    return m ? m[1].trim() : null
  }
  const execStart = get('ExecStart')
  const user = get('User')
  const group = get('Group')
  const supplementaryGroups = get('SupplementaryGroups')
  const umask = get('UMask')
  const runtimeDirectory = get('RuntimeDirectory')
  const runtimeDirectoryMode = get('RuntimeDirectoryMode')
  const runtimeDirectoryPreserve = get('RuntimeDirectoryPreserve')
  const noNewPrivileges = get('NoNewPrivileges')

  if (!execStart) {
    failRelease('INVALID_SYSTEMD_UNIT', `${unitName} is missing ExecStart`, { unitName })
  }
  if (execStart.includes('dist/index.js')) {
    failRelease('INVALID_SYSTEMD_UNIT', `${unitName} references nonexistent dist/index.js`, { unitName, execStart })
  }
  if (/^ExecStartPre=.*\bchown\b/m.test(content)) {
    failRelease('INVALID_SYSTEMD_UNIT', `${unitName} uses forbidden ExecStartPre chown workaround`, { unitName })
  }

  if (unitName === 'xpanel-agent.service') {
    if (
      user !== 'root' ||
      group !== 'xpanel-agent' ||
      supplementaryGroups !== 'xpanel' ||
      runtimeDirectory !== 'xpanel' ||
      runtimeDirectoryMode !== '0750' ||
      runtimeDirectoryPreserve !== 'no' ||
      umask !== '0007' ||
      !execStart.endsWith('/opt/xpanel/apps/agent/src/main.ts')
    ) {
      failRelease('INVALID_SYSTEMD_UNIT', `xpanel-agent.service violates the verified S03/H01 unit contract`, {
        unitName,
        user,
        group,
        supplementaryGroups,
        runtimeDirectory,
        runtimeDirectoryMode,
        runtimeDirectoryPreserve,
        umask,
        execStart,
      })
    }
  } else if (unitName === 'xpanel-api.service') {
    if (
      user !== 'xpanel' ||
      group !== 'xpanel' ||
      supplementaryGroups !== 'xpanel-agent' ||
      umask !== '0007' ||
      noNewPrivileges !== 'yes' ||
      !execStart.endsWith('/opt/xpanel/apps/api/src/main.ts')
    ) {
      failRelease('INVALID_SYSTEMD_UNIT', `xpanel-api.service violates the verified S03/H01 unit contract`, {
        unitName,
        user,
        group,
        supplementaryGroups,
        umask,
        noNewPrivileges,
        execStart,
      })
    }
  }

  return {
    name: unitName,
    execStart,
    user,
    group,
    supplementaryGroups,
    umask,
    runtimeDirectory,
    runtimeDirectoryMode,
    runtimeDirectoryPreserve,
    noNewPrivileges,
  }
}

const isIncludedRuntimeSource = (relPath) => {
  if (isDesignReference(relPath)) return false
  if (REQUIRED_ROOT_FILES.includes(relPath)) return true
  if (REQUIRED_LIFECYCLE_CONTROL_FILES.includes(relPath)) return true
  if (REQUIRED_SYSTEMD_UNITS.includes(relPath)) return true
  if (/^(?:apps|packages)\/[^/]+\/package\.json$/.test(relPath)) return true
  if (/^packages\/db\/src\/migrations\/\d{4}_[a-z0-9_]+\.sql$/.test(relPath)) return true
  if (/^(?:apps|packages)\/[^/]+\/src\/.+\.(?:ts|js|mjs|css|html|json|po)$/.test(relPath)) {
    if (/\.test\.ts$|\.spec\.ts$|\.linux\.test\.ts$/.test(relPath)) return false
    if (/\/fixtures\.ts$|[-.]fixture\.ts$/.test(relPath)) return false
    return true
  }
  return false
}

export const RELEASE_PRIVACY_CONFIG = 'scripts/release-privacy.json'

const PRIVACY_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.pnpm-store',
  '.tools',
  '.secrets',
  '.xpanel-data',
  '.artifacts',
  'dist',
  'coverage',
  'tmp',
])

const PRIVACY_TEXT_EXTENSIONS = new Set(['.md', '.po', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.css', '.html', '.yml', '.yaml', '.sh', '.c', '.sql', '.txt'])

/**
 * Names the release privacy scan may see in this checkout. The build runner reads this
 * file, so it does not keep a machine-local exception list.
 * @param {string} sourceRoot
 * @returns {Set<string>}
 */
export const loadReleasePrivacyAccept = (sourceRoot) => {
  const configPath = join(sourceRoot, RELEASE_PRIVACY_CONFIG)
  if (!existsSync(configPath)) return new Set()
  let parsed
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    failRelease('PRIVACY_CONFIG', `Release privacy config is not valid JSON: ${RELEASE_PRIVACY_CONFIG}`, {
      path: RELEASE_PRIVACY_CONFIG,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  const accept = parsed?.accept
  if (!Array.isArray(accept) || accept.some(item => typeof item !== 'string' || item.length === 0)) {
    failRelease('PRIVACY_CONFIG', `Release privacy config accept must be an array of names: ${RELEASE_PRIVACY_CONFIG}`, {
      path: RELEASE_PRIVACY_CONFIG,
    })
  }
  return new Set(accept)
}

/**
 * Flags agent skills, the design-document test, the data-token attribute, and the fidelity script.
 * A finding is clean when its name is listed in scripts/release-privacy.json.
 * @param {string} sourceRoot
 * @returns {{ violations: { marker: string, path: string }[] }}
 */
export const scanReleasePrivacy = (sourceRoot) => {
  const root = resolve(sourceRoot)
  const accept = loadReleasePrivacyAccept(root)
  /** @type {{ marker: string, path: string }[]} */
  const violations = []
  const seen = new Set()

  const record = (marker, relPath) => {
    if (accept.has(marker)) return
    const key = `${marker}\0${relPath}`
    if (seen.has(key)) return
    seen.add(key)
    violations.push({ marker, path: relPath })
  }

  const walk = (absDir) => {
    const entries = readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (PRIVACY_SKIP_DIRS.has(entry.name)) continue
        walk(join(absDir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      const absPath = join(absDir, entry.name)
      const relPath = toPosix(relative(root, absPath))
      if (relPath === RELEASE_PRIVACY_CONFIG) continue
      const base = basename(relPath)
      if (base === 'SKILL.md') record('SKILL.md', relPath)
      if (base === 'board-fidelity.mjs') record('board-fidelity.mjs', relPath)
      const extension = posix.extname(base)
      if (!PRIVACY_TEXT_EXTENSIONS.has(extension)) continue
      let text = ''
      try {
        const info = statSync(absPath)
        if (info.size > 1_048_576) continue
        text = readFileSync(absPath, 'utf8')
      } catch {
        continue
      }
      if (base === 'design-board.test.ts' || (base.endsWith('.test.ts') && text.includes('docs/design/'))) {
        record(base, relPath)
      }
      if (text.includes('data-token')) record('data-token', relPath)
      if (base !== 'board-fidelity.mjs' && text.includes('board-fidelity')) record('board-fidelity.mjs', relPath)
    }
  }

  walk(root)
  return { violations }
}

const assertReleasePrivacy = (sourceRoot) => {
  const { violations } = scanReleasePrivacy(sourceRoot)
  if (violations.length === 0) return
  failRelease('PRIVACY_SCAN', `Release privacy scan found names that scripts/release-privacy.json does not accept: ${violations.map(item => item.marker).join(', ')}`, {
    violations,
  })
}

const collectSourceFiles = (sourceRoot) => {
  /** @type {string[]} */
  const found = []

  const walk = (absDir) => {
    const entries = readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (EXCLUDED_DIR_NAMES.has(entry.name) || entry.isDirectory() && entry.name.startsWith('.')) continue
      const absPath = join(absDir, entry.name)
      const relPath = toPosix(relative(sourceRoot, absPath))
      if (isDesignReference(relPath)) continue
      const lstat = lstatSync(absPath)
      if (lstat.isSymbolicLink()) {
        failRelease('UNPORTABLE_SYMLINK', `Refusing symbolic link in release source tree: ${relPath}`, { path: relPath })
      }
      if (lstat.isDirectory()) {
        walk(absPath)
      } else if (lstat.isFile()) {
        if (isIncludedRuntimeSource(relPath)) {
          found.push(relPath)
        }
      }
    }
  }

  walk(sourceRoot)
  return found.sort()
}

/** Validate production ESM imports and workspace exports before signing or writing staging. */
const verifySourceClosure = (files) => {
  const packages = new Map()
  for (const [path, file] of files) {
    if (/^(?:apps|packages)\/[^/]+\/package\.json$/.test(path)) {
      const pkg = JSON.parse(file.bytes.toString('utf8'))
      packages.set(pkg.name, { ...pkg, path: posix.dirname(path) })
    }
  }
  let checkedImports = 0
  let checkedSources = 0
  const requireFile = (importer, dependency, target) => {
    if (!files.has(target)) {
      failRelease('RELEASE_DEPENDENCY_MISSING', `Release source ${importer} depends on an input outside the runtime package: ${dependency}`, {
        path: importer, dependency, target, designReference: isDesignReference(target),
      })
    }
  }
  const checkExportTargets = (pkg, value) => {
    if (typeof value === 'string') {
      requireFile(`${pkg.path}/package.json`, value, posix.normalize(posix.join(pkg.path, value)))
    } else if (value && typeof value === 'object') {
      for (const target of Object.values(value)) checkExportTargets(pkg, target)
    }
  }
  for (const pkg of packages.values()) checkExportTargets(pkg, pkg.exports)

  for (const [path, file] of files) {
    if (!/\.(?:ts|js|mjs|cjs)$/.test(path)) continue
    checkedSources++
    const text = file.bytes.toString('utf8')
    const source = path.endsWith('.ts') ? stripTypeScriptTypes(text, { mode: 'strip' }) : text
    const pkg = [...packages.values()].find((candidate) => path.startsWith(`${candidate.path}/`))
    const checkImport = (dependency) => {
      checkedImports++
      if (isBuiltin(dependency)) return
      if (dependency.startsWith('.')) {
        requireFile(path, dependency, posix.normalize(posix.join(posix.dirname(path), dependency)))
        return
      }
      const packageName = dependency.startsWith('@') ? dependency.split('/').slice(0, 2).join('/') : dependency.split('/')[0]
      if (!pkg?.dependencies?.[packageName]) {
        failRelease('UNDECLARED_RELEASE_DEPENDENCY', `Release source ${path} imports an undeclared production dependency: ${dependency}`, { path, dependency })
      }
      const workspace = packages.get(packageName)
      if (workspace) {
        const subpath = dependency === packageName ? '.' : `.${dependency.slice(packageName.length)}`
        const target = typeof workspace.exports === 'string' && subpath === '.' ? workspace.exports : workspace.exports?.[subpath]
        if (!target) failRelease('RELEASE_DEPENDENCY_MISSING', `Workspace export ${dependency} has no release target`, { path, dependency })
        checkExportTargets(workspace, target)
      } else if (String(pkg.dependencies[packageName]).startsWith('workspace:')) {
        failRelease('RELEASE_DEPENDENCY_MISSING', `Workspace package is missing from release: ${packageName}`, { path, dependency })
      }
    }
    for (const imported of parseModules(source)[0]) {
      if (imported.type === 'import-meta') continue
      if (typeof imported.specifier !== 'string' || imported.glob) {
        failRelease('UNRESOLVED_RELEASE_IMPORT', `Release source ${path} has a computed module import that cannot be checked`, { path })
      }
      checkImport(imported.specifier)
    }
  }
  return { checkedSources, checkedImports }
}

const collectProductionSbom = (sourceRoot, version, nodeVersion, packageManager, lockfileSha256) => {
  const workspacePackages = []
  for (const group of ['apps', 'packages']) {
    const groupDir = join(sourceRoot, group)
    if (!existsSync(groupDir)) continue
    for (const entry of readdirSync(groupDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue
      const pkgPath = join(groupDir, entry.name, 'package.json')
      if (!existsSync(pkgPath)) continue
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      const prodDeps = Object.entries(pkg.dependencies ?? {}).map(([name, spec]) => ({ name, specifier: String(spec) }))
      for (const dep of prodDeps) {
        if (DEV_ONLY_PACKAGES.has(dep.name)) {
          failRelease('DEV_DEPENDENCY_IN_RUNTIME', `Workspace package ${pkg.name} lists dev-only package ${dep.name} in dependencies`, {
            workspacePackage: pkg.name,
            dependency: dep.name,
          })
        }
      }
      workspacePackages.push({
        name: pkg.name,
        version: pkg.version ?? version,
        path: `${group}/${entry.name}`,
        private: Boolean(pkg.private),
        dependencies: prodDeps,
      })
    }
  }

  // Verified production external packages from lockfile & runtime policy
  const productionDependencies = [
    { name: 'ws', version: '8.22.0', license: 'MIT', nativeAddon: false },
    { name: 'tar-stream', version: '3.2.2', license: 'MIT', nativeAddon: false },
    { name: 'yaml', version: '2.9.1', license: 'ISC', nativeAddon: false },
    { name: 'b4a', version: '1.9.0', license: 'Apache-2.0', nativeAddon: false },
    { name: 'bare-events', version: '2.9.2', license: 'Apache-2.0', nativeAddon: false },
    { name: 'bare-fs', version: '4.8.4', license: 'Apache-2.0', nativeAddon: false },
    { name: 'bare-path', version: '3.1.2', license: 'Apache-2.0', nativeAddon: false },
    { name: 'bare-stream', version: '2.13.4', license: 'Apache-2.0', nativeAddon: false },
    { name: 'bare-url', version: '2.5.5', license: 'Apache-2.0', nativeAddon: false },
    { name: 'events-universal', version: '1.0.1', license: 'Apache-2.0', nativeAddon: false },
    { name: 'fast-fifo', version: '1.3.2', license: 'MIT', nativeAddon: false },
    { name: 'streamx', version: '2.28.1', license: 'MIT', nativeAddon: false },
    { name: 'teex', version: '1.0.1', license: 'MIT', nativeAddon: false },
    { name: 'text-decoder', version: '1.2.7', license: 'Apache-2.0', nativeAddon: false },
  ]

  return {
    bomFormat: 'xpanel-sbom-v1',
    specVersion: '1.0',
    version,
    runtime: {
      node: nodeVersion,
      packageManager,
      targetOs: 'linux',
      targetArch: 'x64',
    },
    lockfileSha256,
    workspacePackages,
    productionDependencies,
    excludedDevPackages: [...DEV_ONLY_PACKAGES],
    provenance: {
      excludedDirectories: [...EXCLUDED_DIR_NAMES],
      excludedDesignReferences: DESIGN_REFERENCE_INPUTS,
      allowUnportableWorkspaceSymlinks: false,
      allowForeignNativeBinaries: false,
      permissiveRuntimeLicensesOnly: true,
    },
  }
}

const writeOctal = (buf, offset, length, value) => {
  const str = value.toString(8).padStart(length - 1, '0')
  buf.write(str, offset, length - 1, 'ascii')
  buf[offset + length - 1] = 0
}

const encodeTarHeader = (entry) => {
  const header = Buffer.alloc(512, 0)
  const fullPath = String(entry.name)
  let name = fullPath
  let prefix = ''
  if (Buffer.byteLength(fullPath, 'utf8') > 100) {
    const slashIdx = fullPath.lastIndexOf('/', fullPath.length - 1)
    if (slashIdx > 0) {
      prefix = fullPath.slice(0, slashIdx)
      name = fullPath.slice(slashIdx + 1)
    }
  }
  header.write(name, 0, Math.min(100, Buffer.byteLength(name)), 'utf8')
  writeOctal(header, 100, 8, (entry.mode ?? 0o644) & 0o7777)
  writeOctal(header, 108, 8, entry.uid ?? 0)
  writeOctal(header, 116, 8, entry.gid ?? 0)
  const size = entry.type === 'symlink' || entry.type === 'directory' ? 0 : (entry.size ?? 0)
  writeOctal(header, 124, 12, size)
  writeOctal(header, 136, 12, entry.mtimeSec ?? 1792627200)
  // Fill checksum field with spaces (0x20) before computing sum
  header.fill(0x20, 148, 156)
  const typeChar = entry.type === 'directory' ? '5' : entry.type === 'symlink' ? '2' : entry.type === 'link' ? '1' : '0'
  header.write(typeChar, 156, 1, 'ascii')
  if (entry.linkname) {
    header.write(entry.linkname, 157, Math.min(100, Buffer.byteLength(entry.linkname)), 'utf8')
  }
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  header.write(entry.uname ?? 'root', 265, 32, 'utf8')
  header.write(entry.gname ?? 'root', 297, 32, 'utf8')
  if (prefix) {
    header.write(prefix, 345, Math.min(155, Buffer.byteLength(prefix)), 'utf8')
  }
  let sum = 0
  for (let i = 0; i < 512; i++) sum += header[i]
  const chkStr = sum.toString(8).padStart(6, '0')
  header.write(chkStr, 148, 6, 'ascii')
  header[154] = 0
  header[155] = 0x20
  return header
}

export const createTarGzBuffer = (entries) => {
  const blocks = []
  for (const entry of entries) {
    const content = entry.content ? (Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf8')) : Buffer.alloc(0)
    const isBodyless = entry.type === 'symlink' || entry.type === 'directory'
    const header = encodeTarHeader({
      ...entry,
      size: isBodyless ? 0 : content.byteLength,
    })
    blocks.push(header)
    if (!isBodyless && content.byteLength > 0) {
      blocks.push(content)
      const remainder = content.byteLength % 512
      if (remainder !== 0) {
        blocks.push(Buffer.alloc(512 - remainder, 0))
      }
    }
  }
  // End-of-archive marker: two 512-byte zero blocks
  blocks.push(Buffer.alloc(1024, 0))
  return gzipSync(Buffer.concat(blocks), { level: 9 })
}

const readNullTerminated = (buf, offset, length) => {
  const slice = buf.subarray(offset, offset + length)
  const zero = slice.indexOf(0)
  return (zero >= 0 ? slice.subarray(0, zero) : slice).toString('utf8')
}

const readOctalField = (buf, offset, length) => {
  const raw = readNullTerminated(buf, offset, length).trim()
  return raw.length === 0 ? 0 : Number.parseInt(raw, 8)
}

export const parseTarGzBuffer = (gzBuffer, maximumTarBytes = 512 * 1024 * 1024) => {
  if (!Number.isSafeInteger(maximumTarBytes) || maximumTarBytes < 1 || maximumTarBytes > 512 * 1024 * 1024) {
    failRelease('ARCHIVE_LIMIT', 'Tar expansion bounds can only reduce the hard ceiling')
  }
  const tarBuf = gunzipSync(gzBuffer, { maxOutputLength: maximumTarBytes })
  if (tarBuf.byteLength % 512 !== 0) {
    failRelease('CORRUPT_ARCHIVE', 'Decompressed tar stream is not a multiple of 512 bytes')
  }
  const parsed = []
  let offset = 0
  while (offset + 512 <= tarBuf.byteLength) {
    const header = tarBuf.subarray(offset, offset + 512)
    offset += 512
    // Check if all-zero block
    let allZero = true
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) {
        allZero = false
        break
      }
    }
    if (allZero) break

    const namePart = readNullTerminated(header, 0, 100)
    const prefixPart = readNullTerminated(header, 345, 155)
    const fullName = prefixPart ? `${prefixPart}/${namePart}` : namePart
    const mode = readOctalField(header, 100, 8)
    const uid = readOctalField(header, 108, 8)
    const gid = readOctalField(header, 116, 8)
    const size = readOctalField(header, 124, 12)
    const typeFlag = String.fromCharCode(header[156] || 0x30)
    const linkname = readNullTerminated(header, 157, 100)
    const type =
      typeFlag === '5'
        ? 'directory'
        : typeFlag === '2'
          ? 'symlink'
          : typeFlag === '1'
            ? 'link'
            : typeFlag === '0' || typeFlag === '\0'
              ? 'file'
              : `special-${typeFlag}`

    if (offset + size > tarBuf.byteLength) {
      failRelease('CORRUPT_ARCHIVE', `Truncated tar entry for ${fullName}`)
    }
    const content = Buffer.from(tarBuf.subarray(offset, offset + size))
    const paddedSize = Math.ceil(size / 512) * 512
    offset += paddedSize

    parsed.push({
      name: fullName,
      mode,
      uid,
      gid,
      size,
      type,
      linkname,
      content,
    })
  }
  return parsed
}

const writeDeterministicTarGz = async (filesMap, archivePath) => {
  const sortedPaths = [...filesMap.keys()].sort()
  const entries = sortedPaths.map((relPath) => {
    const item = filesMap.get(relPath)
    return {
      name: relPath,
      mode: item.mode,
      uid: 0,
      gid: 0,
      uname: 'root',
      gname: 'root',
      type: 'file',
      content: item.bytes,
    }
  })
  const archiveBytes = createTarGzBuffer(entries)
  writeFileSync(archivePath, archiveBytes)
  return {
    sha256: sha256Hex(archiveBytes),
    bytes: archiveBytes.byteLength,
  }
}

/**
 * Builds a self-contained, verifiable release bundle staging directory + deterministic `.tar.gz`
 * archive + `release-manifest.json` + `sbom-provenance.json`.
 *
 * @param {{
 *   sourceRoot?: string
 *   outputDir: string
 *   version?: string
 *   signingKey?: string
 *   keyId?: string
 *   createTarball?: boolean
 * }} options
 */
export const buildReleaseArtifact = async (options) => {
  const sourceRoot = resolve(options.sourceRoot ?? resolve(import.meta.dirname, '..'))
  const outputDir = resolve(options.outputDir)
  const createTarball = options.createTarball ?? true

  const rootPkgPath = join(sourceRoot, 'package.json')
  if (!existsSync(rootPkgPath)) {
    failRelease('MISSING_SOURCE_MANIFEST', `package.json not found at ${rootPkgPath}`)
  }
  const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'))
  const version = options.version ?? rootPkg.version ?? '0.1.0'
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    failRelease('INVALID_VERSION', `Release version must be valid SemVer: ${version}`, { version })
  }

  const nodeVersionPath = join(sourceRoot, '.node-version')
  if (!existsSync(nodeVersionPath)) {
    failRelease('MISSING_NODE_VERSION', `.node-version not found at ${nodeVersionPath}`)
  }
  const nodeVersion = readFileSync(nodeVersionPath, 'utf8').trim()
  if (!/^\d+\.\d+\.\d+$/.test(nodeVersion)) {
    failRelease('INVALID_NODE_VERSION', `.node-version must contain an exact version: ${nodeVersion}`)
  }

  for (const req of [...REQUIRED_ROOT_FILES, ...REQUIRED_RELEASE_ENTRYPOINTS, ...REQUIRED_SYSTEMD_UNITS]) {
    if (!existsSync(join(sourceRoot, req))) {
      failRelease('MISSING_ENTRYPOINT', `Required release file is missing from source tree: ${req}`, { path: req })
    }
  }

  assertReleasePrivacy(sourceRoot)

  const relFiles = collectSourceFiles(sourceRoot)
  /** @type {Map<string, { bytes: Buffer, sha256: string, mode: number }>} */
  const stagedFiles = new Map()

  for (const relPath of relFiles) {
    for (const pattern of FORBIDDEN_RELEASE_PATTERNS) {
      if (pattern.test(relPath)) {
        failRelease('FORBIDDEN_ARTIFACT_FILE', `Forbidden file matched release exclusion policy: ${relPath}`, { path: relPath })
      }
    }
    const raw = readFileSync(join(sourceRoot, relPath))
    const normalized = normalizeArtifactBytes(relPath, raw)
    // Check web assets and source files for accidental embedded credentials
    if (relPath.startsWith('apps/web/')) {
      const text = normalized.toString('utf8')
      if (/XPANEL_SERVER_SECRET=|XPANEL_AGENT_TOKEN=|BEGIN PRIVATE KEY/.test(text)) {
        failRelease('SECRET_LEAK_DETECTED', `Web source file contains forbidden credential pattern: ${relPath}`, { path: relPath })
      }
    }
    const mode = relPath.endsWith('.sh') || relPath === 'bin/xpanel-ctl' ? 0o755 : 0o644
    stagedFiles.set(relPath, {
      bytes: normalized,
      sha256: sha256Hex(normalized),
      mode,
    })
  }

  const sourceClosure = verifySourceClosure(stagedFiles)

  const versionBytes = Buffer.from(`${version}\n`, 'utf8')
  stagedFiles.set('VERSION', {
    bytes: versionBytes,
    sha256: sha256Hex(versionBytes),
    mode: 0o644,
  })

  // Validate systemd units and extract metadata
  const systemdUnits = REQUIRED_SYSTEMD_UNITS.map((unitRelPath) => {
    const file = stagedFiles.get(unitRelPath)
    if (!file) failRelease('MISSING_ENTRYPOINT', `Missing systemd unit: ${unitRelPath}`)
    const unitName = posix.basename(unitRelPath)
    const contract = parseSystemdUnitContract(unitName, file.bytes.toString('utf8'))
    return {
      ...contract,
      path: unitRelPath,
      sha256: file.sha256,
    }
  })

  // Extract migrations
  const migrations = [...stagedFiles.keys()]
    .filter((p) => /^packages\/db\/src\/migrations\/\d{4}_[a-z0-9_]+\.sql$/.test(p))
    .sort()
    .map((p) => {
      const name = posix.basename(p)
      const ver = Number(name.slice(0, 4))
      return {
        version: ver,
        name,
        path: p,
        sha256: stagedFiles.get(p).sha256,
      }
    })

  if (migrations.length === 0) {
    failRelease('MISSING_MIGRATIONS', 'Release artifact must include SQLite schema migrations')
  }

  const webAssets = [...stagedFiles.keys()]
    .filter((p) => p.startsWith('apps/web/src/'))
    .sort()
    .map((p) => {
      const f = stagedFiles.get(p)
      return { path: p, sha256: f.sha256, bytes: f.bytes.byteLength }
    })

  const lockfileSha256 = stagedFiles.get('pnpm-lock.yaml').sha256
  const packageManager = String(rootPkg.packageManager ?? 'pnpm@12.15.0')
  const typescriptVersion = String(rootPkg.devDependencies?.typescript ?? '7.0.2')

  const sbom = collectProductionSbom(sourceRoot, version, nodeVersion, packageManager, lockfileSha256)
  const sbomBytes = Buffer.from(`${JSON.stringify(sbom, null, 2)}\n`, 'utf8')
  const sbomSha256 = sha256Hex(sbomBytes)
  stagedFiles.set('sbom-provenance.json', {
    bytes: sbomBytes,
    sha256: sbomSha256,
    mode: 0o644,
  })

  const manifestFiles = [...stagedFiles.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, info]) => ({
      path,
      sha256: info.sha256,
      bytes: info.bytes.byteLength,
      mode: info.mode,
      owner: 'root',
      group: 'root',
    }))

  const totalUnpackedBytes = manifestFiles.reduce((acc, f) => acc + f.bytes, 0)
  const schemaVersion = migrations.reduce((max, m) => Math.max(max, m.version), 0)

  const manifestCore = {
    schemaVersion: 1,
    version,
    controlDbSchemaVersion: schemaVersion,
    runtime: {
      nodeVersion,
      packageManager,
      typescriptVersion,
      executionMode: 'node-strip-types-source',
    },
    target: {
      os: 'linux',
      arch: 'x64',
    },
    entrypoints: {
      api: 'apps/api/src/main.ts',
      agent: 'apps/agent/src/main.ts',
      cli: 'apps/api/src/cli.ts',
      web: 'apps/web/src/index.ts',
    },
    sourcePolicy: { excludedDesignReferences: DESIGN_REFERENCE_INPUTS, sourceClosure },
    systemdUnits,
    migrations,
    webAssets,
    lockfileSha256,
    sbomSha256,
    totalUnpackedBytes,
    files: manifestFiles,
  }

  const canonicalPayload = JSON.stringify(manifestCore)
  const payloadSha256 = sha256Hex(Buffer.from(canonicalPayload, 'utf8'))
  const signature = options.signingKey
    ? {
        algorithm: 'hmac-sha256',
        keyId: options.keyId ?? 'xpanel-release-anchor',
        payloadSha256,
        mac: signManifestPayload(canonicalPayload, options.signingKey),
      }
    : null

  const manifest = {
    ...manifestCore,
    payloadSha256,
    signature,
  }

  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const manifestSha256 = sha256Hex(manifestBytes)
  stagedFiles.set('release-manifest.json', {
    bytes: manifestBytes,
    sha256: manifestSha256,
    mode: 0o644,
  })

  const stagingDir = join(outputDir, 'staging')
  if (existsSync(stagingDir)) {
    rmSync(stagingDir, { recursive: true, force: true })
  }
  mkdirSync(stagingDir, { recursive: true })

  for (const [relPath, info] of stagedFiles.entries()) {
    const dest = join(stagingDir, relPath)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, info.bytes, { mode: info.mode })
  }

  let archivePath = null
  let archiveSha256 = null
  let archiveBytes = 0

  if (createTarball) {
    archivePath = join(outputDir, `xpanel-release-${version}.tar.gz`)
    const tarResult = await writeDeterministicTarGz(stagedFiles, archivePath)
    archiveSha256 = tarResult.sha256
    archiveBytes = tarResult.bytes
  }

  return {
    version,
    schemaVersion,
    stagingDir,
    archivePath,
    archiveSha256,
    archiveBytes,
    manifest,
    manifestSha256,
    sbom,
    sbomSha256,
  }
}

const assertSafeArchiveEntryPath = (entryName) => {
  if (typeof entryName !== 'string' || entryName.length === 0 || entryName.length > 1024) {
    failRelease('ARCHIVE_PATH_TRAVERSAL', `Invalid archive entry path: ${String(entryName)}`, { path: entryName })
  }
  if (entryName.startsWith('/') || entryName.includes('\\') || entryName.includes('\0')) {
    failRelease('ARCHIVE_PATH_TRAVERSAL', `Archive entry path must be relative POSIX: ${entryName}`, { path: entryName })
  }
  const normalized = entryName.replace(/^\.\//, '').replace(/\/$/, '')
  const segments = normalized.split('/')
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    failRelease('ARCHIVE_PATH_TRAVERSAL', `Path traversal segment in archive entry: ${entryName}`, { path: entryName })
  }
  return normalized
}

/**
 * Inspects a `.tar.gz` release archive in memory before unpacking a single byte to disk.
 * Rejects path traversal, symlinks/hardlinks/special files, non-root uid/gid, group/world-writable modes,
 * set-ID bits, forbidden secret/native files, and checksum mismatches.
 *
 * @param {string} archivePath
 * @param {{
 *   expectedArchiveSha256?: string
 *   signingKey?: string
 *   requireSignature?: boolean
 * }} [options]
 */
export const verifyReleaseArchive = async (archivePath, options = {}) => {
  if (!existsSync(archivePath)) {
    failRelease('ARCHIVE_MISSING', `Release archive does not exist: ${archivePath}`, { archivePath })
  }
  const rawArchive = readFileSync(archivePath)
  const actualArchiveSha256 = sha256Hex(rawArchive)
  if (options.expectedArchiveSha256 && actualArchiveSha256 !== options.expectedArchiveSha256) {
    failRelease('ARCHIVE_CHECKSUM_MISMATCH', 'Release archive SHA256 does not match expected digest', {
      expected: options.expectedArchiveSha256,
      actual: actualArchiveSha256,
    })
  }

  /** @type {Map<string, { sha256: string, bytes: number, mode: number, content: Buffer }>} */
  const entries = new Map()
  const rawEntries = parseTarGzBuffer(rawArchive)

  for (const header of rawEntries) {
    const normPath = assertSafeArchiveEntryPath(header.name)
    if (isDesignReference(normPath)) {
      failRelease('FORBIDDEN_ARTIFACT_FILE', `Archive contains a non-runtime design reference: ${normPath}`, { path: normPath })
    }
    if (header.type !== 'file' && header.type !== 'directory') {
      failRelease('UNSAFE_ARCHIVE_ENTRY', `Archive contains forbidden entry type '${header.type}' at ${normPath}`, {
        path: normPath,
        type: header.type,
        linkname: header.linkname,
      })
    }
    if (header.linkname) {
      failRelease('UNSAFE_ARCHIVE_ENTRY', `Archive entry specifies link target at ${normPath}`, {
        path: normPath,
        linkname: header.linkname,
      })
    }
    const mode = (header.mode ?? 0o644) & 0o7777
    if ((mode & 0o6022) !== 0) {
      failRelease('UNSAFE_FILE_PERMISSIONS', `Archive entry is group/world-writable or has set-ID bits: ${normPath} (mode ${mode.toString(8)})`, {
        path: normPath,
        mode: mode.toString(8),
      })
    }
    if ((header.uid ?? 0) !== 0 || (header.gid ?? 0) !== 0) {
      failRelease('UNSAFE_FILE_OWNER', `Archive entry is not root-owned (uid=${header.uid}, gid=${header.gid}): ${normPath}`, {
        path: normPath,
        uid: header.uid,
        gid: header.gid,
      })
    }
    for (const pattern of FORBIDDEN_RELEASE_PATTERNS) {
      if (pattern.test(normPath)) {
        failRelease('FORBIDDEN_ARTIFACT_FILE', `Archive contains forbidden file: ${normPath}`, { path: normPath })
      }
    }
    if (header.type === 'directory') {
      if (posix.basename(normPath).startsWith('.')) {
        failRelease('FORBIDDEN_ARTIFACT_FILE', `Archive contains a hidden directory: ${normPath}`, { path: normPath })
      }
      continue
    }
    if (entries.has(normPath)) {
      failRelease('DUPLICATE_ARCHIVE_ENTRY', `Duplicate entry in release archive: ${normPath}`, { path: normPath })
    }
    const content = header.content
    entries.set(normPath, {
      sha256: sha256Hex(content),
      bytes: content.byteLength,
      mode,
      content,
    })
  }

  const manifestEntry = entries.get('release-manifest.json')
  if (!manifestEntry) {
    failRelease('MANIFEST_MISSING', 'Release archive is missing release-manifest.json')
  }
  const manifest = JSON.parse(manifestEntry.content.toString('utf8'))
  verifyManifestObject(manifest, options)

  const manifestMap = new Map(manifest.files.map((f) => [f.path, f]))
  for (const [fPath, fMeta] of manifestMap.entries()) {
    const actual = entries.get(fPath)
    if (!actual) {
      failRelease('MISSING_FILE', `File declared in manifest is missing from archive: ${fPath}`, { path: fPath })
    }
    if (actual.sha256 !== fMeta.sha256 || actual.bytes !== fMeta.bytes) {
      failRelease('CHECKSUM_MISMATCH', `Archive file ${fPath} does not match manifest digest`, {
        path: fPath,
        expectedSha256: fMeta.sha256,
        actualSha256: actual.sha256,
      })
    }
  }

  for (const entryPath of entries.keys()) {
    if (entryPath === 'release-manifest.json') continue
    if (!manifestMap.has(entryPath)) {
      failRelease('UNEXPECTED_FILE', `Archive contains unmanifested file: ${entryPath}`, { path: entryPath })
    }
  }

  return {
    ok: true,
    archiveSha256: actualArchiveSha256,
    manifest,
    entries,
  }
}

const verifyManifestObject = (manifest, options = {}) => {
  if (!manifest || typeof manifest !== 'object' || manifest.schemaVersion !== 1) {
    failRelease('MANIFEST_INVALID', 'Unsupported or malformed release-manifest.json')
  }
  const { payloadSha256, signature, ...manifestCore } = manifest
  const canonicalPayload = JSON.stringify(manifestCore)
  const computedPayloadSha256 = sha256Hex(Buffer.from(canonicalPayload, 'utf8'))
  if (payloadSha256 !== computedPayloadSha256) {
    failRelease('MANIFEST_TAMPERED', 'Release manifest payloadSha256 does not match manifest contents', {
      expected: payloadSha256,
      actual: computedPayloadSha256,
    })
  }

  if (options.requireSignature && !signature) {
    failRelease('SIGNATURE_MISSING', 'Release verification requires a signed manifest, but signature is absent')
  }
  if (options.signingKey) {
    if (!signature || typeof signature.mac !== 'string') {
      failRelease('SIGNATURE_MISSING', 'Signing key provided for verification, but manifest carries no signature')
    }
    const expectedMac = signManifestPayload(canonicalPayload, options.signingKey)
    const a = Buffer.from(signature.mac, 'utf8')
    const b = Buffer.from(expectedMac, 'utf8')
    if (a.byteLength !== b.byteLength || !timingSafeEqual(a, b)) {
      failRelease('SIGNATURE_INVALID', 'Release manifest cryptographic signature verification failed')
    }
  }

  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    failRelease('MANIFEST_INVALID', 'Release manifest contains no file entries')
  }

  const filePaths = new Set(manifest.files.map((f) => f.path))
  for (const ep of REQUIRED_RELEASE_ENTRYPOINTS) {
    if (!filePaths.has(ep)) {
      failRelease('MISSING_ENTRYPOINT', `Release manifest is missing required entrypoint: ${ep}`, { entrypoint: ep })
    }
  }
  for (const unit of REQUIRED_SYSTEMD_UNITS) {
    if (!filePaths.has(unit)) {
      failRelease('MISSING_ENTRYPOINT', `Release manifest is missing required systemd unit: ${unit}`, { unit })
    }
  }
  for (const rootFile of REQUIRED_ROOT_FILES) {
    if (!filePaths.has(rootFile)) {
      failRelease('MISSING_ENTRYPOINT', `Release manifest is missing required root file: ${rootFile}`, { file: rootFile })
    }
  }
}

/**
 * Verifies a staged/installed release directory and/or archive before any service or user mutation.
 *
 * @param {{
 *   artifactDir?: string
 *   archivePath?: string
 *   expectedArchiveSha256?: string
 *   signingKey?: string
 *   requireSignature?: boolean
 *   pinnedNodeVersion?: string
 *   statProvider?: (absPath: string) => { uid: number, gid: number, mode: number, isSymbolicLink: boolean, isDirectory: boolean, isFile: boolean }
 *   runtimePathsToVerify?: string[]
 * }} options
 */
export const verifyReleaseArtifact = async (options) => {
  if (!options || (!options.artifactDir && !options.archivePath)) {
    failRelease('INVALID_OPTIONS', 'verifyReleaseArtifact requires artifactDir and/or archivePath')
  }

  let archiveReport = null
  if (options.archivePath) {
    archiveReport = await verifyReleaseArchive(options.archivePath, {
      expectedArchiveSha256: options.expectedArchiveSha256,
      signingKey: options.signingKey,
      requireSignature: options.requireSignature,
    })
  }

  if (!options.artifactDir) {
    return {
      ok: true,
      version: archiveReport.manifest.version,
      manifest: archiveReport.manifest,
      verifiedFilesCount: archiveReport.manifest.files.length,
    }
  }

  const artifactDir = resolve(options.artifactDir)
  if (!existsSync(artifactDir)) {
    failRelease('ARTIFACT_DIR_MISSING', `Release directory does not exist: ${artifactDir}`, { artifactDir })
  }

  // Optional custom stat provider for testing root ownership & permissions portably across OSes
  const inspectStat = options.statProvider ?? ((absPath) => {
    const st = lstatSync(absPath)
    return {
      uid: st.uid ?? 0,
      gid: st.gid ?? 0,
      mode: st.mode & 0o7777,
      isSymbolicLink: st.isSymbolicLink(),
      isDirectory: st.isDirectory(),
      isFile: st.isFile(),
    }
  })

  if (options.runtimePathsToVerify) {
    for (const rtPath of options.runtimePathsToVerify) {
      const st = inspectStat(rtPath)
      if (st.isSymbolicLink) {
        failRelease('UNSAFE_RUNTIME_PATH', `Runtime or parent path is a symbolic link: ${rtPath}`, { path: rtPath })
      }
      if (st.uid !== 0) {
        failRelease('UNSAFE_RUNTIME_PATH', `Runtime or parent path is not root-owned (uid=${st.uid}): ${rtPath}`, {
          path: rtPath,
          uid: st.uid,
        })
      }
      if ((st.mode & 0o6022) !== 0) {
        failRelease('UNSAFE_RUNTIME_PATH', `Runtime or parent path is group/world-writable or has set-ID bits (mode=${st.mode.toString(8)}): ${rtPath}`, {
          path: rtPath,
          mode: st.mode.toString(8),
        })
      }
    }
  }

  const manifestPath = join(artifactDir, 'release-manifest.json')
  if (!existsSync(manifestPath)) {
    failRelease('MANIFEST_MISSING', `release-manifest.json is missing from ${artifactDir}`)
  }
  const manifestStat = inspectStat(manifestPath)
  if (manifestStat.isSymbolicLink || !manifestStat.isFile) {
    failRelease('UNSAFE_FILE_PERMISSIONS', 'release-manifest.json must be a regular non-symlink file')
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  verifyManifestObject(manifest, options)

  const manifestMap = new Map(manifest.files.map((f) => [f.path, f]))

  for (const fileMeta of manifest.files) {
    assertSafeArchiveEntryPath(fileMeta.path)
    const absPath = join(artifactDir, fileMeta.path)
    if (!existsSync(absPath)) {
      const isEntrypoint = REQUIRED_RELEASE_ENTRYPOINTS.includes(fileMeta.path) || REQUIRED_SYSTEMD_UNITS.includes(fileMeta.path)
      failRelease(isEntrypoint ? 'MISSING_ENTRYPOINT' : 'MISSING_FILE', `Required file missing from artifact: ${fileMeta.path}`, {
        path: fileMeta.path,
      })
    }
    const st = inspectStat(absPath)
    if (st.isSymbolicLink || !st.isFile) {
      failRelease('UNPORTABLE_SYMLINK', `Artifact file is a symbolic link or not a regular file: ${fileMeta.path}`, {
        path: fileMeta.path,
      })
    }
    if (options.statProvider) {
      if (st.uid !== 0) {
        failRelease('UNSAFE_FILE_OWNER', `Artifact file is not root-owned: ${fileMeta.path}`, { path: fileMeta.path, uid: st.uid })
      }
      if ((st.mode & 0o6022) !== 0) {
        failRelease('UNSAFE_FILE_PERMISSIONS', `Artifact file is group/world-writable or set-ID: ${fileMeta.path}`, {
          path: fileMeta.path,
          mode: st.mode.toString(8),
        })
      }
    }

    const content = readFileSync(absPath)
    const digest = sha256Hex(content)
    if (digest !== fileMeta.sha256 || content.byteLength !== fileMeta.bytes) {
      failRelease('CHECKSUM_MISMATCH', `Artifact file was modified after packaging: ${fileMeta.path}`, {
        path: fileMeta.path,
        expectedSha256: fileMeta.sha256,
        actualSha256: digest,
        expectedBytes: fileMeta.bytes,
        actualBytes: content.byteLength,
      })
    }
  }

  // Scan directory recursively to ensure no unmanifested files, symlinks, secrets, or foreign binaries exist
  const verifyTree = (absDir) => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const absPath = join(absDir, entry.name)
      const relPath = toPosix(relative(artifactDir, absPath))
      if (isDesignReference(relPath)) {
        failRelease('FORBIDDEN_ARTIFACT_FILE', `Artifact directory contains a non-runtime design reference: ${relPath}`, { path: relPath })
      }
      const st = inspectStat(absPath)
      if (st.isSymbolicLink) {
        failRelease('UNPORTABLE_SYMLINK', `Artifact directory contains a symbolic link: ${relPath}`, { path: relPath })
      }
      for (const pattern of FORBIDDEN_RELEASE_PATTERNS) {
        if (pattern.test(relPath)) {
          failRelease('FORBIDDEN_ARTIFACT_FILE', `Artifact directory contains forbidden file or foreign binary: ${relPath}`, {
            path: relPath,
          })
        }
      }
      if (st.isDirectory) {
        if (entry.name.startsWith('.')) {
          failRelease('FORBIDDEN_ARTIFACT_FILE', `Artifact contains a hidden directory: ${relPath}`, { path: relPath })
        }
        verifyTree(absPath)
      } else if (st.isFile) {
        if (relPath !== 'release-manifest.json' && !manifestMap.has(relPath)) {
          failRelease('UNEXPECTED_FILE', `Artifact contains unmanifested file: ${relPath}`, { path: relPath })
        }
      }
    }
  }
  verifyTree(artifactDir)

  // Verify .node-version matches manifest and optional caller pin
  const artifactNodeVersion = readFileSync(join(artifactDir, '.node-version'), 'utf8').trim()
  if (artifactNodeVersion !== manifest.runtime.nodeVersion) {
    failRelease('RUNTIME_VERSION_MISMATCH', `.node-version (${artifactNodeVersion}) does not match manifest (${manifest.runtime.nodeVersion})`)
  }
  if (options.pinnedNodeVersion && artifactNodeVersion !== options.pinnedNodeVersion) {
    failRelease('RUNTIME_VERSION_MISMATCH', `Artifact Node version (${artifactNodeVersion}) does not match host runtime (${options.pinnedNodeVersion})`)
  }

  // Verify systemd units match contract
  for (const unitRelPath of REQUIRED_SYSTEMD_UNITS) {
    const unitContent = readFileSync(join(artifactDir, unitRelPath), 'utf8')
    parseSystemdUnitContract(posix.basename(unitRelPath), unitContent)
  }

  // Verify SBOM
  const sbomContent = JSON.parse(readFileSync(join(artifactDir, 'sbom-provenance.json'), 'utf8'))
  if (sbomContent.lockfileSha256 !== manifest.lockfileSha256) {
    failRelease('SBOM_MISMATCH', 'SBOM lockfileSha256 does not match release manifest lockfileSha256')
  }

  return {
    ok: true,
    version: manifest.version,
    manifest,
    verifiedFilesCount: manifest.files.length,
  }
}

/**
 * Safely unpacks a verified `.tar.gz` release into a staging path and activates it only after
 * full verification succeeds. If unpacking fails mid-flight (e.g. disk full `ENOSPC` or interrupted write),
 * cleans up the incomplete staging directory and preserves any existing installation at `targetDir`.
 *
 * @param {{
 *   archivePath: string
 *   stagingRoot: string
 *   targetDir: string
 *   expectedArchiveSha256?: string
 *   signingKey?: string
 *   requireSignature?: boolean
 *   writeFileHook?: (relPath: string, bytes: Buffer) => void
 * }} options
 */
export const unpackVerifiedRelease = async (options) => {
  // Portable build diagnostics. Privileged lifecycle consumers use the
  // authenticated retained-descriptor staging API below and its runtime module.
  // Step 1: Full pre-unpack verification in memory before touching target or staging directories
  const precheck = await verifyReleaseArchive(options.archivePath, {
    expectedArchiveSha256: options.expectedArchiveSha256,
    signingKey: options.signingKey,
    requireSignature: options.requireSignature,
  })

  const stagingDir = join(resolve(options.stagingRoot), `unpack-${precheck.manifest.version}-${Date.now()}`)
  mkdirSync(stagingDir, { recursive: true })

  try {
    for (const [relPath, entry] of precheck.entries.entries()) {
      if (options.writeFileHook) {
        options.writeFileHook(relPath, entry.content)
      }
      const dest = join(stagingDir, relPath)
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, entry.content, { mode: entry.mode })
      chmodSync(dest, entry.mode)
    }

    // Step 2: Verify unpacked directory on disk before switching/activating
    await verifyReleaseArtifact({
      artifactDir: stagingDir,
      signingKey: options.signingKey,
      requireSignature: options.requireSignature,
    })

    return {
      ok: true,
      version: precheck.manifest.version,
      stagedAt: stagingDir,
      targetDir: resolve(options.targetDir),
      manifest: precheck.manifest,
    }
  } catch (err) {
    // Clean up partial staging directory; leave targetDir untouched
    if (existsSync(stagingDir)) {
      rmSync(stagingDir, { recursive: true, force: true })
    }
    throw err
  }
}

/**
 * Stage an authenticated source archive from its retained actual read-only FD.
 * There are no caller validators or writer hooks, no activation and no target
 * replacement. A failed/uncertain attempt retains its private staging for review.
 * Actual Linux root ancestry is mandatory; runtime dependencies remain unqualified.
 */
export const unpackAuthenticatedRelease = async (options) => {
  const allowed = ['archivePath', 'expectedArchiveSha256', 'signingKey', 'keyId', 'stagingRoot', 'bounds']
  if (!options || typeof options !== 'object' || Object.keys(options).some(key => !allowed.includes(key)) || typeof options.stagingRoot !== 'string') {
    failRelease('AUTHENTICATED_OPTIONS', 'Authenticated staging accepts only explicit trust and staging inputs')
  }
  const trust = { signingKey: options.signingKey, keyId: options.keyId, ...(options.bounds ? { bounds: options.bounds } : {}) }
  const { value } = await withAuthenticatedReleaseArchive(options.archivePath, { ...trust, expectedArchiveSha256: options.expectedArchiveSha256 },
    ({ report }) => stageAuthenticatedReleaseArchive(options.stagingRoot, { ...trust, authenticatedArchive: report }))
  return value
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}`) {
  const outArg = process.argv.find((a) => a.startsWith('--out='))
  const verArg = process.argv.find((a) => a.startsWith('--version='))
  const outputDir = outArg ? outArg.slice('--out='.length) : resolve(import.meta.dirname, '..', '.xpanel-data', 'release-build')
  buildReleaseArtifact({
    outputDir,
    ...(verArg ? { version: verArg.slice('--version='.length) } : {}),
  })
    .then((res) => {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          version: res.version,
          stagingDir: res.stagingDir,
          archivePath: res.archivePath,
          archiveSha256: res.archiveSha256,
          manifestSha256: res.manifestSha256,
          sbomSha256: res.sbomSha256,
          filesCount: res.manifest.files.length,
        })}\n`,
      )
    })
    .catch((err) => {
      process.stderr.write(`Release build failed: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    })
}
