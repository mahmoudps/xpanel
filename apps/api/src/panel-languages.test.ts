import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import { requestLocale, translator } from '../../web/src/i18n.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { handlePanelLanguagesRoute, installSavedLanguages, parseLanguagePolicyUpdate } from './panel-languages.ts'
import type { PanelLanguagesHelpers, PanelLanguagesView } from './panel-languages.ts'

const ROOT = { principal: { id: '11111111-1111-4111-8111-111111111111', kind: 'root', username: 'root' }, sessionId: 'one', apiTokenId: null } as AuthenticatedCaller
const RESELLER = { principal: { id: '22222222-2222-4222-8222-222222222222', kind: 'reseller', username: 'reseller1' }, sessionId: 'two', apiTokenId: null } as AuthenticatedCaller
const stamp = '2026-10-29T12:00:00.000Z'
const po = (body: string, language = 'ar') => `msgid ""\nmsgstr ""\n"Language: ${language}\\n"\n"Content-Type: text/plain; charset=UTF-8\\n"\n\n${body}\n`
const GOOD = po('msgid "(sent to {address})"\nmsgstr "(delivered to {address})"')
let root = ''
function harness(caller = ROOT, overrides: Partial<PanelLanguagesHelpers> = {}) {
  const lease = { assertFencingToken: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
  const helpers = { requireCaller: vi.fn(async () => caller), emitAudit: vi.fn(async () => undefined), now: () => new Date(stamp), onPolicySaved: vi.fn(),
    assertRoot: vi.fn(async (actor: AuthenticatedCaller) => { if (actor.principal.kind !== 'root') fail('FORBIDDEN', 'root required') }),
    store: { rootDir: root, getWriterLock: () => ({ acquire: async () => lease }) }, ...overrides } as unknown as PanelLanguagesHelpers & { onPolicySaved: ReturnType<typeof vi.fn> }
  const send = (method = 'GET', path = '/api/server/panel/languages', body?: unknown, headers: Record<string, string> = {}) => handlePanelLanguagesRoute(new Request('http://api.test' + path, { method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : body instanceof Uint8Array ? new Blob([body as Uint8Array<ArrayBuffer>]) : JSON.stringify(body) }) }), new URL('http://api.test' + path), method, helpers)
  const read = async () => (await (await send())!.json()) as PanelLanguagesView
  const upload = async (catalog: string | Uint8Array, tag = 'ar', type = 'text/x-gettext-translation') =>
    send('PUT', `/api/server/panel/languages/${tag}/catalog?expectedRevision=${(await read()).revision}`, catalog, { 'content-type': type })
  return { helpers, lease, send, read, upload }
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xp-languages-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }); await installSavedLanguages(root) })

describe('panel languages policy', () => {
  it('lists every registry locale with release defaults and no-store', async () => {
    const h = harness(), response = (await h.send())!, view = await response.json() as PanelLanguagesView
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(view).toMatchObject({ defaultLocale: 'en', policyState: 'default', updatedAt: null })
    expect(view.locales.map(row => [row.tag, row.source, row.offered, row.override, row.overrideState, row.runtime])).toEqual([['en', true, true, null, 'none', 'applied'], ['ar', false, true, null, 'none', 'applied']])
    expect(view.locales.every(row => row.messages > 1000)).toBe(true)
  })
  it('saves offered locales and the default under the lease, applies and audits them', async () => {
    const h = harness(), before = await h.read()
    const view = await (await h.send('PUT', '/api/server/panel/languages', { offered: ['ar'], defaultLocale: 'ar', expectedRevision: before.revision }))!.json() as PanelLanguagesView
    expect(view).toMatchObject({ defaultLocale: 'ar', policyState: 'saved', updatedAt: stamp })
    expect(view.locales.map(row => row.offered)).toEqual([false, true])
    expect(view.revision).not.toBe(before.revision)
    expect(JSON.parse(await readFile(join(root, 'extended', 'locales', 'policy.json'), 'utf8'))).toEqual({ version: 1, offered: ['ar'], defaultLocale: 'ar', updatedAt: stamp, updatedBy: 'root' })
    expect(h.helpers.onPolicySaved).toHaveBeenCalledWith({ offered: ['ar'], defaultLocale: 'ar' })
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'panel.languages.updated', detail: { offered: ['ar'], defaultLocale: 'ar' } }))
    expect(h.lease.release).toHaveBeenCalledOnce()
    await expect(h.send('PUT', '/api/server/panel/languages', { offered: ['en', 'ar'], defaultLocale: 'en', expectedRevision: before.revision })).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
  })
  it('refuses empty, unknown, duplicate and non-offered default choices', () => {
    const revision = 'a'.repeat(64)
    for (const body of [{ offered: [], defaultLocale: 'en' }, { offered: ['fr'], defaultLocale: 'fr' }, { offered: ['en', 'en'], defaultLocale: 'en' }, { offered: ['ar'], defaultLocale: 'en' }, { offered: ['en'], defaultLocale: 'en', extra: 1 }])
      expect(() => parseLanguagePolicyUpdate({ ...body, expectedRevision: revision })).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
    expect(parseLanguagePolicyUpdate({ offered: ['ar', 'en'], defaultLocale: 'ar', expectedRevision: revision })).toEqual({ offered: ['en', 'ar'], defaultLocale: 'ar', expectedRevision: revision })
  })
  it('is root only and refuses selectors, unknown locales and other methods', async () => {
    const reseller = harness(RESELLER)
    await expect(reseller.read()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const h = harness()
    expect(await h.send('GET', '/api/server/panel/languages/ar')).toBeNull()
    await expect(h.send('GET', '/api/server/panel/languages?lang=ar')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(h.send('GET', '/api/server/panel/languages/fr/catalog')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const result = (await h.send('POST'))!
    expect(result.status).toBe(405); expect(result.headers.get('allow')).toBe('GET, PUT')
  })
  it('reports an invalid saved policy without installing it', async () => {
    await mkdir(join(root, 'extended', 'locales'), { recursive: true })
    await writeFile(join(root, 'extended', 'locales', 'policy.json'), JSON.stringify({ version: 1, offered: ['ar'], defaultLocale: 'en' }))
    expect(await harness().read()).toMatchObject({ policyState: 'invalid', defaultLocale: 'en' })
    expect((await installSavedLanguages(root)).policy).toBe('invalid')
    expect(requestLocale(new URL('http://x/'), new Request('http://x/'))).toBe('en')
  })
})

describe('panel language catalogs', () => {
  it('uploads a valid catalog, reports restart required, downloads it merged and applies it at start', async () => {
    const h = harness(), view = await (await h.upload(GOOD))!.json() as PanelLanguagesView
    const ar = view.locales.find(row => row.tag === 'ar')!
    expect(ar).toMatchObject({ overrideState: 'saved', runtime: 'restart_required', override: { entries: 1, uploadedAt: stamp, uploadedBy: 'root' } })
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'panel.languages.catalog_uploaded', target: 'locale:ar' }))
    const download = (await h.send('GET', '/api/server/panel/languages/ar/catalog'))!
    expect(download.headers.get('content-type')).toBe('text/x-gettext-translation; charset=utf-8')
    expect(download.headers.get('content-disposition')).toBe('attachment; filename="ar.po"')
    expect(await download.text()).toContain('msgid "(sent to {address})"\nmsgstr "(delivered to {address})"')
    const asJson = await (await h.send('GET', '/api/server/panel/languages/ar/catalog', undefined, { accept: 'application/json' }))!.json() as { filename: string; catalog: string }
    expect(asJson.filename).toBe('ar.po')
    expect(await installSavedLanguages(root)).toMatchObject({ applied: ['ar'], rejected: [] })
    expect(translator('ar')('(sent to {address})', { address: 'a@b.test' })).toBe('(delivered to a@b.test)')
    expect((await h.read()).locales.find(row => row.tag === 'ar')!.runtime).toBe('applied')
  })
  it('offers a template for the source locale and refuses uploads to it', async () => {
    const h = harness(), template = await (await h.send('GET', '/api/server/panel/languages/en/catalog'))!.text()
    expect(template).toContain('"Language: \\n"')
    expect(template).toContain('msgid "(sent to {address})"\nmsgstr ""')
    await expect(h.upload(po('', 'en'), 'en')).rejects.toMatchObject({ code: 'VALIDATION', detail: { fields: [{ field: 'catalog', code: 'source_locale' }], stateChanged: false } })
  })
  it('refuses invalid catalogs with field errors and changes nothing', async () => {
    const h = harness()
    const cases: [string, Record<string, unknown>][] = [
      [po('msgid "(sent to {address})"\nmsgstr "x"', 'en'), { field: 'Language', code: 'language_mismatch' }],
      [po('msgid "No such message anywhere"\nmsgstr "x"'), { field: 'msgstr', code: 'unknown_message', line: 6, msgid: 'No such message anywhere' }],
      [po('msgid "(sent to {address})"\nmsgstr "(sent to {recipient})"'), { code: 'placeholder_mismatch', line: 6 }],
      [po('msgid "(sent to {address})"\nmsgstr "(sent to {address"'), { code: 'invalid_message' }],
      [po('msgid "(sent to {address})"\nmsgstr "١ {address}"'), { code: 'non_ascii_digits' }],
      [po('msgid "(sent to {address})"\nmsgstr "x"\nbogus'), { field: 'catalog', code: 'syntax', line: 8 }],
    ]
    for (const [catalog, problem] of cases) await expect(h.upload(catalog)).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false, fields: [expect.objectContaining(problem)] } })
    await expect(h.upload(new Uint8Array([0xff, 0xfe, 0x00]))).rejects.toMatchObject({ code: 'VALIDATION', detail: { fields: [{ field: 'catalog', code: 'encoding' }] } })
    await expect(h.upload(GOOD, 'ar', 'application/json')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(h.send('PUT', '/api/server/panel/languages/ar/catalog', GOOD, { 'content-type': 'text/x-gettext-translation' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(h.send('PUT', '/api/server/panel/languages/ar/catalog?expectedRevision=' + 'a'.repeat(64) + '&x=1', GOOD, { 'content-type': 'text/x-gettext-translation' })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await h.read()).locales[1]!.overrideState).toBe('none')
    expect(h.helpers.emitAudit).not.toHaveBeenCalled()
  })
  it('removes an upload bound to the observed revision', async () => {
    const h = harness()
    await h.upload(GOOD)
    const stale = (await h.read()).revision
    await h.send('PUT', '/api/server/panel/languages', { offered: ['en', 'ar'], defaultLocale: 'en', expectedRevision: stale })
    await expect(h.send('DELETE', '/api/server/panel/languages/ar/catalog', { expectedRevision: stale })).rejects.toMatchObject({ code: 'CONFLICT' })
    const view = await (await h.send('DELETE', '/api/server/panel/languages/ar/catalog', { expectedRevision: (await h.read()).revision }))!.json() as PanelLanguagesView
    expect(view.locales[1]).toMatchObject({ overrideState: 'none', override: null, runtime: 'applied' })
    await expect(readFile(join(root, 'extended', 'locales', 'ar.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(h.send('DELETE', '/api/server/panel/languages/ar/catalog', { expectedRevision: view.revision })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('does not apply a saved catalog that no longer validates and says so', async () => {
    const h = harness()
    await h.upload(GOOD)
    const path = join(root, 'extended', 'locales', 'ar.json'), record = JSON.parse(await readFile(path, 'utf8'))
    const stale = po('msgid "Removed in this release"\nmsgstr "x"')
    await writeFile(path, JSON.stringify({ ...record, catalog: stale, sha256: createHash('sha256').update(stale).digest('hex') }))
    expect(await installSavedLanguages(root)).toMatchObject({ applied: [], rejected: ['ar'] })
    expect((await h.read()).locales[1]!.runtime).toBe('rejected')
    expect(translator('ar')('(sent to {address})', { address: 'x' })).not.toContain('delivered')
  })
})
