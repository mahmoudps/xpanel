import { isUuid } from './schemas.ts'
import { parseServiceLogin } from './rules/naming.ts'

/** Identifies one mailbox lifetime; an address alone is never ownership proof. */
export interface MailboxMetadataAuthority {
  readonly accountId: string
  readonly serviceUserId: string
  readonly mailbox: string
}

export type MailboxMetadataAuthorityAssessment = 'match' | 'unbound' | 'invalid' | 'mismatch'

export const normalizeMailboxMetadataAddress = (value: unknown): string | null => {
  try {
    const parsed = parseServiceLogin(value)
    return `${parsed.local}@${parsed.domain}`.toLowerCase()
  } catch {
    return null
  }
}

/** Validates a stored tuple. Validation does not establish its provenance. */
export const parseMailboxMetadataAuthority = (value: unknown): MailboxMetadataAuthority | null => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const names = Object.getOwnPropertyNames(value)
    if (names.length !== 3 || names.some(name => !['accountId', 'serviceUserId', 'mailbox'].includes(name)) || Object.getOwnPropertySymbols(value).length > 0) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (names.some(name => !Object.hasOwn(descriptors[name]!, 'value'))) return null
    const accountId: unknown = descriptors.accountId?.value
    const serviceUserId: unknown = descriptors.serviceUserId?.value
    const mailbox = normalizeMailboxMetadataAddress(descriptors.mailbox?.value)
    if (!isUuid(accountId) || !isUuid(serviceUserId) || !mailbox) return null
    return Object.freeze({ accountId: accountId.toLowerCase(), serviceUserId: serviceUserId.toLowerCase(), mailbox })
  } catch {
    return null
  }
}

/**
 * Compare preserved metadata to an independently trusted current mailbox tuple.
 * Missing historical bindings remain unbound; this function never adopts them.
 */
export const assessMailboxMetadataAuthority = (
  recordMailbox: unknown,
  persisted: unknown,
  current: MailboxMetadataAuthority,
): MailboxMetadataAuthorityAssessment => {
  const trusted = parseMailboxMetadataAuthority(current)
  const address = normalizeMailboxMetadataAddress(recordMailbox)
  if (!trusted || !address) return 'invalid'
  if (address !== trusted.mailbox) return 'mismatch'
  if (persisted === undefined || persisted === null) return 'unbound'
  const stored = parseMailboxMetadataAuthority(persisted)
  if (!stored || stored.mailbox !== address) return 'invalid'
  return stored.accountId === trusted.accountId && stored.serviceUserId === trusted.serviceUserId
    ? 'match'
    : 'mismatch'
}
