// Turns the saved account mail routing records (forwarders, domain forwarders, default
// addresses, filters, autoresponders) into Postfix map inputs and one Sieve script per
// mailbox. Each record is checked on its own: a bad record is reported and left out,
// so one tenant's record never blocks the mail configuration of the whole server.
import { isXpanelError } from '@xpanel/core'
import {
  assertRejectText,
  renderSieveScript,
  MAX_FORWARD_TARGETS,
  type DefaultAddress,
  type FilterAction,
  type FilterTest,
  type ForwarderInput,
  type MailFilter,
  type RejectInput,
  type VacationInput,
} from './mail.ts'
import { normalizeEmail, normalizeHostedEmail, normalizeHostname } from './validate.ts'
import { autoreplyAddress } from './mail-autoreply.ts'

export type MailRoutingKind = 'forwarder' | 'domain-forwarder' | 'default-address' | 'filter' | 'autoresponder'

/** Raw saved records; every field is checked here before it reaches a rendered file. */
export interface MailRoutingRecords {
  forwarders: readonly unknown[]
  domainForwarders: readonly unknown[]
  defaultAddresses: readonly unknown[]
  filters: readonly unknown[]
  vacations: readonly unknown[]
  /** autoresponders of addresses without a mailbox; mailbox autoresponders are `vacations` */
  autoresponders?: readonly unknown[]
}

export interface MailRoutingContext {
  domains: readonly { name: string; accountId: string }[]
  /** email-enabled service users */
  mailboxes: readonly { login: string; accountId: string; id: string }[]
}

export interface MailRoutingIssue {
  kind: MailRoutingKind
  /** forwarder/filter id, domain name for default addresses, mailbox for autoresponders */
  id: string
  reason: string
}

export interface DomainRouting {
  forwarders: ForwarderInput[]
  rejects: RejectInput[]
  defaultAddress?: DefaultAddress
  domainForward?: string
  /** local parts whose mail also goes to their hidden autoresponder user */
  autoreplies?: string[]
}

/** Mail for `address` is also delivered to `target`, the hidden user whose Sieve script answers it. */
export interface AutoreplyRoute {
  accountId: string
  domain: string
  local: string
  address: string
  target: string
}

export interface MailboxScript {
  accountId: string
  address: string
  script: string
}

export interface MailRoutingPlan {
  domains: Map<string, DomainRouting>
  scripts: MailboxScript[]
  issues: MailRoutingIssue[]
  autoreplies: AutoreplyRoute[]
}

const EMPTY_ROUTING: MailRoutingRecords = { forwarders: [], domainForwarders: [], defaultAddresses: [], filters: [], vacations: [] }

const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const reasonOf = (error: unknown): string => (isXpanelError(error) || error instanceof Error ? error.message : 'invalid record')

const FIELD: Record<string, FilterTest['field'] | undefined> = { from: 'from', to: 'to', subject: 'subject' }

/** Saved API filter rule (conditions with contains/is/matches/over/under, ordered actions) in the renderer's form. */
export const mailFilterOf = (rule: Record<string, unknown>): MailFilter => {
  const conditions = Array.isArray(rule.conditions) ? rule.conditions : []
  const tests = conditions.map((raw): FilterTest => {
    const c = obj(raw) ?? {}
    const op = str(c.comparator)
    const field = str(c.field)
    if (field === 'size') return { field: 'size', op: op as 'over' | 'under', bytes: Number(c.value) }
    if (field === 'body') return { field: 'body', op: op as 'contains' | 'is' | 'matches', value: str(c.value) }
    if (field === 'header') return { field: 'header', header: str(c.headerName), op: op as 'contains', value: str(c.value) }
    const header = FIELD[field]
    if (!header) throw new Error(`unsupported condition field "${field.slice(0, 32)}"`)
    return { field: header as 'from', op: op as 'contains', value: str(c.value) }
  })
  const actions = (Array.isArray(rule.actions) ? rule.actions : []).map((raw): FilterAction => {
    const a = obj(raw) ?? {}
    const target = str(a.target)
    switch (a.type) {
      case 'fileinto': return { kind: 'fileinto', folder: target }
      case 'redirect': return { kind: 'redirect', to: target }
      case 'reject': return { kind: 'reject', message: target }
      case 'discard': return { kind: 'discard' }
      case 'keep': return { kind: 'keep' }
      case 'mark-read': return { kind: 'mark-read' }
      case 'stop': return { kind: 'stop' }
      default: throw new Error('unsupported filter action')
    }
  })
  return { name: str(rule.name), match: rule.matchAll === false ? 'any' : 'all', tests, actions, enabled: rule.enabled !== false }
}

/** Webmail vacation record (UTC instants, hour interval, optional HTML) to the renderer's form. */
const vacationOf = (rec: Record<string, unknown>, mailbox: string): VacationInput => ({
  subject: str(rec.subject),
  body: str(rec.body),
  ...(str(rec.htmlBody).trim() ? { htmlBody: str(rec.htmlBody) } : {}),
  from: mailbox,
  addresses: [mailbox],
  hours: rec.replyIntervalHours as number,
  ...(rec.startDate ? { start: rec.startDate as string } : {}),
  ...(rec.endDate ? { end: rec.endDate as string } : {}),
})

export const planMailRouting = (ctx: MailRoutingContext, records: MailRoutingRecords = EMPTY_ROUTING): MailRoutingPlan => {
  const issues: MailRoutingIssue[] = []
  const report = (kind: MailRoutingKind, id: string, reason: string) => issues.push({ kind, id, reason })
  const domainOwner = new Map(ctx.domains.map((d) => [d.name.toLowerCase(), d.accountId]))
  const mailboxOwner = new Map(ctx.mailboxes.map((m) => [m.login.toLowerCase(), m.accountId]))
  const mailboxIds = new Map(ctx.mailboxes.map((m) => [m.login.toLowerCase(), m.id]))
  const domains = new Map<string, DomainRouting>()
  const routing = (domain: string): DomainRouting => {
    let r = domains.get(domain)
    if (!r) domains.set(domain, (r = { forwarders: [], rejects: [] }))
    return r
  }
  /** the record's account must own the domain it routes: tenant isolation does not trust the record */
  const ownedDomain = (accountId: unknown, name: unknown, what: string): string => {
    const domain = normalizeHostname(name, what)
    if (typeof accountId !== 'string' || domainOwner.get(domain) !== accountId) throw new Error(`${what} ${domain} is not a domain of this account`)
    return domain
  }

  // domain forwarders first: they replace the default address of their source domain
  for (const raw of records.domainForwarders) {
    const rec = obj(raw)
    const id = str(rec?.id)
    try {
      const source = ownedDomain(rec?.accountId, rec?.sourceDomain, 'source domain')
      const target = normalizeHostname(rec?.targetDomain, 'target domain')
      if (target === source) throw new Error('the target domain is the source domain')
      const r = routing(source)
      if (r.domainForward !== undefined) throw new Error(`${source} already has a domain forwarder`)
      r.domainForward = target
    } catch (error) {
      report('domain-forwarder', id, reasonOf(error))
    }
  }

  const sources = new Map<string, ForwarderInput>()
  for (const raw of records.forwarders) {
    const rec = obj(raw)
    const id = str(rec?.id)
    try {
      const { local, domain, address } = normalizeHostedEmail(rec?.sourceAddress, 'forwarder source')
      ownedDomain(rec?.accountId, domain, 'source domain')
      const r = routing(domain)
      if (rec?.action === 'reject') {
        if (mailboxOwner.has(address)) throw new Error(`${address} is a mailbox; delete the mailbox before rejecting its mail`)
        if (sources.has(address) || r.rejects.some((x) => x.local === local)) throw new Error(`${address} already has a forwarder`)
        r.rejects.push({ local, message: assertRejectText(rec.rejectMessage) })
        continue
      }
      if (rec?.action !== undefined && rec.action !== 'forward') throw new Error('action must be forward or reject')
      if (!Array.isArray(rec?.destinations) || rec.destinations.length === 0) throw new Error('a forwarder needs at least one destination')
      const to = rec.destinations.map((d) => normalizeEmail(d, 'forwarder destination').address)
      if (to.includes(address)) throw new Error('a forwarder cannot target its own source address')
      if (r.rejects.some((x) => x.local === local)) throw new Error(`${address} already rejects mail`)
      const existing = sources.get(address)
      const merged = [...new Set([...(existing?.to ?? []), ...to])]
      if (merged.length > MAX_FORWARD_TARGETS) throw new Error(`${address} allows at most ${MAX_FORWARD_TARGETS} destinations`)
      if (existing) existing.to = merged
      else {
        const f = { local, to: merged }
        sources.set(address, f)
        r.forwarders.push(f)
      }
    } catch (error) {
      report('forwarder', id, reasonOf(error))
    }
  }

  for (const raw of records.defaultAddresses) {
    const rec = obj(raw)
    const id = str(rec?.domain)
    try {
      const domain = ownedDomain(rec?.accountId, rec?.domain, 'domain')
      const r = routing(domain)
      if (r.domainForward !== undefined) throw new Error(`the domain forwarder of ${domain} replaces its default address`)
      if (rec?.kind === 'reject') r.defaultAddress = { kind: 'reject' }
      else if (rec?.kind === 'discard') r.defaultAddress = { kind: 'discard' }
      else if (rec?.kind === 'forward') r.defaultAddress = { kind: 'forward', to: [normalizeEmail(rec.destination, 'default address destination').address] }
      else throw new Error('kind must be reject, forward or discard')
    } catch (error) {
      report('default-address', id, reasonOf(error))
    }
  }

  // Sieve: account-wide rules run first, then the mailbox's own, each in priority order
  const priority = (r: Record<string, unknown>) => (typeof r.priority === 'number' ? r.priority : Number.MAX_SAFE_INTEGER)
  const accountRules = new Map<string, Record<string, unknown>[]>()
  const mailboxRules = new Map<string, Record<string, unknown>[]>()
  for (const raw of records.filters) {
    const rec = obj(raw)
    if (!rec) continue
    const id = str(rec.id)
    try {
      if (typeof rec.accountId !== 'string') throw new Error('the filter has no account')
      renderSieveScript({ filters: [mailFilterOf(rec)] })
      if (rec.scope === 'global') {
        accountRules.set(rec.accountId, [...(accountRules.get(rec.accountId) ?? []), rec])
      } else {
        const mailbox = normalizeHostedEmail(rec.mailbox, 'filter mailbox').address
        if (mailboxOwner.get(mailbox) !== rec.accountId) throw new Error(`${mailbox} is not a mailbox of this account`)
        mailboxRules.set(mailbox, [...(mailboxRules.get(mailbox) ?? []), rec])
      }
    } catch (error) {
      report('filter', id, reasonOf(error))
    }
  }
  const vacations = new Map<string, VacationInput>()
  for (const raw of records.vacations) {
    const rec = obj(raw)
    if (!rec || rec.enabled !== true) continue
    const id = str(rec.mailbox)
    try {
      const mailbox = normalizeHostedEmail(rec.mailbox, 'autoresponder mailbox').address
      if (!mailboxOwner.has(mailbox)) throw new Error(`${mailbox} is not a mailbox`)
      // a responder saved for an earlier mailbox of the same address must not answer for the new one
      const owner = obj(rec.ownerAuthority)
      if (!owner || owner.accountId !== mailboxOwner.get(mailbox) || owner.serviceUserId !== mailboxIds.get(mailbox)) throw new Error(`the autoresponder of ${mailbox} needs ownership review`)
      const vacation = vacationOf(rec, mailbox)
      renderSieveScript({ vacation })
      vacations.set(mailbox, vacation)
    } catch (error) {
      report('autoresponder', id, reasonOf(error))
    }
  }

  const scripts: MailboxScript[] = []
  // addresses without a mailbox answer through a hidden user that replies and keeps nothing
  const autoreplies: AutoreplyRoute[] = []
  for (const raw of records.autoresponders ?? []) {
    const rec = obj(raw)
    if (!rec || rec.enabled !== true) continue
    const id = str(rec.address)
    try {
      const { local, domain, address } = normalizeHostedEmail(rec.address, 'autoresponder address')
      const accountId = str(rec.accountId)
      ownedDomain(accountId, domain, 'autoresponder domain')
      if (mailboxOwner.has(address)) throw new Error(`${address} is a mailbox; it answers with its own autoresponder`)
      const r = routing(domain)
      if (r.rejects.some((x) => x.local === local)) throw new Error(`${address} rejects mail`)
      if (autoreplies.some((x) => x.address === address)) throw new Error(`${address} already has an autoresponder`)
      const target = autoreplyAddress(accountId, address)
      const script = renderSieveScript({ vacation: vacationOf(rec, address), discardAfter: true })
      autoreplies.push({ accountId, domain, local, address, target })
      ;(r.autoreplies ??= []).push(local)
      scripts.push({ accountId, address: target, script })
    } catch (error) {
      report('autoresponder', id, reasonOf(error))
    }
  }
  for (const [address, accountId] of [...mailboxOwner.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const rules = [...(accountRules.get(accountId) ?? []).sort((a, b) => priority(a) - priority(b)),
      ...(mailboxRules.get(address) ?? []).sort((a, b) => priority(a) - priority(b))]
    const filters = rules.map(mailFilterOf).filter((f) => f.enabled !== false)
    const vacation = vacations.get(address) ?? null
    if (filters.length === 0 && !vacation) continue
    try {
      scripts.push({ accountId, address, script: renderSieveScript({ filters, vacation }) })
    } catch (error) {
      // only the combination failed (each rule rendered alone): keep the autoresponder
      for (const r of rules) report('filter', str(r.id), `${address}: ${reasonOf(error)}`)
      if (vacation) scripts.push({ accountId, address, script: renderSieveScript({ vacation }) })
    }
  }

  return { domains, scripts, issues, autoreplies }
}
