import { CONTEXT_SEPARATOR, catalogKey, type PoEntry } from './po.ts'
import { compileMessage, type MessageValues } from './message.ts'
import type { Locale } from './locales.ts'

/** Translations for one locale, keyed by gettext msgid or by a context-qualified key. */
export type Catalog = ReadonlyMap<string, string>

/** Entries without a translation are left out, so lookups fall back to the source message. */
export const catalogFromEntries = (entries: readonly PoEntry[]): Catalog =>
  new Map(entries.filter(entry => entry.translation !== '').map(entry => [catalogKey(entry.id, entry.context), entry.translation]))

/** Marks a source message for extraction where it is stored before being translated. */
export const msgid = (message: string): string => message

/** A context-qualified message (gettext pgettext): same source text, separate translation. */
export const msgctxt = (context: string, message: string): string => catalogKey(message, context)

/** The source text of a possibly context-qualified message. */
export const sourceMessage = (message: string): string => message.slice(message.indexOf(CONTEXT_SEPARATOR) + 1)

export interface Translate {
  /** Translates a source message (or a msgctxt key); falls back to the source text when untranslated. */
  (message: string, values?: MessageValues): string
  readonly locale: Locale
}

export function createTranslator(locale: Locale, catalog: Catalog = new Map()): Translate {
  const compiled = new Map<string, (values?: MessageValues) => string>()
  const translate = (message: string, values?: MessageValues): string => {
    let render = compiled.get(message)
    if (!render) {
      const translation = catalog.get(message)
      const source = translation ?? sourceMessage(message)
      try {
        render = compileMessage(source, locale)
      } catch (error) {
        // Catalog messages are validated by tests; text that is not a catalog message renders as written.
        if (translation !== undefined) throw error
        render = () => source
      }
      // shortcut: callers sometimes pass data text, so the cache is bounded by clearing; an LRU is not worth it yet.
      if (compiled.size >= 20_000) compiled.clear()
      compiled.set(message, render)
    }
    return render(values)
  }
  return Object.assign(translate, { locale })
}

/** The catalog entries a page's client scripts look up, keyed exactly as the scripts ask for them. */
export function pickMessages(catalog: Catalog, keys: Iterable<string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of keys) {
    const value = catalog.get(key)
    if (value !== undefined) out[key] = value
  }
  return out
}
