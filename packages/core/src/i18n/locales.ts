/** Locale registry: the single source for supported languages, their names and writing direction. */

export interface LocaleInfo {
  /** BCP 47 language tag. */
  readonly tag: string
  /** English name, for logs and administrators. */
  readonly name: string
  /** Endonym shown in the language switcher. */
  readonly nativeName: string
  readonly dir: 'ltr' | 'rtl'
  /** ISO 15924 script, which selects the type layer (for example Arabic-script typography). */
  readonly script: string
}

export const LOCALES = [
  { tag: 'en', name: 'English', nativeName: 'English', dir: 'ltr', script: 'Latn' },
  { tag: 'ar', name: 'Arabic', nativeName: 'العربية', dir: 'rtl', script: 'Arab' },
] as const satisfies readonly LocaleInfo[]

export type Locale = (typeof LOCALES)[number]['tag']

/** Messages are authored in this locale; every other catalog translates it. */
export const SOURCE_LOCALE = 'en' satisfies Locale

const BY_TAG = new Map<string, LocaleInfo>(LOCALES.map(info => [info.tag.toLowerCase(), info]))

export const isLocale = (value: unknown): value is Locale => typeof value === 'string' && LOCALES.some(info => info.tag === value)

export const localeInfo = (tag: Locale): LocaleInfo => BY_TAG.get(tag.toLowerCase())!

export const localeDirection = (tag: Locale): 'ltr' | 'rtl' => localeInfo(tag).dir

/** RFC 4647 section 3.4 lookup: the longest supported prefix of a language range, or undefined. */
export function lookupLocale(range: string): Locale | undefined {
  let candidate = range.trim().toLowerCase()
  while (candidate) {
    const match = BY_TAG.get(candidate)
    if (match) return match.tag as Locale
    const cut = candidate.lastIndexOf('-')
    if (cut < 0) return undefined
    candidate = candidate.slice(0, cut)
    // A trailing singleton (such as "x" or "u") never stands alone.
    if (/-[a-z0-9]$/.test(candidate)) candidate = candidate.slice(0, -2)
  }
  return undefined
}

/** Language ranges of an Accept-Language header, best quality first (RFC 9110 section 12.5.4). */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return []
  return header.split(',')
    .map((part, index) => {
      const [range = '', ...params] = part.trim().split(';')
      const q = params.map(param => param.trim()).find(param => /^q=/i.test(param))
      const quality = q === undefined ? 1 : Number(q.slice(2))
      return { range: range.trim(), quality: Number.isFinite(quality) ? quality : 0, index }
    })
    .filter(item => item.range && item.range !== '*' && item.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index)
    .map(item => item.range)
}

/** An explicit request wins, then the browser's language ranges, then the source locale. */
export function negotiateLocale(input: { readonly requested?: string | null; readonly acceptLanguage?: string | null }): Locale {
  const explicit = input.requested ? lookupLocale(input.requested) : undefined
  if (explicit) return explicit
  for (const range of parseAcceptLanguage(input.acceptLanguage)) {
    const match = lookupLocale(range)
    if (match) return match
  }
  return SOURCE_LOCALE
}
