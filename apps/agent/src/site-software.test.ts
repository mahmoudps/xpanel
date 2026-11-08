import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applicationCatalogSigningBytes } from './application-catalog.ts'
import { SITE_SOFTWARE_STATE_PATH, handleSiteSoftwareHostRoute, parseSiteSoftwareOffer, readSiteSoftwareOffer } from './site-software.ts'
import type { SiteSoftwareRouteContext } from './site-software.ts'
import { createSwApplicationCatalogSource } from './sw-application-catalog-store.ts'

const release = generateKeyPairSync('ed25519'), stranger = generateKeyPairSync('ed25519')
const pem = release.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const payload = (sequence: number) => JSON.stringify({ schemaVersion: 1, sequence, issuedAt: '2026-11-06T11:00:00.000Z', expiresAt: '2026-11-20T12:00:00.000Z',
  applications: [{ id: 'sample', name: 'Sample', releases: [{ version: '1.2.3', minimumPanelVersion: '1.0.0', artifact: { format: 'xpanel-files-v1', sha256: 'a'.repeat(64), bytes: 99 } }] }] })
const envelope = (sequence: number, key = release.privateKey) => JSON.stringify({ keyId: 'xpanel-release-2026', payload: payload(sequence), signature: sign(null, applicationCatalogSigningBytes(payload(sequence)), key).toString('hex') })
const now = () => new Date('2026-11-07T12:00:00.000Z')
let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xp-site-software-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function source(stored: string | null = null) {
  const state = { envelope: stored, floor: null as string | null }
  return createSwApplicationCatalogSource({ readTrust: async () => ({ state: 'configured', keys: [{ keyId: 'xpanel-release-2026', publicKeyPem: pem }], reason: null }),
    readEnvelope: async () => state.envelope, writeEnvelope: async text => { state.envelope = text }, readFloor: async () => state.floor, writeFloor: async text => { state.floor = text } }, '1.4.2', now)
}
const call = (ctx: SiteSoftwareRouteContext, path: string, body?: unknown) => handleSiteSoftwareHostRoute(new Request('http://agent' + path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  new URL('http://agent' + path), body === undefined ? 'GET' : 'POST', ctx)
const context = (role = 'root', catalog: ReturnType<typeof source> | null = source()): SiteSoftwareRouteContext & { audit: ReturnType<typeof vi.fn> } => ({ authenticate: async () => ({ actor: role, role }), source: catalog, audit: vi.fn(async () => undefined) })

describe('site software catalog', { tags: ['unit'] }, () => {
  it('imports only a catalog the release key signed and reports the refusal reason otherwise', async () => {
    const ctx = context()
    expect(await (await call(ctx, '/host/site-software'))!.json()).toMatchObject({ trust: { state: 'configured', keyIds: ['xpanel-release-2026'] }, catalog: { state: 'unavailable', reason: 'application_catalog_unavailable' } })
    const imported = await (await call(ctx, '/host/site-software/import', { envelope: envelope(3) }))!.json()
    expect(imported).toMatchObject({ outcome: 'imported', catalog: { state: 'read', keyId: 'xpanel-release-2026', sequence: 3, applications: [{ id: 'sample', name: 'Sample', versions: ['1.2.3'] }] } })
    expect(ctx.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.site_software.catalog_imported', outcome: 'ok', detail: expect.objectContaining({ sequence: 3 }) }))
    expect(await (await call(ctx, '/host/site-software/import', { envelope: envelope(4, stranger.privateKey) }))!.json()).toMatchObject({ outcome: 'refused', reason: 'catalog_invalid', catalog: { sequence: 3 } })
    expect(await (await call(ctx, '/host/site-software/import', { envelope: envelope(2) }))!.json()).toMatchObject({ outcome: 'refused', reason: 'catalog_invalid', catalog: { sequence: 3 } })
    expect(await (await call(ctx, '/host/site-software/import', { envelope: JSON.stringify({ ...JSON.parse(envelope(5)), keyId: 'other-key' }) }))!.json()).toMatchObject({ outcome: 'refused', reason: 'catalog_signer_untrusted' })
    expect(ctx.audit).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'failed', detail: { reason: 'catalog_signer_untrusted' } }))
  })

  it('is root only, strict about its body and truthful without an installed release', async () => {
    await expect(call(context('reseller'), '/host/site-software')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call(context(), '/host/site-software/import', { envelope: envelope(1), extra: true })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await (await call(context('root', null), '/host/site-software'))!.json()).toMatchObject({ trust: { reason: 'installed_release_unavailable' }, catalog: { state: 'unavailable' } })
    await expect(call(context('root', null), '/host/site-software/import', { envelope: envelope(1) })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'installed_release_unavailable' } })
  })

  it('offers nothing until root chooses and nothing when the saved offer cannot be verified', async () => {
    expect(await readSiteSoftwareOffer(root)).toEqual([])
    const path = join(root, SITE_SOFTWARE_STATE_PATH)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ version: 1, offered: ['sample'], updatedAt: '2026-11-07T08:00:00.000Z' }))
    expect(await readSiteSoftwareOffer(root)).toEqual(['sample'])
    await writeFile(path, JSON.stringify({ version: 1, offered: ['Sample!'], updatedAt: '2026-11-07T08:00:00.000Z' }))
    expect(await readSiteSoftwareOffer(root)).toBeNull()
    expect(parseSiteSoftwareOffer({ version: 1, offered: ['b', 'a'], updatedAt: '2026-11-07T08:00:00.000Z' })).toBeNull()
  })
})
