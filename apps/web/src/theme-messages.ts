import { readFileSync } from 'node:fs'
import { URL as FileURL } from 'node:url'
import { LOCALES, SOURCE_LOCALE, catalogFromEntries, catalogKey, createTranslator, isLocale, localeInfo, messageArguments, parsePo, type Catalog, type Locale, type MessageValues, type PoCatalog, type Translate } from '@xpanel/core'
import { translator } from './i18n.ts'

/** Only these owned keys may be added to one document's client translator. */
export interface ThemeCatalogOverlay {
  readonly themeId: string
  readonly locale: Locale
  readonly messages: Catalog
}

export interface ThemeMessages {
  readonly themeId: string
  translator(locale: Locale): Translate
  /** A fresh map for this response, not the bundle's internal catalog. */
  forClient(locale: Locale): ThemeCatalogOverlay
}

const SEPARATOR = '\u0004'
const MAX_CATALOG_BYTES = 4 * 1024 * 1024
const NON_ASCII_DIGIT = /(?![0-9])\p{Nd}/u
const asciiDigits = (text: string): string => text.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, digit => String(digit.charCodeAt(0) & 0xf))
const validId = (themeId: string): boolean => /^[a-z][a-z0-9-]*$/.test(themeId)
const IMMUTABLE_THEME_CATALOGS = new WeakSet<Catalog>()
const READONLY_OVERLAYS = new WeakMap<ThemeMessages, (locale: Locale) => ThemeCatalogOverlay>()

export function isImmutableThemeCatalog(catalog: Catalog): boolean {
  return IMMUTABLE_THEME_CATALOGS.has(catalog)
}
export function readonlyThemeOverlay(bundle: ThemeMessages | undefined, locale: Locale): ThemeCatalogOverlay | undefined {
  return bundle ? (READONLY_OVERLAYS.get(bundle)?.(locale) ?? bundle.forClient(locale)) : undefined
}

function checkedPo(themeId: string, locale: Locale, text: string): PoCatalog {
  if (!validId(themeId)) throw new Error('theme_message_id')
  if (Buffer.byteLength(text, 'utf8') > MAX_CATALOG_BYTES) throw new Error('theme_message_size')
  if (text.includes('\uFFFD') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text))
    throw new Error('theme_message_encoding')
  const parsed = parsePo(text)
  if (parsed.header.Language !== locale) throw new Error('theme_message_language')
  if (!/charset=utf-8(?:;|$)/i.test(parsed.header['Content-Type'] ?? '')) throw new Error('theme_message_encoding')
  for (const entry of parsed.entries) {
    if (entry.context !== 'theme:' + themeId) throw new Error('theme_message_scope')
    if (!entry.id || NON_ASCII_DIGIT.test(entry.id) || NON_ASCII_DIGIT.test(entry.translation)) throw new Error('theme_message_digits')
    const sourceArgs = [...messageArguments(entry.id)].sort().join(',')
    if (entry.translation !== '' && sourceArgs !== [...messageArguments(entry.translation)].sort().join(','))
      throw new Error('theme_message_placeholders')
    if (locale === SOURCE_LOCALE && entry.translation !== '') throw new Error('theme_message_source_translation')
  }
  return parsed
}

/** Build one isolated gettext/ICU bundle. Theme-only copy uses a literal theme:<id> msgctxt. */
export function createThemeMessages(themeId: string, sourcePo: string, translations: Partial<Record<Locale, string>> = {}): ThemeMessages {
  const source = checkedPo(themeId, SOURCE_LOCALE, sourcePo)
  const known = new Set(source.entries.map(entry => catalogKey(entry.id, entry.context)))
  for (const tag of Object.keys(translations))
    if (!isLocale(tag) || tag === SOURCE_LOCALE) throw new Error('theme_message_locale')
  const catalogs = new Map<Locale, Catalog>()
  for (const { tag } of LOCALES) {
    const text = translations[tag]
    const parsed = tag === SOURCE_LOCALE || text === undefined ? undefined : checkedPo(themeId, tag, text)
    for (const entry of parsed?.entries ?? [])
      if (!known.has(catalogKey(entry.id, entry.context))) throw new Error('theme_message_unknown')
    const map = parsed ? catalogFromEntries(parsed.entries) : new Map()
    IMMUTABLE_THEME_CATALOGS.add(map)
    catalogs.set(tag, map)
  }
  const emptyCatalog: Catalog = new Map()
  IMMUTABLE_THEME_CATALOGS.add(emptyCatalog)
  const prefix = 'theme:' + themeId + SEPARATOR
  const wrapped = new Map<Locale, Translate>()
  const readonlyByLocale = new Map<Locale, ThemeCatalogOverlay>()
  // A copied locale reads the theme strings of the locale it was copied from.
  const catalogOf = (tag: Locale): Catalog => catalogs.get(tag) ?? catalogs.get(localeInfo(tag).base as Locale) ?? emptyCatalog
  const wrap = (tag: Locale): Translate => {
    const own = createTranslator(tag, catalogOf(tag))
    const translate = (message: string, values?: MessageValues): string => {
      const context = message.slice(0, message.indexOf(SEPARATOR))
      if (message.includes(SEPARATOR) && context.startsWith('theme:') && !message.startsWith(prefix))
        throw new Error('theme_message_scope')
      return asciiDigits(message.startsWith(prefix) ? own(message, values) : translator(tag)(message, values))
    }
    const bound = Object.assign(translate, { locale: tag })
    wrapped.set(tag, bound)
    return bound
  }
  const instance: ThemeMessages = Object.freeze({
    themeId,
    translator(locale: Locale): Translate {
      if (!isLocale(locale)) throw new Error('theme_message_locale')
      return wrapped.get(locale) ?? wrap(locale)
    },
    forClient(locale: Locale): ThemeCatalogOverlay {
      if (!isLocale(locale)) throw new Error('theme_message_locale')
      return Object.freeze({ themeId, locale, messages: new Map(catalogOf(locale)) })
    },
  })
  READONLY_OVERLAYS.set(instance, (locale: Locale): ThemeCatalogOverlay => {
    if (!isLocale(locale)) throw new Error('theme_message_locale')
    let cached = readonlyByLocale.get(locale)
    if (!cached) {
      cached = Object.freeze({ themeId, locale, messages: catalogOf(locale) })
      readonlyByLocale.set(locale, cached)
    }
    return cached
  })
  return instance
}

/** Installed package paths are supplied by trusted theme modules, never by a request preference. */
export function loadThemeMessages(themeId: string, directory: URL): ThemeMessages {
  if (directory.protocol !== 'file:') throw new Error('theme_message_directory')
  const source = readFileSync(new FileURL(SOURCE_LOCALE + '.po', directory.href), 'utf8')
  const translations: Partial<Record<Locale, string>> = {}
  for (const { tag } of LOCALES) {
    if (tag === SOURCE_LOCALE) continue
    try { translations[tag] = readFileSync(new FileURL(tag + '.po', directory.href), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return createThemeMessages(themeId, source, translations)
}

/** Resolve the trusted installing module through Node's URL implementation before the existing file/scope guards. */
export function loadThemeMessagesFromModule(themeId: string, moduleUrl: string): ThemeMessages {
  if (!validId(themeId)) throw new Error('theme_message_id')
  const directory = new FileURL('./locales/', moduleUrl)
  if (directory.protocol !== 'file:') throw new Error('theme_message_directory')
  let loaded: ThemeMessages | undefined
  const bundle = (): ThemeMessages => (loaded ??= loadThemeMessages(themeId, directory))
  const lazyInstance: ThemeMessages = Object.freeze({
    themeId,
    translator: (locale: Locale): Translate => bundle().translator(locale),
    forClient: (locale: Locale): ThemeCatalogOverlay => bundle().forClient(locale),
  })
  READONLY_OVERLAYS.set(lazyInstance, (locale: Locale): ThemeCatalogOverlay => readonlyThemeOverlay(bundle(), locale)!)
  return lazyInstance
}
