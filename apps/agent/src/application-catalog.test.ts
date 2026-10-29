import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { applicationCatalogSigningBytes, assertApplicationCatalogCurrent, compareApplicationVersions, parseApplicationCatalog, selectApplicationRelease, verifyApplicationCatalog } from './application-catalog.ts'
import type { ApplicationCatalogPolicy } from './application-catalog.ts'

const pair = generateKeyPairSync('ed25519')
const keys = [{ keyId: 'apps-2026', publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }]
const policy: ApplicationCatalogPolicy = { now: new Date('2026-10-27T12:00:00.000Z'), minimumSequence: 7, panelVersion: '1.4.2' }
const catalog = () => ({ schemaVersion: 1, sequence: 7, issuedAt: '2026-10-27T11:00:00.000Z', expiresAt: '2026-10-28T12:00:00.000Z', applications: [{ id: 'sample', name: 'Sample', releases: [{ version: '1.2.3', minimumPanelVersion: '1.0.0', artifact: { format: 'xpanel-files-v1', sha256: 'a'.repeat(64), bytes: 99 } }] }] })
const signed = (value: unknown = catalog(), keyId = 'apps-2026') => { const payload = JSON.stringify(value); return { keyId, payload, signature: sign(null, applicationCatalogSigningBytes(payload), pair.privateKey).toString('hex') } }

describe('trusted signed application catalog', () => {
  it('verifies trusted Ed25519 canonical bytes and retains only frozen, validated catalog data', () => {
    const value = verifyApplicationCatalog(signed(), keys, policy)
    expect(value.sequence).toBe(7)
    expect(value.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.isFrozen(value.applications[0]!.releases[0]!.artifact)).toBe(true)
    expect(selectApplicationRelease(value, 'sample', '1.2.3', policy).artifact.bytes).toBe(99)
    expect(() => assertApplicationCatalogCurrent({ ...value }, policy)).toThrow(/verified/)
  })
  it('refuses an untrusted signer, tampered payload/signature, unsigned fields and non-Ed25519 keys', () => {
    const good = signed()
    expect(() => verifyApplicationCatalog(good, [], policy)).toThrow(/trusted/)
    expect(() => verifyApplicationCatalog({ ...good, keyId: 'request-key' }, keys, policy)).toThrow(/trusted/)
    expect(() => verifyApplicationCatalog({ ...good, payload: good.payload.replace('Sample', 'Changed') }, keys, policy)).toThrow()
    expect(() => verifyApplicationCatalog({ ...good, signature: '0'.repeat(128) }, keys, policy)).toThrow()
    expect(() => verifyApplicationCatalog({ ...good, url: 'https://untrusted.invalid' }, keys, policy)).toThrow()
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    expect(() => verifyApplicationCatalog(good, [{ ...keys[0]!, publicKeyPem: rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString() }], policy)).toThrow()
    expect(() => verifyApplicationCatalog(good, [keys[0]!, keys[0]!], policy)).toThrow(/trust configuration/)
  })
  it.each([
    { sequence: 6 }, { expiresAt: '2026-10-27T12:00:00.000Z' }, { issuedAt: '2026-10-28T12:00:00.000Z' },
    { expiresAt: '2026-12-27T12:00:00.000Z' }, { issuedAt: '2026-02-30T12:00:00.000Z' },
  ])('rejects stale, expired or invalid clock metadata %j', override => {
    expect(() => verifyApplicationCatalog(signed({ ...catalog(), ...override }), keys, policy)).toThrow()
  })
  it('checks current policy again at selection and refuses incompatible or unsigned releases', () => {
    const value = verifyApplicationCatalog(signed(), keys, policy)
    expect(() => selectApplicationRelease(value, 'sample', '1.2.3', { ...policy, panelVersion: '0.9.0' })).toThrow(/newer panel/)
    expect(() => selectApplicationRelease(value, 'sample', '1.2.4', policy)).toThrow(/signed catalog/)
    expect(() => selectApplicationRelease(value, 'sample', '1.2.3', { ...policy, minimumSequence: 8 })).toThrow()
    expect(() => selectApplicationRelease(value, 'sample', '1.2.3', { ...policy, now: new Date('2026-10-29T00:00:00Z') })).toThrow()
  })
  it('refuses duplicate/unsorted entries, unknown artifact transport, noncanonical JSON and unsafe labels', () => {
    const app = catalog().applications[0]!
    for (const value of [{ ...catalog(), applications: [app, app] }, { ...catalog(), applications: [{ ...app, releases: [app.releases[0], app.releases[0]] }] }, { ...catalog(), applications: [{ ...app, name: 'bad\u202etext' }] }, { ...catalog(), applications: [{ ...app, releases: [{ ...app.releases[0], artifact: { ...app.releases[0]!.artifact, url: 'https://untrusted.invalid' } }] }] }]) expect(() => verifyApplicationCatalog(signed(value), keys, policy)).toThrow()
    const payload = JSON.stringify(catalog()).replace('"schemaVersion":1', '"schemaVersion":0,"schemaVersion":1')
    expect(() => verifyApplicationCatalog({ keyId: 'apps-2026', payload, signature: sign(null, applicationCatalogSigningBytes(payload), pair.privateKey).toString('hex') }, keys, policy)).toThrow()
    expect(() => parseApplicationCatalog({ ...catalog(), schemaVersion: 2 })).toThrow()
    expect(compareApplicationVersions('1.10.0', '1.9.9')).toBe(1)
    expect(() => compareApplicationVersions('1.02.0', '1.2.0')).toThrow()
  })
})
