import { createHash } from 'node:crypto'
import { classicTheme } from './classic/index.ts'
import type { ThemeAsset, UiTheme, UiThemeId } from './contract.ts'

const DEFAULT_UI_THEME = 'classic' as const
const registered = Object.freeze([classicTheme])
const themes = new Map<UiThemeId, UiTheme>()
const assets = new Map<string, ThemeAsset>()

for (const theme of registered) {
  if (themes.has(theme.id) || !/^[a-z][a-z0-9-]*$/.test(theme.id)
    || (theme.messages && theme.messages.themeId !== theme.id)) throw new Error('Invalid UI theme registry')
  themes.set(theme.id, theme)
  for (const asset of theme.assets) {
    const legacyClassic = theme.id === 'classic' && asset.path === '/assets/tokens.css'
    const allowedPath = new RegExp(`^/assets/themes/${theme.id}/[a-zA-Z0-9][a-zA-Z0-9._/-]*$`)
    if ((!legacyClassic && !allowedPath.test(asset.path)) || asset.path.includes('..') || assets.has(asset.path)
      || !asset.href.startsWith(asset.path + '?v=') || !/^[a-f0-9]{16,64}$/.test(asset.href.slice(asset.path.length + 3))
      || typeof asset.body !== 'string' || typeof asset.contentType !== 'string' || /[\r\n]/.test(asset.contentType)
      || createHash('sha256').update(asset.body).digest('hex').slice(0, asset.href.length - asset.path.length - 3) !== asset.href.slice(asset.path.length + 3))
      throw new Error('Invalid UI theme asset')
    assets.set(asset.path, Object.freeze({ ...asset }))
  }
}

/** Preferences select an existing trusted presentation package; they never become module or asset paths. */
export function resolveUiTheme(preference?: unknown): UiTheme {
  return (typeof preference === 'string' ? themes.get(preference as UiThemeId) : undefined) ?? themes.get(DEFAULT_UI_THEME)!
}

export const registeredUiThemeIds = (): readonly UiThemeId[] => Object.freeze([...themes.keys()])

/** Core keeps immutable response headers and all executable runtime asset names. */
export const findUiThemeAsset = (pathname: string): ThemeAsset | undefined => assets.get(pathname)
