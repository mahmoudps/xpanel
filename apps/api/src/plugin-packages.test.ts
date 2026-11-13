import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { savedFeatureKeys, shownFeatureKeys, tools } from '@xpanel/catalog'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { assertFeatureKeys } from '@xpanel/state'
import { handlePluginPackagesRoute, parsePluginPackage, pluginFeatures } from './plugin-packages.ts'
import type { PluginPackagesHelpers, PluginRow } from './plugin-packages.ts'

const ROOT = { principal: { id: '11111111-1111-4111-8111-111111111111', kind: 'root', username: 'root' }, sessionId: 's1', apiTokenId: null } as AuthenticatedCaller
const RESELLER = { principal: { id: '22222222-2222-4222-8222-222222222222', kind: 'reseller', username: 'reseller1' } } as AuthenticatedCaller
const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333'
const OWNER = { principal: { id: ACCOUNT_ID, kind: 'user', username: 'alice', accountId: ACCOUNT_ID }, sessionId: 's3', apiTokenId: null, scopes: ['*'] } as unknown as AuthenticatedCaller
const png = (width: number, height: number): string => {
  const bytes = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12, 'latin1'); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20)
  return bytes.toString('base64')
}
const svg = (body: string, size = 48): string => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 48 48">${body}</svg>`).toString('base64')
const item = (overrides: Record<string, unknown> = {}) => ({ id: 'notes', name: 'Notes', group: 'Apps', priority: 10, uri: '/files', feature: null, icon: { type: 'image/png', data: png(48, 48) }, ...overrides })
const pkg = (overrides: Record<string, unknown> = {}) => ({ format: 'xpanel-plugin-package-v1', name: 'acme', items: [item()], ...overrides })
const account = { id: ACCOUNT_ID, username: 'alice', status: 'active', planId: 'plan-1' }
let root = '', disabled: string[] = []
function harness(caller = ROOT) {
  const lease = { assertFencingToken: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
  const helpers = { requireCaller: vi.fn(async () => caller), emitAudit: vi.fn(async () => undefined), now: () => new Date('2026-11-07T08:00:00.000Z'),
    store: { rootDir: root, getWriterLock: () => ({ acquire: async () => lease }), getAccount: async () => account, getPlan: async () => ({ id: 'plan-1', featureListId: 'list-1' }), getFeatureList: async () => ({ id: 'list-1', disabled }) },
    assertRoot: vi.fn(async (who: AuthenticatedCaller) => { if (who.principal.kind !== 'root') fail('FORBIDDEN', 'root role is required') }) } as unknown as PluginPackagesHelpers
  const send = (method: string, path = '/api/server/plugins', body?: unknown) => handlePluginPackagesRoute(new Request('http://api.test' + path, { method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), new URL('http://api.test' + path), method, helpers)
  const plugins = async (response: Response | null) => ((await response!.json()) as { plugins: PluginRow[] }).plugins
  return { helpers, send, plugins }
}
const refusal = (reason: string) => ({ code: 'VALIDATION', detail: { reason, stateChanged: false } })
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xp-plugins-')); disabled = [] })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('plugin packages', { tags: ['feature'] }, () => {
  it('generates a download, installs it, lists it without icons, downloads and deletes it', async () => {
    const h = harness()
    expect(await h.plugins(await h.send('GET'))).toEqual([])
    const generated = await h.send('POST', '/api/server/plugin-generator', { name: 'acme', items: [item()], overwrite: false })
    expect(generated!.headers.get('content-disposition')).toBe('attachment; filename="acme.xpanel-plugin.json"')
    const built = await generated!.json()
    expect(built).toEqual(pkg())
    expect(await h.plugins(await h.send('GET'))).toEqual([])
    const [row] = await h.plugins(await h.send('POST', undefined, { package: built, overwrite: false }))
    expect(row).toMatchObject({ name: 'acme', state: 'installed', installedBy: 'root', installedAt: '2026-11-07T08:00:00.000Z' })
    expect(row!.items[0]).toEqual({ id: 'notes', name: 'Notes', group: 'Apps', priority: 10, uri: '/files', feature: null })
    expect(JSON.parse(await readFile(join(root, 'extended/panel/plugins/acme.json'), 'utf8'))).toMatchObject({ version: 1, package: { name: 'acme' } })
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.plugin.installed', target: 'plugin:acme' }))
    expect(await (await h.send('GET', '/api/server/plugins/acme/package'))!.json()).toEqual(pkg())
    expect(await h.plugins(await h.send('DELETE', '/api/server/plugins/acme'))).toEqual([])
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.plugin.deleted', target: 'plugin:acme' }))
    await expect(h.send('DELETE', '/api/server/plugins/acme')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('adds a plugin: key to the Feature Manager, gates the item with it and audits a cPanel archive install', async () => {
    const h = harness()
    await h.send('POST', undefined, { package: pkg({ items: [item({ feature: 'plugin:acme_notes' }), item({ id: 'open', name: 'Open' })] }), overwrite: false })
    expect(await pluginFeatures(root)).toEqual([{ key: 'plugin:acme_notes', label: 'Notes' }])
    expect(assertFeatureKeys(['plugin:Acme_notes'])).toEqual(['plugin:Acme_notes'])
    // Feature Manager sends catalog labels; the store takes the tool ids behind them, and they read back as the label.
    const labels = [...new Set(tools.flatMap(tool => tool.featureKey ?? []))]
    const saved = assertFeatureKeys(savedFeatureKeys(labels))
    expect(shownFeatureKeys(saved).sort()).toEqual(labels.sort())
    expect(savedFeatureKeys(['Analog Stats'])).toEqual(['web-stats-analog'])
    expect(shownFeatureKeys(['ssl-csrs'])).toEqual(['ssl-csrs'])
    expect(() => assertFeatureKeys(['plugin:a b'])).toThrow()
    const owner = harness(OWNER), read = async () => ((await (await owner.send('GET', '/api/account/plugins'))!.json()) as { items: { id: string }[] }).items.map(row => row.id)
    expect(await read()).toEqual(['notes', 'open'])
    disabled = ['plugin:acme_notes']
    expect(await read()).toEqual(['open'])
    expect(() => parsePluginPackage(pkg({ items: [item({ feature: 'plugin:' })] }))).toThrowError(expect.objectContaining(refusal('plugin_item_feature')))
    await expect(h.send('POST', undefined, { archive: 'not base64!', name: 'acme', overwrite: false })).rejects.toMatchObject(refusal('plugin_archive_format'))
    await expect(h.send('POST', undefined, { archive: 'AAAA', overwrite: false })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('refuses a duplicate name without overwrite, replaces it with overwrite and never takes an item id from another plugin', async () => {
    const h = harness()
    await h.send('POST', undefined, { package: pkg(), overwrite: false })
    await expect(h.send('POST', '/api/server/plugin-generator', { name: 'acme', items: [item()], overwrite: false })).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'plugin_exists' } })
    await expect(h.send('POST', undefined, { package: pkg(), overwrite: false })).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'plugin_exists' } })
    expect((await h.send('POST', '/api/server/plugin-generator', { name: 'acme', items: [item()], overwrite: true }))!.status).toBe(200)
    const [row] = await h.plugins(await h.send('POST', undefined, { package: pkg({ items: [item({ name: 'Renamed' })] }), overwrite: true }))
    expect(row!.items[0]!.name).toBe('Renamed')
    await expect(h.send('POST', undefined, { package: pkg({ name: 'other' }), overwrite: true })).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'plugin_item_exists', plugin: 'acme' } })
  })

  it('checks the icon size and refuses anything but drawing elements in an SVG', () => {
    expect(parsePluginPackage(pkg({ items: [item({ icon: { type: 'image/svg+xml', data: svg('<g fill="#123456"><path d="M0 0h48v48z"/></g>') } })] })).items[0]!.icon.type).toBe('image/svg+xml')
    const icon = (type: string, data: string) => () => parsePluginPackage(pkg({ items: [item({ icon: { type, data } })] }))
    expect(icon('image/png', png(64, 64))).toThrow(expect.objectContaining(refusal('plugin_icon_size')))
    expect(icon('image/svg+xml', svg('', 64))).toThrow(expect.objectContaining(refusal('plugin_icon_size')))
    for (const hostile of ['<script>alert(1)</script>', '<image href="https://example.test/x.png"/>', '<a href="javascript:alert(1)"><path d="M0 0"/></a>', '<path onload="alert(1)" d="M0 0"/>', '<path fill="url(https://example.test/x)" d="M0 0"/>',
      '<style>path{fill:red}</style>', '<!-- note --><path d="M0 0"/>', '<foreignObject></foreignObject>', 'text', '</svg><svg xmlns="http://www.w3.org/2000/svg" width="48" height="48">'])
      expect(icon('image/svg+xml', svg(hostile)), hostile).toThrow(expect.objectContaining(refusal('plugin_icon_format')))
    expect(icon('image/png', Buffer.from('not a png').toString('base64'))).toThrow(expect.objectContaining(refusal('plugin_icon_format')))
    expect(icon('image/png', 'not base64!')).toThrow(expect.objectContaining(refusal('plugin_icon_format')))
    expect(icon('image/gif', png(48, 48))).toThrow(expect.objectContaining(refusal('plugin_icon_format')))
  })

  it('refuses every item field outside its grammar with a stable reason', () => {
    const parse = (overrides: Record<string, unknown>) => () => parsePluginPackage(pkg({ items: [item(overrides)] }))
    expect(() => parsePluginPackage({ ...pkg(), format: 'other' })).toThrow(expect.objectContaining(refusal('plugin_package_format')))
    expect(() => parsePluginPackage(pkg({ name: 'Bad Name' }))).toThrow(expect.objectContaining(refusal('plugin_name')))
    expect(() => parsePluginPackage(pkg({ items: [] }))).toThrow(expect.objectContaining(refusal('plugin_items')))
    expect(() => parsePluginPackage(pkg({ items: [item(), item()] }))).toThrow(expect.objectContaining(refusal('plugin_item_duplicate')))
    expect(parse({ id: 'A' })).toThrow(expect.objectContaining(refusal('plugin_item_id')))
    expect(parse({ name: '<b>' })).toThrow(expect.objectContaining(refusal('plugin_item_name')))
    expect(parse({ group: ' ' })).toThrow(expect.objectContaining(refusal('plugin_item_group')))
    expect(parse({ priority: 100 })).toThrow(expect.objectContaining(refusal('plugin_item_priority')))
    for (const uri of ['javascript:alert(1)', 'http://example.test/', '//example.test', '/files/../whm', 'data:text/html,x', 'https://user:pass@example.test/'])
      expect(parse({ uri }), uri).toThrow(expect.objectContaining(refusal('plugin_item_uri')))
    expect(parse({ feature: 'not-a-tool' })).toThrow(expect.objectContaining(refusal('plugin_item_feature')))
    expect(parse({ feature: 'list-accounts' })).toThrow(expect.objectContaining(refusal('plugin_item_feature')))
  })

  it('shows account owners the items their plan allows, in group and priority order, with their icons', async () => {
    const icons = { type: 'image/svg+xml', data: svg('<circle cx="24" cy="24" r="20"/>') }
    await harness().send('POST', undefined, { package: pkg({ items: [item({ id: 'b', group: 'Tools', priority: 2, name: 'Second' }), item({ id: 'a', group: 'Tools', priority: 1, name: 'First', uri: 'https://example.test/app', icon: icons }), item({ id: 'c', group: 'Apps', feature: 'file-manager' })] }), overwrite: false })
    const h = harness(OWNER)
    const read = async () => ((await (await h.send('GET', '/api/account/plugins'))!.json()) as { items: { id: string; uri: string; icon: string }[] }).items
    expect((await read()).map(entry => entry.id)).toEqual(['c', 'a', 'b'])
    expect((await read())[1]).toMatchObject({ plugin: 'acme', id: 'a', uri: 'https://example.test/app', icon: '/api/account/plugins/acme/a/icon' })
    const image = await h.send('GET', '/api/account/plugins/acme/a/icon')
    expect(image!.headers.get('content-type')).toBe('image/svg+xml')
    expect(image!.headers.get('content-security-policy')).toContain('sandbox')
    expect(image!.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await image!.arrayBuffer()).toString('base64')).toBe(icons.data)
    disabled = ['file-manager']
    expect((await read()).map(entry => entry.id)).toEqual(['a', 'b'])
    await expect(h.send('GET', '/api/account/plugins/acme/c/icon')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(harness(ROOT).send('GET', '/api/account/plugins')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('keeps management to root, skips a tampered file for accounts and lists it as invalid for root', async () => {
    await expect(harness(RESELLER).send('GET')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(harness(OWNER).send('POST', '/api/server/plugin-generator', { name: 'acme', items: [item()], overwrite: false })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const h = harness()
    await h.send('POST', undefined, { package: pkg(), overwrite: false })
    const path = join(root, 'extended/panel/plugins/acme.json')
    await writeFile(path, (await readFile(path, 'utf8')).replace('/files', '/whm'))
    expect(await h.plugins(await h.send('GET'))).toEqual([expect.objectContaining({ name: 'acme', state: 'invalid', items: [] })])
    await expect(h.send('GET', '/api/server/plugins/acme/package')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await (await harness(OWNER).send('GET', '/api/account/plugins'))!.json()).toEqual({ items: [] })
    await expect(h.send('POST', undefined, { package: pkg(), overwrite: false })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await h.plugins(await h.send('POST', undefined, { package: pkg(), overwrite: true }))).toEqual([expect.objectContaining({ state: 'installed' })])
  })
})
