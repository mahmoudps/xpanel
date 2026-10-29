/**
 * GNU gettext PO catalogs: msgctxt, msgid, msgstr and comments. Messages use ICU MessageFormat
 * (see message.ts), so msgid_plural is rejected rather than half supported.
 */

export interface PoEntry {
  readonly context?: string
  readonly id: string
  readonly translation: string
  /** Comment lines exactly as written, including their `#`, `#.`, `#:` or `#,` marker. */
  readonly comments?: readonly string[]
}

/** gettext's context separator (EOT): a context-qualified key is `context + EOT + id`. */
export const CONTEXT_SEPARATOR = '\u0004'

export const catalogKey = (id: string, context?: string): string => (context ? context + CONTEXT_SEPARATOR + id : id)

const ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' }

const unescape = (value: string, line: number): string => value.replace(/\\(.)/g, (_match, char: string) => {
  const decoded = ESCAPES[char]
  if (decoded === undefined) throw new Error(`Invalid PO escape \\${char} on line ${line}`)
  return decoded
})

const escape = (value: string): string => value.replace(/[\\"\n\t\r]/g, char => ({ '\\': '\\\\', '"': '\\"', '\n': '\\n', '\t': '\\t', '\r': '\\r' })[char]!)

export interface PoCatalog {
  readonly header: Readonly<Record<string, string>>
  readonly entries: readonly PoEntry[]
}

export function parsePo(text: string): PoCatalog {
  const entries: PoEntry[] = []
  let header: Record<string, string> = {}
  let comments: string[] = []
  let context: string | undefined
  let id: string | undefined
  let translation: string | undefined
  let field: 'context' | 'id' | 'translation' | undefined
  const keys = new Set<string>()
  const flush = (line: number) => {
    if (id === undefined) { if (context !== undefined) throw new Error(`PO msgctxt without msgid before line ${line}`); return }
    if (translation === undefined) throw new Error(`PO msgid without msgstr before line ${line}`)
    if (id === '' && context === undefined) {
      header = Object.fromEntries(translation.split('\n').filter(Boolean).map(row => {
        const colon = row.indexOf(':')
        return [row.slice(0, colon).trim(), row.slice(colon + 1).trim()]
      }))
    } else {
      const key = catalogKey(id, context)
      if (keys.has(key)) throw new Error(`Duplicate PO message before line ${line}: ${JSON.stringify(key)}`)
      keys.add(key)
      entries.push({ ...(context !== undefined ? { context } : {}), id, translation, ...(comments.length ? { comments } : {}) })
    }
    comments = []; context = undefined; id = undefined; translation = undefined; field = undefined
  }
  const lines = text.split(/\r?\n/)
  for (const [index, raw] of lines.entries()) {
    const number = index + 1
    const line = raw.trim()
    if (!line) { flush(number); continue }
    if (line.startsWith('#')) { if (id !== undefined) flush(number); comments.push(line); continue }
    const keyword = /^(msgctxt|msgid|msgstr|msgid_plural|msgstr\[\d+\])\s+"(.*)"$/.exec(line)
    if (keyword) {
      const [, name = '', value = ''] = keyword
      if (name !== 'msgctxt' && name !== 'msgid' && name !== 'msgstr') throw new Error(`PO ${name} on line ${number} is not supported; write plurals as ICU messages`)
      if (name !== 'msgstr' && id !== undefined) flush(number)
      field = name === 'msgctxt' ? 'context' : name === 'msgid' ? 'id' : 'translation'
      const decoded = unescape(value, number)
      if (field === 'context') context = decoded
      else if (field === 'id') id = decoded
      else translation = decoded
      continue
    }
    const continuation = /^"(.*)"$/.exec(line)
    if (continuation && field) {
      const decoded = unescape(continuation[1] ?? '', number)
      if (field === 'context') context = (context ?? '') + decoded
      else if (field === 'id') id = (id ?? '') + decoded
      else translation = (translation ?? '') + decoded
      continue
    }
    throw new Error(`Invalid PO line ${number}: ${raw}`)
  }
  flush(lines.length + 1)
  return { header, entries }
}

export function formatPo(catalog: PoCatalog): string {
  const head = Object.entries(catalog.header).map(([name, value]) => `"${escape(`${name}: ${value}\n`)}"`)
  const blocks = [['msgid ""', 'msgstr ""', ...head].join('\n')]
  for (const entry of catalog.entries) {
    blocks.push([
      ...(entry.comments ?? []),
      ...(entry.context !== undefined ? [`msgctxt "${escape(entry.context)}"`] : []),
      `msgid "${escape(entry.id)}"`,
      `msgstr "${escape(entry.translation)}"`,
    ].join('\n'))
  }
  return blocks.join('\n\n') + '\n'
}
