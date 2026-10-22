import type { Account, Domain, DomainKind } from '../types.ts'
import { fail, isXpanelError } from '../errors.ts'
import { invalid } from './check.ts'
import { DOMAIN_MAX, validateDomainName, validateUsername, validateWildcardName } from './naming.ts'
import { domainServingState } from './suspension.ts'

const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/
const MAX_PATH = 4096

/** Top-level home entries a docroot may never point into. Hidden segments fail SEGMENT_RE already. */
export const PROTECTED_HOME_DIRS: ReadonlySet<string> = new Set(['mail', 'etc', 'tmp', 'logs', 'ssl', 'backups'])

const assertSegments = (what: string, segments: string[]): void => {
  for (const seg of segments) {
    if (!SEGMENT_RE.test(seg) || seg === '.' || seg === '..') invalid(`${what} contains an invalid path segment`, { segment: seg })
  }
}

// Homes anchor every docroot check, so they may never sit in an OS tree: a docroot under
// /etc/x or /var/lib/mysql/x would hand an account system files.
const SYSTEM_TOP_DIRS: ReadonlySet<string> = new Set([
  'bin', 'boot', 'dev', 'etc', 'lib', 'lib32', 'lib64', 'libx32', 'opt', 'proc', 'root', 'run', 'sbin', 'snap', 'sys', 'tmp', 'usr',
])
const SYSTEM_VAR_DIRS: ReadonlySet<string> = new Set(['cache', 'lib', 'lock', 'log', 'mail', 'run', 'spool', 'tmp'])

/**
 * Absolute, normalized home path outside system trees: no `.`/`..`, no `//`, no trailing slash.
 * With `username`, the home must also be `<base>/<username>`, so a corrupted record can never
 * point one account's docroots into another account's home.
 */
export const validateHome = (home: unknown, username?: string): string => {
  if (typeof home !== 'string' || !home.startsWith('/') || home.length > MAX_PATH) return invalid('home must be an absolute path')
  const segments = home.slice(1).split('/')
  if (segments.length < 2) return invalid('home must not be a top-level directory', { home })
  assertSegments('home', segments)
  const [top = '', second = ''] = segments
  if (SYSTEM_TOP_DIRS.has(top) || (top === 'var' && SYSTEM_VAR_DIRS.has(second))) {
    return invalid('home may not be inside a system directory', { home })
  }
  if (username !== undefined && segments[segments.length - 1] !== validateUsername(username)) {
    return invalid('home must end with the account username', { home, username })
  }
  return home
}

export interface DocRootOptions {
  /** relative directory under home holding addon/subdomain docroots; default: home itself */
  addonParent?: string
  /** docroot of the domain an alias points at; defaults to the primary docroot */
  aliasOf?: string
}

/**
 * Primary: `<home>/public_html`. Addon and subdomain: `<home>/<name>` (or under
 * `addonParent`). Alias: the docroot of what it points at.
 */
export const defaultDocRoot = (
  account: Pick<Account, 'home' | 'username'>,
  kind: DomainKind,
  name: string,
  opts: DocRootOptions = {},
): string => {
  const home = validateHome(account.home, account.username)
  const primary = `${home}/public_html`
  switch (kind) {
    case 'primary':
      validateDomainName(name)
      return primary
    case 'alias':
      validateDomainName(name)
      return opts.aliasOf === undefined ? primary : validateDocRoot(home, opts.aliasOf)
    case 'addon':
    case 'subdomain': {
      const domain = validateDomainName(name)
      if (opts.addonParent === undefined || opts.addonParent === '') return `${home}/${domain}`
      return validateDocRoot(home, `${opts.addonParent}/${domain}`)
    }
    default:
      return invalid('unknown domain kind', { kind })
  }
}

/**
 * A user-chosen docroot, absolute or relative to home. It must sit strictly inside home,
 * outside protected and hidden directories. Returns the absolute path.
 */
export const validateDocRoot = (homeInput: string, docRoot: unknown): string => {
  const home = validateHome(homeInput)
  if (typeof docRoot !== 'string' || docRoot.length === 0 || docRoot.length > MAX_PATH) return invalid('document root is required')
  let rel: string
  if (docRoot.startsWith('/')) {
    if (!docRoot.startsWith(`${home}/`)) return invalid('document root must be inside the account home', { docRoot })
    rel = docRoot.slice(home.length + 1)
  } else {
    rel = docRoot
  }
  if (rel.length === 0 || rel.endsWith('/')) return invalid('document root must name a directory inside home', { docRoot })
  const segments = rel.split('/')
  assertSegments('document root', segments)
  const first = segments[0] ?? ''
  if (PROTECTED_HOME_DIRS.has(first)) return invalid(`document root may not be inside "${first}"`, { docRoot })
  return `${home}/${segments.join('/')}`
}

/** Request Host header to a canonical name, or null when it cannot be a hosted domain. */
export const normalizeHost = (host: unknown): string | null => {
  if (typeof host !== 'string' || host.length === 0 || host.length > 300) return null
  const bare = host.replace(/:\d{1,5}$/, '')
  try {
    return validateDomainName(bare)
  } catch {
    return null
  }
}

type Servable = Pick<Domain, 'name' | 'wildcard'>

/**
 * Which domain serves `host`: an exact name first (so an explicit subdomain beats a
 * wildcard), then the implicit `www.` of an exact name, then the longest wildcard parent.
 */
export const resolveServingDomain = <D extends Servable>(host: unknown, domains: readonly D[], opts: { www?: boolean } = {}): D | null => {
  const name = normalizeHost(host)
  if (name === null) return null
  const byName = new Map(domains.map((d) => [d.name.toLowerCase(), d]))
  const exact = byName.get(name)
  if (exact) return exact
  if (opts.www !== false && name.startsWith('www.')) {
    const bare = byName.get(name.slice(4))
    if (bare) return bare
  }
  let best: D | null = null
  for (const d of domains) {
    if (!d.wildcard) continue
    const parent = d.name.toLowerCase()
    if (name.endsWith(`.${parent}`) && (best === null || parent.length > best.name.length)) best = d
  }
  return best
}

type Owned = Pick<Domain, 'name' | 'accountId'>

const isUnder = (child: string, parent: string): boolean => child.endsWith(`.${parent}`)

/**
 * CONFLICT when the name is taken, collides with an implicit `www.` name, or sits above or
 * below a domain another account owns, which would let one tenant take over another's zone
 * or subdomains. Without `accountId` every overlap counts as foreign (fail closed): pass the
 * account the name is being added to.
 */
export const assertDomainUnique = (name: unknown, allDomains: readonly Owned[], accountId?: string): string => {
  const n = validateDomainName(name)
  for (const d of allDomains) {
    const existing = d.name.toLowerCase()
    if (existing === n) fail('CONFLICT', `domain ${n} already exists`, { name: n })
    if (existing === `www.${n}` || `www.${existing}` === n) {
      fail('CONFLICT', `domain ${n} collides with the www name of ${existing}`, { name: n, existing })
    }
    const foreign = accountId === undefined || d.accountId !== accountId
    if (foreign && (isUnder(n, existing) || isUnder(existing, n))) {
      fail('CONFLICT', `domain ${n} overlaps ${existing}, which belongs to another account`, { name: n, existing })
    }
  }
  return n
}

type AliasCandidate = Pick<Domain, 'id' | 'accountId' | 'kind' | 'suspended'>

/** Domains an alias of this account may point at: its primary and addon domains. */
export const aliasTargets = <D extends AliasCandidate>(accountId: string, domains: readonly D[]): D[] =>
  domains.filter((d) => d.accountId === accountId && (d.kind === 'primary' || d.kind === 'addon') && !d.suspended)

export const assertAliasTarget = (accountId: string, target: AliasCandidate): void => {
  if (target.accountId !== accountId) fail('FORBIDDEN', 'alias target belongs to another account')
  if (target.kind !== 'primary' && target.kind !== 'addon') {
    invalid('an alias may only point at a primary or addon domain', { kind: target.kind })
  }
  if (target.suspended) fail('PRECONDITION_FAILED', 'alias target is suspended')
}

type VhostDomain = Pick<Domain, 'id' | 'accountId' | 'name' | 'wildcard'>
type AliasRecord = Pick<Domain, 'accountId' | 'name' | 'kind' | 'parentId' | 'wildcard' | 'suspended' | 'expiresAt'>

/**
 * Every name a vhost answers to: the domain, its www, its serving aliases (and their www), and
 * `*.` for each name with the wildcard flag. Only aliases of the same account count, so a
 * forged parentId cannot pull a name into another tenant's vhost. A suspended or expired alias
 * is left out: its page is the suspension/expiry page, not the parent's site. Each stored name
 * is validated again because the list goes into server_name and ServerAlias lines.
 */
export const serverNames = (domain: VhostDomain, allDomains: readonly AliasRecord[], now: Date = new Date()): string[] => {
  // the implicit www only exists while it still fits the DNS length limit
  const withWww = (n: string): string[] => (n.length + 4 <= DOMAIN_MAX ? [n, `www.${n}`] : [n])
  const own = validateDomainName(domain.name)
  const names = withWww(own)
  const wildcards = domain.wildcard === true ? [validateWildcardName(`*.${own}`)] : []
  for (const d of allDomains) {
    if (d.kind !== 'alias' || d.parentId !== domain.id || d.accountId !== domain.accountId) continue
    if (domainServingState({ status: 'active' }, d, now) !== 'serving') continue
    const alias = validateDomainName(d.name)
    names.push(...withWww(alias))
    if (d.wildcard === true) wildcards.push(validateWildcardName(`*.${alias}`))
  }
  return [...new Set([...names, ...wildcards])]
}

export interface PrimaryRename {
  ok: boolean
  /** canonical new name when ok */
  name: string | null
  reasons: string[]
  /** subdomains hanging off the old primary that follow it to the new name */
  subdomainRenames: { id: string; from: string; to: string }[]
}

const reasonOf = (e: unknown): string => (isXpanelError(e) ? e.message : String(e))

/** Whether the account's primary domain may become `newName`, and what moves with it. */
export const canRenamePrimary = (
  account: Pick<Account, 'id' | 'primaryDomain' | 'status'>,
  newName: unknown,
  allDomains: readonly Pick<Domain, 'id' | 'name' | 'accountId' | 'kind'>[],
): PrimaryRename => {
  const reasons: string[] = []
  const subdomainRenames: PrimaryRename['subdomainRenames'] = []
  if (account.status !== 'active') reasons.push(`account is ${account.status}`)
  let name: string | null = null
  try {
    name = validateDomainName(newName)
  } catch (e) {
    reasons.push(reasonOf(e))
  }
  let old: string | null = null
  try {
    old = validateDomainName(account.primaryDomain)
  } catch (e) {
    reasons.push(`current primary domain: ${reasonOf(e)}`)
  }
  if (name !== null && name === old) reasons.push('new name equals the current primary domain')
  else if (name !== null && old !== null) {
    // the old primary and its subdomains are being replaced, so they do not count as clashes
    const moving = allDomains.filter((d) => d.accountId === account.id && d.kind === 'subdomain' && isUnder(d.name.toLowerCase(), old))
    const movingIds = new Set(moving.map((d) => d.id))
    const others = allDomains.filter((d) => !movingIds.has(d.id) && d.name.toLowerCase() !== old)
    try {
      assertDomainUnique(name, others, account.id)
    } catch (e) {
      reasons.push(reasonOf(e))
    }
    for (const d of moving) {
      const to = `${d.name.toLowerCase().slice(0, -old.length)}${name}`
      try {
        subdomainRenames.push({ id: d.id, from: d.name, to: assertDomainUnique(to, others, account.id) })
      } catch (e) {
        reasons.push(`subdomain ${d.name}: ${reasonOf(e)}`)
      }
    }
  }
  const ok = reasons.length === 0
  return { ok, name: ok ? name : null, reasons, subdomainRenames: ok ? subdomainRenames : [] }
}
