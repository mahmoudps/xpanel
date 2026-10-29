import { createHash } from 'node:crypto'
import { MAILX_MAPS, MAILX_RETENTION_MAX_DAYS, isMailxAddress, isMailxHost } from '../../../packages/os/src/mailx-command.ts'

/**
 * Saved server mail policy, shared by the API (which saves it) and the agent (which renders and applies it).
 * Desired state lives in files under <state>/extended/mailx; a section without a file is not managed and its
 * Postfix parameters are never touched.
 */
export const MAILX_SECTIONS = ['spam', 'relay', 'bcc', 'marketing'] as const
export type MailxSection = typeof MAILX_SECTIONS[number]
export const isMailxSection = (value: unknown): value is MailxSection => (MAILX_SECTIONS as readonly unknown[]).includes(value)
export interface MailxSpamPolicy { enabled: boolean; rejectScore: number; headerScore: number; greylistScore: number | null; blockedDomains: string[] }
export interface MailxRelayPolicy { enabled: boolean; host: string | null; port: number; username: string | null }
export interface MailxBccRule { match: string; copyTo: string }
export interface MailxBccPolicy { alwaysBcc: string | null; recipient: MailxBccRule[]; sender: MailxBccRule[] }
export interface MailxMarketingPolicy { messageRateLimit: number; recipientRateLimit: number; recipientsPerMessage: number; destinationRateDelay: number; destinationConcurrency: number; rateWindow: number }
export interface MailxArchiveDomain { domain: string; mailbox: string; incoming: boolean; outgoing: boolean; retentionDays: number }
export interface MailxArchivePolicy { domains: MailxArchiveDomain[] }
export interface MailxPolicies { spam: MailxSpamPolicy; relay: MailxRelayPolicy; bcc: MailxBccPolicy; marketing: MailxMarketingPolicy }
/** Relay credentials stay in the saved file (mode 0600) and in the 0600 Postfix map only; views carry `passwordSet`. */
export interface MailxRelaySecret { password: string; version: string }
export interface MailxStored<S extends MailxSection = MailxSection> { section: S; policy: MailxPolicies[S]; secret?: MailxRelaySecret | null; updatedAt: string; updatedBy: string }
export interface MailxArchiveStored { accountId: string; policy: MailxArchivePolicy; updatedAt: string; updatedBy: string }

export const MAILX_LIMITS = { blockedDomains: 500, bccRules: 500, archiveDomains: 200 } as const
export const MAILX_DEFAULTS: MailxPolicies = {
  spam: { enabled: true, rejectScore: 15, headerScore: 6, greylistScore: 4, blockedDomains: [] },
  relay: { enabled: false, host: null, port: 587, username: null },
  bcc: { alwaysBcc: null, recipient: [], sender: [] },
  // Postfix defaults (postconf(5)): no client rate limits, 1000 recipients, no delay, concurrency 20, 60s window.
  marketing: { messageRateLimit: 0, recipientRateLimit: 0, recipientsPerMessage: 1000, destinationRateDelay: 0, destinationConcurrency: 20, rateWindow: 60 },
}
export const mailxStatePath = (...parts: string[]): string[] => ['extended', 'mailx', ...parts]
export const MAILX_MARKER = '# Managed by xPanel mail policy. Changes here are replaced on the next apply.'

class MailxInvalid extends Error { field: string; constructor(field: string) { super('invalid_mailx_policy'); this.field = field } }
export const isMailxInvalid = (error: unknown): error is MailxInvalid => error instanceof MailxInvalid
const bad = (field: string): never => { throw new MailxInvalid(field) }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: unknown, keys: readonly string[], field: string): Record<string, unknown> =>
  object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) ? value : bad(field)
const flag = (value: unknown, field: string): boolean => typeof value === 'boolean' ? value : bad(field)
const int = (value: unknown, min: number, max: number, field: string): number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max ? value as number : bad(field)
// Scores use half steps so the rendered rspamd/SpamAssassin text is exact.
const score = (value: unknown, field: string): number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100 && Number.isInteger(value * 2) ? value : bad(field)
const address = (value: unknown, field: string): string => isMailxAddress(value) ? value : bad(field)
const unique = <T>(items: T[], key: (item: T) => string, field: string): T[] => new Set(items.map(key)).size === items.length ? items : bad(field)
const list = (value: unknown, max: number, field: string): unknown[] => Array.isArray(value) && value.length <= max ? value : bad(field)

export function parseMailxSpam(value: unknown): MailxSpamPolicy {
  const raw = exact(value, ['enabled', 'rejectScore', 'headerScore', 'greylistScore', 'blockedDomains'], 'spam')
  const rejectScore = score(raw.rejectScore, 'rejectScore'), headerScore = score(raw.headerScore, 'headerScore')
  const greylistScore = raw.greylistScore === null ? null : score(raw.greylistScore, 'greylistScore')
  if (headerScore >= rejectScore || greylistScore !== null && greylistScore >= headerScore) bad('scoreOrder')
  const blockedDomains = unique(list(raw.blockedDomains, MAILX_LIMITS.blockedDomains, 'blockedDomains').map(item => isMailxHost(item) ? item : bad('blockedDomains')), item => item, 'blockedDomains')
  return { enabled: flag(raw.enabled, 'enabled'), rejectScore, headerScore, greylistScore, blockedDomains }
}
export function parseMailxRelay(value: unknown): MailxRelayPolicy {
  const raw = exact(value, ['enabled', 'host', 'port', 'username'], 'relay')
  const enabled = flag(raw.enabled, 'enabled'), host = raw.host === null ? null : isMailxHost(raw.host) ? raw.host : bad('host')
  // smtp(8) port 465 needs the global smtp_tls_wrappermode, which would break every other destination; STARTTLS ports only.
  const port = int(raw.port, 1, 65535, 'port')
  if (port === 465) bad('port')
  const username = raw.username === null ? null : typeof raw.username === 'string' && /^[A-Za-z0-9._@+=-]{1,128}$/.test(raw.username) ? raw.username : bad('username')
  if (enabled && host === null) bad('host')
  return { enabled, host, port, username }
}
/** postmap(5) input: the value is the rest of the line, so a password may not hold control characters or edge spaces. */
export const isMailxRelayPassword = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= 256 && /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(value)
// recipient_bcc_maps / sender_bcc_maps: full address or @domain keys (postconf(5) table search order).
const bccMatch = (value: unknown): string => {
  const text = typeof value === 'string' ? value : ''
  const domainKey = text.startsWith('@') && isMailxHost(text.slice(1))
  return domainKey || isMailxAddress(text) ? text : bad('match')
}
const rules = (value: unknown): MailxBccRule[] => unique(list(value, MAILX_LIMITS.bccRules, 'rules').map(item => {
  const raw = exact(item, ['match', 'copyTo'], 'rule'), match = bccMatch(raw.match), copyTo = address(raw.copyTo, 'copyTo')
  return match === copyTo ? bad('copyTo') : { match, copyTo }
}), rule => rule.match, 'match')
export function parseMailxBcc(value: unknown): MailxBccPolicy {
  const raw = exact(value, ['alwaysBcc', 'recipient', 'sender'], 'bcc')
  return { alwaysBcc: raw.alwaysBcc === null ? null : address(raw.alwaysBcc, 'alwaysBcc'), recipient: rules(raw.recipient), sender: rules(raw.sender) }
}
export function parseMailxMarketing(value: unknown): MailxMarketingPolicy {
  const raw = exact(value, ['messageRateLimit', 'recipientRateLimit', 'recipientsPerMessage', 'destinationRateDelay', 'destinationConcurrency', 'rateWindow'], 'marketing')
  return { messageRateLimit: int(raw.messageRateLimit, 0, 1000000, 'messageRateLimit'), recipientRateLimit: int(raw.recipientRateLimit, 0, 1000000, 'recipientRateLimit'),
    recipientsPerMessage: int(raw.recipientsPerMessage, 1, 100000, 'recipientsPerMessage'), destinationRateDelay: int(raw.destinationRateDelay, 0, 3600, 'destinationRateDelay'),
    destinationConcurrency: int(raw.destinationConcurrency, 1, 1000, 'destinationConcurrency'), rateWindow: int(raw.rateWindow, 60, 86400, 'rateWindow') }
}
export function parseMailxArchive(value: unknown): MailxArchivePolicy {
  const raw = exact(value, ['domains'], 'archive')
  const domains = list(raw.domains, MAILX_LIMITS.archiveDomains, 'domains').map(item => {
    const row = exact(item, ['domain', 'mailbox', 'incoming', 'outgoing', 'retentionDays'], 'domain')
    const domain = isMailxHost(row.domain) ? row.domain : bad('domain'), mailbox = address(row.mailbox, 'mailbox')
    if (!mailbox.endsWith('@' + domain)) bad('mailbox')
    // 0 keeps archived copies until an administrator removes them.
    return { domain, mailbox, incoming: flag(row.incoming, 'incoming'), outgoing: flag(row.outgoing, 'outgoing'), retentionDays: int(row.retentionDays, 0, MAILX_RETENTION_MAX_DAYS, 'retentionDays') }
  })
  return { domains: unique(domains, row => row.domain, 'domain') }
}
export const MAILX_PARSERS: { [S in MailxSection]: (value: unknown) => MailxPolicies[S] } = { spam: parseMailxSpam, relay: parseMailxRelay, bcc: parseMailxBcc, marketing: parseMailxMarketing }

const iso = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const actor = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._@-]{1,128}$/.test(value)
/** Saved file validation; anything else needs review, never a default. */
export function readMailxStored<S extends MailxSection>(section: S, raw: unknown): MailxStored<S> {
  const keys = section === 'relay' ? ['section', 'policy', 'secret', 'updatedAt', 'updatedBy'] : ['section', 'policy', 'updatedAt', 'updatedBy']
  const value = exact(raw, keys, 'stored')
  if (value.section !== section || !iso(value.updatedAt) || !actor(value.updatedBy)) bad('stored')
  const policy = MAILX_PARSERS[section](value.policy) as MailxPolicies[S]
  if (section !== 'relay') return { section, policy, updatedAt: value.updatedAt as string, updatedBy: value.updatedBy as string }
  const secret = value.secret === null ? null : exact(value.secret, ['password', 'version'], 'secret')
  if (secret && (!isMailxRelayPassword(secret.password) || typeof secret.version !== 'string' || !/^[0-9a-f-]{36}$/.test(secret.version))) bad('secret')
  const relay = policy as MailxRelayPolicy
  if (!!secret !== (relay.username !== null)) bad('secret')
  return { section, policy, secret: secret as MailxRelaySecret | null, updatedAt: value.updatedAt as string, updatedBy: value.updatedBy as string }
}
export function readMailxArchiveStored(accountId: string, raw: unknown): MailxArchiveStored {
  const value = exact(raw, ['accountId', 'policy', 'updatedAt', 'updatedBy'], 'stored')
  if (value.accountId !== accountId || !iso(value.updatedAt) || !actor(value.updatedBy)) bad('stored')
  return { accountId, policy: parseMailxArchive(value.policy), updatedAt: value.updatedAt as string, updatedBy: value.updatedBy as string }
}
/** Revisions never hash a password: a secret change rotates its random version instead. */
export const mailxRevision = (namespace: string, stored: unknown): string => {
  const safe = object(stored) && object(stored.secret) ? { ...stored, secret: { version: stored.secret.version } } : stored
  return createHash('sha256').update(`xpanel-mailx:${namespace}\0`).update(JSON.stringify(safe ?? null)).digest('hex')
}

export interface MailxSaved {
  sections: { [S in MailxSection]: MailxStored<S> | null }
  archives: MailxArchiveStored[]
}
/** One value for the whole saved state, so the agent applies exactly what the API just wrote. */
export const mailxCompositeRevision = (saved: MailxSaved): string =>
  mailxRevision('composite', { sections: Object.fromEntries(MAILX_SECTIONS.map(section => [section, mailxRevision(section, saved.sections[section])])), archives: [...saved.archives].sort((a, b) => a.accountId.localeCompare(b.accountId)).map(item => [item.accountId, mailxRevision('archive', item)]) })

export interface MailxFile { path: string; content: string; mode: number; owner: 'root'; group: 'root' | 'postfix' }
export interface MailxPostfixPlan { settings: Record<string, string>; files: MailxFile[]; conflicts: { accountId: string; domain: string; direction: 'incoming' | 'outgoing' }[] }
const map = (path: string, lines: string[], mode = 0o640, group: MailxFile['group'] = 'postfix'): MailxFile => ({ path, content: `${MAILX_MARKER}\n${lines.map(line => line + '\n').join('')}`, mode, owner: 'root', group })

/** Postfix parameters and owned lookup tables for every saved section; archive rules never override an administrator rule. */
export function renderMailxPostfix(saved: MailxSaved): MailxPostfixPlan {
  const settings: Record<string, string> = {}, files: MailxFile[] = [], conflicts: MailxPostfixPlan['conflicts'] = []
  const relay = saved.sections.relay
  if (relay) {
    const policy = relay.policy, active = policy.enabled && policy.host !== null, next = active ? `[${policy.host}]:${policy.port}` : ''
    const auth = active && policy.username !== null && !!relay.secret
    settings.relayhost = next
    settings.smtp_sasl_auth_enable = auth ? 'yes' : 'no'
    settings.smtp_sasl_password_maps = auth ? `texthash:${MAILX_MAPS.relaySasl}` : ''
    settings.smtp_sasl_security_options = 'noanonymous'
    settings.smtp_sasl_tls_security_options = 'noanonymous'
    // The relay requires TLS through its own policy entry; other destinations keep the global smtp_tls_security_level.
    settings.smtp_tls_policy_maps = active ? `texthash:${MAILX_MAPS.relayTls}` : ''
    files.push(map(MAILX_MAPS.relaySasl, auth ? [`${next} ${policy.username}:${relay.secret!.password}`] : [], 0o600, 'root'))
    files.push(map(MAILX_MAPS.relayTls, active ? [`${next} encrypt`] : []))
  }
  const bcc = saved.sections.bcc
  const archives = [...saved.archives].sort((a, b) => a.accountId.localeCompare(b.accountId))
  if (bcc || archives.some(item => item.policy.domains.some(row => row.incoming || row.outgoing))) {
    const recipient = new Map((bcc?.policy.recipient ?? []).map(rule => [rule.match, rule.copyTo])), sender = new Map((bcc?.policy.sender ?? []).map(rule => [rule.match, rule.copyTo]))
    for (const archive of archives) for (const row of archive.policy.domains) for (const [direction, enabled, table] of [['incoming', row.incoming, recipient], ['outgoing', row.outgoing, sender]] as const) {
      if (!enabled) continue
      if (table.has('@' + row.domain)) conflicts.push({ accountId: archive.accountId, domain: row.domain, direction })
      else table.set('@' + row.domain, row.mailbox)
    }
    if (bcc) settings.always_bcc = bcc.policy.alwaysBcc ?? ''
    settings.recipient_bcc_maps = `texthash:${MAILX_MAPS.recipientBcc}`
    settings.sender_bcc_maps = `texthash:${MAILX_MAPS.senderBcc}`
    files.push(map(MAILX_MAPS.recipientBcc, [...recipient].map(([key, value]) => `${key} ${value}`)), map(MAILX_MAPS.senderBcc, [...sender].map(([key, value]) => `${key} ${value}`)))
  }
  const marketing = saved.sections.marketing?.policy
  if (marketing) Object.assign(settings, {
    smtpd_client_message_rate_limit: String(marketing.messageRateLimit), smtpd_client_recipient_rate_limit: String(marketing.recipientRateLimit),
    smtpd_recipient_limit: String(marketing.recipientsPerMessage), default_destination_rate_delay: `${marketing.destinationRateDelay}s`,
    default_destination_concurrency_limit: String(marketing.destinationConcurrency), anvil_rate_time_unit: `${marketing.rateWindow}s`,
  })
  return { settings, files, conflicts }
}

export type MailxEngine = 'rspamd' | 'spamassassin'
export const MAILX_RSPAMD_FILES = { actions: '/etc/rspamd/local.d/actions.conf', greylist: '/etc/rspamd/local.d/greylist.conf', multimap: '/etc/rspamd/local.d/multimap.conf', blocked: '/etc/rspamd/local.d/xpanel_blocked_domains.map' } as const
export const MAILX_SPAMASSASSIN_DIRS = ['/etc/spamassassin', '/etc/mail/spamassassin'] as const
const half = (value: number): string => Number.isInteger(value) ? value.toFixed(1) : String(value)
/** rspamd local.d overrides (actions: a null action is disabled) or one SpamAssassin site file; reject/greylist have no SpamAssassin equivalent. */
export function renderMailxSpam(policy: MailxSpamPolicy, engine: MailxEngine, spamAssassinDir?: string): MailxFile[] {
  if (engine === 'spamassassin') {
    if (!spamAssassinDir || !(MAILX_SPAMASSASSIN_DIRS as readonly string[]).includes(spamAssassinDir)) return bad('spamAssassinDir')
    // Mail Assassin Conf: required_score marks spam; blacklist_from (an alias of 4.x blocklist_from) adds a large score.
    return [map(`${spamAssassinDir}/90-xpanel.cf`, policy.enabled ? [`required_score ${half(policy.headerScore)}`, ...policy.blockedDomains.map(domain => `blacklist_from *@${domain}`)] : [], 0o644, 'root')]
  }
  const action = (value: number | null): string => policy.enabled && value !== null ? half(value) : 'null'
  return [
    map(MAILX_RSPAMD_FILES.actions, [`reject = ${action(policy.rejectScore)};`, `add_header = ${action(policy.headerScore)};`, `greylist = ${action(policy.greylistScore)};`], 0o644, 'root'),
    map(MAILX_RSPAMD_FILES.greylist, [`enabled = ${policy.enabled && policy.greylistScore !== null};`], 0o644, 'root'),
    map(MAILX_RSPAMD_FILES.blocked, policy.enabled ? policy.blockedDomains : [], 0o644, 'root'),
    map(MAILX_RSPAMD_FILES.multimap, ['XPANEL_BLOCKED_SENDER_DOMAIN {', '  type = "from";', '  filter = "email:domain";', `  map = "${MAILX_RSPAMD_FILES.blocked}";`, '  prefilter = true;', '  action = "reject";', '  description = "Sender domains blocked by the server administrator";', '}'], 0o644, 'root'),
  ]
}
export const isMailxManagedText = (content: string | null): boolean => content === null || content.startsWith(MAILX_MARKER + '\n')
export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/**
 * Saved mailbox spam preferences (written by the xMail spam preferences route). The sender allowlist and a
 * mailbox's own on/off and header score go to the rspamd settings file; blocked senders and moving flagged
 * mail to Junk go to the mailbox's Sieve policy script, which the reconciler renders before its own filters.
 */
export interface MailxMailboxSpam { mailbox: string; accountId: string; serviceUserId: string; inherit: boolean; enabled: boolean; addHeaderScore: number; allowlist: string[]; blocklist: string[]; spamBoxEnabled: boolean }
// The same exact-address grammar the preference route accepts; `"` and `\` can never reach the rendered UCL string.
const SENDER = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/
const senders = (value: unknown, field: string): string[] => unique(list(value, 100, field).map(item => typeof item === 'string' && item.length <= 254 && SENDER.test(item) ? item : bad(field)), item => item, field)
export function readMailxMailboxSpam(raw: unknown): MailxMailboxSpam {
  const value = exact(raw, ['inherit', 'enabled', 'addHeaderScore', 'spamBoxEnabled', 'allowlist', 'blocklist', 'mailbox', 'ownerAuthority', 'updatedAt'], 'mailboxSpam')
  const owner = exact(value.ownerAuthority, ['accountId', 'serviceUserId', 'mailbox'], 'ownerAuthority')
  const mailbox = address(value.mailbox, 'mailbox')
  if (owner.mailbox !== mailbox || typeof owner.accountId !== 'string' || typeof owner.serviceUserId !== 'string' || !iso(value.updatedAt)) bad('ownerAuthority')
  const score = value.addHeaderScore
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) bad('addHeaderScore')
  return { mailbox, accountId: owner.accountId as string, serviceUserId: owner.serviceUserId as string, inherit: flag(value.inherit, 'inherit'), enabled: flag(value.enabled, 'enabled'),
    addHeaderScore: score as number, allowlist: senders(value.allowlist, 'allowlist'), blocklist: senders(value.blocklist, 'blocklist'), spamBoxEnabled: flag(value.spamBoxEnabled, 'spamBoxEnabled') }
}
export const MAILX_RSPAMD_SETTINGS = '/etc/rspamd/local.d/settings.conf'
const ucl = (text: string): string => `"${text}"`
/**
 * rspamd settings module rules keyed by recipient: `want_spam = yes` skips spam checks (allowlisted senders, or a
 * mailbox that turned filtering off); `apply { actions { add_header } }` replaces the header score for that recipient.
 */
export function renderMailxMailboxSettings(rows: readonly MailxMailboxSpam[]): MailxFile {
  const lines: string[] = []
  ;[...rows].sort((a, b) => a.mailbox.localeCompare(b.mailbox)).forEach((row, index) => {
    const name = `xpanel_mailbox_${index + 1}`, custom = !row.inherit
    if (row.allowlist.length) lines.push(`${name}_allow {`, '  priority = high;', `  rcpt = ${ucl(row.mailbox)};`, `  from = [${row.allowlist.map(ucl).join(', ')}];`, '  want_spam = yes;', '}')
    if (custom && !row.enabled) lines.push(`${name}_off {`, '  priority = medium;', `  rcpt = ${ucl(row.mailbox)};`, '  want_spam = yes;', '}')
    else if (custom && row.addHeaderScore > 0 && Number.isInteger(row.addHeaderScore * 2)) lines.push(`${name}_score {`, '  priority = low;', `  rcpt = ${ucl(row.mailbox)};`, `  apply { actions { add_header = ${half(row.addHeaderScore)}; } }`, '}')
  })
  return map(MAILX_RSPAMD_SETTINGS, lines, 0o644, 'root')
}
export type MailxMailboxEffect = 'allowlist' | 'filtering' | 'score' | 'blocklist' | 'spamBox'
/** What a mailbox preference changes natively. An inherited preference keeps only its sender lists: the account policy has no native writer. */
export const mailxMailboxEffects = (row: MailxMailboxSpam): Record<MailxMailboxEffect, boolean> => ({
  allowlist: row.allowlist.length > 0, filtering: !row.inherit && !row.enabled, score: !row.inherit && row.enabled && row.addHeaderScore > 0 && Number.isInteger(row.addHeaderScore * 2),
  blocklist: row.blocklist.length > 0, spamBox: !row.inherit && row.enabled && row.spamBoxEnabled })
