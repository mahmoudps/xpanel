// Postfix (virtual domains, LMTP to Dovecot) and Dovecot 2.3 (passwd-file per domain,
// count quota, Pigeonhole Sieve). Mail is stored in the owning account's home and
// written with the account uid, so the account's disk quota covers it.
import type { ConfigTest, HostAction, Limit, OsProfile, RenderedFile } from '@xpanel/core'
import { MAX_ACCOUNT_UID, MIN_ACCOUNT_UID, isUnlimited } from '@xpanel/core'
import { DEFAULT_TTL, validateRecord, type ZoneRecord } from './dns.ts'
import {
  assertAbsPath,
  assertAccount,
  assertInt,
  assertLine,
  assertNoControl,
  assertString,
  assertWellFormed,
  invalid,
  normalizeEmail,
  normalizeHostedEmail,
  normalizeHostname,
  normalizeMailboxLocal,
  type AccountRef,
} from './validate.ts'

// ---- inputs -----------------------------------------------------------------------------

export interface MailboxInput {
  local: string
  /** Dovecot scheme-prefixed hash, e.g. {ARGON2ID}$argon2id$v=19$... */
  passwordHash: string
  quotaMb: Limit
  /** passdb nologin: IMAP/POP/SMTP-AUTH refused, delivery continues */
  suspendLogin?: boolean
  /** RCPT rejected at SMTP time */
  suspendIncoming?: boolean
}

export interface ForwarderInput {
  local: string
  to: string[]
}

/** What happens to mail for unknown local parts (cPanel's "default address"). */
export type DefaultAddress = { kind: 'reject' } | { kind: 'forward'; to: string[] } | { kind: 'discard' }

export interface MailDomainInput {
  domain: string
  account: AccountRef
  mailboxes: MailboxInput[]
  forwarders?: ForwarderInput[]
  defaultAddress?: DefaultAddress
  /** core suspensionEffects 'mail-login': 'denied' turns every mailbox of the domain to nologin */
  login?: 'allowed' | 'denied'
  /** core suspensionEffects 'mail-delivery': 'defer' answers 450 for the whole domain so senders retry */
  delivery?: 'accept' | 'defer'
}

export const MAX_FORWARD_TARGETS = 50
export const MAX_MAILBOX_QUOTA_MB = 16 * 1024 * 1024

// ---- password hashes ----------------------------------------------------------------------

const B64 = '[A-Za-z0-9+/]'
const CRYPT = '[./A-Za-z0-9]'
const HASH_RES: Record<string, RegExp> = {
  ARGON2ID: new RegExp(`^\\$argon2id\\$v=19\\$m=\\d{1,7},t=\\d{1,3},p=\\d{1,3}\\$${B64}{11,64}\\$${B64}{16,128}$`),
  ARGON2I: new RegExp(`^\\$argon2i\\$v=19\\$m=\\d{1,7},t=\\d{1,3},p=\\d{1,3}\\$${B64}{11,64}\\$${B64}{16,128}$`),
  'SHA512-CRYPT': new RegExp(`^\\$6\\$(?:rounds=\\d{1,9}\\$)?${CRYPT}{1,16}\\$${CRYPT}{86}$`),
  'BLF-CRYPT': new RegExp(`^\\$2[aby]\\$\\d{2}\\$${CRYPT}{53}$`),
}

export const DOVECOT_HASH_SCHEMES = Object.keys(HASH_RES)

/** Accepts only known schemes with a strict body, so ':' or whitespace can never reach the file. */
export const assertDovecotHash = (v: unknown): string => {
  const s = assertString('password hash', v, 512)
  const m = /^\{([A-Z0-9-]+)\}(.+)$/.exec(s)
  const re = m ? HASH_RES[m[1] as string] : undefined
  if (!m || !re) return invalid('password hash', '[redacted]', `must be {${DOVECOT_HASH_SCHEMES.join('|')}}<hash>`)
  if (!re.test(m[2] as string)) return invalid('password hash', '[redacted]', `is not a well-formed ${m[1]} hash`)
  return s
}

// ---- Dovecot passwd-file ------------------------------------------------------------------

/** Dovecot reads a 0 limit as unlimited, so 'unlimited' is written as 0 and a numeric quota starts at 1 MB. */
export const quotaRuleValue = (quotaMb: Limit): string => {
  if (isUnlimited(quotaMb)) return '0'
  return `${assertInt('mailbox quota (MB)', quotaMb, 1, MAX_MAILBOX_QUOTA_MB)}M`
}

/**
 * `user@domain:{SCHEME}hash:uid:gid::home::userdb_mail=maildir:~/mail/<domain>/<local> userdb_quota_rule=*:storage=<n>M`
 * uid/gid are the account's, so LMTP delivery writes as the account inside its home.
 */
export const dovecotPasswdLine = (account: AccountRef, domain: string, m: MailboxInput): string => {
  const a = assertAccount(account)
  const d = normalizeHostname(domain, 'mail domain')
  const local = normalizeMailboxLocal(m.local, 'mailbox')
  const hash = assertDovecotHash(m.passwordHash)
  const extra = [`userdb_mail=maildir:~/mail/${d}/${local}`, `userdb_quota_rule=*:storage=${quotaRuleValue(m.quotaMb)}`]
  if (m.suspendLogin) extra.push('nologin=y', 'reason=suspended')
  return `${local}@${d}:${hash}:${a.uid}:${a.gid}::${a.home}::${extra.join(' ')}`
}

export interface DovecotOptions {
  /** group the auth process reads passwd-files as (both families ship `dovecot`) */
  dovecotGroup?: string
}

const assertGroupName = (g: string): string =>
  /^[a-z_][a-z0-9_-]{0,31}$/.test(g) ? g : invalid('group name', g, 'is not a valid group name')

export const dovecotDomainsDir = (os: OsProfile): string => `${assertAbsPath('dovecot dir', os.paths.dovecotDir)}/xpanel/domains`

/**
 * Per-domain passwd-file at <dovecotDir>/xpanel/domains/<domain>.passwd. The `.passwd`
 * suffix means a hostile `%d` such as `..` can only ever name a non-existent file.
 */
export const dovecotPasswdFile = (os: OsProfile, input: MailDomainInput, o: DovecotOptions = {}): RenderedFile => {
  const domain = normalizeHostname(input.domain, 'mail domain')
  const login = input.login ?? 'allowed'
  if (login !== 'allowed' && login !== 'denied') return invalid('mail login state', login, 'must be allowed or denied')
  const seen = new Set<string>()
  const lines = input.mailboxes.map((m) => {
    const line = dovecotPasswdLine(input.account, domain, login === 'denied' ? { ...m, suspendLogin: true } : m)
    const user = line.slice(0, line.indexOf(':'))
    if (seen.has(user)) invalid('mailbox', user, 'is listed twice')
    seen.add(user)
    return line
  })
  lines.sort()
  return {
    path: `${dovecotDomainsDir(os)}/${domain}.passwd`,
    content: `# managed by xPanel: mailboxes of ${domain}\n${lines.map((l) => `${l}\n`).join('')}`,
    mode: 0o640,
    owner: 'root',
    group: assertGroupName(o.dovecotGroup ?? 'dovecot'),
  }
}

// ---- Postfix lookup tables ------------------------------------------------------------------

export type PostfixMapType = 'texthash' | 'hash' | 'lmdb'

export interface PostfixOptions {
  /** texthash needs no postmap and no DB library (CentOS Stream 10 dropped Berkeley DB) */
  mapType?: PostfixMapType
  /**
   * Group that may read the lookup tables (both families ship `postfix`). Postfix opens
   * them as root before dropping privileges, so accounts never need to read them: the
   * tables list every hosted address on the server.
   */
  postfixGroup?: string
}

export const DISCARD_DOMAIN = 'xpanel-discard.invalid'
export const DISCARD_ADDRESS = `discard@${DISCARD_DOMAIN}`
/** Owner of `@domain` sender entries for domains without mailboxes, so nobody can claim them. */
export const NO_SENDER = 'nobody@xpanel-sender.invalid'

export const postfixMapPaths = (os: OsProfile) => {
  const dir = `${assertAbsPath('postfix dir', os.paths.postfixDir)}/xpanel`
  return {
    dir,
    domains: `${dir}/virtual_domains`,
    mailboxes: `${dir}/virtual_mailboxes`,
    aliases: `${dir}/virtual_aliases`,
    senders: `${dir}/sender_logins`,
    transport: `${dir}/transport`,
    recipientAccess: `${dir}/recipient_access`,
  }
}

const mapTypeOf = (o: PostfixOptions): PostfixMapType => {
  const t = o.mapType ?? 'texthash'
  return t === 'texthash' || t === 'hash' || t === 'lmdb' ? t : invalid('postfix map type', t, 'must be texthash, hash or lmdb')
}

const targetsOf = (what: string, to: unknown): string[] => {
  if (!Array.isArray(to) || to.length === 0) return invalid(what, to, 'needs at least one destination')
  if (to.length > MAX_FORWARD_TARGETS) return invalid(what, to.length, `allows at most ${MAX_FORWARD_TARGETS} destinations`)
  return [...new Set(to.map((t) => normalizeEmail(t, `${what} destination`).address))]
}

const renderMap = (entries: Map<string, string>): string =>
  [...entries.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}\t${v}\n`)
    .join('')

interface DomainMaps {
  domain: string
  mailboxes: Map<string, string>
  aliases: Map<string, string>
  senders: Map<string, string>
  access: Map<string, string>
  discards: boolean
}

const domainMaps = (input: MailDomainInput): DomainMaps => {
  assertAccount(input.account)
  const domain = normalizeHostname(input.domain, 'mail domain')
  const delivery = input.delivery ?? 'accept'
  if (delivery !== 'accept' && delivery !== 'defer') return invalid('mail delivery state', delivery, 'must be accept or defer')
  const mailboxes = new Map<string, string>()
  const access = new Map<string, string>()
  // access(5) matches a bare domain key exactly (parent_domain_matches_subdomains leaves
  // smtpd_access_maps out since compatibility_level 2), so a hosted subdomain is unaffected
  if (delivery === 'defer') access.set(domain, '450 4.2.1 mailbox temporarily unavailable, try again later')
  for (const m of input.mailboxes) {
    const addr = `${normalizeMailboxLocal(m.local, 'mailbox')}@${domain}`
    if (mailboxes.has(addr)) invalid('mailbox', addr, 'is listed twice')
    mailboxes.set(addr, 'OK')
    // a full-address entry would win over the domain key, so deferral covers suspended mailboxes too
    if (m.suspendIncoming && delivery === 'accept') access.set(addr, 'REJECT 5.2.1 mailbox is not accepting mail')
  }
  const owners = [...mailboxes.keys()].sort()
  const aliases = new Map<string, string>()
  const senders = new Map<string, string>()
  for (const a of owners) senders.set(a, a)
  for (const f of input.forwarders ?? []) {
    const src = `${normalizeMailboxLocal(f.local, 'forwarder')}@${domain}`
    if (aliases.has(src)) invalid('forwarder', src, 'is listed twice')
    const targets = targetsOf(`forwarder ${src}`, f.to)
    // forwarding an existing mailbox keeps a copy in it
    if (mailboxes.has(src) && !targets.includes(src)) targets.unshift(src)
    aliases.set(src, targets.join(','))
    if (!senders.has(src)) senders.set(src, owners.length ? owners.join(',') : NO_SENDER)
  }
  const def = input.defaultAddress ?? { kind: 'reject' }
  let discards = false
  if (def.kind === 'forward' || def.kind === 'discard') {
    // virtual_alias_maps is consulted before mailbox lookup: without identity entries a
    // catch-all would swallow mail for real mailboxes (Postfix VIRTUAL_README)
    for (const a of owners) if (!aliases.has(a)) aliases.set(a, a)
    if (def.kind === 'forward') aliases.set(`@${domain}`, targetsOf('default address', def.to).join(','))
    else {
      aliases.set(`@${domain}`, DISCARD_ADDRESS)
      discards = true
    }
  } else if (def.kind !== 'reject') {
    invalid('default address', (def as { kind: unknown }).kind, 'must be reject, forward or discard')
  }
  senders.set(`@${domain}`, owners.length ? owners.join(',') : NO_SENDER)
  return { domain, mailboxes, aliases, senders, access, discards }
}

export interface PostfixMaps {
  files: RenderedFile[]
  actions: HostAction[]
}

/** All lookup tables for every hosted mail domain on the server. */
export const renderPostfixMaps = (os: OsProfile, domains: MailDomainInput[], o: PostfixOptions = {}): PostfixMaps => {
  const type = mapTypeOf(o)
  const p = postfixMapPaths(os)
  const all = domains.map(domainMaps)
  const names = new Set<string>()
  for (const d of all) {
    if (names.has(d.domain)) invalid('mail domain', d.domain, 'is listed twice')
    names.add(d.domain)
  }
  const merge = (pick: (d: DomainMaps) => Map<string, string>): Map<string, string> =>
    new Map(all.flatMap((d) => [...pick(d).entries()]))
  const transport = new Map<string, string>()
  if (all.some((d) => d.discards)) transport.set(DISCARD_DOMAIN, 'discard:default-address')
  const group = assertGroupName(o.postfixGroup ?? 'postfix')
  const header = (what: string): string => `# managed by xPanel: ${what}\n`
  const file = (path: string, what: string, entries: Map<string, string>): RenderedFile => ({
    path,
    content: header(what) + renderMap(entries),
    mode: 0o640,
    owner: 'root',
    group,
  })
  const files = [
    file(p.domains, 'virtual mailbox domains', new Map([...names].map((n) => [n, 'OK']))),
    file(p.mailboxes, 'virtual mailboxes', merge((d) => d.mailboxes)),
    file(p.aliases, 'forwarders and default addresses', merge((d) => d.aliases)),
    file(p.senders, 'sender login ownership', merge((d) => d.senders)),
    file(p.transport, 'transports', transport),
    file(p.recipientAccess, 'suspended and deferred recipients', merge((d) => d.access)),
  ]
  // the directory also hides the .db/.lmdb files postmap creates with its own mode
  const actions: HostAction[] = [{ kind: 'ensure-dir', path: p.dir, mode: 0o750, owner: 'root', group }]
  if (type !== 'texthash') actions.push(...files.map((f): HostAction => ({ kind: 'exec', argv: ['postmap', `${type}:${f.path}`] })))
  actions.push({ kind: 'systemd', verb: 'reload', unit: os.services.postfix })
  return { files, actions }
}

// ---- Postfix main.cf ------------------------------------------------------------------------

export interface PostfixMainOptions extends PostfixOptions {
  /** fullchain/privkey for smtpd; omit to leave TLS settings alone */
  tls?: { certFile: string; keyFile: string }
  messageSizeLimitMb?: number
}

/** Postfix's compiled-in mailbox_size_limit; local(8) refuses to start when it is below message_size_limit. */
const POSTFIX_DEFAULT_MAILBOX_LIMIT = 51_200_000

/** main.cf parameters; apply with postconfAction (main.cf has no include mechanism). */
export const postfixMainSettings = (os: OsProfile, o: PostfixMainOptions = {}): Record<string, string> => {
  const t = mapTypeOf(o)
  const p = postfixMapPaths(os)
  const size = assertInt('message size limit (MB)', o.messageSizeLimitMb ?? 50, 1, 2048) * 1024 * 1024
  const settings: Record<string, string> = {
    virtual_mailbox_domains: `${t}:${p.domains}`,
    virtual_mailbox_maps: `${t}:${p.mailboxes}`,
    virtual_alias_maps: `${t}:${p.aliases}`,
    virtual_transport: 'lmtp:unix:private/dovecot-lmtp',
    transport_maps: `${t}:${p.transport}`,
    recipient_delimiter: '+',
    message_size_limit: String(size),
    // Debian ships mailbox_size_limit = 0, EL keeps the default, which is below 50 MB
    mailbox_size_limit: String(Math.max(POSTFIX_DEFAULT_MAILBOX_LIMIT, size)),
    smtpd_sasl_auth_enable: 'yes',
    smtpd_sasl_type: 'dovecot',
    smtpd_sasl_path: 'private/auth',
    smtpd_sender_login_maps: `${t}:${p.senders}`,
    // authenticated clients only: a hosted MAIL FROM arriving unauthenticated on port 25
    // (forwards, lists, third-party senders) is SPF/DMARC's call, not a login mismatch
    smtpd_sender_restrictions: 'reject_authenticated_sender_login_mismatch',
    // stated explicitly so relaying never depends on the distribution's compatibility_level
    smtpd_relay_restrictions: 'permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination',
    smtpd_recipient_restrictions: `check_recipient_access ${t}:${p.recipientAccess}`,
  }
  if (o.tls) {
    settings.smtpd_tls_cert_file = assertAbsPath('TLS certificate', o.tls.certFile)
    settings.smtpd_tls_key_file = assertAbsPath('TLS key', o.tls.keyFile)
    settings.smtpd_tls_security_level = 'may'
    settings.smtpd_tls_auth_only = 'yes'
  }
  return settings
}

export const renderPostfixMainFragment = (settings: Record<string, string>): string =>
  `# managed by xPanel\n${Object.entries(settings)
    .map(([k, v]) => `${assertPostconfKey(k)} = ${assertNoControl(`main.cf ${k}`, v)}\n`)
    .join('')}`

const assertPostconfKey = (k: string): string => (/^[a-z][a-z0-9_]{0,63}$/.test(k) ? k : invalid('main.cf parameter', k, 'is not a parameter name'))

/** `postconf -c <dir> -e k=v ...` as argv, no shell. */
export const postconfAction = (os: OsProfile, settings: Record<string, string>): HostAction => ({
  kind: 'exec',
  argv: [
    'postconf',
    '-c',
    assertAbsPath('postfix dir', os.paths.postfixDir),
    '-e',
    ...Object.entries(settings).map(([k, v]) => `${assertPostconfKey(k)}=${assertNoControl(`main.cf ${k}`, v)}`),
  ],
})

/**
 * master.cf services for mail clients (RFC 8314): 587 with STARTTLS and 465 with implicit
 * TLS, both SASL-only, while port 25 stays for server-to-server mail. They need the smtpd
 * certificate from postfixMainSettings `tls`, or every client connection is refused.
 */
export const postfixClientServices = (os: OsProfile): HostAction[] => {
  const dir = assertAbsPath('postfix dir', os.paths.postfixDir)
  const saslOnly = 'permit_sasl_authenticated,reject'
  const service = (port: '587' | '465', name: string, extra: Record<string, string>): HostAction[] => {
    const params: Record<string, string> = {
      syslog_name: `postfix/${name}`,
      smtpd_tls_security_level: 'encrypt',
      smtpd_sasl_auth_enable: 'yes',
      smtpd_client_restrictions: saslOnly,
      smtpd_relay_restrictions: saslOnly,
      ...extra,
    }
    return [
      { kind: 'exec', argv: ['postconf', '-c', dir, '-e', '-M', `${port}/inet=${port} inet n - n - - smtpd`] },
      { kind: 'exec', argv: ['postconf', '-c', dir, '-e', '-P', ...Object.entries(params).map(([k, v]) => `${port}/inet/${k}=${v}`)] },
    ]
  }
  return [...service('587', 'submission', {}), ...service('465', 'submissions', { smtpd_tls_wrappermode: 'yes' })]
}

// ---- Dovecot configuration ------------------------------------------------------------------

export interface DovecotConfOptions {
  /** postmaster_address for LMTP bounces */
  postmaster: string
  /** Postfix queue directory (same on Debian and RHEL) */
  postfixSpoolDir?: string
  quotaWarningScript?: string
  tls?: { certFile: string; keyFile: string }
}

export const QUOTA_WARNING_SCRIPT = '/opt/xpanel/libexec/quota-warning'

/**
 * Replaces the distribution's conf.d/10-auth.conf so the stock PAM/system passdb
 * (auth-system.conf.ext) is gone: Linux account passwords never open IMAP.
 */
export const renderDovecotAuthConf = (os: OsProfile): RenderedFile => {
  const dir = dovecotDomainsDir(os)
  return {
    path: `${assertAbsPath('dovecot dir', os.paths.dovecotDir)}/conf.d/10-auth.conf`,
    content: `# managed by xPanel: virtual mailboxes only, one passwd-file per domain
disable_plaintext_auth = yes
auth_mechanisms = plain login
auth_username_format = %Lu
auth_username_chars = abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ01234567890.-_@

passdb {
  driver = passwd-file
  args = username_format=%Lu ${dir}/%Ld.passwd
}

userdb {
  driver = passwd-file
  args = username_format=%Lu ${dir}/%Ld.passwd
}
`,
    mode: 0o644,
    owner: 'root',
    group: 'root',
  }
}

export const renderDovecotXpanelConf = (os: OsProfile, o: DovecotConfOptions): RenderedFile => {
  const postmaster = normalizeHostedEmail(o.postmaster, 'postmaster address').address
  const spool = assertAbsPath('postfix spool dir', o.postfixSpoolDir ?? '/var/spool/postfix')
  const script = assertAbsPath('quota warning script', o.quotaWarningScript ?? QUOTA_WARNING_SCRIPT)
  const tls = o.tls
    ? `ssl = required\nssl_cert = <${assertAbsPath('TLS certificate', o.tls.certFile)}\nssl_key = <${assertAbsPath('TLS key', o.tls.keyFile)}\n`
    : ''
  return {
    path: `${assertAbsPath('dovecot dir', os.paths.dovecotDir)}/conf.d/90-xpanel.conf`,
    content: `# managed by xPanel: delivery runs as the mailbox's account uid inside its home
# mail processes only ever run as an account identity (core's account uid/gid range)
first_valid_uid = ${MIN_ACCOUNT_UID}
last_valid_uid = ${MAX_ACCOUNT_UID}
first_valid_gid = ${MIN_ACCOUNT_UID}
last_valid_gid = ${MAX_ACCOUNT_UID}
mail_plugins = $mail_plugins quota
recipient_delimiter = +
${tls}
service lmtp {
  unix_listener ${spool}/private/dovecot-lmtp {
    mode = 0600
    user = postfix
    group = postfix
  }
}

service auth {
  unix_listener ${spool}/private/auth {
    mode = 0660
    user = postfix
    group = postfix
  }
}

protocol lmtp {
  mail_plugins = $mail_plugins sieve
  postmaster_address = ${postmaster}
}

protocol imap {
  mail_plugins = $mail_plugins imap_quota
}

plugin {
  quota = count:User quota
  quota_vsizes = yes
  quota_grace = 10%%
  quota_warning = storage=95%% quota-warning 95 %u
  quota_warning2 = storage=80%% quota-warning 80 %u
  sieve = file:~/mail/%Ld/%Ln/sieve;active=~/mail/%Ld/%Ln/.dovecot.sieve
  sieve_max_script_size = 1M
  sieve_max_actions = 32
  sieve_max_redirects = ${MAX_SIEVE_REDIRECTS}
  sieve_vacation_min_period = 1d
}

# every account uid delivers, so the listener is world-connectable; the script only
# validates its arguments and queues a notice with sendmail as an unprivileged user
service quota-warning {
  executable = script ${script}
  user = dovecot
  unix_listener quota-warning {
    mode = 0666
  }
}
`,
    mode: 0o644,
    owner: 'root',
    group: 'root',
  }
}

/** The quota-warning script: validates `<percent> <user@domain>` then queues a notice. */
export const renderQuotaWarningScript = (o: { from: string; path?: string; sendmail?: string }): RenderedFile => {
  const from = normalizeHostedEmail(o.from, 'quota warning sender').address
  const sendmail = assertAbsPath('sendmail path', o.sendmail ?? '/usr/sbin/sendmail')
  return {
    path: assertAbsPath('quota warning script', o.path ?? QUOTA_WARNING_SCRIPT),
    content: `#!/bin/sh
# managed by xPanel; Dovecot runs: quota-warning <percent> <user@domain>
set -eu
percent=\${1:-}
rcpt=\${2:-}
case $percent in ''|*[!0-9]*) exit 0 ;; esac
case $rcpt in ''|-*|*[!a-z0-9@._-]*) exit 0 ;; esac
case $rcpt in *@*) ;; *) exit 0 ;; esac
'${sendmail}' -i -f '${from}' -- "$rcpt" <<EOF
From: Mail System <${from}>
To: <$rcpt>
Subject: Your mailbox is $percent% full
Auto-Submitted: auto-generated
Content-Type: text/plain; charset=UTF-8

The mailbox $rcpt is $percent% full.
Delete old messages or ask your provider for a larger quota.
EOF
`,
    mode: 0o755,
    owner: 'root',
    group: 'root',
  }
}

/** Checks the reconciler runs before activating a mail config generation. */
export const mailConfigTests = (os: OsProfile): ConfigTest[] => [
  { name: 'postfix', argv: ['postfix', '-c', assertAbsPath('postfix dir', os.paths.postfixDir), 'check'] },
  { name: 'dovecot', argv: ['doveconf', '-n', '-c', `${assertAbsPath('dovecot dir', os.paths.dovecotDir)}/dovecot.conf`] },
]

// ---- Sieve ------------------------------------------------------------------------------------

export const MAX_SIEVE_REDIRECTS = 4
export const MAX_FILTERS = 200

/** RFC 5228 quoted string; never emits variables/encoded-character expansions (not required). */
export const sieveQuote = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

const sieveLine = (what: string, v: unknown, max: number): string => sieveQuote(assertLine(what, v, max))

const sieveText = (what: string, v: unknown, max: number): string => {
  const s = assertWellFormed(what, assertString(what, v, max)).replace(/\r\n/g, '\n')
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(s)) return invalid(what, '', 'contains control characters')
  return sieveQuote(s)
}

const FOLDER_SEG_RE = /^[\p{L}\p{N}_&-](?:[\p{L}\p{N} _&-]{0,62}[\p{L}\p{N}_&-])?$/u

export const assertFolder = (v: unknown): string => {
  const s = assertLine('folder', v, 255)
  const segs = s.split('.')
  if (segs.some((seg) => !FOLDER_SEG_RE.test(seg))) return invalid('folder', s, 'segments may contain letters, digits, space, _ & - separated by "."')
  return s
}

export interface VacationInput {
  subject: string
  body: string
  /** must be one of the mailbox's own addresses */
  from?: string
  /** minimum days between replies to the same sender */
  days?: number
  /** other addresses (aliases) that count as "to me" */
  addresses?: string[]
  /** inclusive YYYY-MM-DD bounds, server time */
  start?: string
  end?: string
}

export type MatchOp = 'contains' | 'is' | 'matches' | 'begins' | 'ends' | 'regex'
export type HeaderField = 'from' | 'to' | 'cc' | 'subject' | 'reply-to' | 'list-id'

export type FilterTest =
  | { field: HeaderField; op: MatchOp; value: string; not?: boolean }
  | { field: 'header'; header: string; op: MatchOp; value: string; not?: boolean }
  | { field: 'body'; op: Exclude<MatchOp, 'regex'>; value: string; not?: boolean }
  | { field: 'size'; op: 'over' | 'under'; bytes: number; not?: boolean }

export type FilterAction =
  | { kind: 'fileinto'; folder: string }
  | { kind: 'redirect'; to: string; copy?: boolean }
  | { kind: 'discard' }
  | { kind: 'reject'; message: string }
  | { kind: 'keep' }
  | { kind: 'mark-read' }
  | { kind: 'stop' }

export interface MailFilter {
  name: string
  match: 'all' | 'any'
  tests: FilterTest[]
  actions: FilterAction[]
  enabled?: boolean
}

interface SieveChunk {
  requires: Set<string>
  text: string
  redirects: number
}

const HEADER_FIELDS: readonly HeaderField[] = ['from', 'to', 'cc', 'subject', 'reply-to', 'list-id']

interface Match {
  /** match-type tag; RFC 5228 2.6.2 puts tagged arguments before positional ones */
  tag: string
  key: string
}

const matchOf = (op: MatchOp, value: unknown, req: Set<string>): Match => {
  const v = assertLine('filter value', value, 1024)
  if (v.length === 0) return invalid('filter value', v, 'is empty')
  const lit = v.replace(/[\\*?]/g, (c) => `\\${c}`)
  switch (op) {
    case 'contains':
      return { tag: ':contains', key: sieveQuote(v) }
    case 'is':
      return { tag: ':is', key: sieveQuote(v) }
    case 'matches':
      return { tag: ':matches', key: sieveQuote(v) }
    case 'begins':
      return { tag: ':matches', key: sieveQuote(`${lit}*`) }
    case 'ends':
      return { tag: ':matches', key: sieveQuote(`*${lit}`) }
    case 'regex':
      if (v.length > 256) return invalid('filter regex', v, 'is longer than 256 characters')
      try {
        new RegExp(v)
      } catch {
        return invalid('filter regex', v, 'does not compile')
      }
      req.add('regex')
      return { tag: ':regex', key: sieveQuote(v) }
    default:
      return invalid('filter operator', op, 'is not supported')
  }
}

const headerTest = (name: string, m: Match): string => `header ${m.tag} ${sieveQuote(name)} ${m.key}`

const testOf = (t: FilterTest, req: Set<string>): string => {
  let s: string
  if (t.field === 'size') {
    if (t.op !== 'over' && t.op !== 'under') return invalid('size operator', t.op, 'must be over or under')
    s = `size :${t.op} ${assertInt('size', t.bytes, 1, 2147483647)}`
  } else if (t.field === 'body') {
    if ((t.op as string) === 'regex') return invalid('body operator', t.op, 'regex is not allowed on bodies')
    req.add('body')
    const m = matchOf(t.op, t.value, req)
    s = `body :text ${m.tag} ${m.key}`
  } else if (t.field === 'header') {
    const h = assertString('header name', t.header, 64)
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(h)) return invalid('header name', h, 'is not a header field name')
    s = headerTest(h.toLowerCase(), matchOf(t.op, t.value, req))
  } else if (HEADER_FIELDS.includes(t.field)) {
    s = headerTest(t.field, matchOf(t.op, t.value, req))
  } else {
    return invalid('filter field', (t as { field: unknown }).field, 'is not supported')
  }
  return t.not ? `not ${s}` : s
}

const actionsOf = (name: string, actions: FilterAction[], req: Set<string>): { lines: string[]; redirects: number } => {
  if (!Array.isArray(actions) || actions.length === 0 || actions.length > 10) return invalid(`filter "${name}" actions`, actions, 'need 1 to 10 actions')
  const kinds = actions.map((a) => a.kind)
  if (kinds.includes('reject') && kinds.some((k) => k !== 'reject' && k !== 'stop')) {
    return invalid(`filter "${name}"`, kinds.join(','), 'reject cannot be combined with other actions')
  }
  if (kinds.includes('discard') && kinds.some((k) => ['fileinto', 'redirect', 'keep'].includes(k))) {
    return invalid(`filter "${name}"`, kinds.join(','), 'discard cannot be combined with delivery actions')
  }
  const stopAt = kinds.indexOf('stop')
  if (stopAt !== -1 && stopAt !== kinds.length - 1) return invalid(`filter "${name}"`, kinds.join(','), 'stop must be the last action')
  let redirects = 0
  const lines = actions.map((a): string => {
    switch (a.kind) {
      case 'fileinto':
        req.add('fileinto').add('mailbox')
        return `fileinto :create ${sieveQuote(assertFolder(a.folder))};`
      case 'redirect':
        redirects++
        if (a.copy) req.add('copy')
        return `redirect ${a.copy ? ':copy ' : ''}${sieveQuote(normalizeEmail(a.to, 'redirect address').address)};`
      case 'discard':
        return 'discard;'
      case 'reject':
        req.add('reject')
        return `reject ${sieveLine('reject message', a.message, 512)};`
      case 'keep':
        return 'keep;'
      case 'mark-read':
        req.add('imap4flags')
        return 'addflag "\\\\Seen";'
      case 'stop':
        return 'stop;'
      default:
        return invalid('filter action', (a as { kind: unknown }).kind, 'is not supported')
    }
  })
  // discard and reject end the script: otherwise the autoresponder would still answer the
  // discarded sender, and reject next to vacation is a runtime error (RFC 5429 2.2)
  if ((kinds.includes('discard') || kinds.includes('reject')) && stopAt === -1) lines.push('stop;')
  return { lines, redirects }
}

const filtersChunk = (filters: MailFilter[]): SieveChunk => {
  if (!Array.isArray(filters) || filters.length > MAX_FILTERS) return invalid('filters', filters, `allow at most ${MAX_FILTERS} rules`)
  const req = new Set<string>()
  let redirects = 0
  const blocks: string[] = []
  for (const f of filters) {
    if (f.enabled === false) continue
    const name = assertLine('filter name', f.name, 128)
    if (!Array.isArray(f.tests) || f.tests.length === 0 || f.tests.length > 20) return invalid(`filter "${name}" tests`, f.tests, 'need 1 to 20 tests')
    if (f.match !== 'all' && f.match !== 'any') return invalid(`filter "${name}" match`, f.match, 'must be all or any')
    const tests = f.tests.map((t) => testOf(t, req))
    const cond = tests.length === 1 ? tests[0] : `${f.match === 'all' ? 'allof' : 'anyof'}(${tests.join(', ')})`
    const acts = actionsOf(name, f.actions, req)
    redirects += acts.redirects
    blocks.push(`# rule: ${name}\nif ${cond} {\n${acts.lines.map((l) => `  ${l}`).join('\n')}\n}`)
  }
  return { requires: req, text: blocks.join('\n\n'), redirects }
}

const isoDate = (what: string, v: unknown): string => {
  const s = assertString(what, v, 10)
  const d = new Date(`${s}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    return invalid(what, s, 'must be a real YYYY-MM-DD date')
  }
  return s
}

const vacationChunk = (v: VacationInput): SieveChunk => {
  const req = new Set(['vacation'])
  const days = assertInt('vacation days', v.days ?? 1, 1, 365)
  const parts = [`vacation :days ${days}`, `:subject ${sieveLine('vacation subject', v.subject, 255)}`]
  if (v.from !== undefined) parts.push(`:from ${sieveQuote(normalizeHostedEmail(v.from, 'vacation from').address)}`)
  if (v.addresses?.length) {
    if (v.addresses.length > 50) return invalid('vacation addresses', v.addresses.length, 'allow at most 50')
    parts.push(`:addresses [${v.addresses.map((a) => sieveQuote(normalizeEmail(a, 'vacation address').address)).join(', ')}]`)
  }
  parts.push(sieveText('vacation body', v.body, 65536))
  const action = `${parts.join(' ')};`
  const conds: string[] = []
  const start = v.start !== undefined ? isoDate('vacation start', v.start) : null
  const end = v.end !== undefined ? isoDate('vacation end', v.end) : null
  if (start && end && start > end) return invalid('vacation dates', `${start}..${end}`, 'start is after end')
  if (start) conds.push(`currentdate :value "ge" "date" ${sieveQuote(start)}`)
  if (end) conds.push(`currentdate :value "le" "date" ${sieveQuote(end)}`)
  if (conds.length) req.add('date').add('relational')
  const text = conds.length === 0 ? action : `if ${conds.length === 1 ? conds[0] : `allof(${conds.join(', ')})`} {\n  ${action}\n}`
  return { requires: req, text: `# autoresponder\n${text}`, redirects: 0 }
}

/** One active script per mailbox: filters first (discard, reject and stop end it before the autoresponder), then vacation. */
export const renderSieveScript = (o: { filters?: MailFilter[]; vacation?: VacationInput | null }): string => {
  const chunks: SieveChunk[] = []
  if (o.filters?.length) chunks.push(filtersChunk(o.filters))
  if (o.vacation) chunks.push(vacationChunk(o.vacation))
  const redirects = chunks.reduce((n, c) => n + c.redirects, 0)
  if (redirects > MAX_SIEVE_REDIRECTS) return invalid('filters', redirects, `use at most ${MAX_SIEVE_REDIRECTS} redirects`)
  const req = [...new Set(chunks.flatMap((c) => [...c.requires]))].sort()
  const head = '# managed by xPanel\n'
  const body = chunks.map((c) => c.text).filter(Boolean).join('\n\n')
  return req.length ? `${head}require [${req.map(sieveQuote).join(', ')}];\n\n${body}\n` : `${head}${body ? `${body}\n` : 'keep;\n'}`
}

export const renderVacationSieve = (v: VacationInput): string => renderSieveScript({ vacation: v })
export const renderFilterSieve = (filters: MailFilter[]): string => renderSieveScript({ filters })

/**
 * Active script at ~/mail/<domain>/<local>/.dovecot.sieve, owned by the account. The
 * path is inside a user-writable tree: the writer must not follow symlinks (contractRequests).
 */
export const sieveFile = (account: AccountRef, address: string, script: string): RenderedFile => {
  const a = assertAccount(account)
  const { local, domain } = normalizeHostedEmail(address, 'mailbox')
  return {
    path: `${a.home}/mail/${domain}/${local}/.dovecot.sieve`,
    content: assertString('sieve script', script, 1024 * 1024),
    mode: 0o600,
    owner: a.username,
    group: a.username,
  }
}

// ---- DKIM -----------------------------------------------------------------------------------

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

const keyBytes = (publicKey: string): Buffer => {
  const s = assertString('DKIM public key', publicKey, 8192)
  const body = s
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body) || body.length % 4 !== 0) return invalid('DKIM public key', '', 'is not base64 or PEM')
  return Buffer.from(body, 'base64')
}

export const assertDkimSelector = (v: unknown): string => {
  const s = assertString('DKIM selector', v, 63)
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s) ? s : invalid('DKIM selector', s, 'must be one lowercase LDH label')
}

/** TXT record `<selector>._domainkey` with `v=DKIM1; k=...; p=...` (RFC 6376, RFC 8463 for ed25519). */
export const dkimDnsRecord = (
  domain: string,
  selector: string,
  publicKey: string,
  o: { keyType?: 'rsa' | 'ed25519'; ttl?: number; testing?: boolean } = {},
): ZoneRecord => {
  const zone = normalizeHostname(domain, 'DKIM domain')
  const sel = assertDkimSelector(selector)
  const keyType = o.keyType ?? 'rsa'
  let der = keyBytes(publicKey)
  if (keyType === 'ed25519') {
    if (der.length === 44 && der.subarray(0, 12).equals(ED25519_SPKI_PREFIX)) der = der.subarray(12)
    if (der.length !== 32) return invalid('DKIM ed25519 key', der.length, 'must be 32 raw bytes or an Ed25519 SPKI')
  } else if (keyType === 'rsa') {
    // SubjectPublicKeyInfo SEQUENCE; 162 bytes is a 1024-bit key, the floor RFC 8301 allows
    if (der[0] !== 0x30 || der.length < 162 || der.length > 1100) return invalid('DKIM RSA key', der.length, 'must be an RSA SubjectPublicKeyInfo of 1024-8192 bits')
  } else {
    return invalid('DKIM key type', keyType, 'must be rsa or ed25519')
  }
  const content = `v=DKIM1; k=${keyType};${o.testing ? ' t=y;' : ''} p=${der.toString('base64')}`
  return validateRecord({ zone, name: `${sel}._domainkey`, type: 'TXT', ttl: o.ttl ?? DEFAULT_TTL, content, priority: null })
}
