// .htaccess editing: keep the previous version, roll back when the site answers 500, and move
// php_value/php_flag (ignored by FPM and CGI, fatal outside mod_php) into .user.ini.
import { FORBIDDEN_PHP_DIRECTIVES, isXpanelError, phpIniScope, sanitizePhpIni } from '@xpanel/core'
import { invalid } from './validate.ts'

export const HTACCESS = '.htaccess'
export const MAX_HTACCESS_BYTES = 1024 * 1024

const assertHtaccess = (what: string, v: unknown): string => {
  if (typeof v !== 'string') return invalid(what, v, 'must be a string')
  if (Buffer.byteLength(v, 'utf8') > MAX_HTACCESS_BYTES) return invalid(what, v.slice(0, 64), 'is larger than 1 MiB')
  if (v.includes('\u0000')) return invalid(what, v.slice(0, 64), 'contains NUL bytes')
  return v
}

const stamp = (at: Date | string): string => {
  const d = typeof at === 'string' ? new Date(at) : at
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return invalid('timestamp', at, 'is not a date')
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

/** `.htaccess.xpanel-<UTC stamp>.bak`; the `.ht` prefix keeps it covered by Apache's deny rule. */
export const htaccessBackupName = (at: Date | string): string => `${HTACCESS}.xpanel-${stamp(at)}.bak`

export interface HtaccessSavePlan {
  changed: boolean
  /** null when there was no previous file or nothing changed */
  backup: { name: string; content: string } | null
  write: { name: typeof HTACCESS; content: string }
  /** content to restore on rollback; null means delete the new file */
  previous: string | null
  warnings: string[]
}

const PHP_LINE = /^\s*php_(?:admin_)?(?:value|flag)\s/im
const HANDLER_LINE = /^\s*(?:AddHandler|AddType|SetHandler|ForceType)\s+(?:application\/x-httpd-(?:ea-)?php|x-httpd-php|php\d*-script)/im
const SUPHP_LINE = /^\s*suPHP_\w+/im

export const planHtaccessSave = (currentContent: string | null, newContent: string, at: Date | string = new Date()): HtaccessSavePlan => {
  const next = assertHtaccess('.htaccess', newContent)
  const current = currentContent === null ? null : assertHtaccess('current .htaccess', currentContent)
  const backupName = htaccessBackupName(at)
  const warnings: string[] = []
  if (PHP_LINE.test(next)) warnings.push('php_value/php_flag are not honoured by PHP-FPM or CGI; move them to .user.ini')
  if (HANDLER_LINE.test(next)) warnings.push('PHP handler mappings in .htaccess override xPanel; pick the PHP version in xPanel instead')
  if (SUPHP_LINE.test(next)) warnings.push('suPHP_* directives fail with HTTP 500: mod_suphp is not loaded')
  const changed = current !== next
  return {
    changed,
    backup: changed && current !== null ? { name: backupName, content: current } : null,
    write: { name: HTACCESS, content: next },
    previous: current,
    warnings,
  }
}

export type HealthProbe = number | { status: number | null } | null

export interface RollbackDecision {
  restore: boolean
  reason: string
}

const statusOf = (p: HealthProbe | undefined): number | null =>
  p === null || p === undefined ? null : typeof p === 'number' ? p : p.status

/**
 * Apache answers 500 when .htaccess does not parse. Restore when the probe after saving is
 * 500, unless the site was already answering 500 before the change (then the file is not
 * the cause and restoring would discard the fix being attempted).
 */
export const decideHtaccessRollback = (healthStatus: HealthProbe, baselineStatus?: HealthProbe): RollbackDecision => {
  const status = statusOf(healthStatus)
  const baseline = statusOf(baselineStatus)
  if (status === null) return { restore: false, reason: 'probe did not answer; nothing to attribute to .htaccess' }
  if (!Number.isInteger(status) || status < 100 || status > 599) return invalid('health status', status, 'is not an HTTP status')
  if (status !== 500) return { restore: false, reason: `site answers ${status}` }
  if (baseline === 500) return { restore: false, reason: 'site already answered 500 before the change' }
  return { restore: true, reason: 'site answers 500 after the .htaccess change' }
}

export type HtaccessRestore = { kind: 'write'; name: typeof HTACCESS; content: string } | { kind: 'delete'; name: typeof HTACCESS }

export const htaccessRollbackAction = (plan: HtaccessSavePlan): HtaccessRestore =>
  plan.previous === null ? { kind: 'delete', name: HTACCESS } : { kind: 'write', name: HTACCESS, content: plan.previous }

// ---- php directives -----------------------------------------------------------------------

export interface DroppedLine {
  /** 1-based physical line where the directive starts */
  line: number
  text: string
  reason: string
}

export interface PhpDirectiveTranslation {
  cleanedHtaccess: string
  /** settings for .user.ini; the last occurrence of a key wins, as in Apache */
  userIni: Record<string, string>
  moved: string[]
  dropped: DroppedLine[]
}

const DIRECTIVE = /^\s*(php_value|php_flag|php_admin_value|php_admin_flag)\s+(\S+)(?:\s+(.*?))?\s*$/i

const unquote = (v: string): string => {
  const m = /^"(.*)"$/.exec(v) ?? /^'(.*)'$/.exec(v)
  return m ? (m[1] ?? '') : v
}

const FLAG_ON = new Set(['on', '1', 'true', 'yes'])
const FLAG_OFF = new Set(['off', '0', 'false', 'no'])

/**
 * Only keys the panel itself lets an account set per directory (core's php.ini allowlist,
 * PHP_INI_PERDIR scope) move to .user.ini, with the value canonicalized by the same rule.
 */
const translateValue = (directive: string, key: string, raw: string): { value: string } | { reason: string } => {
  if (FORBIDDEN_PHP_DIRECTIVES.has(key) || key.startsWith('cgi.') || key.startsWith('fastcgi.')) {
    return { reason: `${key} is managed by the server and cannot be set per site` }
  }
  const scope = phpIniScope(key)
  if (scope === null) return { reason: `${key} is not a setting an account may change` }
  if (scope === 'pool') return { reason: `${key} is read only at PHP startup; set it in the PHP settings of the domain` }
  let v = unquote(raw.trim())
  if (directive === 'php_flag') {
    const f = v.toLowerCase()
    if (FLAG_ON.has(f)) v = 'On'
    else if (FLAG_OFF.has(f)) v = 'Off'
    else return { reason: `php_flag ${key} needs on/off` }
  }
  try {
    const clean = sanitizePhpIni({ [key]: v })[key]
    return clean === undefined ? { reason: `${key} has no value` } : { value: clean }
  } catch (e) {
    if (!isXpanelError(e)) throw e
    return { reason: e.message }
  }
}

interface Logical {
  start: number
  end: number
  text: string
}

/** Physical lines joined across trailing-backslash continuations, as Apache reads them. */
const logicalLines = (lines: string[]): Logical[] => {
  const out: Logical[] = []
  for (let i = 0; i < lines.length; i++) {
    const start = i
    let text = lines[i] ?? ''
    while (text.endsWith('\\') && i + 1 < lines.length) {
      i++
      text = `${text.slice(0, -1)}${lines[i] ?? ''}`
    }
    out.push({ start, end: i, text })
  }
  return out
}

const OPEN = /^\s*<(IfModule|FilesMatch|Files)\b[^>]*>\s*$/i
const CLOSE = /^\s*<\/(IfModule|FilesMatch|Files)\s*>\s*$/i

/** Removes container sections left with only blank lines inside, repeatedly. */
const collapseEmpty = (lines: (string | null)[]): (string | null)[] => {
  let changed = true
  while (changed) {
    changed = false
    const idx = lines.map((l, i) => (l === null ? -1 : i)).filter((i) => i >= 0)
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k] ?? -1
      const open = OPEN.exec(lines[i] ?? '')
      if (!open) continue
      let j = k + 1
      while (j < idx.length && (lines[idx[j] ?? -1] ?? '').trim() === '') j++
      const close = j < idx.length ? CLOSE.exec(lines[idx[j] ?? -1] ?? '') : null
      if (close && close[1]?.toLowerCase() === open[1]?.toLowerCase()) {
        for (let m = k; m <= j; m++) lines[idx[m] ?? -1] = null
        changed = true
        break
      }
    }
  }
  return lines
}

export const translatePhpDirectives = (htaccess: string): PhpDirectiveTranslation => {
  const src = assertHtaccess('.htaccess', htaccess)
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  const physical = src.split(/\r?\n/)
  const kept: (string | null)[] = [...physical]
  const userIni: Record<string, string> = {}
  const moved: string[] = []
  const dropped: DroppedLine[] = []
  const drop = (l: Logical, reason: string): void => {
    for (let i = l.start; i <= l.end; i++) kept[i] = null
    dropped.push({ line: l.start + 1, text: l.text.trim(), reason })
  }

  for (const l of logicalLines(physical)) {
    const m = DIRECTIVE.exec(l.text)
    if (m) {
      const directive = (m[1] ?? '').toLowerCase()
      const key = m[2] ?? ''
      if (directive.startsWith('php_admin')) {
        drop(l, 'php_admin_* is not allowed in .htaccess')
        continue
      }
      const t = translateValue(directive, key, m[3] ?? '')
      if ('reason' in t) {
        drop(l, t.reason)
        continue
      }
      for (let i = l.start; i <= l.end; i++) kept[i] = null
      delete userIni[key]
      userIni[key] = t.value
      if (!moved.includes(key)) moved.push(key)
      continue
    }
    if (HANDLER_LINE.test(l.text)) drop(l, 'PHP handler mapping; the PHP version is chosen in xPanel')
    else if (SUPHP_LINE.test(l.text)) drop(l, 'mod_suphp is not loaded; suPHP rules are enforced by xPanel')
  }

  const cleanedHtaccess = collapseEmpty(kept)
    .filter((l): l is string => l !== null)
    .join(eol)
  return { cleanedHtaccess, userIni, moved, dropped }
}
