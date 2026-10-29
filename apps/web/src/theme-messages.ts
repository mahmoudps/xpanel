import { readFileSync } from 'node:fs'
import { LOCALES, SOURCE_LOCALE, catalogFromEntries, catalogKey, createTranslator, isLocale, messageArguments, parsePo, type Catalog, type Locale, type MessageValues, type PoCatalog, type Translate } from '@xpanel/core'
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
    catalogs.set(tag, parsed ? catalogFromEntries(parsed.entries) : new Map())
  }
  const prefix = 'theme:' + themeId + SEPARATOR
  const ownTranslators = new Map(LOCALES.map(({ tag }) => [tag, createTranslator(tag, catalogs.get(tag))]))
  const wrapped = new Map<Locale, Translate>()
  for (const { tag } of LOCALES) {
    const translate = (message: string, values?: MessageValues): string => {
      const context = message.slice(0, message.indexOf(SEPARATOR))
      if (message.includes(SEPARATOR) && context.startsWith('theme:') && !message.startsWith(prefix))
        throw new Error('theme_message_scope')
      return asciiDigits(message.startsWith(prefix) ? ownTranslators.get(tag)!(message, values) : translator(tag)(message, values))
    }
    wrapped.set(tag, Object.assign(translate, { locale: tag }))
  }
  return Object.freeze({
    themeId,
    translator(locale: Locale): Translate {
      if (!isLocale(locale)) throw new Error('theme_message_locale')
      return wrapped.get(locale)!
    },
    forClient(locale: Locale): ThemeCatalogOverlay {
      if (!isLocale(locale)) throw new Error('theme_message_locale')
      return Object.freeze({ themeId, locale, messages: new Map(catalogs.get(locale)) })
    },
  })
}

/** Installed package paths are supplied by trusted theme modules, never by a request preference. */
export function loadThemeMessages(themeId: string, directory: URL): ThemeMessages {
  if (directory.protocol !== 'file:') throw new Error('theme_message_directory')
  const source = readFileSync(new URL(SOURCE_LOCALE + '.po', directory), 'utf8')
  const translations: Partial<Record<Locale, string>> = {}
  for (const { tag } of LOCALES) {
    if (tag === SOURCE_LOCALE) continue
    try { translations[tag] = readFileSync(new URL(tag + '.po', directory), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return createThemeMessages(themeId, source, translations)
}
