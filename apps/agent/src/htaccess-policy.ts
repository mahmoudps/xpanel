import { fail } from '@xpanel/core'
import { edge } from '@xpanel/render'

export const HTACCESS_MAX_BYTES = 64 * 1024
export interface HtaccessIssue { line: number; code: string; message: string; key?: string; value?: string }
export interface HtaccessPolicy { valid: boolean; issues: HtaccessIssue[]; phpLines: HtaccessIssue[]; lines: number }
export interface HtaccessPhpPlan { content: string; settings: Record<string, string>; lines: number[] }
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/
const DIRECTIVES = new Set(['rewriteengine', 'rewritebase', 'rewritecond', 'rewriterule', 'redirect', 'redirectmatch', 'errordocument', 'directoryindex', 'options', 'header', 'requestheader', 'expiresactive', 'expiresdefault', 'expiresbytype', 'addtype', 'addcharset', 'adddefaultcharset', 'addoutputfilterbytype', 'require', 'order', 'allow', 'deny', 'defaulttype', 'fileetag'])
const SECTIONS = new Set(['ifmodule', 'files', 'filesmatch'])

/** Parse words without evaluating Apache configuration variables or expressions. */
function words(line: string): string[] {
  const result: string[] = []
  let word = '', quote = '', started = false
  for (let index = 0; index < line.length; index++) {
    const character = line[index]!
    if (quote) {
      if (character === '\\' && (line[index + 1] === quote || line[index + 1] === '\\')) word += line[++index]
      else if (character === quote) quote = ''
      else word += character
    } else if (character === '"' || character === "'") { quote = character; started = true }
    else if (character === ' ' || character === '\t') { if (started) result.push(word); word = ''; started = false }
    else { word += character; started = true }
  }
  if (quote) throw new Error('unterminated_quote')
  if (started) result.push(word)
  return result
}

/** A deliberately bounded per-directory policy, followed by an actual Apache parser test. */
export function inspectHtaccess(content: unknown): HtaccessPolicy {
  if (typeof content !== 'string' || !content.isWellFormed()) return fail('VALIDATION', '.htaccess content must be well-formed Unicode text', { stateChanged: false })
  if (Buffer.byteLength(content, 'utf8') > HTACCESS_MAX_BYTES) return fail('LIMIT_EXCEEDED', '.htaccess content exceeds 64 KiB', { stateChanged: false })
  const physical = content.split(/\r\n|\n|\r/), issues: HtaccessIssue[] = [], phpLines: HtaccessIssue[] = [], stack: string[] = []
  if (physical.length > 4096) return fail('LIMIT_EXCEEDED', '.htaccess content exceeds 4096 lines', { stateChanged: false })
  const issue = (line: number, code: string, message: string): void => { issues.push({ line, code, message }) }
  if (CONTROL.test(content)) issue(1, 'unsafe_text', 'Control and bidirectional override characters are not allowed.')
  let logical = '', start = 1
  for (let index = 0; index < physical.length; index++) {
    const raw = physical[index]!
    if (!logical) start = index + 1
    logical += raw.endsWith('\\') ? raw.slice(0, -1) : raw
    if (raw.endsWith('\\')) continue
    const line = logical.trim(); logical = ''
    if (!line || line.startsWith('#')) continue
    let tokens: string[]
    try { tokens = words(line) } catch { issue(start, 'quote', 'An Apache argument has an unterminated quote.'); continue }
    const name = tokens[0]?.toLowerCase() ?? ''
    if (name === 'php_value' || name === 'php_flag') {
      const key = tokens[1], value = tokens.slice(2).join(' ')
      const entry = { line: start, code: 'php_setting', message: 'PHP-FPM settings belong in domain PHP configuration, not .htaccess.', ...(key ? { key } : {}), ...(value ? { value } : {}) }
      phpLines.push(entry); issues.push(entry); continue
    }
    if (line.includes('${')) { issue(start, 'config_variable', 'Apache configuration-variable substitution is not permitted in account files.'); continue }
    const section = /^<(\/?)([a-z][a-z0-9]*)(?:\s|>)/i.exec(line)
    if (section) {
      const kind = section[2]!.toLowerCase()
      if (!line.endsWith('>') || !SECTIONS.has(kind)) { issue(start, 'section', 'This Apache section is not permitted in a per-directory account file.'); continue }
      if (section[1]) { if (line.toLowerCase() !== '</' + kind + '>' || stack.pop() !== kind) issue(start, 'section_balance', 'Apache sections must be correctly nested.'); continue }
      if (stack.length >= 8) { issue(start, 'section_depth', 'Apache sections may be nested at most 8 levels.'); continue }
      const argumentsText = line.slice(section[0].length - 1, -1).trim()
      if (!argumentsText || kind !== 'ifmodule' && /[/\u0000-\u001f]/.test(argumentsText)) issue(start, 'section_target', 'File sections must match file names within this directory.')
      if (kind === 'ifmodule' && !/^!?[A-Za-z0-9_.-]+$/.test(argumentsText)) issue(start, 'module', 'IfModule requires a literal module name.')
      stack.push(kind); continue
    }
    if (!DIRECTIVES.has(name)) { issue(start, 'directive', 'The directive is not permitted by the account .htaccess policy.'); continue }
    if (tokens.length < 2) issue(start, 'arguments', 'The directive requires arguments.')
    if (name === 'options' && tokens.slice(1).some(value => !/^(?:None|[+-]?Indexes)$/i.test(value))) issue(start, 'options', 'Only directory-index visibility may be changed here.')
    if (name === 'require' && !(tokens.length === 3 && tokens[1]?.toLowerCase() === 'all' && ['granted', 'denied'].includes(tokens[2]!.toLowerCase()))) issue(start, 'require', 'Only literal Require all granted/denied rules are supported here.')
    if (name === 'rewritecond' && tokens[1]?.toLowerCase() === 'expr') issue(start, 'rewrite_expression', 'Configuration expressions are not permitted in account rewrite conditions.')
    if (name === 'rewriterule') {
      const flags = tokens[3]?.replace(/^\[|\]$/g, '').split(',') ?? []
      if (tokens.length < 3 || tokens.length > 4 || flags.some(flag => !/^(?:L|END|NC|NE|QSA|QSD|F|G|R(?:=[12345][0-9]{2})?)$/i.test(flag.trim()))) issue(start, 'rewrite_flags', 'Proxy, handler, environment and loop rewrite flags are not permitted here.')
      const target = tokens[2] ?? ''
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) && (!/^https?:\/\//i.test(target) || !flags.some(flag => /^R(?:=|$)/i.test(flag)))) issue(start, 'rewrite_target', 'Absolute rewrite targets require an explicit HTTP redirect flag.')
    }
    const headerOperation = /^(?:always|onsuccess)$/i.test(tokens[1] ?? '') ? tokens[2] : tokens[1]
    if ((name === 'header' || name === 'requestheader') && (tokens.some(value => /^expr=/i.test(value) || value.includes('%{')) || !/^(?:set|unset|append|merge|add|edit|edit\*)$/i.test(headerOperation ?? ''))) issue(start, 'header_expression', 'Only literal header operations are supported here.')
    if (name === 'addtype' && /(?:x-httpd|cgi|php|perl|python|ruby)/i.test(tokens[1] ?? '')) issue(start, 'mime_handler', 'Executable content handlers cannot be configured in this editor.')
    if (name === 'addoutputfilterbytype' && !/^(?:DEFLATE|BROTLI_COMPRESS)$/i.test(tokens[1] ?? '')) issue(start, 'output_filter', 'Only the standard compression filters are supported here.')
  }
  if (logical) issue(start, 'continuation', 'The file ends with an unfinished continuation.')
  if (stack.length) issue(physical.length, 'section_balance', 'An Apache section is not closed.')
  return { valid: issues.length === 0, issues, phpLines, lines: physical.length }
}

/** A plan only: the existing domain PHP writer must validate/apply its own revision guard. */
export function planHtaccessPhpMigration(content: string): HtaccessPhpPlan {
  inspectHtaccess(content)
  const physical = content.split(/\r\n|\n|\r/), settings: Record<string, string> = {}, lines: number[] = []
  let sectionDepth = 0
  for (let index = 0; index < physical.length; index++) {
    const line = physical[index]!.trim()
    if (line.endsWith('\\')) return fail('VALIDATION', 'continued .htaccess content needs manual review before PHP migration', { stateChanged: false })
    if (/^<\/[A-Za-z]/.test(line)) sectionDepth--
    else if (/^<[A-Za-z]/.test(line)) sectionDepth++
    if (!/^php_(?:value|flag)\b/i.test(line)) continue
    if (sectionDepth !== 0) return fail('VALIDATION', 'scoped PHP settings cannot be widened to the whole domain', { stateChanged: false })
    let tokens: string[]
    try { tokens = words(line) } catch { return fail('VALIDATION', 'PHP setting has invalid quotes', { stateChanged: false }) }
    const key = tokens[1], value = tokens[2]
    if (tokens.length !== 3 || !key || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key) || value === undefined || Object.hasOwn(settings, key)) return fail('VALIDATION', 'PHP migration needs unique literal settings', { stateChanged: false })
    // Reuse the panel's shared PHP allowlist/scope/value canonicalization. Its
    // full-file whitespace normalization is deliberately not used for the file.
    const translated = edge.translatePhpDirectives(line + '\n')
    if (translated.dropped.length || Object.keys(translated.userIni).length !== 1 || !Object.hasOwn(translated.userIni, key)) return fail('VALIDATION', 'the PHP setting is not permitted in per-domain configuration', { stateChanged: false })
    settings[key] = translated.userIni[key]!; lines.push(index + 1)
  }
  if (!lines.length) return fail('VALIDATION', 'there are no PHP settings to migrate', { stateChanged: false })
  const records = [...content.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g)].filter(match => match[0] !== '')
  const updated = records.filter((_line, index) => !lines.includes(index + 1)).map(match => match[0]).join('')
  const policy = inspectHtaccess(updated)
  if (!policy.valid) return fail('VALIDATION', 'remaining .htaccess directives require review', { stateChanged: false })
  return { content: updated, settings, lines }
}
