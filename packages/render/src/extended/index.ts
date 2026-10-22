// Extended pure, deterministic host compilers and validators for xPanel, xWHM, and xMail:
// 1. First-Run Setup, Hostname Change & Filesystem Quota Initialization
// 2. Deep Mail (Domain Forwarders, Mailing Lists, Sieve Filters, CSV Address Importer, CalDAV/CardDAV)
// 3. Operational DNS (Zone Templates, Batch DKIM/SPF/DMARC, Zone Cleanup)
// 4. Extended File & Web Isolation (Directory Privacy, Hotlink Protection, Web Disk, Git Push-to-Deploy)
// 5. Databases Beyond MariaDB (PostgreSQL, Remote Access Hosts, DB Repair, MongoDB, Redis, Memcached)
// 6. Fine-Grained Server Settings, Containers, App Store & Web Stack Profiles

import type { Account, HostAction, RenderedFile } from '@xpanel/core'
import { dbGrantPattern } from '@xpanel/core'
import { assertPhpVersion } from '../system/validate.ts'
import { accountSliceName } from '../system/slice.ts'
import { assertRedirectUrl } from '../edge/validate.ts'
import {
  assertAbsPath,
  assertAccount,
  assertInt,
  assertLine,
  assertNoControl,
  assertString,
  assertUsername,
  canonicalIpv4,
  canonicalIpv6,
  invalid,
  normalizeEmail,
  normalizeHostname,
  normalizeMailboxLocal,
} from '../services/validate.ts'
import { assertDbHost } from '../services/mariadb.ts'

// ============================================================================
// 1. First-Run Setup, Hostname Change & Filesystem Quota Initialization
// ============================================================================

/**
 * Validates FQDN and IP addresses, renders `/etc/hostname` and `/etc/hosts`,
 * and returns the `hostnamectl set-hostname` execution action.
 */
export const renderHostnameChange = (
  newHostname: string,
  ipv4: string,
  ipv6?: string | null,
): { files: RenderedFile[]; actions: HostAction[] } => {
  const fqdn = normalizeHostname(newHostname, 'hostname')
  const labels = fqdn.split('.')
  if (labels.length < 2) {
    return invalid('hostname', newHostname, 'must be a fully-qualified domain name (e.g. host.example.com)')
  }
  const shortHost = labels[0]!
  const v4 = canonicalIpv4(ipv4, 'ipv4')
  const v6 = ipv6 !== undefined && ipv6 !== null && ipv6 !== '' ? canonicalIpv6(ipv6, 'ipv6') : null

  const hostsLines = [
    '# Managed by xPanel',
    '127.0.0.1 localhost',
    '::1 localhost ip6-localhost ip6-loopback',
    `${v4} ${fqdn} ${shortHost}`,
  ]
  if (v6) {
    hostsLines.push(`${v6} ${fqdn} ${shortHost}`)
  }

  const files: RenderedFile[] = [
    {
      path: '/etc/hostname',
      content: `${fqdn}\n`,
      mode: 0o644,
      owner: 'root',
      group: 'root',
    },
    {
      path: '/etc/hosts',
      content: `${hostsLines.join('\n')}\n`,
      mode: 0o644,
      owner: 'root',
      group: 'root',
    },
  ]

  const actions: HostAction[] = [
    {
      kind: 'exec',
      argv: ['/usr/bin/hostnamectl', 'set-hostname', fqdn],
    },
  ]

  return { files, actions }
}

/**
 * Validates a quota mountpoint (`/` or `/home` / `/home0..99`) and returns
 * argv-only actions for `quotacheck` and `quotaon`.
 */
export const renderQuotaInitActions = (filesystem: string): HostAction[] => {
  const fs = assertString('filesystem', filesystem, 64)
  if (fs !== '/' && !/^\/home[1-9]?[0-9]?$/.test(fs)) {
    return invalid('filesystem', filesystem, 'must be "/" or "/home"')
  }
  return [
    { kind: 'exec', argv: ['/usr/sbin/quotacheck', '-cugm', fs] },
    { kind: 'exec', argv: ['/usr/sbin/quotaon', '-vug', fs] },
  ]
}

/**
 * Renders `/etc/logrotate.d/xpanel` covering Nginx domain logs, Apache domain logs,
 * and xPanel daemon logs.
 */
export const renderLogrotateConfig = (opts: {
  rotateDays: number
  maxSizeMb: number
  compress: boolean
}): RenderedFile => {
  if (!opts || typeof opts !== 'object') {
    return invalid('logrotate options', opts, 'is required')
  }
  const rotateDays = assertInt('rotateDays', opts.rotateDays, 1, 3650)
  const maxSizeMb = assertInt('maxSizeMb', opts.maxSizeMb, 1, 10240)
  if (typeof opts.compress !== 'boolean') {
    return invalid('compress', opts.compress, 'must be a boolean')
  }

  const compressDirectives = opts.compress ? ['  compress', '  delaycompress'] : ['  nocompress']
  const lines = [
    '# Managed by xPanel',
    '/var/log/nginx/domains/*.log /var/log/apache2/domains/*.log /var/log/xpanel/*.log {',
    '  daily',
    `  rotate ${rotateDays}`,
    `  maxsize ${maxSizeMb}M`,
    '  missingok',
    '  notifempty',
    ...compressDirectives,
    '  sharedscripts',
    '  postrotate',
    '    /bin/systemctl reload nginx.service >/dev/null 2>&1 || true',
    '    /bin/systemctl reload apache2.service >/dev/null 2>&1 || true',
    '  endscript',
    '}',
  ]

  return {
    path: '/etc/logrotate.d/xpanel',
    content: `${lines.join('\n')}\n`,
    mode: 0o644,
    owner: 'root',
    group: 'root',
  }
}

// ============================================================================
// 2. Deep Mail (Domain Forwarders, Mailing Lists, Sieve, CSV Import, CalDAV/CardDAV)
// ============================================================================

/**
 * Renders Postfix `/etc/postfix/xpanel_domain_aliases` (`@fromDomain @toDomain`)
 * and its `postmap` action.
 */
export const renderDomainForwardersMap = (
  forwarders: readonly { fromDomain: string; toDomain: string }[],
): { file: RenderedFile; action: HostAction } => {
  if (!Array.isArray(forwarders)) {
    return invalid('forwarders', forwarders, 'must be an array')
  }
  const seen = new Set<string>()
  const entries: { fromDomain: string; toDomain: string }[] = []

  for (const item of forwarders) {
    const fromDomain = normalizeHostname(item?.fromDomain, 'fromDomain')
    const toDomain = normalizeHostname(item?.toDomain, 'toDomain')
    if (fromDomain === toDomain) {
      return invalid('domain forwarder', fromDomain, 'cannot forward a domain to itself')
    }
    if (seen.has(fromDomain)) {
      return invalid('domain forwarder', fromDomain, 'duplicate source domain')
    }
    seen.add(fromDomain)
    entries.push({ fromDomain, toDomain })
  }

  entries.sort((a, b) => a.fromDomain.localeCompare(b.fromDomain))
  const lines = [
    '# Managed by xPanel: domain-wide virtual alias forwarders',
    ...entries.map((e) => `@${e.fromDomain} @${e.toDomain}`),
  ]

  const path = '/etc/postfix/xpanel_domain_aliases'
  return {
    file: {
      path,
      content: `${lines.join('\n')}\n`,
      mode: 0o644,
      owner: 'root',
      group: 'root',
    },
    action: {
      kind: 'exec',
      argv: ['/usr/sbin/postmap', path],
    },
  }
}

/**
 * Renders `/var/lib/xpanel/mailing-lists/<domain>/<name>.conf` and Postfix list alias entries.
 */
export const renderMailingListConfig = (list: {
  name: string
  domain: string
  adminEmail: string
  archivePublic: boolean
  members: readonly string[]
}): RenderedFile => {
  if (!list || typeof list !== 'object') {
    return invalid('mailing list', list, 'is required')
  }
  const name = normalizeMailboxLocal(list.name, 'mailing list name')
  const domain = normalizeHostname(list.domain, 'mailing list domain')
  const adminEmail = normalizeEmail(list.adminEmail, 'adminEmail').address
  if (typeof list.archivePublic !== 'boolean') {
    return invalid('archivePublic', list.archivePublic, 'must be a boolean')
  }
  if (!Array.isArray(list.members)) {
    return invalid('members', list.members, 'must be an array')
  }

  const members = [...new Set(list.members.map((m) => normalizeEmail(m, 'member email').address))].sort()
  const listAddress = `${name}@${domain}`

  const lines = [
    `# Managed by xPanel: mailing list ${listAddress}`,
    `list_name = ${name}`,
    `domain = ${domain}`,
    `list_address = ${listAddress}`,
    `admin_email = ${adminEmail}`,
    `archive_public = ${list.archivePublic ? 'yes' : 'no'}`,
    `# Postfix alias entries`,
    `alias_post = ${listAddress} -> ${members.length > 0 ? members.join(',') : adminEmail}`,
    `alias_owner = ${name}-owner@${domain} -> ${adminEmail}`,
    `alias_request = ${name}-request@${domain} -> ${adminEmail}`,
    `members = ${members.join(',')}`,
  ]

  return {
    path: `/var/lib/xpanel/mailing-lists/${domain}/${name}.conf`,
    content: `${lines.join('\n')}\n`,
    mode: 0o640,
    owner: 'root',
    group: 'postfix',
  }
}

const escapeSieveString = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

export interface SieveFilterRule {
  name: string
  enabled: boolean
  field: 'from' | 'to' | 'subject' | 'size' | 'spam_score'
  comparator: 'contains' | 'equals' | 'matches' | 'gt'
  value: string
  action: 'fileinto' | 'redirect' | 'discard' | 'reject'
  target?: string
}

export interface SieveVacationConfig {
  enabled: boolean
  subject: string
  body: string
  days: number
}

/**
 * Compiles a valid RFC 5228 Dovecot Pigeonhole Sieve script from structured filter rules
 * and an optional vacation autoresponder.
 */
export const renderSieveFilterScript = (
  rules: readonly SieveFilterRule[],
  vacation?: SieveVacationConfig,
): string => {
  if (!Array.isArray(rules)) {
    return invalid('sieve rules', rules, 'must be an array')
  }

  const requires = new Set<string>(['fileinto', 'reject', 'vacation'])
  const ruleBlocks: string[] = []

  for (const r of rules) {
    const ruleName = assertLine('rule name', r.name, 128)
    const val = assertLine('rule value', r.value, 512)
    if (val.length === 0) {
      return invalid('rule value', val, 'must not be empty')
    }

    if (!['from', 'to', 'subject', 'size', 'spam_score'].includes(r.field)) {
      return invalid('rule field', r.field, 'is not a supported field')
    }
    if (!['contains', 'equals', 'matches', 'gt'].includes(r.comparator)) {
      return invalid('rule comparator', r.comparator, 'is not a supported comparator')
    }
    if (!['fileinto', 'redirect', 'discard', 'reject'].includes(r.action)) {
      return invalid('rule action', r.action, 'is not a supported action')
    }

    if (!r.enabled) continue

    let testExpr: string
    if (r.field === 'size') {
      const sizeBytes = Number(val)
      if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
        return invalid('size value', val, 'must be a positive integer byte count')
      }
      const sizeOp = r.comparator === 'gt' ? ':over' : ':under'
      testExpr = `size ${sizeOp} ${sizeBytes}`
    } else {
      const headerName = r.field === 'spam_score' ? 'X-Spam-Score' : r.field
      if (r.comparator === 'gt') {
        requires.add('relational')
        requires.add('comparator-i;ascii-numeric')
        testExpr = `header :value "gt" :comparator "i;ascii-numeric" "${headerName}" "${escapeSieveString(val)}"`
      } else {
        const compTag =
          r.comparator === 'contains'
            ? ':contains'
            : r.comparator === 'equals'
              ? ':is'
              : ':matches'
        testExpr = `header ${compTag} "${headerName}" "${escapeSieveString(val)}"`
      }
    }

    let actionStmt: string
    if (r.action === 'fileinto') {
      const folder = assertLine('fileinto target', r.target, 128)
      if (!folder || /[\\"/\u0000-\u001f]/.test(folder)) {
        return invalid('fileinto target', r.target, 'must be a safe folder name')
      }
      actionStmt = `fileinto "${escapeSieveString(folder)}";`
    } else if (r.action === 'redirect') {
      const dest = normalizeEmail(r.target, 'redirect target').address
      actionStmt = `redirect "${dest}";`
    } else if (r.action === 'discard') {
      actionStmt = 'discard;\n  stop;'
    } else {
      const msg = assertLine('reject message', r.target ?? 'Message rejected by filter', 512)
      actionStmt = `reject "${escapeSieveString(msg)}";\n  stop;`
    }

    ruleBlocks.push(`# Rule: ${ruleName}\nif ${testExpr} {\n  ${actionStmt}\n}`)
  }

  if (vacation && vacation.enabled) {
    const days = assertInt('vacation days', vacation.days, 1, 365)
    const subject = assertLine('vacation subject', vacation.subject, 255)
    const body = assertString('vacation body', vacation.body, 16384).replace(/\r\n/g, '\n')
    if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(body)) {
      return invalid('vacation body', body, 'contains forbidden control characters')
    }
    ruleBlocks.push(
      `# Vacation Autoresponder\nvacation :days ${days} :subject "${escapeSieveString(subject)}" "${escapeSieveString(body)}";`,
    )
  }

  const reqList = [...requires].map((cap) => `"${cap}"`).join(', ')
  const bodyText = ruleBlocks.length > 0 ? `\n${ruleBlocks.join('\n\n')}\n` : '\nkeep;\n'
  return `# Managed by xPanel Sieve Compiler\nrequire [${reqList}];\n${bodyText}`
}

/**
 * Parses CSV text for batch mailbox and forwarder import with strict per-line validation.
 */
export const parseAddressImportCsv = (
  csvText: string,
  defaultDomain: string,
): {
  mailboxes: { email: string; quotaMb: number }[]
  forwarders: { source: string; destination: string }[]
  errors: { line: number; error: string }[]
} => {
  const domain = normalizeHostname(defaultDomain, 'defaultDomain')
  const raw = assertString('csvText', csvText, 1024 * 1024)

  const mailboxes: { email: string; quotaMb: number }[] = []
  const forwarders: { source: string; destination: string }[] = []
  const errors: { line: number; error: string }[] = []

  const resolveAddr = (input: string, fieldName: string): string => {
    const trimmed = input.trim()
    const withDomain = trimmed.includes('@') ? trimmed : `${trimmed}@${domain}`
    return normalizeEmail(withDomain, fieldName).address
  }

  const rawLines = raw.replace(/\r\n/g, '\n').split('\n')
  for (let i = 0; i < rawLines.length; i++) {
    const lineNum = i + 1
    const line = rawLines[i]!.trim()
    if (!line || line.startsWith('#')) continue

    const cols = line.split(',').map((c) => c.trim())
    const firstLower = (cols[0] ?? '').toLowerCase()

    // Skip optional CSV header row
    if (
      i === 0 &&
      (firstLower === 'type' ||
        (firstLower === 'email' && (cols[1]?.toLowerCase() === 'quota' || cols[1]?.toLowerCase() === 'quotamb')) ||
        (firstLower === 'source' && cols[1]?.toLowerCase() === 'destination'))
    ) {
      continue
    }

    try {
      if (firstLower === 'mailbox') {
        if (cols.length < 2 || !cols[1]) {
          errors.push({ line: lineNum, error: 'Missing mailbox address' })
          continue
        }
        const email = resolveAddr(cols[1], 'mailbox email')
        const quotaRaw = cols[2] !== undefined && cols[2] !== '' ? Number(cols[2]) : 1024
        if (!Number.isInteger(quotaRaw) || quotaRaw < 1 || quotaRaw > 1048576) {
          errors.push({ line: lineNum, error: `Invalid quota "${cols[2] ?? ''}"` })
          continue
        }
        mailboxes.push({ email, quotaMb: quotaRaw })
      } else if (firstLower === 'forwarder' || firstLower === 'forward') {
        if (cols.length < 3 || !cols[1] || !cols[2]) {
          errors.push({ line: lineNum, error: 'Forwarder requires source and destination' })
          continue
        }
        const source = resolveAddr(cols[1], 'forwarder source')
        const destination = normalizeEmail(cols[2], 'forwarder destination').address
        forwarders.push({ source, destination })
      } else if (cols.length >= 2) {
        const col0 = cols[0]!
        const col1 = cols[1]!
        if (/^\d+$/.test(col1)) {
          const email = resolveAddr(col0, 'mailbox email')
          const quotaMb = Number(col1)
          if (!Number.isInteger(quotaMb) || quotaMb < 1 || quotaMb > 1048576) {
            errors.push({ line: lineNum, error: `Invalid quota "${col1}"` })
            continue
          }
          mailboxes.push({ email, quotaMb })
        } else if (col1.includes('@')) {
          const source = resolveAddr(col0, 'forwarder source')
          const destination = normalizeEmail(col1, 'forwarder destination').address
          forwarders.push({ source, destination })
        } else {
          errors.push({ line: lineNum, error: `Unrecognized CSV format on line ${lineNum}` })
        }
      } else {
        errors.push({ line: lineNum, error: `Insufficient columns on line ${lineNum}` })
      }
    } catch (err) {
      errors.push({
        line: lineNum,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { mailboxes, forwarders, errors }
}

/**
 * Renders Nginx `.well-known/caldav` and `.well-known/carddav` discovery location blocks.
 */
export const renderCalDavCardDavInclude = (domain: string): string => {
  const d = normalizeHostname(domain, 'domain')
  const lines = [
    `# Managed by xPanel: CalDAV / CardDAV service discovery for ${d}`,
    'location = /.well-known/caldav {',
    `  return 301 https://${d}/dav/;`,
    '}',
    'location = /.well-known/carddav {',
    `  return 301 https://${d}/dav/;`,
    '}',
  ]
  return `${lines.join('\n')}\n`
}

// ============================================================================
// 3. Operational DNS (Zone Templates, Batch DKIM/SPF/DMARC, Zone Cleanup)
// ============================================================================

export interface ZoneTemplateRecord {
  type: string
  name: string
  ttl: number
  content: string
  priority?: number
}

/**
 * Produces the full set of DNS records (`A`, `AAAA`, `MX`, `TXT` SPF/DMARC,
 * `CNAME` `www`/`mail`/`ftp`/`webmail`/`cpanel`/`whm`) from the selected template.
 */
export const renderZoneFromTemplate = (
  templateName: 'standard' | 'simple' | 'virtualftp',
  vars: {
    domain: string
    ipv4: string
    ipv6?: string | null
    mailIp?: string
    nameservers: readonly string[]
  },
): ZoneTemplateRecord[] => {
  if (!['standard', 'simple', 'virtualftp'].includes(templateName)) {
    return invalid('templateName', templateName, 'must be standard, simple, or virtualftp')
  }
  if (!vars || typeof vars !== 'object') {
    return invalid('template vars', vars, 'is required')
  }
  const domain = normalizeHostname(vars.domain, 'domain')
  const ipv4 = canonicalIpv4(vars.ipv4, 'ipv4')
  const ipv6 = vars.ipv6 !== undefined && vars.ipv6 !== null && vars.ipv6 !== '' ? canonicalIpv6(vars.ipv6, 'ipv6') : null
  const mailIp = vars.mailIp !== undefined && vars.mailIp !== '' ? canonicalIpv4(vars.mailIp, 'mailIp') : null

  if (!Array.isArray(vars.nameservers) || vars.nameservers.length === 0) {
    return invalid('nameservers', vars.nameservers, 'requires at least one nameserver')
  }
  const nameservers = vars.nameservers.map((ns) => normalizeHostname(ns, 'nameserver'))

  const ttl = 3600
  const records: ZoneTemplateRecord[] = []

  for (const ns of nameservers) {
    records.push({ type: 'NS', name: '@', ttl, content: ns })
  }

  records.push({ type: 'A', name: '@', ttl, content: ipv4 })
  if (ipv6) {
    records.push({ type: 'AAAA', name: '@', ttl, content: ipv6 })
  }

  if (mailIp) {
    records.push({ type: 'A', name: 'mail', ttl, content: mailIp })
  } else {
    records.push({ type: 'CNAME', name: 'mail', ttl, content: domain })
  }

  records.push({
    type: 'MX',
    name: '@',
    ttl,
    content: `mail.${domain}`,
    priority: 10,
  })

  records.push({ type: 'CNAME', name: 'www', ttl, content: domain })

  if (templateName === 'standard') {
    records.push({ type: 'CNAME', name: 'ftp', ttl, content: domain })
    records.push({ type: 'CNAME', name: 'webmail', ttl, content: domain })
    records.push({ type: 'CNAME', name: 'cpanel', ttl, content: domain })
    records.push({ type: 'CNAME', name: 'whm', ttl, content: domain })
  } else if (templateName === 'virtualftp') {
    records.push({ type: 'A', name: 'ftp', ttl, content: ipv4 })
    records.push({ type: 'CNAME', name: 'webmail', ttl, content: domain })
    records.push({ type: 'CNAME', name: 'cpanel', ttl, content: domain })
    records.push({ type: 'CNAME', name: 'whm', ttl, content: domain })
  }

  const spfIp4 = mailIp && mailIp !== ipv4 ? `ip4:${ipv4} ip4:${mailIp}` : `ip4:${ipv4}`
  const spfIp6 = ipv6 ? ` ip6:${ipv6}` : ''
  records.push({
    type: 'TXT',
    name: '@',
    ttl,
    content: `v=spf1 a mx ${spfIp4}${spfIp6} ~all`,
  })
  records.push({
    type: 'TXT',
    name: '_dmarc',
    ttl,
    content: `v=DMARC1; p=none; rua=mailto:postmaster@${domain}`,
  })

  return records
}

/**
 * Generates deterministic `v=spf1`, `default._domainkey` (`v=DKIM1; k=rsa; p=...`),
 * and `_dmarc` (`v=DMARC1; p=...`) records for every domain.
 */
export const provisionBatchDkimSpfDmarc = (
  domains: readonly {
    domain: string
    ipv4: string
    ipv6?: string | null
    dkimPublicKeyB64: string
    spfPolicy?: '~all' | '-all'
    dmarcPolicy?: 'none' | 'quarantine' | 'reject'
  }[],
): Map<string, { spfTxt: string; dkimTxt: string; dmarcTxt: string }> => {
  if (!Array.isArray(domains)) {
    return invalid('domains', domains, 'must be an array')
  }

  const out = new Map<string, { spfTxt: string; dkimTxt: string; dmarcTxt: string }>()
  for (const item of domains) {
    const domain = normalizeHostname(item.domain, 'domain')
    const ipv4 = canonicalIpv4(item.ipv4, 'ipv4')
    const ipv6 =
      item.ipv6 !== undefined && item.ipv6 !== null && item.ipv6 !== ''
        ? canonicalIpv6(item.ipv6, 'ipv6')
        : null

    const keyRaw = assertString('dkimPublicKeyB64', item.dkimPublicKeyB64, 8192).trim()
    if (!/^[A-Za-z0-9+/]+=*$/.test(keyRaw) || keyRaw.length < 16) {
      return invalid('dkimPublicKeyB64', item.dkimPublicKeyB64, 'must be a valid base64 public key')
    }

    const spfPolicy = item.spfPolicy ?? '~all'
    if (spfPolicy !== '~all' && spfPolicy !== '-all') {
      return invalid('spfPolicy', spfPolicy, 'must be ~all or -all')
    }

    const dmarcPolicy = item.dmarcPolicy ?? 'quarantine'
    if (!['none', 'quarantine', 'reject'].includes(dmarcPolicy)) {
      return invalid('dmarcPolicy', dmarcPolicy, 'must be none, quarantine, or reject')
    }

    const spfTxt = `v=spf1 a mx ip4:${ipv4}${ipv6 ? ` ip6:${ipv6}` : ''} ${spfPolicy}`
    const dkimTxt = `v=DKIM1; k=rsa; p=${keyRaw}`
    const dmarcTxt = `v=DMARC1; p=${dmarcPolicy}; rua=mailto:postmaster@${domain}`

    out.set(domain, { spfTxt, dkimTxt, dmarcTxt })
  }

  return out
}

/**
 * Identifies orphan DNS zones that have no matching active domain name.
 */
export const findOrphanDnsZones = (
  zoneNames: readonly string[],
  activeDomainNames: readonly string[],
): string[] => {
  if (!Array.isArray(zoneNames) || !Array.isArray(activeDomainNames)) {
    return invalid('zoneNames', zoneNames, 'zoneNames and activeDomainNames must be arrays')
  }
  const activeSet = new Set(activeDomainNames.map((d) => normalizeHostname(d, 'activeDomainName')))
  const orphans = new Set<string>()
  for (const z of zoneNames) {
    const normalized = normalizeHostname(z, 'zoneName')
    if (!activeSet.has(normalized)) {
      orphans.add(normalized)
    }
  }
  return [...orphans].sort()
}

// ============================================================================
// 4. Extended File & Web Isolation (Directory Privacy, Hotlink, Web Disk, Git)
// ============================================================================

const assertSafeRelativeSubpath = (what: string, relPath: string): string => {
  const s = assertString(what, relPath, 512).replace(/^\/+/, '').replace(/\/+$/, '')
  if (!s) {
    return invalid(what, relPath, 'must not be empty')
  }
  for (const seg of s.split('/')) {
    if (!/^[A-Za-z0-9._-]+$/.test(seg) || seg === '.' || seg === '..') {
      return invalid(what, relPath, `contains unsafe path segment "${seg}"`)
    }
  }
  return s
}

/**
 * Renders `.htpasswd` file and corresponding Nginx and Apache basic auth snippets
 * for directory privacy protection.
 */
export const renderDirectoryPrivacy = (
  account: Pick<Account, 'username' | 'home'>,
  relDir: string,
  authTitle: string,
  users: readonly { username: string; passwordHash: string }[],
): { htpasswdFile: RenderedFile; nginxSnippet: string; apacheSnippet: string } => {
  const username = assertUsername(account?.username)
  const home = assertAbsPath('account home', account?.home)
  const cleanRel = assertSafeRelativeSubpath('relDir', relDir)
  const title = assertLine('authTitle', authTitle, 128)
  if (/["\\]/.test(title) || title.trim().length === 0) {
    return invalid('authTitle', authTitle, 'must be a non-empty title without quotes or backslashes')
  }
  if (!Array.isArray(users) || users.length === 0) {
    return invalid('users', users, 'requires at least one authorized user')
  }

  const seenUsers = new Set<string>()
  const htpasswdLines: string[] = []
  for (const u of users) {
    const user = assertString('htpasswd username', u?.username, 64)
    if (!/^[A-Za-z0-9._-]+$/.test(user)) {
      return invalid('htpasswd username', user, 'must contain only [A-Za-z0-9._-]')
    }
    if (seenUsers.has(user)) {
      return invalid('htpasswd username', user, 'duplicate username')
    }
    seenUsers.add(user)

    const hash = assertLine('htpasswd passwordHash', u?.passwordHash, 256)
    if (!/^(\$2[aby]\$|\$apr1\$|\$6\$|\{SHA\})[^\s:]+$/.test(hash)) {
      return invalid('htpasswd passwordHash', '[redacted]', 'must be a valid bcrypt, apr1, or sha512 crypt hash')
    }
    htpasswdLines.push(`${user}:${hash}`)
  }

  htpasswdLines.sort()
  const htpasswdPath = `${home}/.htpasswds/${cleanRel}/passwd`
  const targetDir = `${home}/${cleanRel}`

  const htpasswdFile: RenderedFile = {
    path: htpasswdPath,
    content: `${htpasswdLines.join('\n')}\n`,
    mode: 0o640,
    owner: username,
    group: 'www-data',
  }

  const nginxSnippet = [
    `location ^~ /${cleanRel.replace(/^public_html\/?/, '')} {`,
    `  auth_basic "${title}";`,
    `  auth_basic_user_file ${htpasswdPath};`,
    '}',
    '',
  ].join('\n')

  const apacheSnippet = [
    `<Directory "${targetDir}">`,
    '  AuthType Basic',
    `  AuthName "${title}"`,
    `  AuthUserFile "${htpasswdPath}"`,
    '  Require valid-user',
    '</Directory>',
    '',
  ].join('\n')

  return { htpasswdFile, nginxSnippet, apacheSnippet }
}

/**
 * Renders Nginx and Apache hotlink protection snippets.
 */
export const renderHotlinkProtection = (config: {
  enabled: boolean
  allowedDomains: readonly string[]
  extensions: readonly string[]
  allowBlankReferrer: boolean
  redirectUrl?: string | null
}): { nginxSnippet: string; apacheSnippet: string } => {
  if (!config || typeof config !== 'object') {
    return invalid('hotlink config', config, 'is required')
  }
  if (!config.enabled) {
    return {
      nginxSnippet: '# Hotlink protection disabled\n',
      apacheSnippet: '# Hotlink protection disabled\n',
    }
  }
  if (!Array.isArray(config.allowedDomains) || config.allowedDomains.length === 0) {
    return invalid('allowedDomains', config.allowedDomains, 'requires at least one allowed domain')
  }
  const domains = config.allowedDomains.map((d) => normalizeHostname(d, 'allowedDomain'))

  if (!Array.isArray(config.extensions) || config.extensions.length === 0) {
    return invalid('extensions', config.extensions, 'requires at least one file extension')
  }
  const exts = config.extensions.map((ext) => {
    const clean = assertString('extension', ext, 16).replace(/^\./, '').toLowerCase()
    if (!/^[a-z0-9]{1,15}$/.test(clean)) {
      return invalid('extension', ext, 'must be an alphanumeric file extension')
    }
    return clean
  })

  const redirectUrl =
    config.redirectUrl !== undefined && config.redirectUrl !== null && config.redirectUrl !== ''
      ? assertRedirectUrl(config.redirectUrl, 'redirectUrl')
      : null

  const extPattern = exts.join('|')
  const validReferers = `${config.allowBlankReferrer ? 'none ' : ''}blocked server_names ${domains.join(' ')}`
  const nginxAction = redirectUrl ? `return 302 ${redirectUrl};` : 'return 403;'

  const nginxSnippet = [
    `location ~* \\.(${extPattern})$ {`,
    `  valid_referers ${validReferers};`,
    '  if ($invalid_referer) {',
    `    ${nginxAction}`,
    '  }',
    '}',
    '',
  ].join('\n')

  const apacheLines = ['RewriteEngine On']
  if (config.allowBlankReferrer) {
    apacheLines.push('RewriteCond %{HTTP_REFERER} !^$')
  }
  for (const d of domains) {
    const escaped = d.replace(/\./g, '\\.')
    apacheLines.push(`RewriteCond %{HTTP_REFERER} !^https?://(www\\.)?${escaped}(/|$) [NC]`)
  }
  const apacheRuleTarget = redirectUrl ? `${redirectUrl} [R=302,L]` : '- [F,L]'
  apacheLines.push(`RewriteRule \\.(${extPattern})$ ${apacheRuleTarget}`)

  return {
    nginxSnippet,
    apacheSnippet: `${apacheLines.join('\n')}\n`,
  }
}

/**
 * Renders Web Disk (WebDAV) per-account configuration.
 */
export const renderWebDiskConfig = (
  account: Pick<Account, 'username' | 'uid' | 'gid' | 'home'>,
  enabled: boolean,
  readOnly: boolean,
): RenderedFile => {
  const acc = assertAccount(account)
  if (typeof enabled !== 'boolean' || typeof readOnly !== 'boolean') {
    return invalid('webdisk flags', { enabled, readOnly }, 'enabled and readOnly must be booleans')
  }

  const lines = [
    `# Managed by xPanel: Web Disk (WebDAV) for ${acc.username} (uid=${acc.uid}, gid=${acc.gid})`,
    `location /webdisk/${acc.username}/ {`,
    `  alias ${acc.home}/;`,
  ]
  if (!enabled) {
    lines.push('  return 403;')
  } else {
    lines.push('  dav_ext_methods PROPFIND OPTIONS;')
    if (readOnly) {
      lines.push('  limit_except GET HEAD OPTIONS PROPFIND {')
      lines.push('    deny all;')
      lines.push('  }')
    } else {
      lines.push('  dav_methods PUT DELETE MKCOL COPY MOVE;')
      lines.push('  create_full_put_path on;')
      lines.push('  dav_access user:rw group:r;')
    }
  }
  lines.push('}')

  return {
    path: `/etc/xpanel/webdav/${acc.username}.conf`,
    content: `${lines.join('\n')}\n`,
    mode: 0o644,
    owner: 'root',
    group: 'root',
  }
}

/**
 * Renders an isolated Git `post-receive` hook script for push-to-deploy.
 */
export const renderGitPostReceiveHook = (
  account: Pick<Account, 'username' | 'uid' | 'home'>,
  repoName: string,
  deployRelPath: string,
  branch = 'main',
): RenderedFile => {
  const username = assertUsername(account?.username)
  const home = assertAbsPath('account home', account?.home)
  assertInt('uid', account?.uid, 1000, 60000)

  const repo = assertString('repoName', repoName, 64).replace(/\.git$/, '')
  if (!/^[A-Za-z0-9._-]+$/.test(repo) || repo === '.' || repo === '..') {
    return invalid('repoName', repoName, 'must be a valid repository name of [A-Za-z0-9._-]')
  }

  const cleanDeployRel = assertSafeRelativeSubpath('deployRelPath', deployRelPath)
  const cleanBranch = assertString('branch', branch, 64)
  if (!/^[A-Za-z0-9._/-]+$/.test(cleanBranch) || cleanBranch.includes('..') || cleanBranch.startsWith('/')) {
    return invalid('branch', branch, 'must be a safe Git branch name')
  }

  const repoDir = `${home}/repos/${repo}.git`
  const deployDir = `${home}/${cleanDeployRel}`

  const lines = [
    '#!/bin/sh',
    `# Managed by xPanel: Git push-to-deploy hook for ${username}/${repo}`,
    'set -eu',
    'umask 0027',
    `TARGET_BRANCH="refs/heads/${cleanBranch}"`,
    `GIT_DIR="${repoDir}"`,
    `WORK_TREE="${deployDir}"`,
    'while read oldrev newrev refname; do',
    '  if [ "$refname" = "$TARGET_BRANCH" ]; then',
    '    /bin/mkdir -p "$WORK_TREE"',
    `    /usr/bin/git --work-tree="$WORK_TREE" --git-dir="$GIT_DIR" checkout -f "${cleanBranch}"`,
    '  fi',
    'done',
  ]

  return {
    path: `${repoDir}/hooks/post-receive`,
    content: `${lines.join('\n')}\n`,
    mode: 0o750,
    owner: username,
    group: username,
  }
}

// ============================================================================
// 5. Databases Beyond MariaDB (PostgreSQL, Remote Hosts, Repair, Redis, Memcached, MongoDB)
// ============================================================================

const PG_IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/

const assertPgIdent = (what: string, v: unknown): string => {
  const s = assertString(what, v, 63)
  if (!PG_IDENT_RE.test(s)) {
    return invalid(what, v, 'must be a lowercase PostgreSQL identifier [a-z_][a-z0-9_]{0,62}')
  }
  return s
}

/**
 * Renders deterministic PostgreSQL provisioning SQL statements (SCRAM-SHA-256 role + database).
 */
export const renderPostgresProvisionSql = (
  dbName: string,
  dbUser: string,
  passwordScramHash: string,
): string[] => {
  const db = assertPgIdent('dbName', dbName)
  const user = assertPgIdent('dbUser', dbUser)
  const hash = assertLine('passwordScramHash', passwordScramHash, 512)
  if (!/^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(hash)) {
    return invalid('passwordScramHash', '[redacted]', 'must be a valid PostgreSQL SCRAM-SHA-256 verifier')
  }

  return [
    `CREATE ROLE "${user}" WITH LOGIN PASSWORD '${hash}' NOSUPERUSER NOCREATEDB NOCREATEROLE;`,
    `CREATE DATABASE "${db}" OWNER "${user}" ENCODING 'UTF8';`,
    `REVOKE ALL ON DATABASE "${db}" FROM PUBLIC;`,
    `GRANT ALL PRIVILEGES ON DATABASE "${db}" TO "${user}";`,
  ]
}

/**
 * Renders `pg_hba.conf` entries for an account's allowed remote hosts using `scram-sha-256`.
 */
export const renderPostgresHbaEntries = (
  accountUsername: string,
  allowedHosts: readonly string[],
): string => {
  const user = assertUsername(accountUsername)
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0) {
    return invalid('allowedHosts', allowedHosts, 'requires at least one allowed host')
  }

  const lines = [`# Managed by xPanel: remote PostgreSQL access for ${user}`]
  for (const rawHost of allowedHosts) {
    const validated = assertDbHost(rawHost)
    let addressCol = validated
    if (/^\d+\.\d+\.\d+\.\d+$/.test(validated)) {
      addressCol = `${validated}/32`
    } else if (validated.includes(':') && !validated.includes('/')) {
      addressCol = `${validated}/128`
    }
    lines.push(`hostssl all +${user} ${addressCol} scram-sha-256`)
  }

  return `${lines.join('\n')}\n`
}

/**
 * Renders remote MariaDB/MySQL GRANT SQL statements for an explicit list of allowed hosts.
 */
export const renderRemoteMysqlGrantsSql = (
  dbName: string,
  dbUser: string,
  allowedHosts: readonly string[],
): string[] => {
  const db = assertPgIdent('dbName', dbName)
  const user = assertPgIdent('dbUser', dbUser)
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0) {
    return invalid('allowedHosts', allowedHosts, 'requires at least one allowed host')
  }

  const pattern = dbGrantPattern(db)
  return allowedHosts.map((h) => {
    const host = assertDbHost(h)
    return `GRANT ALL PRIVILEGES ON \`${pattern}\`.* TO '${user}'@'${host}';`
  })
}

/**
 * Builds argv-only database check/repair/optimize command for MariaDB or PostgreSQL.
 */
export const buildDatabaseRepairArgv = (
  engine: 'mariadb' | 'postgresql',
  dbName: string,
  action: 'check' | 'repair' | 'optimize',
): string[] => {
  const db = assertPgIdent('dbName', dbName)
  if (!['check', 'repair', 'optimize'].includes(action)) {
    return invalid('repair action', action, 'must be check, repair, or optimize')
  }

  if (engine === 'mariadb') {
    const flag =
      action === 'check' ? '--check' : action === 'repair' ? '--repair' : '--optimize'
    return ['/usr/bin/mysqlcheck', flag, '--databases', db]
  }
  if (engine === 'postgresql') {
    if (action === 'repair') {
      return ['/usr/bin/reindexdb', '--dbname', db]
    }
    const flag = action === 'check' ? '--analyze' : '--full'
    return ['/usr/bin/vacuumdb', flag, '--dbname', db]
  }

  return invalid('database engine', engine, 'must be mariadb or postgresql')
}

/**
 * Renders a per-account isolated Redis configuration and systemd unit bound to a Unix socket
 * (`/home/<user>/.run/redis.sock`, `port 0`, inside `xpanel-<uid>.slice`).
 */
export const renderAccountRedisInstance = (
  account: Pick<Account, 'username' | 'uid' | 'gid' | 'home'>,
  maxMemoryMb: number,
): { conf: RenderedFile; unit: RenderedFile } => {
  const acc = assertAccount(account)
  const mem = assertInt('maxMemoryMb', maxMemoryMb, 16, 65536)
  const socketPath = `${acc.home}/.run/redis.sock`
  const dataDir = `${acc.home}/.local/share/redis`
  const confPath = `/etc/xpanel/redis/${acc.username}.conf`
  const slice = accountSliceName(acc.uid)

  const confLines = [
    `# Managed by xPanel: per-account Redis instance for ${acc.username}`,
    'port 0',
    `unixsocket ${socketPath}`,
    'unixsocketperm 770',
    'daemonize no',
    'supervised systemd',
    `dir ${dataDir}`,
    `maxmemory ${mem}mb`,
    'maxmemory-policy allkeys-lru',
    'rename-command FLUSHALL ""',
    'rename-command CONFIG ""',
    'rename-command DEBUG ""',
    'rename-command SHUTDOWN ""',
  ]

  const unitLines = [
    `# Managed by xPanel: Redis service for ${acc.username}`,
    '[Unit]',
    `Description=xPanel Redis instance for ${acc.username}`,
    'After=network.target',
    '',
    '[Service]',
    'Type=notify',
    `User=${acc.username}`,
    `Group=${acc.username}`,
    `Slice=${slice}`,
    `MemoryMax=${mem}M`,
    `ExecStartPre=/bin/mkdir -p ${acc.home}/.run ${dataDir}`,
    `ExecStart=/usr/bin/redis-server ${confPath}`,
    'Restart=on-failure',
    'RestartSec=2s',
    'UMask=0027',
    'PrivateTmp=yes',
    'PrivateDevices=yes',
    'ProtectSystem=strict',
    'ProtectHome=tmpfs',
    `BindPaths=${acc.home}`,
    `ReadWritePaths=${acc.home}`,
    'NoNewPrivileges=yes',
    'SocketBindDeny=any',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
  ]

  return {
    conf: {
      path: confPath,
      content: `${confLines.join('\n')}\n`,
      mode: 0o640,
      owner: acc.username,
      group: acc.username,
    },
    unit: {
      path: `/etc/systemd/system/xpanel-redis-${acc.username}.service`,
      content: `${unitLines.join('\n')}\n`,
      mode: 0o644,
      owner: 'root',
      group: 'root',
    },
  }
}

/**
 * Renders a per-account isolated Memcached systemd unit bound to a Unix socket
 * (`/home/<user>/.run/memcached.sock`, `-s`, inside `xpanel-<uid>.slice`).
 */
export const renderAccountMemcachedUnit = (
  account: Pick<Account, 'username' | 'uid' | 'gid' | 'home'>,
  maxMemoryMb: number,
): RenderedFile => {
  const acc = assertAccount(account)
  const mem = assertInt('maxMemoryMb', maxMemoryMb, 16, 65536)
  const socketPath = `${acc.home}/.run/memcached.sock`
  const slice = accountSliceName(acc.uid)

  const unitLines = [
    `# Managed by xPanel: Memcached service for ${acc.username}`,
    '[Unit]',
    `Description=xPanel Memcached instance for ${acc.username}`,
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `User=${acc.username}`,
    `Group=${acc.username}`,
    `Slice=${slice}`,
    `MemoryMax=${mem}M`,
    `ExecStartPre=/bin/mkdir -p ${acc.home}/.run`,
    `ExecStart=/usr/bin/memcached -s ${socketPath} -a 0770 -m ${mem}`,
    'Restart=on-failure',
    'RestartSec=2s',
    'UMask=0027',
    'PrivateTmp=yes',
    'PrivateDevices=yes',
    'ProtectSystem=strict',
    'ProtectHome=tmpfs',
    `BindPaths=${acc.home}`,
    `ReadWritePaths=${acc.home}`,
    'NoNewPrivileges=yes',
    'SocketBindDeny=any',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
  ]

  return {
    path: `/etc/systemd/system/xpanel-memcached-${acc.username}.service`,
    content: `${unitLines.join('\n')}\n`,
    mode: 0o644,
    owner: 'root',
    group: 'root',
  }
}

const ALLOWED_MONGO_ROLES = new Set(['read', 'readWrite', 'dbAdmin', 'userAdmin'])

/**
 * Renders a deterministic JSON command specification for MongoDB database & user provisioning.
 */
export const renderMongoProvisionJson = (
  dbName: string,
  dbUser: string,
  roles: readonly string[],
): string => {
  const db = assertPgIdent('dbName', dbName)
  const user = assertPgIdent('dbUser', dbUser)
  if (!Array.isArray(roles) || roles.length === 0) {
    return invalid('roles', roles, 'requires at least one MongoDB role')
  }
  const validatedRoles = [...new Set(roles)].map((r) => {
    if (!ALLOWED_MONGO_ROLES.has(r)) {
      return invalid('mongo role', r, 'must be read, readWrite, dbAdmin, or userAdmin')
    }
    return { role: r, db }
  })

  return JSON.stringify(
    {
      createUser: user,
      db,
      roles: validatedRoles,
      mechanisms: ['SCRAM-SHA-256'],
    },
    null,
    2,
  )
}

// ============================================================================
// 6. Fine-Grained Server Settings, Containers, App Store & Web Stack Profiles
// ============================================================================

/**
 * Renders advanced Postfix MTA settings (smarthost relay, message size cap,
 * hourly client rate limits, RBL blacklists, and greylisting policy service).
 */
export const renderMtaAdvancedConfig = (opts: {
  smarthost?: string | null
  maxMsgSizeMb: number
  rateLimitPerHour: number
  rblDomains: readonly string[]
  greylistingEnabled: boolean
}): RenderedFile => {
  if (!opts || typeof opts !== 'object') {
    return invalid('mta options', opts, 'is required')
  }
  const maxMsgSizeMb = assertInt('maxMsgSizeMb', opts.maxMsgSizeMb, 1, 2048)
  const rateLimitPerHour = assertInt('rateLimitPerHour', opts.rateLimitPerHour, 1, 100000)
  if (typeof opts.greylistingEnabled !== 'boolean') {
    return invalid('greylistingEnabled', opts.greylistingEnabled, 'must be a boolean')
  }
  if (!Array.isArray(opts.rblDomains)) {
    return invalid('rblDomains', opts.rblDomains, 'must be an array')
  }

  let relayhost = ''
  if (opts.smarthost !== undefined && opts.smarthost !== null && opts.smarthost !== '') {
    const rawSmart = assertLine('smarthost', opts.smarthost, 255)
    const m = /^\[?([A-Za-z0-9.-]+)\]?(?::(\d{1,5}))?$/.exec(rawSmart)
    if (!m) {
      return invalid('smarthost', opts.smarthost, 'must be host or [host]:port')
    }
    const host = normalizeHostname(m[1], 'smarthost')
    const port = m[2] ? assertInt('smarthost port', Number(m[2]), 1, 65535) : 587
    relayhost = `[${host}]:${port}`
  }

  const rbls = opts.rblDomains.map((d) => normalizeHostname(d, 'rblDomain'))
  const recipientRestrictions = [
    'permit_mynetworks',
    'permit_sasl_authenticated',
    'reject_unauth_destination',
    ...rbls.map((rbl) => `reject_rbl_client ${rbl}`),
    ...(opts.greylistingEnabled ? ['check_policy_service unix:private/postgrey'] : []),
  ]

  const lines = [
    '# Managed by xPanel: advanced Postfix MTA configuration',
    `relayhost = ${relayhost}`,
    `message_size_limit = ${maxMsgSizeMb * 1024 * 1024}`,
    'anvil_rate_time_unit = 3600s',
    `smtpd_client_message_rate_limit = ${rateLimitPerHour}`,
    `smtpd_recipient_restrictions = ${recipientRestrictions.join(', ')}`,
  ]

  return {
    path: '/etc/postfix/xpanel_mta_advanced.cf',
    content: `${lines.join('\n')}\n`,
    mode: 0o644,
    owner: 'root',
    group: 'root',
  }
}

/**
 * Renders a rootless Podman systemd unit running inside the account's cgroup slice.
 */
export const renderRootlessContainerUnit = (
  account: Pick<Account, 'username' | 'uid' | 'gid' | 'home'>,
  container: {
    name: string
    image: string
    internalPort: number
    env: Record<string, string>
    memoryMb: number
  },
): RenderedFile => {
  const acc = assertAccount(account)
  if (!container || typeof container !== 'object') {
    return invalid('container', container, 'is required')
  }
  const name = assertString('container name', container.name, 32)
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(name)) {
    return invalid('container name', container.name, 'must be 1-32 lowercase alphanumeric or dash characters')
  }
  const image = assertLine('container image', container.image, 255)
  if (!/^[A-Za-z0-9._/-]+(?::[A-Za-z0-9._-]+|@sha256:[a-f0-9]{64})?$/.test(image)) {
    return invalid('container image', container.image, 'is not a valid OCI image reference')
  }
  const internalPort = assertInt('internalPort', container.internalPort, 1, 65535)
  const memoryMb = assertInt('memoryMb', container.memoryMb, 32, 65536)

  if (!container.env || typeof container.env !== 'object' || Array.isArray(container.env)) {
    return invalid('container env', container.env, 'must be an object')
  }
  const envFlags: string[] = []
  for (const [k, v] of Object.entries(container.env).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) {
      return invalid('container env key', k, 'is not a valid environment variable name')
    }
    const val = assertNoControl(`env ${k}`, assertString(`env ${k}`, v, 1024))
    if (/["'\\$\s]/.test(val)) {
      return invalid(`env ${k}`, val, 'must not contain whitespace, quotes, or shell metacharacters')
    }
    envFlags.push(`--env ${k}=${val}`)
  }

  const slice = accountSliceName(acc.uid)
  const unitName = `xpanel-container-${acc.username}-${name}.service`
  const envPart = envFlags.length > 0 ? ` ${envFlags.join(' ')}` : ''

  const lines = [
    `# Managed by xPanel: rootless container ${name} for ${acc.username}`,
    '[Unit]',
    `Description=xPanel rootless container ${name} for ${acc.username}`,
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `User=${acc.username}`,
    `Group=${acc.username}`,
    `Slice=${slice}`,
    `MemoryMax=${memoryMb}M`,
    `Environment="HOME=${acc.home}" "XDG_RUNTIME_DIR=/run/user/${acc.uid}"`,
    `ExecStart=/usr/bin/podman run --rm --replace --name ${name} --network slirp4netns --security-opt no-new-privileges --memory ${memoryMb}m -p 127.0.0.1::${internalPort}${envPart} ${image}`,
    `ExecStop=/usr/bin/podman stop -t 10 ${name}`,
    'Restart=on-failure',
    'RestartSec=5s',
    'NoNewPrivileges=yes',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
  ]

  return {
    path: `/etc/systemd/system/${unitName}`,
    content: `${lines.join('\n')}\n`,
    mode: 0o644,
    owner: 'root',
    group: 'root',
  }
}

export type AppInstallKind = 'wordpress' | 'laravel' | 'drupal' | 'joomla' | 'ghost' | 'nextcloud'

/**
 * Builds a deterministic application installation manifest with argv-only setup commands.
 */
export const buildAppInstallManifest = (
  appKind: AppInstallKind,
  opts: {
    domain: string
    docRoot: string
    dbName: string
    dbUser: string
    adminEmail: string
    version?: string
  },
): {
  appKind: string
  filesToCreate: string[]
  cliSetupArgv: string[][]
  envVars: Record<string, string>
} => {
  if (!['wordpress', 'laravel', 'drupal', 'joomla', 'ghost', 'nextcloud'].includes(appKind)) {
    return invalid('appKind', appKind, 'is not a supported application kind')
  }
  if (!opts || typeof opts !== 'object') {
    return invalid('install options', opts, 'is required')
  }

  const domain = normalizeHostname(opts.domain, 'domain')
  const docRoot = assertAbsPath('docRoot', opts.docRoot)
  const dbName = assertPgIdent('dbName', opts.dbName)
  const dbUser = assertPgIdent('dbUser', opts.dbUser)
  const adminEmail = normalizeEmail(opts.adminEmail, 'adminEmail').address
  const version = opts.version !== undefined ? assertString('version', opts.version, 32) : 'latest'
  if (!/^[A-Za-z0-9._-]+$/.test(version)) {
    return invalid('version', version, 'must be a safe version specifier')
  }

  const envVars: Record<string, string> = {
    APP_DOMAIN: domain,
    APP_URL: `https://${domain}`,
    DB_HOST: '127.0.0.1',
    DB_DATABASE: dbName,
    DB_USERNAME: dbUser,
    ADMIN_EMAIL: adminEmail,
    APP_VERSION: version,
  }

  switch (appKind) {
    case 'wordpress':
      return {
        appKind,
        filesToCreate: [`${docRoot}/wp-config.php`, `${docRoot}/.htaccess`],
        cliSetupArgv: [
          ['/usr/local/bin/wp', 'core', 'download', `--path=${docRoot}`, `--version=${version}`],
          [
            '/usr/local/bin/wp',
            'core',
            'install',
            `--path=${docRoot}`,
            `--url=https://${domain}`,
            `--title=${domain}`,
            `--admin_user=admin`,
            `--admin_email=${adminEmail}`,
          ],
        ],
        envVars,
      }
    case 'laravel':
      return {
        appKind,
        filesToCreate: [`${docRoot}/.env`, `${docRoot}/storage/logs/laravel.log`],
        cliSetupArgv: [
          ['/usr/bin/composer', 'create-project', '--no-interaction', 'laravel/laravel', docRoot],
          ['/usr/bin/php', `${docRoot}/artisan`, 'key:generate', '--force'],
          ['/usr/bin/php', `${docRoot}/artisan`, 'migrate', '--force'],
        ],
        envVars,
      }
    case 'drupal':
      return {
        appKind,
        filesToCreate: [`${docRoot}/web/sites/default/settings.php`],
        cliSetupArgv: [
          ['/usr/bin/composer', 'create-project', '--no-interaction', 'drupal/recommended-project', docRoot],
          [
            `${docRoot}/vendor/bin/drush`,
            'site:install',
            'standard',
            `--db-url=mysql://${dbUser}@127.0.0.1/${dbName}`,
            `--account-mail=${adminEmail}`,
            '--yes',
          ],
        ],
        envVars,
      }
    case 'joomla':
      return {
        appKind,
        filesToCreate: [`${docRoot}/configuration.php`, `${docRoot}/.htaccess`],
        cliSetupArgv: [
          [
            '/usr/bin/php',
            `${docRoot}/installation/joomla.php`,
            'install',
            `--site-name=${domain}`,
            `--admin-user=admin`,
            `--admin-email=${adminEmail}`,
            `--db-name=${dbName}`,
            `--db-user=${dbUser}`,
          ],
        ],
        envVars,
      }
    case 'ghost':
      return {
        appKind,
        filesToCreate: [`${docRoot}/config.production.json`],
        cliSetupArgv: [
          [
            '/usr/local/bin/ghost',
            'install',
            version,
            '--dir',
            docRoot,
            '--url',
            `https://${domain}`,
            '--db',
            'mysql',
            '--dbhost',
            '127.0.0.1',
            '--dbname',
            dbName,
            '--dbuser',
            dbUser,
            '--no-prompt',
          ],
        ],
        envVars,
      }
    case 'nextcloud':
      return {
        appKind,
        filesToCreate: [`${docRoot}/config/config.php`],
        cliSetupArgv: [
          [
            '/usr/bin/php',
            `${docRoot}/occ`,
            'maintenance:install',
            '--database=mysql',
            `--database-name=${dbName}`,
            `--database-user=${dbUser}`,
            '--admin-user=admin',
          ],
          ['/usr/bin/php', `${docRoot}/occ`, 'config:system:set', 'trusted_domains', '1', `--value=${domain}`],
        ],
        envVars,
      }
  }
}

/**
 * Renders the server-wide web stack profile (`/etc/xpanel/web-stack.conf`).
 */
export const renderWebStackProfile = (opts: {
  engine: 'apache' | 'openlitespeed'
  http3Quic: boolean
  brotli: boolean
  wafOwaspCrs: boolean
  phpVersions: readonly string[]
  maxMemoryPerProcessMb: number
}): RenderedFile => {
  if (!opts || typeof opts !== 'object') {
    return invalid('webStackProfile', opts, 'is required')
  }
  if (opts.engine !== 'apache' && opts.engine !== 'openlitespeed') {
    return invalid('engine', opts.engine, 'must be apache or openlitespeed')
  }
  if (
    typeof opts.http3Quic !== 'boolean' ||
    typeof opts.brotli !== 'boolean' ||
    typeof opts.wafOwaspCrs !== 'boolean'
  ) {
    return invalid('webStackProfile flags', opts, 'http3Quic, brotli, and wafOwaspCrs must be booleans')
  }
  if (!Array.isArray(opts.phpVersions) || opts.phpVersions.length === 0) {
    return invalid('phpVersions', opts.phpVersions, 'requires at least one PHP version')
  }
  const versions = [...new Set(opts.phpVersions.map((v) => assertPhpVersion(v)))].sort()
  const maxMem = assertInt('maxMemoryPerProcessMb', opts.maxMemoryPerProcessMb, 32, 65536)

  const lines = [
    '# Managed by xPanel: Web Stack Profile',
    `engine = ${opts.engine}`,
    `http3_quic = ${opts.http3Quic ? 'enabled' : 'disabled'}`,
    `brotli_compression = ${opts.brotli ? 'enabled' : 'disabled'}`,
    `waf_owasp_crs = ${opts.wafOwaspCrs ? 'enabled' : 'disabled'}`,
    `php_versions = ${versions.join(',')}`,
    `max_memory_per_process_mb = ${maxMem}`,
  ]

  return {
    path: '/etc/xpanel/web-stack.conf',
    content: `${lines.join('\n')}\n`,
    mode: 0o644,
    owner: 'root',
    group: 'root',
  }
}
