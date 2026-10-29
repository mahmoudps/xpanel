import { createHash, randomUUID } from 'node:crypto'
import { fail } from '@xpanel/core'
import type { WebmailContact } from '../extended-routes.ts'
import { escapeContactVcardText, rewriteContactVcard } from './contact-vcard.ts'

export interface ContactWorkspaceFields { fullName: string; email: string; phone: string; organization: string; title: string }
const fields = ['fullName', 'email', 'phone', 'organization', 'title'] as const
export const CONTACTS_PER_MAILBOX_MAX = 10000
export const CONTACT_GROUPS_PER_MAILBOX_MAX = 256
export const CONTACT_GROUPS_PER_CONTACT_MAX = 32
export const CONTACT_GROUP_NAME_MAX = 64

export const normalizeContactGroupName = (value: unknown): string => {
  if (typeof value !== 'string' || !value.isWellFormed() || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/.test(value)) return fail('VALIDATION', 'group name must be safe text', { stateChanged: false })
  const name = value.trim().normalize('NFC')
  if (!name || Array.from(name).length > CONTACT_GROUP_NAME_MAX) return fail('VALIDATION', 'group name must contain 1 through 64 characters', { stateChanged: false })
  return name
}

export const normalizeContactGroups = (value: unknown, previous: readonly string[] = []): string[] => {
  if (!Array.isArray(value) || value.length > Math.max(CONTACT_GROUPS_PER_CONTACT_MAX, previous.length)) return fail('VALIDATION', 'contact group capacity may not grow beyond the mailbox limit', { stateChanged: false })
  const names = value.map(normalizeContactGroupName)
  if (new Set(names).size !== names.length) return fail('VALIDATION', 'contact group names must be unique', { stateChanged: false })
  return names
}

/** Inverse of the category escaping emitted by this workspace's vCard writer. */
export const parseContactVcardGroups = (value: string): string[] => {
  if (value === '') return []
  const groups: string[] = []
  let current = '', escaped = false
  for (const character of value) {
    if (escaped) {
      if (!['\\', ',', ';'].includes(character)) return fail('VALIDATION', 'unsupported contact category escape', { stateChanged: false })
      current += character; escaped = false
    } else if (character === '\\') escaped = true
    else if (character === ',') { groups.push(current); current = '' }
    else current += character
  }
  if (escaped) return fail('VALIDATION', 'incomplete contact category escape', { stateChanged: false })
  groups.push(current)
  return normalizeContactGroups(groups)
}

export const contactVcardCategories = (groups: readonly string[]): string => 'CATEGORIES:' + groups.map(value => value.replaceAll('\\', '\\\\').replaceAll(';', '\\;').replaceAll(',', '\\,')).join(',')

/** Call under the existing contact writer lease before create/import publication. */
export const assertContactCapacity = (contacts: readonly WebmailContact[], owner: string, addedCount: number): void => {
  if (!Number.isSafeInteger(addedCount) || addedCount < 0) return fail('VALIDATION', 'invalid contact count', { stateChanged: false })
  const count = contacts.filter(contact => contact.owner.toLowerCase() === owner.toLowerCase()).length
  if (addedCount > 0 && count + addedCount > CONTACTS_PER_MAILBOX_MAX) return fail('LIMIT_EXCEEDED', 'mailbox contact capacity reached', { stateChanged: false, limit: CONTACTS_PER_MAILBOX_MAX })
}

export const contactWorkspaceRevision = (contact: WebmailContact): string => createHash('sha256').update(JSON.stringify([
  contact.id, contact.owner, contact.fullName, contact.email, contact.phone, contact.organization, contact.title,
  contact.groups, contact.shares ?? [], contact.vcard, contact.createdAt, contact.ownerAuthority ?? null,
])).digest('hex')

export const projectContactWorkspace = (contact: WebmailContact) => ({
  id: contact.id, owner: contact.owner, fullName: contact.fullName, email: contact.email, phone: contact.phone,
  organization: contact.organization, title: contact.title, groups: contact.groups,
  shares: (contact.shares ?? []).map(share => ({ principal: share.principal, permission: share.permission, sharedAt: share.sharedAt })),
  vcard: contact.vcard, createdAt: contact.createdAt, revision: contactWorkspaceRevision(contact),
})

export const parseContactWorkspaceRequest = (value: unknown, editing: boolean,
  normalize: (value: unknown, field: string) => string): ContactWorkspaceFields & { expectedRevision?: string } => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('VALIDATION', 'contact request must be an object', { stateChanged: false })
  const body = value as Record<string, unknown>, allowed: readonly string[] = editing ? [...fields, 'expectedRevision'] : fields
  if (Object.keys(body).some(key => !allowed.includes(key)) || fields.some(key => typeof body[key] !== 'string')) {
    return fail('VALIDATION', 'contact request requires the supported text fields only', { stateChanged: false })
  }
  if (editing && (typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedRevision))) {
    return fail('VALIDATION', 'expectedRevision is required', { stateChanged: false })
  }
  const result = Object.fromEntries(fields.map(key => [key, normalize(body[key], key)])) as unknown as ContactWorkspaceFields
  result.email = result.email.toLowerCase()
  if (!result.fullName || !/^[^\s@/\\]+@[^\s@/\\]+$/.test(result.email)) return fail('VALIDATION', 'fullName and a valid email are required', { stateChanged: false })
  return { ...result, ...(editing ? { expectedRevision: body.expectedRevision as string } : {}) }
}

const contactVcard = (contact: ContactWorkspaceFields, groups: readonly string[] = []): string => {
  if (groups.some(name => normalizeContactGroupName(name) !== name)) return fail('PRECONDITION_FAILED', 'stored contact groups require review', { stateChanged: false })
  normalizeContactGroups([...groups], groups)
  const escape = (value: string) => value.replaceAll('\\', '\\\\').replaceAll(';', '\\;').replaceAll(',', '\\,')
  return ['BEGIN:VCARD', 'VERSION:3.0', 'FN:' + escape(contact.fullName), 'EMAIL;TYPE=INTERNET:' + escape(contact.email),
    ...(contact.phone ? ['TEL;TYPE=CELL:' + escape(contact.phone)] : []),
    ...(contact.organization ? ['ORG:' + escape(contact.organization)] : []),
    ...(contact.title ? ['TITLE:' + escape(contact.title)] : []),
    ...(groups.length ? [contactVcardCategories(groups)] : []), 'END:VCARD'].join('\r\n')
}

export const createWorkspaceContact = (owner: string, fields: ContactWorkspaceFields): WebmailContact => ({
  id: randomUUID(), owner, ...fields, groups: [], shares: [], vcard: contactVcard(fields), createdAt: new Date().toISOString(),
})

export const updateWorkspaceContact = (contact: WebmailContact, fields: ContactWorkspaceFields): WebmailContact => {
  const names = { fullName: 'FN', email: 'EMAIL', phone: 'TEL', organization: 'ORG', title: 'TITLE' } as const
  const replacements: Record<string, string | null> = {}
  for (const field of Object.keys(names) as Array<keyof typeof names>) if (contact[field] !== fields[field]) replacements[names[field]] = fields[field] ? escapeContactVcardText(fields[field]) : null
  return { ...contact, fullName: fields.fullName, email: fields.email, phone: fields.phone, organization: fields.organization, title: fields.title,
    vcard: Object.keys(replacements).length ? rewriteContactVcard(contact.vcard, replacements) : contact.vcard }
}

export const updateWorkspaceContactGroups = (contact: WebmailContact, groups: string[]): WebmailContact => ({
  ...contact, groups, vcard: rewriteContactVcard(contact.vcard, { CATEGORIES: groups.length ? contactVcardCategories(groups).slice('CATEGORIES:'.length) : null }),
})
