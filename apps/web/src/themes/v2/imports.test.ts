import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// A theme imports only core and packages/*: never classic files, another theme, or anything else.
const THEME = dirname(fileURLToPath(import.meta.url))
const WEB_SRC = resolve(THEME, '../..')
const CORE_MODULES = new Set([
  'html.ts', 'i18n.ts', 'theme-messages.ts', 'branding.ts', 'display-format.ts', 'audit-labels.ts',
  'models/account-list.ts', 'models/whm-account-access.ts', 'models/website-analytics.ts', 'models/mail.ts',
  'models/action-state.ts', 'models/status-page.ts', 'models/reseller-allocation.ts', 'models/theme-surface.ts', 'display-name.ts',
])
const TYPE_ONLY_CORE_MODULES = new Set(['themes/contract.ts'])
const TEST_CORE_MODULES = new Set(['themes/markup.ts'])
const PACKAGES = /^@xpanel\/(?:catalog|core)$/
const TEST_ONLY = /^(?:vitest|node:(?:fs|path|url|zlib|crypto))$/
const RUNTIME_BUILTINS = new Set(['node:crypto'])

const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : [])

const specifiers = (source: string): { specifier: string; typeOnly: boolean }[] =>
  [...source.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm)]
    .map(match => ({ specifier: match[1] ?? match[2] ?? match[3]!, typeOnly: /^\s*(?:import|export)\s+type\b/.test(match[0]) }))

function violation(file: string, specifier: string, typeOnly = false): string | undefined {
  const test = file.endsWith('.test.ts')
  if (specifier.startsWith('.')) {
    const target = resolve(dirname(file), specifier)
    if (target.startsWith(THEME + sep)) return undefined
    const fromWeb = relative(WEB_SRC, target)
    const module = fromWeb.split(sep).join('/')
    return CORE_MODULES.has(module) || (typeOnly && TYPE_ONLY_CORE_MODULES.has(module)) || (test && TEST_CORE_MODULES.has(module)) ? undefined : `imports ${fromWeb} outside the theme and core`
  }
  if (PACKAGES.test(specifier) || RUNTIME_BUILTINS.has(specifier) || (test && TEST_ONLY.test(specifier))) return undefined
  return `imports ${specifier}`
}

describe('v2 theme import boundary', () => {
  it('imports only its own modules, core modules and packages/*', () => {
    const problems = files(THEME).flatMap(file => specifiers(readFileSync(file, 'utf8')).map(({ specifier, typeOnly }) => {
      const problem = violation(file, specifier, typeOnly)
      return problem ? `${relative(THEME, file)} ${problem}` : undefined
    }).filter(Boolean))
    expect(problems).toEqual([])
  })

  it('flags classic files, other themes and unlisted modules', () => {
    const file = join(THEME, 'components', 'card.ts')
    for (const specifier of ['../../../tokens.ts', '../../../chrome.ts', '../../../shell.ts', '../../../surfaces/xwhm.ts', '../../../board-port/x.ts', '../../classic/index.ts', 'some-package']) {
      expect(violation(file, specifier), specifier).toBeDefined()
    }
    expect(violation(file, '../../../i18n.ts')).toBeUndefined()
    expect(violation(file, '../../../theme-messages.ts')).toBeUndefined()
    expect(violation(file, '../../../branding.ts')).toBeUndefined()
    expect(violation(file, '../../contract.ts', true)).toBeUndefined()
    expect(violation(file, '../../contract.ts')).toBeDefined()
    expect(violation(file, '../../../models/mail.ts')).toBeUndefined()
    expect(violation(file, '../../markup.ts')).toBeDefined()
    expect(violation(join(THEME, 'html.test.ts'), '../markup.ts')).toBeUndefined()
    expect(violation(file, '../html.ts')).toBeUndefined()
    expect(violation(join(THEME, 'html.test.ts'), 'vitest')).toBeUndefined()
    expect(violation(join(THEME, 'html.ts'), 'vitest')).toBeDefined()
  })
})
