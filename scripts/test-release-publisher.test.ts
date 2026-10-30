import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { captureReleaseSource, createPublisherManifest, publisherManifestPath, publisherPayload, releaseInputFingerprint, writePublisherOutput } from './release-publisher.mjs'
import { canonicalReleasePayload, parseSignedReleaseManifest, verifySignedManifestForRelease } from '../apps/agent/src/lifecycle/upgrade-runner.ts'

// Ephemeral test-only keys never leave process memory or become production trust.
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const trust = [{ keyId: 'publisher-test', kind: 'ed25519-pem' as const, publicKeyOrSecret: publicPem }]
const release = { version: '0.1.0', schemaVersion: 6, sha256: 'a'.repeat(64), bytes: 123456 }
const roots: string[] = []
const temp = () => { const path = mkdtempSync(join(tmpdir(), 'xpanel-publisher-')); roots.push(path); return path }
afterEach(() => { for (const path of roots.splice(0)) {
  if (dirname(resolve(path)) !== resolve(tmpdir()) || !basename(path).startsWith('xpanel-publisher-')) throw new Error('Unowned test directory')
  rmSync(path, { recursive: true, force: true })
} })

describe('publisher signature and native consumer contract', () => {
  it('produces the exact native wire payload and an Ed25519 sidecar accepted by the real consumer', () => {
    const signed = createPublisherManifest(release, { keyId: 'publisher-test', privateKey })
    expect(publisherPayload(release)).toEqual(canonicalReleasePayload(release))
    expect(publisherPayload(release).toString()).toBe(`xpanel-release-v1:0.1.0:6:${release.sha256}:123456`)
    expect(signed.signature).toMatch(/^[a-f0-9]{128}$/)
    expect(Object.keys(signed).sort()).toEqual(['bytes', 'keyId', 'schemaVersion', 'sha256', 'signature', 'version'])
    expect(() => verifySignedManifestForRelease(parseSignedReleaseManifest(JSON.parse(JSON.stringify(signed))), release, trust)).not.toThrow()
    expect(Object.isFrozen(signed)).toBe(true)
  })

  it.each([
    ['version', '0.2.0'], ['schemaVersion', 7], ['sha256', 'b'.repeat(64)], ['bytes', 123457],
  ])('refuses a modified %s even when the release plan repeats the modified field', (field, value) => {
    const signed = createPublisherManifest(release, { keyId: 'publisher-test', privateKey })
    const changed = { ...signed, [field]: value }
    expect(() => verifySignedManifestForRelease(changed, { ...release, [field]: value }, trust)).toThrow()
  })

  it('rejects another publisher, signature tampering, unsigned fields and compressed-byte substitution', () => {
    const signed = createPublisherManifest(release, { keyId: 'publisher-test', privateKey })
    const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
    expect(() => verifySignedManifestForRelease(signed, release, [{ ...trust[0]!, publicKeyOrSecret: other }])).toThrow()
    expect(() => verifySignedManifestForRelease({ ...signed, signature: '0'.repeat(128) }, release, trust)).toThrow()
    expect(() => parseSignedReleaseManifest({ ...signed, sourceCommit: 'c'.repeat(40) })).toThrow()
    // Runtime compares the authenticated inventory total, not archive.stat.size.
    expect(() => verifySignedManifestForRelease(signed, { ...release, bytes: 100 }, trust)).toThrow()
    expect(() => verifySignedManifestForRelease({ ...signed, keyId: 'not-trusted' }, release, trust)).toThrow()
  })

  it('rejects invalid release fields, non-Ed25519/private keys and invalid key IDs', () => {
    for (const changed of [{ version: '1.0.0-beta' }, { schemaVersion: 0 }, { bytes: 0 }, { bytes: NaN }, { sha256: 'X'.repeat(64) }]) {
      expect(() => createPublisherManifest({ ...release, ...changed }, { keyId: 'publisher-test', privateKey })).toThrow()
    }
    expect(() => createPublisherManifest(release, { keyId: 'bad/id', privateKey })).toThrow()
    expect(() => createPublisherManifest(release, { keyId: 'publisher-test', privateKey: publicPem })).toThrow()
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    expect(() => createPublisherManifest(release, { keyId: 'publisher-test', privateKey: ec.privateKey })).toThrow()
  })

  it('pairs the existing archive basename with the sidecar expected by staging and native activation', () => {
    expect(publisherManifestPath('/staged/xpanel-release-0.1.0.tar.gz')).toBe('/staged/xpanel-release-0.1.0.manifest.json')
    expect(() => publisherManifestPath('/staged/release.zip')).toThrow()
  })

  it('refuses competing publisher output without replacing previously signed archive bytes', () => {
    const archive = join(temp(), 'release.tar.gz')
    const first = Buffer.from('first diagnostic archive'), second = Buffer.from('second diagnostic archive')
    writePublisherOutput(archive, first)
    expect(() => writePublisherOutput(archive, second)).toThrow()
    expect(readFileSync(archive)).toEqual(first)
  })
})

describe('explicit release-input provenance', () => {
  it('is deterministic, rejects ambiguous paths, and uses a named digest domain', () => {
    const a = { path: 'apps/a.ts', sha256: 'a'.repeat(64), bytes: 3 }
    const b = { path: 'package.json', sha256: 'b'.repeat(64), bytes: 4 }
    expect(releaseInputFingerprint([a, b])).toBe(releaseInputFingerprint([b, a]))
    expect(releaseInputFingerprint([a])).not.toBe(createHash('sha256').update(JSON.stringify([a])).digest('hex'))
    for (const path of ['../private', '/absolute', 'C:/outside', 'a\\b', 'a//b', 'a/./b', 'a\u0000b']) {
      expect(() => releaseInputFingerprint([{ ...a, path }])).toThrow()
    }
    expect(() => releaseInputFingerprint([a, a])).toThrow()
    expect(() => releaseInputFingerprint([])).toThrow()
  })

  it('records exported source honestly and detects changed bytes without including generated output', () => {
    const root = temp()
    writeFileSync(join(root, 'input.ts'), 'export {}\n')
    const captured = captureReleaseSource(root, ['input.ts'])
    expect(captured.source).toMatchObject({ schemaVersion: 1, fingerprintAlgorithm: 'sha256-release-inputs-v1', inputFiles: 1, commit: null, tree: null, dirty: null })
    expect(captured.source.inputFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(() => captured.assertUnchanged()).not.toThrow()
    writeFileSync(join(root, 'generated.json'), JSON.stringify(captured.source))
    expect(() => captured.assertUnchanged()).not.toThrow()
    writeFileSync(join(root, 'input.ts'), 'export const changed = true\n')
    expect(() => captured.assertUnchanged()).toThrow('SOURCE_CHANGED_DURING_BUILD')
    expect(() => captureReleaseSource(root, ['../outside'])).toThrow()
    expect(readFileSync(join(root, 'input.ts'), 'utf8')).toContain('changed')
  })

  it('requires a clean identifiable checkout before publisher signing', () => {
    const root = temp()
    writeFileSync(join(root, 'input.ts'), 'export {}\n')
    expect(() => captureReleaseSource(root, ['input.ts'], { requireClean: true })).toThrow('PUBLISHER_CLEAN_SOURCE_REQUIRED')
  })

  it('stages captured bytes even after a change-and-restore and returns defensive copies', () => {
    const root = temp(), path = join(root, 'input.ts'), original = Buffer.from('export {}\n')
    writeFileSync(path, original)
    const captured = captureReleaseSource(root, ['input.ts'])
    writeFileSync(path, 'export const unrelated = true\n')
    expect(captured.readInput('input.ts')).toEqual(original)
    const copy = captured.readInput('input.ts'); copy.fill(0)
    expect(captured.readInput('input.ts')).toEqual(original)
    writeFileSync(path, original)
    expect(() => captured.assertUnchanged()).not.toThrow()
    expect(() => captured.readInput('not-admitted.ts')).toThrow('SOURCE_INPUTS_INVALID')
  })
})
