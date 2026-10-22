import { fail } from '@xpanel/core'
import type { Account, Domain, Id, Limit, Plan, Reseller, ResellerAcl } from '@xpanel/core'
import { checksumStateTree } from '@xpanel/state'
import type { StateSnapshot } from '@xpanel/state'
import type { Db } from '../client.ts'
import { withSqliteErrors } from '../sqlite-errors.ts'
import { clampLimit, nowIso } from './util.ts'

export const REBUILT_DERIVED_TABLES = [
  'idx_resellers',
  'idx_plans',
  'idx_accounts',
  'idx_domains',
  'idx_service_users',
  'idx_databases',
  'search_fts',
] as const

export const UNTOUCHED_OPERATIONAL_TABLES = [
  'principals',
  'sessions',
  'totp_enrollments',
  'api_tokens',
  'audit_log',
  'jobs',
] as const

export type RebuiltDerivedTable = (typeof REBUILT_DERIVED_TABLES)[number]
export type UntouchedOperationalTable = (typeof UNTOUCHED_OPERATIONAL_TABLES)[number]

export interface ReindexAuthorityReport {
  snapshotVerified: true
  snapshotChecksum: string
  snapshotRevision: number
  rebuiltDerivedTables: readonly RebuiltDerivedTable[]
  untouchedOperationalTables: readonly UntouchedOperationalTable[]
  identityRecoveryAuthority: 'sqlite-operational-db'
  desiredStateAuthority: 'filesystem-state-tree'
  operationalRowCountsPreserved: Record<UntouchedOperationalTable, number>
}

export interface ReindexResult {
  resellers: number
  plans: number
  accounts: number
  domains: number
  serviceUsers: number
  databases: number
  ftsEntries: number
  readonly report?: ReindexAuthorityReport
  readonly rebuiltDerivedTables?: readonly RebuiltDerivedTable[]
  readonly untouchedOperationalTables?: readonly UntouchedOperationalTable[]
  readonly snapshotVerified?: boolean
  readonly snapshotChecksum?: string
  readonly snapshotRevision?: number
}

export type SearchEntityKind = 'account' | 'domain' | 'service-user' | 'database' | 'plan' | 'reseller'

export interface SearchHit {
  kind: SearchEntityKind
  entityId: string
  accountId: string | null
  ownerId: string | null
  title: string
  subtitle: string
}

const limitToSql = (v: Limit): number | null => (v === 'unlimited' ? null : v)

const assertUniqueBy = <T>(items: readonly T[], keyFn: (item: T) => string, label: string): Map<string, T> => {
  const map = new Map<string, T>()
  for (const item of items) {
    const key = keyFn(item)
    if (!key || typeof key !== 'string') {
      fail('VALIDATION', `snapshot ${label} has an invalid key`)
    }
    if (map.has(key)) {
      fail('VALIDATION', `snapshot contains duplicate ${label} "${key}"`, { label, key })
    }
    map.set(key, item)
  }
  return map
}

/**
 * Verifies that a `StateSnapshot` is structurally complete, checksum-coherent,
 * UID-allocator-coherent, and referentially intact before `reindexFromState` touches `idx_*`.
 */
export const verifySnapshotCoherence = (snapshot: StateSnapshot): void => {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    fail('VALIDATION', 'reindex requires a valid StateSnapshot object')
  }
  const requiredArrays: (keyof StateSnapshot)[] = [
    'featureLists',
    'plans',
    'resellers',
    'accounts',
    'domains',
    'serviceUsers',
    'databases',
    'databaseUsers',
    'certificates',
    'zones',
    'cronJobs',
  ]
  for (const field of requiredArrays) {
    if (!Array.isArray(snapshot[field])) {
      fail('VALIDATION', `snapshot.${String(field)} must be an array`)
    }
  }
  if (
    typeof snapshot.uidAllocator !== 'object' ||
    snapshot.uidAllocator === null ||
    !Array.isArray(snapshot.uidAllocator.allocated) ||
    typeof snapshot.uidAllocator.nextUid !== 'number'
  ) {
    fail('VALIDATION', 'snapshot.uidAllocator is missing or malformed')
  }
  if (typeof snapshot.checksum !== 'string' || !/^[0-9a-f]{64}$/.test(snapshot.checksum)) {
    fail('VALIDATION', 'snapshot.checksum must be a 64-character lowercase hex SHA-256 digest')
  }
  const computed = checksumStateTree(snapshot)
  if (computed !== snapshot.checksum) {
    fail('VALIDATION', 'snapshot checksum mismatch: refusing to wipe derived SQLite indexes', {
      expected: snapshot.checksum,
      actual: computed,
    })
  }

  const featureById = assertUniqueBy(snapshot.featureLists, (f) => f.id, 'feature list id')
  const resellerById = assertUniqueBy(snapshot.resellers, (r) => r.id, 'reseller id')
  assertUniqueBy(snapshot.resellers, (r) => r.username.toLowerCase(), 'reseller username')
  const planById = assertUniqueBy(snapshot.plans, (p) => p.id, 'plan id')
  assertUniqueBy(snapshot.plans, (p) => p.name.toLowerCase(), 'plan name')
  const accountById = assertUniqueBy(snapshot.accounts, (a) => a.id, 'account id')
  assertUniqueBy(snapshot.accounts, (a) => a.username.toLowerCase(), 'account username')
  assertUniqueBy(snapshot.accounts, (a) => String(a.uid), 'account uid')
  const domainById = assertUniqueBy(snapshot.domains, (d) => d.id, 'domain id')
  assertUniqueBy(snapshot.domains, (d) => d.name.toLowerCase(), 'domain name')
  assertUniqueBy(snapshot.serviceUsers, (u) => u.id, 'service user id')
  assertUniqueBy(snapshot.serviceUsers, (u) => u.login.toLowerCase(), 'service user login')
  const dbById = assertUniqueBy(snapshot.databases, (d) => d.id, 'database id')
  assertUniqueBy(snapshot.databases, (d) => d.name.toLowerCase(), 'database name')

  for (const p of snapshot.plans) {
    if (!featureById.has(p.featureListId)) {
      fail('VALIDATION', `snapshot plan "${p.name}" references missing featureListId "${p.featureListId}"`, {
        planId: p.id,
        featureListId: p.featureListId,
      })
    }
    if (p.ownerId !== null && !resellerById.has(p.ownerId)) {
      fail('VALIDATION', `snapshot plan "${p.name}" references missing reseller "${p.ownerId}"`, {
        planId: p.id,
        ownerId: p.ownerId,
      })
    }
  }

  const allocatedByUid = new Map<number, string>()
  for (const entry of snapshot.uidAllocator.allocated) {
    if (allocatedByUid.has(entry.uid)) {
      fail('VALIDATION', `snapshot uidAllocator has duplicate uid ${entry.uid}`, { uid: entry.uid })
    }
    allocatedByUid.set(entry.uid, entry.username)
  }

  for (const a of snapshot.accounts) {
    if (!planById.has(a.planId)) {
      fail('VALIDATION', `snapshot account "${a.username}" references missing plan "${a.planId}"`, {
        accountId: a.id,
        planId: a.planId,
      })
    }
    if (a.ownerId !== null && !resellerById.has(a.ownerId)) {
      fail('VALIDATION', `snapshot account "${a.username}" references missing reseller "${a.ownerId}"`, {
        accountId: a.id,
        ownerId: a.ownerId,
      })
    }
    const allocatedUser = allocatedByUid.get(a.uid)
    if (allocatedUser !== a.username || snapshot.uidAllocator.nextUid <= a.uid) {
      fail('VALIDATION', `snapshot account "${a.username}" (uid ${a.uid}) is incoherent with uidAllocator`, {
        accountId: a.id,
        uid: a.uid,
      })
    }
    const primary = snapshot.domains.find(
      (d) => d.accountId === a.id && d.kind === 'primary' && d.name === a.primaryDomain,
    )
    if (!primary) {
      fail('VALIDATION', `snapshot account "${a.username}" is missing its primary domain "${a.primaryDomain}"`, {
        accountId: a.id,
        primaryDomain: a.primaryDomain,
      })
    }
  }

  for (const d of snapshot.domains) {
    if (!accountById.has(d.accountId)) {
      fail('VALIDATION', `snapshot domain "${d.name}" references missing account "${d.accountId}"`, {
        domainId: d.id,
        accountId: d.accountId,
      })
    }
    if (d.parentId !== null) {
      const parent = domainById.get(d.parentId)
      if (!parent || parent.accountId !== d.accountId) {
        fail('VALIDATION', `snapshot domain "${d.name}" references invalid parent domain "${d.parentId}"`, {
          domainId: d.id,
          parentId: d.parentId,
        })
      }
    }
  }

  for (const u of snapshot.serviceUsers) {
    if (!accountById.has(u.accountId)) {
      fail('VALIDATION', `snapshot service user "${u.login}" references missing account "${u.accountId}"`, {
        serviceUserId: u.id,
        accountId: u.accountId,
      })
    }
    const dom = domainById.get(u.domainId)
    if (!dom || dom.accountId !== u.accountId) {
      fail('VALIDATION', `snapshot service user "${u.login}" references invalid domain "${u.domainId}"`, {
        serviceUserId: u.id,
        domainId: u.domainId,
      })
    }
  }

  for (const d of snapshot.databases) {
    if (!accountById.has(d.accountId)) {
      fail('VALIDATION', `snapshot database "${d.name}" references missing account "${d.accountId}"`, {
        databaseId: d.id,
        accountId: d.accountId,
      })
    }
  }

  for (const du of snapshot.databaseUsers) {
    if (!accountById.has(du.accountId)) {
      fail('VALIDATION', `snapshot database user "${du.name}" references missing account "${du.accountId}"`, {
        databaseUserId: du.id,
        accountId: du.accountId,
      })
    }
    for (const g of du.grants) {
      const targetDb = dbById.get(g.databaseId)
      if (!targetDb || targetDb.accountId !== du.accountId) {
        fail('VALIDATION', `snapshot database user "${du.name}" references invalid grant database "${g.databaseId}"`, {
          databaseUserId: du.id,
          databaseId: g.databaseId,
        })
      }
    }
  }
}

const readOperationalTableCounts = async (
  tx: Pick<Db, 'query'>,
): Promise<Record<UntouchedOperationalTable, number>> => {
  const counts = {} as Record<UntouchedOperationalTable, number>
  for (const table of UNTOUCHED_OPERATIONAL_TABLES) {
    const rows = await tx.query<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM ${table}`)
    counts[table] = Number(rows[0]?.cnt ?? 0)
  }
  return counts
}

/**
 * Rebuilds all derived SQLite index tables (`idx_*`) and the `search_fts` FTS5 table
 * from an authoritative `StateSnapshot` (`/var/lib/xpanel/state/`).
 *
 * Verifies snapshot coherence (checksum, UID allocator, and cross-entity invariants)
 * BEFORE wiping `idx_*`. Operational and identity/recovery authority tables
 * (`principals`, `sessions`, `totp_enrollments`, `api_tokens`, `audit_log`, `jobs`)
 * are never touched or rebuilt from filesystem state (`A25`).
 */
export const reindexFromState = async (
  db: Db,
  snapshot: StateSnapshot,
  opts: { includeReport?: boolean } = {},
): Promise<ReindexResult> => {
  verifySnapshotCoherence(snapshot)

  return withSqliteErrors(() =>
    db.transaction(async (tx) => {
      const beforeOperationalCounts = await readOperationalTableCounts(tx)

      await tx.exec(`
        DELETE FROM idx_databases;
        DELETE FROM idx_service_users;
        DELETE FROM idx_domains;
        DELETE FROM idx_accounts;
        DELETE FROM idx_plans;
        DELETE FROM idx_resellers;
        DELETE FROM search_fts;
      `)

      const now = nowIso()
      let ftsEntries = 0

      for (const r of snapshot.resellers) {
        await tx.query(
          `INSERT INTO idx_resellers (
            id, username, acl, max_accounts, total_disk_mb, total_bandwidth_mb,
            oversell, nameservers, delegated_ips, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            r.id,
            r.username,
            JSON.stringify(r.acl),
            limitToSql(r.maxAccounts),
            limitToSql(r.totalDiskMb),
            limitToSql(r.totalBandwidthMb),
            r.oversell ? 1 : 0,
            JSON.stringify(r.nameservers),
            JSON.stringify(r.delegatedIps),
            now,
            now,
          ],
        )
        await tx.query(
          `INSERT INTO search_fts (kind, entity_id, account_id, owner_id, title, subtitle, keywords)
           VALUES ('reseller', $1, '', '', $2, 'reseller', $3)`,
          [r.id, r.username, [...r.nameservers, ...r.delegatedIps].join(' ')],
        )
        ftsEntries++
      }

      for (const p of snapshot.plans) {
        await tx.query(
          `INSERT INTO idx_plans (
            id, name, owner_id, feature_list_id, disk_mb, bandwidth_mb_month,
            memory_mb, cpu_percent, max_processes, php_workers, dedicated_ip, shell, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            p.id,
            p.name,
            p.ownerId,
            p.featureListId,
            limitToSql(p.resources.diskMb),
            limitToSql(p.resources.bandwidthMbMonth),
            limitToSql(p.resources.memoryMb),
            limitToSql(p.resources.cpuPercent),
            limitToSql(p.resources.maxProcesses),
            limitToSql(p.caps.phpWorkers),
            p.dedicatedIp ? 1 : 0,
            p.shell,
            now,
            now,
          ],
        )
        await tx.query(
          `INSERT INTO search_fts (kind, entity_id, account_id, owner_id, title, subtitle, keywords)
           VALUES ('plan', $1, '', $2, $3, 'hosting plan', $4)`,
          [p.id, p.ownerId ?? '', p.name, p.shell],
        )
        ftsEntries++
      }

      const accountById = new Map(snapshot.accounts.map((a) => [a.id, a]))

      for (const a of snapshot.accounts) {
        await tx.query(
          `INSERT INTO idx_accounts (
            id, username, uid, gid, home, primary_domain, plan_id, owner_id,
            status, suspend_reason, suspended_at, contact_email, ipv4, shell, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
          [
            a.id,
            a.username,
            a.uid,
            a.gid,
            a.home,
            a.primaryDomain,
            a.planId,
            a.ownerId,
            a.status,
            a.suspendReason,
            a.suspendedAt,
            a.contactEmail,
            a.ipv4,
            a.shell,
            a.createdAt,
            now,
          ],
        )
        await tx.query(
          `INSERT INTO search_fts (kind, entity_id, account_id, owner_id, title, subtitle, keywords)
           VALUES ('account', $1, $1, $2, $3, $4, $5)`,
          [
            a.id,
            a.ownerId ?? '',
            a.username,
            a.primaryDomain,
            `${a.contactEmail} ${a.ipv4} uid:${a.uid} ${a.status}`,
          ],
        )
        ftsEntries++
      }

      for (const d of snapshot.domains) {
        const a = accountById.get(d.accountId)
        await tx.query(
          `INSERT INTO idx_domains (
            id, account_id, name, kind, parent_id, doc_root, site_type,
            upstream, redirect_to, redirect_code, php_version, php_handler,
            wildcard, certificate_id, suspended, expires_at, path_quota_mb, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
          [
            d.id,
            d.accountId,
            d.name,
            d.kind,
            d.parentId,
            d.docRoot,
            d.siteType,
            d.upstream,
            d.redirect?.to ?? null,
            d.redirect?.code ?? null,
            d.php.version,
            d.php.handler,
            d.wildcard ? 1 : 0,
            d.certificateId,
            d.suspended ? 1 : 0,
            d.expiresAt,
            d.pathQuotaMb === undefined ? null : limitToSql(d.pathQuotaMb),
            a?.createdAt ?? now,
            now,
          ],
        )
        await tx.query(
          `INSERT INTO search_fts (kind, entity_id, account_id, owner_id, title, subtitle, keywords)
           VALUES ('domain', $1, $2, $3, $4, $5, $6)`,
          [
            d.id,
            d.accountId,
            a?.ownerId ?? '',
            d.name,
            `${a?.username ?? ''} (${d.kind})`,
            `${d.docRoot} ${d.siteType} php${d.php.version}`,
          ],
        )
        ftsEntries++
      }

      for (const su of snapshot.serviceUsers) {
        const a = accountById.get(su.accountId)
        await tx.query(
          `INSERT INTO idx_service_users (
            id, account_id, domain_id, local_part, address,
            email, ftp, webdisk, mailbox_quota_mb, ftp_dir, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            su.id,
            su.accountId,
            su.domainId,
            su.localPart,
            su.login,
            su.services.email ? 1 : 0,
            su.services.ftp ? 1 : 0,
            su.services.webdisk ? 1 : 0,
            limitToSql(su.mailboxQuotaMb),
            su.ftpDir,
            a?.createdAt ?? now,
            now,
          ],
        )
        await tx.query(
          `INSERT INTO search_fts (kind, entity_id, account_id, owner_id, title, subtitle, keywords)
           VALUES ('service-user', $1, $2, $3, $4, $5, $6)`,
          [
            su.id,
            su.accountId,
            a?.ownerId ?? '',
            su.login,
            a?.username ?? '',
            [
              su.services.email ? 'email' : '',
              su.services.ftp ? 'ftp' : '',
              su.services.webdisk ? 'webdisk' : '',
            ]
              .filter(Boolean)
              .join(' '),
          ],
        )
        ftsEntries++
      }

      for (const dbItem of snapshot.databases) {
        const a = accountById.get(dbItem.accountId)
        await tx.query(
          `INSERT INTO idx_databases (id, account_id, engine, name, trashed_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [dbItem.id, dbItem.accountId, dbItem.engine, dbItem.name, dbItem.trashedAt, a?.createdAt ?? now],
        )
        await tx.query(
          `INSERT INTO search_fts (kind, entity_id, account_id, owner_id, title, subtitle, keywords)
           VALUES ('database', $1, $2, $3, $4, $5, $6)`,
          [dbItem.id, dbItem.accountId, a?.ownerId ?? '', dbItem.name, a?.username ?? '', dbItem.engine],
        )
        ftsEntries++
      }

      const afterOperationalCounts = await readOperationalTableCounts(tx)
      for (const table of UNTOUCHED_OPERATIONAL_TABLES) {
        if (afterOperationalCounts[table] !== beforeOperationalCounts[table]) {
          fail('PRECONDITION_FAILED', `reindex unexpectedly mutated operational table "${table}"`)
        }
      }

      const report: ReindexAuthorityReport = {
        snapshotVerified: true,
        snapshotChecksum: snapshot.checksum,
        snapshotRevision: snapshot.revision ?? 0,
        rebuiltDerivedTables: REBUILT_DERIVED_TABLES,
        untouchedOperationalTables: UNTOUCHED_OPERATIONAL_TABLES,
        identityRecoveryAuthority: 'sqlite-operational-db',
        desiredStateAuthority: 'filesystem-state-tree',
        operationalRowCountsPreserved: afterOperationalCounts,
      }

      const result: ReindexResult = {
        resellers: snapshot.resellers.length,
        plans: snapshot.plans.length,
        accounts: snapshot.accounts.length,
        domains: snapshot.domains.length,
        serviceUsers: snapshot.serviceUsers.length,
        databases: snapshot.databases.length,
        ftsEntries,
      }
      const enumerable = Boolean(opts.includeReport)
      Object.defineProperties(result, {
        report: { value: report, enumerable, configurable: false, writable: false },
        rebuiltDerivedTables: { value: REBUILT_DERIVED_TABLES, enumerable, configurable: false, writable: false },
        untouchedOperationalTables: { value: UNTOUCHED_OPERATIONAL_TABLES, enumerable, configurable: false, writable: false },
        snapshotVerified: { value: true, enumerable, configurable: false, writable: false },
        snapshotChecksum: { value: snapshot.checksum, enumerable, configurable: false, writable: false },
        snapshotRevision: { value: snapshot.revision ?? 0, enumerable, configurable: false, writable: false },
      })
      return result
    }),
  )
}

const sanitizeFtsQuery = (raw: string): string => {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/["'*^():-]/g, '').trim())
    .filter((t) => t.length > 0)
  if (tokens.length === 0) return ''
  return tokens.map((t) => `"${t}"*`).join(' AND ')
}

/** Searches the FTS5 index across accounts, domains, service users, databases, plans, and resellers. */
export const searchIndex = async (
  db: Db,
  query: string,
  opts: { accountId?: Id; ownerId?: Id; kind?: SearchEntityKind; limit?: number } = {},
): Promise<SearchHit[]> => {
  if (typeof query !== 'string') return []
  const ftsExpr = sanitizeFtsQuery(query)
  if (!ftsExpr) return []
  const limit = clampLimit(opts.limit, 25, 200)
  const clauses: string[] = ['search_fts MATCH $1']
  const params: unknown[] = [ftsExpr]

  if (opts.accountId !== undefined) {
    clauses.push(`account_id = $${params.length + 1}`)
    params.push(opts.accountId.toLowerCase())
  }
  if (opts.ownerId !== undefined) {
    clauses.push(`owner_id = $${params.length + 1}`)
    params.push(opts.ownerId.toLowerCase())
  }
  if (opts.kind !== undefined) {
    clauses.push(`kind = $${params.length + 1}`)
    params.push(opts.kind)
  }
  params.push(limit)

  const rows = await db.query<{
    kind: SearchEntityKind
    entity_id: string
    account_id: string
    owner_id: string
    title: string
    subtitle: string
  }>(
    `SELECT kind, entity_id, account_id, owner_id, title, subtitle
     FROM search_fts
     WHERE ${clauses.join(' AND ')}
     ORDER BY rank
     LIMIT $${params.length}`,
    params,
  )
  return rows.map((r) => ({
    kind: r.kind,
    entityId: r.entity_id,
    accountId: r.account_id || null,
    ownerId: r.owner_id || null,
    title: r.title,
    subtitle: r.subtitle,
  }))
}

export const listIndexedAccounts = async (
  db: Db,
  opts: { ownerId?: Id; planId?: Id; status?: Account['status']; limit?: number } = {},
): Promise<Account[]> => {
  const limit = clampLimit(opts.limit, 100, 1000)
  const clauses: string[] = []
  const params: unknown[] = []
  if (opts.ownerId !== undefined) {
    clauses.push(`owner_id = $${params.length + 1}`)
    params.push(opts.ownerId.toLowerCase())
  }
  if (opts.planId !== undefined) {
    clauses.push(`plan_id = $${params.length + 1}`)
    params.push(opts.planId.toLowerCase())
  }
  if (opts.status !== undefined) {
    clauses.push(`status = $${params.length + 1}`)
    params.push(opts.status)
  }
  params.push(limit)
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = await db.query<{
    id: string
    username: string
    uid: number
    gid: number
    home: string
    primary_domain: string
    plan_id: string
    owner_id: string | null
    status: Account['status']
    suspend_reason: string | null
    contact_email: string
    ipv4: string
    shell: Account['shell']
    created_at: string
  }>(`SELECT * FROM idx_accounts ${where} ORDER BY username ASC LIMIT $${params.length}`, params)

  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    uid: r.uid,
    gid: r.gid,
    home: r.home,
    primaryDomain: r.primary_domain,
    planId: r.plan_id,
    ownerId: r.owner_id,
    status: r.status,
    suspendReason: r.suspend_reason,
    contactEmail: r.contact_email,
    ipv4: r.ipv4,
    shell: r.shell,
    createdAt: r.created_at,
  }))
}

export const listIndexedDomains = async (
  db: Db,
  opts: { accountId?: Id; kind?: Domain['kind']; limit?: number } = {},
): Promise<
  Array<{
    id: Id
    accountId: Id
    name: string
    kind: Domain['kind']
    docRoot: string
    siteType: Domain['siteType']
    phpVersion: string
    phpHandler: string
    suspended: boolean
  }>
> => {
  const limit = clampLimit(opts.limit, 100, 1000)
  const clauses: string[] = []
  const params: unknown[] = []
  if (opts.accountId !== undefined) {
    clauses.push(`account_id = $${params.length + 1}`)
    params.push(opts.accountId.toLowerCase())
  }
  if (opts.kind !== undefined) {
    clauses.push(`kind = $${params.length + 1}`)
    params.push(opts.kind)
  }
  params.push(limit)
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = await db.query<{
    id: string
    account_id: string
    name: string
    kind: Domain['kind']
    doc_root: string
    site_type: Domain['siteType']
    php_version: string
    php_handler: string
    suspended: number
  }>(`SELECT * FROM idx_domains ${where} ORDER BY name ASC LIMIT $${params.length}`, params)

  return rows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    name: r.name,
    kind: r.kind,
    docRoot: r.doc_root,
    siteType: r.site_type,
    phpVersion: r.php_version,
    phpHandler: r.php_handler,
    suspended: Boolean(r.suspended),
  }))
}

export const listIndexedResellers = async (db: Db): Promise<Reseller[]> => {
  const rows = await db.query<{
    id: string
    username: string
    acl: string
    max_accounts: number | null
    total_disk_mb: number | null
    total_bandwidth_mb: number | null
    oversell: number
    nameservers: string
    delegated_ips: string
  }>(`SELECT * FROM idx_resellers ORDER BY username ASC`)
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    acl: JSON.parse(r.acl) as ResellerAcl[],
    maxAccounts: r.max_accounts ?? 'unlimited',
    totalDiskMb: r.total_disk_mb ?? 'unlimited',
    totalBandwidthMb: r.total_bandwidth_mb ?? 'unlimited',
    oversell: Boolean(r.oversell),
    nameservers: JSON.parse(r.nameservers) as string[],
    delegatedIps: JSON.parse(r.delegated_ips) as string[],
  }))
}

export const listIndexedPlans = async (
  db: Db,
  opts: { ownerId?: Id | null } = {},
): Promise<
  Array<{
    id: Id
    name: string
    ownerId: Id | null
    featureListId: Id
    diskMb: Limit
    bandwidthMbMonth: Limit
    memoryMb: Limit
    cpuPercent: Limit
    maxProcesses: Limit
    phpWorkers: Limit
    dedicatedIp: boolean
    shell: Plan['shell']
  }>
> => {
  const clauses: string[] = []
  const params: unknown[] = []
  if (opts.ownerId !== undefined) {
    if (opts.ownerId === null) {
      clauses.push('owner_id IS NULL')
    } else {
      clauses.push(`owner_id = $${params.length + 1}`)
      params.push(opts.ownerId.toLowerCase())
    }
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = await db.query<{
    id: string
    name: string
    owner_id: string | null
    feature_list_id: string
    disk_mb: number | null
    bandwidth_mb_month: number | null
    memory_mb: number | null
    cpu_percent: number | null
    max_processes: number | null
    php_workers: number | null
    dedicated_ip: number
    shell: Plan['shell']
  }>(`SELECT * FROM idx_plans ${where} ORDER BY name ASC`, params)

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    ownerId: r.owner_id,
    featureListId: r.feature_list_id,
    diskMb: r.disk_mb ?? 'unlimited',
    bandwidthMbMonth: r.bandwidth_mb_month ?? 'unlimited',
    memoryMb: r.memory_mb ?? 'unlimited',
    cpuPercent: r.cpu_percent ?? 'unlimited',
    maxProcesses: r.max_processes ?? 'unlimited',
    phpWorkers: r.php_workers ?? 'unlimited',
    dedicatedIp: Boolean(r.dedicated_ip),
    shell: r.shell,
  }))
}
