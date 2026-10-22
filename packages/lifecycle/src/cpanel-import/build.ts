import { X509Certificate, createPrivateKey } from 'node:crypto'
import { posix } from 'node:path'
import { defaultDocRoot, fail, isXpanelError, validateDocRoot } from '@xpanel/core'
import type { DomainKind, Limit, PlanCaps } from '@xpanel/core'
import { services } from '@xpanel/render'
import type { DomainMail } from '../backup/mail-config.ts'
import { isPlanName } from '../transfer/session.ts'
import { assertDatabaseName, assertDbUserName, isAddress, isDomain, isHostedAddress, isIpv4, passes } from '../validate.ts'
import { parseGrants } from './grants.ts'
import type { ParsedGrant } from './grants.ts'
import { cpDomains, parseValiases, phpVersionHint } from './parsers.ts'
import type { ReadState } from './state.ts'
import { warn } from './state.ts'
import type { ImportAccount, ImportDatabase, ImportDbUser, ImportDomain, ImportMailbox, ImportZone } from './types.ts'

const MB = 1024 * 1024
const mbOf = (bytes: number): Limit => (bytes === 0 ? 'unlimited' : Math.ceil(bytes / MB))
const errText = (e: unknown): string => (e instanceof Error ? e.message.slice(0, 200) : 'invalid')

const limitOf = (v: string | undefined): Limit | undefined => {
  if (v === undefined) return undefined
  if (/^unlimited$/i.test(v)) return 'unlimited'
  return /^\d{1,12}$/.test(v) ? Number(v) : undefined
}

const CP_CAPS: readonly [string, keyof PlanCaps][] = [
  ['MAXADDON', 'addonDomains'], ['MAXPARK', 'aliasDomains'], ['MAXSUB', 'subdomains'], ['MAXPOP', 'mailboxes'],
  ['MAXSQL', 'databases'], ['MAXFTP', 'ftpAccounts'], ['MAXLST', 'mailingLists'],
]

export const primaryDomainOf = (s: ReadState): string => {
  const primary = s.main?.mainDomain ?? (s.cp ? cpDomains(s.cp)[0] : undefined)
  return primary !== undefined && isDomain(primary) ? primary : fail('VALIDATION', 'archive has no valid main domain')
}

export const buildAccount = (s: ReadState, username: string, primaryDomain: string): ImportAccount => {
  const cp = s.cp
  const caps: Partial<PlanCaps> = {}
  for (const [key, cap] of CP_CAPS) {
    const l = limitOf(cp?.get(key))
    if (l !== undefined) caps[cap] = l
  }
  const quotaMb = s.quota?.trim() ? limitOf(s.quota.trim()) : undefined
  const bw = limitOf(cp?.get('BWLIMIT'))
  const contact = cp?.get('CONTACTEMAIL')?.toLowerCase()
  const plan = cp?.get('PLAN')
  if (plan !== undefined && !isPlanName(plan)) warn(s, 'plan-name-unusable', 'the source plan name is not a valid plan name here; choose a plan on apply')
  const ip = cp?.get('IP')
  return {
    username,
    primaryDomain,
    contactEmail: contact !== undefined && isAddress(contact) ? contact : null,
    sourcePlan: plan !== undefined && isPlanName(plan) ? plan : null,
    sourceIp: ip !== undefined && isIpv4(ip) ? ip : null,
    diskQuotaMb: quotaMb === undefined ? null : quotaMb === 0 ? 'unlimited' : quotaMb,
    bandwidthMbMonth: bw === undefined ? null : bw === 'unlimited' || bw === 0 ? 'unlimited' : mbOf(bw),
    caps,
    passwordResetRequired: true,
  }
}

/** A cPanel document root as a path relative to the new home, or null when it was outside the old home. */
const rebaseDocroot = (docroot: string | null, oldHomes: readonly string[], newHome: string): string | null => {
  if (!docroot) return null
  const clean = docroot.replace(/\/+$/, '')
  for (const h of oldHomes) {
    if (!clean.startsWith(`${h}/`)) continue
    try {
      return validateDocRoot(newHome, clean.slice(h.length + 1)).slice(newHome.length + 1)
    } catch (e) {
      if (isXpanelError(e)) return null
      throw e
    }
  }
  return null
}

const relativeDefault = (home: string, username: string, kind: DomainKind, name: string): string =>
  defaultDocRoot({ home, username }, kind, name).slice(home.length + 1)

export const buildDomains = (s: ReadState, sourceUser: string, target: string, primary: string): ImportDomain[] => {
  const newHome = `/home/${target}`
  const oldHomes = (ud: string): string[] => {
    const h = s.userdata.get(ud)?.homedir?.replace(/\/+$/, '')
    return [...(h && posix.basename(h) === sourceUser ? [h] : []), `/home/${sourceUser}`, ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `/home${n}/${sourceUser}`)]
  }
  const out: ImportDomain[] = []
  const names = new Set<string>()
  const add = (name: string, kind: DomainKind, parent: string | null, udName: string): ImportDomain | null => {
    if (!isDomain(name)) { warn(s, 'domain-skipped', `invalid domain ${name.slice(0, 100)}`); return null }
    if (names.has(name)) return null
    const ud = s.userdata.get(udName)
    const fallback = relativeDefault(newHome, target, kind === 'alias' ? 'primary' : kind, name)
    let docRoot = rebaseDocroot(ud?.documentroot ?? null, oldHomes(udName), newHome)
    if (docRoot === null) {
      if (ud?.documentroot) warn(s, 'docroot-outside-home', `${name}: document root ${ud.documentroot.slice(0, 200)} is not usable inside the new home; using ${fallback}`)
      docRoot = fallback
    }
    names.add(name)
    const d: ImportDomain = {
      name, kind, parent, docRoot,
      serverAliases: (ud?.serveralias ?? []).filter((a) => isDomain(a) || (a.startsWith('*.') && isDomain(a.slice(2)))),
      phpVersion: phpVersionHint(ud?.phpversion ?? null),
      wildcard: false,
    }
    out.push(d)
    return d
  }
  const primaryDomain = add(primary, 'primary', null, primary) as ImportDomain
  const main = s.main
  if (!main) {
    warn(s, 'userdata-missing', 'userdata/main is missing; only the primary domain is imported')
    return out
  }
  const backing = new Set<string>()
  for (const [addon, sub] of main.addonDomains) {
    backing.add(sub)
    add(addon, 'addon', null, s.userdata.has(sub) ? sub : addon)
  }
  for (const parked of main.parkedDomains) {
    if (!isDomain(parked)) { warn(s, 'domain-skipped', `invalid parked domain ${parked.slice(0, 100)}`); continue }
    if (names.has(parked)) continue
    names.add(parked)
    out.push({ name: parked, kind: 'alias', parent: primary, docRoot: primaryDomain.docRoot, serverAliases: [], phpVersion: primaryDomain.phpVersion, wildcard: false })
  }
  const parentOf = (sub: string): ImportDomain | undefined =>
    out.filter((d) => (d.kind === 'primary' || d.kind === 'addon') && sub.endsWith(`.${d.name}`)).sort((a, b) => b.name.length - a.name.length)[0]
  for (const sub of main.subDomains) {
    if (backing.has(sub)) continue
    if (sub.startsWith('*.')) {
      const parent = out.find((d) => d.name === sub.slice(2))
      if (!parent) { warn(s, 'domain-skipped', `wildcard ${sub.slice(0, 100)} has no parent domain`); continue }
      parent.wildcard = true
      const ud = s.userdata.get(`_wildcard_.${parent.name}`)
      if (ud?.documentroot && rebaseDocroot(ud.documentroot, oldHomes(parent.name), newHome) !== parent.docRoot) {
        warn(s, 'wildcard-docroot', `*.${parent.name} had its own document root; it now serves ${parent.docRoot}`)
      }
      continue
    }
    const parent = parentOf(sub)
    if (!parent) { warn(s, 'domain-skipped', `subdomain ${sub.slice(0, 100)} has no parent domain in this account`); continue }
    add(sub, 'subdomain', parent.name, sub)
  }
  return out
}

/** `<source>_x` -> `<target>_x`; unprefixed or mixed-case names are folded into the target's prefix. */
const mapPrefixed = (s: ReadState, src: string, sourceUser: string, target: string, assertName: (n: string) => string, what: string): string | null => {
  let rest = src.startsWith(`${sourceUser}_`) ? src.slice(sourceUser.length + 1) : src
  if (!src.startsWith(`${sourceUser}_`)) warn(s, `${what}-renamed`, `${src.slice(0, 80)} was not prefixed with ${sourceUser}_`)
  if (/[A-Z-]/.test(rest)) {
    warn(s, `${what}-renamed`, `${src.slice(0, 80)} contains uppercase letters or hyphens; renamed`)
    rest = rest.toLowerCase().replace(/-/g, '_')
  }
  try {
    return assertName(`${target}_${rest}`)
  } catch (e) {
    if (!isXpanelError(e)) throw e
    warn(s, `${what}-skipped`, `${src.slice(0, 80)} cannot be mapped to a valid name: ${errText(e)}`)
    return null
  }
}

export const buildDatabases = (s: ReadState, sourceUser: string, target: string): { databases: ImportDatabase[]; map: Map<string, string> } => {
  const map = new Map<string, string>()
  const databases: ImportDatabase[] = []
  for (const [src, ref] of s.sql) {
    const name = mapPrefixed(s, src, sourceUser, target, (n) => assertDatabaseName(n, target), 'database')
    if (!name) continue
    if (databases.some((d) => d.name === name)) { warn(s, 'database-skipped', `${src} maps onto ${name}, which another dump already uses`); continue }
    map.set(src, name)
    databases.push({ sourceName: src, name, sql: ref })
  }
  return { databases, map }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

const grantPrivileges = (s: ReadState, g: ParsedGrant): services.MariadbPrivilege[] => {
  const privs: services.MariadbPrivilege[] = []
  for (const p of g.privileges) {
    if (p === 'USAGE') continue
    try {
      privs.push(...services.normalizePrivileges([p]))
    } catch (e) {
      if (!isXpanelError(e)) throw e
      warn(s, 'grant-dropped', `privilege ${p.slice(0, 60)} for ${g.user.slice(0, 80)} is not allowed`)
    }
  }
  return privs.length ? services.normalizePrivileges(privs) : []
}

export const buildDbUsers = (s: ReadState, sourceUser: string, target: string, dbMap: ReadonlyMap<string, string>): { users: ImportDbUser[]; remote: string[] } => {
  const grants = s.grants ? parseGrants(s.grants) : { grants: [], users: [], ignored: 0 }
  if (grants.ignored) warn(s, 'grant-unparsed', `${grants.ignored} statement(s) in mysql.sql were not GRANT or CREATE USER and were ignored`)
  const users = new Map<string, ImportDbUser>()
  /** source user -> target name, so a user with several grants is renamed (and warned about) once */
  const names = new Map<string, string | null>()
  const remote = new Set<string>()
  for (const g of grants.grants) {
    if (g.user === sourceUser) continue
    if (g.database === '*') {
      const extra = g.privileges.filter((p) => p !== 'USAGE')
      if (extra.length) warn(s, 'grant-dropped', `global privileges ${extra.join(', ').slice(0, 200)} for ${g.user.slice(0, 80)} are not imported`)
      continue
    }
    if (g.database === null) { warn(s, 'grant-dropped', `wildcard grant on ${g.pattern.slice(0, 80)} for ${g.user.slice(0, 80)} is not imported`); continue }
    const db = dbMap.get(g.database)
    if (!db) { warn(s, 'grant-dropped', `grant for ${g.user.slice(0, 80)} on missing database ${g.database.slice(0, 80)}`); continue }
    if (g.table !== '*') { warn(s, 'grant-dropped', `table-level grant ${g.database.slice(0, 80)}.${g.table.slice(0, 80)} for ${g.user.slice(0, 80)} is not widened to the database`); continue }
    if (g.withGrantOption) warn(s, 'grant-dropped', `GRANT OPTION for ${g.user.slice(0, 80)} is not imported`)
    const privileges = grantPrivileges(s, g)
    if (!privileges.length) continue
    let host: string
    try {
      host = services.assertDbHost(g.host)
    } catch (e) {
      if (!isXpanelError(e)) throw e
      warn(s, 'grant-dropped', `host ${g.host.slice(0, 80)} for ${g.user.slice(0, 80)} is not allowed: ${errText(e)}`)
      continue
    }
    if (!names.has(g.user)) names.set(g.user, mapPrefixed(s, g.user, sourceUser, target, (n) => assertDbUserName(n, target), 'database-user'))
    const name = names.get(g.user)
    if (!name) continue
    const u = users.get(name) ?? { sourceName: g.user, name, hosts: [], grants: [], passwordResetRequired: true as const }
    if (!u.hosts.includes(host)) u.hosts.push(host)
    if (!LOCAL_HOSTS.has(host)) remote.add(host)
    const existing = u.grants.find((x) => x.database === db)
    if (existing) existing.privileges = services.normalizePrivileges([...existing.privileges, ...privileges])
    else u.grants.push({ database: db, privileges })
    users.set(name, u)
  }
  if (remote.size) warn(s, 'remote-mysql-hosts', `remote MySQL access from ${[...remote].slice(0, 20).join(', ')} needs review`)
  return { users: [...users.values()], remote: [...remote] }
}

export const buildZones = (s: ReadState, own: ReadonlySet<string>, move: { from: string; to: string } | null): ImportZone[] => {
  const zones: ImportZone[] = []
  let moved = 0
  for (const [zone, text] of s.zones) {
    if (!own.has(zone)) { warn(s, 'zone-skipped', `zone ${zone.slice(0, 100)} is not a domain of this account`); continue }
    let parsed: services.ParsedZone
    try {
      parsed = services.parseBindZone(text, { origin: zone })
    } catch (e) {
      if (!isXpanelError(e)) throw e
      warn(s, 'zone-unreadable', `${zone}: ${errText(e)}`)
      continue
    }
    for (const k of parsed.skipped.slice(0, 50)) warn(s, 'dns-record-skipped', `${zone} line ${k.line} (${k.type.slice(0, 16)}): ${k.reason.slice(0, 200)}`)
    const records = parsed.records.filter((r) => r.type !== 'SOA').map((r) => {
      if (move && r.type === 'A' && r.content === move.from) {
        moved++
        return { ...r, content: move.to }
      }
      return r
    })
    zones.push({ zone, records, sourceNameservers: records.filter((r) => r.type === 'NS' && r.name === '@').map((r) => r.content.replace(/\.$/, '')) })
  }
  if (move && moved) warn(s, 'a-records-moved', `${moved} A record(s) moved from ${move.from} to ${move.to}`)
  return zones
}

export const buildMailboxes = (s: ReadState, own: ReadonlySet<string>): ImportMailbox[] => {
  const mailboxes: ImportMailbox[] = []
  for (const [domain, locals] of s.mailPasswd) {
    if (!own.has(domain)) { warn(s, 'mailbox-skipped', `mail domain ${domain.slice(0, 100)} is not a domain of this account`); continue }
    const q = s.mailQuota.get(domain)
    for (const local of locals) {
      const address = `${local}@${domain}`
      if (!isHostedAddress(address)) { warn(s, 'mailbox-skipped', `invalid mailbox ${address.slice(0, 100)}`); continue }
      mailboxes.push({ address, quotaMb: mbOf(q?.get(local) ?? 0), maildir: `mail/${domain}/${local}`, hasMaildir: s.maildirs.has(address), passwordResetRequired: true })
    }
  }
  for (const m of s.maildirs) if (!mailboxes.some((x) => x.address === m)) warn(s, 'maildir-orphan', `maildir for ${m.slice(0, 100)} has no mail account; its files were copied`)
  return mailboxes
}

const isLocal = passes(services.normalizeMailboxLocal)

/** va/<domain> into forwarders and default addresses. Pipes and file deliveries are never imported. */
export const buildMail = (s: ReadState, own: ReadonlySet<string>): DomainMail[] => {
  const out: DomainMail[] = []
  for (const [domain, text] of s.valiases) {
    if (!own.has(domain)) { warn(s, 'forwarder-skipped', `forwarders for ${domain.slice(0, 100)} are not on this account`); continue }
    const d: DomainMail = { domain, forwarders: [], defaultAddress: { kind: 'reject' } }
    for (const line of parseValiases(text)) {
      if (line.source === '*') {
        const dest = line.dests[0]
        if (dest?.kind === 'fail') d.defaultAddress = { kind: 'reject' }
        else if (dest?.kind === 'blackhole') d.defaultAddress = { kind: 'discard' }
        else if (dest?.kind === 'address') d.defaultAddress = { kind: 'forward', to: [dest.address] }
        else warn(s, 'default-address-skipped', `default address for ${domain} (${dest?.kind ?? 'empty'}) is not imported; unknown recipients are rejected`)
        continue
      }
      const at = line.source.lastIndexOf('@')
      const local = line.source.slice(0, at)
      if (at <= 0 || line.source.slice(at + 1) !== domain || !isLocal(local) || local !== local.toLowerCase()) {
        warn(s, 'forwarder-skipped', `invalid forwarder source ${line.source.slice(0, 100)}`)
        continue
      }
      const to: string[] = []
      for (const dest of line.dests) {
        if (dest.kind === 'address') { if (!to.includes(dest.address)) to.push(dest.address) }
        else if (dest.kind === 'pipe' || dest.kind === 'file') warn(s, 'forwarder-unsafe', `${line.source} delivers to a ${dest.kind}; not imported and never executed`)
        else warn(s, 'forwarder-skipped', `${line.source} -> ${dest.kind} is not imported`)
      }
      if (to.length > services.MAX_FORWARD_TARGETS) warn(s, 'forwarder-truncated', `${line.source} keeps its first ${services.MAX_FORWARD_TARGETS} destinations`)
      const existing = d.forwarders.find((f) => f.local === local)
      const targets = to.slice(0, services.MAX_FORWARD_TARGETS)
      if (existing) existing.to = [...new Set([...existing.to, ...targets])].slice(0, services.MAX_FORWARD_TARGETS)
      else if (targets.length) d.forwarders.push({ local, to: targets })
    }
    out.push(d)
  }
  for (const [domain, n] of s.vfilters) if (own.has(domain)) warn(s, 'filters-not-imported', `${n} Exim filter line(s) for ${domain} are not translated; recreate them as filters`)
  return out
}

/** A certificate worth importing and the private key that matches it (archive paths). */
export interface CertificateChoice {
  names: string[]
  notAfter: string
  certPath: string
  keyPath: string | null
}

const coveredBy = (domains: readonly ImportDomain[], name: string): boolean => {
  const bare = name.startsWith('*.') ? name.slice(2) : name
  return domains.some((d) => bare === d.name || bare.endsWith(`.${d.name}`))
}

/**
 * Certificates whose names all belong to the account and that are still valid, each with its
 * matching key. Only these are stored: keys of foreign, expired or unreadable certificates
 * never leave the archive.
 */
export const selectCertificates = (s: ReadState, domains: readonly ImportDomain[], now: Date): CertificateChoice[] => {
  const keys: { path: string; key: ReturnType<typeof createPrivateKey> }[] = []
  for (const [path, pem] of s.keys) {
    try { keys.push({ path, key: createPrivateKey(pem) }) } catch { warn(s, 'ssl-key-unreadable', `${path} is not a readable private key`) }
  }
  const out: CertificateChoice[] = []
  for (const [path, pem] of s.certs) {
    if (path.endsWith('.cabundle')) continue
    let x: X509Certificate
    try { x = new X509Certificate(pem) } catch { warn(s, 'ssl-cert-unreadable', `${path} is not a certificate`); continue }
    const san = (x.subjectAltName ?? '').split(',').map((p) => p.trim()).filter((p) => p.startsWith('DNS:')).map((p) => p.slice(4).toLowerCase())
    const cn = /(?:^|\n)CN=([^\n]+)/.exec(x.subject)?.[1]?.toLowerCase()
    const names = san.length ? san : cn ? [cn] : []
    if (!names.length || !names.every((n) => coveredBy(domains, n))) { warn(s, 'ssl-cert-foreign', `${path} covers names outside this account`); continue }
    const notAfter = new Date(x.validTo)
    if (Number.isNaN(notAfter.getTime()) || notAfter <= now) { warn(s, 'ssl-cert-expired', `${path} has expired`); continue }
    const match = keys.find((k) => { try { return x.checkPrivateKey(k.key) } catch { return false } })
    if (!match) warn(s, 'ssl-key-missing', `${path} has no matching private key; AutoSSL will issue a new certificate`)
    out.push({ names, notAfter: notAfter.toISOString(), certPath: path, keyPath: match?.path ?? null })
  }
  for (const k of keys) if (!out.some((c) => c.keyPath === k.path)) warn(s, 'ssl-key-unused', `${k.path} matches no imported certificate and was not copied`)
  return out
}
