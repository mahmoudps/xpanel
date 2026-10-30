import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  DEV_ONLY_PACKAGES,
  DESIGN_REFERENCE_INPUTS,
  REQUIRED_RELEASE_ENTRYPOINTS,
  REQUIRED_ROOT_FILES,
  REQUIRED_SYSTEMD_UNITS,
  ReleaseArtifactError,
  buildReleaseArtifact,
  collectProductionSbom,
  createTarGzBuffer,
  scanReleasePrivacy,
  parseTarGzBuffer,
  parseSystemdUnitContract,
  unpackVerifiedRelease,
  unpackAuthenticatedRelease,
  verifyReleaseArchive,
  verifyReleaseArtifact,
} from './package-release.mjs'
import { createPublisherManifest } from './release-publisher.mjs'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { parseSignedReleaseManifest, verifySignedManifestForRelease } from '../apps/agent/src/lifecycle/upgrade-runner.ts'
import { ALMA_9, CENTOS_STREAM_9, ROCKY_9, UBUNTU_2204, UBUNTU_2404 } from '../packages/os/src/fixtures.ts'

const tempDirs: string[] = []
const suiteTempDirs: string[] = []

const makeTempDir = (prefix = 'xpanel-release-test-', lifetime: 'test' | 'suite' = 'test'): string => {
  const root = resolve(tmpdir())
  const dir = mkdtempSync(join(root, prefix))
  ;(lifetime === 'suite' ? suiteTempDirs : tempDirs).push(dir)
  return dir
}

const removeTempDirs = (dirs: string[]): void => {
  const root = resolve(tmpdir())
  while (dirs.length > 0) {
    const dir = dirs.pop()!
    const target = resolve(dir)
    if (dirname(target) === root && basename(target).startsWith('xpanel-release-test-')) {
      rmSync(target, { recursive: true, force: true })
    }
  }
}

afterEach(() => removeTempDirs(tempDirs))
afterAll(() => removeTempDirs(suiteTempDirs))

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

const makeSourceFixture = (root = makeTempDir()): string => {
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

const fixtureSigningKey = 'xpanel-release-signing-key-2026-10-22'
type BuiltRelease = Awaited<ReturnType<typeof buildReleaseArtifact>>
let signedReleaseFixture: BuiltRelease | undefined

const cloneSignedReleaseFixture = (): BuiltRelease => {
  if (!signedReleaseFixture?.archivePath) throw new Error('Signed release fixture is not ready')
  const outputDir = makeTempDir()
  const stagingDir = join(outputDir, 'staging')
  const archivePath = join(outputDir, basename(signedReleaseFixture.archivePath))
  cpSync(signedReleaseFixture.stagingDir, stagingDir, { recursive: true, force: false, errorOnExist: true })
  copyFileSync(signedReleaseFixture.archivePath, archivePath)
  return { ...signedReleaseFixture, stagingDir, archivePath }
}

describe('H01 release artifact packager & pre-unpack verifier (A26, A28, A59)', () => {
  beforeAll(async () => {
    const sourceRoot = makeSourceFixture(makeTempDir('xpanel-release-test-source-', 'suite'))
    signedReleaseFixture = await buildReleaseArtifact({
      sourceRoot,
      outputDir: makeTempDir('xpanel-release-test-built-', 'suite'),
      version: '0.1.0',
      signingKey: fixtureSigningKey,
      keyId: 'release-key-1',
    })
  })

  it('binds the publisher sidecar to a real small HMAC-authenticated archive and records source uncertainty', async () => {
    const fixture = signedReleaseFixture!
    const verified = await verifyReleaseArchive(fixture.archivePath!, { expectedArchiveSha256: fixture.archiveSha256!, signingKey: fixtureSigningKey, requireSignature: true })
    const source = JSON.parse(readFileSync(join(fixture.stagingDir, 'source-provenance.json'), 'utf8'))
    expect(source).toMatchObject({ schemaVersion: 1, fingerprintAlgorithm: 'sha256-release-inputs-v1', commit: null, verificationSource: null })
    expect(source.inputFingerprint).toMatch(/^[a-f0-9]{64}$/)
    const release = { version: fixture.version, schemaVersion: fixture.schemaVersion, sha256: verified.archiveSha256, bytes: verified.manifest.totalUnpackedBytes }
    const pair = generateKeyPairSync('ed25519')
    const signed = createPublisherManifest(release, { keyId: 'small-fixture', privateKey: pair.privateKey })
    const trust = [{ keyId: 'small-fixture', kind: 'ed25519-pem' as const, publicKeyOrSecret: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }]
    expect(() => verifySignedManifestForRelease(parseSignedReleaseManifest(signed), release, trust)).not.toThrow()
    expect(() => verifySignedManifestForRelease(signed, { ...release, sha256: '0'.repeat(64) }, trust)).toThrow()
    expect(() => verifySignedManifestForRelease(signed, { ...release, bytes: fixture.archiveBytes }, trust)).toThrow()
    expect(fixture.publisherManifest).toBeNull()
    expect(fixture.artifactProvenance).toBeNull()
  })

  it('derives SBOM workspace metadata from the captured archive inputs instead of rereading changed source', () => {
    const root = makeTempDir()
    const captured = new Map([['apps/api/package.json', { bytes: Buffer.from(JSON.stringify({ name: '@xpanel/api', version: '0.1.0', dependencies: {} })) }]])
    writeSourceFile(root, 'apps/api/package.json', JSON.stringify({ name: '@xpanel/api', version: '9.9.9', dependencies: { vitest: '5.0.5' } }))
    const sbom = collectProductionSbom(root, '0.1.0', '26.12.1', 'pnpm@12.15.0', 'a'.repeat(64), captured)
    expect(sbom.workspacePackages).toEqual([{ name: '@xpanel/api', version: '0.1.0', path: 'apps/api', private: false, dependencies: [] }])
  })

  it('rejects publisher builds with native-incompatible archive trust before creating output', async () => {
    const sourceRoot = makeSourceFixture()
    const pair = generateKeyPairSync('ed25519')
    for (const trust of [{ signingKey: 'a'.repeat(31), keyId: 'valid' }, { signingKey: 'a'.repeat(4097), keyId: 'valid' }, { signingKey: 'a'.repeat(32), keyId: 'a'.repeat(65) }, { signingKey: 'a'.repeat(32), keyId: 'bad/id' }]) {
      const outputDir = makeTempDir()
      await expectReleaseError(() => buildReleaseArtifact({ sourceRoot, outputDir, ...trust, publisher: { keyId: 'publisher-test', privateKey: pair.privateKey } }), 'PUBLISHER_TRUST_REQUIRED')
      expect(readdirSync(outputDir)).toEqual([])
    }
  })

  it('builds a deterministic, signed release bundle with verified entrypoints, systemd units, migrations, and SBOM', { tags: ['slow'] }, async () => {
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
    const signingKey = fixtureSigningKey
    const built = cloneSignedReleaseFixture()

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
    const built = cloneSignedReleaseFixture()

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

  it('accepts only the flat or current program entrypoints while preserving unit security metadata', () => {
    const workspace = resolve(import.meta.dirname, '..')
    for (const role of ['api', 'agent']) {
      const name = `xpanel-${role}.service`
      const flat = readFileSync(join(workspace, 'deploy/systemd', name), 'utf8')
      const current = flat.replaceAll('/opt/xpanel/apps/', '/opt/xpanel/current/apps/')
      expect(parseSystemdUnitContract(name, flat).execStart).toContain(`/opt/xpanel/apps/${role}/src/main.ts`)
      expect(parseSystemdUnitContract(name, current).execStart).toContain(`/opt/xpanel/current/apps/${role}/src/main.ts`)
      expect(() => parseSystemdUnitContract(name, flat.replaceAll('/opt/xpanel/apps/', '/tmp/opt/xpanel/apps/'))).toThrow()
    }
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
    const built = cloneSignedReleaseFixture()

    for (const unsafe of [{ uid: 0, mode: 0o777 }, { uid: 1000, mode: 0o755 }]) {
      await expectReleaseError(
        () =>
          verifyReleaseArtifact({
            artifactDir: built.stagingDir,
            runtimePathsToVerify: ['/opt/xpanel', '/usr/bin/node'],
            statProvider: (p) => ({
              uid: p === '/opt/xpanel' ? unsafe.uid : 0,
              gid: 0,
              mode: p === '/opt/xpanel' ? unsafe.mode : 0o755,
              isSymbolicLink: false,
              isDirectory: p === '/opt/xpanel',
              isFile: p !== '/opt/xpanel',
            }),
          }),
        'UNSAFE_RUNTIME_PATH',
      )
    }
  })

  it('cleans up partial staging directory and preserves existing release when unpack fails mid-flight (ENOSPC)', async () => {
    const built = cloneSignedReleaseFixture()
    const outDir = dirname(built.stagingDir)

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
        signingKey: fixtureSigningKey,
        requireSignature: true,
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
    expect(filesWritten).toBe(6)
    expect(readdirSync(stagingRoot)).toEqual([])
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
    expect(optInPkgLine).toContain('pdns-backend-bind')
    expect(optInPkgLine).toContain('bind9-utils')
    expect(optInPkgLine).toContain('dnsutils')
    expect(optInPkgLine).not.toContain('pdns-backend-pgsql')
    expect(optInRun.stdout).toContain('Existing daemon backend and zones are preserved')
    expect(optInPkgLine).toContain('pure-ftpd')
    expect(optInPkgLine).toContain('mariadb-server')

    // Verify deploy/systemd unit files match rendered dry-run units
    const agentUnitDisk = readFileSync(join(rootDir, 'deploy/systemd/xpanel-agent.service'), 'utf8').replace(/\r\n/g, '\n').trim()
    const apiUnitDisk = readFileSync(join(rootDir, 'deploy/systemd/xpanel-api.service'), 'utf8').replace(/\r\n/g, '\n').trim()
    const dryRunNormalized = baseRun.stdout.replace(/\r\n/g, '\n')
    expect(dryRunNormalized).toContain(agentUnitDisk)
    expect(dryRunNormalized).toContain(apiUnitDisk)
  })

  it.each([
    ['ubuntu-22.04', UBUNTU_2204], ['ubuntu-24.04', UBUNTU_2404], ['almalinux-9', ALMA_9],
    ['rocky-9', ROCKY_9], ['centos-stream-9', CENTOS_STREAM_9],
  ])('plans explicit authenticated current layout for %s without reading credentials or running native effects', (_profile, osRelease) => {
    const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash'
    const directory = makeTempDir(), file = join(directory, 'os-release').replaceAll('\\', '/')
    writeFileSync(file, osRelease)
    const args = ['scripts/install.sh', '--dry-run', `--os-release=${file}`, '--new-install',
      '--artifact=/root/protected/release.tar.gz', `--artifact-sha256=${'a'.repeat(64)}`,
      '--release-trust-file=/root/protected/trust.json', '--release-keys-file=/root/protected/publishers.json']
    // Git Bash must pass these Linux-only grammar inputs unchanged to native Windows Node.
    // Keep conversion enabled for the real script path; production path validation stays strict.
    const result = spawnSync(bash, args, { cwd: resolve(import.meta.dirname, '..'), env: { ...process.env,
      ...(process.platform === 'win32' ? { MSYS2_ARG_CONV_EXCL: '--artifact=;--release-trust-file=;--release-keys-file=' } : {}),
      XPANEL_NODE_BIN: process.execPath.replaceAll('\\', '/') }, encoding: 'utf8', timeout: 10_000 })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('source/dependency proof pending real execution')
    expect(result.stdout).toContain('WorkingDirectory=/opt/xpanel/current')
    expect(result.stdout).toContain('/opt/xpanel/current/apps/agent/src/main.ts')
    expect(result.stdout).toContain('/opt/xpanel/current/apps/api/src/main.ts')
    expect(result.stdout).toContain('ExecStartPre=/usr/bin/install -d -o xpanel -g xpanel -m 0700 /run/xpanel/lifecycle-api')
    expect(result.stdout).toContain('ReadWritePaths=/var/lib/xpanel /var/log/xpanel /run/xpanel/lifecycle-api')
    expect(result.stdout).toContain('no host files mutated')
  })

  it.each(['debian', 'rhel'])('checks fresh %s package config metadata and preserves modified vendor bytes (diagnostic model)', family => {
    const root = resolve(import.meta.dirname, '..'), directory = makeTempDir()
    const config = join(directory, 'pdns.conf').replaceAll('\\', '/')
    const vendor = '# Diagnostic vendor PowerDNS configuration\nlaunch=bind\n'
    writeFileSync(config, vendor)
    const source = readFileSync(join(root, 'scripts/install.sh'), 'utf8')
    const declaration = /^verify_fresh_pdns_vendor\(\) \{[\s\S]*?^\}/m.exec(source)?.[0]
    expect(declaration).toBeDefined()
    const script = `set -euo pipefail
die() { printf '%s' "$*" >&2; exit 3; }
assert_root_file() { [[ -f "$1" && ! -L "$1" ]]; }
record_install_phase() { printf '%s' "$3"; }
dpkg-query() { if [[ "$1" == -S ]]; then printf 'pdns-server: %s\\n' "$VENDOR_CONFIG"; else printf ' %s %s\\n' "$VENDOR_CONFIG" "$EXPECTED_DIGEST"; fi; }
rpm() { case "$*" in *FILEDIGESTALGO*) printf 8;; *FILENAMES*) printf '%s %s\\n' "$VENDOR_CONFIG" "$EXPECTED_DIGEST";; *) printf pdns;; esac; }
${declaration}
verify_fresh_pdns_vendor "$VENDOR_CONFIG"
`
    const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash'
    const env = { ...process.env, OS_FAMILY: family, VENDOR_CONFIG: config, EXPECTED_DIGEST: createHash(family === 'debian' ? 'md5' : 'sha256').update(vendor).digest('hex') }
    const run = () => spawnSync(bash, ['-s'], { input: script, env, encoding: 'utf8', timeout: 10_000 })
    const accepted = run()
    expect(accepted.status, accepted.stderr).toBe(0)
    expect(accepted.stdout).toBe(createHash('sha256').update(vendor).digest('hex'))
    const operatorBytes = vendor + 'operator-setting=preserve\n'
    writeFileSync(config, operatorBytes)
    const refused = run()
    expect(refused.status).toBe(3)
    expect(refused.stderr).toContain('differs from package metadata; preserved')
    expect(readFileSync(config, 'utf8')).toBe(operatorBytes)
  })
})

describe('release privacy scan', () => {
  it('accepts the skill, the design-doc test, the data-token attribute, and the fidelity script from the repo config', () => {
    const sourceRoot = makeSourceFixture()
    const workspace = resolve(import.meta.dirname, '..')
    writeSourceFile(sourceRoot, 'scripts/release-privacy.json', readFileSync(join(workspace, 'scripts/release-privacy.json')))
    writeSourceFile(sourceRoot, '.cursor/skills/design-board-pixel-port/SKILL.md', '# skill\n')
    writeSourceFile(sourceRoot, 'apps/web/src/design-board.test.ts', 'expect(page).toContain(\'data-token="accent"\')\n')
    writeSourceFile(sourceRoot, 'scripts/board-fidelity.mjs', 'export {}\n')
    expect(scanReleasePrivacy(sourceRoot).violations).toEqual([])
  })

  it('rejects those names when the repo config does not accept them', async () => {
    const sourceRoot = makeSourceFixture()
    writeSourceFile(sourceRoot, '.cursor/skills/design-board-pixel-port/SKILL.md', '# skill\n')
    writeSourceFile(sourceRoot, 'apps/web/src/design-board.test.ts', 'expect(page).toContain(\'data-token="accent"\')\n')
    writeSourceFile(sourceRoot, 'scripts/board-fidelity.mjs', 'export {}\n')
    const blocked = await expectReleaseError(
      () => buildReleaseArtifact({ sourceRoot, outputDir: makeTempDir(), version: '0.1.0', createTarball: false }),
      'PRIVACY_SCAN',
    )
    const markers = new Set((blocked.detail.violations as { marker: string }[]).map(item => item.marker))
    expect(markers).toEqual(new Set(['SKILL.md', 'design-board.test.ts', 'data-token', 'board-fidelity.mjs']))

    writeSourceFile(sourceRoot, 'scripts/release-privacy.json', `${JSON.stringify({
      schema: 1,
      accept: ['SKILL.md', 'design-board.test.ts', 'data-token', 'board-fidelity.mjs'],
    })}\n`)
    expect(scanReleasePrivacy(sourceRoot).violations).toEqual([])
  })
})

describe('authenticated source staging diagnostics (no native-root qualification)', () => {
  afterEach(() => { vi.doUnmock('node:fs'); vi.doUnmock('./release-verifier.mjs'); vi.resetModules() })

  it('retains license/community files, the builtin verifier, and explicit lifecycle bridge source closure', async () => {
    const sourceRoot = makeSourceFixture()
    writeSourceFile(sourceRoot, 'scripts/lifecycle-root-safety.mjs', 'export const diagnosticBridge = true\n')
    writeSourceFile(sourceRoot, 'scripts/lifecycle-root-safety.d.mts', 'export declare const diagnosticBridge: boolean\n')
    writeSourceFile(sourceRoot, 'bin/xpanel-ctl', '#!/usr/bin/env bash\nexit 0\n')
    writeSourceFile(sourceRoot, 'apps/api/src/main.ts', 'import "../../../scripts/lifecycle-root-safety.mjs"\n')
    const built = await buildReleaseArtifact({ sourceRoot, outputDir: makeTempDir(), createTarball: false })
    const paths = new Set(built.manifest.files.map((file: { path: string }) => file.path))
    for (const path of ['LICENSE', 'README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'CLA.md', 'scripts/management-tls.mjs', 'scripts/release-verifier.mjs', 'scripts/release-verifier.d.mts', 'scripts/lifecycle-root-safety.mjs', 'scripts/lifecycle-root-safety.d.mts']) expect(paths.has(path)).toBe(true)
    expect(readFileSync(join(built.stagingDir, 'LICENSE'), 'utf8')).toBe(readFileSync(join(sourceRoot, 'LICENSE'), 'utf8'))
    expect(built.sbom.excludedDevPackages).toContain('es-module-lexer')
    expect(built.manifest.files.find((file: { path: string }) => file.path === 'bin/xpanel-ctl')?.mode).toBe(0o755)
    expect(paths.has('scripts/package-release.mjs')).toBe(false)
  })

  it('refuses caller-supplied authority and retains the actual Linux/root boundary', async () => {
    const trust = { archivePath: '/missing-release', expectedArchiveSha256: 'a'.repeat(64), signingKey: 'synthetic-staging-trust-key-at-least-32-bytes', keyId: 'diagnostic', stagingRoot: makeTempDir() }
    for (const field of ['statProvider', 'writeFileHook', 'authenticatedArchive', 'validateStage']) {
      await expect(unpackAuthenticatedRelease({ ...trust, [field]: () => true })).rejects.toMatchObject({ code: 'AUTHENTICATED_OPTIONS' })
    }
    if (process.platform !== 'linux' || process.geteuid?.() !== 0) {
      await expect(unpackAuthenticatedRelease(trust)).rejects.toMatchObject({ code: 'LINUX_ROOT_REQUIRED' })
      expect(readdirSync(trust.stagingRoot)).toEqual([])
    }
  })

  it('caps the extraction parser independently of the gzip input size', () => {
    const bytes = createTarGzBuffer([{ name: 'bounded.txt', content: Buffer.alloc(65536) }])
    expect(() => parseTarGzBuffer(bytes, 1024)).toThrow()
    expect(() => parseTarGzBuffer(bytes, 512 * 1024 * 1024 + 1)).toThrow()
  })

  it('delegates staging to the single runtime extractor inside the retained authenticated lifetime', async () => {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
    const strict = await vi.importActual<any>('./release-verifier.mjs')
    const root = makeSourceFixture(), output = makeTempDir(), stagingRoot = makeTempDir()
    const signingKey = 'synthetic-staging-trust-key-at-least-32-bytes', keyId = 'diagnostic-staging'
    const built = await buildReleaseArtifact({ sourceRoot: root, outputDir: output, signingKey, keyId })
    let held = false, delegated = false, liveReport: any
    vi.doMock('./release-verifier.mjs', () => ({
      ...strict,
      withAuthenticatedReleaseArchive: async (path: string, trust: unknown, use: (input: unknown) => Promise<unknown>) => {
        const report = await strict.verifyAuthenticatedReleaseArchive(path, trust), fd = fs.openSync(path, 'r')
        liveReport = report; held = true
        try { return { report, value: await use({ report, fd }) } } finally { fs.closeSync(fd); held = false }
      },
      stageAuthenticatedReleaseArchive: async (path: string, trust: any) => {
        expect(path).toBe(stagingRoot); expect(held).toBe(true)
        expect(trust.authenticatedArchive).toBe(liveReport)
        expect(trust.signingKey).toBe(signingKey); expect(trust.keyId).toBe(keyId)
        expect(Object.keys(trust).sort()).toEqual(['authenticatedArchive', 'keyId', 'signingKey'])
        delegated = true
        return { ok: true, activated: false, installReady: false, runtimeDependenciesVerified: false }
      },
    }))
    vi.resetModules()
    const module = await import('./package-release.mjs')
    const result = await module.unpackAuthenticatedRelease({ archivePath: built.archivePath!, expectedArchiveSha256: built.archiveSha256!, signingKey, keyId, stagingRoot })
    expect(delegated).toBe(true); expect(held).toBe(false)
    expect(result).toMatchObject({ ok: true, activated: false, installReady: false, runtimeDependenciesVerified: false })
  })

})
