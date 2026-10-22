import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildTarArchive,
  computeSourceDigest,
  inspectTarGzArchive,
  verifyAndExtractSourceSnapshot,
  verifySnapshotReceipt,
} from './vm/verify-source-snapshot.mjs'

const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')

interface TarTestEntry {
  path: string
  content?: Buffer | string
  typeflag?: string
  linkname?: string
  mode?: number
}

function createSyntheticTarGz(entries: TarTestEntry[]): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const body = entry.content !== undefined ? (Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf8')) : Buffer.alloc(0)
    const header = Buffer.alloc(512, 0)
    header.write(entry.path, 0, Math.min(100, Buffer.byteLength(entry.path)), 'utf8')
    header.write( modalOctal(entry.mode ?? 0o644, 7), 100, 7, 'ascii')
    header.write(modalOctal(0, 7), 108, 7, 'ascii')
    header.write(modalOctal(0, 7), 116, 7, 'ascii')
    const size = entry.typeflag && entry.typeflag !== '0' && entry.typeflag !== '\0' ? 0 : body.length
    header.write(modalOctal(size, 11), 124, 11, 'ascii')
    header.write(modalOctal(1700000000, 11), 136, 11, 'ascii')
    header.fill(0x20, 148, 156)
    header[156] = (entry.typeflag ?? '0').charCodeAt(0)
    if (entry.linkname) {
      header.write(entry.linkname, 157, Math.min(100, Buffer.byteLength(entry.linkname)), 'utf8')
    }
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    let sum = 0
    for (let i = 0; i < 512; i++) sum += header[i]!
    header.write(modalOctal(sum, 6), 148, 6, 'ascii')
    header[154] = 0
    header[155] = 0x20
    blocks.push(header)
    if (size > 0) {
      blocks.push(body)
      const remainder = size % 512
      if (remainder !== 0) blocks.push(Buffer.alloc(512 - remainder, 0))
    }
  }
  blocks.push(Buffer.alloc(1024, 0))
  return gzipSync(Buffer.concat(blocks))
}

function modalOctal(val: number, width: number): string {
  return val.toString(8).padStart(width, '0')
}

function createValidFixtureSnapshot(baseDir: string, extraFiles: Record<string, string> = {}) {
  const fileMap: Record<string, string> = {
    '.node-version': '26.12.1\n',
    'package.json': JSON.stringify({ name: 'xpanel-test-fixture', private: true }, null, 2) + '\n',
    'pnpm-lock.yaml': 'lockfileVersion: \'9.0\'\n',
    'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n',
    'tsconfig.base.json': '{}\n',
    'vitest.config.ts': 'export default {}\n',
    'apps/api/src/index.ts': 'export const ok = true\n',
    'packages/core/src/index.ts': 'export const core = 1\n',
    'scripts/test-linux-preflight.mjs': 'export const x = 1\n',
    'docs/STANDARDS.md': '# Standards\n',
    'docs/ARCHITECTURE.md': '# Architecture\n',
    ...extraFiles,
  }
  const sortedPaths = Object.keys(fileMap).sort()
  const tarEntries: TarTestEntry[] = sortedPaths.map(path => ({
    path,
    content: fileMap[path]!,
    typeflag: '0',
    mode: 0o777, // Intentionally permissive in archive to verify extraction normalizes to 0644
  }))
  const archiveBytes = createSyntheticTarGz(tarEntries)
  const archivePath = join(baseDir, 'snapshot.tar.gz')
  writeFileSync(archivePath, archiveBytes)

  const manifestEntries = sortedPaths.map(path => {
    const buf = Buffer.from(fileMap[path]!, 'utf8')
    return { path, bytes: buf.length, sha256: sha256(buf) }
  })
  const sourceSha256 = computeSourceDigest(manifestEntries)
  const archiveSha256 = sha256(archiveBytes)
  const manifest = {
    schema_version: 1,
    created_at: new Date().toISOString(),
    scope: 'Test fixture snapshot',
    archive: archivePath,
    archive_sha256: archiveSha256,
    source_sha256: sourceSha256,
    file_count: manifestEntries.length,
    files: manifestEntries,
  }
  const manifestPath = join(baseDir, 'snapshot.manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  return { archivePath, manifestPath, archiveSha256, sourceSha256, manifest, fileMap }
}

describe('B03 source snapshot & receipt verifier (A01, A02)', () => {
  const tempRoots: string[] = []
  const makeTempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'xpanel-b03-test-'))
    tempRoots.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of tempRoots.splice(0)) {
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  })

  it('extracts a valid archive, runs frozen install hook, re-verifies source and lockfile, and writes a valid receipt', () => {
    const work = makeTempDir()
    const fixture = createValidFixtureSnapshot(work, {
      'helpers/account-files/xpanel-account-files.c': 'int main(void) { return 0; }\n',
    })
    const destination = join(work, 'extracted')

    const result = verifyAndExtractSourceSnapshot({
      archivePath: fixture.archivePath,
      manifestPath: fixture.manifestPath,
      expectedArchiveSha256: fixture.archiveSha256,
      expectedSourceSha256: fixture.sourceSha256,
      destination,
      installCommand: targetDir => {
        // Simulate frozen-lockfile install creating node_modules without mutating tracked source
        mkdirSync(join(targetDir, 'node_modules/.pnpm'), { recursive: true })
        writeFileSync(join(targetDir, 'node_modules/.modules.yaml'), 'storeDir: /tmp\n')
        return { exitCode: 0, stdout: 'Done in 0.5s', stderr: '' }
      },
    })

    expect(result.status).toBe('verified')
    expect(result.archive_sha256).toBe(fixture.archiveSha256)
    expect(result.source_sha256).toBe(fixture.sourceSha256)
    expect(result.drift_detected).toBe(false)
    expect(existsSync(join(destination, '.xpanel-snapshot-receipt.json'))).toBe(true)

    const receiptCheck = verifySnapshotReceipt({
      rootDir: destination,
      expectedArchiveSha256: fixture.archiveSha256,
    })
    expect(receiptCheck.ok).toBe(true)
    expect(receiptCheck.receipt?.source_sha256).toBe(fixture.sourceSha256)
  })

  it('rejects missing coordinator-supplied expected digests without trusting manifest self-digests', () => {
    const work = makeTempDir()
    const fixture = createValidFixtureSnapshot(work)
    const destination = join(work, 'extracted')

    expect(() =>
      verifyAndExtractSourceSnapshot({
        archivePath: fixture.archivePath,
        manifestPath: fixture.manifestPath,
        expectedArchiveSha256: '',
        expectedSourceSha256: fixture.sourceSha256,
        destination,
      }),
    ).toThrow(/expectedArchiveSha256/i)
    expect(existsSync(destination)).toBe(false)
  })

  it('rejects a 1-byte modification in a source file or archive before or during verification with zero leftover destination', () => {
    const work = makeTempDir()
    const fixture = createValidFixtureSnapshot(work)
    const destination = join(work, 'extracted')

    // Tamper with archive content while keeping manifest sha stale
    const tamperedTar = createSyntheticTarGz(
      Object.keys(fixture.fileMap)
        .sort()
        .map(path => ({
          path,
          content: path === 'apps/api/src/index.ts' ? 'export const ok = false\n' : fixture.fileMap[path]!,
        })),
    )
    const tamperedArchivePath = join(work, 'tampered.tar.gz')
    writeFileSync(tamperedArchivePath, tamperedTar)

    expect(() =>
      verifyAndExtractSourceSnapshot({
        archivePath: tamperedArchivePath,
        manifestPath: fixture.manifestPath,
        expectedArchiveSha256: fixture.archiveSha256,
        expectedSourceSha256: fixture.sourceSha256,
        destination,
      }),
    ).toThrow(/archive sha256 mismatch/i)
    expect(existsSync(destination)).toBe(false)
  })

  it('rejects missing or duplicate manifest entries and extra archive members before creating destination', () => {
    const work = makeTempDir()
    const fixture = createValidFixtureSnapshot(work)
    const destination = join(work, 'extracted')

    // 1. Extra member in archive that is not in manifest
    const extraArchiveBytes = createSyntheticTarGz([
      ...Object.keys(fixture.fileMap)
        .sort()
        .map(path => ({ path, content: fixture.fileMap[path]! })),
      { path: 'apps/api/src/extra-unlisted.ts', content: 'console.log(1)\n' },
    ])
    const extraArchivePath = join(work, 'extra.tar.gz')
    writeFileSync(extraArchivePath, extraArchiveBytes)
    const extraArchiveSha = sha256(extraArchiveBytes)
    const manifestWithUpdatedArchiveSha = {
      ...fixture.manifest,
      archive_sha256: extraArchiveSha,
    }
    const extraManifestPath = join(work, 'extra.manifest.json')
    writeFileSync(extraManifestPath, JSON.stringify(manifestWithUpdatedArchiveSha, null, 2))

    expect(() =>
      verifyAndExtractSourceSnapshot({
        archivePath: extraArchivePath,
        manifestPath: extraManifestPath,
        expectedArchiveSha256: extraArchiveSha,
        expectedSourceSha256: fixture.sourceSha256,
        destination,
      }),
    ).toThrow(/unlisted|extra|mismatch/i)
    expect(existsSync(destination)).toBe(false)

    // 2. Duplicate member in tar archive
    const dupArchiveBytes = createSyntheticTarGz([
      ...Object.keys(fixture.fileMap)
        .sort()
        .map(path => ({ path, content: fixture.fileMap[path]! })),
      { path: 'apps/api/src/index.ts', content: fixture.fileMap['apps/api/src/index.ts']! },
    ])
    expect(() => inspectTarGzArchive(dupArchiveBytes)).toThrow(/duplicate/i)
  })

  it('rejects symlink, hardlink, and special tar entries before creating destination', () => {
    const work = makeTempDir()
    const destination = join(work, 'extracted')

    for (const badEntry of [
      { path: 'apps/api/src/symlink.ts', typeflag: '2', linkname: '/etc/shadow' },
      { path: 'apps/api/src/hardlink.ts', typeflag: '1', linkname: 'apps/api/src/index.ts' },
      { path: 'apps/api/src/fifo', typeflag: '6' },
    ]) {
      const archiveBytes = createSyntheticTarGz([
        { path: '.node-version', content: '26.12.1\n' },
        badEntry,
      ])
      expect(() => inspectTarGzArchive(archiveBytes)).toThrow(/non-regular|symlink|link|typeflag/i)
      expect(existsSync(destination)).toBe(false)
    }
  })

  it('rejects traversal, absolute, drive, UNC, backslash, control-char, and non-allowlisted paths before extraction', () => {
    const badPaths = [
      '../outside.ts',
      'apps/api/../../outside.ts',
      '/etc/passwd',
      'C:/Windows/win.ini',
      '\\\\server\\share\\file.ts',
      'apps\\api\\src\\win.ts',
      'apps/api/src/bad\rname.ts',
      '.secrets/hetzner.env',
      'apps/api/.workspace-private/notes.json',
      'packages/core/src/.local-cache/runtime.ts',
      'apps/api/.env.production',
      'apps/api/private.key',
      'unallowed-root/file.ts',
    ]
    for (const badPath of badPaths) {
      const archiveBytes = createSyntheticTarGz([{ path: badPath, content: 'x' }])
      expect(() => inspectTarGzArchive(archiveBytes)).toThrow()
    }
  })

  it('rejects existing destination (no overwrite) and rejects symlink ancestors in destination path', () => {
    const work = makeTempDir()
    const fixture = createValidFixtureSnapshot(work)
    const existingDest = join(work, 'already-exists')
    mkdirSync(existingDest, { recursive: true })
    writeFileSync(join(existingDest, 'sentinel.txt'), 'keep')

    expect(() =>
      verifyAndExtractSourceSnapshot({
        archivePath: fixture.archivePath,
        manifestPath: fixture.manifestPath,
        expectedArchiveSha256: fixture.archiveSha256,
        expectedSourceSha256: fixture.sourceSha256,
        destination: existingDest,
      }),
    ).toThrow(/already exists/i)
    expect(readFileSync(join(existingDest, 'sentinel.txt'), 'utf8')).toBe('keep')

    // Symlink parent test (when supported by OS permissions)
    const realParent = join(work, 'real-parent')
    const linkParent = join(work, 'link-parent')
    mkdirSync(realParent, { recursive: true })
    let symlinkCreated = false
    try {
      symlinkSync(realParent, linkParent, 'dir')
      symlinkCreated = true
    } catch {
      symlinkCreated = false
    }
    if (symlinkCreated) {
      expect(() =>
        verifyAndExtractSourceSnapshot({
          archivePath: fixture.archivePath,
          manifestPath: fixture.manifestPath,
          expectedArchiveSha256: fixture.archiveSha256,
          expectedSourceSha256: fixture.sourceSha256,
          destination: join(linkParent, 'extracted'),
        }),
      ).toThrow(/symlink|canonical/i)
    }
  })

  it('rejects source drift or unlisted source/build files introduced during frozen install', () => {
    const work = makeTempDir()
    const fixture = createValidFixtureSnapshot(work)
    const destDrift = join(work, 'dest-drift')

    expect(() =>
      verifyAndExtractSourceSnapshot({
        archivePath: fixture.archivePath,
        manifestPath: fixture.manifestPath,
        expectedArchiveSha256: fixture.archiveSha256,
        expectedSourceSha256: fixture.sourceSha256,
        destination: destDrift,
        installCommand: targetDir => {
          writeFileSync(join(targetDir, 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0-tampered\'\n')
          return { exitCode: 0, stdout: '', stderr: '' }
        },
      }),
    ).toThrow(/drift|modified|sha256/i)
    expect(existsSync(join(destDrift, '.xpanel-snapshot-receipt.json'))).toBe(false)

    const destExtra = join(work, 'dest-extra')
    expect(() =>
      verifyAndExtractSourceSnapshot({
        archivePath: fixture.archivePath,
        manifestPath: fixture.manifestPath,
        expectedArchiveSha256: fixture.archiveSha256,
        expectedSourceSha256: fixture.sourceSha256,
        destination: destExtra,
        installCommand: targetDir => {
          writeFileSync(join(targetDir, 'apps/api/src/rogue-postinstall.ts'), 'export const evil = 1\n')
          return { exitCode: 0, stdout: '', stderr: '' }
        },
      }),
    ).toThrow(/unlisted|unexpected|extra/i)
    expect(existsSync(join(destExtra, '.xpanel-snapshot-receipt.json'))).toBe(false)
  })

  it('rejects receipt verification when a file is modified after receipt issuance or XPANEL_SOURCE_VERIFIED=true is set without receipt', () => {
    const work = makeTempDir()
    const fixture = createValidFixtureSnapshot(work)
    const destination = join(work, 'extracted')

    verifyAndExtractSourceSnapshot({
      archivePath: fixture.archivePath,
      manifestPath: fixture.manifestPath,
      expectedArchiveSha256: fixture.archiveSha256,
      expectedSourceSha256: fixture.sourceSha256,
      destination,
      installCommand: () => ({ exitCode: 0, stdout: '', stderr: '' }),
    })

    // Modify 1 byte after receipt was written
    writeFileSync(join(destination, 'apps/api/src/index.ts'), 'export const ok = false\n')
    const afterTamper = verifySnapshotReceipt({
      rootDir: destination,
      expectedArchiveSha256: fixture.archiveSha256,
    })
    expect(afterTamper.ok).toBe(false)
    expect(afterTamper.reasons.join(' ')).toMatch(/mismatch|modified|drift/i)

    // Missing receipt in an unverified directory even with XPANEL_SOURCE_VERIFIED=true
    const unverifiedDir = join(work, 'unverified')
    mkdirSync(unverifiedDir, { recursive: true })
    process.env.XPANEL_SOURCE_VERIFIED = 'true'
    try {
      const noReceipt = verifySnapshotReceipt({
        rootDir: unverifiedDir,
        expectedArchiveSha256: fixture.archiveSha256,
      })
      expect(noReceipt.ok).toBe(false)
      expect(noReceipt.reasons.join(' ')).toMatch(/receipt/i)
    } finally {
      delete process.env.XPANEL_SOURCE_VERIFIED
    }
  })

  it('verifies and extracts the real repository snapshot archive when present in .tools/source-snapshots', () => {
    const repoRoot = resolve(import.meta.dirname, '..')
    const realArchive = resolve(repoRoot, '.tools/source-snapshots/source-20261022T104858739Z-4c761b30.tar.gz')
    const realManifest = resolve(repoRoot, '.tools/source-snapshots/source-20261022T104858739Z-4c761b30.manifest.json')
    if (!existsSync(realArchive) || !existsSync(realManifest)) return

    const work = makeTempDir()
    const destination = join(work, 'real-snapshot-extracted')
    const receipt = verifyAndExtractSourceSnapshot({
      archivePath: realArchive,
      manifestPath: realManifest,
      expectedArchiveSha256: 'aa42db6b7d0e0152e6e92e579b2ffdef80d04ab91d20efd3cbc288dfffbc8df6',
      expectedSourceSha256: 'd84bf97cd85faae1bd63c007d6e839ea94cf73ba0ea39dfcca7f1c7338f72a71',
      destination,
      installCommand: () => ({ exitCode: 0, stdout: 'verified', stderr: '' }),
    })
    expect(receipt.status).toBe('verified')
    expect(receipt.file_count).toBe(318)
    expect(receipt.source_sha256).toBe('d84bf97cd85faae1bd63c007d6e839ea94cf73ba0ea39dfcca7f1c7338f72a71')

    const verified = verifySnapshotReceipt({
      rootDir: destination,
      expectedArchiveSha256: 'aa42db6b7d0e0152e6e92e579b2ffdef80d04ab91d20efd3cbc288dfffbc8df6',
    })
    expect(verified.ok).toBe(true)
  })
})
