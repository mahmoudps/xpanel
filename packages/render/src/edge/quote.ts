// Quoting for each target syntax. Inputs are validated first; quoting is the second wall.
import { hasControl, invalid } from './validate.ts'

const noControl = (what: string, s: string): string =>
  hasControl(s) ? invalid(what, s, 'contains control characters or newlines') : s

/** nginx double-quoted string: the parser unescapes `\\` and `\"`. `$` is refused (variables). */
export const nginxQuote = (s: string, what = 'nginx value'): string => {
  noControl(what, s)
  if (s.includes('$')) invalid(what, s, 'must not contain "$" (nginx variable interpolation)')
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** nginx regex inside quotes: `$` stays (end anchor), backslashes are doubled for the parser. */
export const nginxRegexQuote = (s: string, what = 'nginx pattern'): string => {
  noControl(what, s)
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Apache double-quoted argument. `$`, `"`, `\` are refused: Apache expands ${VAR} at parse time. */
export const apacheQuote = (s: string, what = 'Apache value'): string => {
  noControl(what, s)
  if (/["\\$]/.test(s)) invalid(what, s, 'must not contain quotes, backslashes or "$"')
  return `"${s}"`
}

/** POSIX shell single-quoted word. */
export const shQuote = (s: string, what = 'shell word'): string => {
  noControl(what, s)
  return `'${s.replace(/'/g, `'\\''`)}'`
}

const INI_BARE = /^[A-Za-z0-9_.:\/@+%*,-]+$/
const INI_EXPR = /^[A-Z0-9_ ~&|^!()]+$/
const INI_QUOTABLE = /^[\x20-\x7e]*$/

/**
 * PHP INI value as php-fpm, .user.ini and php.ini parse it (INI_SCANNER_NORMAL).
 * Bare when it is a plain token or a constant expression (E_ALL & ~E_NOTICE), quoted otherwise.
 * `"`, `\`, `$` and newlines are refused: they escape or expand inside INI strings.
 */
export const iniValue = (v: string, what = 'INI value'): string => {
  if (typeof v !== 'string') return invalid(what, v, 'must be a string')
  if (v.length > 4096) return invalid(what, v, 'is too long')
  if (INI_BARE.test(v)) return v
  if (INI_EXPR.test(v) && /[~&|^!]/.test(v)) return v
  if (!INI_QUOTABLE.test(v) || /["\\$]/.test(v)) {
    return invalid(what, v, 'must not contain quotes, backslashes, "$" or control characters')
  }
  return `"${v}"`
}

/** OpenLiteSpeed config value: single line, no braces (block delimiters). */
export const olsValue = (s: string, what = 'OpenLiteSpeed value'): string => {
  noControl(what, s)
  if (/[{}]/.test(s)) invalid(what, s, 'must not contain braces')
  return s
}
