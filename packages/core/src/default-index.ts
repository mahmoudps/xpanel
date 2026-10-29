import { fail } from './errors.ts'

export const DEFAULT_INDEX_FILES = ['index.php', 'index.html', 'index.htm'] as const

/** File basenames only: no paths, URLs, expansions, directives or ambiguous encoding. */
export function validateDomainIndexFiles(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 16 || raw.some(name => typeof name !== 'string'
    || name.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..') || name.toLowerCase() === 'disabled')
    || new Set(raw).size !== raw.length) return fail('VALIDATION', 'index files must be 1 through 16 unique safe basenames, each at most 64 ASCII characters', { stateChanged: false })
  return [...raw] as string[]
}
