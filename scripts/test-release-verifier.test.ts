import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { Readable } from 'node:stream'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildReleaseArtifact, createTarGzBuffer, parseTarGzBuffer, REQUIRED_ROOT_FILES, REQUIRED_RELEASE_ENTRYPOINTS, REQUIRED_SYSTEMD_UNITS } from './package-release.mjs'
import { RELEASE_VERIFICATION_LIMITS, serializeManifestPayload, signManifestPayload, stageAuthenticatedReleaseArchive, verifyAuthenticatedReleaseArchive, verifyAuthenticatedReleaseTree, withAuthenticatedReleaseArchive } from './release-verifier.mjs'

const roots: string[] = []
const temp = (): string => { const path = mkdtempSync(join(tmpdir(), 'xpanel-runtime-verifier-')); roots.push(path); return path }
afterEach(() => { for (const root of roots.splice(0)) {
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('xpanel-runtime-verifier-')) throw new Error('Refusing unrelated fixture cleanup')
  rmSync(root, { recursive: true, force: true })
} })
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const key = 'diagnostic-release-key-not-a-production-credential'
const keyId = 'diagnostic-release-anchor'
const options = (bytes: Buffer) => ({ expectedArchiveSha256: sha(bytes), signingKey: key, keyId })
let original: Buffer
beforeAll(async () => {
  const sourceRoot = temp(), workspace = resolve(import.meta.dirname, '..')
  const write = (path: string, bytes: string | Buffer) => { mkdirSync(dirname(join(sourceRoot, path)), { recursive: true }); writeFileSync(join(sourceRoot, path), bytes) }
  for (const path of [...REQUIRED_ROOT_FILES, ...REQUIRED_SYSTEMD_UNITS]) write(path, readFileSync(join(workspace, path)))
  for (const path of REQUIRED_RELEASE_ENTRYPOINTS) write(path, 'export {}\n')
  for (const name of ['api', 'agent', 'web']) {
    write(`apps/${name}/package.json`, JSON.stringify({ name: `@xpanel/${name}`, type: 'module', exports: { '.': './src/index.ts' } }))
    write(`apps/${name}/src/index.ts`, 'export {}\n')
  }
  write('packages/db/src/migrations/0001_init.sql', 'CREATE TABLE verifier_diagnostic_fixture (id INTEGER);\n')
  const built = await buildReleaseArtifact({ sourceRoot, outputDir: temp(), signingKey: key, keyId })
  original = readFileSync(built.archivePath!)
})
// Actual fixture bytes live outside the source tree and are never installed/executed.
const archiveFile = (bytes: Buffer): string => { const path = join(temp(), 'release.tar.gz'); writeFileSync(path, bytes); return path }
const verify = (bytes = original, overrides = {}) => verifyAuthenticatedReleaseArchive(archiveFile(bytes), { ...options(bytes), ...overrides })
const rewrite = (change: (entries: any[]) => void): Buffer => {
  const entries = parseTarGzBuffer(original); change(entries); return createTarGzBuffer(entries)
}
const rewriteManifest = (change: (manifest: any) => void): Buffer => rewrite(entries => {
  const entry = entries.find(entry => entry.name === 'release-manifest.json')
  const manifest = JSON.parse(entry.content.toString('utf8')); change(manifest)
  const { payloadSha256: _payload, signature: _signature, ...core } = manifest
  const payload = JSON.stringify(core), digest = sha(Buffer.from(payload))
  entry.content = Buffer.from(JSON.stringify({ ...core, payloadSha256: digest, signature: { algorithm: 'hmac-sha256', keyId, payloadSha256: digest, mac: createHmac('sha256', key).update(payload).digest('hex') } }, null, 2) + '\n')
})

describe('strict authenticated runtime release verifier, diagnostic archives only', () => {
  it('authenticates existing packager bytes with a mandatory independent digest and shared HMAC representation', async () => {
    const report = await verify()
    expect(report.ok).toBe(true)
    expect(report.archiveBytes).toBe(original.length)
    expect(report.totalUnpackedBytes).toBe(report.manifest.files.reduce((sum: number, file: any) => sum + file.bytes, 0))
    expect(report.tarBytes).toBeGreaterThan(report.totalUnpackedBytes)
    expect(report.manifest.schemaVersion).toBe(1)
    expect(report.manifest.controlDbSchemaVersion).toBeGreaterThanOrEqual(1)
    expect(Object.isFrozen(report)).toBe(true); expect(Object.isFrozen(report.entries)).toBe(true)
    expect(report.entries.every((entry: any) => Object.isFrozen(entry) && !('content' in entry))).toBe(true)
    const core = { z: 1, a: { b: 2 } }, serialized = serializeManifestPayload(core)
    expect(serialized).toBe('{"z":1,"a":{"b":2}}')
    expect(signManifestPayload(serialized, key)).toBe(createHmac('sha256', key).update(serialized).digest('hex'))
    expect(report.sourceClosure).toEqual({ authenticatedBuilderDeclaration: true, runtimeImportsReparsed: false })
    expect(report.installReady).toBe(false); expect(report.runtimeDependenciesVerified).toBe(false)
  })

  it('rejects a corrupt tar header even when the actual compressed archive SHA and manifest HMAC match', async () => {
    const tar = gunzipSync(original)
    tar[148] = tar[148] === 48 ? 49 : 48
    await expect(verify(gzipSync(tar))).rejects.toMatchObject({ code: 'CORRUPT_ARCHIVE' })
  })

  it('rejects nonzero data after the tar end marker even when the compressed SHA and manifest HMAC match', async () => {
    const bytes = gzipSync(Buffer.concat([gunzipSync(original), Buffer.alloc(512, 65)]))
    await expect(verify(bytes)).rejects.toMatchObject({ code: 'CORRUPT_ARCHIVE' })
  })

  it.each(['expectedArchiveSha256', 'signingKey', 'keyId'])('refuses missing trusted %s before reading any archive', async field => {
    const opts: any = options(original); delete opts[field]
    await expect(verifyAuthenticatedReleaseArchive(join(temp(), 'does-not-exist'), opts)).rejects.toMatchObject({ code: 'TRUST_REQUIRED' })
  })
  it('does not accept an unsigned archive or another key/key ID/algorithm/payload', async () => {
    const unsigned = rewrite(entries => { const entry = entries.find(e => e.name === 'release-manifest.json'); const manifest = JSON.parse(entry.content); manifest.signature = null; entry.content = Buffer.from(JSON.stringify(manifest)) })
    await expect(verify(unsigned)).rejects.toMatchObject({ code: 'MANIFEST_INVALID' })
    await expect(verify(original, { signingKey: 'a-different-diagnostic-key-at-least-32-bytes' })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' })
    await expect(verify(original, { keyId: 'another-key' })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' })
    for (const [field, value] of [['algorithm', 'ed25519'], ['payloadSha256', '0'.repeat(64)], ['mac', 'AA'.repeat(32)]]) {
      const changed = rewrite(entries => { const e = entries.find(e => e.name === 'release-manifest.json'); const m = JSON.parse(e.content); m.signature[field] = value; e.content = Buffer.from(JSON.stringify(m)) })
      await expect(verify(changed)).rejects.toThrow()
    }
  })
  it('refuses a wrong external archive SHA before decompressing corrupt input', async () => {
    await expect(verify(Buffer.from('not gzip'), { expectedArchiveSha256: '0'.repeat(64) })).rejects.toMatchObject({ code: 'ARCHIVE_CHECKSUM_MISMATCH' })
  })
  it('rejects malformed gzip, truncated tar/header/body/end markers and nonzero padding', async () => {
    await expect(verify(Buffer.from('not gzip'))).rejects.toMatchObject({ code: 'CORRUPT_ARCHIVE' })
    const tar = gunzipSync(original)
    for (const cut of [17, 511, 520, tar.length - 513]) await expect(verify(gzipSync(tar.subarray(0, cut)))).rejects.toMatchObject({ code: 'CORRUPT_ARCHIVE' })
    const padding = Buffer.from(tar), size = Number.parseInt(padding.subarray(124, 136).toString().replace(/\0/g, ''), 8)
    if (size % 512) { padding[512 + size] = 1; await expect(verify(gzipSync(padding))).rejects.toMatchObject({ code: 'CORRUPT_ARCHIVE' }) }
  })
  it.each(['../escape', '/absolute', 'a//b', './VERSION', 'a/../b', 'C:/bad', 'a\\b', 'a\u0000b'])('refuses noncanonical member path %s', async path => {
    const bytes = rewrite(entries => { entries[0].name = path })
    await expect(verify(bytes)).rejects.toThrow()
  })
  it.each(['symlink', 'link', 'directory'])('refuses unsafe %s members and directory bodies', async type => {
    const bytes = rewrite(entries => { entries.push({ name: 'extra', type, linkname: type === 'directory' ? 'bad' : '/etc/passwd', content: Buffer.alloc(0), mode: 0o755 }) })
    await expect(verify(bytes)).rejects.toMatchObject({ code: 'UNSAFE_ENTRY' })
  })
  it.each([0o666, 0o4755, 0o2755, 0o1755, 0])('rejects unsafe mode %s', async mode => {
    await expect(verify(rewrite(entries => { entries[0].mode = mode }))).rejects.toMatchObject({ code: 'UNSAFE_MODE' })
  })
  it.each(['uid', 'gid'])('rejects non-root %s', async field => {
    await expect(verify(rewrite(entries => { entries[0][field] = 1000 }))).rejects.toMatchObject({ code: 'UNSAFE_OWNER' })
  })
  it('rejects duplicate paths, case aliases, implicit parent aliases and file/parent collisions', async () => {
    for (const extras of [
      [{ name: 'VERSION', content: Buffer.from('x') }],
      [{ name: 'version', content: Buffer.from('x') }],
      [{ name: 'Apps/other', content: Buffer.from('x') }],
      [{ name: 'VERSION/child', content: Buffer.from('x') }],
      [{ name: 'apps', content: Buffer.from('x') }],
    ]) await expect(verify(rewrite(entries => entries.push(...extras)))).rejects.toThrow()
  })
  it.each(['.secrets/password', '.env', 'cert.key', 'apps/web/src/live-boards.ts'])('rejects forbidden payload %s', async path => {
    await expect(verify(rewrite(entries => entries.push({ name: path, content: Buffer.from('x') })))).rejects.toMatchObject({ code: 'FORBIDDEN_FILE' })
  })
  it('refuses content, mode, missing-file and unexpected-file deviations from authenticated closure', async () => {
    for (const mutation of [
      (entries: any[]) => { entries[0].content = Buffer.from('modified') },
      (entries: any[]) => { entries[0].mode = entries[0].mode === 0o644 ? 0o755 : 0o644 },
      (entries: any[]) => { entries.splice(0, 1) },
      (entries: any[]) => { entries.push({ name: 'unlisted', content: Buffer.from('x') }) },
    ]) await expect(verify(rewrite(mutation))).rejects.toThrow()
  })
  it('rejects duplicate JSON keys even when JSON.parse would preserve signed values', async () => {
    const bytes = rewrite(entries => { const entry = entries.find(e => e.name === 'release-manifest.json'); entry.content = Buffer.from(entry.content.toString().replace('"schemaVersion": 1,', '"schemaVersion": 1, "schemaVersion": 1,')) })
    await expect(verify(bytes)).rejects.toMatchObject({ code: 'MANIFEST_INVALID' })
  })
  it('rejects signed but inconsistent manifest format/schema/files/units/runtime/source metadata', async () => {
    for (const mutation of [
      (m: any) => { m.schemaVersion = 2 },
      (m: any) => { m.controlDbSchemaVersion++ },
      (m: any) => { m.totalUnpackedBytes++ },
      (m: any) => { m.files.push({ ...m.files[0] }) },
      (m: any) => { m.files[0].mode = 0o755 },
      (m: any) => { m.runtime.nodeVersion = '99.1.2' },
      (m: any) => { m.sourcePolicy.sourceClosure.checkedSources++ },
      (m: any) => { m.systemdUnits[0].user = 'nobody' },
      (m: any) => { m.migrations[0].sha256 = '0'.repeat(64) },
      (m: any) => { m.webAssets.pop() },
      (m: any) => { m.lockfileSha256 = '0'.repeat(64) },
    ]) await expect(verify(rewriteManifest(mutation))).rejects.toThrow()
  })
  it('enforces compressed equality/overage before decompression and lower-only bounds', async () => {
    expect((await verify(original, { bounds: { compressedBytes: original.length } })).ok).toBe(true)
    await expect(verify(original, { bounds: { compressedBytes: original.length - 1 } })).rejects.toMatchObject({ code: 'LIMIT' })
    await expect(verify(original, { bounds: { compressedBytes: RELEASE_VERIFICATION_LIMITS.compressedBytes + 1 } })).rejects.toMatchObject({ code: 'OPTIONS' })
  })
  it('enforces tar, member, file, manifest and JSON-depth ceilings', async () => {
    for (const bounds of [{ tarBytes: 1024 }, { members: 1 }, { fileBytes: 1 }, { manifestBytes: 1 }, { jsonDepth: 1 }]) await expect(verify(original, { bounds })).rejects.toMatchObject({ code: 'LIMIT' })
    const bomb = gzipSync(Buffer.alloc(1024 * 1024))
    await expect(verify(bomb, { bounds: { tarBytes: 1024 } })).rejects.toMatchObject({ code: 'LIMIT' })
  })
  it('refuses copied archive reports and optional stat-provider ownership waivers', async () => {
    const report = await verify()
    await expect(verifyAuthenticatedReleaseTree('/opt/xpanel', { authenticatedArchive: { ...report }, signingKey: key, keyId })).rejects.toMatchObject({ code: 'TRUST_REQUIRED' })
    await expect(verifyAuthenticatedReleaseTree('/opt/xpanel', { authenticatedArchive: report, signingKey: key, keyId, statProvider: () => ({ uid: 0 }) })).rejects.toMatchObject({ code: 'OPTIONS' })
    if (process.platform !== 'linux' || process.geteuid?.() !== 0) await expect(verifyAuthenticatedReleaseTree('/opt/xpanel', { authenticatedArchive: report, signingKey: key, keyId })).rejects.toMatchObject({ code: 'LINUX_ROOT_REQUIRED' })
  })
  it('does not offer retained-FD extraction lifetime on non-Linux or non-root hosts', async () => {
    if (process.platform !== 'linux' || process.geteuid?.() !== 0) {
      let invoked = false
      await expect(withAuthenticatedReleaseArchive(archiveFile(original), options(original), () => { invoked = true })).rejects.toMatchObject({ code: 'LINUX_ROOT_REQUIRED' })
      expect(invoked).toBe(false)
    }
  })
  it('does not accept a copied report or caller FD as staging authority', async () => {
    const report = await verify()
    await expect(stageAuthenticatedReleaseArchive('/protected/staging', { authenticatedArchive: { ...report }, signingKey: key, keyId })).rejects.toMatchObject({ code: 'LIVE_ARCHIVE_REQUIRED' })
    await expect(stageAuthenticatedReleaseArchive('/protected/staging', { authenticatedArchive: report, signingKey: key, keyId, fd: 123 })).rejects.toMatchObject({ code: 'OPTIONS' })
    await expect(stageAuthenticatedReleaseArchive('/protected/staging', { authenticatedArchive: report, signingKey: key, keyId })).rejects.toMatchObject({ code: 'LIVE_ARCHIVE_REQUIRED' })
  })
})

// Scoped Linux-identity diagnostics. Archive bytes/streams are real temporary files; root/proc
// ownership and directory identities are mocked ONLY here. This is not native Linux proof.
describe('retained archive FD lifetime diagnostics with explicit filesystem identity fixtures', () => {
  afterEach(() => { vi.doUnmock('node:fs'); vi.doUnmock('node:fs/promises'); vi.doUnmock('node:process'); vi.doUnmock('node:path'); vi.resetModules() })
  const fixture = async () => {
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
    const pathModule = await vi.importActual<typeof import('node:path')>('node:path')
    let backing = archiveFile(original), nextFd = 10_000, openedFile: any, closed = false, fileCloses = 0, directoryMode = 0o755, treeEpoch = 0, changeTreeDuringRead = false, closeFailure = false, stagingWriteFailure = false
    const dirs = new Map<number, string>()
    const tree = new Map<string, any>()
    for (const entry of parseTarGzBuffer(original)) {
      const path = `/protected/tree/${entry.name}`
      tree.set(path, { content: Buffer.from(entry.content), mode: entry.mode, uid: 0n, nlink: 1n })
      const parts = path.split('/'); for (let i = 2; i < parts.length; i++) if (!tree.has(parts.slice(0, i).join('/'))) tree.set(parts.slice(0, i).join('/'), { directory: true })
    }
    const canonical = (path: string): string => {
      const match = new RegExp(`^/proc/${process.pid}/fd/([0-9]+)(?:/(.*))?$`).exec(path)
      return match ? match[2] ? `${dirs.get(Number(match[1])) === '/' ? '' : dirs.get(Number(match[1]))}/${match[2]}` : dirs.get(Number(match[1]))! : path
    }
    const directory = (path: string) => ({ uid: 0n, gid: 0n, mode: BigInt(0o40000 | (tree.get(path)?.mode ?? directoryMode)), dev: 1n, ino: BigInt(`0x${sha(Buffer.from(path)).slice(0, 12)}`) + (path === '/protected/tree' ? BigInt(treeEpoch) : 0n), nlink: 2n, size: 0n, mtimeNs: 1n, ctimeNs: 1n, isDirectory: () => true, isFile: () => false })
    const treeStat = (path: string) => {
      const node = tree.get(path)
      if (!node) throw Object.assign(new Error('diagnostic ENOENT'), { code: 'ENOENT' })
      return node.directory ? directory(path) : { ...directory(path), uid: node.uid, nlink: node.nlink, mode: BigInt((node.special ? 0o120000 : 0o100000) | node.mode), size: BigInt(node.content.length), isDirectory: () => false, isFile: () => !node.special }
    }
    const fileStat = (stat: any) => ({ ...stat, uid: 0n, gid: 0n, mode: 0o100644n, isDirectory: () => false, isFile: () => true })
    const stat = async (path: string) => canonical(path) === '/protected/release.tar.gz' ? fileStat(await real.lstat(backing, { bigint: true })) : tree.has(canonical(path)) || canonical(path).startsWith('/protected/tree') ? treeStat(canonical(path)) : directory(canonical(path))
    vi.resetModules()
    vi.doMock('node:process', () => ({ default: { platform: 'linux', geteuid: () => 0, pid: process.pid } }))
    vi.doMock('node:path', () => ({ dirname: pathModule.posix.dirname, join: pathModule.posix.join, isAbsolute: pathModule.posix.isAbsolute, resolve: pathModule.posix.resolve }))
    vi.doMock('node:fs', () => ({ constants: { ...fs.constants, O_NOFOLLOW: 0x20000, O_DIRECTORY: 0x10000, O_NONBLOCK: 0x800 } }))
    vi.doMock('node:fs/promises', () => ({
      ...real, lstat: stat, readlink: async (path: string) => path === '/proc/self' ? String(process.pid) : '',
      mkdir: async (path: string, opts: { recursive?: boolean; mode?: number }) => {
        const target = canonical(path), parts = target.split('/')
        for (let i = 2; i < parts.length; i++) if (!tree.has(parts.slice(0, i).join('/'))) tree.set(parts.slice(0, i).join('/'), { directory: true, mode: 0o755 })
        if (!opts.recursive && tree.has(target)) throw Object.assign(new Error('diagnostic EEXIST'), { code: 'EEXIST' })
        if (!tree.has(target)) tree.set(target, { directory: true, mode: opts.mode ?? 0o755 })
      },
      opendir: async (path: string) => {
        const base = canonical(path), names = [...tree.keys()].filter(path => path.startsWith(`${base}/`) && !path.slice(base.length + 1).includes('/')).map(path => path.slice(base.length + 1))
        let index = 0
        return { read: async () => index < names.length ? { name: names[index++] } : null, close: async () => undefined }
      },
      open: async (path: string, flags = 0, mode = 0o644) => {
        if (canonical(path) === '/protected/release.tar.gz') {
          const actual = await real.open(backing, 'r'); closed = false
          openedFile = { fd: actual.fd, stat: async () => fileStat(await actual.stat({ bigint: true })), createReadStream: (opts: any) => actual.createReadStream(opts), close: async () => { fileCloses++; await actual.close(); closed = true; if (closeFailure) throw new Error('diagnostic uncertain close') } }
          return openedFile
        }
        if ((flags & fs.constants.O_CREAT) !== 0) {
          if (tree.has(canonical(path))) throw Object.assign(new Error('diagnostic EEXIST'), { code: 'EEXIST' })
          tree.set(canonical(path), { content: Buffer.alloc(0), mode, uid: 0n, nlink: 1n })
        }
        const node = tree.get(canonical(path))
        if (node && !node.directory) return { fd: nextFd++, stat: async () => treeStat(canonical(path)), write: async (bytes: Buffer, offset: number, length: number) => { if (stagingWriteFailure) throw new Error('diagnostic ENOSPC'); const chunk = bytes.subarray(offset, offset + length); node.content = Buffer.concat([node.content, chunk]); return { bytesWritten: chunk.length } }, sync: async () => undefined, createReadStream: () => { if (changeTreeDuringRead) { treeEpoch++; changeTreeDuringRead = false } return Readable.from([node.content]) }, close: async () => undefined }
        const normalized = canonical(path), fd = nextFd++; dirs.set(fd, normalized)
        return { fd, stat: async () => directory(normalized), sync: async () => undefined, statfs: async () => ({ type: 0x9fa0n }), close: async () => { dirs.delete(fd) } }
      },
    }))
    const mod = await import('./release-verifier.mjs')
    return { mod, path: '/protected/release.tar.gz', isClosed: () => closed, fileCloses: () => fileCloses,
      closeFile: async () => { await openedFile.close() }, replace: () => { backing = archiveFile(original) },
      mutate: () => { const bytes = Buffer.from(original); bytes[bytes.length - 1] ^= 1; writeFileSync(backing, bytes) }, insecure: () => { directoryMode = 0o777 },
      failClose: () => { closeFailure = true },
      failStageWrite: () => { stagingWriteFailure = true },
      content: (path: string) => tree.get(path)?.content,
      paths: () => [...tree.keys()],
      treeFault: (kind: string) => {
        const leaf = tree.get('/protected/tree/VERSION')
        if (kind === 'content') leaf.content = Buffer.alloc(leaf.content.length, 88)
        if (kind === 'missing') tree.delete('/protected/tree/VERSION')
        if (kind === 'extra') tree.set('/protected/tree/unlisted', { ...leaf })
        if (kind === 'dependencies') tree.set('/protected/tree/node_modules', { directory: true })
        if (kind === 'owner') leaf.uid = 1000n
        if (kind === 'mode') leaf.mode = 0o666
        if (kind === 'hardlink') leaf.nlink = 2n
        if (kind === 'symlink') leaf.special = true
        if (kind === 'retired-root') changeTreeDuringRead = true
      },
    }
  }
  it('retains the actual read-only file handle through the callback and closes it before returning', async () => {
    const f = await fixture(); let during = false
    const result = await f.mod.withAuthenticatedReleaseArchive(f.path, options(original), async ({ report, fd }: any) => {
      expect(report.archiveSha256).toBe(sha(original)); expect(Number.isInteger(fd)).toBe(true)
      expect(f.isClosed()).toBe(false); during = true; return 'staged-only'
    })
    expect(during).toBe(true); expect(result.value).toBe('staged-only'); expect(f.isClosed()).toBe(true); expect(f.fileCloses()).toBe(1)
  })
  it.each(['replace', 'mutate', 'closeFile', 'throw'] as const)('refuses publication after callback %s and revokes its report', async action => {
    const f = await fixture(); let report: any
    await expect(f.mod.withAuthenticatedReleaseArchive(f.path, options(original), async (admitted: any) => {
      report = admitted.report
      if (action === 'throw') throw new Error('diagnostic staging failure')
      await f[action]()
    })).rejects.toMatchObject({ code: 'ARCHIVE_USE_UNCERTAIN', uncertain: true, archiveSha256: sha(original) })
    expect(f.isClosed()).toBe(true)
    await expect(f.mod.verifyAuthenticatedReleaseTree('/protected/tree', { authenticatedArchive: report, signingKey: key, keyId })).rejects.toMatchObject({ code: 'TRUST_REQUIRED' })
  })
  it.each([undefined, null, 0, ''])('refuses a falsy callback exception %s instead of returning a successful lifetime', async reason => {
    const f = await fixture(); let report: any
    await expect(f.mod.withAuthenticatedReleaseArchive(f.path, options(original), (admitted: any) => { report = admitted.report; throw reason })).rejects.toMatchObject({ code: 'ARCHIVE_USE_UNCERTAIN', uncertain: true })
    await expect(f.mod.verifyAuthenticatedReleaseTree('/protected/tree', { authenticatedArchive: report, signingKey: key, keyId })).rejects.toMatchObject({ code: 'TRUST_REQUIRED' })
  })
  it('rejects writable ancestry before opening the compressed file or calling the callback', async () => {
    const f = await fixture(); f.insecure(); let invoked = false
    await expect(f.mod.withAuthenticatedReleaseArchive(f.path, options(original), () => { invoked = true })).rejects.toMatchObject({ code: 'UNSAFE_MODE' })
    expect(invoked).toBe(false); expect(f.fileCloses()).toBe(0)
  })
  it('retains uncertain retirement and refuses new verification without retrying the close', async () => {
    const f = await fixture(); f.failClose()
    await expect(f.mod.withAuthenticatedReleaseArchive(f.path, options(original), () => 'staged')).rejects.toMatchObject({ code: 'DESCRIPTOR_UNCERTAIN', uncertain: true })
    expect(f.fileCloses()).toBe(1)
    await expect(f.mod.verifyAuthenticatedReleaseArchive(f.path, options(original))).rejects.toMatchObject({ code: 'DESCRIPTOR_UNCERTAIN' })
    expect(f.fileCloses()).toBe(1)
  })
  it('verifies complete actual source-byte closure through the strict tree branch in diagnostic identities', async () => {
    const f = await fixture()
    const { value } = await f.mod.withAuthenticatedReleaseArchive(f.path, options(original), ({ report }: any) => f.mod.verifyAuthenticatedReleaseTree('/protected/tree', { authenticatedArchive: report, signingKey: key, keyId }))
    expect(value.ok).toBe(true); expect(value.verifiedFiles).toBe(parseTarGzBuffer(original).filter(e => e.type === 'file').length)
  })
  it('streams authenticated retained bytes into a private stage and verifies its real modeled closure', async () => {
    const f = await fixture(); let report: any
    const { value } = await f.mod.withAuthenticatedReleaseArchive(f.path, options(original), async (held: any) => {
      report = held.report
      return f.mod.stageAuthenticatedReleaseArchive('/protected/staging', { authenticatedArchive: report, signingKey: key, keyId })
    })
    expect(value).toMatchObject({ ok: true, activated: false, installReady: false, runtimeDependenciesVerified: false })
    expect(f.content(`${value.stagedAt}/VERSION`).toString()).toBe('0.1.0\n')
    expect(f.isClosed()).toBe(true)
    await expect(f.mod.stageAuthenticatedReleaseArchive('/protected/staging', { authenticatedArchive: report, signingKey: key, keyId })).rejects.toMatchObject({ code: 'LIVE_ARCHIVE_REQUIRED' })
  })
  it('retains an owned extracted stage when the archive path changes before lifetime retirement', async () => {
    const f = await fixture(); let stagedAt = ''
    await expect(f.mod.withAuthenticatedReleaseArchive(f.path, options(original), async ({ report }: any) => {
      const staged = await f.mod.stageAuthenticatedReleaseArchive('/protected/staging', { authenticatedArchive: report, signingKey: key, keyId })
      stagedAt = staged.stagedAt; f.replace()
    })).rejects.toMatchObject({ code: 'ARCHIVE_USE_UNCERTAIN', stagingRetained: true })
    expect(f.content(`${stagedAt}/VERSION`).toString()).toBe('0.1.0\n')
    expect(f.isClosed()).toBe(true)
  })
  it('awaits an unawaited actual extraction before retiring the archive descriptor', async () => {
    const f = await fixture()
    const result = await f.mod.withAuthenticatedReleaseArchive(f.path, options(original), ({ report }: any) => {
      void f.mod.stageAuthenticatedReleaseArchive('/protected/staging', { authenticatedArchive: report, signingKey: key, keyId })
      return 'callback-value-is-not-validation'
    })
    const version = f.paths().find((path: string) => path.startsWith('/protected/staging/authenticated-') && path.endsWith('/VERSION'))!
    expect(f.content(version).toString()).toBe('0.1.0\n')
    expect(result.value).toBe('callback-value-is-not-validation'); expect(f.isClosed()).toBe(true)
  })
  it('cannot turn an unawaited writer failure into callback-declared success', async () => {
    const f = await fixture(); f.failStageWrite()
    await expect(f.mod.withAuthenticatedReleaseArchive(f.path, options(original), ({ report }: any) => {
      void f.mod.stageAuthenticatedReleaseArchive('/protected/staging', { authenticatedArchive: report, signingKey: key, keyId })
      return { validation: 'claimed-ready' }
    })).rejects.toMatchObject({ code: 'ARCHIVE_USE_UNCERTAIN', stagingRetained: true })
    expect(f.paths().some((path: string) => path.startsWith('/protected/staging/authenticated-'))).toBe(true)
    expect(f.isClosed()).toBe(true)
  })
  it('binds extraction to the held signer and forbids another staging attempt', async () => {
    const f = await fixture()
    await expect(f.mod.withAuthenticatedReleaseArchive(f.path, options(original), ({ report }: any) =>
      f.mod.stageAuthenticatedReleaseArchive('/protected/staging', { authenticatedArchive: report, signingKey: key, keyId: 'other-key' })))
      .rejects.toMatchObject({ code: 'ARCHIVE_USE_UNCERTAIN' })
    const g = await fixture()
    await g.mod.withAuthenticatedReleaseArchive(g.path, options(original), async ({ report }: any) => {
      const staging = g.mod.stageAuthenticatedReleaseArchive('/protected/staging', { authenticatedArchive: report, signingKey: key, keyId })
      await expect(g.mod.stageAuthenticatedReleaseArchive('/protected/staging', { authenticatedArchive: report, signingKey: key, keyId })).rejects.toMatchObject({ code: 'STAGING_ALREADY_STARTED' })
      return staging
    })
    expect(g.isClosed()).toBe(true)
  })
  it.each(['content', 'missing', 'extra', 'dependencies', 'owner', 'mode', 'hardlink', 'symlink', 'retired-root'])('refuses tree %s without a stat-provider waiver', async kind => {
    const f = await fixture(); f.treeFault(kind)
    await expect(f.mod.withAuthenticatedReleaseArchive(f.path, options(original), ({ report }: any) => f.mod.verifyAuthenticatedReleaseTree('/protected/tree', { authenticatedArchive: report, signingKey: key, keyId }))).rejects.toMatchObject({ code: 'ARCHIVE_USE_UNCERTAIN' })
  })
})
