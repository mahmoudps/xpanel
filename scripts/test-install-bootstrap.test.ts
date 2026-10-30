import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { assertFreshInstallReleaseControls, parseBootstrapArgs, parseBootstrapKeys, parseBootstrapTrust, prepareNewInstallation, runBootstrapCli, verifyBootstrapPublisher } from './install-bootstrap.mjs'

const options = ['--artifact=/root/releases/xpanel-release-0.1.0.tar.gz', `--artifact-sha256=${'a'.repeat(64)}`, '--release-trust-file=/root/protected/archive-trust.json', '--release-keys-file=/root/protected/publisher-keys.json']
const archiveTrust = () => ({ keyId: 'archive-anchor', packageManagerPath: '/opt/tools/pnpm', packageManagerSha256: 'b'.repeat(64), signingKeyPath: '/root/protected/archive-hmac' })
// Generated ephemeral keys stay in process memory and never become installation trust.
const pair = generateKeyPairSync('ed25519')
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const keys = () => ({ schemaVersion: 1, keys: [{ keyId: 'publisher-test', algorithm: 'ed25519', publicKey }] })
const release = { version: '0.1.0', schemaVersion: 6, sha256: 'a'.repeat(64), bytes: 123456 }
const signed = () => ({ ...release, keyId: 'publisher-test', signature: sign(null, Buffer.from(`xpanel-release-v1:${release.version}:${release.schemaVersion}:${release.sha256}:${release.bytes}`), pair.privateKey).toString('hex') })
const report = () => ({ manifest: { version: release.version, controlDbSchemaVersion: release.schemaVersion }, archiveSha256: release.sha256, totalUnpackedBytes: release.bytes })

describe('new install input grammar; no native installation effects', () => {
  it('keeps legacy lifecycle eligibility distinct from stricter fresh-install bootstrap prerequisites', () => {
    const legacy = { lifecycleControlsPresent: true, manifest: { files: [{ path: 'scripts/lifecycle-runtime.mjs' }] } }
    expect(legacy.lifecycleControlsPresent).toBe(true)
    expect(() => assertFreshInstallReleaseControls(legacy)).toThrow('INSTALL_RELEASE_CONTROLS_REQUIRED')
    const helper = { path: 'scripts/install-bootstrap.mjs' }, declaration = { path: 'scripts/install-bootstrap.d.mts' }
    expect(() => assertFreshInstallReleaseControls({ ...legacy, manifest: { files: [...legacy.manifest.files, helper] } })).toThrow('INSTALL_RELEASE_CONTROLS_REQUIRED')
    const fresh = { ...legacy, manifest: { files: [...legacy.manifest.files, helper, declaration] } }
    expect(() => assertFreshInstallReleaseControls(fresh)).not.toThrow()
    expect(() => assertFreshInstallReleaseControls({ ...fresh, lifecycleControlsPresent: false })).toThrow('INSTALL_RELEASE_CONTROLS_REQUIRED')
  })

  it('requires complete explicit trust and never accepts a caller-selected root or provider', () => {
    expect(parseBootstrapArgs(['plan', ...options])).toEqual({ phase: 'plan', artifactPath: '/root/releases/xpanel-release-0.1.0.tar.gz', artifactSha256: 'a'.repeat(64), trustPath: '/root/protected/archive-trust.json', keysPath: '/root/protected/publisher-keys.json' })
    expect(parseBootstrapArgs(['admission'])).toEqual({ phase: 'admission' })
    expect(parseBootstrapArgs(['capture'])).toEqual({ phase: 'capture' })
    for (const argv of [['plan'], ['prepare', ...options.slice(0, 3)], ['capture', ...options], ['activate'], ['plan', ...options, '--root=/tmp/xpanel'], ['plan', ...options, options[0]!]]) {
      expect(() => parseBootstrapArgs(argv)).toThrow()
    }
  })

  it.each([
    ['--artifact=relative.tar.gz', 0], ['--artifact=/root/a/../release.tar.gz', 0], ['--artifact=/root/release.zip', 0],
    ['--artifact-sha256=AAAA', 1], ['--release-trust-file=/tmp/trust.json', 2], ['--release-keys-file=/home/owner/keys.json', 3],
    [`--artifact-sha257=${'a'.repeat(64)}`, 1],
    ['--release-keys-file=/root/keys.json\n--root=/tmp', 3],
  ] as const)('rejects unsafe input %s', (value, index) => {
    const changed = [...options]; changed[index] = value
    expect(() => parseBootstrapArgs(['plan', ...changed])).toThrow()
  })

  it('plans without probing the filesystem or claiming source/dependency/readiness verification', async () => {
    const output: string[] = [], errors: string[] = []
    const code = await runBootstrapCli(['plan', ...options], { stdout: { write: value => output.push(value) }, stderr: { write: value => errors.push(value) } })
    expect(code).toBe(0); expect(errors).toEqual([])
    expect(JSON.parse(output.join(''))).toEqual({ status: 'plan', existingInstallations: 'refused', nativeExecution: 'not_run', installationReceipt: 'pending' })
  })

  it('rejects extra native option fields before platform or host checks', async () => {
    await expect(prepareNewInstallation({ artifactPath: '/root/release.tar.gz', artifactSha256: 'a'.repeat(64), trustPath: '/root/trust.json', keysPath: '/root/keys.json', root: '/tmp/fake', statProvider: () => ({ uid: 0 }) } as never)).rejects.toThrow('INSTALL_OPTIONS_INVALID')
    await expect(prepareNewInstallation({ phase: 'plan', artifactPath: '/root/release.tar.gz', artifactSha256: 'a'.repeat(64), trustPath: '/root/trust.json', keysPath: '/root/keys.json' } as never)).rejects.toThrow('INSTALL_OPTIONS_INVALID')
  })
})

describe('separate archive and publisher trust', () => {
  it('retains explicit package-manager hash and HMAC path without reading or copying secret values', () => {
    const value = archiveTrust(), parsed = parseBootstrapTrust(value)
    expect(parsed).toEqual(value); expect(Object.isFrozen(parsed)).toBe(true)
    value.keyId = 'changed'; expect(parsed.keyId).toBe('archive-anchor')
    for (const change of [{ signingKey: 'must-not-be-accepted' }, { packageManagerSha256: 'x'.repeat(64) }, { packageManagerPath: '/tmp/pnpm' }, { signingKeyPath: '/home2/user/key' }, { keyId: 'a'.repeat(65) }]) {
      expect(() => parseBootstrapTrust({ ...archiveTrust(), ...change })).toThrow('INSTALL_TRUST_INVALID')
    }
  })

  it('accepts Ed25519 public key rings and rejects secrets, duplicates and other algorithms', () => {
    const parsed = parseBootstrapKeys(keys())
    expect(parsed.keys[0]!.algorithm).toBe('ed25519'); expect(Object.isFrozen(parsed.keys)).toBe(true)
    for (const keyring of [
      { schemaVersion: 1, keys: [] }, { schemaVersion: 1, keys: Array.from({ length: 9 }, () => keys().keys[0]) },
      { schemaVersion: 1, keys: [keys().keys[0], keys().keys[0]] },
      { schemaVersion: 1, keys: [{ keyId: 'hmac', algorithm: 'hmac-sha256', secret: 'not-a-public-key' }] },
      { schemaVersion: 1, keys: [{ ...keys().keys[0], publicKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }] },
    ]) expect(() => parseBootstrapKeys(keyring)).toThrow('INSTALL_PUBLISHER_KEYS_INVALID')
  })
})

describe('native publisher wire binding before staging', () => {
  it('verifies the native six-field Ed25519 contract with unpacked bytes', () => {
    const value = signed()
    expect(verifyBootstrapPublisher(value, report(), keys())).toEqual(value)
    expect(Object.isFrozen(verifyBootstrapPublisher(value, report(), keys()))).toBe(true)
    expect(() => verifyBootstrapPublisher(value, { ...report(), totalUnpackedBytes: 100 }, keys())).toThrow('INSTALL_PUBLISHER_RELEASE_MISMATCH')
  })

  it.each([
    ['version', '0.2.0'], ['schemaVersion', 7], ['sha256', 'b'.repeat(64)], ['bytes', 123457],
  ] as const)('rejects changed %s even when the report repeats the modification', (field, value) => {
    const manifest = { ...signed(), [field]: value }, changed = { ...release, [field]: value }
    const repeated = { manifest: { version: changed.version, controlDbSchemaVersion: changed.schemaVersion }, archiveSha256: changed.sha256, totalUnpackedBytes: changed.bytes }
    expect(() => verifyBootstrapPublisher(manifest, repeated, keys())).toThrow('INSTALL_PUBLISHER_SIGNATURE_INVALID')
  })

  it('rejects malformed signatures, unknown publisher IDs, unsigned extras and prerelease versions', () => {
    expect(() => verifyBootstrapPublisher({ ...signed(), signature: '0'.repeat(128) }, report(), keys())).toThrow('INSTALL_PUBLISHER_SIGNATURE_INVALID')
    expect(() => verifyBootstrapPublisher({ ...signed(), keyId: 'unknown' }, report(), keys())).toThrow('INSTALL_PUBLISHER_UNTRUSTED')
    for (const manifest of [{ ...signed(), note: 'unsigned' }, { ...signed(), signature: 'a'.repeat(64) }, { ...signed(), version: '0.1.0-beta' }, { ...signed(), schemaVersion: 0 }]) {
      expect(() => verifyBootstrapPublisher(manifest, report(), keys())).toThrow('INSTALL_PUBLISHER_MANIFEST_INVALID')
    }
  })
})
