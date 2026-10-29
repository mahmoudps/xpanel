import type { Limit, Locale } from '@xpanel/core'
import type { Db } from '@xpanel/db'
import { ExtendedFeaturesStore, type EmailFilter, type StateStore } from '@xpanel/state'
import { translator } from '../../../web/src/i18n.ts'
import { mailboxSessionPassword, requireMailboxSessionRecord, type MailboxTransport } from './inbox.ts'

export interface MailDocumentAttachment {
  name: string
  sizeBytes: number
}

export interface MailDocumentMessage {
  uid: number
  folder: string
  from: string
  fromName?: string
  to: string
  cc?: string
  subject: string
  preview: string
  body: string
  receivedAt: string
  unread: boolean
  attachments?: MailDocumentAttachment[]
  /** The list fetch did not include a body for this row. The open action reads it. */
  bodyPending?: boolean
}

export interface MailDocumentFolderCount {
  folder: string
  total: number
  unread: number
}

export interface MailDocumentRule {
  id: string
  name: string
  condition: string
  action: string
  enabled: boolean
}

export interface MailDocument {
  mailbox: string
  quotaUsedMb?: number
  quotaUsedBytes?: number
  quotaLimitMb?: Limit
  messages?: MailDocumentMessage[]
  folderCounts?: MailDocumentFolderCount[]
  mailListFailed?: boolean
  vacationEnabled?: boolean
  sieveRules?: MailDocumentRule[]
  identityDkim?: string
  identitySpf?: string
  identitySize?: string
  composeDraft?: MailComposeDraft
}

export interface MailComposeDraft {
  to: string
  cc: string
  subject: string
  body: string
}

const quoted = (body: string): string => body.replace(/\r\n/g, '\n').split('\n').map(line => `> ${line}`).join('\n')

const withPrefix = (subject: string, prefix: 'Re:' | 'Fwd:'): string => {
  const trimmed = subject.trim()
  return trimmed.toLowerCase().startsWith(prefix.toLowerCase()) ? trimmed : `${prefix} ${trimmed}`
}

const addressOf = (value: string): string => {
  const angle = /<([^>]+)>/.exec(value)
  return (angle?.[1] ?? value).trim().toLowerCase()
}

const splitAddresses = (value: string): string[] => {
  const parts: string[] = []
  let current = ''
  let quoted = false
  let angle = false
  for (const ch of value) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && ch === '<') angle = true
    else if (!quoted && ch === '>') angle = false
    if ((ch === ',' || ch === ';') && !quoted && !angle) {
      if (current.trim()) parts.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) parts.push(current.trim())
  return parts.filter(part => part.includes('@'))
}

/** Reply, reply-all, or forward. The quoted body is the original text. */
export const composeDraftFromMessage = (input: {
  mode: 'reply' | 'reply-all' | 'forward'
  mailbox: string
  from: string
  fromName?: string
  to: string
  cc?: string
  subject: string
  body: string
}): MailComposeDraft => {
  const sender = input.fromName && input.fromName.trim().length > 0 ? `${input.fromName.trim()} <${input.from}>` : input.from
  const quote = input.mode === 'forward'
    ? `---------- Forwarded message ----------\nFrom: ${sender}\nSubject: ${input.subject}\n\n${quoted(input.body)}`
    : quoted(input.body)
  const body = `\n\n${quote}`
  if (input.mode === 'forward') {
    return { to: '', cc: '', subject: withPrefix(input.subject, 'Fwd:'), body }
  }
  const mailbox = addressOf(input.mailbox)
  const senderAddr = addressOf(input.from)
  if (input.mode === 'reply') return { to: sender, cc: '', subject: withPrefix(input.subject, 'Re:'), body }
  const cc = [...splitAddresses(input.to), ...splitAddresses(input.cc ?? '')]
    .filter(addr => addressOf(addr) !== mailbox && addressOf(addr) !== senderAddr)
  return { to: sender, cc: cc.join(', '), subject: withPrefix(input.subject, 'Re:'), body }
}

/** `postconf -h message_size_limit` prints the compiled value even when main.cf omits the key. */
export const messageSizeLimitFromPostconf = (stdout: string): number | null => {
  const text = stdout.trim()
  if (!/^\d+$/.test(text)) return null
  const bytes = Number(text)
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null
}

/** `message_size_limit` bytes from a Postfix main.cf. */
export const messageSizeLimitBytes = (mainCf: string): number | null => {
  const match = /^[ \t]*message_size_limit[ \t]*=[ \t]*(\d+)[ \t]*$/m.exec(mainCf)
  if (!match) return null
  const bytes = Number(match[1])
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null
}

/** True when smtpd_milters names a socket. A configured socket is not a connection. */
export const smtpdMiltersConfigured = (mainCf: string): boolean => {
  const match = /^[ \t]*smtpd_milters[ \t]*=[ \t]*(.*)$/m.exec(mainCf)
  const value = match?.[1]?.trim() ?? ''
  return value.length > 0
}

/** @deprecated A milter line is configuration. The compose page uses `dkimIdentityLine`. */
export const smtpdMiltersConnected = smtpdMiltersConfigured

export type DkimProbeStatus = 'signing' | 'refused' | 'unknown'

/** The compose label. It names the probe result, never the presence of a milter line. */
export const dkimIdentityLine = (status: DkimProbeStatus, selector: string | undefined, locale?: Locale): string => {
  const t = translator(locale)
  if (status === 'signing' && selector) return t('OpenDKIM is signing with {selector}', { selector })
  if (status === 'signing') return t('OpenDKIM is signing')
  if (status === 'refused') return t('OpenDKIM refused the connection')
  return t('OpenDKIM status unknown')
}

/** 10,240,000 B is 9.77 MiB and is shown as 10 MB. Values under 9.5 MB keep one decimal. */
export const formatMessageSizeLimit = (bytes: number): string | null => {
  if (!Number.isFinite(bytes) || bytes <= 0) return null
  const mb = bytes / (1024 * 1024)
  if (mb >= 9.5) return `${Math.round(mb)} MB`
  return `${mb.toFixed(mb >= 1 ? 1 : 2)} MB`
}

const fieldLabel: Record<string, string> = {
  from: 'From', to: 'To', subject: 'Subject', body: 'Body', header: 'Header',
}
const operatorLabel: Record<string, string> = {
  contains: 'contains', equals: 'equals', matches: 'matches', startsWith: 'starts with', endsWith: 'ends with',
}

const ruleCondition = (filter: EmailFilter): string =>
  filter.rules.map(rule => `${fieldLabel[rule.field] ?? rule.field} ${operatorLabel[rule.operator] ?? rule.operator} ${rule.value}`).join('; ')

const ruleAction = (filter: EmailFilter): string => {
  if (filter.action === 'discard') return 'Discard'
  if (filter.action === 'reject') return 'Reject'
  if (filter.action === 'redirect') return filter.actionTarget ? `Redirect to ${filter.actionTarget}` : 'Redirect'
  if (filter.action === 'folder') return filter.actionTarget ? `File into ${filter.actionTarget}` : 'File into a folder'
  return filter.actionTarget ? `${filter.action} ${filter.actionTarget}` : filter.action
}

const zoneTxt = (
  records: readonly { name: string; type: string; content: string }[],
  zone: string,
  owner: string,
): string[] => records.filter(record => record.type === 'TXT').filter(record => {
  const raw = record.name.trim().toLowerCase().replace(/\.$/, '')
  const name = raw === '@' || raw === '' || raw === zone ? '@' : raw.endsWith(`.${zone}`) ? raw.slice(0, -(zone.length + 1)) : raw
  return name === owner
}).map(record => record.content)

const previewOf = (text: string): string =>
  text.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0)?.slice(0, 180) ?? ''

const UNSAVED_SETTINGS = new Date(0).toISOString()

/**
 * Reads the values the xMail pages are allowed to show.
 * A missing vacation file is off. Filters, DKIM and the size limit stay unknown when their files could not be read.
 */
export const loadMailDocument = async (input: {
  db: Db
  store: StateStore
  serverSecret: string
  sessionId: string | null
  transport: MailboxTransport
  folder?: string
  /** A list refresh must not automatically mark a message Seen. */
  readFirst?: boolean
  /** Postfix main.cf text. Absent when the file could not be read. */
  postfixMain?: string | null
  /** Result of a socket connect as the postfix user. Omitted means the probe did not run. */
  dkimProbe?: DkimProbeStatus
  /** Public DKIM material from the live writer. The private key is not here. */
  dkimByDomain?: Readonly<Record<string, { selector: string; dnsTxt: string }>>
  zones?: readonly { name: string; records: readonly { name: string; type: string; content: string }[] }[]
  locale?: Locale
  reply?: { mode: 'reply' | 'reply-all' | 'forward'; uid: number }
}): Promise<MailDocument> => {
  if (!input.sessionId) return { mailbox: '' }
  const record = await requireMailboxSessionRecord(input.db, input.sessionId)
  const password = mailboxSessionPassword(record, input.serverSecret)
  const snap = await input.store.readSnapshot()
  const serviceUser = snap.serviceUsers.find(user => user.accountId === record.accountId && user.login.toLowerCase() === record.mailbox)
  const extended = new ExtendedFeaturesStore(input.store.rootDir)
  const document: MailDocument = { mailbox: record.mailbox }
  if (serviceUser) document.quotaLimitMb = serviceUser.mailboxQuotaMb

  try {
    const vacation = await extended.storedVacationResponder(record.mailbox)
    document.vacationEnabled = vacation ? vacation.enabled : false
  } catch { /* the file could not be read; the page keeps the unknown mark */ }

  try {
    const filters = await extended.listEmailFilters(record.accountId, record.mailbox)
    document.sieveRules = filters.map(filter => ({
      id: filter.id,
      name: filter.name,
      condition: ruleCondition(filter),
      action: ruleAction(filter),
      enabled: filter.enabled,
    }))
  } catch { /* unknown, not zero */ }

  try {
    const domain = (record.mailbox.split('@')[1] ?? '').toLowerCase()
    const locale = input.locale
    const auth = domain ? await extended.readEmailAuth(domain) : null
    const material = domain ? input.dkimByDomain?.[domain] : undefined
    const zone = input.zones?.find(item => item.name.toLowerCase() === domain)
    const records = zone?.records ?? []
    const probe = input.dkimProbe
    const haveProbe = probe === 'signing' || probe === 'refused' || probe === 'unknown'
    const postfixMain = typeof input.postfixMain === 'string' ? input.postfixMain : null
    if (haveProbe || material || auth || postfixMain !== null) {
      if (haveProbe || material) {
        const line = dkimIdentityLine(haveProbe ? probe : 'unknown', material?.selector, locale)
        document.identityDkim = material?.dnsTxt ? `${line} · ${material.dnsTxt}` : line
      } else if (auth?.dkimTxtValue) {
        document.identityDkim = `Selector ${auth.selector} is stored for ${auth.domain}`
      } else {
        document.identityDkim = dkimIdentityLine('unknown', undefined, locale)
      }
      const zoneSpf = zoneTxt(records, domain, '@').find(content => content.toLowerCase().startsWith('v=spf1'))
      const zoneDmarc = zoneTxt(records, domain, '_dmarc').find(content => content.toLowerCase().startsWith('v=dmarc1'))
      const spf = zoneSpf ?? auth?.spfTxtValue ?? (material ? 'v=spf1 a mx ~all' : null)
      const dmarc = zoneDmarc ?? auth?.dmarcTxtValue ?? (material ? 'v=DMARC1; p=none' : null)
      const spfLabel = spf ?? translator(locale)('SPF record missing')
      const dmarcLabel = dmarc ?? translator(locale)('DMARC record missing')
      document.identitySpf = `${spfLabel} · ${dmarcLabel}`
    }
  } catch { /* unknown */ }

  try {
    const fine = await extended.getServerFineSettings() as {
      updatedAt?: string
      mtaMaxMsgSizeMb?: number
      mta?: { maxMessageSizeMb?: number }
    }
    const fromFile = typeof input.postfixMain === 'string' ? messageSizeLimitBytes(input.postfixMain) : null
    const formatted = fromFile !== null ? formatMessageSizeLimit(fromFile) : null
    if (formatted) document.identitySize = formatted
    else {
      const size = fine.mta?.maxMessageSizeMb ?? fine.mtaMaxMsgSizeMb
      if (fine.updatedAt && fine.updatedAt !== UNSAVED_SETTINGS && typeof size === 'number' && Number.isFinite(size) && size > 0) {
        document.identitySize = `${size} MiB per message`
      }
    }
  } catch { /* unknown */ }

  // A handed-off session has no mailbox credential: the message list is unavailable, never empty.
  if (password === null) {
    document.mailListFailed = true
    return document
  }
  try {
    if (input.transport.quota) {
      const measured = await input.transport.quota(record.mailbox, password)
      if (measured) {
        document.quotaUsedMb = measured.usedMb
        if (typeof measured.usedBytes === 'number') document.quotaUsedBytes = measured.usedBytes
      }
    }
  } catch { /* usage stays unknown */ }

  const folder = input.folder && input.folder.length > 0 ? input.folder : 'INBOX'
  try {
    const listed = await input.transport.list(record.mailbox, password, folder)
    const messages: MailDocumentMessage[] = listed.map(item => ({
      uid: item.uid,
      folder,
      from: item.from,
      ...(item.fromName ? { fromName: item.fromName } : {}),
      to: item.to,
      ...(item.cc ? { cc: item.cc } : {}),
      subject: item.subject,
      preview: item.preview ?? '',
      body: '',
      receivedAt: item.receivedAt,
      unread: item.unread,
      ...(item.attachments && item.attachments.length > 0 ? { attachments: item.attachments } : {}),
      bodyPending: true,
    }))
    const first = messages[0]
    if (first && input.readFirst !== false) {
      try {
        const full = await input.transport.read(record.mailbox, password, first.uid, folder)
        first.body = full.body
        first.unread = full.unread
        first.bodyPending = false
        if (full.fromName) first.fromName = full.fromName
        if (full.cc) first.cc = full.cc
        if (full.attachments && full.attachments.length > 0) first.attachments = full.attachments
        if (!first.preview) first.preview = previewOf(full.body)
      } catch { /* the row stays pending */ }
    }
    document.messages = messages
  } catch {
    document.mailListFailed = true
  }
  try {
    if (input.transport.counts) {
      document.folderCounts = await input.transport.counts(record.mailbox, password)
    }
  } catch { /* folder counts stay unknown */ }
  if (input.reply && Number.isInteger(input.reply.uid) && input.reply.uid > 0) {
    try {
      const source = await input.transport.read(record.mailbox, password, input.reply.uid, folder)
      document.composeDraft = composeDraftFromMessage({
        mode: input.reply.mode,
        mailbox: record.mailbox,
        from: source.from,
        ...(source.fromName ? { fromName: source.fromName } : {}),
        to: source.to,
        ...(source.cc ? { cc: source.cc } : {}),
        subject: source.subject,
        body: source.body,
      })
    } catch { /* compose stays empty when that message cannot be read */ }
  }
  return document
}
