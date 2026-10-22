import { fail } from '@xpanel/core'
import { services } from '@xpanel/render'
import { assertAddress, assertDomain, assertHostedAddress, domainOf, exactKeys, isObj } from '../validate.ts'

// The "mail-config" backup part: forwarders, default addresses and filters. The shapes are
// the renderer's own (Postfix maps and Sieve), so a restored config renders exactly like a
// live one. Pipes and file deliveries are not representable at all.

export interface DomainMail {
  domain: string
  forwarders: services.ForwarderInput[]
  defaultAddress: services.DefaultAddress
}

export interface MailboxFilters {
  /** local@domain of the mailbox the Sieve script belongs to */
  address: string
  filters: services.MailFilter[]
}

export interface MailConfig {
  domains: DomainMail[]
  mailboxes: MailboxFilters[]
}

const MAX_ENTRIES = 10_000

const list = (v: unknown, what: string, max: number): unknown[] =>
  Array.isArray(v) && v.length <= max ? v : fail('VALIDATION', `${what} must be a list of at most ${max} entries`)

const object = (v: unknown, what: string, keys: readonly string[]): Record<string, unknown> => {
  if (!isObj(v)) return fail('VALIDATION', `${what} must be an object`)
  exactKeys(v, keys, what)
  return v
}

const local = (v: unknown, what: string): string => {
  const l = services.normalizeMailboxLocal(v, what)
  return l === v ? l : fail('VALIDATION', `${what} is not in canonical form`)
}

const targets = (v: unknown, what: string): string[] => {
  const to = list(v, what, services.MAX_FORWARD_TARGETS)
  if (to.length === 0) fail('VALIDATION', `${what} needs at least one destination`)
  return [...new Set(to.map((t) => assertAddress(t, `${what} destination`)))]
}

const parseDefault = (v: unknown, domain: string): services.DefaultAddress => {
  const what = `default address of ${domain}`
  if (!isObj(v)) return fail('VALIDATION', `${what} must be an object`)
  if (v.kind === 'reject' || v.kind === 'discard') {
    exactKeys(v, ['kind'], what)
    return { kind: v.kind }
  }
  if (v.kind === 'forward') {
    exactKeys(v, ['kind', 'to'], what)
    return { kind: 'forward', to: targets(v.to, what) }
  }
  return fail('VALIDATION', `${what} must be reject, discard or forward`)
}

const parseDomain = (raw: unknown, own: ReadonlySet<string>): DomainMail => {
  const d = object(raw, 'mail domain', ['domain', 'forwarders', 'defaultAddress'])
  const domain = assertDomain(d.domain, 'mail domain')
  if (!own.has(domain)) fail('VALIDATION', `mail domain ${domain} is not a domain of this account`)
  const seen = new Set<string>()
  const forwarders = list(d.forwarders, `forwarders of ${domain}`, MAX_ENTRIES).map((f): services.ForwarderInput => {
    const o = object(f, 'forwarder', ['local', 'to'])
    const l = local(o.local, 'forwarder')
    if (seen.has(l)) fail('VALIDATION', `forwarder ${l}@${domain} is listed twice`)
    seen.add(l)
    return { local: l, to: targets(o.to, `forwarder ${l}@${domain}`) }
  })
  return { domain, forwarders, defaultAddress: parseDefault(d.defaultAddress, domain) }
}

const TEST_KEYS: Record<string, readonly string[]> = {
  header: ['field', 'header', 'op', 'value', 'not'],
  size: ['field', 'op', 'bytes', 'not'],
}
const ACTION_KEYS: Record<string, readonly string[]> = {
  fileinto: ['kind', 'folder'],
  redirect: ['kind', 'to', 'copy'],
  reject: ['kind', 'message'],
}

/** Shape check only (unknown keys are refused); the content rules are the Sieve renderer's. */
const filterShape = (raw: unknown): services.MailFilter => {
  const f = object(raw, 'filter', ['name', 'match', 'tests', 'actions', 'enabled'])
  for (const t of list(f.tests, 'filter tests', 20)) {
    const field = isObj(t) ? String(t.field) : ''
    object(t, 'filter test', TEST_KEYS[field] ?? ['field', 'op', 'value', 'not'])
  }
  for (const a of list(f.actions, 'filter actions', 10)) {
    const kind = isObj(a) ? String(a.kind) : ''
    object(a, 'filter action', ACTION_KEYS[kind] ?? ['kind'])
  }
  if (f.enabled !== undefined && typeof f.enabled !== 'boolean') fail('VALIDATION', 'filter enabled must be a boolean')
  return structuredClone(f) as unknown as services.MailFilter
}

const parseMailbox = (raw: unknown, own: ReadonlySet<string>): MailboxFilters => {
  const m = object(raw, 'mailbox filters', ['address', 'filters'])
  const address = assertHostedAddress(m.address, 'filter mailbox')
  if (!own.has(domainOf(address))) fail('VALIDATION', `mailbox ${address} is not on this account's domains`)
  const filters = list(m.filters, `filters of ${address}`, services.MAX_FILTERS).map(filterShape)
  // disabled filters are skipped by the renderer, so each one is also checked as if enabled
  for (const f of filters) services.renderFilterSieve([{ ...f, enabled: true }])
  services.renderFilterSieve(filters)
  return { address, filters }
}

/** Strict parse of an untrusted mail config (it may come from an uploaded archive). */
export const parseMailConfig = (raw: unknown, accountDomains: readonly string[]): MailConfig => {
  const own = new Set(accountDomains.map((d) => assertDomain(d, 'account domain')))
  const c = object(raw, 'mail config', ['domains', 'mailboxes'])
  const domains = list(c.domains, 'mail domains', MAX_ENTRIES).map((d) => parseDomain(d, own))
  if (new Set(domains.map((d) => d.domain)).size !== domains.length) fail('VALIDATION', 'a mail domain is listed twice')
  const mailboxes = list(c.mailboxes, 'mailbox filters', MAX_ENTRIES).map((m) => parseMailbox(m, own))
  if (new Set(mailboxes.map((m) => m.address)).size !== mailboxes.length) fail('VALIDATION', 'a mailbox is listed twice')
  return { domains, mailboxes }
}

/** Keeps only what belongs to `domains` (used when a transfer drops a domain). */
export const mailConfigFor = (c: MailConfig, domains: ReadonlySet<string>): MailConfig => ({
  domains: c.domains.filter((d) => domains.has(d.domain)),
  mailboxes: c.mailboxes.filter((m) => domains.has(domainOf(m.address))),
})

export interface MailMergeResult {
  merged: MailConfig
  addedDestinations: number
  addedForwarders: number
  addedFilters: number
  replacedFilters: number
  changedDefaults: string[]
}

/**
 * Restore merge: forwarders gain the backup's destinations, the backup's default address
 * applies, filters replace same-named ones. Nothing that exists only now is removed.
 */
export const mergeMailConfig = (current: MailConfig, backup: MailConfig): MailMergeResult => {
  const r: MailMergeResult = { merged: structuredClone(current), addedDestinations: 0, addedForwarders: 0, addedFilters: 0, replacedFilters: 0, changedDefaults: [] }
  for (const b of backup.domains) {
    let d = r.merged.domains.find((x) => x.domain === b.domain)
    if (!d) {
      d = { domain: b.domain, forwarders: [], defaultAddress: { kind: 'reject' } }
      r.merged.domains.push(d)
    }
    for (const f of b.forwarders) {
      let cur = d.forwarders.find((x) => x.local === f.local)
      if (!cur) {
        cur = { local: f.local, to: [] }
        d.forwarders.push(cur)
        r.addedForwarders++
      }
      for (const t of f.to) {
        if (!cur.to.includes(t) && cur.to.length < services.MAX_FORWARD_TARGETS) {
          cur.to.push(t)
          r.addedDestinations++
        }
      }
    }
    if (JSON.stringify(d.defaultAddress) !== JSON.stringify(b.defaultAddress)) {
      d.defaultAddress = structuredClone(b.defaultAddress)
      r.changedDefaults.push(b.domain)
    }
  }
  for (const b of backup.mailboxes) {
    let m = r.merged.mailboxes.find((x) => x.address === b.address)
    if (!m) {
      m = { address: b.address, filters: [] }
      r.merged.mailboxes.push(m)
    }
    for (const f of b.filters) {
      const i = m.filters.findIndex((x) => x.name === f.name)
      if (i >= 0) {
        m.filters[i] = structuredClone(f)
        r.replacedFilters++
      } else {
        m.filters.push(structuredClone(f))
        r.addedFilters++
      }
    }
    // the union may break per-script limits (filter count, redirects): refuse rather than truncate
    services.renderFilterSieve(m.filters)
  }
  return r
}
