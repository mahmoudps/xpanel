import { fail } from './errors.ts'

/** Pure identity contract shared by native adapters, RPC, routes and browser validation. */
export function createQuarantineIdentity() {
  const guid = /^[0-9a-f]{32}$/
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  const mailbox = /^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/
  const username = /^[a-z][a-z0-9_]{0,31}$/
  const revision = /^[0-9a-f]{64}$/
  const uintMax = 4294967295
  const folders = ['Spam', 'Junk', 'Quarantine'] as const
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  const integer = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= uintMax
  const uidText = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value) && Number(value) <= uintMax
  const address = (value: unknown): value is string => typeof value === 'string' && value.length <= 254 && mailbox.test(value)
  const hash = (value: unknown): value is string => typeof value === 'string' && revision.test(value)
  const locator = (value: unknown): value is QuarantineLocator => object(value)
    && Object.keys(value).length === 4 && Object.keys(value).every(key => ['mailboxGuid', 'uidValidity', 'uid', 'messageGuid'].includes(key))
    && typeof value.mailboxGuid === 'string' && guid.test(value.mailboxGuid)
    && typeof value.messageGuid === 'string' && guid.test(value.messageGuid)
    && integer(value.uidValidity, 1) && integer(value.uid, 1)
  const sameLocator = (left: QuarantineLocator, right: QuarantineLocator): boolean =>
    left.mailboxGuid === right.mailboxGuid && left.uidValidity === right.uidValidity && left.uid === right.uid && left.messageGuid === right.messageGuid
  return { guid, uuid, mailbox, username, revision, uintMax, folders, object, integer, uidText, address, hash, locator, sameLocator }
}

export const quarantineIdentity = createQuarantineIdentity()
export const QUARANTINE_GUID = quarantineIdentity.guid
export const QUARANTINE_UUID = quarantineIdentity.uuid
export const QUARANTINE_MAILBOX = quarantineIdentity.mailbox
export const QUARANTINE_USERNAME = quarantineIdentity.username
export const QUARANTINE_REVISION = quarantineIdentity.revision
export const QUARANTINE_UINT_MAX = quarantineIdentity.uintMax
export const QUARANTINE_FOLDERS = quarantineIdentity.folders
export const QUARANTINE_PAGE_UIDS = 100
export const QUARANTINE_RELEASE_MAX_BYTES = 1024 * 1024
export const QUARANTINE_MAX_PENDING = 16

export interface QuarantineScope { accountId: string; mailbox: string }
export interface QuarantineLocator { mailboxGuid: string; uidValidity: number; uid: number; messageGuid: string }
export interface QuarantineMessage {
  locator: QuarantineLocator
  revision: string
  from: string
  to: string
  subject: string
  receivedAt: string | null
  heldAt: string | null
  sizeBytes: number
  score: number | null
  reason: string
  headers: string
  releaseEligible: boolean
}
export interface QuarantinePolicy {
  retentionDays: number
  retentionMode: 'manual_expiry'
  senderAllowAvailable: false
  digestAvailable: false
}
export interface QuarantineAvailable {
  state: 'available'
  scope: QuarantineScope
  source: { kind: 'dovecot'; folder: string; observedAt: string }
  revision: string
  messages: QuarantineMessage[]
  totalMessages: number
  nextBeforeUid: number | null
  policy: QuarantinePolicy
}
export interface QuarantineUnavailable { state: 'unavailable'; scope: QuarantineScope; reason: 'native_profile_unavailable' }
export type QuarantineReadResult = QuarantineAvailable | QuarantineUnavailable
export interface QuarantineMutation { locator: QuarantineLocator; expectedRevision: string }
export interface QuarantineActionResult {
  state: 'released' | 'deleted' | 'partial' | 'unknown'
  scope: QuarantineScope
  locator: QuarantineLocator
  sourceRevision: string
  correction: 'applied' | 'not_attempted' | 'unknown'
  deliveredToInbox: boolean | null
  sourcePresent: boolean | null
  deleted: boolean | null
  stateChanged: boolean
  verificationRequired: boolean
  reason?: 'correction_unverified' | 'move_unverified' | 'delete_unverified' | 'cleanup_unverified' | 'authorization_changed'
  observedAt: string
}
export interface QuarantineExpiryResult {
  state: 'expired' | 'partial'
  scope: QuarantineScope
  removed: number
  considered: number
  results: QuarantineActionResult[]
}

/** Reject sealed-selector injection and return only a canonical captured identity. */
export function parseQuarantineMutation(value: unknown): QuarantineMutation {
  if (!quarantineIdentity.object(value) || Object.keys(value).some(key => !['locator', 'expectedRevision'].includes(key))
    || !quarantineIdentity.hash(value.expectedRevision)) return fail('VALIDATION', 'quarantine mutation requires a locator and saved revision', { stateChanged: false })
  if (!quarantineIdentity.locator(value.locator)) return fail('VALIDATION', 'invalid quarantine message identity', { stateChanged: false })
  return { locator: { ...value.locator }, expectedRevision: value.expectedRevision }
}
