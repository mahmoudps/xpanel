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
const NGINX_ISOLATION_FORBIDDEN = /^(?:root|alias|include|lua_[a-z_]+|perl[a-z_]*|client_body_temp_path|proxy_temp_path|fastcgi_temp_path|scgi_temp_path|uwsgi_temp_path|access_log|error_log|ssl_certificate_key)\b/i

/**
 * Apache directives that alter process identity, load modules, or open listeners outside the
 * vhost scope.
 */
const APACHE_TOP_LEVEL_FORBIDDEN = /^(?:User|Group|Listen|LoadModule|LoadFile|ServerRoot|PidFile|ScoreBoardFile|Mutex|SuexecUserGroup|AssignUserId|<\s*VirtualHost\b)/i
const APACHE_ISOLATION_FORBIDDEN = /^(?:Include|IncludeOptional|ScriptAlias|ScriptAliasMatch|Action|SetHandler|FcgidWrapper|CustomLog|ErrorLog|DocumentRoot|<\s*Directory\b|<\s*Files\b)/i

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

  let braceDepth = 0
  const lines = snippet.replace(/\r\n/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!
    const stripped = rawLine.replace(/#.*$/, '').trim()
    if (!stripped) continue

    if (NGINX_TOP_LEVEL_FORBIDDEN.test(stripped)) {
      return fail('VALIDATION', `line ${i + 1}: directive is not allowed inside a site server {} include`, {
        line: i + 1,
        text: stripped.slice(0, 80),
      })
    }
    if (!opts.allowRootDirectives && NGINX_ISOLATION_FORBIDDEN.test(stripped)) {
      return fail('FORBIDDEN', `line ${i + 1}: directive requires root privileges in xWHM`, {
        line: i + 1,
        text: stripped.slice(0, 80),
      })
    }
    if (opts.allowRootDirectives && opts.accountHome) {
      const pathMatch = /^(?:root|alias)\s+([^\s;]+)/i.exec(stripped)
      if (pathMatch) {
        const target = pathMatch[1]!.replace(/^["']|["']$/g, '')
        if (!target.startsWith(`${opts.accountHome}/`) && target !== opts.accountHome) {
          return fail('FORBIDDEN', `line ${i + 1}: custom root/alias path must stay inside account home ${opts.accountHome}`, {
            line: i + 1,
            path: target,
          })
        }
      }
    }

    for (const ch of stripped) {
      if (ch === '{') braceDepth++
      else if (ch === '}') {
        braceDepth--
        if (braceDepth < 0) {
          return fail('VALIDATION', `line ${i + 1}: unbalanced closing "}" in nginx custom include`, { line: i + 1 })
        }
      }
    }
  }
  if (braceDepth !== 0) {
    return fail('VALIDATION', 'unbalanced "{" in nginx custom include')
  }
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
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!
    const stripped = rawLine.replace(/#.*$/, '').trim()
    if (!stripped) continue

    if (APACHE_TOP_LEVEL_FORBIDDEN.test(stripped)) {
      return fail('FORBIDDEN', `line ${i + 1}: directive is forbidden inside an account VirtualHost include`, {
        line: i + 1,
        text: stripped.slice(0, 80),
      })
    }
    if (!opts.allowRootDirectives && APACHE_ISOLATION_FORBIDDEN.test(stripped)) {
      return fail('FORBIDDEN', `line ${i + 1}: directive requires root privileges in xWHM`, {
        line: i + 1,
        text: stripped.slice(0, 80),
      })
    }
  }
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
