import type { Limit } from '@xpanel/core'
import type { Db } from '@xpanel/db'
import { ExtendedFeaturesStore, type EmailFilter, type StateStore } from '@xpanel/state'
import { openMailboxSession, type MailboxTransport } from './inbox.ts'

export interface MailDocumentMessage {
  uid: number
  folder: 'INBOX'
  from: string
  to: string
  subject: string
  preview: string
  body: string
  receivedAt: string
  unread: boolean
  /** The list fetch did not include a body for this row. The open action reads it. */
  bodyPending?: boolean
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
  quotaLimitMb?: Limit
  messages?: MailDocumentMessage[]
  mailListFailed?: boolean
  vacationEnabled?: boolean
  sieveRules?: MailDocumentRule[]
  identityDkim?: string
  identitySpf?: string
  identitySize?: string
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

const previewOf = (text: string): string =>
  text.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0)?.slice(0, 180) ?? ''

const UNSAVED_SETTINGS = new Date(0).toISOString()

/**
 * Reads the values the xMail pages are allowed to show.
 * Quota usage is omitted: nothing in this process runs IMAP GETQUOTA.
 * Vacation, filters, DKIM and the size limit are omitted when their files were never written.
 */
export const loadMailDocument = async (input: {
  db: Db
  store: StateStore
  serverSecret: string
  sessionId: string | null
  transport: MailboxTransport
}): Promise<MailDocument> => {
  if (!input.sessionId) return { mailbox: '' }
  const { record, password } = await openMailboxSession(input.db, input.serverSecret, input.sessionId)
  const snap = await input.store.readSnapshot()
  const serviceUser = snap.serviceUsers.find(user => user.accountId === record.accountId && user.login.toLowerCase() === record.mailbox)
  const extended = new ExtendedFeaturesStore(input.store.rootDir)
  const document: MailDocument = { mailbox: record.mailbox }
  if (serviceUser) document.quotaLimitMb = serviceUser.mailboxQuotaMb

  try {
    const vacation = await extended.storedVacationResponder(record.mailbox)
    if (vacation) document.vacationEnabled = vacation.enabled
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
    const domain = record.mailbox.split('@')[1] ?? ''
    const auth = domain ? await extended.readEmailAuth(domain) : null
    if (auth?.dkimTxtValue) document.identityDkim = `Selector ${auth.selector} is stored for ${auth.domain}`
    if (auth) {
      document.identitySpf = `${auth.spfTxtValue ? 'SPF record stored' : 'SPF record not stored'} · ${auth.dmarcTxtValue ? 'DMARC record stored' : 'DMARC record not stored'}`
    }
  } catch { /* unknown */ }

  try {
    const fine = await extended.getServerFineSettings() as {
      updatedAt?: string
      mtaMaxMsgSizeMb?: number
      mta?: { maxMessageSizeMb?: number }
    }
    const size = fine.mta?.maxMessageSizeMb ?? fine.mtaMaxMsgSizeMb
    if (fine.updatedAt && fine.updatedAt !== UNSAVED_SETTINGS && typeof size === 'number' && Number.isFinite(size) && size > 0) {
      document.identitySize = `${size} MiB per message`
    }
  } catch { /* unknown */ }

  try {
    const listed = await input.transport.list(record.mailbox, password)
    const messages: MailDocumentMessage[] = listed.map(item => ({
      uid: item.uid,
      folder: 'INBOX',
      from: item.from,
      to: item.to,
      subject: item.subject,
      preview: item.preview ?? '',
      body: '',
      receivedAt: item.receivedAt,
      unread: item.unread,
      bodyPending: true,
    }))
    const first = messages[0]
    if (first) {
      try {
        const full = await input.transport.read(record.mailbox, password, first.uid)
        first.body = full.body
        first.unread = full.unread
        first.bodyPending = false
        if (!first.preview) first.preview = previewOf(full.body)
      } catch { /* the row stays pending */ }
    }
    document.messages = messages
  } catch {
    document.mailListFailed = true
  }
  return document
}
