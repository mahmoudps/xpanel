import { createHash } from 'node:crypto'
import { fail } from '@xpanel/core'

export interface ComposeStoredIdentity {
  id: string
  mailbox: string
  email: string
  displayName: string
  replyTo: string
  textSignature: string
  htmlSignature: string
  isDefault: boolean
  createdAt: string
}

export interface ComposeIdentitySelection {
  identityId: string
  expectedIdentityRevision: string
}

export interface ResolvedComposeIdentity {
  identityId: string
  identityRevision: string
  from: string
  fromName: string
  replyTo: string
}

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const addressPattern = /^[^\s@<>(),;:"\\[\]/]+@[^\s@<>(),;:"\\[\]/]+$/
const unsafeHeader = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/

/** Binds the compose selection to the persisted identity, including its signatures. */
export function composeIdentityRevision(identity: ComposeStoredIdentity): string {
  return createHash('sha256').update(JSON.stringify({
    id: identity.id.toLowerCase(), mailbox: identity.mailbox.toLowerCase(), email: identity.email.toLowerCase(),
    displayName: identity.displayName, replyTo: identity.replyTo, textSignature: identity.textSignature,
    htmlSignature: identity.htmlSignature, isDefault: identity.isDefault, createdAt: identity.createdAt,
  })).digest('hex')
}

export function projectComposeIdentity<T extends ComposeStoredIdentity>(identity: T): T & { revision: string } {
  return { ...identity, revision: composeIdentityRevision(identity) }
}

/** The caller supplies only an id/revision. Header values always come from the saved identity. */
export function resolveComposeIdentity(mailbox: string, body: unknown, identities: readonly ComposeStoredIdentity[]): ResolvedComposeIdentity | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('VALIDATION', 'message must be an object', { stateChanged: false })
  const input = body as Record<string, unknown>
  if (input.identityId === undefined && input.expectedIdentityRevision === undefined) return null
  if (typeof input.identityId !== 'string' || !idPattern.test(input.identityId)
    || typeof input.expectedIdentityRevision !== 'string' || !/^[0-9a-f]{64}$/.test(input.expectedIdentityRevision)) {
    return fail('VALIDATION', 'a saved identity id and revision are required together', { stateChanged: false })
  }
  const canonicalMailbox = mailbox.trim().toLowerCase()
  const identity = identities.find(item => item.id.toLowerCase() === input.identityId!.toString().toLowerCase()
    && item.mailbox.trim().toLowerCase() === canonicalMailbox)
  if (!identity) return fail('NOT_FOUND', 'sender identity is unavailable', { stateChanged: false, identitySelectionRequired: true })
  if (identity.email.trim().toLowerCase() !== canonicalMailbox) return fail('FORBIDDEN', 'sender identity does not belong to this mailbox', { stateChanged: false, identitySelectionRequired: true })
  const revision = composeIdentityRevision(identity)
  if (revision !== input.expectedIdentityRevision) return fail('CONFLICT', 'sender identity changed; read and review it before sending', { stateChanged: false, identitySelectionRequired: true })
  if (typeof identity.displayName !== 'string' || !identity.displayName.trim() || !identity.displayName.isWellFormed()
    || unsafeHeader.test(identity.displayName) || Buffer.byteLength(identity.displayName, 'utf8') > 200
    || typeof identity.replyTo !== 'string' || !identity.replyTo.isWellFormed() || unsafeHeader.test(identity.replyTo)
    || Buffer.byteLength(identity.replyTo, 'utf8') > 254 || !addressPattern.test(identity.replyTo)) {
    return fail('VALIDATION', 'saved sender identity contains invalid header values', { stateChanged: false, identitySelectionRequired: true })
  }
  return { identityId: identity.id, identityRevision: revision, from: canonicalMailbox, fromName: identity.displayName, replyTo: identity.replyTo.trim().toLowerCase() }
}
