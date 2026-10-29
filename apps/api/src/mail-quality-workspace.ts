import { BlockList, isIP } from 'node:net'
import { Resolver } from 'node:dns/promises'
import { fail, resolveDomainOutboundMailIp } from '@xpanel/core'
import { services as render } from '@xpanel/render'
import type { StateSnapshot } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { buildMailServerView } from './mail-server-workspace.ts'

export type MailQualityState = 'ok' | 'problem' | 'unavailable'
export type MailQualityFix = '/whm/dns' | '/whm/email/server' | null
export type SpfResult = 'pass' | 'fail' | 'softfail' | 'neutral' | 'permerror' | 'temperror' | 'undecided'
export type DmarcPolicy = 'none' | 'quarantine' | 'reject'
export interface MailQualityCheck<D> { state: MailQualityState; cause: string; fix: MailQualityFix; detail: D }
export interface MxHost { priority: number | null; host: string }
export interface MailQualityResult {
  domain: string
  mx: MailQualityCheck<{ published: MxHost[]; saved: MxHost[]; hostname: string | null; pointsHere: boolean | null }>
  spf: MailQualityCheck<{ record: string | null; records: number; addresses: { address: string; result: SpfResult }[] }>
  dkim: MailQualityCheck<{ selector: string | null; source: 'signing-key' | 'saved-zone' | null; records: number }>
  dmarc: MailQualityCheck<{ record: string | null; policy: DmarcPolicy | null }>
  ptr: MailQualityCheck<{ expected: string | null; addresses: { address: string; names: string[]; confirmed: string[] }[] }>
}
/** node:dns/promises Resolver methods the checks use; injected in tests. */
export interface MailQualityResolver {
  resolveMx(name: string): Promise<unknown>
  resolveTxt(name: string): Promise<unknown>
  resolve4(name: string): Promise<unknown>
  resolve6(name: string): Promise<unknown>
  reverse(address: string): Promise<unknown>
}
export type DkimMaterial = { selector: string; publicKeyPem: string }
export interface SendingAddress { address: string; version: 4 | 6 }
export interface MailQualityTarget { domain: string; savedMx: MxHost[]; zone: Pick<StateSnapshot['zones'][number], 'name' | 'records'> | null; sending: SendingAddress[]; helo: string | null; hostname: string | null; local: string[] }
export type MailQualitySaved = Pick<StateSnapshot, 'accounts' | 'domains' | 'serviceUsers' | 'zones' | 'server' | 'ipPool' | 'mailIpConfig'>
export interface MailQualityWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot'> {
  readSaved: () => Promise<MailQualitySaved>
  /** Verified OpenDKIM public material from the agent (/host/dkim-public); absent when no host agent is connected. */
  readDkimPublicMaterial?: (caller: AuthenticatedCaller, domain: string) => Promise<DkimMaterial | null>
  resolver?: MailQualityResolver
}

export const MAIL_QUALITY_MAX_CHECK = 50
export const MAIL_QUALITY_CONCURRENCY = 5
const LOOKUP_MS = 5000, TOTAL_MS = 25_000
const NAME = /^(?!.*\.\.)[a-z0-9_](?:[a-z0-9_.-]{0,251}[a-z0-9])?$/
const SELECTOR = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const host = (name: string): string => name.toLowerCase().replace(/\.$/, '')
const family = (version: 4 | 6): 'ipv4' | 'ipv6' => version === 4 ? 'ipv4' : 'ipv6'
const inside = (address: string, version: 4 | 6, network: string, prefix: number): boolean => {
  const list = new BlockList()
  try { list.addSubnet(network, prefix, family(version)); return list.check(address, family(version)) } catch { return false }
}
// shortcut: private, loopback, link-local, CGNAT and multicast ranges only; documentation ranges count as public. Use the full IANA special-purpose registry if PTR checks misfire.
const RESERVED = new BlockList()
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 3]] as const) RESERVED.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) RESERVED.addSubnet(network, prefix, 'ipv6')
const isPublic = (ip: SendingAddress): boolean => !RESERVED.check(ip.address, family(ip.version))

const SERVER_CAUSES = ['dkim_key_unknown', 'no_server_address', 'address_not_public', 'hostname_unknown', 'ptr_missing', 'ptr_not_confirmed', 'ptr_hostname_mismatch']
const UNFIXABLE = ['ok', 'lookup_failed', 'lookup_timeout', 'spf_not_decidable', 'mx_target_unverified']
const verdict = <D>(state: MailQualityState, cause: string, detail: D): MailQualityCheck<D> =>
  ({ state, cause, fix: UNFIXABLE.includes(cause) ? null : SERVER_CAUSES.includes(cause) ? '/whm/email/server' : '/whm/dns', detail })

type Answer<T> = { kind: 'ok'; value: T } | { kind: 'none' } | { kind: 'timeout' | 'failed' }
type Lookups = ReturnType<typeof createLookups>
const lost = (answer: Answer<unknown>): answer is { kind: 'timeout' | 'failed' } => answer.kind === 'timeout' || answer.kind === 'failed'
const lookupCause = (answer: { kind: 'timeout' | 'failed' }): string => answer.kind === 'timeout' ? 'lookup_timeout' : 'lookup_failed'

/** One memoized, deadline-bound lookup per (type, name) for the whole run; oversized or malformed answers are 'failed', never data. */
function createLookups(resolver: MailQualityResolver, deadline: number, lookupMs: number) {
  const memo = new Map<string, Promise<Answer<unknown>>>()
  const run = <T>(key: string, call: () => Promise<unknown>, read: (value: unknown) => T | null): Promise<Answer<T>> => {
    let pending = memo.get(key)
    if (!pending) {
      pending = (async (): Promise<Answer<unknown>> => {
        const left = Math.min(lookupMs, deadline - Date.now())
        if (left <= 0) return { kind: 'timeout' }
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const value = await Promise.race([call(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), left) })])
          const parsed = read(value)
          return parsed === null ? { kind: 'failed' } : { kind: 'ok', value: parsed }
        } catch (error) {
          const code = object(error) ? error.code : undefined
          // c-ares: ENOTFOUND is NXDOMAIN, ENODATA is an empty answer; both mean the record does not exist.
          return { kind: code === 'ENODATA' || code === 'ENOTFOUND' ? 'none' : code === 'ETIMEOUT' ? 'timeout' : 'failed' }
        } finally { clearTimeout(timer) }
      })()
      memo.set(key, pending)
    }
    return pending as Promise<Answer<T>>
  }
  const strings = (value: unknown, max: number, test: (item: string) => boolean): string[] | null => Array.isArray(value) && value.length <= max && value.every(item => typeof item === 'string' && test(item)) ? value as string[] : null
  return {
    mx: (name: string) => run('MX ' + name, () => resolver.resolveMx(name), value => Array.isArray(value) && value.length <= 32 && value.every(item => object(item) && typeof item.exchange === 'string' && item.exchange.length <= 255
      && Number.isSafeInteger(item.priority) && (item.priority as number) >= 0 && (item.priority as number) <= 65535) ? (value as { exchange: string; priority: number }[]).map(item => ({ priority: item.priority, host: host(item.exchange) })) : null),
    // RFC 7208 3.3 / RFC 6376 3.6.2.2: the character-strings of one TXT record are concatenated without separators.
    txt: (name: string) => run('TXT ' + name, () => resolver.resolveTxt(name), value => Array.isArray(value) && value.length <= 64 && value.every(item => strings(item, 64, text => text.length <= 255) !== null)
      ? (value as string[][]).map(item => item.join('')) : null),
    addresses: (name: string, version: 4 | 6) => run((version === 4 ? 'A ' : 'AAAA ') + name, () => version === 4 ? resolver.resolve4(name) : resolver.resolve6(name), value => strings(value, 64, item => isIP(item) === version)),
    reverse: (address: string) => run('PTR ' + address, () => resolver.reverse(address), value => strings(value, 16, item => item.length <= 255)?.map(host) ?? null),
  }
}

type SpfTerm = { name: 'all' | 'include' | 'a' | 'mx' | 'ptr' | 'ip4' | 'ip6' | 'exists' | 'redirect'; qualifier: '+' | '-' | '~' | '?'; target: string | null; cidr4: number | null; cidr6: number | null }
const SPF = /^v=spf1(?: |$)/i
const MECHANISM = /^([+?~-]?)(all|include|a|mx|ptr|ip4|ip6|exists)(?::([^/]*))?(?:\/(\d{1,3}))?(?:\/\/(\d{1,3}))?$/i
const LOOKUP_TERMS = ['include', 'a', 'mx', 'ptr', 'exists', 'redirect']

/** RFC 7208 4.6.1 and 5: mechanisms and modifiers after "v=spf1"; unknown modifiers are ignored (6), redirect occurs at most once (6.1). */
export function parseSpf(record: string): SpfTerm[] | null {
  const terms: SpfTerm[] = []
  for (const word of record.trim().split(/ +/).slice(1)) {
    const modifier = /^([a-z][a-z0-9_.-]*)=(.*)$/i.exec(word)
    if (modifier) {
      if (modifier[1]!.toLowerCase() !== 'redirect') continue
      if (!modifier[2] || terms.some(term => term.name === 'redirect') || !modifier[2].includes('%') && !NAME.test(modifier[2].toLowerCase())) return null
      terms.push({ name: 'redirect', qualifier: '+', target: modifier[2].toLowerCase(), cidr4: null, cidr6: null }); continue
    }
    const match = MECHANISM.exec(word)
    if (!match) return null
    const name = match[2]!.toLowerCase() as SpfTerm['name'], target = match[3] === undefined ? null : match[3].toLowerCase()
    const cidr4 = match[4] === undefined ? null : Number(match[4]), cidr6 = match[5] === undefined ? null : Number(match[5]), ip = name === 'ip4' || name === 'ip6', cidr = cidr4 !== null || cidr6 !== null
    if (target === '' || name === 'all' && (target !== null || cidr) || (name === 'include' || name === 'exists') && (target === null || cidr) || name === 'ptr' && cidr
      || ip && (target === null || isIP(target) !== (name === 'ip4' ? 4 : 6) || cidr6 !== null || cidr4 !== null && cidr4 > (name === 'ip4' ? 32 : 128))
      || !ip && (target !== null && !target.includes('%') && !NAME.test(target) || cidr4 !== null && cidr4 > 32 || cidr6 !== null && cidr6 > 128)) return null
    terms.push({ name, qualifier: (match[1] || '+') as SpfTerm['qualifier'], target, cidr4, cidr6 })
  }
  return terms
}

type SpfRecord = { kind: 'record'; terms: SpfTerm[] } | { kind: 'none' | 'multiple' | 'invalid' | 'temperror' }
const spfRecord = async (dns: Lookups, name: string): Promise<SpfRecord> => {
  const answer = await dns.txt(name)
  if (lost(answer)) return { kind: 'temperror' }
  const records = answer.kind === 'ok' ? answer.value.filter(text => SPF.test(text)) : []
  if (records.length !== 1) return { kind: records.length ? 'multiple' : 'none' }
  const terms = parseSpf(records[0]!)
  return terms ? { kind: 'record', terms } : { kind: 'invalid' }
}
const QUALIFIER: Record<string, SpfResult> = { '+': 'pass', '-': 'fail', '~': 'softfail', '?': 'neutral' }

/** RFC 7208 4.6.2 left-to-right check_host() for one address. include/redirect are followed one level; ptr, exists and macros stay undecided. */
async function evaluateSpf(dns: Lookups, terms: SpfTerm[], domain: string, ip: SendingAddress, depth: number): Promise<SpfResult> {
  const matches = async (names: string[], cidr: number | null): Promise<boolean | 'temperror'> => {
    for (const name of names.filter(item => NAME.test(item))) {
      const answer = await dns.addresses(name, ip.version)
      if (lost(answer)) return 'temperror'
      if (answer.kind === 'ok' && answer.value.some(address => inside(ip.address, ip.version, address, cidr ?? (ip.version === 4 ? 32 : 128)))) return true
    }
    return false
  }
  const nested = async (target: string): Promise<SpfResult> => {
    if (depth >= 1 || target.includes('%')) return 'undecided'
    const inner = await spfRecord(dns, target)
    // RFC 7208 5.2: an include target without exactly one valid record is a permerror.
    return inner.kind === 'record' ? evaluateSpf(dns, inner.terms, target, ip, depth + 1) : inner.kind === 'temperror' ? 'temperror' : 'permerror'
  }
  for (const term of terms) {
    if (term.name === 'redirect') continue
    const target = term.target ?? domain
    if (target.includes('%') || term.name === 'ptr' || term.name === 'exists') return 'undecided'
    let matched: boolean | 'temperror'
    if (term.name === 'all') matched = true
    else if (term.name === 'ip4' || term.name === 'ip6') matched = (term.name === 'ip4') === (ip.version === 4) && inside(ip.address, ip.version, target, term.cidr4 ?? (ip.version === 4 ? 32 : 128))
    else if (term.name === 'a') matched = await matches([target], ip.version === 4 ? term.cidr4 : term.cidr6)
    else if (term.name === 'mx') {
      const answer = await dns.mx(target)
      if (lost(answer)) return 'temperror'
      // RFC 7208 4.6.4: more than 10 MX names is a permerror.
      if (answer.kind === 'ok' && answer.value.length > 10) return 'permerror'
      matched = answer.kind === 'ok' ? await matches(answer.value.map(item => item.host), ip.version === 4 ? term.cidr4 : term.cidr6) : false
    } else {
      const result = await nested(target)
      if (!['pass', 'fail', 'softfail', 'neutral'].includes(result)) return result
      matched = result === 'pass'
    }
    if (matched === 'temperror') return 'temperror'
    if (matched) return QUALIFIER[term.qualifier]!
  }
  const redirect = terms.find(term => term.name === 'redirect')
  return redirect ? nested(redirect.target!) : 'neutral'
}

/** RFC 6376 3.2 / RFC 7489 6.4 tag=value list; a duplicated tag invalidates the list. */
const tagList = (text: string): [string, string][] | null => {
  const tags: [string, string][] = []
  for (const part of text.split(';')) {
    if (!part.trim()) continue
    const match = /^\s*([a-z][a-z0-9_]*)\s*=\s*([^]*?)\s*$/i.exec(part)
    if (!match || tags.some(([name]) => name === match[1]!.toLowerCase())) return null
    tags.push([match[1]!.toLowerCase(), match[2]!])
  }
  return tags
}
/** RFC 6376 3.6.1: v= is optional but must come first; p= is required and may contain folding whitespace. */
const dkimKey = (text: string): string | null => {
  const tags = tagList(text), version = tags?.findIndex(([name]) => name === 'v') ?? -1, key = tags?.find(([name]) => name === 'p')
  return !tags || version > 0 || version === 0 && tags[0]![1] !== 'DKIM1' || !key ? null : key[1].replace(/\s+/g, '')
}
const looksDkim = (text: string): boolean => /^\s*v\s*=\s*DKIM1/i.test(text) || /(?:^|;)\s*p\s*=/i.test(text)
const owner = (name: string, zone: string): string => { const value = host(name), apex = host(zone); return value === apex ? '@' : value.endsWith('.' + apex) ? value.slice(0, -(apex.length + 1)) : value }

async function checkMx(dns: Lookups, target: MailQualityTarget): Promise<MailQualityResult['mx']> {
  const detail = { published: [] as MxHost[], saved: target.savedMx, hostname: target.hostname, pointsHere: null as boolean | null }
  const answer = await dns.mx(target.domain)
  if (lost(answer)) return verdict('unavailable', lookupCause(answer), detail)
  if (answer.kind === 'none' || !answer.value.length) return verdict('problem', 'mx_missing', detail)
  detail.published = [...answer.value].sort((left, right) => left.priority - right.priority || left.host.localeCompare(right.host))
  // RFC 7505: a single "." exchange announces that the domain accepts no mail.
  if (detail.published.some(item => item.host === '' || item.host === '.')) return verdict('problem', 'mx_null', detail)
  const key = (rows: MxHost[]) => rows.map(item => item.priority + ' ' + item.host).sort().join(',')
  if (target.savedMx.length && key(detail.published) !== key(target.savedMx)) return verdict('problem', 'mx_differs_saved', detail)
  if (target.hostname && detail.published.some(item => item.host === target.hostname)) detail.pointsHere = true
  else {
    const local = new BlockList()
    for (const address of target.local) local.addAddress(address, isIP(address) === 6 ? 'ipv6' : 'ipv4')
    let unknown = false
    for (const item of detail.published.slice(0, 5)) for (const version of [4, 6] as const) {
      if (detail.pointsHere || !NAME.test(item.host)) continue
      const addresses = await dns.addresses(item.host, version)
      if (lost(addresses)) unknown = true
      else if (addresses.kind === 'ok' && addresses.value.some(address => local.check(address, family(version)))) detail.pointsHere = true
    }
    if (!detail.pointsHere) detail.pointsHere = unknown ? null : false
  }
  return detail.pointsHere === true ? verdict('ok', 'ok', detail) : verdict(detail.pointsHere === false ? 'problem' : 'unavailable', detail.pointsHere === false ? 'mx_not_this_server' : 'mx_target_unverified', detail)
}

async function checkSpf(dns: Lookups, target: MailQualityTarget): Promise<MailQualityResult['spf']> {
  const detail = { record: null as string | null, records: 0, addresses: [] as { address: string; result: SpfResult }[] }
  const answer = await dns.txt(target.domain)
  if (lost(answer)) return verdict('unavailable', lookupCause(answer), detail)
  const records = answer.kind === 'ok' ? answer.value.filter(text => SPF.test(text)) : []
  detail.records = records.length; detail.record = records[0]?.slice(0, 512) ?? null
  if (!records.length) return verdict('problem', 'spf_missing', detail)
  // RFC 7208 3.2 and 4.5: more than one v=spf1 record is a permerror.
  if (records.length > 1) return verdict('problem', 'spf_multiple', detail)
  const terms = parseSpf(records[0]!)
  if (!terms) return verdict('problem', 'spf_invalid', detail)
  // RFC 7208 4.6.4: at most 10 DNS-querying terms.
  if (terms.filter(term => LOOKUP_TERMS.includes(term.name)).length > 10) return verdict('problem', 'spf_too_many_lookups', detail)
  const sending = target.sending.filter(isPublic)
  if (!sending.length) return verdict('unavailable', target.sending.length ? 'address_not_public' : 'no_server_address', detail)
  const results = await Promise.all(sending.map(ip => evaluateSpf(dns, terms, target.domain, ip, 0)))
  detail.addresses = sending.map((ip, index) => ({ address: ip.address, result: results[index]! }))
  if (results.some(result => ['fail', 'softfail', 'neutral', 'permerror'].includes(result))) return verdict('problem', 'spf_not_authorized', detail)
  if (results.includes('temperror')) return verdict('unavailable', 'lookup_failed', detail)
  return results.includes('undecided') ? verdict('unavailable', 'spf_not_decidable', detail) : verdict('ok', 'ok', detail)
}

function expectedDkim(target: MailQualityTarget, material: DkimMaterial | null): { selector: string; key: string; source: 'signing-key' | 'saved-zone' } | null {
  if (material) try {
    const key = dkimKey(render.dkimDnsRecord(target.domain, material.selector, material.publicKeyPem).content)
    if (key) return { selector: material.selector, key, source: 'signing-key' }
  } catch { /* unusable material falls back to the saved zone record */ }
  if (!target.zone) return null
  const relative = owner(target.domain, target.zone.name), suffix = '._domainkey' + (relative === '@' ? '' : '.' + relative)
  const saved = target.zone.records.filter(record => record.type === 'TXT' && owner(record.name, target.zone!.name).endsWith(suffix))
    .map(record => ({ selector: owner(record.name, target.zone!.name).slice(0, -suffix.length), key: dkimKey(record.content) }))
    .filter((item): item is { selector: string; key: string } => SELECTOR.test(item.selector) && !!item.key)
  return saved.length === 1 ? { ...saved[0]!, source: 'saved-zone' } : null
}

async function checkDkim(dns: Lookups, target: MailQualityTarget, material: DkimMaterial | null): Promise<MailQualityResult['dkim']> {
  const expected = expectedDkim(target, material)
  const detail = { selector: expected?.selector ?? null, source: expected?.source ?? null, records: 0 }
  if (!expected) return verdict('unavailable', 'dkim_key_unknown', detail)
  const answer = await dns.txt(expected.selector + '._domainkey.' + target.domain)
  if (lost(answer)) return verdict('unavailable', lookupCause(answer), detail)
  const records = answer.kind === 'ok' ? answer.value.filter(looksDkim) : []
  detail.records = records.length
  if (!records.length) return verdict('problem', 'dkim_missing', detail)
  if (records.length > 1) return verdict('problem', 'dkim_multiple', detail)
  const key = dkimKey(records[0]!)
  return key === null ? verdict('problem', 'dkim_invalid', detail) : key === '' ? verdict('problem', 'dkim_revoked', detail)
    : key !== expected.key ? verdict('problem', 'dkim_mismatch', detail) : verdict('ok', 'ok', detail)
}

// shortcut: only _dmarc.<domain> is read; the organizational-domain fallback (RFC 7489 6.6.3) is not followed for subdomains.
async function checkDmarc(dns: Lookups, target: MailQualityTarget): Promise<MailQualityResult['dmarc']> {
  const detail = { record: null as string | null, policy: null as DmarcPolicy | null }
  const answer = await dns.txt('_dmarc.' + target.domain)
  if (lost(answer)) return verdict('unavailable', lookupCause(answer), detail)
  // RFC 7489 6.6.3: records that do not start with v=DMARC1 are discarded; more than one leaves no policy.
  const records = answer.kind === 'ok' ? answer.value.filter(text => /^v\s*=\s*DMARC1\s*(?:;|$)/i.test(text)) : []
  detail.record = records[0]?.slice(0, 512) ?? null
  if (!records.length) return verdict('problem', 'dmarc_missing', detail)
  if (records.length > 1) return verdict('problem', 'dmarc_multiple', detail)
  const tags = tagList(records[0]!), value = (name: string) => tags?.find(([tag]) => tag === name)?.[1].toLowerCase()
  const policies = ['none', 'quarantine', 'reject'], policy = value('p'), sub = value('sp'), pct = value('pct')
  if (!tags || tags[0]![0] !== 'v' || !policies.includes(policy ?? '') || sub !== undefined && !policies.includes(sub) || pct !== undefined && !(/^\d{1,3}$/.test(pct) && Number(pct) <= 100)) return verdict('problem', 'dmarc_invalid', detail)
  detail.policy = policy as DmarcPolicy
  return verdict('ok', 'ok', detail)
}

/** RFC 1912 2.1: each sending address needs a PTR whose name resolves back to it (forward-confirmed), naming the HELO host. */
async function checkPtr(dns: Lookups, target: MailQualityTarget): Promise<MailQualityResult['ptr']> {
  const detail = { expected: target.helo, addresses: [] as { address: string; names: string[]; confirmed: string[] }[] }
  if (!target.helo) return verdict('unavailable', 'hostname_unknown', detail)
  const sending = target.sending.filter(isPublic)
  if (!sending.length) return verdict('unavailable', target.sending.length ? 'address_not_public' : 'no_server_address', detail)
  const outcomes = await Promise.all(sending.map(async (ip): Promise<{ state: MailQualityState; cause: string }> => {
    const row = { address: ip.address, names: [] as string[], confirmed: [] as string[] }
    detail.addresses.push(row)
    const answer = await dns.reverse(ip.address)
    if (lost(answer)) return { state: 'unavailable', cause: lookupCause(answer) }
    if (answer.kind === 'none' || !answer.value.length) return { state: 'problem', cause: 'ptr_missing' }
    row.names = answer.value
    let unknown = false
    for (const name of row.names.filter(item => NAME.test(item))) {
      const forward = await dns.addresses(name, ip.version)
      if (lost(forward)) unknown = true
      else if (forward.kind === 'ok' && forward.value.some(address => inside(ip.address, ip.version, address, ip.version === 4 ? 32 : 128))) row.confirmed.push(name)
    }
    if (!row.confirmed.length) return unknown ? { state: 'unavailable', cause: 'lookup_failed' } : { state: 'problem', cause: 'ptr_not_confirmed' }
    return row.confirmed.includes(target.helo!) ? { state: 'ok', cause: 'ok' } : { state: 'problem', cause: 'ptr_hostname_mismatch' }
  }))
  const worst = outcomes.find(item => item.state === 'problem') ?? outcomes.find(item => item.state === 'unavailable') ?? outcomes[0]!
  return verdict(worst.state, worst.cause, detail)
}

export interface MailQualityRun { targets: MailQualityTarget[]; resolver: MailQualityResolver; material?: (domain: string) => Promise<DkimMaterial | null>; lookupMs?: number; totalMs?: number }

/** Checks at most MAIL_QUALITY_CONCURRENCY domains at a time; every lookup after the total deadline reports lookup_timeout. Nothing is changed. */
export async function runMailQualityChecks(run: MailQualityRun): Promise<{ results: MailQualityResult[]; timedOut: boolean }> {
  const lookupMs = run.lookupMs ?? LOOKUP_MS, deadline = Date.now() + (run.totalMs ?? TOTAL_MS), dns = createLookups(run.resolver, deadline, lookupMs)
  const material = async (domain: string): Promise<DkimMaterial | null> => {
    const left = Math.min(lookupMs, deadline - Date.now())
    if (!run.material || left <= 0) return null
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([run.material(domain), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), left) })]) } catch { return null } finally { clearTimeout(timer) }
  }
  const results: MailQualityResult[] = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(MAIL_QUALITY_CONCURRENCY, run.targets.length) }, async () => {
    while (next < run.targets.length) {
      const index = next++, target = run.targets[index]!
      const [mx, spf, dkim, dmarc, ptr] = await Promise.all([checkMx(dns, target), checkSpf(dns, target), material(target.domain).then(found => checkDkim(dns, target, found)), checkDmarc(dns, target), checkPtr(dns, target)])
      results[index] = { domain: target.domain, mx, spf, dkim, dmarc, ptr }
    }
  }))
  return { results, timedOut: Date.now() >= deadline }
}

/** The reconciler's mail-domain rule: a domain with at least one email service user, outside terminating accounts (see mail-server-workspace domainRows). */
export function hostedMailDomains(saved: MailQualitySaved): { rows: { domain: string; account: string | null; mailboxes: number; zone: string | null; mx: MxHost[] }[]; truncated: boolean } {
  const view = buildMailServerView('routing', null, 'not-connected', null, saved)
  return { rows: view.domains.filter(row => row.mailboxes > 0).map(row => ({ domain: row.domain.toLowerCase(), account: row.account, mailboxes: row.mailboxes, zone: row.zone, mx: row.mx.map(item => ({ priority: item.priority, host: host(item.host) })) })), truncated: view.truncated }
}

const sendingIdentity = (saved: MailQualitySaved, domainName: string | null): { sending: SendingAddress[]; helo: string | null; hostname: string | null } => {
  const pool = saved.ipPool ?? [], config = saved.mailIpConfig ?? null, hostname = saved.server?.settings.hostname ? host(saved.server.settings.hostname) : null
  const primary = (version: 4 | 6): string | null => (pool.find(ip => ip.version === version && ip.isPrimary) ?? pool.find(ip => ip.version === version))?.address ?? null
  let ipv4 = config?.defaultIpv4 ?? primary(4), ipv6 = config?.defaultIpv6 ?? primary(6), helo = config?.defaultHelo ?? hostname
  const domain = domainName ? saved.domains.find(item => item.name.toLowerCase() === domainName) : undefined, account = domain && saved.accounts.find(item => item.id === domain.accountId)
  // Same resolver the reconciler renders sender_dependent_default_transport_maps from; without a mail IP config the saved primary addresses are assumed.
  if (config && domain && account) { const outbound = resolveDomainOutboundMailIp(domain, account, config, { ipv4: ipv4 ?? '', ipv6, hostname: hostname ?? '' }); ipv4 = outbound.ipv4 || null; ipv6 = outbound.ipv6; helo = outbound.heloHostname || null }
  const sending = ([[ipv4, 4], [ipv6, 6]] as const).filter((item): item is readonly [string, 4 | 6] => !!item[0] && isIP(item[0]) === item[1]).map(([address, version]) => ({ address, version }))
  return { sending, helo: helo ? host(helo) : null, hostname }
}

export function mailQualityTarget(saved: MailQualitySaved, row: ReturnType<typeof hostedMailDomains>['rows'][number]): MailQualityTarget {
  const identity = sendingIdentity(saved, row.domain)
  const zone = row.zone ? saved.zones.find(item => item.name.toLowerCase() === row.zone!.toLowerCase()) ?? null : null
  const local = [...new Set([...(saved.ipPool ?? []).map(ip => ip.address), ...identity.sending.map(ip => ip.address)])].filter(address => isIP(address) !== 0)
  return { domain: row.domain, savedMx: row.mx, zone: zone ? { name: zone.name, records: zone.records } : null, ...identity, local }
}

async function readCheckBody(request: Request): Promise<string[]> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'application/json is required', { stateChanged: false })
  const text = await request.text()
  if (text.length > 16_384) return fail('VALIDATION', 'mail quality request exceeds the bounded body size', { stateChanged: false })
  let body: unknown
  try { body = JSON.parse(text) } catch { return fail('VALIDATION', 'request body must be valid JSON', { stateChanged: false }) }
  const domains = object(body) ? body.domains : undefined
  if (!object(body) || Object.keys(body).length !== 1 || !Array.isArray(domains) || domains.length < 1 || domains.length > MAIL_QUALITY_MAX_CHECK
    || !domains.every(item => typeof item === 'string' && item.length <= 253 && NAME.test(item)) || new Set(domains).size !== domains.length)
    return fail('VALIDATION', `domains must list 1-${MAIL_QUALITY_MAX_CHECK} distinct lowercase domain names and nothing else`, { stateChanged: false })
  return domains as string[]
}

const LIST = '/api/server/mail-quality', CHECK = '/api/server/mail-quality/check'

export async function handleMailQualityWorkspaceRoute(request: Request, url: URL, method: string, helpers: MailQualityWorkspaceHelpers): Promise<Response | null> {
  if (url.pathname !== LIST && url.pathname !== CHECK) return null
  const action = 'server.mail-quality.read'
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  const allowed = url.pathname === LIST ? 'GET' : 'POST'
  if (method !== allowed) return new Response(null, { status: 405, headers: { allow: allowed } })
  if (url.search) return fail('VALIDATION', 'mail quality routes do not accept selectors', { stateChanged: false })
  const requested = url.pathname === CHECK ? await readCheckBody(request) : null
  const saved = await helpers.readSaved(), hosted = hostedMailDomains(saved)
  let body: unknown
  if (!requested) {
    const identity = sendingIdentity(saved, null)
    body = { hostname: identity.hostname, helo: identity.helo, addresses: identity.sending.map(ip => ({ ...ip, public: isPublic(ip) })),
      domains: hosted.rows.map(({ domain, account, mailboxes, zone }) => ({ domain, account, mailboxes, zone })), truncated: hosted.truncated, maxCheck: MAIL_QUALITY_MAX_CHECK }
  } else {
    const rows = requested.map(name => hosted.rows.find(row => row.domain === name))
    const missing = requested.find((_, index) => !rows[index])
    if (missing) return fail('VALIDATION', 'only hosted mail domains can be checked', { stateChanged: false, domain: missing })
    const run = await runMailQualityChecks({ targets: rows.map(row => mailQualityTarget(saved, row!)), resolver: helpers.resolver ?? new Resolver({ timeout: 2000, tries: 2 }),
      ...(helpers.readDkimPublicMaterial ? { material: (domain: string) => helpers.readDkimPublicMaterial!(caller, domain) } : {}) })
    body = { checkedAt: new Date().toISOString(), timedOut: run.timedOut, results: run.results }
  }
  const current = await helpers.requireCaller(request)
  await helpers.assertRoot(current, action)
  if (current.principal.id !== caller.principal.id) return fail('FORBIDDEN', 'mail quality authority changed', { stateChanged: false })
  return Response.json(body, { headers: { 'cache-control': 'no-store' } })
}
