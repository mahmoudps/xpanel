import { createHash } from 'node:crypto'
import { Readable, pipeline } from 'node:stream'
import { createGzip } from 'node:zlib'
import { pack as tarPack } from 'tar-stream'
import { MAX_ACCOUNT_UID, MIN_ACCOUNT_UID, fail, isXpanelError, sliceUnit, validateDocRoot } from '@xpanel/core'
import type { Account, Database, DatabaseUser, DnsRecord, DnsRecordType, Domain, PhpSettings, ServiceUser } from '@xpanel/core'
import { isPhpVersion } from '@xpanel/os'
import { services } from '@xpanel/render'
import { ArchiveGuard } from '../archive/guard.ts'
import { normalizeEntryName } from '../archive/paths.ts'
import { hashing, readBody, walkTar } from '../archive/reader.ts'
import type { Body, ByteSource } from '../archive/reader.ts'
import type { GuardOptions, SafeEntry } from '../archive/guard.ts'
import type { FileRef, ImportSink } from '../archive/sink.ts'
import { mailConfigFor } from '../backup/mail-config.ts'
import type { MailConfig } from '../backup/mail-config.ts'
import { assertDatabaseName, assertDbUserName, assertDomain, assertUsername, domainOf, isId, isIpv4, isIsoDate, isSha256 } from '../validate.ts'
import { parseAccountManifest } from './manifest.ts'
import type { AccountArchiveManifest } from './manifest.ts'
import { checkLocalInventory, localDomainConflicts } from './session.ts'
import type { LocalInventory } from './session.ts'

// xPanel's own account archive (tar.gz): manifest.json first, then dns/<zone>.json,
// mysql/<db>.sql, home/ (the home without ~/mail), mail/<domain>/<local>/ (maildirs) and
// checksums.json last. Import verifies every digest and rebuilds a NEW uid, slice and
// domains (hence vhosts) as desired state.

const MANIFEST = 'manifest.json'
const CHECKSUMS = 'checksums.json'
const MAX_JSON = 8 * 1024 * 1024
const MAX_CHECKSUMS_JSON = 256 * 1024 * 1024
const ZONE_RECORD_TYPES: readonly DnsRecordType[] = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA']

export interface ExportEntry {
  /** relative to the part root (home dir or mail root) */
  path: string
  type: 'file' | 'directory' | 'symlink'
  mode?: number
  mtime?: Date
  linkTarget?: string
  /** required for streamed content */
  size?: number
  content?: Buffer | (() => AsyncIterable<Uint8Array>)
}

type Entries = Iterable<ExportEntry> | AsyncIterable<ExportEntry>

export interface AccountExportSource {
  manifest: AccountArchiveManifest
  /** desired-state records per manifest zone (no SOA: the importing server writes its own) */
  zones: Record<string, services.RecordInput[]>
  dumps: Record<string, Buffer | { size: number; open: () => AsyncIterable<Uint8Array> }>
  home: Entries
  /** maildirs as <domain>/<local>/... */
  mail?: Entries
}

export interface ChecksumEntry {
  path: string
  size: number
  sha256: string
}

export interface ExportSummary {
  manifest: AccountArchiveManifest
  checksums: ChecksumEntry[]
  skipped: { path: string; reason: string }[]
}

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

/** Validated, SOA-free records of one zone in desired-state form. */
const zoneRecords = (zone: string, records: unknown): services.ZoneRecord[] => {
  if (!Array.isArray(records) || records.length > 10_000) return fail('VALIDATION', `zone ${zone} must be a list of at most 10000 records`)
  const out = records.length ? services.validateZone(records as services.RecordInput[], { requireSoa: false }) : []
  for (const r of out) {
    if (r.zone !== zone) fail('VALIDATION', `record for ${r.zone} in zone ${zone}`)
    if (!ZONE_RECORD_TYPES.includes(r.type as DnsRecordType)) fail('VALIDATION', `zone ${zone} carries a ${r.type} record; the importing server writes its own`)
  }
  return out
}

/** Streams the archive as tar.gz; `done` settles once every entry has been written. */
export const exportAccountArchive = (src: AccountExportSource): { stream: Readable; done: Promise<ExportSummary> } => {
  const manifest = parseAccountManifest(src.manifest)
  const p = tarPack()
  const stream = createGzip()
  // a failure is reported through `done` and by destroying `stream`; the pack's own error
  // event must not escape as an uncaught exception
  p.on('error', () => undefined)
  pipeline(Readable.from(p as unknown as AsyncIterable<Buffer>, { objectMode: false }), stream, () => undefined)
  const checksums: ChecksumEntry[] = []
  const skipped: { path: string; reason: string }[] = []
  const mtime = new Date(manifest.createdAt)
  const domains = new Set(manifest.domains.map((d) => d.name))

  const add = (header: { name: string; type: 'file' | 'directory' | 'symlink'; mode: number; mtime?: Date; linkname?: string }, buf?: Buffer): Promise<void> =>
    new Promise((resolve, reject) => {
      const cb = (e?: Error | null): void => (e ? reject(e) : resolve())
      const h = { ...header, mtime: header.mtime ?? mtime }
      if (header.type === 'file') p.entry(h, buf ?? Buffer.alloc(0), cb)
      else p.entry(h, cb)
    })

  const addFile = async (name: string, content: Buffer, mode = 0o600, at?: Date): Promise<void> => {
    await add({ name, type: 'file', mode, ...(at ? { mtime: at } : {}) }, content)
    checksums.push({ path: name, size: content.length, sha256: sha(content) })
  }

  const addStream = async (name: string, size: number, open: () => AsyncIterable<Uint8Array>, mode: number, at?: Date): Promise<void> => {
    if (!Number.isSafeInteger(size) || size < 0) fail('VALIDATION', `a size is required for ${name}`)
    const h = createHash('sha256')
    await new Promise<void>((resolve, reject) => {
      const sink = p.entry({ name, type: 'file', mode, size, mtime: at ?? mtime }, (e) => (e ? reject(e) : resolve()))
      // destroying the entry reports through the callback above; its error event is not a second failure
      sink.on('error', () => undefined)
      void (async () => {
        let n = 0
        try {
          for await (const chunk of open()) {
            n += chunk.length
            if (n > size) throw new Error(`${name} is larger than its declared ${size} bytes`)
            h.update(chunk)
            if (!sink.write(Buffer.from(chunk))) await new Promise<void>((r) => sink.once('drain', () => r()))
          }
          if (n !== size) throw new Error(`${name} is ${n} bytes, declared ${size}`)
          sink.end(undefined)
        } catch (e) {
          sink.destroy(e as Error)
          reject(e)
        }
      })()
    })
    checksums.push({ path: name, size, sha256: h.digest('hex') })
  }

  // the importer's own guard runs here first: what it would skip or refuse is left out, so
  // every exported archive imports (a symlink chain is skipped here instead of failing there)
  const guard = new ArchiveGuard({ linkScope: partOf, maxEntries: Number.MAX_SAFE_INTEGER, maxTotalBytes: Number.MAX_SAFE_INTEGER })
  const refusal = (name: string, e: ExportEntry): string | null => {
    try {
      const d = guard.check({ name, type: e.type, size: 0, linkname: e.linkTarget ?? null })
      return d.action === 'accept' ? null : d.skipped.reason
    } catch (err) {
      if (isXpanelError(err)) return err.message
      throw err
    }
  }

  const addTree = async (part: 'home' | 'mail', entries: Entries): Promise<void> => {
    for await (const e of entries) {
      const n = normalizeEntryName(e.path)
      if (!n.ok || n.path !== e.path || n.path === '' || n.control) { skipped.push({ path: String(e.path).slice(0, 300), reason: 'unsafe name' }); continue }
      const name = `${part}/${n.path}`
      if (part === 'home' && (n.path === 'mail' || n.path.startsWith('mail/'))) { skipped.push({ path: name, reason: 'mail is exported in mail/' }); continue }
      if (part === 'mail' && !domains.has(n.path.split('/')[0] as string)) { skipped.push({ path: name, reason: 'mail for a domain outside the account' }); continue }
      const refused = refusal(name, e)
      if (refused !== null) { skipped.push({ path: name, reason: refused }); continue }
      const mode = (e.mode ?? (e.type === 'directory' ? 0o750 : 0o640)) & 0o777
      const at = e.mtime
      if (e.type === 'directory') { await add({ name, type: 'directory', mode, ...(at ? { mtime: at } : {}) }); continue }
      if (e.type === 'symlink') {
        const target = e.linkTarget as string
        await add({ name, type: 'symlink', mode: 0o777, linkname: target, ...(at ? { mtime: at } : {}) })
        checksums.push({ path: name, size: 0, sha256: sha(target) })
        continue
      }
      if (e.content === undefined || Buffer.isBuffer(e.content)) await addFile(name, e.content ?? Buffer.alloc(0), mode, at)
      else await addStream(name, e.size ?? -1, e.content, mode, at)
    }
  }

  const done = (async (): Promise<ExportSummary> => {
    await addFile(MANIFEST, Buffer.from(JSON.stringify(manifest)))
    for (const z of manifest.zones) await addFile(`dns/${z}.json`, Buffer.from(JSON.stringify(zoneRecords(z, src.zones[z]))))
    for (const db of manifest.databases) {
      const d = src.dumps[db]
      if (d === undefined) return fail('VALIDATION', `database ${db} has no dump`)
      if (Buffer.isBuffer(d)) await addFile(`mysql/${db}.sql`, d)
      else await addStream(`mysql/${db}.sql`, d.size, d.open, 0o600)
    }
    await addTree('home', src.home)
    if (src.mail) await addTree('mail', src.mail)
    const sums = [...checksums]
    await add({ name: CHECKSUMS, type: 'file', mode: 0o600 }, Buffer.from(JSON.stringify({ files: sums })))
    p.finalize()
    return { manifest, checksums: sums, skipped }
  })()
  done.catch((e: unknown) => {
    const err = e instanceof Error ? e : new Error(String(e))
    p.destroy(err)
    stream.destroy(err)
  })
  return { stream, done }
}

export interface AccountImportOptions {
  local: LocalInventory
  planId: string
  ownerId: string | null
  /** this server's address for the account; A records that pointed at the source move here */
  ipv4: string
  now: string
  ids: () => string
  /** PHP settings new domains start from; the archived version is kept when this server ships it */
  defaultPhp: PhpSettings
  targetUsername?: string
  dropDomains?: string[]
  homeRoot?: string
  uidRange?: { min: number; max: number }
  sink?: ImportSink
  limits?: Partial<Pick<GuardOptions, 'maxEntries' | 'maxTotalBytes'>>
}

export interface ImportedDbUser extends DatabaseUser {
  hosts: string[]
  passwordResetRequired: true
}

export interface ImportedAccount {
  account: Account
  slice: string
  domains: Domain[]
  databases: Database[]
  dbUsers: ImportedDbUser[]
  dnsRecords: DnsRecord[]
  serviceUsers: (ServiceUser & { passwordResetRequired: true })[]
  mail: MailConfig
  sql: { database: string; file: FileRef }[]
  files: { home: number; mail: number; bytes: number }
  warnings: string[]
}

/** Lowest free uid in range; uids of the source server are never reused blindly. */
export const allocateUid = (used: Iterable<number>, range = { min: MIN_ACCOUNT_UID, max: MAX_ACCOUNT_UID }): number => {
  const ok = Number.isSafeInteger(range.min) && Number.isSafeInteger(range.max) && range.min >= MIN_ACCOUNT_UID && range.max <= MAX_ACCOUNT_UID && range.min <= range.max
  if (!ok) fail('VALIDATION', `uid range must lie within ${MIN_ACCOUNT_UID}..${MAX_ACCOUNT_UID}`)
  const taken = new Set(used)
  for (let u = range.min; u <= range.max; u++) if (!taken.has(u)) return u
  return fail('LIMIT_EXCEEDED', `no free uid in ${range.min}..${range.max}`)
}

const parseJson = (raw: Buffer | null, what: string): unknown => {
  if (raw === null) return fail('VALIDATION', `${what} is too large`)
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    return fail('VALIDATION', `${what} is not JSON`)
  }
}

const parseChecksums = (json: unknown): ChecksumEntry[] => {
  const list = (json as { files?: unknown })?.files
  if (!Array.isArray(list)) return fail('VALIDATION', 'checksums.json is malformed')
  return list.map((c: Record<string, unknown>) => (typeof c?.path === 'string' && isSha256(c.sha256) && Number.isSafeInteger(c.size) && (c.size as number) >= 0
    ? { path: c.path, sha256: c.sha256 as string, size: c.size as number }
    : fail('VALIDATION', 'checksums.json is malformed')))
}

const partOf = (path: string): 'home' | 'mail' | null =>
  path.startsWith('home/') ? 'home' : path.startsWith('mail/') ? 'mail' : null

interface ImportState {
  manifest: AccountArchiveManifest | null
  /** the account name the import creates */
  username: string
  /** domains left out of the import (requested, plus their subdomains and aliases) */
  dropped: Set<string>
  warnings: string[]
  checksums: ChecksumEntry[] | null
  digests: Map<string, { sha256: string; size: number }>
  zones: Map<string, services.ZoneRecord[]>
  sql: { db: string; file: FileRef }[]
  files: ImportedAccount['files']
}

const visitor = (st: ImportState, opts: AccountImportOptions) => async (e: SafeEntry, body: Body): Promise<void> => {
  const sink = opts.sink
  if (st.checksums !== null) fail('VALIDATION', `${e.path} follows checksums.json`)
  if (st.manifest === null) {
    if (e.path !== MANIFEST || e.type !== 'file') fail('VALIDATION', 'manifest.json must be the first member')
    const h = hashing(body)
    const raw = await readBody(h.body, MAX_JSON)
    st.digests.set(MANIFEST, await h.finish())
    st.manifest = parseAccountManifest(parseJson(raw, 'manifest.json'))
    claimIdentity(st, st.manifest, opts)
    return
  }
  const m = st.manifest
  if (e.type === 'hardlink') fail('VALIDATION', `${e.path}: xPanel account archives never contain hardlinks`)
  if (e.type === 'directory') {
    if (['home', 'mail', 'dns', 'mysql'].includes(e.path)) return
    const part = partOf(e.path)
    if (!part) return fail('VALIDATION', `unexpected directory ${e.path.slice(0, 200)}`)
    const dropped = part === 'mail' && st.dropped.has(e.path.split('/')[1] as string)
    if (sink && !dropped) await sink.put({ part, path: e.path.slice(5), type: 'directory', mode: e.mode & 0o777, size: 0, mtime: e.mtime, linkTarget: null }, body)
    return
  }
  if (e.path === CHECKSUMS) {
    if (e.type !== 'file') fail('VALIDATION', 'checksums.json must be a file')
    st.checksums = parseChecksums(parseJson(await readBody(body, MAX_CHECKSUMS_JSON), 'checksums.json'))
    return
  }
  const dns = /^dns\/([a-z0-9.-]+)\.json$/.exec(e.path)
  if (dns) {
    const zone = dns[1] as string
    if (!m.zones.includes(zone) || e.type !== 'file' || st.zones.has(zone)) fail('VALIDATION', `unexpected zone file ${e.path}`)
    const h = hashing(body)
    const raw = await readBody(h.body, MAX_JSON)
    st.digests.set(e.path, await h.finish())
    st.zones.set(zone, zoneRecords(zone, parseJson(raw, e.path)))
    return
  }
  const sqlFile = /^mysql\/([a-z0-9_]+)\.sql$/.exec(e.path)
  if (sqlFile) {
    const db = sqlFile[1] as string
    if (!m.databases.includes(db) || e.type !== 'file' || st.sql.some((s) => s.db === db)) fail('VALIDATION', `unexpected dump ${e.path}`)
    const h = hashing(body)
    const ref = sink ? await sink.put({ part: 'sql', path: `${db}.sql`, type: 'file', mode: 0o600, size: e.size, mtime: e.mtime, linkTarget: null }, h.body) : null
    const d = await h.finish()
    st.digests.set(e.path, d)
    st.sql.push({ db, file: { archivePath: e.path, size: d.size, sha256: d.sha256, ref } })
    return
  }
  const part = partOf(e.path)
  if (!part) return fail('VALIDATION', `unexpected member ${e.path.slice(0, 200)}`)
  const mailDomain = part === 'mail' ? (e.path.split('/')[1] as string) : null
  if (mailDomain !== null && !m.domains.some((d) => d.name === mailDomain)) fail('VALIDATION', `mail for a domain outside the archive: ${e.path.slice(0, 200)}`)
  if (part === 'home' && (e.path === 'home/mail' || e.path.startsWith('home/mail/'))) fail('VALIDATION', 'mail must be archived under mail/, not home/mail')
  // mail of a dropped domain is verified like everything else but never stored
  const keep = mailDomain === null || !st.dropped.has(mailDomain)
  const h = hashing(body)
  if (sink && keep) await sink.put({ part, path: e.path.slice(5), type: e.type, mode: e.mode & 0o777, size: e.size, mtime: e.mtime, linkTarget: e.linkTarget }, h.body)
  const d = await h.finish()
  st.digests.set(e.path, e.type === 'symlink' ? { sha256: sha(e.linkTarget ?? ''), size: 0 } : d)
  if (!keep) return
  st.files[part]++
  st.files.bytes += d.size
}

const verifyIntegrity = (st: ImportState): AccountArchiveManifest => {
  if (!st.manifest) return fail('VALIDATION', 'archive has no manifest')
  if (!st.checksums) return fail('VALIDATION', 'archive has no checksums.json; it may be truncated')
  const listed = new Map(st.checksums.map((c) => [c.path, c]))
  const problems: string[] = []
  for (const [path, d] of st.digests) {
    const c = listed.get(path)
    if (!c) problems.push(`${path} is not listed`)
    else if (c.sha256 !== d.sha256 || c.size !== d.size) problems.push(`${path} does not match its checksum`)
  }
  for (const path of listed.keys()) if (!st.digests.has(path)) problems.push(`${path} is missing`)
  if (problems.length) fail('VALIDATION', `archive integrity check failed: ${problems.slice(0, 10).join('; ')}`, { problems: problems.slice(0, 100) })
  for (const z of st.manifest.zones) if (!st.zones.has(z)) fail('VALIDATION', `zone ${z} is missing`)
  for (const d of st.manifest.databases) if (!st.sql.some((s) => s.db === d)) fail('VALIDATION', `dump for ${d} is missing`)
  return st.manifest
}

const checkImportOptions = (opts: AccountImportOptions): void => {
  if (!/^\/home\d*$/.test(opts.homeRoot ?? '/home')) fail('VALIDATION', 'homeRoot must be /home or /homeN')
  if (!isIpv4(opts.ipv4)) fail('VALIDATION', 'invalid IPv4 address for the account')
  if (!isId(opts.planId) || (opts.ownerId !== null && !isId(opts.ownerId))) fail('VALIDATION', 'invalid plan or owner id')
  if (!isIsoDate(opts.now)) fail('VALIDATION', 'now must be an ISO timestamp')
  if (opts.targetUsername !== undefined) assertUsername(opts.targetUsername, 'target username')
  checkLocalInventory(opts.local)
  if (!isPhpVersion(opts.defaultPhp?.version)) fail('VALIDATION', 'the default PHP version is not installed here')
}

/**
 * Imports an account archive into NEW desired state: new uid/gid, home and slice, domains
 * the reconciler renders into fresh vhosts, renamed database prefixes, A records moved to
 * this server and every password reset. Content streams to `opts.sink`; nothing executes.
 */
export const importAccountArchive = async (source: ByteSource, opts: AccountImportOptions): Promise<ImportedAccount> => {
  checkImportOptions(opts)
  const st: ImportState = { manifest: null, username: '', dropped: new Set(), warnings: [], checksums: null, digests: new Map(), zones: new Map(), sql: [], files: { home: 0, mail: 0, bytes: 0 } }
  try {
    await walkTar(source, visitor(st, opts), { ...(opts.limits ?? {}), linkScope: partOf })
    return build(verifyIntegrity(st), st, opts)
  } catch (e) {
    await opts.sink?.abort?.(e instanceof Error ? e : new Error(String(e)))
    throw e
  }
}

const droppedDomains = (m: AccountArchiveManifest, requested: readonly string[], warnings: string[]): Set<string> => {
  const dropped = new Set(requested.map((d) => assertDomain(d, 'dropped domain')))
  if (dropped.has(m.account.primaryDomain)) fail('VALIDATION', 'the primary domain cannot be dropped')
  for (const d of dropped) if (!m.domains.some((x) => x.name === d)) fail('VALIDATION', `cannot drop ${d}: not in the archive`)
  for (let changed = true; changed;) {
    changed = false
    for (const d of m.domains) {
      if (d.parent && dropped.has(d.parent) && !dropped.has(d.name)) {
        dropped.add(d.name)
        warnings.push(`${d.name} dropped with its parent ${d.parent}`)
        changed = true
      }
    }
  }
  return dropped
}

/**
 * Name and domain checks that need only the manifest run as soon as it is read, so a
 * conflicting import fails before any content reaches the sink.
 */
const claimIdentity = (st: ImportState, m: AccountArchiveManifest, opts: AccountImportOptions): void => {
  st.username = assertUsername(opts.targetUsername ?? m.account.username, 'account name')
  if (opts.local.usernames.includes(st.username)) fail('CONFLICT', `account ${st.username} already exists`)
  st.dropped = droppedDomains(m, opts.dropDomains ?? [], st.warnings)
  const kept = m.domains.filter((d) => !st.dropped.has(d.name)).map((d) => d.name)
  // the transfer review's rule: exact names, www twins and names above or below a local domain
  const clash = localDomainConflicts(kept, opts.local.domains)
  if (clash.length) fail('CONFLICT', `domains conflict with this server: ${clash.map((c) => c.detail).join('; ')}`, { domains: clash.map((c) => c.name) })
  for (const d of st.dropped) if (m.mailboxes.some((x) => domainOf(x.address) === d)) st.warnings.push(`mail stored for ${d} was not imported with the dropped domain`)
}

const build = (m: AccountArchiveManifest, st: ImportState, opts: AccountImportOptions): ImportedAccount => {
  const { warnings, username, dropped } = st
  const kept = m.domains.filter((d) => !dropped.has(d.name))

  const uid = allocateUid(opts.local.uids, opts.uidRange)
  const home = `${opts.homeRoot ?? '/home'}/${username}`
  const accountId = opts.ids()
  const account: Account = {
    id: accountId, username, uid, gid: uid, home, primaryDomain: m.account.primaryDomain, planId: opts.planId, ownerId: opts.ownerId,
    status: 'active', suspendReason: null, contactEmail: m.account.contactEmail, ipv4: opts.ipv4, shell: m.account.shell, createdAt: opts.now,
  }
  const domainIds = new Map(kept.map((d) => [d.name, opts.ids()]))
  const domains: Domain[] = kept.map((d) => {
    const version = isPhpVersion(d.phpVersion) ? d.phpVersion : opts.defaultPhp.version
    if (version !== d.phpVersion) warnings.push(`${d.name}: PHP ${d.phpVersion} is not available here; using ${version}`)
    return {
      id: domainIds.get(d.name) as string,
      accountId,
      name: d.name,
      kind: d.kind,
      parentId: d.parent ? (domainIds.get(d.parent) ?? null) : null,
      docRoot: validateDocRoot(home, d.docRoot),
      siteType: d.siteType,
      upstream: d.upstream,
      redirect: null,
      php: { ...structuredClone(opts.defaultPhp), version },
      wildcard: d.wildcard,
      certificateId: null,
      suspended: false,
      expiresAt: null,
      pathQuotaMb: 'unlimited',
    }
  })

  const prefix = (n: string): string => `${username}_${n.slice(m.account.username.length + 1)}`
  const dbIds = new Map(m.databases.map((d) => [d, opts.ids()]))
  const dbNames = new Map(m.databases.map((d) => [d, assertDatabaseName(prefix(d), username)]))
  const databases: Database[] = m.databases.map((d) => ({ id: dbIds.get(d) as string, accountId, engine: 'mariadb', name: dbNames.get(d) as string, trashedAt: null }))
  const dbUsers = m.dbUsers.map((u): ImportedDbUser => ({
    id: opts.ids(),
    accountId,
    name: u.name === m.account.username ? username : assertDbUserName(prefix(u.name), username),
    hosts: [...u.hosts],
    grants: u.grants.map((g) => ({ databaseId: dbIds.get(g.database) as string, privileges: [...g.privileges] })),
    passwordResetRequired: true,
  }))
  if (dbUsers.length) warnings.push('database user passwords are not transferred; set new ones')

  let moved = 0
  const dnsRecords: DnsRecord[] = []
  for (const z of m.zones) {
    if (dropped.has(z)) continue
    for (const r of st.zones.get(z) ?? []) {
      const content = r.type === 'A' && r.content === m.account.ipv4 ? opts.ipv4 : r.content
      if (content !== r.content) moved++
      dnsRecords.push({ id: opts.ids(), zone: r.zone, name: r.name, type: r.type as DnsRecordType, ttl: r.ttl, content, priority: r.priority })
    }
  }
  if (moved) warnings.push(`${moved} A record(s) moved from ${m.account.ipv4} to ${opts.ipv4}`)

  const keptNames = new Set(kept.map((d) => d.name))
  const serviceUsers = m.mailboxes.filter((x) => keptNames.has(domainOf(x.address))).map((x) => ({
    id: opts.ids(), accountId, login: x.address, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: x.quotaMb, ftpDir: '', passwordResetRequired: true as const,
  }))
  if (serviceUsers.length) warnings.push('mailbox passwords are not transferred; set new ones')
  return {
    account,
    slice: sliceUnit(uid),
    domains,
    databases,
    dbUsers,
    dnsRecords,
    serviceUsers,
    mail: mailConfigFor(m.mail, keptNames),
    sql: st.sql.map((s) => ({ database: dbNames.get(s.db) as string, file: s.file })),
    files: st.files,
    warnings,
  }
}
