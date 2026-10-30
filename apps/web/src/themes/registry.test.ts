import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { lexJavaScriptSource, sourceLiteral } from '../../../../scripts/i18n-catalog.mjs'
import { findUiThemeAsset, registeredUiThemeIds, resolveUiTheme } from './registry.ts'
import { escapeHtml } from '../html.ts'
import { escapeHtml as legacyEscapeHtml } from '../tokens.ts'

const unknownPreference = (() => {
  let value = 'unregistered-test-theme'
  while ((registeredUiThemeIds() as readonly string[]).includes(value)) value += '-x'
  return value
})()

it.each([undefined, null, '', unknownPreference, '../v2', '__proto__', 'constructor', { id: 'classic' }])('falls back for an unregistered preference %j', preference => {
  expect(resolveUiTheme(preference).id).toBe('classic')
})

it('exposes unique immutable registered packages with classic as the default', () => {
  const ids = registeredUiThemeIds()
  expect(ids).toContain('classic')
  expect(new Set(ids).size).toBe(ids.length)
  for (const id of ids) {
    expect(resolveUiTheme(id).id).toBe(id)
    expect(Object.isFrozen(resolveUiTheme(id))).toBe(true)
    expect(Object.isFrozen(resolveUiTheme(id).assets)).toBe(true)
  }
})

it('keeps core runtime paths and traversal outside the theme asset registry', () => {
  for (const path of ['/assets/ws-client.js', '/assets/login.js', '/assets/i18n-en.js', '/assets/../tokens.css', '/assets/themes/classic/../../tokens.css'])
    expect(findUiThemeAsset(path)).toBeUndefined()
  expect(findUiThemeAsset('/assets/tokens.css')).toMatchObject({ path: '/assets/tokens.css', contentType: 'text/css; charset=utf-8' })
})

it('keeps the legacy escaping export identical to the core helper', () => {
  expect(legacyEscapeHtml).toBe(escapeHtml)
  expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;')
  expect(escapeHtml('')).toBe('')
  expect(escapeHtml('العربية 123 日本語')).toBe('العربية 123 日本語')
})

const sourceRoot = resolve(import.meta.dirname, '..')
const portablePath = (path: string): string => path.replaceAll('\\', '/')
const themeOwner = (path: string): string | undefined => /^themes\/([a-z][a-z0-9-]*)(?:\/|$)/.exec(path)?.[1]

function moduleReferences(source: string): (string | undefined)[] {
  const result: (string | undefined)[] = []
  const visit = (tokens: ReturnType<typeof lexJavaScriptSource>['tokens']): void => {
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    for (const expression of token.exprs ?? []) visit(expression.tokens)
    if (token.type !== 'ident' || (token.text !== 'import' && token.text !== 'export')) continue
    if (tokens[index - 1]?.text === '.' || tokens[index - 1]?.text === '?.') continue
    if (tokens[index + 1]?.text === '.') continue
    if (token.text === 'import' && tokens[index + 1]?.text === '(') {
      const end = tokens[index + 3]?.text
      result.push(end === ')' || end === ',' ? sourceLiteral(tokens[index + 2]) : undefined)
      continue
    }
    const sideEffect = token.text === 'import' ? sourceLiteral(tokens[index + 1]) : undefined
    if (sideEffect !== undefined) { result.push(sideEffect); continue }
    for (let at = index + 1; at < tokens.length; at++) {
      const next = tokens[at]!
      if (next.text === ';' || (at > index + 1 && next.type === 'ident' && (next.text === 'import' || next.text === 'export'))) break
      if (next.type === 'ident' && next.text === 'from') {
        const module = sourceLiteral(tokens[at + 1])
        if (module !== undefined) { result.push(module); break }
      }
    }
  }
  }
  visit(lexJavaScriptSource(source).tokens)
  return result
}

function boundaryIssues(file: string, source: string): string[] {
  const owner = themeOwner(file)
  return moduleReferences(source).flatMap(module => {
    if (module === undefined) return ['Unresolved dynamic module reference']
    if (!module.startsWith('.')) return /(?:^|\/)themes\//.test(portablePath(module)) ? [`Nonrelative theme dependency: ${module}`] : []
    const target = portablePath(relative(sourceRoot, resolve(sourceRoot, dirname(file), module)))
    const targetOwner = themeOwner(target)
    if (owner && targetOwner && owner !== targetOwner) return [`Cross-theme dependency: ${module}`]
    if (owner && target === 'themes/registry.ts') return [`Theme depends on its registry: ${module}`]
    if (!owner && targetOwner && file !== 'themes/registry.ts') return [`Core imports a theme implementation: ${module}`]
    if (target === 'themes/registry.ts' && file !== 'app.ts') return [`Registry imported outside the application seam: ${module}`]
    return []
  })
}

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? walk(join(dir, entry.name)) : entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [join(dir, entry.name)] : [])

it.each(walk(sourceRoot).map(file => portablePath(relative(sourceRoot, file))))('keeps module dependencies at the theme boundary: %s', file => {
  expect(boundaryIssues(file, readFileSync(resolve(sourceRoot, file), 'utf8'))).toEqual([])
})

it.each([
  ['themes/classic/index.ts', "import { value } from '../v2/index.ts'"],
  ['themes/v2/index.ts', "export * from '../classic/index.ts'"],
  ['themes/classic/index.ts', "export { value } from '../v2/index.ts'"],
  ['themes/v2/index.ts', "export type { Value } from '../future/index.ts'"],
  ['themes/v2/index.ts', "export { value as from } from '../classic/index.ts'"],
  ['themes/v2/index.ts', "import { from as value } from '../classic/index.ts'"],
  ['themes/v2/index.ts', "import '../classic'"],
  ['app.ts', "export * from './themes/classic'"],
  ['themes/v2/index.ts', "type Value = typeof import('../classic/index.ts')"],
  ['surface.ts', "export * from './themes/classic/index.ts'"],
  ['other.ts', "import { resolveUiTheme } from './themes/registry.ts'"],
  ['themes/classic/index.ts', "import { resolveUiTheme } from '../registry.ts'"],
  ['app.ts', "import('./themes/' + preference)"],
  ['app.ts', "const body = `${import('./themes/v2/index.ts')}`"],
  ['app.ts', "export * from '@xpanel/web/themes/v2/index.ts'"],
])('rejects forbidden or unresolved module dependencies in %s: %s', (file, source) => {
  expect(boundaryIssues(file!, source!)).not.toEqual([])
})

it('accepts the sole registry seam and ignores import text inside comments and strings', () => {
  expect(boundaryIssues('app.ts', "import { resolveUiTheme } from './themes/registry.ts'")).toEqual([])
  expect(boundaryIssues('themes/registry.ts', "export { classicTheme } from './classic/index.ts'")).toEqual([])
  expect(boundaryIssues('themes/classic/index.ts', "import { escapeHtml } from '../../html.ts'")).toEqual([])
  expect(boundaryIssues('app.ts', "const text = \"export * from './themes/classic/index.ts'\"; // import('../themes/v2/index.ts')")).toEqual([])
})
