import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cookedJavaScriptTemplate, lexJavaScriptSource, sourceLiteral } from './i18n-catalog.mjs'
import { SELECTOR_SOURCE_REVIEWS } from '../apps/web/src/themes/selector-audit-data.ts'
import { AUTHORITATIVE_CONTROLLER_DECLARATIONS } from '../apps/web/src/themes/controller-hooks.ts'

export const SELECTOR_METHODS = Object.freeze(['querySelector', 'querySelectorAll', 'closest', 'matches', 'getElementById'])
const root = fileURLToPath(new URL('..', import.meta.url))
const normalized = source => source.replace(/\r\n/g, '\n')
export const selectorSourceDigest = source => createHash('sha256').update(normalized(source)).digest('hex')
const fail = (gate, path, line) => { throw new Error(`${gate}: ${path}${line === undefined ? '' : ':' + line}`) }

/** Lexical census only. Authored classifications provide the controller/flow meaning of each dynamic site. */
export function nonliteralSelectorSites(input) {
  const source = normalized(input), result = [], seen = new Set()
  const visit = (code, offset = 0) => {
    const tokens = lexJavaScriptSource(code).tokens
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]
      if (token.type === 'tpl') {
        if (SELECTOR_METHODS.some(method => token.text.includes(method))) {
          const cooked = cookedJavaScriptTemplate(code, token)
          if (SELECTOR_METHODS.some(method => cooked.includes(method)))
            visit(code.slice(token.start + 1, token.end - 1), offset + token.start + 1)
        }
        for (const expression of token.exprs ?? []) visit(code.slice(expression.start, expression.end), offset + expression.start)
      }
      if (token.type !== 'ident' || !SELECTOR_METHODS.includes(token.text) || !['.', '?.'].includes(tokens[index - 1]?.text)) continue
      let at = index + 1
      if (tokens[at]?.text === '?.') at++
      if (tokens[at]?.text === '<') {
        let depth = 0
        do {
          if (tokens[at].text === '<') depth++
          else if (tokens[at].text === '>') depth--
          at++
        } while (at < tokens.length && depth > 0)
        if (depth !== 0) fail('UNPARSED_SELECTOR_TYPE_ARGUMENTS', '<source>', source.slice(0, offset + token.start).split('\n').length)
      }
      if (tokens[at]?.text !== '(') continue
      const first = ++at
      let depth = 0
      for (; at < tokens.length; at++) {
        const value = tokens[at].text
        if (depth === 0 && (value === ')' || value === ',')) break
        if (['(', '[', '{'].includes(value)) depth++
        else if ([')', ']', '}'].includes(value)) depth--
      }
      const argument = tokens.slice(first, at)
      if (!argument.length || argument.length === 1 && sourceLiteral(argument[0]) !== undefined) continue
      if (at >= tokens.length) fail('UNPARSED_SELECTOR_ARGUMENT', '<source>', source.slice(0, offset + token.start).split('\n').length)
      const start = offset + argument[0].start, end = offset + argument.at(-1).end, key = token.text + ':' + start
      if (seen.has(key)) continue
      seen.add(key)
      result.push({
        line: source.slice(0, start).split('\n').length,
        column: start - source.lastIndexOf('\n', start - 1),
        method: token.text, argument: source.slice(start, end), offset: start,
      })
    }
  }
  visit(source)
  return result.sort((left, right) => left.offset - right.offset)
}

const siteKey = site => JSON.stringify([site.line, site.column, site.method, site.argument])
export function assertSelectorReview(path, source, review) {
  const actual = nonliteralSelectorSites(source)
  if (!review) {
    if (actual.length) fail('UNCLASSIFIED_SELECTOR_SOURCE', path, actual[0].line)
    return actual
  }
  if (review.path !== path || selectorSourceDigest(source) !== review.sha256) fail('SELECTOR_SOURCE_DRIFT', path)
  const expected = new Map()
  for (const site of review.sites) {
    const key = siteKey(site)
    if (expected.has(key) || typeof site.classification !== 'string' || !site.classification.trim()
      || !Array.isArray(site.controllers) || !site.controllers.length || site.controllers.some(id => typeof id !== 'string' || !id))
      fail('INVALID_SELECTOR_CLASSIFICATION', path, site.line)
    expected.set(key, site)
  }
  for (const site of actual) {
    if (!expected.delete(siteKey(site))) fail('UNCLASSIFIED_SELECTOR_SITE', path, site.line)
  }
  if (expected.size) fail('STALE_SELECTOR_CLASSIFICATION', path, expected.values().next().value.line)
  return actual
}

/** Each controller mapping must retain its independently authored required/optional scope declaration. */
export function assertControllerReviewMappings(reviews, declarations = AUTHORITATIVE_CONTROLLER_DECLARATIONS) {
  const ids = new Set()
  const visit = declaration => {
    if (ids.has(declaration.id)) fail('DUPLICATE_CONTROLLER_DECLARATION', declaration.id)
    ids.add(declaration.id)
    for (const child of [...declaration.variants ?? [], ...declaration.nestedScopes ?? []]) visit(child)
  }
  for (const declaration of declarations) visit(declaration)
  for (const review of reviews) for (const site of review.sites) for (const id of site.controllers) {
    // Ancestor eligibility is a source guard policy, not a mounted controller/control requirement.
    if (id === 'ancestor-eligibility-policy' && ['literal-ineligibility-ancestor-policy', 'finite-owning-form-policy'].includes(site.classification)) continue
    if (!ids.has(id)) fail('MISSING_CONTROLLER_DECLARATION', `${review.path}:${site.line}: ${id}`)
  }
}

/** Core controllers live outside theme packages. Theme motion/assets have their own package tests. */
export function assertControllerSourceAudit(sourceRoot = root, reviews = SELECTOR_SOURCE_REVIEWS) {
  assertControllerReviewMappings(reviews)
  const directory = join(sourceRoot, 'apps/web/src')
  const walk = folder => readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory()) return entry.name === 'themes' ? [] : walk(join(folder, entry.name))
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')
      ? [join(folder, entry.name)] : []
  })
  const byPath = new Map(reviews.map(review => [review.path, review]))
  if (byPath.size !== reviews.length) fail('DUPLICATE_SELECTOR_SOURCE', '<inventory>')
  const counts = Object.fromEntries(SELECTOR_METHODS.map(method => [method, 0]))
  let files = 0, sites = 0
  for (const fullPath of walk(directory)) {
    const path = relative(sourceRoot, fullPath).split(sep).join('/')
    const source = readFileSync(fullPath, 'utf8')
    if (!byPath.has(path) && !SELECTOR_METHODS.some(method => source.includes(method))) continue
    const actual = assertSelectorReview(path, source, byPath.get(path))
    byPath.delete(path)
    if (actual.length) files++
    for (const site of actual) { counts[site.method]++; sites++ }
  }
  if (byPath.size) fail('MISSING_SELECTOR_SOURCE', byPath.keys().next().value)
  return { files, sites, methodCounts: counts, sourceNormalization: 'utf8-lf' }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(assertControllerSourceAudit())) }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
