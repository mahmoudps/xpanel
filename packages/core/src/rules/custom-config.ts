import { posix } from 'node:path'
import { fail } from '../errors.ts'
import type { Account, DomainCustomConfig, Id, Plan } from '../types.ts'
import { phpIniScope, sanitizePhpIni } from './php.ts'

export const MAX_CUSTOM_INCLUDE_CHARS = 64 * 1024
export const MAX_CUSTOM_HEADERS = 32
export const MAX_CACHE_BYPASS_PATHS = 64

const HEADER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
const FORBIDDEN_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'host'])

/**
 * Nginx directives that escape a site's `server {}` block or weaken multi-tenant isolation
 * when written by a non-root caller. Even for root, top-level context directives (`user`,
 * `pid`, `worker_processes`, `load_module`, `http`, `events`, `stream`) cannot appear inside
 * a vhost `server {}` include.
 */
const NGINX_TOP_LEVEL_FORBIDDEN = /^(?:user|pid|worker_processes|worker_rlimit_nofile|load_module|events|http|stream|mail|lock_file|daemon|master_process)\b/i
const NGINX_ISOLATION_FORBIDDEN = /^(?:root|alias|include|listen|server_name|lua_[a-z_]+|[a-z_]+_by_lua[a-z_]*|js_[a-z_]+|perl[a-z_]*|proxy_pass|fastcgi_pass|scgi_pass|uwsgi_pass|grpc_pass|memcached_pass|auth_request|mirror|client_body_temp_path|proxy_temp_path|fastcgi_temp_path|scgi_temp_path|uwsgi_temp_path|access_log|error_log|ssl_certificate|ssl_certificate_key|ssl_trusted_certificate|ssl_client_certificate|ssl_password_file|ssl_dhparam)\b/i

/**
 * Apache directives that alter process identity, load modules, or open listeners outside the
 * vhost scope.
 */
const APACHE_TOP_LEVEL_FORBIDDEN = /^(?:User|Group|Listen|LoadModule|LoadFile|ServerRoot|PidFile|ScoreBoardFile|Mutex|SuexecUserGroup|AssignUserId|<\s*VirtualHost\b)/i
const APACHE_ISOLATION_FORBIDDEN = /^(?:Include|IncludeOptional|Define|UnDefine|Alias|AliasMatch|ScriptAlias|ScriptAliasMatch|Action|SetHandler|FcgidWrapper|CustomLog|ErrorLog|DocumentRoot|Proxy[A-Za-z]*|RewriteMap|Lua[A-Za-z]*|Perl[A-Za-z]*|<\s*Proxy(?:Match)?\b|<\s*Directory(?:Match)?\b|<\s*Files(?:Match)?\b)/i

/** Inspect statements rather than physical lines; quoted delimiters are data. */
const nginxStatements = (text: string, inspect: (words: string[], line: number) => void): void => {
  let line = 1
  let statementLine = 1
  let depth = 0
  let quote: string | null = null
  let comment = false
  let escaped = false
  let started = false
  let word = ''
  let words: string[] = []
  const start = (): void => {
    if (!started && words.length === 0) statementLine = line
    started = true
  }
  const finishWord = (): void => {
    if (started) words.push(word)
    word = ''
    started = false
  }
  const finishStatement = (): void => {
    finishWord()
    if (!words.length || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(words[0]!)) {
      fail('VALIDATION', `line ${statementLine}: invalid nginx directive`)
    }
    inspect(words, statementLine)
    words = []
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (comment) {
      if (ch === '\n') { comment = false; line++ }
      continue
    }
    if (escaped) {
      word += ch
      escaped = false
      if (ch === '\n') line++
      continue
    }
    if (ch === '\\') { start(); escaped = true; continue }
    if (quote) {
      if (ch === quote) quote = null
      else word += ch
      if (ch === '\n') line++
      continue
    }
    if (ch === '"' || ch === "'") { start(); quote = ch; continue }
    if (ch === '#' && !started) { comment = true; continue }
    if (ch === '$' && text[i + 1] === '{') {
      const end = text.indexOf('}', i + 2)
      if (end < 0 || !/^[A-Za-z0-9_]+$/.test(text.slice(i + 2, end))) {
        fail('VALIDATION', `line ${line}: invalid nginx variable`)
      }
      start()
      word += text.slice(i, end + 1)
      i = end
      continue
    }
    if (ch === ';' || ch === '{') {
      finishStatement()
      if (ch === '{') depth++
      continue
    }
    if (ch === '}') {
      finishWord()
      if (words.length) fail('VALIDATION', `line ${line}: unterminated nginx directive`)
      if (--depth < 0) fail('VALIDATION', `line ${line}: unbalanced closing "}" in nginx custom include`)
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      finishWord()
      if (ch === '\n') line++
      continue
    }
    start()
    word += ch
  }
  if (quote || escaped) fail('VALIDATION', 'unterminated quote or escape in nginx custom include')
  finishWord()
  if (words.length) fail('VALIDATION', 'unterminated nginx directive')
  if (depth !== 0) fail('VALIDATION', 'unbalanced "{" in nginx custom include')
}

const apacheWords = (line: string): string[] => {
  const words: string[] = []
  let word = ''
  let quote: string | null = null
  let started = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quote) {
      if (ch === '\\' && (line[i + 1] === quote || line[i + 1] === '\\')) word += line[++i]
      else if (ch === quote) { quote = null; words.push(word); word = ''; started = false }
      else word += ch
    } else if (ch === '"' || ch === "'") {
      if (started) { words.push(word); word = '' }
      started = true
      quote = ch
    } else if (ch === ' ' || ch === '\t' || ch === '\r') {
      if (started) words.push(word)
      word = ''; started = false
    } else { started = true; word += ch }
  }
  if (quote) fail('VALIDATION', 'unterminated quote in apache custom include')
  if (started) words.push(word)
  return words
}

export interface CustomIncludeOptions {
  /** Only `root` in xWHM may use `root`, `alias`, `include`, `<Directory>`, or `SetHandler` in custom drop-ins. */
  allowRootDirectives?: boolean
  /** Account home directory used to verify that any path referenced by root stays inside the account or `/var/www`. */
  accountHome?: string
  /** Optional expected accountId when validating a stored userdata JSON file */
  accountId?: Id
}

/**
 * Validates a custom Nginx vhost include snippet (`userdata` drop-in).
 * Checks balanced braces, forbids NUL/control characters, blocks top-level directives that
 * would break `nginx -t`, and blocks filesystem-escaping directives unless `allowRootDirectives` is true.
 */
export const validateNginxCustomInclude = (snippet: unknown, opts: CustomIncludeOptions = {}): string => {
  if (typeof snippet !== 'string') return fail('VALIDATION', 'nginx custom include must be a string')
  if (snippet.length > MAX_CUSTOM_INCLUDE_CHARS) {
    return fail('VALIDATION', `nginx custom include exceeds ${MAX_CUSTOM_INCLUDE_CHARS} characters`)
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(snippet)) {
    return fail('VALIDATION', 'nginx custom include contains control characters')
  }

  const lines = snippet.replace(/\r\n/g, '\n').split('\n')
  nginxStatements(lines.join('\n'), (words, line) => {
    const name = words[0]!
    if (NGINX_TOP_LEVEL_FORBIDDEN.test(name)) {
      return fail('VALIDATION', `line ${line}: directive is not allowed inside a site server {} include`, {
        line, text: name,
      })
    }
    if (!opts.allowRootDirectives && NGINX_ISOLATION_FORBIDDEN.test(name)) {
      return fail('FORBIDDEN', `line ${line}: directive requires root privileges in xWHM`, {
        line, text: name,
      })
    }
    if (opts.allowRootDirectives && opts.accountHome && /^(?:root|alias)$/i.test(name)) {
      const target = words[1] ?? ''
      const home = posix.normalize(opts.accountHome).replace(/\/$/, '')
      const normalized = posix.normalize(target)
      if (words.length !== 2 || !posix.isAbsolute(target) || target.includes('$') ||
          (normalized !== home && !normalized.startsWith(`${home}/`))) {
        return fail('FORBIDDEN', `line ${line}: custom root/alias path must stay inside account home ${opts.accountHome}`, { line })
      }
    }
  })
  return lines.join('\n').trim()
}

/**
 * Validates a custom Apache `<VirtualHost>` include snippet (`userdata` drop-in).
 * Blocks `AssignUserId`, `SuexecUserGroup`, `User`, `Group`, `Listen`, `LoadModule`, and nested `<VirtualHost>`.
 */
export const validateApacheCustomInclude = (snippet: unknown, opts: CustomIncludeOptions = {}): string => {
  if (typeof snippet !== 'string') return fail('VALIDATION', 'apache custom include must be a string')
  if (snippet.length > MAX_CUSTOM_INCLUDE_CHARS) {
    return fail('VALIDATION', `apache custom include exceeds ${MAX_CUSTOM_INCLUDE_CHARS} characters`)
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(snippet)) {
    return fail('VALIDATION', 'apache custom include contains control characters')
  }

  const lines = snippet.replace(/\r\n/g, '\n').split('\n')
  let logical = ''
  let logicalLine = 1
  const sections: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!
    if (!logical) logicalLine = i + 1
    logical += rawLine.endsWith('\\') ? rawLine.slice(0, -1) : rawLine
    if (rawLine.endsWith('\\')) continue
    const stripped = logical.trim()
    logical = ''
    if (!stripped || stripped.startsWith('#')) continue

    const words = apacheWords(stripped)
    const name = words[0] ?? ''
    if (!/^(?:[A-Za-z][A-Za-z0-9_]*|<\/?[A-Za-z][A-Za-z0-9_]*>?)$/.test(name)) {
      fail('VALIDATION', `line ${logicalLine}: invalid apache directive`)
    }
    if (APACHE_TOP_LEVEL_FORBIDDEN.test(name) || APACHE_TOP_LEVEL_FORBIDDEN.test(stripped)) {
      return fail('FORBIDDEN', `line ${logicalLine}: directive is forbidden inside an account VirtualHost include`, {
        line: logicalLine,
        text: stripped.slice(0, 80),
      })
    }
    if (!opts.allowRootDirectives && (APACHE_ISOLATION_FORBIDDEN.test(name) || APACHE_ISOLATION_FORBIDDEN.test(stripped))) {
      return fail('FORBIDDEN', `line ${logicalLine}: directive requires root privileges in xWHM`, {
        line: logicalLine,
        text: stripped.slice(0, 80),
      })
    }
    const section = /^<(\/?)([A-Za-z][A-Za-z0-9_]*)>?$/.exec(name)
    if (section) {
      if (!stripped.endsWith('>')) fail('VALIDATION', `line ${logicalLine}: unterminated apache section`)
      const kind = section[2]!.toLowerCase()
      if (section[1]) {
        if (words.length !== 1 || sections.pop() !== kind) {
          fail('VALIDATION', `line ${logicalLine}: unbalanced apache section`)
        }
      } else sections.push(kind)
    }
    if (!opts.allowRootDirectives && /^RewriteRule$/i.test(name)) {
      // Apache expands configuration variables before parsing words. A value
      // may introduce proxy flags even when no literal flag is present here.
      if (stripped.includes('${')) {
        return fail('FORBIDDEN', `line ${logicalLine}: rewrite configuration substitutions require root privileges in xWHM`, { line: logicalLine })
      }
      const flags = words[3]?.replace(/^\[|\]$/g, '').split(',').map(flag => flag.trim().toLowerCase()) ?? []
      if (flags.includes('p') || flags.includes('proxy') || flags.some(flag => /^(?:h|handler)(?:=|$)/.test(flag))) {
        return fail('FORBIDDEN', `line ${logicalLine}: proxy or handler rewrite requires root privileges in xWHM`, { line: logicalLine })
      }
    }
  }
  if (logical) fail('VALIDATION', 'unterminated continuation in apache custom include')
  if (sections.length) fail('VALIDATION', 'unbalanced apache section in custom include')
  return lines.join('\n').trim()
}

export const validateCustomHeaders = (headers: unknown): Record<string, string> => {
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
    return fail('VALIDATION', 'customHeaders must be an object')
  }
  const entries = Object.entries(headers as Record<string, unknown>)
  if (entries.length > MAX_CUSTOM_HEADERS) {
    return fail('VALIDATION', `at most ${MAX_CUSTOM_HEADERS} custom headers are allowed`)
  }
  const out: Record<string, string> = {}
  for (const [k, v] of entries) {
    if (!HEADER_NAME_RE.test(k) || FORBIDDEN_HEADERS.has(k.toLowerCase())) {
      return fail('VALIDATION', `invalid or reserved HTTP header name "${k}"`, { header: k })
    }
    if (typeof v !== 'string' || v.length === 0 || v.length > 1024 || /[\r\n\u0000-\u001f\u007f"\\]/.test(v)) {
      return fail('VALIDATION', `invalid value for custom header "${k}"`, { header: k })
    }
    out[k] = v
  }
  return out
}

export const validateCacheBypassPaths = (paths: unknown): string[] => {
  if (!Array.isArray(paths)) return fail('VALIDATION', 'cacheBypassPaths must be an array')
  if (paths.length > MAX_CACHE_BYPASS_PATHS) {
    return fail('VALIDATION', `at most ${MAX_CACHE_BYPASS_PATHS} cache bypass paths are allowed`)
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const p of paths) {
    if (typeof p !== 'string' || !p.startsWith('/') || p.length > 256 || /[\s\u0000-\u001f\u007f"'\\;$]/.test(p)) {
      return fail('VALIDATION', 'cache bypass path must start with "/" and contain no spaces or control characters', { path: p })
    }
    if (!seen.has(p)) {
      seen.add(p)
      out.push(p)
    }
  }
  return out
}

export const validateUserIniMap = (ini: unknown): Record<string, string> => {
  const sanitized = sanitizePhpIni(ini)
  for (const k of Object.keys(sanitized)) {
    if (phpIniScope(k) !== 'user') {
      return fail('VALIDATION', `directive "${k}" cannot be set in .user.ini`, { directive: k })
    }
  }
  return sanitized
}

export const validateDomainCustomConfig = (
  input: unknown,
  opts: CustomIncludeOptions = {},
): DomainCustomConfig => {
  if (typeof input !== 'object' || input === null) {
    return fail('VALIDATION', 'domain custom config must be an object')
  }
  const raw = input as Record<string, unknown>
  const domainId = typeof raw.domainId === 'string' && raw.domainId.length > 0 ? raw.domainId : fail('VALIDATION', 'domainId is required')
  const accountId = typeof raw.accountId === 'string' && raw.accountId.length > 0 ? raw.accountId : fail('VALIDATION', 'accountId is required')
  if (opts.accountId && accountId !== opts.accountId) {
    return fail('VALIDATION', 'custom config accountId mismatch')
  }
  const domainName = typeof raw.domainName === 'string' && raw.domainName.length > 0 ? raw.domainName : fail('VALIDATION', 'domainName is required')
  const updatedBy =
    raw.updatedBy === 'root' || raw.updatedBy === 'reseller' || raw.updatedBy === 'user'
      ? raw.updatedBy
      : 'user'
  const allowRoot = opts.allowRootDirectives ?? updatedBy === 'root'
  return {
    domainId,
    accountId,
    domainName,
    nginxInclude: validateNginxCustomInclude(raw.nginxInclude ?? '', { ...opts, allowRootDirectives: allowRoot }),
    apacheInclude: validateApacheCustomInclude(raw.apacheInclude ?? '', { ...opts, allowRootDirectives: allowRoot }),
    userIni: validateUserIniMap(raw.userIni ?? {}),
    customHeaders: validateCustomHeaders(raw.customHeaders ?? {}),
    cacheBypassPaths: validateCacheBypassPaths(raw.cacheBypassPaths ?? []),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    updatedBy,
  }
}

/**
 * Verifies whether an account is permitted to open an isolated jailed shell (`jailshell` / Web Terminal).
 * Both the plan and the account must have `shell: 'jailed'` and the account must be `active`.
 */
export const assertJailedShellAllowed = (
  account: Pick<Account, 'username' | 'status' | 'shell'>,
  plan: Pick<Plan, 'name' | 'shell'>,
): void => {
  if (account.status !== 'active') {
    fail('PRECONDITION_FAILED', `shell access is unavailable while account "${account.username}" is ${account.status}`, {
      username: account.username,
      status: account.status,
    })
  }
  if (plan.shell !== 'jailed') {
    fail('FORBIDDEN', `plan "${plan.name}" has shell access disabled (shell: none)`, {
      username: account.username,
      planShell: plan.shell,
    })
  }
  if (account.shell !== 'jailed') {
    fail('FORBIDDEN', `jailed shell is disabled on account "${account.username}"`, {
      username: account.username,
      accountShell: account.shell,
    })
  }
}
