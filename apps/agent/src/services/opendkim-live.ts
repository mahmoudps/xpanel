import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto'
import type { DnsRecord, HostAction, RenderedFile } from '@xpanel/core'
import { services } from '@xpanel/render'
import type { AgentExecutor } from '../executor.ts'

/** Socket OpenDKIM binds on the host, inside the Postfix chroot. */
export const OPENDKIM_SOCKET_PATH = '/var/spool/postfix/opendkim/opendkim.sock'
/** Path Postfix uses. smtpd and cleanup are chrooted at /var/spool/postfix. */
export const OPENDKIM_MILTER = 'local:opendkim/opendkim.sock'
const OPENDKIM_DIR = '/etc/opendkim'
const OPENDKIM_KEYS = '/etc/opendkim/keys'
const OPENDKIM_CONF = '/etc/opendkim.conf'
const SIGNING_PATH = '/etc/opendkim/signing.json'
const PUBLISHED_PATH = '/etc/opendkim/published'
const SOCKET_DIR = '/var/spool/postfix/opendkim'

export interface OpenDkimDomainMaterial {
  selector: string
  publicKeyPem: string
  dnsTxt: string
}

export interface OpenDkimSigning {
  domains: Record<string, OpenDkimDomainMaterial>
}

export interface OpenDkimSetup {
  changed: boolean
  stamp: string
  signing: OpenDkimSigning
}

/** Selector for a newly signed domain. An existing key keeps its own selector. */
export const currentDkimSelector = (now = new Date()): string => {
  const month = String(now.getUTCMonth() + 1).padStart(2, '0')
  return `xp${now.getUTCFullYear()}${month}`
}

const stampOf = (signing: OpenDkimSigning): string =>
  createHash('sha256').update(JSON.stringify(signing), 'utf8').digest('hex')

const fileHash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

export const parseOpenDkimSigning = (text: string | null): OpenDkimSigning => {
  if (!text) return { domains: {} }
  try {
    const parsed = JSON.parse(text) as { domains?: unknown }
    if (!parsed || typeof parsed !== 'object' || !parsed.domains || typeof parsed.domains !== 'object') return { domains: {} }
    const domains: Record<string, OpenDkimDomainMaterial> = {}
    for (const [name, value] of Object.entries(parsed.domains as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const row = value as { selector?: unknown; publicKeyPem?: unknown; dnsTxt?: unknown }
      if (typeof row.selector !== 'string' || typeof row.publicKeyPem !== 'string' || typeof row.dnsTxt !== 'string') continue
      domains[name] = { selector: row.selector, publicKeyPem: row.publicKeyPem, dnsTxt: row.dnsTxt }
    }
    return { domains }
  } catch {
    return { domains: {} }
  }
}

const backupStamp = (): string => new Date().toISOString().replace(/[:.]/g, '')

const writeOwned = async (executor: AgentExecutor, file: RenderedFile): Promise<boolean> => {
  const existing = await executor.readFile(file.path)
  if (existing === file.content) return false
  if (existing !== null) {
    await executor.writeFile({
      path: `${file.path}.bak.${backupStamp()}`,
      content: existing,
      mode: 0o644,
      owner: 'root',
      group: 'root',
    })
  }
  await executor.writeFile(file)
  return true
}

const publicPem = (privatePem: string): string => {
  const exported = createPublicKey(privatePem).export({ type: 'spki', format: 'pem' })
  if (typeof exported !== 'string') throw new Error('DKIM public key export was not a PEM string')
  return exported
}

const freshKey = (): { privatePem: string; publicPem: string } => {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  return { privatePem: pair.privateKey, publicPem: pair.publicKey }
}

const safeDomain = (name: string): string | null => {
  try {
    return services.normalizeHostname(name, 'DKIM domain')
  } catch {
    return null
  }
}

/** Public material only, verified against the current signing key. */
export const readOpenDkimPublicMaterial = async (
  executor: AgentExecutor,
  name: string,
): Promise<{ selector: string; publicKeyPem: string } | null> => {
  const domain = safeDomain(name)
  if (!domain) return null
  const material = parseOpenDkimSigning(await executor.readFile(SIGNING_PATH)).domains[domain]
  if (!material) return null
  try {
    services.assertDkimSelector(material.selector)
    if (material.publicKeyPem.includes('PRIVATE KEY')) return null
    const stored = createPublicKey(material.publicKeyPem)
    const privatePem = await executor.readFile(`${OPENDKIM_KEYS}/${domain}/${material.selector}.private`)
    if (!privatePem) return null
    const actual = createPublicKey(privatePem)
    if (actual.asymmetricKeyType !== 'rsa' || (actual.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) return null
    const exported = actual.export({ type: 'spki', format: 'pem' }).toString()
    if (stored.export({ type: 'spki', format: 'pem' }).toString() !== exported) return null
    return { selector: material.selector, publicKeyPem: exported }
  } catch {
    return null
  }
}

/**
 * Per-domain 2048-bit keys, OpenDKIM tables, the chroot socket, and the postfix
 * group membership. A domain that already has a key keeps that selector.
 */
export const ensureOpenDkimSigning = async (
  executor: AgentExecutor,
  domains: readonly string[],
  now = new Date(),
): Promise<OpenDkimSetup> => {
  const previous = parseOpenDkimSigning(await executor.readFile(SIGNING_PATH))
  const wanted = new Set<string>()
  for (const name of domains) {
    const domain = safeDomain(name)
    if (domain) wanted.add(domain)
  }

  const dirs: HostAction[] = [
    { kind: 'ensure-dir', path: OPENDKIM_DIR, mode: 0o755, owner: 'root', group: 'root' },
    { kind: 'ensure-dir', path: OPENDKIM_KEYS, mode: 0o750, owner: 'root', group: 'opendkim' },
    { kind: 'ensure-dir', path: SOCKET_DIR, mode: 0o750, owner: 'opendkim', group: 'postfix' },
  ]
  for (const domain of wanted) {
    dirs.push({ kind: 'ensure-dir', path: `${OPENDKIM_KEYS}/${domain}`, mode: 0o750, owner: 'root', group: 'opendkim' })
  }
  for (const action of dirs) await executor.runAction(action)

  const signing: OpenDkimSigning = { domains: {} }
  let changed = false
  const tracked: { path: string; previous: string; next: string }[] = []
  for (const domain of [...wanted].sort()) {
    const kept = previous.domains[domain]
    const selector = kept?.selector ?? currentDkimSelector(now)
    services.assertDkimSelector(selector)
    const keyPath = `${OPENDKIM_KEYS}/${domain}/${selector}.private`
    const onDiskKey = (await executor.readFile(keyPath)) ?? ''
    let privatePem: string | null = onDiskKey || null
    let publicKey = ''
    if (privatePem && !privatePem.includes('BEGIN PRIVATE KEY') && !privatePem.includes('BEGIN RSA PRIVATE KEY')) privatePem = null
    if (privatePem) {
      try {
        publicKey = publicPem(privatePem)
      } catch {
        privatePem = null
      }
    }
    if (!privatePem) {
      const created = freshKey()
      privatePem = created.privatePem
      publicKey = created.publicPem
      changed = true
      await executor.writeFile({ path: keyPath, content: privatePem, mode: 0o600, owner: 'opendkim', group: 'opendkim' })
    }
    const record = services.dkimDnsRecord(domain, selector, publicKey, { keyType: 'rsa' })
    signing.domains[domain] = { selector, publicKeyPem: publicKey, dnsTxt: record.content }
    tracked.push({ path: keyPath, previous: onDiskKey, next: privatePem })
    if (!kept || kept.selector !== selector || kept.dnsTxt !== record.content) changed = true
  }

  const signingText = `${JSON.stringify(signing, null, 2)}\n`
  tracked.push({ path: SIGNING_PATH, previous: (await executor.readFile(SIGNING_PATH)) ?? '', next: signingText })
  if (await writeOwned(executor, { path: SIGNING_PATH, content: signingText, mode: 0o644, owner: 'root', group: 'root' })) changed = true

  const keyLines = ['# Managed by xPanel: OpenDKIM KeyTable']
  const signLines = ['# Managed by xPanel: OpenDKIM SigningTable']
  const trustLines = ['# Managed by xPanel: OpenDKIM TrustedHosts', '127.0.0.1', '::1', 'localhost']
  const internalLines = ['# Managed by xPanel: OpenDKIM InternalHosts', '127.0.0.1', '::1', 'localhost']
  for (const domain of Object.keys(signing.domains).sort()) {
    const row = signing.domains[domain]!
    const keyName = `${row.selector}._domainkey.${domain}`
    const keyPath = `${OPENDKIM_KEYS}/${domain}/${row.selector}.private`
    keyLines.push(`${keyName} ${domain}:${row.selector}:${keyPath}`)
    signLines.push(`*@${domain} ${keyName}`)
  }
  const table = (path: string, lines: string[]): RenderedFile => ({
    path,
    content: `${lines.join('\n')}\n`,
    mode: 0o640,
    owner: 'root',
    group: 'opendkim',
  })
  const tables = [
    table(`${OPENDKIM_DIR}/KeyTable`, keyLines),
    table(`${OPENDKIM_DIR}/SigningTable`, signLines),
    table(`${OPENDKIM_DIR}/TrustedHosts`, trustLines),
    table(`${OPENDKIM_DIR}/InternalHosts`, internalLines),
  ]
  for (const file of tables) {
    tracked.push({ path: file.path, previous: (await executor.readFile(file.path)) ?? '', next: file.content })
    if (await writeOwned(executor, file)) changed = true
  }

  const managed = [
    'Mode sv',
    'Canonicalization relaxed/relaxed',
    'UMask 002',
    'UserID opendkim:opendkim',
    `Socket local:${OPENDKIM_SOCKET_PATH}`,
    'KeyTable refile:/etc/opendkim/KeyTable',
    'SigningTable refile:/etc/opendkim/SigningTable',
    'ExternalIgnoreList refile:/etc/opendkim/TrustedHosts',
    'InternalHosts refile:/etc/opendkim/TrustedHosts',
  ].join('\n')
  const existingConf = (await executor.readFile(OPENDKIM_CONF)) ?? ''
  const nextConf = services.replaceManagedBlock(existingConf, managed)
  tracked.push({ path: OPENDKIM_CONF, previous: existingConf, next: nextConf })
  const wantedSocket = `local:${OPENDKIM_SOCKET_PATH}`
  let previousSocket: string | null = null
  for (const line of existingConf.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = /^Socket\s+(\S+)\s*$/.exec(trimmed)
    if (match?.[1]) previousSocket = match[1]
  }
  const socketChanged = previousSocket !== wantedSocket
  const confWritten = await writeOwned(executor, { path: OPENDKIM_CONF, content: nextConf, mode: 0o644, owner: 'root', group: 'root' })
  if (confWritten) changed = true
  const digest = (pick: 'previous' | 'next'): string => {
    const hash = createHash('sha256')
    for (const entry of tracked) {
      hash.update(entry.path, 'utf8')
      hash.update('\0', 'utf8')
      hash.update(fileHash(pick === 'next' ? entry.next : entry.previous), 'utf8')
    }
    return hash.digest('hex')
  }
  const filesChanged = digest('previous') !== digest('next')

  try {
    await executor.runAction({ kind: 'exec', argv: ['/usr/sbin/usermod', '-a', '-G', 'opendkim', 'postfix'] })
  } catch { /* The postfix account is absent on a host that has not installed mail. */ }
  try {
    if (socketChanged && confWritten) {
      await executor.runAction({ kind: 'systemd', verb: 'restart', unit: 'opendkim.service' })
      try {
        await executor.runCommand(['/usr/bin/systemctl', 'is-active', 'opendkim.service'])
      } catch { /* milter_default_action stays accept when the health check cannot run. */ }
    } else if (filesChanged) {
      await executor.runAction({ kind: 'systemd', verb: 'reload', unit: 'opendkim.service' })
    }
  } catch { /* A missing OpenDKIM unit must not stop the rest of the mail stack. */ }

  return { changed, stamp: stampOf(signing), signing }
}

export const readOpenDkimPublished = async (executor: AgentExecutor): Promise<string | null> =>
  executor.readFile(PUBLISHED_PATH)

export const writeOpenDkimPublished = async (executor: AgentExecutor, stamp: string): Promise<void> => {
  await executor.runAction({ kind: 'ensure-dir', path: OPENDKIM_DIR, mode: 0o755, owner: 'root', group: 'root' })
  await writeOwned(executor, { path: PUBLISHED_PATH, content: `${stamp}\n`, mode: 0o644, owner: 'root', group: 'root' })
}

const ownerName = (name: string, zone: string): string => {
  const raw = name.trim().toLowerCase().replace(/\.$/, '')
  if (raw === '@' || raw === '' || raw === zone) return '@'
  return raw.endsWith(`.${zone}`) ? raw.slice(0, -(zone.length + 1)) : raw
}

/**
 * DKIM TXT for each signed domain, plus SPF and DMARC when the zone does not
 * already have them. Existing SPF and DMARC records are left alone.
 */
export const mailAuthZoneAdditions = (
  zoneName: string,
  records: readonly { name: string; type: string; content: string }[],
  signing: OpenDkimSigning,
): DnsRecord[] => {
  const zone = safeDomain(zoneName)
  if (!zone) return []
  const material = signing.domains[zone]
  if (!material) return []
  const txt = (name: string): string[] => records
    .filter(record => record.type === 'TXT' && ownerName(record.name, zone) === name)
    .map(record => record.content)
  const extra: DnsRecord[] = []
  const dkimName = `${material.selector}._domainkey`
  if (!txt(dkimName).some(content => content.toLowerCase().startsWith('v=dkim1'))) {
    extra.push({ id: `xpanel-dkim-${zone}`, zone, name: dkimName, type: 'TXT', ttl: 3600, content: material.dnsTxt, priority: null })
  }
  if (!records.some(record => record.type === 'TXT' && ownerName(record.name, zone) === '@' && record.content.toLowerCase().startsWith('v=spf1'))) {
    extra.push({ id: `xpanel-spf-${zone}`, zone, name: '@', type: 'TXT', ttl: 3600, content: 'v=spf1 a mx ~all', priority: null })
  }
  if (!txt('_dmarc').some(content => content.toLowerCase().startsWith('v=dmarc1'))) {
    extra.push({ id: `xpanel-dmarc-${zone}`, zone, name: '_dmarc', type: 'TXT', ttl: 3600, content: 'v=DMARC1; p=none', priority: null })
  }
  return extra
}
