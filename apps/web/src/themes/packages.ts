import { createHash } from 'node:crypto'
import { fail } from '@xpanel/core'
import type { ThemeAsset, UiTheme } from './contract.ts'

/** The registry's built-in themes; core passes this lookup so the package rules never import the registry. */
export type BuiltInThemes = (id: string) => UiTheme | undefined

/**
 * Uploaded theme packages (WHM Theme Manager). A package is data only: it names one built-in base theme and sets
 * values for the design tokens that base declares overridable (colors and corner radii), for the light and dark
 * schemes. It carries no CSS, markup, script or file, so it cannot run code, fetch anything or move a control; the
 * base theme renders every page and keeps the spacing, typography and accessibility rules. Its stylesheet is
 * generated here and linked only while that package is the active theme, so nothing leaks into another theme.
 */
export interface UiThemePackage {
  format: 'xpanel-theme-package-v1'
  id: string
  name: string
  version: string
  base: string
  tokens: { light: Record<string, string>; dark: Record<string, string> }
}
export const THEME_PACKAGE_FORMAT = 'xpanel-theme-package-v1'
export const THEME_PACKAGE_LIMITS = Object.freeze({ bytes: 64 * 1024, packages: 16, name: 40 })
const ID = /^[a-z][a-z0-9-]{1,31}$/
const VERSION = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/
const COLOR = /^#[0-9a-f]{6}$/
const RADIUS = /^(?:0|[1-9]|[12][0-9]|3[0-2])px$/
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const refuse = (reason: string, message: string, detail: Record<string, unknown> = {}): never => fail('VALIDATION', message, { stateChanged: false, reason, ...detail })

const channel = (hex: string, at: number): number => { const value = parseInt(hex.slice(at, at + 2), 16) / 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4 }
const luminance = (hex: string): number => 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5)
/** WCAG 2.2 contrast ratio of two opaque colors. */
export const contrastRatio = (a: string, b: string): number => { const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (high! + 0.05) / (low! + 0.05) }

/** Strict package grammar with a stable reason for every refusal; the base theme decides which tokens may change. */
export function parseUiThemePackage(raw: unknown, builtInUiTheme: BuiltInThemes): UiThemePackage {
  if (!object(raw) || Object.keys(raw).sort().join() !== 'base,format,id,name,tokens,version' || raw.format !== THEME_PACKAGE_FORMAT) return refuse('package_format', 'the package is not an xpanel-theme-package-v1 manifest with exactly format, id, name, version, base and tokens')
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) return refuse('package_id', 'the theme id is 2 to 32 lowercase letters, digits and dashes, starting with a letter')
  if (builtInUiTheme(raw.id)) return refuse('theme_id_reserved', 'a built-in theme already uses this id')
  if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > THEME_PACKAGE_LIMITS.name || !raw.name.isWellFormed() || /[\u0000-\u001f\u007f-\u009f<>&"]/u.test(raw.name)) return refuse('package_name', `the theme name is plain text of up to ${THEME_PACKAGE_LIMITS.name} characters`)
  if (typeof raw.version !== 'string' || !VERSION.test(raw.version)) return refuse('package_version', 'the version is MAJOR.MINOR.PATCH')
  const base = typeof raw.base === 'string' ? builtInUiTheme(raw.base) : undefined, contract = base?.packageTokens
  if (!base || !contract) return refuse('package_base', 'the base must be a built-in theme that accepts packages')
  if (!object(raw.tokens) || Object.keys(raw.tokens).sort().join() !== 'dark,light') return refuse('package_tokens', 'tokens has exactly a light and a dark scheme')
  const allowed = new Set([...contract.required, ...contract.optional]), tokens = { light: {} as Record<string, string>, dark: {} as Record<string, string> }
  for (const scheme of ['light', 'dark'] as const) {
    const values = raw.tokens[scheme]
    if (!object(values) || Object.keys(values).length > allowed.size) return refuse('package_tokens', 'each scheme is an object of design token values')
    for (const [name, value] of Object.entries(values)) {
      if (!allowed.has(name)) return refuse('token_not_allowed', 'the base theme does not allow this token to change', { token: name.slice(0, 64) })
      const radius = contract.radii.includes(name)
      if (typeof value !== 'string' || !(radius ? RADIUS : COLOR).test(value)) return refuse('token_value_invalid', radius ? 'a radius is 0px to 32px' : 'a color is #rrggbb in lowercase', { token: name })
      tokens[scheme][name] = value
    }
    const missing = contract.required.find(name => !(name in tokens[scheme]))
    if (missing) return refuse('missing_required_token', 'every required token must have a value in both schemes', { token: missing, scheme })
    for (const [text, background] of contract.contrast) {
      if (contrastRatio(tokens[scheme][text]!, tokens[scheme][background]!) < 4.5) return refuse('insufficient_contrast', 'text and its background need a contrast ratio of at least 4.5:1', { token: text, background, scheme })
    }
  }
  const sorted = (values: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)))
  return { format: THEME_PACKAGE_FORMAT, id: raw.id, name: raw.name, version: raw.version, base: base.id, tokens: { light: sorted(tokens.light), dark: sorted(tokens.dark) } }
}

/** A copy under a new id and name; a built-in source becomes a package with that theme's shipped values. */
export function cloneUiThemePackage(source: UiThemePackage | string, id: string, name: string, builtInUiTheme: BuiltInThemes): UiThemePackage {
  const from = typeof source === 'string' ? builtInUiTheme(source) : undefined
  if (typeof source === 'string' && !from?.packageTokens) return refuse('package_base', 'only a built-in theme that accepts packages can be cloned')
  const tokens = typeof source === 'string' ? from!.packageTokens!.defaults : source.tokens
  return parseUiThemePackage({ format: THEME_PACKAGE_FORMAT, id, name, version: typeof source === 'string' ? '1.0.0' : source.version, base: typeof source === 'string' ? source : source.base,
    tokens: { light: { ...tokens.light }, dark: { ...tokens.dark } } }, builtInUiTheme)
}

/** `:root[data-theme]` outranks the base theme's own scheme selectors, and this sheet loads after the base styles. */
export const uiThemePackageCss = (pkg: UiThemePackage): string => (['light', 'dark'] as const)
  .map(scheme => `:root[data-theme="${scheme}"]{${Object.entries(pkg.tokens[scheme]).map(([name, value]) => `${name}:${value}`).join(';')}}`).join('\n') + '\n'

/** The theme of a parsed package: its base renders every page and its generated sheet follows the base styles. */
export function uiThemePackageTheme(pkg: UiThemePackage, base: UiTheme | undefined): UiTheme {
  if (!base || base.id !== pkg.base) return refuse('package_base', 'the base theme is not installed')
  const body = uiThemePackageCss(pkg), path = `/assets/themes/${pkg.id}/tokens.css` as const
  const asset: ThemeAsset = Object.freeze({ path, href: `${path}?v=${createHash('sha256').update(body).digest('hex').slice(0, 16)}`, contentType: 'text/css; charset=utf-8', body })
  const link = `<link rel="stylesheet" href="${asset.href}">`
  const { packageTokens: _overridable, ...rendering } = base
  return Object.freeze<UiTheme>({ ...rendering, id: pkg.id, baseId: base.id, label: pkg.name, assets: Object.freeze([asset]),
    renderDocument: props => base.renderDocument({ ...props, headHtml: link + props.headHtml }) })
}
