import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { handleSiteSoftwareRoute } from './site-software-catalog.ts'
import type { SiteSoftwareHelpers, SiteSoftwareView } from './site-software-catalog.ts'

const ROOT = { principal: { id: '11111111-1111-4111-8111-111111111111', kind: 'root', username: 'root' } } as AuthenticatedCaller
const RESELLER = { principal: { id: '22222222-2222-4222-8222-222222222222', kind: 'reseller', username: 'reseller1' } } as AuthenticatedCaller
const catalog = { state: 'read', reason: null, keyId: 'xpanel-release-2026', sequence: 3, issuedAt: '2026-11-06T11:00:00.000Z', expiresAt: '2026-11-20T12:00:00.000Z', revision: 'b'.repeat(64),
  applications: [{ id: 'sample', name: 'Sample', versions: ['1.2.3'], stored: [] }, { id: 'notes', name: 'Notes', versions: ['2.0.0'], stored: ['2.0.0'] }] }
const hostView = { trust: { state: 'configured', keyIds: ['xpanel-release-2026'], reason: null }, catalog }
let root = ''
function harness(callHost?: SiteSoftwareHelpers['callHost'], caller = ROOT) {
  const lease = { assertFencingToken: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
  const helpers = { requireCaller: vi.fn(async () => caller), emitAudit: vi.fn(async () => undefined), now: () => new Date('2026-11-07T08:00:00.000Z'), ...(callHost ? { callHost } : {}),
    store: { rootDir: root, getWriterLock: () => ({ acquire: async () => lease }) },
    assertRoot: vi.fn(async (who: AuthenticatedCaller) => { if (who.principal.kind !== 'root') fail('FORBIDDEN', 'root role is required') }) } as unknown as SiteSoftwareHelpers
  const send = (method: string, path = '/api/server/site-software', body?: unknown) => handleSiteSoftwareRoute(new Request('http://api.test' + path, { method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), new URL('http://api.test' + path), method, helpers)
  return { helpers, send, read: async () => (await (await send('GET'))!.json()) as SiteSoftwareView }
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xp-site-software-api-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('site software catalog workspace', { tags: ['unit'] }, () => {
  it('offers only applications of the verified signed catalog and withdraws them without it', async () => {
    const h = harness(async () => hostView)
    const first = await h.read()
    expect(first).toMatchObject({ host: hostView, offer: { state: 'default', offered: [] } })
    const saved = (await (await h.send('PUT', undefined, { offered: ['sample'], expectedRevision: first.offer.revision }))!.json()) as SiteSoftwareView
    expect(saved.offer).toMatchObject({ state: 'saved', offered: ['sample'], updatedAt: '2026-11-07T08:00:00.000Z' })
    expect(JSON.parse(await readFile(join(root, 'extended', 'panel', 'site-software.json'), 'utf8'))).toEqual({ version: 1, offered: ['sample'], updatedAt: '2026-11-07T08:00:00.000Z' })
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.site_software.updated', detail: { added: ['sample'], removed: [], offered: 1 } }))
    await expect(h.send('PUT', undefined, { offered: ['sample', 'unknown'], expectedRevision: saved.offer.revision })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'application_not_in_catalog' } })
    const offline = harness()
    await expect(offline.send('PUT', undefined, { offered: ['sample', 'notes'], expectedRevision: saved.offer.revision })).rejects.toMatchObject({ detail: { reason: 'application_not_in_catalog' } })
    const withdrawn = (await (await offline.send('PUT', undefined, { offered: [], expectedRevision: saved.offer.revision }))!.json()) as SiteSoftwareView
    expect(withdrawn).toMatchObject({ host: null, offer: { offered: [] } })
  })

  it('relays a verified import result and refuses malformed requests and resellers', async () => {
    const replies: unknown[] = []
    const h = harness(async (_caller, path, body) => { replies.push([path, body]); return path.endsWith('/import') ? { outcome: 'refused', reason: 'catalog_signer_untrusted', ...hostView } : hostView })
    const result = (await (await h.send('POST', '/api/server/site-software/catalog', { envelope: '{"keyId":"x"}' }))!.json()) as SiteSoftwareView
    expect(result.import).toEqual({ outcome: 'refused', reason: 'catalog_signer_untrusted' })
    expect(replies).toEqual([['/host/site-software/import', { envelope: '{"keyId":"x"}' }]])
    await expect(h.send('POST', '/api/server/site-software/catalog', { envelope: 1 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(harness(async () => ({ outcome: 'maybe' })).send('POST', '/api/server/site-software/catalog', { envelope: '{}' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true } })
    await expect(harness().send('POST', '/api/server/site-software/catalog', { envelope: '{}' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(harness(undefined, RESELLER).send('GET')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await harness(async () => ({ trust: 'forged' })).read()).host).toBeNull()
  })
})
