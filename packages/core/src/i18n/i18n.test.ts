import { describe, expect, it } from 'vitest'
import {
  LOCALES,
  catalogFromEntries,
  compileMessage,
  createTranslator,
  escapeMessageText,
  formatPo,
  isLocale,
  localeDirection,
  lookupLocale,
  messageArguments,
  msgctxt,
  negotiateLocale,
  parseAcceptLanguage,
  parseMessage,
  parsePo,
  pickMessages,
} from './index.ts'

describe('locale registry and negotiation', () => {
  it('lists valid, unique BCP 47 tags with endonyms and directions', () => {
    const tags = LOCALES.map(info => info.tag)
    expect(new Set(tags).size).toBe(tags.length)
    for (const info of LOCALES) {
      expect(Intl.getCanonicalLocales(info.tag)).toEqual([info.tag])
      expect(new Intl.DisplayNames([info.tag], { type: 'language' }).of(info.tag)).toBeTruthy()
      expect(info.nativeName.length).toBeGreaterThan(0)
      expect(new Intl.Locale(info.tag).maximize().script).toBe(info.script)
      expect((new Intl.Locale(info.tag) as Intl.Locale & { getTextInfo(): { direction: string } }).getTextInfo().direction).toBe(info.dir)
    }
    expect(localeDirection('ar')).toBe('rtl')
    expect(localeDirection('en')).toBe('ltr')
    expect(isLocale('ar')).toBe(true)
    expect(isLocale('AR')).toBe(false)
  })

  it('follows RFC 4647 lookup, including singleton truncation', () => {
    expect(lookupLocale('ar-EG')).toBe('ar')
    expect(lookupLocale('AR-latn-x-private')).toBe('ar')
    expect(lookupLocale('en-US-x-a')).toBe('en')
    expect(lookupLocale('fr-CA')).toBeUndefined()
    expect(lookupLocale('')).toBeUndefined()
  })

  it('orders Accept-Language ranges by quality, then position', () => {
    expect(parseAcceptLanguage('fr;q=0.9, ar-SA, en;q=0.8, *;q=0.1, de;q=0')).toEqual(['ar-SA', 'fr', 'en'])
    expect(parseAcceptLanguage('en;q=bad, ar')).toEqual(['ar'])
    expect(parseAcceptLanguage(undefined)).toEqual([])
  })

  it('prefers the explicit request, then the browser, then English', () => {
    expect(negotiateLocale({ requested: 'ar', acceptLanguage: 'en' })).toBe('ar')
    expect(negotiateLocale({ requested: 'xx', acceptLanguage: 'fr, ar;q=0.5' })).toBe('ar')
    expect(negotiateLocale({ acceptLanguage: 'fr' })).toBe('en')
    expect(negotiateLocale({})).toBe('en')
  })
})

describe('ICU message subset', () => {
  it('formats arguments, select and CLDR plural categories', () => {
    const files = '{count, plural, =0 {لا ملفات} one {ملف واحد} two {ملفان} few {# ملفات} many {# ملفًا} other {# ملف}}'
    const render = compileMessage(files, 'ar')
    expect([0, 1, 2, 3, 11, 100].map(count => render({ count }))).toEqual(['لا ملفات', 'ملف واحد', 'ملفان', '3 ملفات', '11 ملفًا', '100 ملف'])
    expect(compileMessage('{n, plural, one {# file} other {# files}} in {dir}', 'en')({ n: 1234, dir: '/home' })).toBe('1,234 files in /home')
    expect(compileMessage('{kind, select, cron {Scheduled} other {Manual}}', 'en')({ kind: 'cron' })).toBe('Scheduled')
    expect(compileMessage('{kind, select, cron {Scheduled} other {Manual}}', 'en')({ kind: 'x' })).toBe('Manual')
    expect(compileMessage('{n, plural, offset:1 =0 {nobody} one {you} other {you and # others}}', 'en')({ n: 3 })).toBe('you and 2 others')
  })

  it('inserts plain arguments verbatim and leaves missing ones visible', () => {
    expect(compileMessage('Port {port} on {host}', 'en')({ port: 8080 })).toBe('Port 8080 on {host}')
  })

  it('handles apostrophe quoting', () => {
    expect(compileMessage("Don't stop", 'en')()).toBe("Don't stop")
    expect(compileMessage("Use '{name}' literally, it''s fine", 'en')()).toBe("Use {name} literally, it's fine")
    for (const text of ['Path {a}/{b}', "it''s", 'JSON {"a": 1}', "Don't", 'plain']) {
      expect(compileMessage(escapeMessageText(text), 'en')()).toBe(text)
    }
  })

  it('rejects malformed messages and reports argument names', () => {
    expect(() => parseMessage('{open')).toThrow(/Invalid message/)
    expect(() => parseMessage('close}')).toThrow(/Invalid message/)
    expect(() => parseMessage('{n, plural, one {x}}')).toThrow(/other/)
    expect(() => parseMessage('{n, number}')).toThrow(/unsupported/)
    expect([...messageArguments('{a} {n, plural, other {# {b}}}')].sort()).toEqual(['a', 'b', 'n'])
  })

  it('stays self-contained for client serialization', () => {
    const client = new Function(`const parseMessage=${parseMessage.toString()};const compileMessage=${compileMessage.toString()};return compileMessage`)() as typeof compileMessage
    expect(client('{n, plural, one {# item} other {# items}}', 'en')({ n: 2 })).toBe('2 items')
  })
})

describe('PO catalogs and translators', () => {
  const po = [
    'msgid ""',
    'msgstr ""',
    '"Language: ar\\n"',
    '"Content-Type: text/plain; charset=UTF-8\\n"',
    '',
    '#: apps/web/src/example.ts',
    'msgid "Save"',
    'msgstr "حفظ"',
    '',
    'msgctxt "mail"',
    'msgid "Present"',
    'msgstr "موجودة"',
    '',
    'msgid ""',
    '"Line one\\n"',
    '"with \\"quotes\\""',
    'msgstr "سطر\\n\\"اقتباس\\""',
    '',
    'msgid "Untranslated"',
    'msgstr ""',
    '',
  ].join('\n')

  it('parses headers, contexts, comments and continuations, and round-trips', () => {
    const catalog = parsePo(po)
    expect(catalog.header).toEqual({ Language: 'ar', 'Content-Type': 'text/plain; charset=UTF-8' })
    expect(catalog.entries).toHaveLength(4)
    expect(catalog.entries[0]).toEqual({ id: 'Save', translation: 'حفظ', comments: ['#: apps/web/src/example.ts'] })
    expect(catalog.entries[1]).toEqual({ context: 'mail', id: 'Present', translation: 'موجودة' })
    expect(catalog.entries[2]?.id).toBe('Line one\nwith "quotes"')
    expect(parsePo(formatPo(catalog))).toEqual(catalog)
  })

  it('rejects duplicates, gettext plurals and stray lines', () => {
    expect(() => parsePo('msgid "a"\nmsgstr "b"\n\nmsgid "a"\nmsgstr "c"\n')).toThrow(/Duplicate/)
    expect(() => parsePo('msgid "a"\nmsgid_plural "as"\nmsgstr[0] "b"\n')).toThrow(/ICU/)
    expect(() => parsePo('nonsense\n')).toThrow(/Invalid PO line 1/)
    expect(() => parsePo('msgid "a\\q"\nmsgstr ""\n')).toThrow(/escape/)
  })

  it('translates with context and falls back to the source text', () => {
    const catalog = catalogFromEntries(parsePo(po).entries)
    const ar = createTranslator('ar', catalog)
    expect(ar('Save')).toBe('حفظ')
    expect(ar(msgctxt('mail', 'Present'))).toBe('موجودة')
    expect(ar('Present')).toBe('Present')
    expect(ar('Untranslated')).toBe('Untranslated')
    expect(createTranslator('en')(msgctxt('mail', 'Present'))).toBe('Present')
    expect(ar.locale).toBe('ar')
    expect(ar('data {with} {braces')).toBe('data {with} {braces')
    expect(pickMessages(catalog, ['Save', 'Missing'])).toEqual({ Save: 'حفظ' })
  })
})
