import { fail } from '@xpanel/core'
import { assertBackupFileName } from './account-backup.ts'
import { RESTORE_REVISION } from './backup-file-restore-request.ts'
import { isBackupZoneName } from './acct-backup-plan.ts'

/** Component restore grammar shared by the API boundary and the agent; no host access here. */
export const MAX_COMPONENT_MAILBOXES = 50
export const MAX_LISTED_MAILBOXES = 1000
/** Databases plus DNS zones per restore request; each is restored in turn in the background backup slot. */
export const MAX_COMPONENT_DATABASES = 20
export const BACKUP_DATABASE_NAME = /^[a-z][a-z0-9]{0,15}_[a-z0-9_]{1,47}$/
export const MAILBOX_ADDRESS = /^([a-z0-9][a-z0-9._+-]{0,63})@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/
/** Maildir++ message files: <mailbox>/{cur,new}/<name> or <mailbox>/.<folder>/{cur,new}/<name> (Dovecot mailbox format docs). */
const MESSAGE = /^mail\/([^/]+)\/([^/]+)\/(?:\.[^/]+\/)?(?:cur|new)\/[^/]+$/
const unchanged = { stateChanged: false }

export type ComponentRestoreRequest =
  | { op: 'inventory'; file: string }
  | { op: 'preview'; file: string; mailboxes: string[] }
  | { op: 'restore'; file: string; mailboxes: string[]; expectedRevision: string }
  | { op: 'parts'; file: string; databases: string[]; zones: string[]; expectedArchiveSha256: string }

/** The mailbox address of an archived message file, or null for any other member. */
export const archivedMessageMailbox = (path: string): string | null => {
  const match = MESSAGE.exec(path)
  const address = match ? match[2] + '@' + match[1] : null
  return address && MAILBOX_ADDRESS.test(address) ? address : null
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Exact keys, archive names of this account only, 1..50 unique mailbox addresses. */
export function parseComponentRestoreRequest(op: ComponentRestoreRequest['op'], username: string, body: unknown): ComponentRestoreRequest {
  const keys = op === 'inventory' ? ['file'] : op === 'preview' ? ['file', 'mailboxes'] : op === 'parts' ? ['file', 'databases', 'zones', 'expectedArchiveSha256'] : ['file', 'mailboxes', 'expectedRevision']
  if (!object(body) || Object.keys(body).length !== keys.length || keys.some(key => !Object.hasOwn(body, key))) return fail('VALIDATION', 'component restore ' + op + ' takes only ' + keys.join(', '), unchanged)
  let file: string
  try { file = assertBackupFileName(username, body.file as string) } catch { return fail('VALIDATION', 'the backup archive name is invalid for this account', unchanged) }
  if (op === 'inventory') return { op, file }
  if (op === 'parts') {
    const names = body.databases, zones = body.zones
    if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !BACKUP_DATABASE_NAME.test(name) || !name.startsWith(username + '_'))
      || !Array.isArray(zones) || !zones.every(isBackupZoneName) || !names.length && !zones.length || names.length + zones.length > MAX_COMPONENT_DATABASES) return fail('VALIDATION', `select 1 to ${MAX_COMPONENT_DATABASES} databases or DNS zones of this account`, unchanged)
    if (new Set(names).size !== names.length || new Set(zones).size !== zones.length) return fail('VALIDATION', 'a selected database or zone is repeated', unchanged)
    if (typeof body.expectedArchiveSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedArchiveSha256)) return fail('VALIDATION', 'the reviewed archive digest is required', unchanged)
    return { op, file, databases: [...names as string[]], zones: [...zones as string[]], expectedArchiveSha256: body.expectedArchiveSha256 }
  }
  const list = body.mailboxes
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_COMPONENT_MAILBOXES || list.some(item => typeof item !== 'string' || !MAILBOX_ADDRESS.test(item))) return fail('VALIDATION', `select 1 to ${MAX_COMPONENT_MAILBOXES} mailbox addresses`, unchanged)
  const mailboxes = [...list as string[]]
  if (new Set(mailboxes).size !== mailboxes.length) return fail('VALIDATION', 'a selected mailbox is repeated', unchanged)
  if (op === 'preview') return { op, file, mailboxes }
  if (typeof body.expectedRevision !== 'string' || !RESTORE_REVISION.test(body.expectedRevision)) return fail('VALIDATION', 'the reviewed restore revision is required', unchanged)
  return { op, file, mailboxes, expectedRevision: body.expectedRevision }
}
