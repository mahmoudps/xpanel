import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { formatPo, msgctxt, type PoEntry } from '@xpanel/core'
import { catalogFor, renderClientI18nScript, translator } from './i18n.ts'
import { createThemeMessages, loadThemeMessages, type ThemeCatalogOverlay } from './theme-messages.ts'
import { collectMessages, collectThemeMessages, splitMessageCalls } from '../../../scripts/i18n-catalog.mjs'

const po = (locale: string, entries: readonly PoEntry[]) => formatPo({
  header: { Language: locale, 'Content-Type': 'text/plain; charset=UTF-8' }, entries,
})
const entry = (id: string, translation = '', themeId = 'sample'): PoEntry => ({ context: 'theme:' + themeId, id, translation })
const source = po('en', [entry('Hello {name}'), entry('{count, plural, one {# item} other {# items}}')])

it('uses theme-owned ICU messages and live shared-core fallback with ASCII values', () => {
  const bundle = createThemeMessages('sample', source, { ar: po('ar', [entry('Hello {name}', 'مرحبًا {name}')]) })
  expect(bundle.translator('ar')(msgctxt('theme:sample', 'Hello {name}'), { name: '\u0661\u0662' })).toBe('مرحبًا 12')
  expect(bundle.translator('ar')(msgctxt('theme:sample', '{count, plural, one {# item} other {# items}}'), { count: 2 })).toContain('2 items')
  expect(bundle.translator('ar')('Close')).toBe(translator('ar')('Close'))
  expect(bundle.translator('en')(msgctxt('theme:sample', 'Hello {name}'), { name: 'Sam' })).toBe('Hello Sam')
})

it.each([
  [po('ar', [{ id: 'Close', translation: 'Different' }]), 'theme_message_scope'],
  [po('ar', [entry('Hello {name}', 'Hello {other}')]), 'theme_message_placeholders'],
  [po('ar', [entry('Hello {name}', '\u0661 {name}')]), 'theme_message_digits'],
  [po('ar', [entry('Unknown', 'New')]), 'theme_message_unknown'],
  [po('ar', [entry('Hello {name}', 'Other {name}', 'other')]), 'theme_message_scope'],
  [po('en', [entry('Hello {name}', 'Hello {name}')]), 'theme_message_language'],
])('rejects an invalid or foreign theme catalog', (translation, code) => {
  expect(() => createThemeMessages('sample', source, { ar: translation })).toThrow(code)
})

it('keeps English source entries untranslated and validates ICU before use', () => {
  expect(() => createThemeMessages('sample', po('en', [entry('Hello', 'Different')]))).toThrow('theme_message_source_translation')
  expect(() => createThemeMessages('sample', po('en', [entry('Broken {')]))).toThrow()
  expect(() => createThemeMessages('sample', source, { ar: po('ar', [entry('Hello {name}', 'Broken {')]) })).toThrow()
})

it('cannot read another theme or mutate another response through its client map', () => {
  const first = createThemeMessages('sample', source, { ar: po('ar', [entry('Hello {name}', 'مرحبًا {name}')]) })
  const second = createThemeMessages('other', po('en', [entry('Hello {name}', '', 'other')]), { ar: po('ar', [entry('Hello {name}', 'أهلًا {name}', 'other')]) })
  const copy = first.forClient('ar').messages as Map<string, string>
  copy.set(msgctxt('theme:sample', 'Hello {name}'), 'changed')
  expect(first.translator('ar')(msgctxt('theme:sample', 'Hello {name}'), { name: 'A' })).toBe('مرحبًا A')
  expect(first.forClient('ar').messages.get(msgctxt('theme:sample', 'Hello {name}'))).toBe('مرحبًا {name}')
  expect(second.translator('ar')(msgctxt('theme:other', 'Hello {name}'), { name: 'A' })).toBe('أهلًا A')
  expect(() => first.translator('ar')(msgctxt('theme:other', 'Hello {name}'), { name: 'A' })).toThrow('theme_message_scope')
})

it('keeps empty installed classic overlays byte-identical and leaves core catalogs unchanged', () => {
  const bundle = loadThemeMessages('classic', new URL('./themes/classic/locales/', import.meta.url))
  const keys = ['Close', 'Username']
  const before = [...catalogFor('ar')]
  expect(bundle.forClient('ar').messages.size).toBe(0)
  expect(renderClientI18nScript('ar', keys, bundle.forClient('ar'))).toBe(renderClientI18nScript('ar', keys))
  expect([...catalogFor('ar')]).toEqual(before)
})

it('includes all owned client copy safely, including messages used by external theme assets', () => {
  const id = 'Owned copy'
  const bundle = createThemeMessages('sample', po('en', [entry(id)]), { ar: po('ar', [entry(id, '</script><img src=x>')]) })
  const script = renderClientI18nScript('ar', [], bundle.forClient('ar'))
  expect(script).toContain('theme:sample')
  expect(script).toContain('\\u003c/script>')
  expect(script).not.toContain('</script><img')
  const forged: ThemeCatalogOverlay = { themeId: 'sample', locale: 'ar', messages: new Map([['Close', 'changed']]) }
  expect(() => renderClientI18nScript('ar', [], forged)).toThrow('theme_message_scope')
  expect(() => renderClientI18nScript('en', [], bundle.forClient('ar'))).toThrow('theme_message_scope')
})

it('partitions owned theme calls while retaining shared classic messages in core extraction', () => {
  const calls = [{ id: 'Close', line: 1 }, { id: 'Shared', context: 'app', line: 2 }, { id: 'Unique', context: 'theme:classic', line: 3 }]
  const split = splitMessageCalls('apps/web/src/themes/classic/index.ts', calls)
  expect(split.core).toEqual(calls.slice(0, 2))
  expect(split.theme).toEqual(calls.slice(2))
  expect(split.themeId).toBe('classic')
  expect(() => splitMessageCalls('apps/web/src/app.ts', calls)).toThrow('theme_message_source_scope')
  expect(() => splitMessageCalls('apps/web/src/themes/v2/index.ts', calls)).toThrow('theme_message_source_scope')
})

it('extracts theme and core catalogs through the actual file collector without cross-contamination', () => {
  const root = mkdtempSync(join(tmpdir(), 'xpanel-theme-messages-'))
  try {
    for (const path of ['apps/web/src/themes/classic', 'apps/api/src', 'apps/agent/src', 'packages']) mkdirSync(join(root, path), { recursive: true })
    writeFileSync(join(root, 'apps/web/src/themes/classic/page.ts'), "translator(locale)('Close'); msgctxt('theme:classic', 'Own copy')")
    writeFileSync(join(root, 'apps/api/src/message.ts'), "msgctxt('app', 'Shared')")
    const shared = collectMessages(root).used
    const owned = collectThemeMessages('classic', root).used
    expect([...shared.keys()]).toEqual(expect.arrayContaining(['Close', msgctxt('app', 'Shared')]))
    expect(shared.has(msgctxt('theme:classic', 'Own copy'))).toBe(false)
    expect([...owned.keys()]).toEqual([msgctxt('theme:classic', 'Own copy')])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
