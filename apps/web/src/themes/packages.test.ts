import { afterEach, describe, expect, it } from 'vitest'
import { contrastRatio, uiThemePackageCss } from './packages.ts'
import { cloneThemePackage, findUiThemeAsset, installThemePackage, parseThemePackage, registeredUiThemeIds, removeUiThemePackage, renderWebApp, resolveUiTheme } from '../app.ts'

const pkg = (patch: Record<string, unknown> = {}, light: Record<string, string> = {}, dark: Record<string, string> = {}) => ({
  format: 'xpanel-theme-package-v1', id: 'acme', name: 'Acme', version: '1.2.0', base: 'classic',
  tokens: { light: { '--xp-accent': '#0f766e', '--xp-bg-canvas': '#f6f7f7', '--xp-bg-surface': '#ffffff', '--xp-text-primary': '#111827', ...light },
    dark: { '--xp-accent': '#5eead4', '--xp-bg-canvas': '#0b1414', '--xp-bg-surface': '#132020', '--xp-text-primary': '#e5f2f0', ...dark } },
  ...patch,
})
const reason = (raw: unknown): unknown => { try { parseThemePackage(raw); return null } catch (error) { return (error as { detail?: { reason?: unknown } }).detail?.reason } }
afterEach(() => { for (const id of registeredUiThemeIds()) if (!['classic', 'v2'].includes(id)) removeUiThemePackage(id) })

describe('theme packages', { tags: ['unit'] }, () => {
  it('admits only data for tokens the base declares, in both schemes, with readable contrast', () => {
    expect(parseThemePackage(pkg({}, { '--xp-radius-md': '6px' })).tokens.light).toMatchObject({ '--xp-accent': '#0f766e', '--xp-radius-md': '6px' })
    expect(reason({ ...pkg(), css: 'body{}' })).toBe('package_format')
    expect(reason(pkg({ format: 'zip' }))).toBe('package_format')
    expect(reason(pkg({ id: '../v2' }))).toBe('package_id')
    expect(reason(pkg({ id: 'v2' }))).toBe('theme_id_reserved')
    expect(reason(pkg({ name: '<b>Acme</b>' }))).toBe('package_name')
    expect(reason(pkg({ base: 'acme' }))).toBe('package_base')
    expect(reason(pkg({}, { '--xp-space-field': '4px' }))).toBe('token_not_allowed')
    expect(reason(pkg({}, { '--xp-accent': 'url(https://evil.example/x)' }))).toBe('token_value_invalid')
    expect(reason(pkg({}, { '--xp-accent': 'red;}body{display:none' }))).toBe('token_value_invalid')
    expect(reason(pkg({}, { '--xp-radius-md': '64px' }))).toBe('token_value_invalid')
    expect(reason({ ...pkg(), tokens: { light: pkg().tokens.light, dark: { '--xp-accent': '#5eead4' } } })).toBe('missing_required_token')
    expect(reason(pkg({}, { '--xp-text-primary': '#bbbbbb' }))).toBe('insufficient_contrast')
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
  })

  it('installs a package as its own theme rendered by the base, with a stylesheet linked only while it is active', () => {
    const parsed = parseThemePackage(pkg())
    installThemePackage(parsed)
    expect(registeredUiThemeIds()).toEqual(['classic', 'v2', 'acme'])
    const theme = resolveUiTheme('acme')
    expect(theme).toMatchObject({ id: 'acme', baseId: 'classic', label: 'Acme' })
    const asset = theme.assets[0]!
    expect(findUiThemeAsset('/assets/themes/acme/tokens.css')).toMatchObject({ href: asset.href, contentType: 'text/css; charset=utf-8', body: uiThemePackageCss(parsed) })
    expect(asset.body).toBe(':root[data-theme="light"]{--xp-accent:#0f766e;--xp-bg-canvas:#f6f7f7;--xp-bg-surface:#ffffff;--xp-text-primary:#111827}\n:root[data-theme="dark"]{--xp-accent:#5eead4;--xp-bg-canvas:#0b1414;--xp-bg-surface:#132020;--xp-text-primary:#e5f2f0}\n')
    const html = renderWebApp({ surface: 'login', locale: 'en', uiTheme: 'acme' })
    expect(html).toContain(`<link rel="stylesheet" href="${asset.href}">`)
    expect(html).not.toContain('data-ui-theme=')
    expect(renderWebApp({ surface: 'login', locale: 'en', uiTheme: 'classic' })).not.toContain('/assets/themes/acme/')
    expect(() => installThemePackage(parsed)).toThrow()
    removeUiThemePackage('acme')
    expect(resolveUiTheme('acme').id).toBe('v2')
    expect(findUiThemeAsset('/assets/themes/acme/tokens.css')).toBeUndefined()
  })

  it('keeps the base data-ui-theme for a v2 package and clones a built-in with its shipped values', () => {
    const clone = cloneThemePackage('v2', 'v2-copy', 'V2 copy')
    expect(clone).toMatchObject({ base: 'v2', version: '1.0.0', tokens: { light: { '--accent': '#1d5bd6', '--text': '#0e1726' } } })
    installThemePackage(clone)
    const html = renderWebApp({ surface: 'login', locale: 'en', uiTheme: 'v2-copy' })
    expect(html).toContain('data-ui-theme="v2"')
    expect(html).toContain('/assets/themes/v2-copy/tokens.css?v=')
    expect(cloneThemePackage(clone, 'v2-copy-2', 'Second').tokens).toEqual(clone.tokens)
    expect(() => cloneThemePackage('missing', 'x2', 'X')).toThrow()
  })
})
