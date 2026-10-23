import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, dirname, isAbsolute, parse, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'
import {
  ALLOWED_DOC_FILES,
  ALLOWED_ROOT_FILES,
  ALLOWED_SOURCE_DIRECTORIES,
  computeSourceDigest,
  isAllowedSnapshotPath,
} from './source-snapshot.mjs'

export { computeSourceDigest, isAllowedSnapshotPath }

export const SNAPSHOT_RECEIPT_FILENAME = '.xpanel-snapshot-receipt.json'
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
const MAX_TAR_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
const HEX64_RE = /^[a-f0-9]{64}$/

const sha256Hex = value => createHash('sha256').update(value).digest('hex')

function readNullTerminatedAscii(buf, offset, length) {
  let end = offset
  const limit = offset + length
  while (end < limit && buf[end] !== 0) end++
  return buf.subarray(offset, end).toString('utf8')
}

function parseOctalField(buf, offset, length, fieldName) {
  const raw = readNullTerminatedAscii(buf, offset, length).trim()
  if (!raw) return 0
  if (!/^[0-7]+$/.test(raw)) {
    throw new Error(`Invalid tar octal field ${fieldName}: ${JSON.stringify(raw)}`)
  }
  return Number.parseInt(raw, 8)
}

function isZeroBlock(block) {
  for (let i = 0; i < block.length; i++) {
    if (block[i] !== 0) return false
  }
  return true
}

function verifyTarHeaderChecksum(block) {
  const expected = parseOctalField(block, 148, 8, 'chksum')
  let unsignedSum = 0
  let signedSum = 0
  for (let i = 0; i < 512; i++) {
    const byte = i >= 148 && i < 156 ? 0x20 : block[i]
    unsignedSum += byte
    signedSum += byte > 127 ? byte - 256 : byte
  }
  if (unsignedSum !== expected && signedSum !== expected) {
    throw new Error(`Corrupted tar header checksum (expected ${expected}, got ${unsignedSum})`)
  }
}

function parsePaxRecords(buffer) {
  const text = buffer.toString('utf8')
  const records = {}
  let idx = 0
  while (idx < text.length) {
    const spaceIdx = text.indexOf(' ', idx)
    if (spaceIdx === -1) break
    const lenStr = text.slice(idx, spaceIdx)
    const recordLen = Number.parseInt(lenStr, 10)
    if (!Number.isFinite(recordLen) || recordLen <= 0) {
      throw new Error('Malformed PAX extended header length')
    }
    const record = text.slice(spaceIdx + 1, idx + recordLen)
    const eqIdx = record.indexOf('=')
    if (eqIdx === -1) throw new Error('Malformed PAX extended header key=value')
    const key = record.slice(0, eqIdx)
    const val = record.endsWith('\n') ? record.slice(eqIdx + 1, -1) : record.slice(eqIdx + 1)
    records[key] = val
    idx += recordLen
  }
  return records
}

/**
 * Inspects a `.tar.gz` buffer in memory BEFORE any directory creation or extraction.
 * Rejects symlinks, hardlinks, devices, directories, PAX linkpath, duplicate paths,
 * and any path outside the explicit snapshot allowlist.
 */
export function inspectTarGzArchive(archiveBytes) {
  if (!Buffer.isBuffer(archiveBytes) || archiveBytes.length === 0) {
    throw new Error('Archive buffer is empty or invalid')
  }
  if (archiveBytes.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`Archive exceeds maximum size limit (${MAX_ARCHIVE_BYTES} bytes)`)
  }
  const tarBuffer = gunzipSync(archiveBytes, { maxOutputLength: MAX_TAR_UNCOMPRESSED_BYTES })
  if (tarBuffer.length === 0 || tarBuffer.length % 512 !== 0) {
    throw new Error('Uncompressed tar stream length is not a positive multiple of 512 bytes')
  }

  const members = []
  const seenPaths = new Set()
  let offset = 0
  let pendingPax = null

  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512)
    offset += 512

    if (isZeroBlock(header)) {
      break
    }

    verifyTarHeaderChecksum(header)

    const typeflagByte = header[156]
    const typeflag = typeflagByte === 0 ? '0' : String.fromCharCode(typeflagByte)
    const name = readNullTerminatedAscii(header, 0, 100)
    const prefix = readNullTerminatedAscii(header, 345, 155)
    const linkname = readNullTerminatedAscii(header, 157, 100)
    const size = parseOctalField(header, 124, 12, 'size')

    if (size < 0 || offset + size > tarBuffer.length) {
      throw new Error(`Tar entry size out of bounds for ${name}`)
    }
    const content = tarBuffer.subarray(offset, offset + size)
    const paddedSize = Math.ceil(size / 512) * 512
    offset += paddedSize

    if (typeflag === 'x') {
      pendingPax = parsePaxRecords(content)
      if (pendingPax.linkpath) {
        throw new Error(`Rejected PAX linkpath in archive member: ${pendingPax.linkpath}`)
      }
      continue
    }

    if (typeflag !== '0') {
      throw new Error(`Rejected non-regular tar entry (typeflag=${JSON.stringify(typeflag)}, path=${JSON.stringify(name)})`)
    }
    if (linkname.length > 0) {
      throw new Error(`Rejected tar entry with non-empty linkname: ${JSON.stringify(linkname)}`)
    }

    let rawPath = pendingPax?.path ?? (prefix ? `${prefix}/${name}` : name)
    pendingPax = null
    if (rawPath.startsWith('./')) {
      rawPath = rawPath.slice(2)
    }

    if (!isAllowedSnapshotPath(rawPath)) {
      throw new Error(`Rejected disallowed or unsafe archive member path: ${JSON.stringify(rawPath)}`)
    }
    if (seenPaths.has(rawPath)) {
      throw new Error(`Rejected duplicate archive member path: ${rawPath}`)
    }
    seenPaths.add(rawPath)

    const bodyBuffer = Buffer.from(content)
    members.push({
      path: rawPath,
      bytes: bodyBuffer.length,
      sha256: sha256Hex(bodyBuffer),
      content: bodyBuffer,
    })
  }

  if (pendingPax !== null) {
    throw new Error('Dangling PAX extended header at end of archive')
  }
  if (members.length === 0) {
    throw new Error('Archive contains no regular source files')
  }

  return members
}

export function buildTarArchive(entries) {
  const blocks = []
  for (const entry of entries) {
    if (!isAllowedSnapshotPath(entry.path)) {
      throw new Error(`Disallowed path in buildTarArchive: ${entry.path}`)
    }
    const body = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf8')
    const header = Buffer.alloc(512, 0)
    header.write(entry.path, 0, Math.min(100, Buffer.byteLength(entry.path)), 'utf8')
    header.write((0o644).toString(8).padStart(7, '0'), 100, 7, 'ascii')
    header.write((0).toString(8).padStart(7, '0'), 108, 7, 'ascii')
    header.write((0).toString(8).padStart(7, '0'), 116, 7, 'ascii')
    header.write(body.length.toString(8).padStart(11, '0'), 124, 11, 'ascii')
    header.write((1700000000).toString(8).padStart(11, '0'), 136, 11, 'ascii')
    header.fill(0x20, 148, 156)
    header[156] = '0'.charCodeAt(0)
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    let sum = 0
    for (let i = 0; i < 512; i++) sum += header[i]
    header.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii')
    header[154] = 0
    header[155] = 0x20
    blocks.push(header)
    if (body.length > 0) {
      blocks.push(body)
      const rem = body.length % 512
      if (rem !== 0) blocks.push(Buffer.alloc(512 - rem, 0))
    }
  }
  blocks.push(Buffer.alloc(1024, 0))
  return gzipSync(Buffer.concat(blocks))
}

function validateAndParseManifest(manifestPath, expectedArchiveSha256, expectedSourceSha256) {
  const stat = lstatSync(manifestPath)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Manifest path must be a regular non-symlink file: ${manifestPath}`)
  }
  const raw = readFileSync(manifestPath, 'utf8')
  const manifest = JSON.parse(raw)
  if (manifest?.schema_version !== 1) {
    throw new Error(`Unsupported manifest schema_version: ${manifest?.schema_version}`)
  }
  if (!HEX64_RE.test(manifest.archive_sha256 ?? '') || manifest.archive_sha256 !== expectedArchiveSha256) {
    throw new Error(`Manifest archive_sha256 mismatch: expected ${expectedArchiveSha256}, got ${manifest.archive_sha256}`)
  }
  if (!HEX64_RE.test(manifest.source_sha256 ?? '') || manifest.source_sha256 !== expectedSourceSha256) {
    throw new Error(`Manifest source_sha256 mismatch: expected ${expectedSourceSha256}, got ${manifest.source_sha256}`)
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.file_count !== manifest.files.length) {
    throw new Error('Manifest file_count or files array is invalid')
  }

  const seen = new Set()
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || !isAllowedSnapshotPath(entry.path)) {
      throw new Error(`Manifest contains disallowed path: ${JSON.stringify(entry?.path)}`)
    }
    if (seen.has(entry.path)) {
      throw new Error(`Manifest contains duplicate path: ${entry.path}`)
    }
    seen.add(entry.path)
    if (!Number.isInteger(entry.bytes) || entry.bytes < 0) {
      throw new Error(`Manifest entry has invalid byte count for ${entry.path}`)
    }
    if (!HEX64_RE.test(entry.sha256 ?? '')) {
      throw new Error(`Manifest entry has invalid sha256 for ${entry.path}`)
    }
  }

  const recomputedSourceSha = computeSourceDigest(manifest.files)
  if (recomputedSourceSha !== expectedSourceSha256) {
    throw new Error(`Manifest aggregate source_sha256 mismatch: recomputed ${recomputedSourceSha}, expected ${expectedSourceSha256}`)
  }

  return manifest
}

function assertSafeDestinationAncestors(destination) {
  const absDest = resolve(destination)
  if (existsSync(absDest)) {
    throw new Error(`Destination already exists and will not be overwritten: ${absDest}`)
  }
  let current = dirname(absDest)
  const rootPath = parse(absDest).root
  let existingAnchor = null

  const chain = []
  while (true) {
    chain.push(current)
    if (current === rootPath || dirname(current) === current) break
    current = dirname(current)
  }

  for (const dirPath of chain) {
    if (!existsSync(dirPath)) continue
    const st = lstatSync(dirPath)
    if (st.isSymbolicLink()) {
      throw new Error(`Rejected symlink ancestor in destination path: ${dirPath}`)
    }
    if (!st.isDirectory()) {
      throw new Error(`Ancestor path is not a directory: ${dirPath}`)
    }
    if (!existingAnchor) existingAnchor = dirPath
  }

  if (existingAnchor) {
    const canonicalAnchor = realpathSync(existingAnchor)
    if (canonicalAnchor !== resolve(existingAnchor)) {
      throw new Error(`Destination parent path is not canonical (symlinked ancestor detected): ${existingAnchor} -> ${canonicalAnchor}`)
    }
    if (process.platform === 'linux' && process.getuid?.() === 0) {
      const st = lstatSync(existingAnchor)
      if (st.uid !== 0) {
        throw new Error(`Destination parent must be root-owned on privileged Linux host: ${existingAnchor} (uid=${st.uid})`)
      }
      if ((st.mode & 0o022) !== 0) {
        throw new Error(`Destination parent must not be group/world writable: ${existingAnchor} (mode=${(st.mode & 0o777).toString(8)})`)
      }
    }
  }

  return absDest
}

function isPathInside(parent, candidate) {
  const rel = relative(parent, candidate)
  if (rel === '') return true
  return !rel.startsWith('..') && !isAbsolute(rel)
}

function isKnownDependencyDirectory(relPath) {
  if (relPath === 'node_modules' || relPath === '.pnpm-store') return true
  return /^(apps|packages)\/[^/]+\/node_modules$/.test(relPath)
}

function listAllExtractedFilesOutsideDependencies(rootDir, { allowDependencyDirs = false } = {}) {
  const found = []

  function walk(relDir) {
    const absDir = relDir ? resolve(rootDir, relDir) : rootDir
    for (const item of readdirSync(absDir, { withFileTypes: true })) {
      const relPath = relDir ? `${relDir}/${item.name}` : item.name
      if (!relDir && item.name === SNAPSHOT_RECEIPT_FILENAME) continue
      if (allowDependencyDirs && isKnownDependencyDirectory(relPath)) continue
      const fullPath = resolve(rootDir, relPath)
      const st = lstatSync(fullPath)
      if (st.isSymbolicLink()) {
        throw new Error(`Rejected symbolic link inside verified source tree: ${relPath}`)
      }
      if (st.isDirectory()) {
        walk(relPath)
      } else if (st.isFile()) {
        found.push(relPath)
      } else {
        throw new Error(`Rejected special filesystem node inside verified source tree: ${relPath}`)
      }
    }
  }

  walk('')
  return found.sort()
}

function verifyExtractedTreeAgainstEntries(rootDir, expectedEntries, { allowDependencyDirs = false } = {}) {
  const expectedMap = new Map(expectedEntries.map(e => [e.path, e]))
  const diskFiles = listAllExtractedFilesOutsideDependencies(rootDir, { allowDependencyDirs })

  for (const diskPath of diskFiles) {
    if (!expectedMap.has(diskPath)) {
      throw new Error(`Unexpected unlisted file in destination tree: ${diskPath}`)
    }
  }

  const verifiedEntries = []
  for (const entry of expectedEntries) {
    const absFile = resolve(rootDir, entry.path)
    if (!existsSync(absFile)) {
      throw new Error(`Missing expected source file on disk: ${entry.path}`)
    }
    const st = lstatSync(absFile)
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error(`Source file on disk is not a regular non-symlink file: ${entry.path}`)
    }
    if (process.platform === 'linux' && process.getuid?.() === 0) {
      if (st.uid !== 0 || st.gid !== 0) {
        throw new Error(`Source file ownership drifted on root host: ${entry.path} (${st.uid}:${st.gid})`)
      }
      if ((st.mode & 0o777) !== 0o644) {
        throw new Error(`Source file mode drifted on Linux host: ${entry.path} (${(st.mode & 0o777).toString(8)})`)
      }
    }
    const content = readFileSync(absFile)
    const digest = sha256Hex(content)
    if (content.length !== entry.bytes || digest !== entry.sha256) {
      throw new Error(`Source file content drift or sha256 mismatch on disk: ${entry.path}`)
    }
    verifiedEntries.push({ path: entry.path, bytes: content.length, sha256: digest })
  }

  return verifiedEntries
}

function computeReceiptDigest(receiptPayload) {
  const { receipt_sha256: _ignored, ...canonical } = receiptPayload
  return sha256Hex(JSON.stringify(canonical))
}

const HOST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export function buildFrozenInstallEnvironment(targetDir, { pnpmPath: explicitPnpmPath = null } = {}) {
  const nodePin = readFileSync(resolve(targetDir, '.node-version'), 'utf8').trim()
  if (!/^\d+\.\d+\.\d+$/.test(nodePin) || process.version !== `v${nodePin}`) {
    throw new Error(`Frozen install requires the snapshot Node pin ${nodePin}; this process is ${process.version}`)
  }
  const manifest = JSON.parse(readFileSync(resolve(targetDir, 'package.json'), 'utf8'))
  const manager = /^pnpm@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager ?? '')
  if (!manager) throw new Error('Snapshot packageManager pin is not an exact pnpm version')
  const wanted = manager[1]
  const executableName = process.platform === 'win32' ? 'pnpm.exe' : 'pnpm'
  if (explicitPnpmPath !== null && !isAbsolute(explicitPnpmPath)) {
    throw new Error('Explicit pnpmPath must be an absolute coordinator-supplied path')
  }
  const candidates = explicitPnpmPath !== null ? [explicitPnpmPath] : [
    resolve(HOST_ROOT, '.tools', `pnpm-v${wanted}`, 'node_modules', 'pnpm', executableName),
    resolve(HOST_ROOT, '.tools', 'pnpm-runtime', 'node_modules', 'pnpm', executableName),
    resolve('/opt/xpanel-lab/bin', executableName),
  ]
  let pnpmPath = null
  let pnpmArgs = []
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const canonical = realpathSync(candidate)
    if (!lstatSync(canonical).isFile() || isPathInside(realpathSync(targetDir), canonical)) continue
    // An explicit JavaScript CLI is run by the already pinned Node, never by a shell shim.
    const args = /\.[cm]js$/.test(canonical) ? [canonical] : []
    const command = args.length ? process.execPath : canonical
    const probe = spawnSync(command, [...args, '--version'], { encoding: 'utf8', timeout: 20_000, windowsHide: true,
      env: { PATH: dirname(process.execPath), LANG: 'C', LC_ALL: 'C', ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {}) } })
    if ((probe.status ?? 1) === 0 && (probe.stdout ?? '').trim() === wanted) {
      pnpmPath = canonical
      pnpmArgs = args
      break
    }
  }
  if (!pnpmPath) throw new Error(`Pinned pnpm ${wanted} was not found at the explicit path, beside the verifier or in /opt/xpanel-lab/bin`)
  const systemPath = process.platform === 'win32'
    ? [process.env.SystemRoot ? `${process.env.SystemRoot}\\System32` : 'C:\\Windows\\System32']
    : ['/opt/xpanel-lab/bin', '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin']
  const env = {
    PATH: [dirname(process.execPath), dirname(pnpmPath), ...systemPath].join(delimiter),
    HOME: process.env.HOME ?? (process.platform === 'win32' ? process.env.USERPROFILE ?? 'C:\\Users\\Default' : '/root'),
    LANG: 'C',
    LC_ALL: 'C',
    CI: 'true',
  }
  if (process.platform === 'win32') {
    env.SystemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    env.PATHEXT = '.EXE'
  }
  return { env, pnpmPath, pnpmVersion: wanted, command: pnpmArgs.length ? process.execPath : pnpmPath, args: pnpmArgs }
}

function defaultInstallCommand(targetDir, options = {}) {
  let tool
  try {
    tool = buildFrozenInstallEnvironment(targetDir, options)
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      pnpmVersion: null,
    }
  }
  const child = spawnSync(tool.command, [...tool.args, 'install', '--frozen-lockfile'], {
    cwd: targetDir,
    env: tool.env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  if ((child.status ?? 1) !== 0) {
    return {
      exitCode: child.status ?? 1,
      stdout: child.stdout ?? '',
      stderr: child.stderr ?? (child.error?.message ?? ''),
      pnpmVersion: null,
    }
  }
  const version = spawnSync(tool.command, [...tool.args, '--version'], {
    cwd: targetDir,
    env: tool.env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  })
  const pnpmVersion = (version.stdout ?? '').trim()
  if ((version.status ?? 1) !== 0 || pnpmVersion !== tool.pnpmVersion) {
    return {
      exitCode: 1,
      stdout: version.stdout ?? '',
      stderr: version.stderr || version.error?.message || 'Pinned pnpm version probe failed after frozen install',
      pnpmVersion: null,
    }
  }
  return {
    exitCode: 0,
    stdout: child.stdout ?? '',
    stderr: child.stderr ?? '',
    pnpmVersion,
  }
}

export function verifyAndExtractSourceSnapshot({
  archivePath,
  manifestPath,
  expectedArchiveSha256,
  expectedSourceSha256,
  destination,
  receiptOutputPath = null,
  pnpmPath = null,
  installCommand = defaultInstallCommand,
}) {
  if (!HEX64_RE.test(expectedArchiveSha256 ?? '')) {
    throw new Error('Coordinator-supplied expectedArchiveSha256 (<64 lowercase hex>) is required')
  }
  if (!HEX64_RE.test(expectedSourceSha256 ?? '')) {
    throw new Error('Coordinator-supplied expectedSourceSha256 (<64 lowercase hex>) is required')
  }
  if (!archivePath || !manifestPath || !destination) {
    throw new Error('archivePath, manifestPath, and destination are required')
  }

  const absArchive = resolve(archivePath)
  const absManifest = resolve(manifestPath)
  const absDest = assertSafeDestinationAncestors(destination)

  const archiveStat = lstatSync(absArchive)
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) {
    throw new Error(`Archive path must be a regular non-symlink file: ${absArchive}`)
  }
  const archiveBytes = readFileSync(absArchive)
  const actualArchiveSha = sha256Hex(archiveBytes)
  if (actualArchiveSha !== expectedArchiveSha256) {
    throw new Error(`Archive sha256 mismatch: expected ${expectedArchiveSha256}, got ${actualArchiveSha}`)
  }

  const manifest = validateAndParseManifest(absManifest, expectedArchiveSha256, expectedSourceSha256)
  const tarMembers = inspectTarGzArchive(archiveBytes)

  if (tarMembers.length !== manifest.files.length) {
    throw new Error(`Archive member count (${tarMembers.length}) does not match manifest (${manifest.files.length}); extra or missing member rejected`)
  }

  const manifestMap = new Map(manifest.files.map(f => [f.path, f]))
  for (const member of tarMembers) {
    const expected = manifestMap.get(member.path)
    if (!expected) {
      throw new Error(`Archive contains unlisted extra member: ${member.path}`)
    }
    if (member.bytes !== expected.bytes || member.sha256 !== expected.sha256) {
      throw new Error(`Archive member sha256 or byte mismatch for ${member.path}`)
    }
  }

  const tarSourceSha = computeSourceDigest(tarMembers.map(m => ({ path: m.path, sha256: m.sha256 })))
  if (tarSourceSha !== expectedSourceSha256) {
    throw new Error(`Archive aggregate source_sha256 mismatch: expected ${expectedSourceSha256}, got ${tarSourceSha}`)
  }

  // Extract verified members to destination without importing archive owners or permissions
  mkdirSync(absDest, { recursive: true, mode: 0o755 })
  const createdDirs = new Set([absDest])
  const isRootLinux = process.platform === 'linux' && process.getuid?.() === 0
  if (isRootLinux) {
    chownSync(absDest, 0, 0)
    chmodSync(absDest, 0o755)
  }

  for (const member of tarMembers) {
    const targetFile = resolve(absDest, member.path)
    const parentDir = dirname(targetFile)
    if (!createdDirs.has(parentDir)) {
      mkdirSync(parentDir, { recursive: true, mode: 0o755 })
      // Normalize every intermediate directory under absDest
      let cur = parentDir
      while (isPathInside(absDest, cur) && !createdDirs.has(cur)) {
        if (isRootLinux) chownSync(cur, 0, 0)
        chmodSync(cur, 0o755)
        createdDirs.add(cur)
        if (cur === absDest) break
        cur = dirname(cur)
      }
    }
    writeFileSync(targetFile, member.content, { mode: 0o644, flag: 'wx' })
    if (isRootLinux) chownSync(targetFile, 0, 0)
    chmodSync(targetFile, 0o644)
  }

  // Verify pre-install tree on disk (no dependency directories allowed before install)
  verifyExtractedTreeAgainstEntries(absDest, manifest.files, { allowDependencyDirs: false })

  // Execute frozen-lockfile install in destination
  const installResult = installCommand(absDest, { pnpmPath })
  if (!installResult || installResult.exitCode !== 0) {
    throw new Error(`Frozen lockfile install failed in ${absDest} (exit=${installResult?.exitCode}): ${installResult?.stderr || ''}`)
  }

  // Re-verify all tracked source files and lockfile after install to ensure zero drift or injected source files
  const postInstallEntries = verifyExtractedTreeAgainstEntries(absDest, manifest.files, { allowDependencyDirs: true })
  const postInstallSourceSha = computeSourceDigest(postInstallEntries)
  if (postInstallSourceSha !== expectedSourceSha256) {
    throw new Error(`Post-install source drift detected: expected ${expectedSourceSha256}, got ${postInstallSourceSha}`)
  }

  const lockfileEntry = postInstallEntries.find(e => e.path === 'pnpm-lock.yaml')
  const receiptPayload = {
    schema_version: 1,
    status: 'verified',
    verified_at: new Date().toISOString(),
    destination: realpathSync(absDest),
    archive_sha256: expectedArchiveSha256,
    source_sha256: expectedSourceSha256,
    lockfile_sha256: lockfileEntry?.sha256 ?? null,
    file_count: postInstallEntries.length,
    drift_detected: false,
    runtime: {
      node: process.version,
      platform: process.platform,
      uid: process.getuid?.() ?? null,
      pnpm: typeof installResult.pnpmVersion === 'string' && /^\d+\.\d+\.\d+$/.test(installResult.pnpmVersion)
        ? installResult.pnpmVersion
        : null,
    },
    install: {
      executed: true,
      exit_code: installResult.exitCode,
    },
    files: postInstallEntries,
  }
  const receipt = {
    ...receiptPayload,
    receipt_sha256: computeReceiptDigest(receiptPayload),
  }

  const inTreeReceiptPath = resolve(absDest, SNAPSHOT_RECEIPT_FILENAME)
  writeFileSync(inTreeReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644 })
  if (isRootLinux) {
    chownSync(inTreeReceiptPath, 0, 0)
    chmodSync(inTreeReceiptPath, 0o644)
  }

  if (receiptOutputPath) {
    const extPath = resolve(receiptOutputPath)
    mkdirSync(dirname(extPath), { recursive: true })
    writeFileSync(extPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644 })
  }

  return receipt
}

/**
 * Verifies that `rootDir` contains a valid `.xpanel-snapshot-receipt.json` matching the
 * coordinator archive and source digests, and that every receipt file on disk is unmodified.
 * A receipt self-hash is not a coordinator signature. Never trusts `XPANEL_SOURCE_VERIFIED=true`.
 */
export function verifySnapshotReceipt({
  rootDir,
  expectedArchiveSha256,
  expectedSourceSha256,
  receiptPath = null,
  requirePinnedPnpm = false,
}) {
  const reasons = []
  if (!HEX64_RE.test(expectedArchiveSha256 ?? '')) {
    reasons.push('A coordinator supplied --snapshot-sha256=<64 lowercase hex> is required.')
    return { ok: false, reasons, receipt: null }
  }
  if (!HEX64_RE.test(expectedSourceSha256 ?? '')) {
    reasons.push('A coordinator supplied --source-sha256=<64 lowercase hex> is required.')
  }

  const absRoot = resolve(rootDir)
  const targetReceiptPath = receiptPath ? resolve(receiptPath) : resolve(absRoot, SNAPSHOT_RECEIPT_FILENAME)
  if (!existsSync(targetReceiptPath)) {
    reasons.push(`Verified source snapshot receipt is missing (${SNAPSHOT_RECEIPT_FILENAME}); run verify-source-snapshot.mjs first.`)
    return { ok: false, reasons, receipt: null }
  }

  try {
    const st = lstatSync(targetReceiptPath)
    if (!st.isFile() || st.isSymbolicLink()) {
      reasons.push('Snapshot receipt path is not a regular non-symlink file.')
      return { ok: false, reasons, receipt: null }
    }
    const receipt = JSON.parse(readFileSync(targetReceiptPath, 'utf8'))
    if (receipt?.schema_version !== 1 || receipt?.status !== 'verified') {
      reasons.push('Snapshot receipt has invalid schema_version or status.')
    }
    if (receipt?.drift_detected !== false) {
      reasons.push('Snapshot receipt reports drift_detected !== false.')
    }
    if (receipt?.archive_sha256 !== expectedArchiveSha256) {
      reasons.push(`Snapshot receipt archive_sha256 (${receipt?.archive_sha256}) does not match expected (${expectedArchiveSha256}).`)
    }
    if (HEX64_RE.test(expectedSourceSha256 ?? '') && receipt?.source_sha256 !== expectedSourceSha256) {
      reasons.push(`Snapshot receipt source_sha256 (${receipt?.source_sha256}) does not match coordinator expected source digest (${expectedSourceSha256}).`)
    }
    const expectedReceiptDigest = computeReceiptDigest(receipt)
    if (!HEX64_RE.test(receipt?.receipt_sha256 ?? '') || receipt.receipt_sha256 !== expectedReceiptDigest) {
      reasons.push('Snapshot receipt self-digest (receipt_sha256) is invalid or tampered.')
    }
    const canonicalRoot = existsSync(absRoot) ? realpathSync(absRoot) : absRoot
    if (receipt?.destination && receipt.destination !== canonicalRoot) {
      reasons.push(`Snapshot receipt destination (${receipt.destination}) does not match current root (${canonicalRoot}).`)
    }
    if (!Array.isArray(receipt?.files) || receipt.files.length === 0 || receipt.file_count !== receipt.files.length) {
      reasons.push('Snapshot receipt file list is missing or invalid.')
    } else {
      const verifiedEntries = verifyExtractedTreeAgainstEntries(absRoot, receipt.files, { allowDependencyDirs: true })
      const currentSourceSha = computeSourceDigest(verifiedEntries)
      if (currentSourceSha !== receipt.source_sha256) {
        reasons.push(`Current source tree digest (${currentSourceSha}) drifted from receipt (${receipt.source_sha256}).`)
      }
      if (HEX64_RE.test(expectedSourceSha256 ?? '') && currentSourceSha !== expectedSourceSha256) {
        reasons.push(`Current source tree digest (${currentSourceSha}) does not match coordinator expected source digest (${expectedSourceSha256}).`)
      }
    }
    if (requirePinnedPnpm && !/^\d+\.\d+\.\d+$/.test(receipt?.runtime?.pnpm ?? '')) {
      reasons.push('Snapshot receipt is missing the pnpm version recorded by the frozen install.')
    } else if (requirePinnedPnpm) {
      const manifest = JSON.parse(readFileSync(resolve(absRoot, 'package.json'), 'utf8'))
      const pin = /^pnpm@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager ?? '')
      if (!pin || receipt.runtime.pnpm !== pin[1]) {
        reasons.push('Snapshot receipt pnpm version does not match the exact source-bound packageManager pin.')
      }
    }
    return { ok: reasons.length === 0, reasons, receipt: reasons.length === 0 ? receipt : null }
  } catch (error) {
    reasons.push(`Snapshot receipt verification failed: ${error instanceof Error ? error.message : String(error)}`)
    return { ok: false, reasons, receipt: null }
  }
}

function parseCliArgs(argv) {
  const out = {}
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq === -1) out[arg.slice(2)] = 'true'
    else out[arg.slice(2, eq)] = arg.slice(eq + 1)
  }
  return out
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseCliArgs(process.argv.slice(2))
  try {
    const receipt = verifyAndExtractSourceSnapshot({
      archivePath: args['archive'],
      manifestPath: args['manifest'],
      expectedArchiveSha256: args['expected-archive-sha256'],
      expectedSourceSha256: args['expected-source-sha256'],
      destination: args['destination'],
      receiptOutputPath: args['receipt'] ?? null,
      pnpmPath: args['pnpm-path'] ?? null,
    })
    process.stdout.write(
      `${JSON.stringify({
        status: receipt.status,
        destination: receipt.destination,
        archive_sha256: receipt.archive_sha256,
        source_sha256: receipt.source_sha256,
        lockfile_sha256: receipt.lockfile_sha256,
        file_count: receipt.file_count,
        receipt_sha256: receipt.receipt_sha256,
      })}\n`,
    )
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: 'failed', error: error instanceof Error ? error.message : String(error) })}\n`)
    process.exitCode = 1
  }
}
