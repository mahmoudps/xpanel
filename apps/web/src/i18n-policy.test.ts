import { afterEach, describe, expect, it } from 'vitest'
import { MAX_CATALOG_BYTES, alternateLocales, clientI18nAsset, installLocaleOverrides, localePolicy, requestLocale, requestedLocale, setLocalePolicy, translator, validateLocaleCatalog } from './i18n.ts'

const page = (query: string, acceptLanguage?: string) => {
  const url = new URL('http://panel.test/whm' + query)
  return [url, new Request(url, acceptLanguage ? { headers: { 'accept-language': acceptLanguage } } : {})] as const
}
const po = (body: string) => `msgid ""\nmsgstr ""\n"Language: ar\\n"\n\n${body}\n`
afterEach(() => { setLocalePolicy(null); installLocaleOverrides({}) })

describe('locale policy', () => {
  it('keeps release negotiation when no policy is installed', () => {
    expect(localePolicy()).toEqual({ offered: ['en', 'ar'], defaultLocale: 'en' })
    expect(requestLocale(...page('?lang=ar'))).toBe('ar')
    expect(requestLocale(...page('', 'ar-EG,en;q=0.5'))).toBe('ar')
    expect(requestLocale(...page('', 'fr'))).toBe('en')
    expect(alternateLocales('en').map(info => info.tag)).toEqual(['ar'])
  })
  it('ignores non-offered locales in ?lang= and Accept-Language and falls back to the default', () => {
    setLocalePolicy({ offered: ['en'], defaultLocale: 'en' })
    expect(requestedLocale(page('?lang=ar')[0])).toBeUndefined()
    expect(requestLocale(...page('?lang=ar', 'ar'))).toBe('en')
    expect(alternateLocales('en')).toEqual([])
    setLocalePolicy({ offered: ['ar', 'en'], defaultLocale: 'ar' })
    expect(localePolicy().offered).toEqual(['en', 'ar'])
    expect(requestLocale(...page('', 'fr, de'))).toBe('ar')
    expect(requestLocale(...page('', 'fr, en'))).toBe('en')
  })
  it('refuses an empty policy or a default that is not offered', () => {
    expect(() => setLocalePolicy({ offered: [], defaultLocale: 'en' })).toThrow()
    expect(() => setLocalePolicy({ offered: ['ar'], defaultLocale: 'en' })).toThrow()
  })
})

describe('catalog overrides', () => {
  it('validates encoding, size and the source locale before parsing', () => {
    expect(validateLocaleCatalog('en', po('')).problems).toEqual([{ field: 'catalog', code: 'source_locale' }])
    expect(validateLocaleCatalog('ar', po('msgid "Not read"\nmsgstr "�"')).problems).toEqual([{ field: 'catalog', code: 'encoding' }])
    expect(validateLocaleCatalog('ar', 'x'.repeat(MAX_CATALOG_BYTES + 1)).problems).toEqual([{ field: 'catalog', code: 'too_large' }])
    expect(validateLocaleCatalog('ar', po('')).problems).toEqual([{ field: 'catalog', code: 'empty' }])
  })
  it('reports at most twenty problems with the total count', () => {
    const many = Array.from({ length: 25 }, (_, index) => `msgid "No such message ${index}"\nmsgstr "x"`).join('\n\n')
    const result = validateLocaleCatalog('ar', po(many))
    expect(result.problemCount).toBe(25)
    expect(result.problems).toHaveLength(20)
    expect(result.entries).toEqual([])
  })
  it('merges a valid override into server translators and the client catalog asset; empty msgstr keeps the release text', () => {
    const before = translator('ar')('(sent to {address})', { address: 'a' })
    expect(installLocaleOverrides({ ar: po('msgid "(sent to {address})"\nmsgstr "(override {address})"\n\nmsgid "Not read"\nmsgstr ""') })).toEqual({ applied: ['ar'], rejected: [] })
    expect(translator('ar')('(sent to {address})', { address: 'a' })).toBe('(override a)')
    expect(translator('ar')('Not read')).not.toBe('Not read')
    expect(clientI18nAsset('ar')).toContain('(override {address})')
    installLocaleOverrides({})
    expect(translator('ar')('(sent to {address})', { address: 'a' })).toBe(before)
    expect(installLocaleOverrides({ ar: po('msgid "No such message here"\nmsgstr "x"') })).toEqual({ applied: [], rejected: ['ar'] })
  })
})

describe('Arabic release catalog wording', () => {
  const ar = translator('ar')
  it('isolates number ranges so they keep their order between Arabic words', () => {
    expect(ar('One port or a range such as 8000-8100. Leave source empty for any source.')).toContain('\u20668000-8100\u2069')
    expect(ar('{start}–{end} of {total} loaded rows · Page {page} of {totalPages}', { start: 1, end: 6, total: 6, page: 1, totalPages: 1 })).toMatch(/^\u20661–6\u2069 /)
    expect(ar('1–{shown} of {total}', { shown: 3, total: 3 })).toMatch(/^\u20661–3\u2069 /)
  })
  it('names a source and an origin with different words', () => {
    expect([ar('Source'), ar('Origin')]).toEqual(['المصدر', 'المنشأ'])
  })
})
