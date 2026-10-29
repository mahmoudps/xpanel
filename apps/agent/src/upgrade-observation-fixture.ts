// Test-only fixture for the upgrade observation and route tests. Not imported by production code.
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDb } from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import type { UpgradeLayout } from '@xpanel/lifecycle'
import { canonicalReleasePayload } from './lifecycle/upgrade-runner.ts'
import type { SignedReleaseManifest } from './lifecycle/upgrade-runner.ts'
import { nodeUpgradeFs } from './upgrade-observation.ts'
import type { FileFacts, UpgradeHostFs, UpgradeObservationDeps } from './upgrade-observation.ts'

export const KEY_ID = 'xpanel-release-test'

export interface UpgradeFixture {
  tmp: string
  db: TestDbHandle
  layout: UpgradeLayout
  keysPath: string
  osReleasePath: string
  facts: Map<string, Partial<FileFacts>>
  links: Map<string, string>
  free: { bytes: number }
  fs: UpgradeHostFs
  publicPem: string
  sign(core: Omit<SignedReleaseManifest, 'signature' | 'keyId'>, keyId?: string): SignedReleaseManifest
  stage(version: string, options?: { archive?: string; manifest?: Record<string, unknown>; keyId?: string }): Promise<{ archivePath: string; manifestPath: string }>
  writeKeys(document: unknown): Promise<void>
  deps(extra?: Partial<UpgradeObservationDeps>): UpgradeObservationDeps
  close(): Promise<void>
}

/** Real temp files; ownership/mode facts are normalized to root-owned 0644 so tests run on any OS. */
export const createUpgradeFixture = async (): Promise<UpgradeFixture> => {
  const tmp = await mkdtemp(join(tmpdir(), 'xp-upgrade-'))
  const opt = join(tmp, 'opt')
  const layout: UpgradeLayout = {
    root: opt, releasesDir: join(opt, 'releases'), currentLink: join(opt, 'current'), stagingDir: join(opt, 'staging'), downloadsDir: join(opt, 'downloads'),
    stateDir: join(tmp, 'var'), snapshotsDir: join(tmp, 'lifecycle', 'backups'), lockFile: join(tmp, 'var', 'upgrade.lock'), maintenanceFile: join(tmp, 'var', 'maintenance.json'),
  }
  for (const dir of [join(layout.releasesDir, '1.0.0'), layout.downloadsDir, layout.stateDir, layout.snapshotsDir, join(tmp, 'etc')]) await mkdir(dir, { recursive: true })
  await writeFile(join(layout.releasesDir, '1.0.0', 'VERSION'), '1.0.0\n')
  const osReleasePath = join(tmp, 'etc', 'os-release')
  await writeFile(osReleasePath, 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\nPRETTY_NAME="Ubuntu 24.04 LTS"\n')
  const keysPath = join(tmp, 'etc', 'release-keys.json')
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const facts = new Map<string, Partial<FileFacts>>()
  const links = new Map<string, string>([[layout.currentLink, join(layout.releasesDir, '1.0.0')]])
  const free = { bytes: 50 * 1024 ** 3 }
  const adjust = (path: string, info: FileFacts): FileFacts => ({ ...info, uid: 0, mode: info.mode & ~0o022, nlink: info.kind === 'file' ? 1 : info.nlink, ...(facts.get(path) ?? {}) })
  const fs: UpgradeHostFs = {
    lstat: async path => { const info = await nodeUpgradeFs.lstat(path); return info && adjust(path, info) },
    read: async (path, max) => { const held = await nodeUpgradeFs.read(path, max); return { ...held, facts: adjust(path, held.facts) } },
    sha256: async (path, max) => { const held = await nodeUpgradeFs.sha256(path, max); return { ...held, facts: adjust(path, held.facts) } },
    list: path => nodeUpgradeFs.list(path),
    readlink: async path => links.get(path) ?? null,
    freeBytes: async () => free.bytes,
  }
  const db = await createTestDb()
  const sign: UpgradeFixture['sign'] = (core, keyId = KEY_ID) => ({ ...core, keyId, signature: cryptoSign(null, canonicalReleasePayload(core), privateKey).toString('hex') })
  const writeKeys = async (document: unknown): Promise<void> => { await writeFile(keysPath, JSON.stringify(document)) }
  await writeKeys({ schemaVersion: 1, keys: [{ keyId: KEY_ID, algorithm: 'ed25519', publicKey: publicPem }] })
  return {
    tmp, db, layout, keysPath, osReleasePath, facts, links, free, fs, publicPem, sign, writeKeys,
    async stage(version, options = {}) {
      const archive = options.archive ?? `release-${version}-payload`
      const archivePath = join(layout.downloadsDir, `xpanel-${version}.tar.gz`)
      const manifestPath = join(layout.downloadsDir, `xpanel-${version}.manifest.json`)
      await writeFile(archivePath, archive)
      const signed = sign({ version, schemaVersion: db.migration.version + 1, sha256: createHash('sha256').update(archive).digest('hex'), bytes: 100 * 1024 * 1024 }, options.keyId)
      await writeFile(manifestPath, JSON.stringify({ ...signed, ...(options.manifest ?? {}) }))
      return { archivePath, manifestPath }
    },
    deps: (extra = {}) => ({ db: db.db, fs, layout, keysPath, osReleasePath, now: () => new Date('2026-10-27T10:00:00.000Z'), ...extra }),
    async close() { await db.close(); await rm(tmp, { recursive: true, force: true }) },
  }
}
