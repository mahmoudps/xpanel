import { and, asc, count, eq, sql } from 'drizzle-orm'
import { assertAliasTarget, assertCapAvailable, canRenamePrimary, fail, isUnlimited, limitLte, validateDocRoot, validateDomainName } from '@xpanel/core'
import type { Account, Domain, DomainKind, Id, Limit, Plan, PlanCapKey, SiteType } from '@xpanel/core'
import type { Db } from '../client.ts'
import { domainFromRow, limitToDb, type DomainInsert, type DomainRow } from '../mappers.ts'
import { withPgErrors } from '../pg-errors.ts'
import { accounts, certificates, domains, serverSettings } from '../schema.ts'
import { assertBool, assertIsoDate, assertPhpSettings, assertRedirectTarget, assertUpstream, oneOf } from '../validate.ts'
import { lockAccount, lockPlan } from './accounts.ts'
import { assertNameFree, lockDomainNames, overlappingDomains } from './domain-names.ts'
import { assertId, assertIdOrNull, first, isUuid, mustExist } from './util.ts'

export type NewDomain = Omit<Domain, 'id'>
export type DomainPatch = Partial<
  Pick<Domain, 'docRoot' | 'siteType' | 'upstream' | 'redirect' | 'php' | 'wildcard' | 'certificateId' | 'suspended' | 'expiresAt' | 'pathQuotaMb'>
>

const KINDS: readonly DomainKind[] = ['primary', 'addon', 'alias', 'subdomain']
const SITE_TYPES: readonly SiteType[] = ['php', 'static', 'proxy', 'node', 'python']
const UPSTREAM_TYPES: readonly SiteType[] = ['proxy', 'node', 'python']

const CAP_OF: Record<Exclude<DomainKind, 'primary'>, PlanCapKey> = {
  addon: 'addonDomains',
  alias: 'aliasDomains',
  subdomain: 'subdomains',
}

/** Loopback ports a proxied site may not point at: the panel, SSH and the web backends behind Nginx. */
const reservedLoopbackPorts = async (tx: Db): Promise<Set<number>> => {
  const s = first(
    await tx
      .select({ panel: serverSettings.panelPort, ssh: serverSettings.sshPort, be: serverSettings.backendPort, tls: serverSettings.backendTlsPort })
      .from(serverSettings),
  )
  return new Set(s ? [s.panel, s.ssh, s.be, s.tls] : [])
}

const siteFields = async (tx: Db, d: Pick<Domain, 'siteType' | 'upstream' | 'redirect'>) => {
  const siteType = oneOf(d.siteType, SITE_TYPES, 'siteType')
  const needsUpstream = UPSTREAM_TYPES.includes(siteType)
  if (needsUpstream !== (d.upstream !== null && d.upstream !== undefined)) {
    fail('VALIDATION', needsUpstream ? `${siteType} sites need an upstream` : `${siteType} sites take no upstream`)
  }
  let upstream: string | null = null
  if (needsUpstream) {
    const target = assertUpstream(d.upstream)
    if (target.loopbackPort !== null && (target.loopbackPort < 1024 || (await reservedLoopbackPorts(tx)).has(target.loopbackPort))) {
      fail('VALIDATION', 'a local upstream must use an unprivileged port that is not the panel, SSH or web backend port', { upstream: target.url })
    }
    upstream = target.url
  }
  const redirect = d.redirect ?? null
  if (redirect !== null && (typeof redirect !== 'object' || (redirect.code !== 301 && redirect.code !== 302))) {
    fail('VALIDATION', 'redirect must be { to, code: 301 | 302 }')
  }
  return {
    siteType,
    upstream,
    redirectTo: redirect ? assertRedirectTarget(redirect.to) : null,
    redirectCode: redirect ? redirect.code : null,
  }
}

/** A path quota is a slice of the account quota: a finite one may not exceed a finite disk cap. */
const assertPathQuota = (q: Limit, plan: Plan): number | null => {
  const stored = limitToDb(q, 'pathQuotaMb')
  if (stored === 0) fail('VALIDATION', 'pathQuotaMb must be at least 1 MB or unlimited')
  if (!isUnlimited(q) && !limitLte(q, plan.resources.diskMb)) {
    fail('VALIDATION', 'pathQuotaMb may not exceed the account disk quota', { pathQuotaMb: q, diskMb: plan.resources.diskMb })
  }
  return stored
}

/** A certificate is used only by domains of the account that owns it. */
const assertCertificate = async (tx: Db, certificateId: unknown, accountId: Id): Promise<Id | null> => {
  const id = assertIdOrNull(certificateId, 'certificateId')
  if (id === null) return null
  const cert = mustExist(first(await tx.select({ accountId: certificates.accountId }).from(certificates).where(eq(certificates.id, id))), 'certificate', id)
  if (cert.accountId !== accountId) fail('FORBIDDEN', 'the certificate belongs to another account')
  return id
}

const isoDateOrNull = (v: unknown, what: string): Date | null => (v === null ? null : assertIsoDate(v, what))

const loadDomainRow = async (db: Db, id: Id): Promise<DomainRow | null> => {
  if (!isUuid(id)) return null
  return first(await db.select().from(domains).where(eq(domains.id, id)))
}

const phpCaps = (plan: Plan) => ({ phpWorkers: plan.caps.phpWorkers, memoryMb: plan.resources.memoryMb })

/** Per-kind counts for plan caps (addonDomains, aliasDomains, subdomains). */
export const countDomainsByKind = async (db: Db, accountId: Id): Promise<Record<DomainKind, number>> => {
  const out: Record<DomainKind, number> = { primary: 0, addon: 0, alias: 0, subdomain: 0 }
  if (!isUuid(accountId)) return out
  const rows = await db.select({ kind: domains.kind, n: count() }).from(domains).where(eq(domains.accountId, accountId)).groupBy(domains.kind)
  for (const r of rows) out[r.kind] = r.n
  return out
}

/**
 * Addon, alias or subdomain; the primary domain is created with its account. Refused past
 * the plan's cap for the kind, when the name overlaps another account's domains, or when
 * the docroot leaves the home or enters a protected or hidden directory.
 */
export const createDomain = (db: Db, input: NewDomain): Promise<Domain> =>
  withPgErrors(() =>
    db.transaction(async (tx) => {
      if (typeof input !== 'object' || input === null) fail('VALIDATION', 'domain must be an object')
      const kind = oneOf(input.kind, KINDS, 'kind')
      if (kind === 'primary') fail('VALIDATION', 'the primary domain is created with the account; rename it instead')
      const capKey = CAP_OF[kind as Exclude<DomainKind, 'primary'>]
      const name = validateDomainName(input.name)
      const parentId = assertIdOrNull(input.parentId, 'parentId')
      if ((kind === 'addon') !== (parentId === null)) fail('VALIDATION', `${kind} domains ${kind === 'addon' ? 'have no' : 'need a'} parent`)

      await lockDomainNames(tx)
      const account = await lockAccount(tx, input.accountId)
      const plan = await lockPlan(tx, account.planId)
      const counts = await countDomainsByKind(tx, account.id)
      assertCapAvailable(plan, { [capKey]: counts[kind] }, capKey)

      let docRoot = validateDocRoot(account.home, input.docRoot)
      if (parentId !== null) {
        const parent = domainFromRow(mustExist(await loadDomainRow(tx, parentId), 'parent domain', parentId))
        if (parent.accountId !== account.id) fail('FORBIDDEN', 'parent domain belongs to another account')
        if (kind === 'alias') {
          assertAliasTarget(account.id, parent)
          // an alias serves its target's site
          if (docRoot !== parent.docRoot) fail('VALIDATION', 'an alias uses the document root of the domain it points at', { docRoot: parent.docRoot })
          docRoot = parent.docRoot
        }
        if (kind === 'subdomain' && !name.endsWith(`.${parent.name}`)) fail('VALIDATION', `subdomain must end with .${parent.name}`)
      }
      await assertNameFree(tx, name, account.id)

      const values: DomainInsert = {
        accountId: account.id,
        name,
        kind,
        parentId,
        docRoot,
        ...(await siteFields(tx, input)),
        php: assertPhpSettings(input.php, phpCaps(plan)),
        wildcard: assertBool(input.wildcard, 'wildcard'),
        certificateId: await assertCertificate(tx, input.certificateId, account.id),
        suspended: assertBool(input.suspended, 'suspended'),
        expiresAt: isoDateOrNull(input.expiresAt, 'expiresAt'),
        pathQuotaMb: assertPathQuota(input.pathQuotaMb, plan),
      }
      const [row] = await tx.insert(domains).values(values).returning()
      return domainFromRow(mustExist(row, 'domain', name))
    }),
  )

export const getDomain = async (db: Db, id: Id): Promise<Domain | null> => {
  const row = await loadDomainRow(db, id)
  return row ? domainFromRow(row) : null
}

/** Server-wide, case-insensitive. */
export const getDomainByName = async (db: Db, name: string): Promise<Domain | null> => {
  if (typeof name !== 'string' || name.length > 253) return null
  const row = first(await db.select().from(domains).where(eq(sql`lower(${domains.name})`, name.toLowerCase())))
  return row ? domainFromRow(row) : null
}

export const listDomains = async (db: Db, f: { accountId?: Id; kind?: DomainKind } = {}): Promise<Domain[]> => {
  const where = and(
    f.accountId === undefined ? undefined : eq(domains.accountId, assertId(f.accountId, 'accountId')),
    f.kind === undefined ? undefined : eq(domains.kind, oneOf(f.kind, KINDS, 'kind')),
  )
  const rows = await db.select().from(domains).where(where).orderBy(asc(domains.name))
  return rows.map(domainFromRow)
}

export const updateDomain = (db: Db, id: Id, patch: DomainPatch): Promise<Domain> =>
  withPgErrors(() =>
    db.transaction(async (tx) => {
      if (typeof patch !== 'object' || patch === null) fail('VALIDATION', 'domain patch must be an object')
      const found = mustExist(await loadDomainRow(tx, id), 'domain', id)
      const account = await lockAccount(tx, found.accountId)
      const current = domainFromRow(mustExist(await loadDomainRow(tx, found.id), 'domain', id))
      const plan = await lockPlan(tx, account.planId)
      if (patch.docRoot !== undefined && current.kind === 'alias') fail('VALIDATION', 'an alias uses the document root of the domain it points at')
      const merged = { ...current, ...patch }
      const values: Partial<DomainInsert> = {
        ...(patch.docRoot !== undefined && { docRoot: validateDocRoot(account.home, patch.docRoot) }),
        ...((patch.siteType !== undefined || patch.upstream !== undefined || patch.redirect !== undefined) && (await siteFields(tx, merged))),
        ...(patch.php !== undefined && { php: assertPhpSettings(patch.php, phpCaps(plan)) }),
        ...(patch.wildcard !== undefined && { wildcard: assertBool(patch.wildcard, 'wildcard') }),
        ...(patch.certificateId !== undefined && { certificateId: await assertCertificate(tx, patch.certificateId, account.id) }),
        ...(patch.suspended !== undefined && { suspended: assertBool(patch.suspended, 'suspended') }),
        ...(patch.expiresAt !== undefined && { expiresAt: isoDateOrNull(patch.expiresAt, 'expiresAt') }),
        ...(patch.pathQuotaMb !== undefined && { pathQuotaMb: assertPathQuota(patch.pathQuotaMb, plan) }),
      }
      if (Object.keys(values).length === 0) return current
      const [row] = await tx.update(domains).set(values).where(eq(domains.id, current.id)).returning()
      // aliases follow their target's document root
      if (values.docRoot !== undefined) await tx.update(domains).set({ docRoot: values.docRoot }).where(and(eq(domains.parentId, current.id), eq(domains.kind, 'alias')))
      return domainFromRow(mustExist(row, 'domain', id))
    }),
  )

interface Move {
  id: Id
  to: string
}

/** Subdomains of the account named under `oldName` move with it (blog.old.tld -> blog.new.tld). */
const planMoves = async (tx: Db, account: Account, current: Domain, name: string): Promise<Move[]> => {
  const own = await tx
    .select({ id: domains.id, name: domains.name, accountId: domains.accountId, kind: domains.kind })
    .from(domains)
    .where(eq(domains.accountId, account.id))
  const all = [...new Map([...own, ...(await overlappingDomains(tx, name))].map((d) => [d.id, d])).values()]
  if (current.kind === 'primary') {
    const r = canRenamePrimary(account, name, all)
    if (!r.ok) return fail(account.status === 'active' ? 'CONFLICT' : 'PRECONDITION_FAILED', `cannot rename: ${r.reasons.join('; ')}`, { reasons: r.reasons })
    return [{ id: current.id, to: name }, ...r.subdomainRenames.map((m) => ({ id: m.id, to: m.to }))]
  }
  const old = current.name
  const moving = all.filter((d) => d.accountId === account.id && d.kind === 'subdomain' && d.name.endsWith(`.${old}`))
  const ignore = new Set([current.id, ...moving.map((d) => d.id)])
  const moves: Move[] = [{ id: current.id, to: name }, ...moving.map((d) => ({ id: d.id, to: `${d.name.slice(0, -old.length)}${name}` }))]
  for (const m of moves) await assertNameFree(tx, validateDomainName(m.to), account.id, ignore)
  return moves
}

/**
 * Renames a domain and the subdomains named under it; for the primary (core's
 * canRenamePrimary: account active, no overlap with other accounts) the account follows.
 */
export const renameDomain = (db: Db, id: Id, newName: string): Promise<Domain> =>
  withPgErrors(() =>
    db.transaction(async (tx) => {
      const name = validateDomainName(newName)
      await lockDomainNames(tx)
      const found = mustExist(await loadDomainRow(tx, id), 'domain', id)
      const account = await lockAccount(tx, found.accountId)
      const current = domainFromRow(found)
      if (name === current.name) return current
      if (current.kind === 'subdomain') {
        const parent = mustExist(await loadDomainRow(tx, current.parentId as string), 'parent domain', current.parentId)
        if (!name.endsWith(`.${parent.name}`)) fail('VALIDATION', `subdomain must end with .${parent.name}`)
      }
      const moves = await planMoves(tx, account, current, name)
      // unique checks run per row, so park every moving row on a reserved .invalid name (RFC 6761) first:
      // renaming a.example to x.a.example while x.a.example itself moves on would otherwise clash midway
      for (const m of moves) await tx.update(domains).set({ name: `${m.id}.renaming.invalid` }).where(eq(domains.id, m.id))
      for (const m of moves) await tx.update(domains).set({ name: m.to }).where(eq(domains.id, m.id))
      if (current.kind === 'primary') await tx.update(accounts).set({ primaryDomain: name }).where(eq(accounts.id, account.id))
      return domainFromRow(mustExist(await loadDomainRow(tx, current.id), 'domain', id))
    }),
  )

/** Subdomains and aliases under it go too. The primary domain cannot be deleted. */
export const deleteDomain = (db: Db, id: Id): Promise<boolean> =>
  withPgErrors(async () => {
    const current = await loadDomainRow(db, id)
    if (!current) return false
    if (current.kind === 'primary') fail('PRECONDITION_FAILED', 'the primary domain is removed only with its account')
    const rows = await db.delete(domains).where(eq(domains.id, current.id)).returning({ id: domains.id })
    return rows.length > 0
  })
