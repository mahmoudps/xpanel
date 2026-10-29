import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CATALOG_LOCALE_DIR } from '@xpanel/catalog'
import { LOCALES, SOURCE_LOCALE, catalogKey, messageArguments, parseMessage, parsePo } from '@xpanel/core'
import { collectMessages, sourceFiles, WEB_CATALOG_DIR } from '../../../scripts/i18n-catalog.mjs'

const translated = LOCALES.filter(info => info.tag !== SOURCE_LOCALE)
const catalogs = translated.flatMap(info => [
  { tag: info.tag, domain: 'web', path: join(WEB_CATALOG_DIR, `${info.tag}.po`) },
  { tag: info.tag, domain: 'catalog', path: join(CATALOG_LOCALE_DIR, `${info.tag}.po`) },
])
const read = (path: string) => parsePo(readFileSync(path, 'utf8'))
const { used, literals } = collectMessages()

describe('translation catalogs', () => {
  it('exist for every registry locale and name their language', () => {
    for (const { tag, path } of catalogs) {
      expect(existsSync(path), path).toBe(true)
      expect(read(path).header.Language).toBe(tag)
    }
  })

  it('hold valid ICU messages whose placeholders match the source', () => {
    const problems: string[] = []
    for (const { path } of catalogs) for (const entry of read(path).entries) {
      try {
        parseMessage(entry.id)
        parseMessage(entry.translation)
        // An empty msgstr is gettext's "untranslated": the source message is shown.
        if (entry.translation === '') continue
        const source = [...messageArguments(entry.id)].sort().join(), target = [...messageArguments(entry.translation)].sort().join()
        if (source !== target) problems.push(`${JSON.stringify(entry.id)}: {${source}} != {${target}}`)
      } catch (error) {
        problems.push(`${JSON.stringify(entry.id)}: ${(error as Error).message}`)
      }
    }
    expect(problems).toEqual([])
  })

  it('use ASCII digits only', () => {
    for (const { path } of catalogs) {
      const bad = read(path).entries.filter(entry => /[٠-٩۰-۹]/.test(entry.translation)).map(entry => entry.id)
      expect(bad, path).toEqual([])
    }
  })

  it('translate every message the product code uses', () => {
    for (const info of translated) {
      const keys = new Set(read(join(WEB_CATALOG_DIR, `${info.tag}.po`)).entries.map(entry => catalogKey(entry.id, entry.context)))
      const missing = [...used].filter(([key]) => !keys.has(key)).map(([key, message]) => `${JSON.stringify(key)} (${[...message.files].join(', ')})`)
      expect(missing, info.tag).toEqual([])
    }
  })

  it('carry no message the product code no longer uses', () => {
    for (const info of translated) {
      const unused = read(join(WEB_CATALOG_DIR, `${info.tag}.po`)).entries.filter(entry => !literals.has(entry.id)).map(entry => catalogKey(entry.id, entry.context))
      expect(unused, info.tag).toEqual([])
    }
  })
})

describe('product sources', () => {
  const sources = sourceFiles().map(path => ({ path, text: readFileSync(path, 'utf8') }))
  // The registry spells each language in its own script (endonyms); every other translation lives in a catalog.
  const registry = /packages[\\/]core[\\/]src[\\/]i18n[\\/]locales\.ts$/

  it('contain no inline translations', () => {
    const inline = sources.filter(file => !registry.test(file.path) && /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFC]/.test(file.text)).map(file => file.path)
    expect(inline).toEqual([])
  })

  it('choose text and direction from the registry, not from a language code', () => {
    // Fixtures name their Arabic specimen variant; they are sample data, not product UI.
    const branches = sources.filter(file => !/\.fixture\.ts$/.test(file.path)).flatMap(file => [...file.text.matchAll(/[\w$.)\]]\s*[!=]==?\s*['"]ar['"]|['"]ar['"]\s*[!=]==?\s*[\w$.(]/g)].map(match => `${file.path}: ${match[0]}`))
    expect(branches).toEqual([])
  })
})
