// Just enough of the PostgreSQL lexical grammar to tell code from comments,
// string literals, quoted identifiers and dollar-quoted bodies.

export type SegmentKind = 'code' | 'comment' | 'string' | 'ident' | 'dollar'

export interface Segment {
  kind: SegmentKind
  text: string
}

const IDENT_CHAR = /[A-Za-z0-9_$]/
const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/

const unterminated = (what: string, at: number): never => {
  throw new Error(`unterminated ${what} at offset ${at}`)
}

const blockCommentEnd = (sql: string, start: number): number => {
  let depth = 1
  let i = start + 2
  while (i < sql.length) {
    if (sql.startsWith('/*', i)) {
      depth++
      i += 2
    } else if (sql.startsWith('*/', i)) {
      depth--
      i += 2
      if (depth === 0) return i
    } else i++
  }
  return unterminated('block comment', start)
}

const quotedEnd = (sql: string, start: number, quote: string, backslashEscapes: boolean): number => {
  let i = start + 1
  while (i < sql.length) {
    const c = sql[i]
    if (backslashEscapes && c === '\\') i += 2
    else if (c === quote) {
      if (sql[i + 1] === quote) i += 2
      else return i + 1
    } else i++
  }
  return unterminated(quote === "'" ? 'string literal' : 'quoted identifier', start)
}

const isEscapeString = (sql: string, quoteAt: number): boolean => {
  const prev = sql[quoteAt - 1]
  if (prev !== 'e' && prev !== 'E') return false
  const before = sql[quoteAt - 2]
  return before === undefined || !IDENT_CHAR.test(before)
}

/** Splits SQL text into segments; throws on unterminated quotes or comments. */
export const lexSql = (sql: string): Segment[] => {
  const out: Segment[] = []
  let code = ''
  const flush = (): void => {
    if (code) out.push({ kind: 'code', text: code })
    code = ''
  }
  const push = (kind: SegmentKind, from: number, to: number): number => {
    flush()
    out.push({ kind, text: sql.slice(from, to) })
    return to
  }
  let i = 0
  while (i < sql.length) {
    const c = sql[i] as string
    if (sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i)
      i = push('comment', i, nl === -1 ? sql.length : nl)
    } else if (sql.startsWith('/*', i)) {
      i = push('comment', i, blockCommentEnd(sql, i))
    } else if (c === "'") {
      i = push('string', i, quotedEnd(sql, i, "'", isEscapeString(sql, i)))
    } else if (c === '"') {
      i = push('ident', i, quotedEnd(sql, i, '"', false))
    } else if (c === '$' && (i === 0 || !IDENT_CHAR.test(sql[i - 1] as string))) {
      const tag = DOLLAR_TAG.exec(sql.slice(i, i + 66))?.[0]
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length)
        if (end === -1) unterminated('dollar-quoted string', i)
        i = push('dollar', i, end + tag.length)
      } else {
        code += c
        i++
      }
    } else {
      code += c
      i++
    }
  }
  flush()
  return out
}

/** SQL text with comments replaced by a space; literals and bodies are kept. */
export const stripComments = (sql: string): string =>
  lexSql(sql)
    .map((s) => (s.kind === 'comment' ? ' ' : s.text))
    .join('')

/** Top-level statements (split on ';' outside literals), comments removed, trimmed, non-empty. */
export const splitStatements = (sql: string): string[] => {
  const statements: string[] = []
  let current = ''
  for (const s of lexSql(sql)) {
    if (s.kind === 'comment') {
      current += ' '
      continue
    }
    if (s.kind !== 'code') {
      current += s.text
      continue
    }
    const parts = s.text.split(';')
    current += parts[0]
    for (const part of parts.slice(1)) {
      statements.push(current)
      current = part
    }
  }
  statements.push(current)
  return statements.map((st) => st.trim()).filter((st) => st.length > 0)
}
