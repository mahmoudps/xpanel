import {
  assessMailboxMetadataAuthority,
  fail,
  normalizeMailboxMetadataAddress,
  parseMailboxMetadataAuthority,
  type MailboxMetadataAuthority,
} from '@xpanel/core'

export interface MailboxMetadataAuthorityStore {
  getServiceUserByLogin(mailbox: string): Promise<{
    id: string
    accountId: string
    login: string
    services: { email: boolean }
  } | null>
  getAccount(id: string): Promise<{ id: string; status: string } | null>
}

/** Static guidance, not an assertion that withheld records exist. No history counts or IDs. */
export const MAILBOX_METADATA_REVIEW_REQUIRED = Object.freeze({
  status: 'review_required' as const,
  reason: 'mailbox_metadata_binding_unverified' as const,
})

/**
 * Resolve current state, never request-supplied account/service IDs.
 * This is not authorization: consumers retain requireMailbox/features checks.
 * Mutations must resolve inside their existing writer lease, without a nested lease.
 */
export const resolveMailboxMetadataAuthority = async (
  store: MailboxMetadataAuthorityStore,
  mailbox: unknown,
): Promise<MailboxMetadataAuthority | null> => {
  const address = normalizeMailboxMetadataAddress(mailbox)
  if (!address) return null
  const service = await store.getServiceUserByLogin(address)
  if (!service || service.services.email !== true || normalizeMailboxMetadataAddress(service.login) !== address) return null
  const account = await store.getAccount(service.accountId)
  if (!account || account.id !== service.accountId || account.status !== 'active') return null
  return parseMailboxMetadataAuthority({ accountId: account.id, serviceUserId: service.id, mailbox: service.login })
}

/** Capture only for a new entity or an explicit new grant after normal authorization. */
export const captureMailboxMetadataAuthority = async (
  store: MailboxMetadataAuthorityStore,
  mailbox: unknown,
): Promise<MailboxMetadataAuthority> => {
  const authority = await resolveMailboxMetadataAuthority(store, mailbox)
  if (!authority) return fail('NOT_FOUND', 'mailbox not found')
  return authority
}

/** A targeted legacy edit may not silently bind or expose an unverified old row. */
export const assertMailboxMetadataAuthority = (
  recordMailbox: unknown,
  persisted: unknown,
  current: MailboxMetadataAuthority,
): void => {
  const assessment = assessMailboxMetadataAuthority(recordMailbox, persisted, current)
  if (assessment === 'match') return
  if (assessment === 'mismatch') return fail('NOT_FOUND', 'mailbox metadata not found')
  return fail('PRECONDITION_FAILED', 'mailbox metadata requires verified ownership review', {
    reason: MAILBOX_METADATA_REVIEW_REQUIRED.reason,
    stateChanged: false,
  })
}

export interface MailboxIdentityOwnedRecord {
  mailbox: string
  ownerAuthority?: MailboxMetadataAuthority
}

/** Resolve authority before identity default selection, revision checks or SMTP use. */
export const boundMailboxIdentityRecords = <T extends MailboxIdentityOwnedRecord>(
  records: readonly T[],
  authority: MailboxMetadataAuthority,
): T[] => records.filter(record => !!record && typeof record === 'object' && assessMailboxMetadataAuthority(record.mailbox, record.ownerAuthority, authority) === 'match')

/** Call after sealed-mailbox authorization; readRecords is a fixed trusted store port. */
export const readBoundMailboxIdentityRecords = async <T extends MailboxIdentityOwnedRecord>(
  store: MailboxMetadataAuthorityStore,
  mailbox: unknown,
  readRecords: () => Promise<T[]>,
  expectedAuthority?: MailboxMetadataAuthority,
): Promise<T[]> => {
  const authority = await captureMailboxMetadataAuthority(store, mailbox)
  if (expectedAuthority) assertMailboxMetadataAuthority(authority.mailbox, expectedAuthority, authority)
  const records = await readRecords()
  if (!Array.isArray(records)) return fail('PRECONDITION_FAILED', 'identity collection requires review', { stateChanged: false })
  return boundMailboxIdentityRecords(records, authority)
}
