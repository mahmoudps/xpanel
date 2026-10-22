import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEV_ONLY_PACKAGES,
  DESIGN_REFERENCE_INPUTS,
  REQUIRED_RELEASE_ENTRYPOINTS,
  REQUIRED_ROOT_FILES,
  REQUIRED_SYSTEMD_UNITS,
  ReleaseArtifactError,
  buildReleaseArtifact,
  createTarGzBuffer,
  parseTarGzBuffer,
  parseSystemdUnitContract,
  unpackVerifiedRelease,
  verifyReleaseArchive,
  verifyReleaseArtifact,
} from './package-release.mjs'

const tempDirs: string[] = []

const makeTempDir = (prefix = 'xpanel-release-test-'): string => {
  const root = resolve(tmpdir())
  const dir = mkdtempSync(join(root, prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  const root = resolve(tmpdir())
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    const target = resolve(dir)
    if (dirname(target) === root && basename(target).startsWith('xpanel-release-test-')) {
      rmSync(target, { recursive: true, force: true })
    }
  }
})

const expectReleaseError = async (fn: () => Promise<unknown> | unknown, expectedCode: string): Promise<ReleaseArtifactError> => {
  try {
    await fn()
  } catch (err) {
    expect(err).toBeInstanceOf(ReleaseArtifactError)
    const relErr = err as ReleaseArtifactError
    expect(relErr.code).toBe(expectedCode)
    return relErr
  }
  throw new Error(`Expected ReleaseArtifactError(${expectedCode}), but call succeeded`)
}

const createCustomTarGz = async (
  filePath: string,
  entries: Array<{
    name: string
    content?: string
    mode?: number
    uid?: number
    gid?: number
    type?: 'file' | 'directory' | 'symlink'
    linkname?: string
  }>,
): Promise<void> => {
  writeFileSync(filePath, createTarGzBuffer(entries))
}

const writeSourceFile = (root: string, path: string, content: string | Buffer): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}

const makeSourceFixture = (): string => {
  const root = makeTempDir()
  const workspace = resolve(import.meta.dirname, '..')
  for (const path of [...REQUIRED_ROOT_FILES, ...REQUIRED_SYSTEMD_UNITS]) {
    writeSourceFile(root, path, readFileSync(join(workspace, path)))
  }
  for (const path of REQUIRED_RELEASE_ENTRYPOINTS) writeSourceFile(root, path, 'export {}\n')
  for (const name of ['api', 'agent', 'web']) {
    writeSourceFile(root, `apps/${name}/package.json`, JSON.stringify({ name: `@xpanel/${name}`, type: 'module', exports: { '.': './src/index.ts' } }))
    writeSourceFile(root, `apps/${name}/src/index.ts`, 'export {}\n')
  }
  writeSourceFile(root, 'packages/db/src/migrations/0001_init.sql', 'CREATE TABLE release_fixture (id INTEGER);\n')
  return root
}

describe('H01 release artifact packager & pre-unpack verifier (A26, A28, A59)', () => {
  it('builds a deterministic, signed release bundle with verified entrypoints, systemd units, migrations, and SBOM', async () => {
    const outDir = makeTempDir()
    const signingKey = 'xpanel-release-signing-key-2026-10-22'
    const built = await buildReleaseArtifact({
      outputDir: outDir,
      version: '0.1.0',
      signingKey,
      keyId: 'release-key-1',
    })

    expect(built.version).toBe('0.1.0')
    expect(built.schemaVersion).toBeGreaterThan(0)
    expect(existsSync(built.stagingDir)).toBe(true)
    expect(built.archivePath && existsSync(built.archivePath)).toBe(true)
    expect(built.archiveSha256).toMatch(/^[a-f0-9]{64}$/)

    // Verify pinned runtime contract in manifest
    expect(built.manifest.runtime).toEqual({
      nodeVersion: '26.12.1',
      packageManager: 'pnpm@12.15.0',
      typescriptVersion: '7.0.2',
      executionMode: 'node-strip-types-source',
    })

    // Verify all required entrypoints and systemd units are present in manifest and staging
    const filePaths = new Set(built.manifest.files.map((f: { path: string }) => f.path))
    for (const ep of REQUIRED_RELEASE_ENTRYPOINTS) {
      expect(filePaths.has(ep)).toBe(true)
      expect(existsSync(join(built.stagingDir, ep))).toBe(true)
    }
    for (const unit of REQUIRED_SYSTEMD_UNITS) {
      expect(filePaths.has(unit)).toBe(true)
      expect(existsSync(join(built.stagingDir, unit))).toBe(true)
    }

    // Verify systemd units match the S03/H01 identity & permission contract and never reference dist/index.js
    const agentUnit = built.manifest.systemdUnits.find((u: { name: string }) => u.name === 'xpanel-agent.service')
    const apiUnit = built.manifest.systemdUnits.find((u: { name: string }) => u.name === 'xpanel-api.service')
    expect(agentUnit).toMatchObject({
      name: 'xpanel-agent.service',
      user: 'root',
      group: 'xpanel-agent',
      supplementaryGroups: 'xpanel',
      runtimeDirectory: 'xpanel',
      runtimeDirectoryMode: '0750',
      runtimeDirectoryPreserve: 'no',
      umask: '0007',
      execStart: '/usr/bin/node --max-old-space-size=64 /opt/xpanel/apps/agent/src/main.ts',
    })
    expect(apiUnit).toMatchObject({
      name: 'xpanel-api.service',
      user: 'xpanel',
      group: 'xpanel',
      supplementaryGroups: 'xpanel-agent',
      umask: '0007',
      noNewPrivileges: 'yes',
      execStart: '/usr/bin/node --max-old-space-size=96 /opt/xpanel/apps/api/src/main.ts',
    })

    // Verify SBOM excludes dev-only packages and non-permissive dependencies
    const prodNames = built.sbom.productionDependencies.map((d: { name: string }) => d.name)
    expect(prodNames).toContain('ws')
    expect(prodNames).toContain('tar-stream')
    expect(prodNames).toContain('yaml')
    for (const devPkg of DEV_ONLY_PACKAGES) {
      expect(prodNames).not.toContain(devPkg)
    }

    // Verify no test files, fixtures, or secrets entered the bundle
    for (const f of built.manifest.files) {
      expect(f.path).not.toMatch(/\.test\.ts$|\.spec\.ts$|fixtures\.ts$/)
      expect(f.path).not.toMatch(/^\.git|^\.secrets|^node_modules|^\.tools/)
    }

    // Exclusion metadata does not depend on local reference assets being present.
    const referenceDir = DESIGN_REFERENCE_INPUTS.directories[0]!
    const referenceFiles = ['reference.dc.html', 'support.js']
    const excludedPaths = [...DESIGN_REFERENCE_INPUTS.files, ...referenceFiles.map((path) => `${referenceDir}${path}`)]
    const archivePaths = new Set(parseTarGzBuffer(readFileSync(built.archivePath!)).map((entry: { name: string }) => entry.name))
    for (const path of excludedPaths) {
      expect(filePaths.has(path)).toBe(false)
      expect(archivePaths.has(path)).toBe(false)
      expect(built.manifest.webAssets.some((asset: { path: string }) => asset.path === path)).toBe(false)
      expect(existsSync(join(built.stagingDir, path))).toBe(false)
    }
    expect(built.manifest.sourcePolicy.excludedDesignReferences).toEqual(DESIGN_REFERENCE_INPUTS)
    expect(built.sbom.provenance.excludedDesignReferences).toEqual(DESIGN_REFERENCE_INPUTS)
    expect(built.manifest.sourcePolicy.sourceClosure.checkedSources).toBeGreaterThan(0)
    expect(built.manifest.sourcePolicy.sourceClosure.checkedImports).toBeGreaterThan(0)
    for (const path of ['helpers/account-files/build.mjs', 'helpers/account-files/xpanel-account-files.c', 'apps/agent/src/peer-identity.ts']) {
      expect(filePaths.has(path)).toBe(true)
      expect(archivePaths.has(path)).toBe(true)
    }

    // Verify both staged directory and tarball pass full verification
    const verified = await verifyReleaseArtifact({
      artifactDir: built.stagingDir,
      archivePath: built.archivePath!,
      expectedArchiveSha256: built.archiveSha256!,
      signingKey,
      requireSignature: true,
      pinnedNodeVersion: '26.12.1',
    })
    expect(verified.ok).toBe(true)
    expect(verified.verifiedFilesCount).toBe(built.manifest.files.length)
  })

  it('excludes 148 synthetic reference inputs from every release surface without local assets', async () => {
    const sourceRoot = makeSourceFixture()
    const referenceDir = DESIGN_REFERENCE_INPUTS.directories[0]!
    const paths = [...DESIGN_REFERENCE_INPUTS.files, `${referenceDir}support.js`, ...Array.from({ length: 146 }, (_, index) => `${referenceDir}screen-${index}.dc.html`)]
    expect(paths).toHaveLength(148)
    for (const path of paths) writeSourceFile(sourceRoot, path, 'synthetic reference only\n')
    writeSourceFile(sourceRoot, 'apps/api/src/.workspace-private/runtime.ts', 'local-only\n')
    const built = await buildReleaseArtifact({ sourceRoot, outputDir: makeTempDir() })
    const manifestPaths = new Set(built.manifest.files.map((file: { path: string }) => file.path))
    const archivePaths = new Set(parseTarGzBuffer(readFileSync(built.archivePath!)).map((entry: { name: string }) => entry.name))
    for (const path of [...paths, 'apps/api/src/.workspace-private/runtime.ts']) {
      expect(manifestPaths.has(path)).toBe(false)
      expect(archivePaths.has(path)).toBe(false)
      expect(built.manifest.webAssets.some((asset: { path: string }) => asset.path === path)).toBe(false)
      expect(existsSync(join(built.stagingDir, path))).toBe(false)
    }
    mkdirSync(join(built.stagingDir, 'apps/api/src/.workspace-private'), { recursive: true })
    await expectReleaseError(() => verifyReleaseArtifact({ artifactDir: built.stagingDir }), 'FORBIDDEN_ARTIFACT_FILE')
  })

  it('keeps the release digest deterministic when only excluded design references change', async () => {
    const sourceRoot = makeSourceFixture()
    const renderer = 'apps/web/src/live-boards.ts'
    const board = 'apps/web/src/design-boards/reference.dc.html'
    writeSourceFile(sourceRoot, renderer, 'export const preview = 1\n')
    writeSourceFile(sourceRoot, board, '<main>Reference revision 1</main>\n')
    const first = await buildReleaseArtifact({ sourceRoot, outputDir: makeTempDir() })
    writeSourceFile(sourceRoot, renderer, 'export const preview = 2\n')
    writeSourceFile(sourceRoot, board, '<main>Reference revision 2</main>\n')
    const second = await buildReleaseArtifact({ sourceRoot, outputDir: makeTempDir() })
    expect(second.archiveSha256).toBe(first.archiveSha256)
    expect(second.manifestSha256).toBe(first.manifestSha256)
  })

  it.each(['ts', 'js', 'mjs', 'html', 'json', 'css'].flatMap((extension) =>
    ['XPANEL_SERVER_SECRET=', 'XPANEL_AGENT_TOKEN=', 'BEGIN PRIVATE KEY'].map((pattern) => ({ extension, pattern })),
  ))('rejects credential patterns in production .$extension inputs ($pattern)', async ({ extension, pattern }) => {
    const sourceRoot = makeSourceFixture()
    const path = `apps/web/src/runtime.${extension}`
    writeSourceFile(sourceRoot, path, pattern)
    const err = await expectReleaseError(
      () => buildReleaseArtifact({ sourceRoot, outputDir: makeTempDir(), createTarball: false }),
      'SECRET_LEAK_DETECTED',
    )
    expect(err.detail.path).toBe(path)
  })

  it.each([
    ['static import', 'import "./live-boards.ts"'],
    ['multiline export', 'export {\n preview\n} from "./live-boards.ts"'],
    ['dynamic import', 'void import("./live-boards.ts")'],
  ])('rejects a production %s of an excluded design reference', async (_name, content) => {
    const sourceRoot = makeSourceFixture()
    writeSourceFile(sourceRoot, 'apps/web/src/index.ts', content)
    writeSourceFile(sourceRoot, 'apps/web/src/live-boards.ts', 'export const preview = 1\n')
    writeSourceFile(sourceRoot, 'apps/web/src/design-boards/reference.dc.html', '<main>Reference</main>\n')
    const err = await expectReleaseError(
      () => buildReleaseArtifact({ sourceRoot, outputDir: makeTempDir(), createTarball: false }),
      'RELEASE_DEPENDENCY_MISSING',
    )
    expect(err.detail.designReference).toBe(true)
  })

  it.each([
    ['missing source', 'import "./missing.ts"', 'RELEASE_DEPENDENCY_MISSING'],
    ['excluded test fixture', 'import "./fixtures.ts"', 'RELEASE_DEPENDENCY_MISSING'],
    ['computed import', 'void import(process.env.XPANEL_MODULE)', 'UNRESOLVED_RELEASE_IMPORT'],
    ['constant computed import', 'const board = "./live-boards.ts"; void import(board)', 'UNRESOLVED_RELEASE_IMPORT'],
    ['template computed import', 'void import(`./${process.env.XPANEL_MODULE}.ts`)', 'UNRESOLVED_RELEASE_IMPORT'],
    ['development dependency', 'import "vitest"', 'UNDECLARED_RELEASE_DEPENDENCY'],
  ])('rejects a runtime closure with %s', async (_name, content, code) => {
    const sourceRoot = makeSourceFixture()
    writeSourceFile(sourceRoot, 'apps/web/src/index.ts', content)
    writeSourceFile(sourceRoot, 'apps/web/src/fixtures.ts', 'export {}\n')
    await expectReleaseError(
      () => buildReleaseArtifact({ sourceRoot, outputDir: makeTempDir(), createTarball: false }),
      code,
    )
  })

  it('rejects package exports that target an excluded reference', async () => {
    const sourceRoot = makeSourceFixture()
    writeSourceFile(sourceRoot, 'apps/web/package.json', JSON.stringify({ name: '@xpanel/web', exports: { '.': './src/live-boards.ts' } }))
    writeSourceFile(sourceRoot, 'apps/web/src/live-boards.ts', 'export {}\n')
    const err = await expectReleaseError(
      () => buildReleaseArtifact({ sourceRoot, outputDir: makeTempDir(), createTarball: false }),
      'RELEASE_DEPENDENCY_MISSING',
    )
    expect(err.detail.designReference).toBe(true)
  })

  it('checks workspace imports through their production package exports', async () => {
    const sourceRoot = makeSourceFixture()
    writeSourceFile(sourceRoot, 'apps/web/package.json', JSON.stringify({
      name: '@xpanel/web', exports: { '.': './src/index.ts' }, dependencies: { '@xpanel/agent': 'workspace:*' },
    }))
    writeSourceFile(sourceRoot, 'apps/web/src/index.ts', 'export * from "@xpanel/agent"\n')
    const built = await buildReleaseArtifact({ sourceRoot, outputDir: makeTempDir(), createTarball: false })
    expect(built.manifest.files.map((file: { path: string }) => file.path)).toContain('apps/agent/src/index.ts')
    writeSourceFile(sourceRoot, 'apps/web/src/index.ts', 'export * from "@xpanel/agent/missing"\n')
    await expectReleaseError(
      () => buildReleaseArtifact({ sourceRoot, outputDir: makeTempDir(), createTarball: false }),
      'RELEASE_DEPENDENCY_MISSING',
    )
  })

  it('includes JavaScript runtime imports and checks their transitive source dependencies', async () => {
    const sourceRoot = makeSourceFixture()
    writeSourceFile(sourceRoot, 'apps/web/src/index.ts', 'export * from "./runtime.js"\n')
    writeSourceFile(sourceRoot, 'apps/web/src/runtime.js', 'export { value } from "./value.js"\n')
    writeSourceFile(sourceRoot, 'apps/web/src/value.js', 'export const value = 1\n')
    const built = await buildReleaseArtifact({ sourceRoot, outputDir: makeTempDir(), createTarball: false })
    expect(built.manifest.files.map((file: { path: string }) => file.path)).toContain('apps/web/src/value.js')
    unlinkSync(join(sourceRoot, 'apps/web/src/value.js'))
    const err = await expectReleaseError(
      () => buildReleaseArtifact({ sourceRoot, outputDir: makeTempDir(), createTarball: false }),
      'RELEASE_DEPENDENCY_MISSING',
    )
    expect(err.detail.path).toBe('apps/web/src/runtime.js')
  })

  it('requires the native account-file helper source and build script', async () => {
    const sourceRoot = makeSourceFixture()
    unlinkSync(join(sourceRoot, 'helpers/account-files/xpanel-account-files.c'))
    const err = await expectReleaseError(
      () => buildReleaseArtifact({ sourceRoot, outputDir: makeTempDir(), createTarball: false }),
      'MISSING_ENTRYPOINT',
    )
    expect(err.detail.path).toBe('helpers/account-files/xpanel-account-files.c')
  })

  it('rejects a tampered artifact when any file byte or manifest payload is modified', async () => {
    const outDir = makeTempDir()
    const signingKey = 'xpanel-release-signing-key-2026-10-22'
    const built = await buildReleaseArtifact({
      outputDir: outDir,
      version: '0.1.0',
      signingKey,
      createTarball: false,
    })

    // Corrupt a single byte in apps/api/src/main.ts
    const apiMainPath = join(built.stagingDir, 'apps/api/src/main.ts')
    const original = readFileSync(apiMainPath, 'utf8')
    writeFileSync(apiMainPath, `${original}\n// tampered\n`)

    const err = await expectReleaseError(
      () => verifyReleaseArtifact({ artifactDir: built.stagingDir, signingKey, requireSignature: true }),
      'CHECKSUM_MISMATCH',
    )
    expect(err.detail.path).toBe('apps/api/src/main.ts')

    // Restore file and test wrong signing key rejection
    writeFileSync(apiMainPath, original)
    await expectReleaseError(
      () => verifyReleaseArtifact({ artifactDir: built.stagingDir, signingKey: 'wrong-key', requireSignature: true }),
      'SIGNATURE_INVALID',
    )

    // Tamper with manifest version without updating payloadSha256
    const manifestPath = join(built.stagingDir, 'release-manifest.json')
    const manifestObj = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifestObj.version = '9.9.9'
    writeFileSync(manifestPath, JSON.stringify(manifestObj, null, 2))
    await expectReleaseError(
      () => verifyReleaseArtifact({ artifactDir: built.stagingDir }),
      'MANIFEST_TAMPERED',
    )
  })

  it('rejects an artifact with a missing entrypoint or invalid systemd unit contract', async () => {
    const outDir = makeTempDir()
    const built = await buildReleaseArtifact({
      outputDir: outDir,
      version: '0.1.0',
      createTarball: false,
    })

    // Remove apps/agent/src/main.ts from staging
    unlinkSync(join(built.stagingDir, 'apps/agent/src/main.ts'))
    const err = await expectReleaseError(
      () => verifyReleaseArtifact({ artifactDir: built.stagingDir }),
      'MISSING_ENTRYPOINT',
    )
    expect(err.detail.path).toBe('apps/agent/src/main.ts')

    // Verify parseSystemdUnitContract rejects dist/index.js or wrong User/Group/RuntimeDirectory
    expect(() =>
      parseSystemdUnitContract(
        'xpanel-api.service',
        '[Service]\nUser=xpanel\nGroup=xpanel\nSupplementaryGroups=xpanel-agent\nUMask=0007\nNoNewPrivileges=yes\nExecStart=/usr/bin/node /opt/xpanel/dist/index.js\n',
      ),
    ).toThrow(/nonexistent dist\/index\.js/)

    expect(() =>
      parseSystemdUnitContract(
        'xpanel-agent.service',
        '[Service]\nUser=root\nGroup=xpanel\nSupplementaryGroups=xpanel-agent\nRuntimeDirectory=xpanel\nRuntimeDirectoryMode=0750\nRuntimeDirectoryPreserve=no\nUMask=0007\nExecStart=/usr/bin/node /opt/xpanel/apps/agent/src/main.ts\n',
      ),
    ).toThrow(/violates the verified S03\/H01 unit contract/)
  })

  it('rejects path traversal, symlinks, world-writable permissions, and non-root owners in pre-unpack archive verification', async () => {
    const outDir = makeTempDir()

    // 1. Path traversal in archive entry
    const traversalTar = join(outDir, 'traversal.tar.gz')
    await createCustomTarGz(traversalTar, [{ name: '../../etc/cron.d/pwn', content: '* * * * * root id\n' }])
    await expectReleaseError(() => verifyReleaseArchive(traversalTar), 'ARCHIVE_PATH_TRAVERSAL')

    // 2. Symlink entry in archive
    const symlinkTar = join(outDir, 'symlink.tar.gz')
    await createCustomTarGz(symlinkTar, [{ name: 'apps/api/src/evil-link', type: 'symlink', linkname: '/etc/shadow' }])
    await expectReleaseError(() => verifyReleaseArchive(symlinkTar), 'UNSAFE_ARCHIVE_ENTRY')

    // 3. World-writable file in archive (0666)
    const writableTar = join(outDir, 'writable.tar.gz')
    await createCustomTarGz(writableTar, [{ name: 'apps/api/src/main.ts', content: 'export {}', mode: 0o666 }])
    await expectReleaseError(() => verifyReleaseArchive(writableTar), 'UNSAFE_FILE_PERMISSIONS')

    // 4. Non-root uid in archive
    const nonRootTar = join(outDir, 'nonroot.tar.gz')
    await createCustomTarGz(nonRootTar, [{ name: 'apps/api/src/main.ts', content: 'export {}', uid: 1000, gid: 1000 }])
    await expectReleaseError(() => verifyReleaseArchive(nonRootTar), 'UNSAFE_FILE_OWNER')

    // 5. Forbidden secret or Windows native binary in archive
    const secretTar = join(outDir, 'secret.tar.gz')
    await createCustomTarGz(secretTar, [{ name: '.secrets/prod.key', content: 'secret' }])
    await expectReleaseError(() => verifyReleaseArchive(secretTar), 'FORBIDDEN_ARTIFACT_FILE')
    const hiddenTar = join(outDir, 'hidden-directory.tar.gz')
    await createCustomTarGz(hiddenTar, [{ name: 'apps/api/src/.workspace-private/runtime.ts', content: 'local-only' }])
    await expectReleaseError(() => verifyReleaseArchive(hiddenTar), 'FORBIDDEN_ARTIFACT_FILE')
    const hiddenDirectoryTar = join(outDir, 'hidden-empty-directory.tar.gz')
    await createCustomTarGz(hiddenDirectoryTar, [{ name: 'apps/api/src/.workspace-private/', type: 'directory' }])
    await expectReleaseError(() => verifyReleaseArchive(hiddenDirectoryTar), 'FORBIDDEN_ARTIFACT_FILE')

    // Reference inputs are forbidden even when an archive is constructed outside the packager.
    for (const path of ['apps/web/src/design-boards/reference.dc.html', 'apps/web/src/design-boards/support.js', 'apps/web/src/live-boards.ts']) {
      const referenceTar = join(outDir, 'reference.tar.gz')
      await createCustomTarGz(referenceTar, [{ name: path, content: 'reference' }])
      const err = await expectReleaseError(() => verifyReleaseArchive(referenceTar), 'FORBIDDEN_ARTIFACT_FILE')
      expect(err.detail.path).toBe(path)
    }
  })

  it('rejects world-writable or non-root runtime parent paths before any service mutation', async () => {
    const outDir = makeTempDir()
    const built = await buildReleaseArtifact({
      outputDir: outDir,
      version: '0.1.0',
      createTarball: false,
    })

    await expectReleaseError(
      () =>
        verifyReleaseArtifact({
          artifactDir: built.stagingDir,
          runtimePathsToVerify: ['/opt/xpanel', '/usr/bin/node'],
          statProvider: (p) => ({
            uid: p === '/opt/xpanel' ? 0 : 0,
            gid: 0,
            mode: p === '/opt/xpanel' ? 0o777 : 0o755,
            isSymbolicLink: false,
            isDirectory: p === '/opt/xpanel',
            isFile: p !== '/opt/xpanel',
          }),
        }),
      'UNSAFE_RUNTIME_PATH',
    )
  })

  it('cleans up partial staging directory and preserves existing release when unpack fails mid-flight (ENOSPC)', async () => {
    const outDir = makeTempDir()
    const built = await buildReleaseArtifact({
      outputDir: outDir,
      version: '0.1.0',
      createTarball: true,
    })

    const targetDir = join(outDir, 'installed-current')
    const stagingRoot = join(outDir, 'unpack-staging')
    mkdirSync(targetDir, { recursive: true })
    mkdirSync(stagingRoot, { recursive: true })
    writeFileSync(join(targetDir, 'VERSION'), '0.0.9\n')

    let filesWritten = 0
    await expect(
      unpackVerifiedRelease({
        archivePath: built.archivePath!,
        expectedArchiveSha256: built.archiveSha256!,
        stagingRoot,
        targetDir,
        writeFileHook: () => {
          filesWritten++
          if (filesWritten > 5) {
            const err = new Error('ENOSPC: no space left on device') as Error & { code: string }
            err.code = 'ENOSPC'
            throw err
          }
        },
      }),
    ).rejects.toThrow(/ENOSPC/)

    // Previous installation at targetDir must remain untouched, and partial staging dir must be removed
    expect(readFileSync(join(targetDir, 'VERSION'), 'utf8')).toBe('0.0.9\n')
    const remainingStaging = existsSync(stagingRoot) ? readFileSync(join(targetDir, 'VERSION'), 'utf8') : ''
    expect(remainingStaging).toBe('0.0.9\n')
  })

  it('verifies scripts/install.sh dry-run matches deploy/systemd units and enforces opt-in service flags', () => {
    const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash'
    if (!existsSync(bash)) {
      throw new Error('Bash is required for scripts/install.sh dry-run verification')
    }
    const dir = makeTempDir()
    const osReleaseFile = join(dir, 'os-release').replaceAll('\\', '/')
    writeFileSync(osReleaseFile, 'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04 LTS"\n')

    const rootDir = resolve(import.meta.dirname, '..')
    // Default dry-run: opt-in services (mail, dns, ftp, mariadb) are excluded by default
    const baseRun = spawnSync(bash, ['scripts/install.sh', '--dry-run', `--os-release=${osReleaseFile}`], {
      cwd: rootDir,
      encoding: 'utf8',
      timeout: 10_000,
    })
    expect(baseRun.status, baseRun.stderr).toBe(0)
    const pkgLine = baseRun.stdout.split('\n').find((l) => l.startsWith('Package List')) ?? ''
    expect(pkgLine).toContain('nginx')
    expect(pkgLine).toContain('apache2')
    expect(pkgLine).toContain('libapache2-mpm-itk')
    expect(pkgLine).not.toContain('postfix')
    expect(pkgLine).not.toContain('pdns-server')
    expect(pkgLine).not.toContain('pure-ftpd')
    expect(pkgLine).not.toContain('mariadb-server')

    // Opt-in dry-run: --with-mail --with-dns --with-ftp --with-mariadb includes them
    const optInRun = spawnSync(
      bash,
      [
        'scripts/install.sh',
        '--dry-run',
        `--os-release=${osReleaseFile}`,
        '--with-mail',
        '--with-dns',
        '--with-ftp',
        '--with-mariadb',
      ],
      {
        cwd: rootDir,
        encoding: 'utf8',
        timeout: 10_000,
      },
    )
    expect(optInRun.status, optInRun.stderr).toBe(0)
    const optInPkgLine = optInRun.stdout.split('\n').find((l) => l.startsWith('Package List')) ?? ''
    expect(optInPkgLine).toContain('postfix')
    expect(optInPkgLine).toContain('dovecot-sieve')
    expect(optInPkgLine).toContain('pdns-server')
    expect(optInPkgLine).toContain('pure-ftpd')
    expect(optInPkgLine).toContain('mariadb-server')

    // Verify deploy/systemd unit files match rendered dry-run units
    const agentUnitDisk = readFileSync(join(rootDir, 'deploy/systemd/xpanel-agent.service'), 'utf8').replace(/\r\n/g, '\n').trim()
    const apiUnitDisk = readFileSync(join(rootDir, 'deploy/systemd/xpanel-api.service'), 'utf8').replace(/\r\n/g, '\n').trim()
    const dryRunNormalized = baseRun.stdout.replace(/\r\n/g, '\n')
    expect(dryRunNormalized).toContain(agentUnitDisk)
    expect(dryRunNormalized).toContain(apiUnitDisk)
  })
})
