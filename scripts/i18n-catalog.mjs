#!/usr/bin/env node
// Message catalog tooling for the gettext/ICU translation system (apps/web/src/i18n.ts).
//
//   node scripts/i18n-catalog.mjs check   report missing, unused and invalid catalog messages
//   node scripts/i18n-catalog.mjs refs    rewrite the `#:` source references in every PO catalog
//   node scripts/i18n-catalog.mjs pot     write apps/web/src/locales/messages.pot (template for a new locale)
//
// Messages are found the way xgettext finds keywords: the first string literal passed to msgid, xpT,
// a translator call `translator(locale)(...)` or a local translation helper (t, copy, text, label), and
// msgctxt(context, message) pairs. Browser code written inside template strings is scanned as well.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const WEB_CATALOG_DIR = join(ROOT, 'apps/web/src/locales')
export const SOURCE_ROOTS = ['apps/web/src', 'apps/api/src', 'apps/agent/src', 'packages']
const HELPERS = new Set(['t', 'copy', 'text', 'label', 'xpT', 'msgid'])
const CONTEXT_SEPARATOR = '\u0004'

// ---- lexer: strings, templates with nested interpolations, comments, regex literals
const REGEX_AFTER_PUNCT = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '=>', '&&', '||', '??', '===', '!==', '==', '!=', '+=', '-=', '...'])
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'of', 'in', 'delete', 'void', 'throw', 'new', 'else', 'do', 'yield', 'await'])
const PUNCT3 = ['===', '!==', '...', '??=', '**=', '||=', '&&=']
const PUNCT2 = ['=>', '&&', '||', '??', '==', '!=', '<=', '>=', '+=', '-=', '?.', '++', '--', '**']

function lex(src, start = 0, end = src.length, interpolation = false) {
  const tokens = []
  let i = start, depth = 0
  const push = (type, s, e, extra) => tokens.push({ type, start: s, end: e, text: src.slice(s, e), ...extra })
  while (i < end) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue }
    if (c === '/' && src[i + 1] === '/') { while (i < end && src[i] !== '\n') i++; continue }
    if (c === '/' && src[i + 1] === '*') { const close = src.indexOf('*/', i + 2); i = close < 0 ? end : close + 2; continue }
    if (c === "'" || c === '"') { const s = i++; while (i < end && src[i] !== c && src[i] !== '\n') { if (src[i] === '\\') i++; i++ } i++; push('str', s, i); continue }
    if (c === '`') {
      const s = i++, exprs = []
      while (i < end && src[i] !== '`') {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === '$' && src[i + 1] === '{') { const inner = lex(src, i + 2, end, true); exprs.push({ start: i + 2, end: inner.end, tokens: inner.tokens }); i = inner.end + 1; continue }
        i++
      }
      i++; push('tpl', s, i, { exprs }); continue
    }
    if (c === '/') {
      const p = tokens[tokens.length - 1]
      if (!p || (p.type === 'punct' && REGEX_AFTER_PUNCT.has(p.text)) || (p.type === 'ident' && REGEX_AFTER_WORD.has(p.text))) {
        const s = i++; let cls = false
        while (i < end && (src[i] !== '/' || cls) && src[i] !== '\n') { if (src[i] === '\\') i++; else if (src[i] === '[') cls = true; else if (src[i] === ']') cls = false; i++ }
        i++; while (/[a-z]/i.test(src[i] ?? '')) i++
        push('regex', s, i); continue
      }
    }
    if (/[A-Za-z_$\u00C0-\uFFFF]/.test(c)) { const s = i; while (i < end && /[\w$\u00C0-\uFFFF]/.test(src[i])) i++; push('ident', s, i); continue }
    if (/[0-9]/.test(c)) { const s = i; while (i < end && /[\w.]/.test(src[i])) i++; push('num', s, i); continue }
    if (interpolation) { if (c === '{') depth++; else if (c === '}') { if (depth === 0) return { tokens, end: i }; depth-- } }
    const three = src.slice(i, i + 3), two = src.slice(i, i + 2)
    if (PUNCT3.includes(three)) { push('punct', i, i + 3); i += 3; continue }
    if (PUNCT2.includes(two)) { push('punct', i, i + 2); i += 2; continue }
    push('punct', i, i + 1); i++
  }
  return { tokens, end: i }
}

function decode(body) {
  let out = ''
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') { out += body[i]; continue }
    const n = body[++i]
    if (n === 'n') out += '\n'
    else if (n === 't') out += '\t'
    else if (n === 'r') out += '\r'
    else if (n === 'u' && body[i + 1] === '{') { const close = body.indexOf('}', i); out += String.fromCodePoint(parseInt(body.slice(i + 2, close), 16)); i = close }
    else if (n === 'u') { out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16)); i += 4 }
    else if (n === 'x') { out += String.fromCharCode(parseInt(body.slice(i + 1, i + 3), 16)); i += 2 }
    else if (n === '\n') continue
    else out += n
  }
  return out
}
const literal = token => token && (token.type === 'str' || (token.type === 'tpl' && token.exprs.length === 0)) ? decode(token.text.slice(1, -1)) : undefined

// Cooked text of a template with a map back to raw offsets, so browser JS inside it can be lexed.
function cooked(src, token) {
  let text = ''
  let i = token.start + 1, e = 0
  while (i < token.end - 1) {
    const expr = token.exprs[e]
    if (expr && i === expr.start - 2) { text += '0'; i = expr.end + 1; e++; continue }
    if (src[i] === '\\') { const n = src[i + 1]; text += n === '`' || n === '$' || n === '\\' ? n : decode(src.slice(i, i + 2)) || ' '; i += 2; continue }
    text += src[i++]
  }
  return text
}

const { LOCALES } = await import('../packages/core/src/i18n/locales.ts')
const LOCALE_TAGS = new Set(LOCALES.map(info => info.tag))
const isMessageLike = value => /\p{L}/u.test(value) && !/^[a-z0-9]+(?:[-_.][a-z0-9]+)+$/.test(value) && !/^[[.#]|^data-/.test(value) && !LOCALE_TAGS.has(value)

/** Messages a source text passes to keyword calls, and every string literal it contains. */
export function scanSource(src) {
  const calls = [], literals = new Set()
  // A local helper is a translation keyword only where the file defines or receives it as a translator.
  const helpers = new Set(['xpT', 'msgid'])
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*(?:translator\(|xpT\b|\(\s*message\b|\(\s*copy\s*:|extensionText\b)|\b([A-Za-z_$][\w$]*)\s*:\s*(?:Translate|T)\b[),]|function\s+([A-Za-z_$][\w$]*)\s*\(\s*message\b/g)) {
    const name = m[1] ?? m[2] ?? m[3]
    if (HELPERS.has(name)) helpers.add(name)
  }
  const visit = (tokens, text) => {
    for (let k = 0; k < tokens.length; k++) {
      const t = tokens[k]
      const value = literal(t)
      if (value !== undefined) literals.add(value)
      if (t.type === 'tpl') {
        for (const expr of t.exprs) visit(expr.tokens, text)
        if (text === src && /=>|\bfunction\b|document\./.test(t.text)) { const js = cooked(src, t); visit(lex(js).tokens, js) }
      }
      if (t.text !== '(' ) continue
      const prev = tokens[k - 1], before = tokens[k - 2]
      const arg = literal(tokens[k + 1])
      if (arg === undefined || !prev) continue
      const isKeyword = prev.type === 'ident' && helpers.has(prev.text) && before?.text !== '.' && before?.text !== 'function'
      const isTranslatorCall = prev.text === ')' && /\btranslator\s*\([^()]*\)$/.test(text.slice(Math.max(0, prev.end - 80), prev.end))
      if (prev.type === 'ident' && prev.text === 'msgctxt' && tokens[k + 2]?.text === ',') {
        const message = literal(tokens[k + 3])
        if (message !== undefined) calls.push({ context: arg, id: message, line: text === src ? src.slice(0, t.start).split('\n').length : 0 })
        continue
      }
      // local helpers named t/text also take ids and selectors; those are not messages
      const message = prev.text === 'msgid' || prev.text === 'xpT' || isTranslatorCall || isMessageLike(arg)
      if ((isKeyword || isTranslatorCall) && message && (tokens[k + 2]?.text === ')' || tokens[k + 2]?.text === ',')) calls.push({ id: arg, line: text === src ? src.slice(0, t.start).split('\n').length : 0 })
    }
  }
  visit(lex(src).tokens, src)
  return { calls, literals }
}

export function sourceFiles(root = ROOT) {
  const files = []
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'locales' || name.startsWith('.')) continue
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.ts$/.test(name) && !/\.(test|spec)\.ts$|\.d\.ts$/.test(name)) files.push(path)
    }
  }
  for (const r of SOURCE_ROOTS) walk(join(root, r))
  return files
}

/** All keyword-call messages and literals of the product sources, with the files that use them. */
export function collectMessages(root = ROOT) {
  const used = new Map(), literals = new Set()
  for (const file of sourceFiles(root)) {
    const src = readFileSync(file, 'utf8')
    const rel = relative(root, file).split('\\').join('/')
    const scan = scanSource(src)
    scan.literals.forEach(value => literals.add(value))
    for (const call of scan.calls) {
      const key = call.context ? call.context + CONTEXT_SEPARATOR + call.id : call.id
      if (!used.has(key)) used.set(key, { id: call.id, context: call.context, files: new Set() })
      used.get(key).files.add(rel)
    }
  }
  return { used, literals }
}

// ---- CLI
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const { parsePo, formatPo, catalogKey } = await import('../packages/core/src/i18n/po.ts')
  const { LOCALES, SOURCE_LOCALE } = await import('../packages/core/src/i18n/locales.ts')
  const command = process.argv[2]
  const { used, literals } = collectMessages()
  const catalogs = LOCALES.filter(info => info.tag !== SOURCE_LOCALE).map(info => ({ tag: info.tag, path: join(WEB_CATALOG_DIR, `${info.tag}.po`) }))
  if (command === 'check') {
    let problems = 0
    for (const { tag, path } of catalogs) {
      const catalog = parsePo(readFileSync(path, 'utf8'))
      const keys = new Set(catalog.entries.map(e => catalogKey(e.id, e.context)))
      const missing = [...used].filter(([key, info]) => !keys.has(key) && /[A-Za-z]{2}/.test(info.id))
      const unused = catalog.entries.filter(e => !literals.has(e.id))
      for (const [key, info] of missing) console.log(`${tag} missing: ${JSON.stringify(key)} (${[...info.files].join(', ')})`)
      for (const e of unused) console.log(`${tag} unused: ${JSON.stringify(catalogKey(e.id, e.context))}`)
      problems += missing.length + unused.length
    }
    process.exitCode = problems ? 1 : 0
  } else if (command === 'refs') {
    for (const { path } of catalogs) {
      const catalog = parsePo(readFileSync(path, 'utf8'))
      const entries = catalog.entries.map(e => {
        const files = used.get(catalogKey(e.id, e.context))?.files
        const comments = (e.comments ?? []).filter(c => !c.startsWith('#:'))
        return { ...e, comments: files?.size ? [...comments, `#: ${[...files].sort().join(' ')}`] : comments }
      })
      writeFileSync(path, formatPo({ header: catalog.header, entries }))
    }
  } else if (command === 'pot') {
    const entries = [...used.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : (a.context ?? '') < (b.context ?? '') ? -1 : 1)
      .map(info => ({ ...(info.context ? { context: info.context } : {}), id: info.id, translation: '', comments: [`#: ${[...info.files].sort().join(' ')}`] }))
    writeFileSync(join(WEB_CATALOG_DIR, 'messages.pot'), formatPo({ header: { 'Project-Id-Version': 'xPanel', 'MIME-Version': '1.0', 'Content-Type': 'text/plain; charset=UTF-8', 'Content-Transfer-Encoding': '8bit', 'X-Message-Format': 'ICU MessageFormat' }, entries }))
  } else {
    console.error('usage: node scripts/i18n-catalog.mjs check|refs|pot')
    process.exitCode = 2
  }
}
