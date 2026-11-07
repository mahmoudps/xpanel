import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { handleThemePackagesRoute, installSavedThemePackages, withThemePreview } from './theme-packages.ts'
import type { ThemePackagesHelpers, ThemeRow } from './theme-packages.ts'
import { registeredUiThemeIds, removeUiThemePackage, resolveUiTheme } from '../../web/src/index.ts'

const ROOT = { principal: { id: '11111111-1111-4111-8111-111111111111', kind: 'root', username: 'root' } } as AuthenticatedCaller
const RESELLER = { principal: { id: '22222222-2222-4222-8222-222222222222', kind: 'reseller', username: 'reseller1' } } as AuthenticatedCaller
const pkg = { format: 'xpanel-theme-package-v1', id: 'acme', name: 'Acme', version: '1.0.0', base: 'classic',
  tokens: { light: { '--xp-accent': '#0f766e', '--xp-bg-canvas': '#f6f7f7', '--xp-bg-surface': '#ffffff', '--xp-text-primary': '#111827' },
    dark: { '--xp-accent': '#5eead4', '--xp-bg-canvas': '#0b1414', '--xp-bg-surface': '#132020', '--xp-text-primary': '#e5f2f0' } } }
let root = ''
function harness(caller = ROOT) {
  const lease = { assertFencingToken: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
  const helpers = { requireCaller: vi.fn(async () => caller), emitAudit: vi.fn(async () => undefined), now: () => new Date('2026-11-07T08:00:00.000Z'),
    store: { rootDir: root, getWriterLock: () => ({ acquire: async () => lease }) },
    assertRoot: vi.fn(async (who: AuthenticatedCaller) => { if (who.principal.kind !== 'root') fail('FORBIDDEN', 'root role is required') }) } as unknown as ThemePackagesHelpers
  const send = (method: string, path = '/api/server/themes', body?: unknown, type = 'application/json') => handleThemePackagesRoute(new Request('http://api.test' + path, { method,
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': type } }) }), new URL('http://api.test' + path), method, helpers)
  const themes = async (response: Response | null) => ((await response!.json()) as { themes: ThemeRow[] }).themes
  return { helpers, send, themes }
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xp-themes-')) })
afterEach(async () => { for (const id of registeredUiThemeIds()) if (!['classic', 'v2'].includes(id)) removeUiThemePackage(id); await rm(root, { recursive: true, force: true }) })

describe('theme manager', { tags: ['unit'] }, () => {
  it('previews an installed theme for root on one document and saves nothing', async () => {
    await harness().send('POST', undefined, pkg)
    const state = (kind: string) => ({ visibility: { principal: { kind } }, uiTheme: 'classic' })
    const preview = (kind: string, id: string) => withThemePreview(new URL('http://panel.test/whm/panel/branding?previewTheme=' + id), state(kind))
    expect(preview('root', 'acme')).toEqual({ ...state('root'), themePreview: 'acme' })
    expect(preview('root', 'v2')).toEqual({ ...state('root'), themePreview: 'v2' })
    expect(preview('root', 'missing')).toEqual(state('root'))
    for (const kind of ['reseller', 'user']) expect(preview(kind, 'acme')).toEqual(state(kind))
    expect(withThemePreview(new URL('http://panel.test/whm'), state('root'))).toEqual(state('root'))
  })

  it('installs, clones, downloads and deletes packages, and lists the built-in themes', async () => {
    const h = harness()
    expect((await h.themes(await h.send('GET'))).map(row => [row.id, row.builtIn])).toEqual([['classic', true], ['v2', true]])
    const installed = await h.themes(await h.send('POST', undefined, pkg))
    expect(installed[2]).toMatchObject({ id: 'acme', name: 'Acme', base: 'classic', state: 'installed', installedBy: 'root', installedAt: '2026-11-07T08:00:00.000Z' })
    expect(resolveUiTheme('acme').baseId).toBe('classic')
    expect(JSON.parse(await readFile(join(root, 'extended', 'panel', 'themes', 'acme.json'), 'utf8'))).toMatchObject({ version: 1, package: { id: 'acme' } })
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.theme.installed', target: 'theme:acme' }))
    const download = await h.send('GET', '/api/server/themes/acme/package')
    expect(download!.headers.get('content-disposition')).toBe('attachment; filename="acme.xpanel-theme.json"')
    const downloaded = await download!.json()
    expect(downloaded.tokens).toEqual(pkg.tokens)
    const cloned = await h.themes(await h.send('POST', '/api/server/themes/acme/clone', { id: 'acme-blue', name: 'Acme blue' }))
    expect(cloned.find(row => row.id === 'acme-blue')).toMatchObject({ name: 'Acme blue', base: 'classic' })
    const clonedDownload = await (await h.send('GET', '/api/server/themes/acme-blue/package'))!.json()
    expect(clonedDownload.tokens).toEqual(downloaded.tokens)
    await h.send('POST', '/api/server/themes/v2/clone', { id: 'mine', name: 'Mine' })
    expect(resolveUiTheme('mine').baseId).toBe('v2')
    const remaining = await h.themes(await h.send('DELETE', '/api/server/themes/acme'))
    expect(remaining.map(row => row.id)).toEqual(['classic', 'v2', 'acme-blue', 'mine'])
    expect(resolveUiTheme('acme').id).toBe('classic')
  })

  it('refuses invalid packages with their reason, duplicates, built-in changes and resellers', async () => {
    const h = harness()
    await expect(h.send('POST', undefined, { ...pkg, script: 'alert(1)' })).rejects.toMatchObject({ code: 'VALIDATION', detail: { reason: 'package_format' } })
    await expect(h.send('POST', undefined, '{', 'application/json')).rejects.toMatchObject({ code: 'VALIDATION', detail: { reason: 'package_format' } })
    await expect(h.send('POST', undefined, JSON.stringify(pkg), 'application/zip')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(h.send('POST', undefined, { ...pkg, tokens: { ...pkg.tokens, dark: { '--xp-accent': '#5eead4' } } })).rejects.toMatchObject({ detail: { reason: 'missing_required_token' } })
    await expect(h.send('POST', undefined, JSON.stringify({ ...pkg, name: 'x'.repeat(70 * 1024) }))).rejects.toMatchObject({ code: 'VALIDATION' })
    await h.send('POST', undefined, pkg)
    await expect(h.send('POST', undefined, pkg)).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'theme_exists' } })
    await expect(h.send('DELETE', '/api/server/themes/classic')).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { reason: 'built_in_theme' } })
    await expect(h.send('GET', '/api/server/themes/v2/package')).rejects.toMatchObject({ code: 'NOT_FOUND', detail: { reason: 'built_in_theme' } })
    await expect(harness(RESELLER).send('GET')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(h.helpers.emitAudit).toHaveBeenCalledTimes(1)
  })

  it('installs saved packages at panel start and reports an altered file instead of loading it', async () => {
    const h = harness()
    await h.send('POST', undefined, pkg)
    removeUiThemePackage('acme')
    const path = join(root, 'extended', 'panel', 'themes', 'acme.json')
    expect(await installSavedThemePackages(root)).toEqual({ installed: ['acme'], rejected: [] })
    expect(resolveUiTheme('acme').id).toBe('acme')
    removeUiThemePackage('acme')
    const record = JSON.parse(await readFile(path, 'utf8'))
    record.package.tokens.light['--xp-accent'] = '#ff0000'
    await writeFile(path, JSON.stringify(record))
    await mkdir(join(root, 'extended', 'panel', 'themes'), { recursive: true })
    expect(await installSavedThemePackages(root)).toEqual({ installed: [], rejected: ['acme'] })
    expect((await h.themes(await h.send('GET'))).find(row => row.id === 'acme')).toMatchObject({ state: 'invalid' })
  })
})
