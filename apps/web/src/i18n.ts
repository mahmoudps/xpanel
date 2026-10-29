// Translation runtime for xPanel, xWHM and xMail.
// Messages are English source text (ICU MessageFormat) looked up in gettext PO catalogs, one per
// locale in ./locales; supported locales come from the @xpanel/core registry. See docs/STANDARDS.md.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CATALOG_LOCALE_DIR } from '@xpanel/catalog'
import {
  LOCALES,
  SOURCE_LOCALE,
  catalogFromEntries,
  catalogKey,
  compileMessage,
  createTranslator,
  localeInfo,
  lookupLocale,
  msgctxt as coreMsgctxt,
  msgid as coreMsgid,
  negotiateLocale,
  parseMessage,
  parsePo,
  pickMessages,
  type Catalog,
  type Locale,
  type LocaleInfo,
  type MessageValues,
  type Translate,
} from '@xpanel/core'
export { LOCALES, SOURCE_LOCALE, isLocale, localeDirection, localeInfo, negotiateLocale } from '@xpanel/core'
export type { Locale, LocaleInfo, MessageValues, Translate } from '@xpanel/core'

declare global {
  /** The page translator installed by the client i18n runtime; client bindings call it. */
  function xpT(message: string, values?: MessageValues): string
  /** Marks a stored source message for extraction (identity). A global so serialized client code can use it too. */
  function msgid(message: string): string
  /** A context-qualified message key (gettext pgettext). A global for the same reason as msgid. */
  function msgctxt(context: string, message: string): string
}

// The markers are pure functions; installing them here makes them available to every server module that
// imports this one, and the client runtime installs the same globals in pages.
Object.assign(globalThis, { msgid: coreMsgid, msgctxt: coreMsgctxt })

const readCatalog = (dir: string, locale: Locale): Catalog =>
  locale === SOURCE_LOCALE ? new Map() : catalogFromEntries(parsePo(readFileSync(join(dir, `${locale}.po`), 'utf8')).entries)

const CATALOGS: ReadonlyMap<Locale, Catalog> = new Map(LOCALES.map(info => [info.tag, readCatalog(join(dirname(fileURLToPath(import.meta.url)), 'locales'), info.tag)]))
// Product rule: every displayed digit is ASCII 0-9, including digits inside interpolated values.
const ASCII_DIGITS = (text: string): string => text.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, digit => String((digit.charCodeAt(0) & 0xf)))
const asciiTranslator = (base: Translate): Translate => Object.assign((message: string, values?: MessageValues) => ASCII_DIGITS(base(message, values)), { locale: base.locale })
const TRANSLATORS: ReadonlyMap<Locale, Translate> = new Map(LOCALES.map(info => [info.tag, asciiTranslator(createTranslator(info.tag, CATALOGS.get(info.tag)))]))
const TOOL_CATALOGS: ReadonlyMap<Locale, Catalog> = new Map(LOCALES.map(info => [info.tag, readCatalog(CATALOG_LOCALE_DIR, info.tag)]))

/** The supported locale named by `?lang=`, if any. */
export const requestedLocale = (url: URL): Locale | undefined => lookupLocale(url.searchParams.get('lang') ?? '')

/** The page locale: an explicit `?lang=` that names a supported locale, else the browser's Accept-Language. */
export const requestLocale = (url: URL, request: Request): Locale =>
  negotiateLocale({ requested: url.searchParams.get('lang'), acceptLanguage: request.headers.get('accept-language') })

const languageNames = new Map<string, Intl.DisplayNames>()

/** A language's name in the reading locale, from CLDR (for example the English name of Arabic is "Arabic"). */
export function languageName(tag: Locale, inLocale: Locale): string {
  let names = languageNames.get(inLocale)
  if (!names) { names = new Intl.DisplayNames([inLocale], { type: 'language' }); languageNames.set(inLocale, names) }
  return names.of(tag) ?? localeInfo(tag).name
}

/** The other supported locales, in registry order, for language switchers (labelled by their endonym). */
export const alternateLocales = (locale: Locale): readonly (typeof LOCALES)[number][] => LOCALES.filter(info => info.tag !== locale)

/** The translator for a supported locale. */
export const translator = (locale: Locale = SOURCE_LOCALE): Translate => TRANSLATORS.get(locale)!

/** The catalog of a supported locale (empty for the source locale). */
export const catalogFor = (locale: Locale): Catalog => CATALOGS.get(locale)!

/** Plain catalog text (tool, group and navigation names): the record's own context first, then the shared name. */
export const catalogText = (locale: Locale, recordKey: string, source: string): string => {
  const catalog = TOOL_CATALOGS.get(locale)!
  return catalog.get(catalogKey(source, recordKey)) ?? catalog.get(source) ?? source
}

/** Extra search keywords a locale provides for a catalog record (none when it has no entry). */
export const catalogKeywords = (locale: Locale, recordKey: string): string[] =>
  (TOOL_CATALOGS.get(locale)!.get(catalogKey('keywords', recordKey)) ?? '').split(',').map(keyword => keyword.trim()).filter(Boolean)

/** Authored content (not UI copy) keyed by locale tag; the source locale is always present. */
export type LocalizedText = Readonly<Partial<Record<Locale, string>> & Record<typeof SOURCE_LOCALE, string>>

export const localizedText = (text: LocalizedText, locale: Locale): string => text[locale] ?? text[SOURCE_LOCALE]

// ---- Client runtime: bindings serialized into pages call the globals msgid, msgctxt and xpT.

const JS_STRING = String.raw`'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"`
const CLIENT_LITERAL = new RegExp(String.raw`msgctxt\(\s*(${JS_STRING})\s*,\s*(${JS_STRING})\s*\)|(${JS_STRING})`, 'g')
const SCRIPT_BLOCK = /<script\b[^>]*>([\s\S]*?)<\/script>/gi
const decodeJsString = (literal: string): string | undefined => {
  try {
    return JSON.parse('"' + literal.slice(1, -1).replace(/\\'/g, "'").replace(/(?<!\\)((?:\\\\)*)"/g, '$1\\"') + '"') as string
  } catch {
    return undefined
  }
}

const keyCache = new Map<string, readonly string[]>()

/** Message keys a client script may look up: its string literals and msgctxt pairs. */
export function clientMessageKeys(script: string): readonly string[] {
  const cached = keyCache.get(script)
  if (cached) return cached
  const keys = new Set<string>()
  for (const match of script.matchAll(CLIENT_LITERAL)) {
    if (match[3]) {
      const value = decodeJsString(match[3])
      if (value) keys.add(value)
    } else {
      const context = decodeJsString(match[1]!), message = decodeJsString(match[2]!)
      if (context !== undefined && message !== undefined) keys.add(context + '\u0004' + message)
    }
  }
  const result = [...keys]
  // shortcut: unbounded growth is prevented by clearing; page scripts are mostly module constants
  if (keyCache.size > 512) keyCache.clear()
  keyCache.set(script, result)
  return result
}

/** Message keys used by the inline scripts of an HTML fragment. */
export const inlineScriptMessageKeys = (html: string): string[] =>
  [...html.matchAll(SCRIPT_BLOCK)].flatMap(match => clientMessageKeys(match[1] ?? ''))

function installClientI18n(messages: Record<string, string>, locale: string): void {
  const scope = globalThis as unknown as { xpI18n?: { messages: Record<string, string> }; xpT?: unknown; msgid?: unknown; msgctxt?: unknown }
  if (scope.xpI18n) { Object.assign(scope.xpI18n.messages, messages); return }
  const state = { messages: { ...messages } }
  const compiled = new Map<string, (values?: MessageValues) => string>()
  scope.xpI18n = state
  scope.msgid = (message: string) => message
  scope.msgctxt = (context: string, message: string) => context + '\u0004' + message
  scope.xpT = (message: string, values?: MessageValues) => {
    let render = compiled.get(message)
    if (!render) {
      const source = state.messages[message] ?? message.slice(message.indexOf('\u0004') + 1)
      try { render = compileMessage(source, locale) } catch { render = () => source }
      compiled.set(message, render)
    }
    // ASCII digits only, as on the server.
    return render(values).replace(/[\u0660-\u0669\u06F0-\u06F9]/g, digit => String(digit.charCodeAt(0) & 0xf))
  }
}

const CLIENT_RUNTIME = `const parseMessage=${parseMessage.toString()};const compileMessage=${compileMessage.toString()};(${installClientI18n.toString()})`

const scriptJson = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')

/** Inline script that installs the client translator with the messages the given keys need. */
export function renderClientI18nScript(locale: Locale, keys: Iterable<string>): string {
  return `<script id="xpanel-i18n">(()=>{${CLIENT_RUNTIME}(${scriptJson(pickMessages(catalogFor(locale), keys))},${scriptJson(locale)})})()</script>`
}

/**
 * Cached per-locale script with the whole UI catalog. It loads before the realtime client, so messages that
 * arrive at runtime (API and host-agent responses) resolve as well as those in the cached client code.
 */
export const clientI18nAsset = (locale: Locale): string =>
  `(()=>{${CLIENT_RUNTIME}(${scriptJson(Object.fromEntries(catalogFor(locale)))},${scriptJson(locale)})})();\n`
