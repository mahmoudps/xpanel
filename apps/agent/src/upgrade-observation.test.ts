import { generateKeyPairSync } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createUpgrade } from '@xpanel/db'
import { REWIND_STEPS, rewindJournalPath } from '@xpanel/lifecycle'
import { createUpgradeFixture, KEY_ID } from './upgrade-observation-fixture.ts'
import type { UpgradeFixture } from './upgrade-observation-fixture.ts'
import { loadTrustedReleaseKeys, readReleaseManifestFor, readUpgradeObservation, releaseManifestPathFor } from './upgrade-observation.ts'

let f: UpgradeFixture
beforeEach(async () => { f = await createUpgradeFixture() })
afterEach(async () => { await f.close() })

describe('upgrade observation', () => {
  it('reads current release, schema, OS, free space, transfers and a verified staged release from the host only', async () => {
    await f.stage('1.1.0')
    const value = await readUpgradeObservation(f.deps())
    expect(value.current).toEqual({ state: 'read', version: '1.0.0', releasePath: join(f.layout.releasesDir, '1.0.0') })
    expect(value.schemaVersion).toBe(f.db.migration.version)
    expect(value.os).toEqual({ id: 'ubuntu', versionId: '24.04', prettyName: 'Ubuntu 24.04 LTS' })
    expect(value.freeBytes).toBe(50 * 1024 ** 3)
    expect(value.activeTransfers).toBe(0)
    expect(value.lock).toEqual({ present: false, state: null, to: null, at: null })
    expect(value.retirementPending).toBe(false)
    expect(value.trust).toMatchObject({ state: 'configured', keysConfigured: 1, keyIds: [KEY_ID], reason: null })
    expect(value.staged.releases).toEqual([expect.objectContaining({ manifest: 'xpanel-1.1.0.manifest.json', version: '1.1.0', signatureState: 'verified', reason: null })])
    expect(value.availability.candidates).toEqual(['1.1.0'])
    expect(value.availability.preflight).toEqual({ enabled: true, reasons: [] })
    // No coordinator is composed here, so the start button must stay disabled with that exact reason.
    expect(value.availability.start).toEqual({ enabled: false, reasons: ['upgrade-coordinator-unavailable'] })
    expect(value.revision).toMatch(/^[0-9a-f]{64}$/)
  })

  it('keeps the revision stable across volatile free space and read time, and changes it when staging changes', async () => {
    await f.stage('1.1.0')
    const first = await readUpgradeObservation(f.deps())
    f.free.bytes -= 4096
    const second = await readUpgradeObservation(f.deps({ now: () => new Date('2026-10-27T10:05:00.000Z') }))
    expect(second.revision).toBe(first.revision)
    await f.stage('1.2.0')
    expect((await readUpgradeObservation(f.deps())).revision).not.toBe(first.revision)
  })

  it('reports each staged signature state truthfully', async () => {
    await f.stage('1.1.0')
    await f.stage('1.2.0', { keyId: 'unknown-key' })
    const tampered = await f.stage('1.3.0')
    await writeFile(tampered.archivePath, 'tampered-bytes')
    const forged = await f.stage('1.4.0')
    const forgedManifest = JSON.parse(await readFile(forged.manifestPath, 'utf8'))
    await writeFile(forged.manifestPath, JSON.stringify({ ...forgedManifest, signature: 'a'.repeat(128) }))
    await f.stage('1.5.0', { manifest: { notes: 'unsigned release notes' } })
    const linked = await f.stage('1.6.0')
    f.facts.set(linked.manifestPath, { kind: 'symlink' })
    const value = await readUpgradeObservation(f.deps())
    const state = Object.fromEntries(value.staged.releases.map(item => [item.manifest, [item.signatureState, item.reason]]))
    expect(state).toEqual({
      'xpanel-1.1.0.manifest.json': ['verified', null],
      'xpanel-1.2.0.manifest.json': ['unverified', 'untrusted-key'],
      'xpanel-1.3.0.manifest.json': ['invalid', 'archive-checksum-mismatch'],
      'xpanel-1.4.0.manifest.json': ['invalid', 'signature-mismatch'],
      'xpanel-1.5.0.manifest.json': ['invalid', 'manifest-invalid'],
      'xpanel-1.6.0.manifest.json': ['invalid', 'manifest-not-regular-file'],
    })
    expect(value.availability.candidates).toEqual(['1.1.0'])
  })

  it('refuses every staged release when no trusted keys exist and blocks preflight with the exact reason', async () => {
    await f.stage('1.1.0')
    const value = await readUpgradeObservation(f.deps({ keysPath: join(f.tmp, 'etc', 'absent.json') }))
    expect(value.trust).toMatchObject({ state: 'missing', keysConfigured: 0, reason: 'no-trusted-release-keys' })
    expect(value.staged.releases[0]).toMatchObject({ signatureState: 'no-trusted-keys', reason: 'no-trusted-release-keys' })
    expect(value.availability.preflight).toEqual({ enabled: false, reasons: ['no-trusted-release-keys'] })
    expect(value.availability.start.enabled).toBe(false)
  })

  it('reports lock, in-flight upgrade, archive safety and unreadable current release as blockers', async () => {
    const staged = await f.stage('1.1.0')
    await writeFile(f.layout.lockFile, JSON.stringify({ state: 'rollback-failed', recordId: null, actor: 'root', to: '1.1.0', at: '2026-10-26T00:00:00.000Z' }))
    await createUpgrade(f.db.db, { fromVersion: '1.0.0', toVersion: '1.1.0', actor: 'root', fromSchemaVersion: 1 })
    const blocked = await readUpgradeObservation(f.deps({ coordinatorAvailable: true }))
    expect(blocked.lock).toMatchObject({ present: true, state: 'rollback-failed', to: '1.1.0' })
    expect(blocked.availability.start.reasons).toEqual(['upgrade-lock-present', 'upgrade-in-flight'])
    f.facts.set(staged.archivePath, { mode: 0o666 })
    expect((await readUpgradeObservation(f.deps())).staged.releases[0]).toMatchObject({ signatureState: 'invalid', reason: 'archive-unsafe' })
    f.links.delete(f.layout.currentLink)
    const lost = await readUpgradeObservation(f.deps())
    expect(lost.current).toEqual({ state: 'unavailable', version: null, releasePath: null })
    expect(lost.availability.preflight.reasons).toContain('current-release-unreadable')
    f.links.set(f.layout.currentLink, join(f.layout.releasesDir, '1.0.0'))
    await writeFile(join(f.layout.releasesDir, '1.0.0', 'VERSION'), '0.9.0\n')
    expect((await readUpgradeObservation(f.deps())).current.state).toBe('unavailable')
  })

  it('reports the latest upgrade rewind journal, and an unreadable journal as unreadable rather than absent', async () => {
    expect((await readUpgradeObservation(f.deps())).rewind).toBeNull()
    const { id } = await createUpgrade(f.db.db, { fromVersion: '1.0.0', toVersion: '1.1.0', actor: 'root', fromSchemaVersion: 1 })
    expect((await readUpgradeObservation(f.deps())).rewind).toBeNull()
    const journal = rewindJournalPath(f.layout, id)
    const entry = { schemaVersion: 1, recordId: id, state: 'rewind-unknown', done: ['release', 'state-extract'], generation: null, problems: ['canary alice served by uid 33 instead of 1001'], startedAt: '2026-10-27T09:00:00.000Z', updatedAt: '2026-10-27T09:05:00.000Z' }
    await writeFile(journal, JSON.stringify(entry))
    const first = await readUpgradeObservation(f.deps())
    expect(first.rewind).toEqual({ state: 'rewind-unknown', done: ['release', 'state-extract'], problems: ['canary alice served by uid 33 instead of 1001'], updatedAt: '2026-10-27T09:05:00.000Z' })
    await writeFile(journal, JSON.stringify({ ...entry, state: 'rewind-verified', done: REWIND_STEPS, problems: [] }))
    const verified = await readUpgradeObservation(f.deps())
    expect(verified.rewind?.state).toBe('rewind-verified')
    expect(verified.revision).not.toBe(first.revision)
    await writeFile(journal, '{"state":"rewind-verified"')
    expect((await readUpgradeObservation(f.deps())).rewind).toEqual({ state: 'unreadable', done: [], problems: [], updatedAt: null })
  })
})

describe('trusted release keys', () => {
  const load = (fixture: UpgradeFixture, path = fixture.keysPath) => loadTrustedReleaseKeys({ fs: fixture.fs, path })

  it('loads Ed25519 public keys only from a root-owned non-writable file', async () => {
    expect(await load(f)).toMatchObject({ state: 'configured', keyIds: [KEY_ID], reason: null })
    expect((await load(f)).keys[0]).toMatchObject({ keyId: KEY_ID, kind: 'ed25519-pem' })
  })

  it('treats a missing file or an empty list as no trusted keys', async () => {
    expect(await load(f, join(f.tmp, 'etc', 'missing.json'))).toMatchObject({ state: 'missing', keys: [], reason: 'no-trusted-release-keys' })
    await f.writeKeys({ schemaVersion: 1, keys: [] })
    expect(await load(f)).toMatchObject({ state: 'missing', keys: [], reason: 'no-trusted-release-keys' })
  })

  it('refuses HMAC secrets instead of downgrading trust', async () => {
    await f.writeKeys({ schemaVersion: 1, keys: [{ keyId: 'legacy', algorithm: 'hmac-sha256', secret: 'super-secret-shared-signing-key-material' }] })
    expect(await load(f)).toMatchObject({ state: 'invalid', keys: [], reason: 'hmac-release-key-refused' })
    await f.writeKeys({ schemaVersion: 1, keys: [{ keyId: KEY_ID, algorithm: 'ed25519', publicKey: f.publicPem }, { keyId: 'legacy', algorithm: 'HMAC-SHA256', publicKey: 'x' }] })
    expect(await load(f)).toMatchObject({ state: 'invalid', keys: [], reason: 'hmac-release-key-refused' })
  })

  it('refuses group/world-writable files, writable ancestors and symbolic links', async () => {
    f.facts.set(f.keysPath, { mode: 0o664 })
    expect(await load(f)).toMatchObject({ state: 'invalid', reason: 'release-keys-file-unsafe' })
    f.facts.set(f.keysPath, { mode: 0o644, uid: 1000 })
    expect(await load(f)).toMatchObject({ state: 'invalid', reason: 'release-keys-file-unsafe' })
    f.facts.set(f.keysPath, { kind: 'symlink' })
    expect(await load(f)).toMatchObject({ state: 'invalid', reason: 'release-keys-file-unsafe' })
    f.facts.delete(f.keysPath)
    f.facts.set(dirname(f.keysPath), { mode: 0o777 })
    expect(await load(f)).toMatchObject({ state: 'invalid', reason: 'release-keys-file-unsafe' })
  })

  it('refuses private keys, non-Ed25519 keys and unknown fields', async () => {
    const { privateKey } = generateKeyPairSync('ed25519')
    await f.writeKeys({ schemaVersion: 1, keys: [{ keyId: KEY_ID, algorithm: 'ed25519', publicKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }] })
    expect(await load(f)).toMatchObject({ state: 'invalid', reason: 'release-keys-invalid' })
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'pem' }).toString()
    await f.writeKeys({ schemaVersion: 1, keys: [{ keyId: KEY_ID, algorithm: 'ed25519', publicKey: rsa }] })
    expect(await load(f)).toMatchObject({ state: 'invalid', reason: 'release-keys-invalid' })
    await f.writeKeys({ schemaVersion: 1, keys: [{ keyId: KEY_ID, algorithm: 'ed25519', publicKey: f.publicPem, comment: 'x' }] })
    expect(await load(f)).toMatchObject({ state: 'invalid', reason: 'release-keys-invalid' })
  })

  it('reads the signed manifest that sits beside an archive for the native coordinator gate', async () => {
    const staged = await f.stage('1.1.0')
    expect(releaseManifestPathFor(staged.archivePath)).toBe(staged.manifestPath)
    expect((await readReleaseManifestFor(staged.archivePath, f.fs)).version).toBe('1.1.0')
    expect(() => releaseManifestPathFor('/opt/xpanel/downloads/release.zip')).toThrow()
  })
})
