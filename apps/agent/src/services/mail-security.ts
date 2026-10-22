import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto'
import { fail } from '@xpanel/core'
import type { DnsRecord, HostAction, Id, OsProfile, RenderedFile } from '@xpanel/core'
import { services } from '@xpanel/render'
import type { AgentExecutor } from '../executor.ts'

type ZoneRecord = services.ZoneRecord

export type DkimAlgorithm = 'rsa' | 'ed25519'

export interface DkimSelectorKeyRecord {
  domain: string
  selector: string
  algorithm: DkimAlgorithm
  privateKeyPath: string
  publicKeyPem: string
  dnsRecord: ZoneRecord
  status: 'active' | 'overlapping_previous' | 'retired'
  createdAt: string
  overlapUntil: string | null
}

export interface DkimPublicExportView {
  domain: string
  selector: string
  algorithm: DkimAlgorithm
  dnsName: string
  dnsTxtValue: string
  status: 'active' | 'overlapping_previous' | 'retired'
  createdAt: string
  overlapUntil: string | null
}

export interface SpfDmarcPolicyInput {
  domain: string
  existingRecords: readonly DnsRecord[]
  ipv4: readonly string[]
  ipv6?: readonly string[]
  includeDomains?: readonly string[]
  spfMode?: '~all' | '-all'
  dmarcPolicy?: 'none' | 'quarantine' | 'reject'
  dmarcSubdomainPolicy?: 'none' | 'quarantine' | 'reject'
  dmarcAlignmentDkim?: 'r' | 's'
  dmarcAlignmentSpf?: 'r' | 's'
  ruaEmail?: string
  dkimSelectors: readonly DkimSelectorKeyRecord[]
}

export interface ReconciledEmailAuthDns {
  domain: string
  records: DnsRecord[]
  replacedDuplicateSpfCount: number
  replacedDuplicateDmarcCount: number
  spfRecord: DnsRecord
  dmarcRecord: DnsRecord
  dkimRecords: DnsRecord[]
}

export interface OutboundRateCapConfig {
  mailboxMaxMessagesPerHour: number
  mailboxMaxRecipientsPerHour: number
  mailboxMaxBytesPerHour: number
  accountMaxMessagesPerHour: number
  serverMaxMessagesPerHour: number
  exceedAction: 'defer' | 'reject'
}

export interface OutboundRateCheckInput {
  accountId: Id
  mailbox: string
  recipientCount: number
  messageBytes: number
  nowMs?: number
  operatorOverrideReason?: string | null
}

export interface OutboundRateDecision {
  allowed: boolean
  outcome: 'allowed' | 'operator_override' | 'deferred' | 'rejected'
  smtpCode: 250 | 450 | 550
  smtpMessage: string
  mailboxUsedMessagesLastHour: number
  accountUsedMessagesLastHour: number
}

export type MtaDeliveryStage =
  | 'accepted'
  | 'queued'
  | 'deferred'
  | 'bounced'
  | 'rejected'
  | 'delivered'

export interface MailDeliveryLogEvent {
  queueId: string
  stage: MtaDeliveryStage
  timestamp: string
  daemon: string
  sender: string | null
  recipient: string | null
  domain: string | null
  saslUsername: string | null
  relay: string | null
  smtpCode: number
  sizeBytes: number | null
  sanitizedDiagnostic: string
}

export interface MailLogCollectorCursor {
  logPath: string
  inode: string
  byteOffset: number
  updatedAt: string
}

export interface LogFileSnapshot {
  path: string
  inode: string
  content: string
  rotatedPreviousContent?: string
  rotatedPreviousInode?: string
}

const OPENDKIM_DIR = '/etc/opendkim'
const OPENDKIM_KEYS_DIR = '/etc/opendkim/keys'

const sanitizeDiagnosticText = (raw: string): string =>
  raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .trim()
    .slice(0, 512)

const canonicalizeHeaderRelaxed = (name: string, value: string): string => {
  const cleanName = name.trim().toLowerCase()
  const unfolded = value.replace(/\r?\n[ \t]+/g, ' ')
  const collapsed = unfolded.replace(/[ \t]+/g, ' ').trim()
  return `${cleanName}:${collapsed}`
}

const canonicalizeBodyRelaxed = (body: string): string => {
  const normalized = body.replace(/\r?\n/g, '\r\n')
  const lines = normalized.split('\r\n').map((line) => line.replace(/[ \t]+$/g, '').replace(/[ \t]+/g, ' '))
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines.length === 0 ? '\r\n' : `${lines.join('\r\n')}\r\n`
}

/**
 * Asserts that a queue ID is a genuine Postfix/MTA queue identifier (or `NOQUEUE`),
 * and rejects synthetic UUID prefixes.
 */
export const assertRealMtaQueueId = (queueId: string): string => {
  const trimmed = queueId.trim()
  if (trimmed === 'NOQUEUE') return trimmed
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(trimmed)) {
    fail('VALIDATION', `queueId "${trimmed}" is a UUID, not a real MTA queue ID`)
  }
  if (!/^[0-9A-Za-z_-]{6,32}$/.test(trimmed)) {
    fail('VALIDATION', `invalid MTA queue ID "${trimmed}"`)
  }
  return trimmed
}

/**
 * M03 MailSecurityAndDeliveryAdapter:
 * - Generates & rotates root/opendkim-owned 2048-bit RSA and Ed25519 DKIM keys with selector overlap
 * - Cryptographically signs and verifies RFC 6376 / RFC 8463 DKIM messages
 * - Reconciles SPF and DMARC DNS TXT records without creating duplicate policies
 * - Enforces per-mailbox, per-account, and server-wide outbound rate caps
 * - Incrementally collects Postfix/Dovecot log events across log rotations using persisted inode + byteOffset
 */
export class MailSecurityAndDeliveryAdapter {
  private readonly executor: AgentExecutor
  private readonly os: OsProfile
  private readonly dkimKeysByDomain = new Map<string, DkimSelectorKeyRecord[]>()
  private readonly privateKeysInMemory = new Map<string, string>()
  private readonly outboundWindowLog: {
    accountId: Id
    mailbox: string
    recipients: number
    bytes: number
    atMs: number
  }[] = []
  private readonly cursors = new Map<string, MailLogCollectorCursor>()
  private readonly queueContext = new Map<
    string,
    { sender: string; sizeBytes: number | null; saslUsername: string | null }
  >()

  constructor(opts: { executor: AgentExecutor; os: OsProfile }) {
    this.executor = opts.executor
    this.os = opts.os
  }

  /**
   * Generates a real 2048-bit RSA or Ed25519 DKIM keypair for `domain` + `selector`,
   * writes the private key with mode `0600` (`root:opendkim`), and transitions any previous
   * active selector into `overlapping_previous` for `overlapSeconds` (default 48h) so
   * in-flight messages signed with the prior selector continue to verify.
   */
  async generateOrRotateDkimKey(input: {
    domain: string
    selector: string
    algorithm?: DkimAlgorithm
    overlapSeconds?: number
    now?: Date
  }): Promise<{
    activeKey: DkimPublicExportView
    overlappingKeys: DkimPublicExportView[]
    files: RenderedFile[]
    actions: HostAction[]
  }> {
    const domain = services.normalizeHostname(input.domain, 'DKIM domain')
    const selector = services.assertDkimSelector(input.selector)
    const algorithm: DkimAlgorithm = input.algorithm ?? 'rsa'
    const now = input.now ?? new Date()
    const overlapSeconds = input.overlapSeconds ?? 48 * 3600
    const overlapUntilIso = new Date(now.getTime() + overlapSeconds * 1000).toISOString()

    const existingList = this.dkimKeysByDomain.get(domain) ?? []
    if (existingList.some((k) => k.selector === selector && k.status !== 'retired')) {
      fail('CONFLICT', `DKIM selector "${selector}" is already active or overlapping for ${domain}`)
    }

    let privateKeyPem: string
    let publicKeyPem: string
    if (algorithm === 'ed25519') {
      const pair = generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      })
      privateKeyPem = pair.privateKey
      publicKeyPem = pair.publicKey
    } else {
      const pair = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      })
      privateKeyPem = pair.privateKey
      publicKeyPem = pair.publicKey
    }

    const dnsRecord = services.dkimDnsRecord(domain, selector, publicKeyPem, {
      keyType: algorithm,
    })

    const domainKeyDir = `${OPENDKIM_KEYS_DIR}/${domain}`
    const privateKeyPath = `${domainKeyDir}/${selector}.private`

    // Transition previous active keys to overlapping_previous, and retire expired overlaps
    const updatedList: DkimSelectorKeyRecord[] = existingList.map((prev) => {
      if (prev.status === 'active') {
        return {
          ...prev,
          status: 'overlapping_previous',
          overlapUntil: overlapUntilIso,
        }
      }
      if (
        prev.status === 'overlapping_previous' &&
        prev.overlapUntil &&
        new Date(prev.overlapUntil).getTime() <= now.getTime()
      ) {
        return { ...prev, status: 'retired' }
      }
      return prev
    })

    const newRecord: DkimSelectorKeyRecord = {
      domain,
      selector,
      algorithm,
      privateKeyPath,
      publicKeyPem,
      dnsRecord,
      status: 'active',
      createdAt: now.toISOString(),
      overlapUntil: null,
    }
    updatedList.push(newRecord)
    this.dkimKeysByDomain.set(domain, updatedList)
    this.privateKeysInMemory.set(`${domain}::${selector}`, privateKeyPem)

    const preActions: HostAction[] = [
      { kind: 'ensure-dir', path: OPENDKIM_DIR, mode: 0o750, owner: 'root', group: 'opendkim' },
      { kind: 'ensure-dir', path: OPENDKIM_KEYS_DIR, mode: 0o750, owner: 'root', group: 'opendkim' },
      { kind: 'ensure-dir', path: domainKeyDir, mode: 0o750, owner: 'root', group: 'opendkim' },
    ]

    const privateKeyFile: RenderedFile = {
      path: privateKeyPath,
      content: privateKeyPem,
      mode: 0o600,
      owner: 'root',
      group: 'opendkim',
    }

    const tables = this.renderOpenDkimTables()
    const files: RenderedFile[] = [privateKeyFile, ...tables]
    const postActions: HostAction[] = [
      { kind: 'systemd', verb: 'reload', unit: 'opendkim.service' },
    ]

    for (const a of preActions) await this.executor.runAction(a)
    for (const f of files) await this.executor.writeFile(f)
    for (const a of postActions) await this.executor.runAction(a)

    return {
      activeKey: this.toPublicExportView(newRecord),
      overlappingKeys: updatedList
        .filter((k) => k.status === 'overlapping_previous')
        .map((k) => this.toPublicExportView(k)),
      files,
      actions: [...preActions, ...postActions],
    }
  }

  /**
   * Prunes expired overlapping selectors once their DNS TTL overlap window has elapsed.
   */
  async pruneExpiredDkimSelectors(domain: string, now = new Date()): Promise<string[]> {
    const normDomain = services.normalizeHostname(domain, 'DKIM domain')
    const list = this.dkimKeysByDomain.get(normDomain) ?? []
    const removedSelectors: string[] = []

    for (const item of list) {
      if (
        item.status === 'overlapping_previous' &&
        item.overlapUntil &&
        new Date(item.overlapUntil).getTime() <= now.getTime()
      ) {
        item.status = 'retired'
        removedSelectors.push(item.selector)
        this.privateKeysInMemory.delete(`${normDomain}::${item.selector}`)
        await this.executor.removePath(item.privateKeyPath)
      }
    }
    return removedSelectors
  }

  /**
   * Returns only public DKIM metadata (never exposing `privateKeyPem`).
   */
  listPublicDkimKeys(domain: string): DkimPublicExportView[] {
    const normDomain = services.normalizeHostname(domain, 'DKIM domain')
    return (this.dkimKeysByDomain.get(normDomain) ?? []).map((k) => this.toPublicExportView(k))
  }

  getDkimSelectorRecords(domain: string): DkimSelectorKeyRecord[] {
    const normDomain = services.normalizeHostname(domain, 'DKIM domain')
    return [...(this.dkimKeysByDomain.get(normDomain) ?? [])]
  }

  private toPublicExportView(rec: DkimSelectorKeyRecord): DkimPublicExportView {
    return {
      domain: rec.domain,
      selector: rec.selector,
      algorithm: rec.algorithm,
      dnsName: rec.dnsRecord.name,
      dnsTxtValue: rec.dnsRecord.content,
      status: rec.status,
      createdAt: rec.createdAt,
      overlapUntil: rec.overlapUntil,
    }
  }

  private renderOpenDkimTables(): RenderedFile[] {
    const keyTableLines: string[] = ['# Managed by xPanel: OpenDKIM KeyTable']
    const signingTableLines: string[] = ['# Managed by xPanel: OpenDKIM SigningTable']
    const trustedHostsLines: string[] = [
      '# Managed by xPanel: OpenDKIM TrustedHosts',
      '127.0.0.1',
      '::1',
      'localhost',
    ]

    const domains = [...this.dkimKeysByDomain.keys()].sort()
    for (const domain of domains) {
      trustedHostsLines.push(domain, `*.${domain}`)
      const keys = this.dkimKeysByDomain.get(domain) ?? []
      for (const k of keys) {
        if (k.status === 'retired') continue
        const keyId = `${k.selector}._domainkey.${domain}`
        keyTableLines.push(`${keyId} ${domain}:${k.selector}:${k.privateKeyPath}`)
        if (k.status === 'active') {
          signingTableLines.push(`*@${domain} ${keyId}`)
        }
      }
    }

    return [
      {
        path: `${OPENDKIM_DIR}/KeyTable`,
        content: `${keyTableLines.join('\n')}\n`,
        mode: 0o640,
        owner: 'root',
        group: 'opendkim',
      },
      {
        path: `${OPENDKIM_DIR}/SigningTable`,
        content: `${signingTableLines.join('\n')}\n`,
        mode: 0o640,
        owner: 'root',
        group: 'opendkim',
      },
      {
        path: `${OPENDKIM_DIR}/TrustedHosts`,
        content: `${trustedHostsLines.join('\n')}\n`,
        mode: 0o640,
        owner: 'root',
        group: 'opendkim',
      },
    ]
  }

  /**
   * Signs an outbound RFC 5322 message with the domain's active DKIM selector
   * (`rsa-sha256` or `ed25519-sha256`, `c=relaxed/relaxed`).
   */
  signOutboundMessage(rawMime: string, domain: string, selector?: string): string {
    const normDomain = services.normalizeHostname(domain, 'DKIM domain')
    const keys = this.dkimKeysByDomain.get(normDomain) ?? []
    const keyRec = selector
      ? keys.find((k) => k.selector === selector && k.status !== 'retired')
      : keys.find((k) => k.status === 'active')

    if (!keyRec) {
      return fail('PRECONDITION_FAILED', `No active DKIM key found for domain ${normDomain}`)
    }
    const privPem = this.privateKeysInMemory.get(`${normDomain}::${keyRec.selector}`)
    if (!privPem) {
      return fail(
        'PRECONDITION_FAILED',
        `DKIM private key material is unavailable for ${keyRec.selector}._domainkey.${normDomain}`,
      )
    }

    const normalizedMime = rawMime.replace(/\r?\n/g, '\r\n')
    const splitIdx = normalizedMime.indexOf('\r\n\r\n')
    const rawHeaderBlock = splitIdx >= 0 ? normalizedMime.slice(0, splitIdx) : normalizedMime
    const rawBody = splitIdx >= 0 ? normalizedMime.slice(splitIdx + 4) : ''

    const canonBody = canonicalizeBodyRelaxed(rawBody)
    const bodyHashB64 = createHash('sha256').update(canonBody, 'utf8').digest('base64')

    const unfoldedHeaders = rawHeaderBlock.replace(/\r\n[ \t]+/g, ' ').split('\r\n')
    const headerMap = new Map<string, string>()
    for (const line of unfoldedHeaders) {
      const idx = line.indexOf(':')
      if (idx > 0) {
        headerMap.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim())
      }
    }

    const signedHeaderNames = ['from', 'to', 'subject', 'date', 'message-id'].filter((h) =>
      headerMap.has(h),
    )
    const algTag = keyRec.algorithm === 'ed25519' ? 'ed25519-sha256' : 'rsa-sha256'
    const timestamp = Math.floor(Date.now() / 1000)

    const dkimValueWithoutB = `v=1; a=${algTag}; c=relaxed/relaxed; d=${normDomain}; s=${keyRec.selector}; t=${timestamp}; bh=${bodyHashB64}; h=${signedHeaderNames.join(':')}; b=`
    const canonHeaders = [
      ...signedHeaderNames.map((h) => canonicalizeHeaderRelaxed(h, headerMap.get(h)!)),
      canonicalizeHeaderRelaxed('dkim-signature', dkimValueWithoutB),
    ].join('\r\n')

    const privKeyObj = createPrivateKey(privPem)
    const signatureB64 =
      keyRec.algorithm === 'ed25519'
        ? cryptoSign(null, Buffer.from(canonHeaders, 'utf8'), privKeyObj).toString('base64')
        : cryptoSign('sha256', Buffer.from(canonHeaders, 'utf8'), privKeyObj).toString('base64')

    const dkimHeader = `DKIM-Signature: ${dkimValueWithoutB}${signatureB64}`
    return `${dkimHeader}\r\n${normalizedMime}`
  }

  /**
   * Verifies a signed RFC 5322 message's `DKIM-Signature` against the published DNS TXT record (`v=DKIM1; ...`).
   */
  verifyDkimSignature(
    signedMime: string,
    dnsTxtRecordContent: string,
  ): { valid: boolean; domain: string; selector: string; reason?: string } {
    const normalizedMime = signedMime.replace(/\r?\n/g, '\r\n')
    const splitIdx = normalizedMime.indexOf('\r\n\r\n')
    const rawHeaderBlock = splitIdx >= 0 ? normalizedMime.slice(0, splitIdx) : normalizedMime
    const rawBody = splitIdx >= 0 ? normalizedMime.slice(splitIdx + 4) : ''

    const unfoldedHeaders = rawHeaderBlock.replace(/\r\n[ \t]+/g, ' ').split('\r\n')
    const headerMap = new Map<string, string>()
    for (const line of unfoldedHeaders) {
      const idx = line.indexOf(':')
      if (idx > 0) {
        headerMap.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim())
      }
    }

    const dkimRaw = headerMap.get('dkim-signature')
    if (!dkimRaw) {
      return { valid: false, domain: '', selector: '', reason: 'missing DKIM-Signature header' }
    }

    const tags = new Map<string, string>()
    for (const part of dkimRaw.split(';')) {
      const eq = part.indexOf('=')
      if (eq > 0) {
        tags.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim())
      }
    }

    const domain = tags.get('d') ?? ''
    const selector = tags.get('s') ?? ''
    const bh = tags.get('bh') ?? ''
    const b = (tags.get('b') ?? '').replace(/\s+/g, '')
    const hList = (tags.get('h') ?? '')
      .split(':')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
    const alg = tags.get('a') ?? 'rsa-sha256'

    const canonBody = canonicalizeBodyRelaxed(rawBody)
    const actualBh = createHash('sha256').update(canonBody, 'utf8').digest('base64')
    if (actualBh !== bh) {
      return { valid: false, domain, selector, reason: 'body hash mismatch' }
    }

    const pMatch = /(?:^|;)\s*p=([A-Za-z0-9+/=]+)/.exec(dnsTxtRecordContent)
    if (!pMatch || !pMatch[1]) {
      return { valid: false, domain, selector, reason: 'missing public key in DNS TXT record' }
    }

    const dkimWithoutB = dkimRaw.replace(/b=[A-Za-z0-9+/=\s]+$/, 'b=')
    const signingInput = [
      ...hList.map((h) => canonicalizeHeaderRelaxed(h, headerMap.get(h) ?? '')),
      canonicalizeHeaderRelaxed('dkim-signature', dkimWithoutB),
    ].join('\r\n')

    try {
      let pubKeyPem: string
      if (alg === 'ed25519-sha256') {
        const rawPub = Buffer.from(pMatch[1], 'base64')
        const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex')
        const spkiDer = rawPub.length === 32 ? Buffer.concat([spkiPrefix, rawPub]) : rawPub
        pubKeyPem = `-----BEGIN PUBLIC KEY-----\n${spkiDer.toString('base64')}\n-----END PUBLIC KEY-----`
        const valid = cryptoVerify(
          null,
          Buffer.from(signingInput, 'utf8'),
          createPublicKey(pubKeyPem),
          Buffer.from(b, 'base64'),
        )
        return { valid, domain, selector, ...(valid ? {} : { reason: 'signature verification failed' }) }
      }

      pubKeyPem = `-----BEGIN PUBLIC KEY-----\n${pMatch[1]}\n-----END PUBLIC KEY-----`
      const valid = cryptoVerify(
        'sha256',
        Buffer.from(signingInput, 'utf8'),
        createPublicKey(pubKeyPem),
        Buffer.from(b, 'base64'),
      )
      return { valid, domain, selector, ...(valid ? {} : { reason: 'signature verification failed' }) }
    } catch (err) {
      return {
        valid: false,
        domain,
        selector,
        reason: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /**
   * Validates and reconciles SPF, DMARC, and active/overlapping DKIM TXT records on a domain zone
   * without ever creating duplicate `v=spf1` or `_dmarc` TXT records.
   */
  reconcileDomainEmailAuthRecords(input: SpfDmarcPolicyInput): ReconciledEmailAuthDns {
    const domain = services.normalizeHostname(input.domain, 'domain')
    if (!Array.isArray(input.ipv4) || input.ipv4.length === 0) {
      fail('VALIDATION', 'at least one IPv4 address is required for SPF record')
    }
    const ipv4Tokens = [...new Set(input.ipv4.map((ip) => `ip4:${services.canonicalIpv4(ip)}`))].sort()
    const ipv6Tokens = [
      ...new Set((input.ipv6 ?? []).filter(Boolean).map((ip) => `ip6:${services.canonicalIpv6(ip)}`)),
    ].sort()
    const includeTokens = [
      ...new Set((input.includeDomains ?? []).map((d) => `include:${services.normalizeHostname(d, 'SPF include')}`)),
    ].sort()
    const spfMode = input.spfMode ?? '~all'
    if (spfMode !== '~all' && spfMode !== '-all') {
      fail('VALIDATION', 'spfMode must be ~all or -all')
    }

    const dmarcPolicy = input.dmarcPolicy ?? 'quarantine'
    if (!['none', 'quarantine', 'reject'].includes(dmarcPolicy)) {
      fail('VALIDATION', 'dmarcPolicy must be none, quarantine, or reject')
    }
    const adkim = input.dmarcAlignmentDkim ?? 'r'
    const aspf = input.dmarcAlignmentSpf ?? 'r'
    const rua = input.ruaEmail
      ? services.normalizeEmail(input.ruaEmail, 'DMARC rua').address
      : `postmaster@${domain}`

    const spfContent = [
      'v=spf1',
      'a',
      'mx',
      ...ipv4Tokens,
      ...ipv6Tokens,
      ...includeTokens,
      spfMode,
    ].join(' ')

    const dmarcParts = [
      'v=DMARC1',
      `p=${dmarcPolicy}`,
      ...(input.dmarcSubdomainPolicy ? [`sp=${input.dmarcSubdomainPolicy}`] : []),
      `adkim=${adkim}`,
      `aspf=${aspf}`,
      `rua=mailto:${rua}`,
    ]
    const dmarcContent = dmarcParts.join('; ')

    const activeDkimSelectorNames = new Set(
      input.dkimSelectors.filter((k) => k.status !== 'retired').map((k) => `${k.selector}._domainkey`),
    )

    let replacedDuplicateSpfCount = 0
    let replacedDuplicateDmarcCount = 0

    const preservedRecords: DnsRecord[] = []
    for (const r of input.existingRecords) {
      const isSpf = r.type === 'TXT' && r.name === '@' && /^v=spf1\b/i.test(r.content.trim())
      if (isSpf) {
        replacedDuplicateSpfCount++
        continue
      }
      const isDmarc =
        r.type === 'TXT' &&
        (r.name === '_dmarc' || /^v=DMARC1\b/i.test(r.content.trim()))
      if (isDmarc) {
        replacedDuplicateDmarcCount++
        continue
      }
      const isManagedDkim =
        r.type === 'TXT' &&
        (activeDkimSelectorNames.has(r.name) ||
          (r.name.endsWith('._domainkey') && /^v=DKIM1\b/i.test(r.content.trim())))
      if (isManagedDkim) {
        continue
      }
      preservedRecords.push(r)
    }

    const spfRecord: DnsRecord = {
      id: `spf-${domain}`,
      zone: domain,
      name: '@',
      type: 'TXT',
      ttl: 3600,
      content: spfContent,
      priority: null,
    }

    const dmarcRecord: DnsRecord = {
      id: `dmarc-${domain}`,
      zone: domain,
      name: '_dmarc',
      type: 'TXT',
      ttl: 3600,
      content: dmarcContent,
      priority: null,
    }

    const dkimRecords: DnsRecord[] = input.dkimSelectors
      .filter((k) => k.status !== 'retired')
      .map((k) => ({
        id: `dkim-${domain}-${k.selector}`,
        zone: domain,
        name: k.dnsRecord.name,
        type: 'TXT',
        ttl: k.dnsRecord.ttl,
        content: k.dnsRecord.content,
        priority: null,
      }))

    return {
      domain,
      records: [...preservedRecords, spfRecord, dmarcRecord, ...dkimRecords],
      replacedDuplicateSpfCount,
      replacedDuplicateDmarcCount,
      spfRecord,
      dmarcRecord,
      dkimRecords,
    }
  }

  /**
   * Evaluates and records per-mailbox, per-account, and server-wide hourly outbound rate limits.
   */
  evaluateOutboundAbusePolicy(
    config: OutboundRateCapConfig,
    input: OutboundRateCheckInput,
  ): OutboundRateDecision {
    const nowMs = input.nowMs ?? Date.now()
    const windowStartMs = nowMs - 3600 * 1000
    const mailbox = input.mailbox.trim().toLowerCase()

    // Prune entries older than 1 hour
    while (this.outboundWindowLog.length > 0 && this.outboundWindowLog[0]!.atMs < windowStartMs) {
      this.outboundWindowLog.shift()
    }

    const mailboxEntries = this.outboundWindowLog.filter((e) => e.mailbox === mailbox)
    const accountEntries = this.outboundWindowLog.filter((e) => e.accountId === input.accountId)

    const mailboxMessages = mailboxEntries.length
    const mailboxRecipients = mailboxEntries.reduce((sum, e) => sum + e.recipients, 0)
    const mailboxBytes = mailboxEntries.reduce((sum, e) => sum + e.bytes, 0)
    const accountMessages = accountEntries.length
    const serverMessages = this.outboundWindowLog.length

    const exceededReasons: string[] = []
    if (mailboxMessages + 1 > config.mailboxMaxMessagesPerHour) {
      exceededReasons.push(`mailbox hourly message cap (${config.mailboxMaxMessagesPerHour}/h)`)
    }
    if (mailboxRecipients + input.recipientCount > config.mailboxMaxRecipientsPerHour) {
      exceededReasons.push(`mailbox hourly recipient cap (${config.mailboxMaxRecipientsPerHour}/h)`)
    }
    if (mailboxBytes + input.messageBytes > config.mailboxMaxBytesPerHour) {
      exceededReasons.push(`mailbox hourly byte cap (${config.mailboxMaxBytesPerHour}B/h)`)
    }
    if (accountMessages + 1 > config.accountMaxMessagesPerHour) {
      exceededReasons.push(`account hourly message cap (${config.accountMaxMessagesPerHour}/h)`)
    }
    if (serverMessages + 1 > config.serverMaxMessagesPerHour) {
      exceededReasons.push(`server hourly message cap (${config.serverMaxMessagesPerHour}/h)`)
    }

    if (exceededReasons.length > 0) {
      if (input.operatorOverrideReason && input.operatorOverrideReason.trim().length > 0) {
        this.outboundWindowLog.push({
          accountId: input.accountId,
          mailbox,
          recipients: input.recipientCount,
          bytes: input.messageBytes,
          atMs: nowMs,
        })
        return {
          allowed: true,
          outcome: 'operator_override',
          smtpCode: 250,
          smtpMessage: `250 2.0.0 Accepted via audited operator override (${input.operatorOverrideReason.trim()})`,
          mailboxUsedMessagesLastHour: mailboxMessages + 1,
          accountUsedMessagesLastHour: accountMessages + 1,
        }
      }

      const code = config.exceedAction === 'defer' ? 450 : 550
      return {
        allowed: false,
        outcome: config.exceedAction === 'defer' ? 'deferred' : 'rejected',
        smtpCode: code,
        smtpMessage: `${code} 4.7.1 Outbound rate limit exceeded: ${exceededReasons.join(', ')}`,
        mailboxUsedMessagesLastHour: mailboxMessages,
        accountUsedMessagesLastHour: accountMessages,
      }
    }

    this.outboundWindowLog.push({
      accountId: input.accountId,
      mailbox,
      recipients: input.recipientCount,
      bytes: input.messageBytes,
      atMs: nowMs,
    })

    return {
      allowed: true,
      outcome: 'allowed',
      smtpCode: 250,
      smtpMessage: '250 2.0.0 Ok',
      mailboxUsedMessagesLastHour: mailboxMessages + 1,
      accountUsedMessagesLastHour: accountMessages + 1,
    }
  }

  /**
   * Incrementally parses Postfix/Dovecot mail log lines from `snapshot` using a persisted
   * `(inode, byteOffset)` cursor, handling log rotation seamlessly without double-counting
   * or dropping lines at the end of the rotated log file.
   */
  collectMailDeliveryEvents(snapshot: LogFileSnapshot): {
    events: MailDeliveryLogEvent[]
    cursor: MailLogCollectorCursor
    rotated: boolean
  } {
    const prevCursor = this.cursors.get(snapshot.path) ?? null
    let rawChunk = ''
    let rotated = false

    const currentBuf = Buffer.from(snapshot.content, 'utf8')

    if (!prevCursor) {
      rawChunk = snapshot.content
    } else if (prevCursor.inode === snapshot.inode && currentBuf.length >= prevCursor.byteOffset) {
      rawChunk = currentBuf.subarray(prevCursor.byteOffset).toString('utf8')
    } else {
      // Log rotation detected (inode changed or file truncated)
      rotated = true
      let remainderFromOld = ''
      if (
        snapshot.rotatedPreviousContent !== undefined &&
        (!snapshot.rotatedPreviousInode || snapshot.rotatedPreviousInode === prevCursor.inode)
      ) {
        const oldBuf = Buffer.from(snapshot.rotatedPreviousContent, 'utf8')
        if (oldBuf.length > prevCursor.byteOffset) {
          remainderFromOld = oldBuf.subarray(prevCursor.byteOffset).toString('utf8')
        }
      }
      rawChunk = `${remainderFromOld}\n${snapshot.content}`
    }

    const nextCursor: MailLogCollectorCursor = {
      logPath: snapshot.path,
      inode: snapshot.inode,
      byteOffset: currentBuf.length,
      updatedAt: new Date().toISOString(),
    }
    this.cursors.set(snapshot.path, nextCursor)

    const events: MailDeliveryLogEvent[] = []

    const lines = rawChunk
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)

    for (const line of lines) {
      const parsed = this.parseMtaLogLine(line, this.queueContext)
      if (parsed) {
        events.push(parsed)
      }
    }

    return { events, cursor: nextCursor, rotated }
  }

  /**
   * Filters delivery log events by owner domains so Tenant A never sees Tenant B's mail logs.
   */
  filterEventsForOwner(
    events: readonly MailDeliveryLogEvent[],
    caller: { isRoot: boolean; ownedDomains: readonly string[] },
  ): MailDeliveryLogEvent[] {
    if (caller.isRoot) return [...events]
    const domainSet = new Set(caller.ownedDomains.map((d) => d.toLowerCase()))
    return events.filter((ev) => {
      const senderDomain = ev.sender?.split('@')[1]?.toLowerCase()
      const rcptDomain = ev.recipient?.split('@')[1]?.toLowerCase()
      const evDomain = ev.domain?.toLowerCase()
      return (
        (senderDomain !== undefined && domainSet.has(senderDomain)) ||
        (rcptDomain !== undefined && domainSet.has(rcptDomain)) ||
        (evDomain !== undefined && domainSet.has(evDomain))
      )
    })
  }

  private parseMtaLogLine(
    line: string,
    queueContext: Map<string, { sender: string; sizeBytes: number | null; saslUsername: string | null }>,
  ): MailDeliveryLogEvent | null {
    // Match ISO timestamp or syslog timestamp + daemon + message
    const headMatch = /^(\S+)\s+\S+\s+(postfix\/[a-z0-9_/-]+|dovecot)(?:\[\d+\])?:\s+(.*)$/i.exec(line)
    if (!headMatch) return null
    const timestamp = headMatch[1]!
    const daemon = headMatch[2]!.toLowerCase()
    const payload = headMatch[3]!

    // 1. NOQUEUE reject
    if (payload.startsWith('NOQUEUE: reject:')) {
      const fromMatch = /\bfrom=<([^>]*)>/i.exec(payload)
      const toMatch = /\bto=<([^>]*)>/i.exec(payload)
      const codeMatch = /\b([45]\d{2})\s+(?:[45]\.\d\.\d\s+)?([^;]+)/.exec(payload)
      const sender = fromMatch?.[1]?.toLowerCase() || null
      const recipient = toMatch?.[1]?.toLowerCase() || null
      const domain = recipient?.split('@')[1] ?? sender?.split('@')[1] ?? null
      return {
        queueId: 'NOQUEUE',
        stage: 'rejected',
        timestamp,
        daemon,
        sender,
        recipient,
        domain,
        saslUsername: null,
        relay: null,
        smtpCode: codeMatch ? Number.parseInt(codeMatch[1]!, 10) : 550,
        sizeBytes: null,
        sanitizedDiagnostic: sanitizeDiagnosticText(payload),
      }
    }

    const qMatch = /^([0-9A-Za-z]{6,32}):\s+(.*)$/.exec(payload)
    if (!qMatch) return null
    const queueId = assertRealMtaQueueId(qMatch[1]!)
    const rest = qMatch[2]!

    // 2. Submission accepted: `client=..., sasl_method=PLAIN, sasl_username=alice@example.com`
    if (/\bclient=/.test(rest)) {
      const saslMatch = /\bsasl_username=([^\s,]+)/i.exec(rest)
      const saslUsername = saslMatch ? saslMatch[1]!.toLowerCase() : null
      const prev = queueContext.get(queueId)
      queueContext.set(queueId, {
        sender: prev?.sender ?? saslUsername ?? '',
        sizeBytes: prev?.sizeBytes ?? null,
        saslUsername,
      })
      return {
        queueId,
        stage: 'accepted',
        timestamp,
        daemon,
        sender: saslUsername,
        recipient: null,
        domain: saslUsername?.split('@')[1] ?? null,
        saslUsername,
        relay: null,
        smtpCode: 250,
        sizeBytes: null,
        sanitizedDiagnostic: sanitizeDiagnosticText(rest),
      }
    }

    // 3. Queue active (`qmgr: from=<...>, size=2048, nrcpt=1 (queue active)`)
    if (/\bfrom=<([^>]*)>/.test(rest) && /\(queue active\)/i.test(rest)) {
      const fromMatch = /\bfrom=<([^>]*)>/i.exec(rest)
      const sizeMatch = /\bsize=(\d+)/i.exec(rest)
      const sender = (fromMatch?.[1] ?? '').toLowerCase()
      const sizeBytes = sizeMatch ? Number.parseInt(sizeMatch[1]!, 10) : null
      const prev = queueContext.get(queueId)
      queueContext.set(queueId, {
        sender,
        sizeBytes,
        saslUsername: prev?.saslUsername ?? null,
      })
      return {
        queueId,
        stage: 'queued',
        timestamp,
        daemon,
        sender: sender || null,
        recipient: null,
        domain: sender.split('@')[1] ?? null,
        saslUsername: prev?.saslUsername ?? null,
        relay: null,
        smtpCode: 250,
        sizeBytes,
        sanitizedDiagnostic: sanitizeDiagnosticText(rest),
      }
    }

    // 4. Delivery outcome (`to=<...>, relay=..., status=sent|deferred|bounced (...)`)
    const statusMatch = /\bto=<([^>]+)>.*?\bstatus=(sent|deferred|bounced)\s+\((.+)\)$/i.exec(rest)
    if (statusMatch) {
      const recipient = statusMatch[1]!.toLowerCase()
      const rawStatus = statusMatch[2]!.toLowerCase()
      const detail = statusMatch[3]!
      const relayMatch = /\brelay=([^\s,]+)/i.exec(rest)
      const codeMatch = /\b([245]\d{2})\b/.exec(detail)
      const ctx = queueContext.get(queueId)

      const stage: MtaDeliveryStage =
        rawStatus === 'sent' ? 'delivered' : rawStatus === 'deferred' ? 'deferred' : 'bounced'
      const defaultCode = stage === 'delivered' ? 250 : stage === 'deferred' ? 451 : 550

      return {
        queueId,
        stage,
        timestamp,
        daemon,
        sender: ctx?.sender || null,
        recipient,
        domain: ctx?.sender?.split('@')[1] ?? recipient.split('@')[1] ?? null,
        saslUsername: ctx?.saslUsername ?? null,
        relay: relayMatch ? relayMatch[1]! : null,
        smtpCode: codeMatch ? Number.parseInt(codeMatch[1]!, 10) : defaultCode,
        sizeBytes: ctx?.sizeBytes ?? null,
        sanitizedDiagnostic: sanitizeDiagnosticText(detail),
      }
    }

    return null
  }
}
