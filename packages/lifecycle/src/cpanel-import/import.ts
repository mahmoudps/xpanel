import { posix } from 'node:path'
import { fail } from '@xpanel/core'
import { drain, hashing, readBody, walkTar } from '../archive/reader.ts'
import type { Body, ByteSource } from '../archive/reader.ts'
import { single } from '../archive/sink.ts'
import type { FileRef, ImportSink, SinkItem } from '../archive/sink.ts'
import type { GuardOptions, SafeEntry } from '../archive/guard.ts'
import { assertUsername, isDomain, isHostedAddress, isIpv4 } from '../validate.ts'
import { buildAccount, buildCron, buildDatabases, buildDbUsers, buildDomains, buildMail, buildMailboxes, buildZones, primaryDomainOf, selectCertificates } from './build.ts'
import type { CertificateChoice } from './build.ts'
import { parseCpUserFile, parseMailPasswd, parseMailQuota, parseUserdataDomain, parseUserdataMain } from './parsers.ts'
import { newReadState, warn, warnOnce } from './state.ts'
import type { ReadState } from './state.ts'
import type { ImportCertificate, ImportPlan } from './types.ts'

// Reads a cPanel full backup (cpmove-<user>.tar.gz or backup-<date>_<user>.tar.gz) by its
// publicly documented layout in one streaming pass and turns it into desired-state
// entities. Nothing from the archive is executed and no password material is retained.

export interface CpanelImportOptions {
  /** rename on import; defaults to the source username */
  targetUsername?: string
  /** this server's address for the account: A records pointing at the source IP move here */
  ipv4?: string
  /** content goes here; without a sink the import is a dry run that only validates and plans */
  sink?: ImportSink
  limits?: Partial<Pick<GuardOptions, 'maxEntries' | 'maxTotalBytes'>>
  /** reference time for certificate expiry */
  now?: Date
}

const TOP_CPMOVE = /^cpmove-([a-z][a-z0-9]{0,15})$/
const TOP_BACKUP = /^backup-\d{1,2}\.\d{1,2}\.\d{4}_\d{1,2}-\d{1,2}-\d{1,2}_([a-z][a-z0-9]{0,15})$/
const META_CAP = 4 * 1024 * 1024
const GRANTS_CAP = 32 * 1024 * 1024
const PEM_CAP = 256 * 1024

/** Top-level pkgacct items that carry nothing an xPanel account uses. */
const IGNORED_TOP = new Set([
  'logs', 'bandwidth', 'bandwidth_db', 'counters', 'meta', 'version', 'pds', 'interchange', 'fp', 'httpfiles',
  'apache_tls', 'ips', 'locale', 'resellerconfig', 'resellerfeatures', 'resellerpackages', 'nobodyfiles', 'mysql-timestamps',
  'sds', 'sds2', 'shell', 'ssldomain', 'suspended', 'suspendinfo', 'vad', 'customizations', 'team', 'authnlinks',
  'homedir_paths', 'pkgacct.version', 'cpuser', 'dnslink', 'has_sitejet', 'mailman', 'webcalls', 'ftp_shell', 'cpbandwidth',
])

const detectTop = (path: string): { top: string; user: string; format: ImportPlan['format'] } => {
  const top = path.split('/')[0] ?? ''
  const c = TOP_CPMOVE.exec(top)
  if (c) return { top, user: c[1] as string, format: 'cpmove' }
  const b = TOP_BACKUP.exec(top)
  if (b) return { top, user: b[1] as string, format: 'backup' }
  return fail('VALIDATION', `not a cPanel account backup: unexpected top directory ${top.slice(0, 80)}`)
}

const textOf = async (body: Body, cap: number, s: ReadState, path: string): Promise<string | null> => {
  const b = await readBody(body, cap)
  if (!b) {
    warn(s, 'file-too-large', `${path} exceeds ${cap} bytes and was ignored`, path)
    return null
  }
  return b.toString('utf8')
}

const store = async (sink: ImportSink | undefined, item: SinkItem, body: Body): Promise<{ ref: string | null; sha256: string; size: number }> => {
  const h = hashing(body)
  const ref = sink ? await sink.put(item, h.body) : null
  return { ref, ...(await h.finish()) }
}

/** homedir content that never reaches the new home: cPanel internals and credentials. */
const homeExclusion = (rel: string): { code: string; message: string } | null => {
  if (/^etc\/[^/]+\/(?:passwd|shadow|quota|@pwcache(?:\/.*)?|_privs\.json)$/.test(rel)) return { code: 'mail-auth-file', message: 'cPanel mail auth files are rebuilt, not copied' }
  if (rel === '.my.cnf') return { code: 'credentials-file-skipped', message: '~/.my.cnf holds the old MySQL password and was not copied' }
  if (rel === '.cpanel' || rel.startsWith('.cpanel/')) return { code: 'cpanel-internal', message: 'cPanel internal data is not imported' }
  return null
}

/** mail/<domain>/<local>/... is a mailbox store; mail/cur|new|tmp is cPanel's default account inbox. */
const noteMailStore = (s: ReadState, homeRel: string, path: string): void => {
  const md = /^mail\/([^/]+)\/([^/]+)(?:\/|$)/.exec(homeRel)
  if (!md) return
  if (['cur', 'new', 'tmp'].includes(md[1] as string)) {
    warnOnce(s, 'main-inbox', 'main-inbox-not-imported', 'the cPanel default account inbox (~/mail/cur, new, tmp) was copied but no mailbox serves it; create one and move the messages if they are needed', path)
    return
  }
  const address = `${(md[2] as string).toLowerCase()}@${(md[1] as string).toLowerCase()}`
  if (isHostedAddress(address)) s.maildirs.add(address)
}

const onHome = async (s: ReadState, e: SafeEntry, rel: string, body: Body, sink: ImportSink | undefined): Promise<void> => {
  const homeRel = rel === 'homedir' ? '' : rel.slice('homedir/'.length)
  if (homeRel === '') return
  const auth = /^etc\/([^/]+)\/(passwd|quota)$/.exec(homeRel)
  if (auth && e.type === 'file') {
    s.unstored.add(homeRel)
    const domain = (auth[1] as string).toLowerCase()
    const t = await textOf(body, META_CAP, s, e.path)
    if (t === null) return
    if (auth[2] === 'passwd') {
      const p = parseMailPasswd(t)
      s.mailPasswd.set(domain, p.locals)
      for (const r of p.rejected.slice(0, 20)) warn(s, 'mailbox-skipped', `mailbox ${r}@${domain.slice(0, 100)} has a name xPanel does not allow`)
    } else s.mailQuota.set(domain, parseMailQuota(t))
    return
  }
  const ex = homeExclusion(homeRel)
  if (ex) {
    s.unstored.add(homeRel)
    if (homeRel === '.my.cnf' || homeRel === '.cpanel') warn(s, ex.code, ex.message, e.path)
    return
  }
  const prefix = `${s.top}/homedir/`
  const linked = e.type === 'hardlink' && e.linkTarget?.startsWith(prefix) ? e.linkTarget.slice(prefix.length) : null
  if (e.type === 'hardlink' && (linked === null || s.unstored.has(linked))) {
    // the target was excluded (credentials, cPanel internals) or skipped: linking to it would recreate it
    s.unstored.add(homeRel)
    s.home.skipped++
    warn(s, 'hardlink-skipped', 'hardlink to content that is not imported', e.path)
    return
  }
  noteMailStore(s, homeRel, e.path)
  if (e.type === 'directory') s.home.directories++
  else if (e.type === 'symlink') s.home.symlinks++
  else s.home.files++
  s.home.bytes += e.size
  if (sink) await sink.put({ part: 'home', path: homeRel, type: e.type, mode: e.mode & 0o777, size: e.size, mtime: e.mtime, linkTarget: linked ?? e.linkTarget }, body)
}

const onMetaFile = async (s: ReadState, e: SafeEntry, rel: string, body: Body, sink: ImportSink | undefined): Promise<void> => {
  const seg = rel.split('/')
  const dir = seg[0] as string
  const name = seg[1] ?? ''
  if (rel === 'mysql.sql') { s.grants = await textOf(body, GRANTS_CAP, s, e.path); return }
  if (dir === 'mysql' && seg.length === 2) {
    if (!name.endsWith('.sql')) return
    const db = name.slice(0, -4)
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(db)) { warn(s, 'database-skipped', `database dump ${name.slice(0, 80)} has an unsupported name`, e.path); return }
    const r = await store(sink, { part: 'sql', path: name, type: 'file', mode: 0o600, size: e.size, mtime: e.mtime, linkTarget: null }, body)
    s.sql.set(db, { archivePath: e.path, size: r.size, sha256: r.sha256, ref: r.ref })
    return
  }
  if (dir === 'dnszones' && seg.length === 2 && name.endsWith('.db')) {
    const t = await textOf(body, META_CAP, s, e.path)
    if (t !== null) s.zones.set(name.slice(0, -3).toLowerCase(), t)
    return
  }
  if (dir === 'userdata' && seg.length === 2) {
    const n = name.toLowerCase()
    const isDomainFile = isDomain(n) || (n.startsWith('_wildcard_.') && isDomain(n.slice(11)))
    if (name !== 'main' && !isDomainFile) return
    const t = await textOf(body, META_CAP, s, e.path)
    if (t === null) return
    try {
      if (name === 'main') s.main = parseUserdataMain(t)
      else s.userdata.set(n, parseUserdataDomain(t))
    } catch (err) {
      warn(s, 'userdata-unreadable', `${name}: ${err instanceof Error ? err.message.slice(0, 200) : 'parse error'}`, e.path)
    }
    return
  }
  if (dir === 'cp' && seg.length === 2) {
    if (name !== s.sourceUser) { warn(s, 'cp-file-ignored', `cp/${name.slice(0, 32)} does not match the account`, e.path); return }
    const t = await textOf(body, META_CAP, s, e.path)
    if (t !== null) s.cp = parseCpUserFile(t)
    return
  }
  if ((dir === 'va' || dir === 'vf') && seg.length === 2) {
    const t = await textOf(body, META_CAP, s, e.path)
    if (t === null) return
    if (dir === 'va') s.valiases.set(name.toLowerCase(), t)
    else {
      const rules = t.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).length
      if (rules) s.vfilters.set(name.toLowerCase(), rules)
    }
    return
  }
  if ((dir === 'sslcerts' || dir === 'sslkeys') && seg.length === 2) {
    const b = await readBody(body, PEM_CAP)
    if (!b) { warn(s, 'file-too-large', `${rel} is too large for a PEM file`, e.path); return }
    ;(dir === 'sslcerts' ? s.certs : s.keys).set(rel, b)
    return
  }
  if (rel === 'quota') { s.quota = await textOf(body, 4096, s, e.path); return }
  if (rel === 'shadow') { await drain(body); warn(s, 'password-not-kept', 'the account password is not imported; a reset is required'); return }
  if (dir === 'cron' && seg.length === 2 && name === s.sourceUser) { s.cron = await textOf(body, META_CAP, s, e.path); return }
  if (dir === 'cron') { warnOnce(s, 'cron', 'cron-not-imported', `${rel.slice(0, 80)} does not belong to the account and was not imported`, e.path); return }
  if (dir === 'mm' && seg.length >= 2) { warnOnce(s, `mm:${seg[1]}`, 'mailing-list-skipped', `mailing list ${(seg[1] ?? '').slice(0, 64)} is not imported; recreate it`, `mm/${seg[1]}`); return }
  if (dir === 'mma' || dir === 'mms') return
  if (rel === 'homedir.tar') { warn(s, 'split-home-unsupported', 'homedir.tar archives are not supported; export with an inline homedir', e.path); return }
  if (rel === 'proftpdpasswd' || dir === 'ftp') { warnOnce(s, 'ftp', 'ftp-accounts-not-imported', 'FTP accounts are not imported; recreate them', e.path); return }
  if (dir === 'domainkeys') { warnOnce(s, 'dkim', 'dkim-keys-not-imported', 'DKIM keys are regenerated; publish the new DKIM TXT records'); return }
  if (IGNORED_TOP.has(dir)) return
  warnOnce(s, `top:${dir}`, 'unsupported-item', `${dir.slice(0, 80)} is not imported`, e.path)
}

const visitor = (s: ReadState, sink: ImportSink | undefined, targetUsername: string | undefined) => async (e: SafeEntry, body: Body): Promise<void> => {
  if (s.top === null) {
    const t = detectTop(e.path)
    // a source name that is reserved here (admin, test...) needs a target name: fail before streaming the home
    s.target = assertUsername(targetUsername ?? t.user, 'target username')
    s.top = t.top
    s.sourceUser = t.user
    s.format = t.format
  }
  const top = s.top
  if (e.path !== top && !e.path.startsWith(`${top}/`)) fail('VALIDATION', `archive entry ${e.path.slice(0, 200)} is outside ${top}/`)
  const rel = e.path === top ? '' : e.path.slice(top.length + 1)
  if (rel === '') return
  if (rel === 'homedir' || rel.startsWith('homedir/')) return onHome(s, e, rel, body, sink)
  if (rel === 'psql' || rel.startsWith('psql/')) { warnOnce(s, 'psql', 'postgresql-unsupported', 'PostgreSQL databases are not supported', e.path); return }
  if (e.type === 'directory') return
  if (e.type !== 'file') { warn(s, 'link-ignored', 'links outside homedir are ignored', e.path); return }
  return onMetaFile(s, e, rel, body, sink)
}

/** Stores the chosen certificates and their keys (each key once, even when shared). */
const storeCertificates = async (s: ReadState, chosen: readonly CertificateChoice[], sink: ImportSink | undefined): Promise<ImportCertificate[]> => {
  const refs = new Map<string, FileRef>()
  const stored = async (path: string, part: 'ssl-cert' | 'ssl-key', pem: Buffer): Promise<FileRef> => {
    const known = refs.get(path)
    if (known) return known
    const r = await store(sink, { part, path: posix.basename(path), type: 'file', mode: 0o600, size: pem.length, mtime: null, linkTarget: null }, single(pem))
    const ref = { archivePath: `${s.top}/${path}`, size: r.size, sha256: r.sha256, ref: r.ref }
    refs.set(path, ref)
    return ref
  }
  const out: ImportCertificate[] = []
  for (const c of chosen) {
    const cert = await stored(c.certPath, 'ssl-cert', s.certs.get(c.certPath) as Buffer)
    const key = c.keyPath === null ? null : await stored(c.keyPath, 'ssl-key', s.keys.get(c.keyPath) as Buffer)
    out.push({ names: c.names, notAfter: c.notAfter, cert, key })
  }
  return out
}

const finalize = async (s: ReadState, opts: CpanelImportOptions): Promise<ImportPlan> => {
  if (!s.top || !s.sourceUser || !s.format || !s.target) return fail('VALIDATION', 'archive is empty')
  const sourceUser = s.sourceUser
  const target = s.target
  if (!s.cp) warn(s, 'cp-file-missing', `cp/${sourceUser} is missing; plan limits and contact data are unknown`)
  const cpUser = s.cp?.get('USER')
  if (cpUser !== undefined && cpUser !== sourceUser) warn(s, 'cp-user-mismatch', `cp file names user ${cpUser.slice(0, 32)}`)
  const primary = primaryDomainOf(s)
  const account = buildAccount(s, target, primary)
  const domains = buildDomains(s, sourceUser, target, primary)
  const own = new Set(domains.map((d) => d.name))
  const { databases, map } = buildDatabases(s, sourceUser, target)
  const { users: dbUsers, remote } = buildDbUsers(s, sourceUser, target, map)
  if (databases.length || dbUsers.length) warn(s, 'password-not-kept', 'database user passwords are not imported; set new ones')
  const move = opts.ipv4 !== undefined && account.sourceIp !== null && account.sourceIp !== opts.ipv4 ? { from: account.sourceIp, to: opts.ipv4 } : null
  const dnsZones = buildZones(s, own, move)
  const mailboxes = buildMailboxes(s, own)
  if (mailboxes.length) warn(s, 'password-not-kept', 'mailbox passwords are not imported; set new ones')
  const mail = buildMail(s, own)
  const certificates = await storeCertificates(s, selectCertificates(s, domains, opts.now ?? new Date()), opts.sink)
  const cronJobs = buildCron(s, sourceUser, target)
  if (s.warningCount > s.warnings.length) s.warnings.push({ code: 'warnings-truncated', message: `${s.warningCount - s.warnings.length} more warnings` })
  return {
    format: s.format,
    topDir: s.top,
    sourceUsername: sourceUser,
    account,
    domains,
    databases,
    dbUsers,
    remoteDbHosts: remote,
    dnsZones,
    mailboxes,
    mail,
    certificates,
    cronJobs,
    home: s.home,
    warnings: s.warnings,
  }
}

/**
 * Streams a cPanel account archive once. Unsafe entries (traversal, absolute names, writes
 * through links, hardlinks out of homedir) reject the whole archive; symlinks leaving the
 * home and device nodes are skipped and reported.
 */
export const readCpanelArchive = async (source: ByteSource, opts: CpanelImportOptions = {}): Promise<ImportPlan> => {
  if (opts.targetUsername !== undefined) assertUsername(opts.targetUsername, 'target username')
  if (opts.ipv4 !== undefined && !isIpv4(opts.ipv4)) fail('VALIDATION', 'invalid IPv4 address for the account')
  const s = newReadState()
  const linkScope = (p: string): string | null => {
    const top = p.split('/')[0] ?? ''
    return p.startsWith(`${top}/homedir/`) ? `${top}/homedir` : null
  }
  try {
    // a skipped homedir entry is remembered, so a later hardlink cannot bring it back
    const onSkip = (sk: { path: string }): void => {
      const prefix = `${s.top ?? sk.path.split('/')[0]}/homedir/`
      if (sk.path.startsWith(prefix)) s.unstored.add(sk.path.slice(prefix.length))
    }
    const summary = await walkTar(source, visitor(s, opts.sink, opts.targetUsername), { ...(opts.limits ?? {}), linkScope, onSkip })
    for (const sk of summary.skipped) {
      if (sk.path.includes('/homedir/')) s.home.skipped++
      warn(s, sk.code, sk.reason, sk.path)
    }
    if (summary.skippedTotal > summary.skipped.length) s.home.skipped += summary.skippedTotal - summary.skipped.length
    return await finalize(s, opts)
  } catch (e) {
    await opts.sink?.abort?.(e instanceof Error ? e : new Error(String(e)))
    throw e
  }
}
