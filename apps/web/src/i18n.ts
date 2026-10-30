// Translation runtime for xPanel, xWHM and xMail.
// Messages are English source text (ICU MessageFormat) looked up in gettext PO catalogs, one per
// locale in ./locales; supported locales come from the @xpanel/core registry. See docs/STANDARDS.md.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ThemeCatalogOverlay } from './theme-messages.ts'
import { CATALOG_LOCALE_DIR } from '@xpanel/catalog'
import {
  LOCALES,
  SOURCE_LOCALE,
  catalogFromEntries,
  catalogKey,
  compileMessage,
  createTranslator,
  formatPo,
  localeInfo,
  lookupLocale,
  messageArguments,
  msgctxt as coreMsgctxt,
  msgid as coreMsgid,
  negotiateLocale,
  parseAcceptLanguage,
  parseMessage,
  parsePo,
  pickMessages,
  type Catalog,
  type Locale,
  type LocaleInfo,
  type MessageValues,
  type PoCatalog,
  type PoEntry,
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

const WEB_CATALOG_DIR = join(dirname(fileURLToPath(import.meta.url)), 'locales')
// Mutable only through installLocaleOverrides, which runs once at panel start before pages render.
const CATALOGS = new Map<Locale, Catalog>(LOCALES.map(info => [info.tag, readCatalog(WEB_CATALOG_DIR, info.tag)]))
// Product rule: every displayed digit is ASCII 0-9, including digits inside interpolated values.
const ASCII_DIGITS = (text: string): string => text.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, digit => String((digit.charCodeAt(0) & 0xf)))
const asciiTranslator = (base: Translate): Translate => Object.assign((message: string, values?: MessageValues) => ASCII_DIGITS(base(message, values)), { locale: base.locale })
const TRANSLATORS = new Map<Locale, Translate>(LOCALES.map(info => [info.tag, asciiTranslator(createTranslator(info.tag, CATALOGS.get(info.tag)))]))
const TOOL_CATALOGS: ReadonlyMap<Locale, Catalog> = new Map(LOCALES.map(info => [info.tag, readCatalog(CATALOG_LOCALE_DIR, info.tag)]))

/** Which registry locales the panels offer and which one answers a request that names none of them. */
export interface LocalePolicy { readonly offered: readonly Locale[]; readonly defaultLocale: Locale }
let POLICY: LocalePolicy | null = null

/** Installs the server's locale policy (null restores the release default: every locale, source fallback). */
export function setLocalePolicy(policy: LocalePolicy | null): void {
  if (policy && (!policy.offered.length || !policy.offered.every(tag => LOCALES.some(info => info.tag === tag)) || !policy.offered.includes(policy.defaultLocale))) throw new Error('invalid_locale_policy')
  POLICY = policy && { offered: LOCALES.map(info => info.tag).filter(tag => policy.offered.includes(tag)), defaultLocale: policy.defaultLocale }
}

/** The policy in force; without a saved policy every registry locale is offered and the source locale is the fallback. */
export const localePolicy = (): LocalePolicy => POLICY ?? { offered: LOCALES.map(info => info.tag), defaultLocale: SOURCE_LOCALE }

export const isOfferedLocale = (tag: Locale): boolean => !POLICY || POLICY.offered.includes(tag)

/** The offered locale named by `?lang=`, if any. */
export const requestedLocale = (url: URL): Locale | undefined => {
  const tag = lookupLocale(url.searchParams.get('lang') ?? '')
  return tag && isOfferedLocale(tag) ? tag : undefined
}

/** The page locale: an explicit `?lang=` that names an offered locale, else the browser's Accept-Language among offered ones. */
export const requestLocale = (url: URL, request: Request): Locale => {
  if (!POLICY) return negotiateLocale({ requested: url.searchParams.get('lang'), acceptLanguage: request.headers.get('accept-language') })
  const explicit = requestedLocale(url)
  if (explicit) return explicit
  for (const range of parseAcceptLanguage(request.headers.get('accept-language'))) {
    const match = lookupLocale(range)
    if (match && isOfferedLocale(match)) return match
  }
  return POLICY.defaultLocale
}

// ---- Catalog overrides uploaded by the administrator (validated here, stored by the API).

/** Largest catalog upload, in UTF-8 bytes. The shipped catalogs are about half of it. */
export const MAX_CATALOG_BYTES = 4 * 1024 * 1024

export interface CatalogProblem {
  readonly field: 'catalog' | 'Language' | 'msgstr'
  readonly code: 'source_locale' | 'too_large' | 'encoding' | 'syntax' | 'language_mismatch' | 'empty' | 'unknown_message' | 'invalid_message' | 'placeholder_mismatch' | 'non_ascii_digits'
  readonly line?: number
  readonly msgid?: string
  readonly msgctxt?: string
}
export interface CatalogValidation { readonly entries: readonly PoEntry[]; readonly problems: readonly CatalogProblem[]; readonly problemCount: number }

/** The release's own catalog file for a translated locale (read on demand: uploads and downloads are rare). */
const shippedPo = (locale: Locale): PoCatalog => parsePo(readFileSync(join(WEB_CATALOG_DIR, `${locale}.po`), 'utf8'))
const translatedLocales = (): Locale[] => LOCALES.map(info => info.tag).filter(tag => tag !== SOURCE_LOCALE)
const NON_ASCII_DIGIT = /(?![0-9])\p{Nd}/u
const REPORTED_PROBLEMS = 20

/** The `msgid` line of each non-header entry in file order, or nothing when the layout is not the plain one parsePo saw. */
function entryLines(text: string, count: number): number[] | undefined {
  const lines = text.split(/\r?\n/), out: number[] = []
  lines.forEach((raw, index) => {
    const line = raw.trim()
    if (!/^msgid\s/.test(line)) return
    const previous = lines[index - 1]?.trim() ?? '', next = lines[index + 1]?.trim() ?? ''
    if (line === 'msgid ""' && /^msgstr\s/.test(next) && !/^(msgctxt\s|")/.test(previous)) return
    out.push(index + 1)
  })
  return out.length === count ? out : undefined
}

/**
 * Checks an uploaded PO catalog against the shipped catalog of the same locale: its Language header, known
 * messages only, valid ICU on both sides, the same placeholders and ASCII digits. An empty msgstr is allowed
 * and leaves the shipped translation in place.
 */
export function validateLocaleCatalog(locale: Locale, text: string): CatalogValidation {
  const refuse = (problem: CatalogProblem): CatalogValidation => ({ entries: [], problems: [problem], problemCount: 1 })
  if (locale === SOURCE_LOCALE) return refuse({ field: 'catalog', code: 'source_locale' })
  if (Buffer.byteLength(text, 'utf8') > MAX_CATALOG_BYTES) return refuse({ field: 'catalog', code: 'too_large' })
  if (text.includes('\uFFFD') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) return refuse({ field: 'catalog', code: 'encoding' })
  let catalog: PoCatalog
  try { catalog = parsePo(text) }
  catch (error) {
    const line = /line (\d+)/.exec((error as Error).message)?.[1]
    return refuse({ field: 'catalog', code: 'syntax', ...(line ? { line: Number(line) } : {}) })
  }
  const charset = /charset=([^;\s]+)/i.exec(catalog.header['Content-Type'] ?? '')?.[1]
  if (charset && charset.toLowerCase() !== 'utf-8') return refuse({ field: 'catalog', code: 'encoding' })
  if (catalog.header.Language !== locale) return refuse({ field: 'Language', code: 'language_mismatch' })
  if (!catalog.entries.length) return refuse({ field: 'catalog', code: 'empty' })
  const known = new Set(shippedPo(locale).entries.map(entry => catalogKey(entry.id, entry.context)))
  const lines = entryLines(text, catalog.entries.length)
  const problems: CatalogProblem[] = []
  let problemCount = 0
  catalog.entries.forEach((entry, index) => {
    const problem = (code: CatalogProblem['code']): void => {
      if (problemCount++ >= REPORTED_PROBLEMS) return
      problems.push({ field: 'msgstr', code, ...(lines ? { line: lines[index]! } : {}), msgid: entry.id.slice(0, 200), ...(entry.context !== undefined ? { msgctxt: entry.context.slice(0, 200) } : {}) })
    }
    if (!known.has(catalogKey(entry.id, entry.context))) return problem('unknown_message')
    if (entry.translation === '') return
    try {
      const source = [...messageArguments(entry.id)].sort().join(), target = [...messageArguments(entry.translation)].sort().join()
      if (source !== target) return problem('placeholder_mismatch')
    } catch { return problem('invalid_message') }
    if (NON_ASCII_DIGIT.test(entry.translation)) problem('non_ascii_digits')
  })
  return { entries: problemCount ? [] : catalog.entries, problems, problemCount }
}

const mergedCatalog = (shipped: PoCatalog, entries: readonly PoEntry[]): Map<string, string> => {
  const merged = new Map(catalogFromEntries(shipped.entries))
  for (const entry of entries) if (entry.translation !== '') merged.set(catalogKey(entry.id, entry.context), entry.translation)
  return merged
}

/**
 * Rebuilds every translated catalog from the release files and merges the given uploaded catalogs over them.
 * Call once at panel start, before the web UI module computes its cached client catalogs. An upload that no
 * longer validates against this release (for example after an update removed messages) is not applied.
 */
export function installLocaleOverrides(overrides: Partial<Record<Locale, string>>): { applied: Locale[]; rejected: Locale[] } {
  const applied: Locale[] = [], rejected: Locale[] = []
  for (const tag of translatedLocales()) {
    const text = overrides[tag]
    let entries: readonly PoEntry[] = []
    if (text !== undefined) {
      const check = validateLocaleCatalog(tag, text)
      if (check.problemCount) rejected.push(tag)
      else { entries = check.entries; applied.push(tag) }
    }
    const catalog = mergedCatalog(shippedPo(tag), entries)
    CATALOGS.set(tag, catalog)
    TRANSLATORS.set(tag, asciiTranslator(createTranslator(tag, catalog)))
  }
  return { applied, rejected }
}

let sourceCount: number | undefined
/** Translated messages in effect for a locale; for the source locale, the number of source messages. */
export const effectiveMessageCount = (locale: Locale): number => locale !== SOURCE_LOCALE ? catalogFor(locale).size
  : (sourceCount ??= new Set(translatedLocales().flatMap(tag => shippedPo(tag).entries.map(entry => catalogKey(entry.id, entry.context)))).size)

/**
 * A downloadable catalog. For a translated locale: the release catalog with the uploaded override merged in.
 * For the source locale: a template with every message and empty translations, to start a new translation.
 */
export function localeCatalogPo(locale: Locale, overrideText?: string): string {
  if (locale === SOURCE_LOCALE) {
    const entries = new Map<string, PoEntry>()
    for (const tag of translatedLocales()) for (const entry of shippedPo(tag).entries) {
      const key = catalogKey(entry.id, entry.context)
      if (!entries.has(key)) entries.set(key, { ...entry, translation: '' })
    }
    const header = { 'Project-Id-Version': 'xPanel', Language: '', 'MIME-Version': '1.0', 'Content-Type': 'text/plain; charset=UTF-8', 'Content-Transfer-Encoding': '8bit', 'X-Message-Format': 'ICU MessageFormat' }
    return formatPo({ header, entries: [...entries.values()] })
  }
  const shipped = shippedPo(locale)
  const override = overrideText === undefined ? [] : validateLocaleCatalog(locale, overrideText).entries
  const merged = mergedCatalog(shipped, override)
  return formatPo({ header: shipped.header, entries: shipped.entries.map(entry => ({ ...entry, translation: merged.get(catalogKey(entry.id, entry.context)) ?? '' })) })
}

const languageNames = new Map<string, Intl.DisplayNames>()

/** A language's name in the reading locale, from CLDR (for example the English name of Arabic is "Arabic"). */
export function languageName(tag: Locale, inLocale: Locale): string {
  let names = languageNames.get(inLocale)
  if (!names) { names = new Intl.DisplayNames([inLocale], { type: 'language' }); languageNames.set(inLocale, names) }
  return names.of(tag) ?? localeInfo(tag).name
}

/** The other offered locales, in registry order, for language switchers (labelled by their endonym). */
export const alternateLocales = (locale: Locale): readonly (typeof LOCALES)[number][] => LOCALES.filter(info => info.tag !== locale && isOfferedLocale(info.tag))

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
export function renderClientI18nScript(locale: Locale, keys: Iterable<string>, overlay?: ThemeCatalogOverlay): string {
  const messages = pickMessages(catalogFor(locale), keys)
  if (overlay) {
    if (overlay.locale !== locale || !/^[a-z][a-z0-9-]*$/.test(overlay.themeId)) throw new Error('theme_message_scope')
    const prefix = 'theme:' + overlay.themeId + '\u0004'
    for (const [key, value] of overlay.messages) {
      if (!key.startsWith(prefix) || typeof value !== 'string') throw new Error('theme_message_scope')
      messages[key] = value
    }
  }
  return `<script id="xpanel-i18n">(()=>{${CLIENT_RUNTIME}(${scriptJson(messages)},${scriptJson(locale)})})()</script>`
}

/**
 * Cached per-locale script with the whole UI catalog. It loads before the realtime client, so messages that
 * arrive at runtime (API and host-agent responses) resolve as well as those in the cached client code.
 */
export const clientI18nAsset = (locale: Locale): string =>
  `(()=>{${CLIENT_RUNTIME}(${scriptJson(Object.fromEntries(catalogFor(locale)))},${scriptJson(locale)})})();\n`
