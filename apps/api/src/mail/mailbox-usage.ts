import { fail, isXpanelError } from '@xpanel/core'
import type { ImapMailboxEntry, ImapProtocolClient, ImapSearchCriteria } from './imap.ts'
import {
  mailboxJson, mailFolderIdentity, mailFolderSelectable, mailFolderSpecialUse, mailTrashFolder, methodNotAllowed, strictMailboxBody, withSealedImap,
} from './folder-admin.ts'
import type { SealedImapPorts } from './folder-admin.ts'

export type MailboxUsageClient = Pick<ImapProtocolClient, 'connect' | 'login' | 'logout' | 'capabilities' | 'listMailboxes' | 'mailboxStatus'
  | 'mailboxMessageSizes' | 'searchMailboxUids' | 'moveUidSet' | 'expungeUidSet' | 'quotaRootResources'>

export const MAILBOX_MEASURE_MAX = 50000
export const MAILBOX_ACTION_MAX = 5000
const FOLDER_MAX = 500
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export type FolderSize = { state: 'measured'; bytes: number; method: 'status-size' | 'message-sizes' } | { state: 'not-measured'; reason: 'too-many-messages' | 'changed' | 'unavailable' }
export interface MailboxUsageFolder { folder: string; name: string; specialUse: string | null; messages: number | null; unseen: number | null; size: FolderSize }
export type MailboxQuota =
  | { state: 'read'; root: string; usedBytes: number; limitBytes: number | null; messages: { used: number; limit: number | null } | null }
  | { state: 'no-storage-limit' | 'not-advertised' | 'unavailable' }
export interface MailboxUsageView {
  mailbox: string; observedAt: string
  capabilities: { statusSize: boolean; quota: boolean; move: boolean; uidPlus: boolean }
  quota: MailboxQuota
  folders: MailboxUsageFolder[]
  omittedFolders: number
  trash: string | null
  limits: { measureMessages: number; actionMessages: number }
}
export interface CleanupCriteria { olderThanDays?: number; largerThanMb?: number; seen?: true }

const own = (value: Record<string, unknown>, key: string): boolean => Object.hasOwn(value, key)
const imapDay = (ms: number): string => { const date = new Date(ms); return date.getUTCDate() + '-' + MONTHS[date.getUTCMonth()] + '-' + date.getUTCFullYear() }

/** Older than N days (internal date, RFC 3501 BEFORE), larger than N MiB (LARGER), already read (SEEN); at least one. */
export function parseCleanupCriteria(value: unknown, now: Date): { criteria: CleanupCriteria; search: ImapSearchCriteria } {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  if (!input || Object.keys(input).some(key => !['olderThanDays', 'largerThanMb', 'seen'].includes(key))) return fail('VALIDATION', 'cleanup criteria are age, size and read state only', { stateChanged: false })
  const criteria: CleanupCriteria = {}, search: ImapSearchCriteria = {}
  if (own(input, 'olderThanDays')) {
    if (!Number.isSafeInteger(input.olderThanDays) || (input.olderThanDays as number) < 1 || (input.olderThanDays as number) > 36500) return fail('VALIDATION', 'age must be from 1 through 36500 days', { stateChanged: false })
    criteria.olderThanDays = input.olderThanDays as number; search.before = imapDay(now.getTime() - criteria.olderThanDays * 86_400_000)
  }
  if (own(input, 'largerThanMb')) {
    if (!Number.isSafeInteger(input.largerThanMb) || (input.largerThanMb as number) < 1 || (input.largerThanMb as number) > 10240) return fail('VALIDATION', 'size must be from 1 through 10240 MB', { stateChanged: false })
    criteria.largerThanMb = input.largerThanMb as number; search.largerThan = criteria.largerThanMb * 1024 * 1024
  }
  if (own(input, 'seen')) {
    if (input.seen !== true) return fail('VALIDATION', 'the read-state criterion is true or absent', { stateChanged: false })
    criteria.seen = true; search.seen = true
  }
  if (!Object.keys(criteria).length) return fail('VALIDATION', 'choose at least one cleanup criterion; an empty cleanup is refused', { stateChanged: false, reason: 'cleanup_criteria_required' })
  return { criteria, search }
}

function queryCriteria(url: URL): { folder: string; criteria: unknown } {
  const seen = new Set<string>(), values: Record<string, unknown> = {}
  for (const [key, raw] of url.searchParams) {
    if (!['folder', 'olderThanDays', 'largerThanMb', 'seen'].includes(key) || seen.has(key)) return fail('VALIDATION', 'unsupported or repeated cleanup selector', { stateChanged: false })
    seen.add(key)
    if (key === 'seen') values.seen = raw === 'true' ? true : raw
    else if (key !== 'folder') values[key] = /^[1-9]\d{0,4}$/.test(raw) ? Number(raw) : raw
  }
  return { folder: mailFolderIdentity(url.searchParams.get('folder')), criteria: values }
}

function requireSelectable(entries: readonly ImapMailboxEntry[], folder: string): ImapMailboxEntry {
  const entry = entries.find(item => item.name === folder || (item.name.toUpperCase() === 'INBOX' && folder.toUpperCase() === 'INBOX'))
  if (!entry || !mailFolderSelectable(entry)) return fail('NOT_FOUND', 'that mail folder is not available', { stateChanged: false, reason: 'mail_folder_missing' })
  return entry
}
const sameFolder = (left: string, right: string): boolean => left === right || (left.toUpperCase() === 'INBOX' && right.toUpperCase() === 'INBOX')

async function readQuota(client: MailboxUsageClient, mailbox: string, advertised: boolean): Promise<MailboxQuota> {
  if (!advertised) return { state: 'not-advertised' }
  let observed: Awaited<ReturnType<MailboxUsageClient['quotaRootResources']>>
  try { observed = await client.quotaRootResources(mailbox) } catch (error) {
    if (isXpanelError(error) && error.detail.reason === 'imap_quota_unavailable') return { state: 'unavailable' }
    throw error
  }
  const storage = observed.resources.find(item => item.resource === 'STORAGE' && observed.roots.includes(item.root))
  if (!storage) return { state: 'no-storage-limit' }
  const messages = observed.resources.find(item => item.resource === 'MESSAGE' && item.root === storage.root)
  return { state: 'read', root: storage.root, usedBytes: storage.usage * 1024, limitBytes: storage.limit > 0 ? storage.limit * 1024 : null,
    messages: messages ? { used: messages.usage, limit: messages.limit > 0 ? messages.limit : null } : null }
}

export async function readMailboxUsage(client: MailboxUsageClient, mailbox: string, now: Date): Promise<MailboxUsageView> {
  const capabilities = await client.capabilities(mailbox)
  const statusSize = capabilities.has('STATUS=SIZE'), quota = capabilities.has('QUOTA') || [...capabilities].some(item => item.startsWith('QUOTA='))
  const listed = await client.listMailboxes(mailbox), selectable = listed.entries.filter(mailFolderSelectable), folders: MailboxUsageFolder[] = []
  for (const entry of selectable.slice(0, FOLDER_MAX)) {
    const row = { folder: entry.name, name: entry.displayName ?? entry.name, specialUse: mailFolderSpecialUse(entry) }
    let status: Awaited<ReturnType<MailboxUsageClient['mailboxStatus']>>
    try { status = await client.mailboxStatus(entry.name, statusSize ? ['MESSAGES', 'UNSEEN', 'SIZE'] : ['MESSAGES', 'UNSEEN'], mailbox) } catch (error) {
      if (!isXpanelError(error) || error.detail.reason !== 'imap_status_unavailable') throw error
      folders.push({ ...row, messages: null, unseen: null, size: { state: 'not-measured', reason: 'unavailable' } }); continue
    }
    const messages = status.messages ?? 0
    let size: FolderSize
    if (statusSize) size = { state: 'measured', bytes: status.size!, method: 'status-size' }
    else if (messages > MAILBOX_MEASURE_MAX) size = { state: 'not-measured', reason: 'too-many-messages' }
    else {
      try {
        const measured = await client.mailboxMessageSizes(entry.name, MAILBOX_MEASURE_MAX, mailbox)
        size = measured.sizes ? { state: 'measured', bytes: [...measured.sizes.values()].reduce((sum, bytes) => sum + bytes, 0), method: 'message-sizes' } : { state: 'not-measured', reason: 'too-many-messages' }
      } catch (error) {
        if (!isXpanelError(error) || error.detail.reason !== 'imap_folder_changed') throw error
        size = { state: 'not-measured', reason: 'changed' }
      }
    }
    folders.push({ ...row, messages, unseen: status.unseen ?? 0, size })
  }
  return { mailbox, observedAt: now.toISOString(), capabilities: { statusSize, quota, move: capabilities.has('MOVE'), uidPlus: capabilities.has('UIDPLUS') },
    quota: await readQuota(client, mailbox, quota), folders, omittedFolders: selectable.length - folders.length, trash: mailTrashFolder(listed.entries),
    limits: { measureMessages: MAILBOX_MEASURE_MAX, actionMessages: MAILBOX_ACTION_MAX } }
}

/** One observed generation: every matching UID with its RFC822.SIZE, or a refusal above the measurement bound. */
async function matching(client: MailboxUsageClient, mailbox: string, folder: string, search: ImapSearchCriteria, expectedUidValidity?: number) {
  const measured = await client.mailboxMessageSizes(folder, MAILBOX_MEASURE_MAX, mailbox, expectedUidValidity)
  if (!measured.sizes) return fail('PRECONDITION_FAILED', 'this folder holds more than 50000 messages, so its cleanup cannot be measured', { stateChanged: false, reason: 'folder_too_large' })
  const found = await client.searchMailboxUids(folder, search, measured.uidValidity, MAILBOX_MEASURE_MAX, mailbox)
  if (found.uids.some(uid => !measured.sizes!.has(uid))) return fail('CONFLICT', 'the folder changed while it was read; preview again', { stateChanged: false, reason: 'imap_folder_changed' })
  return { uidValidity: measured.uidValidity, uids: [...new Set(found.uids)].sort((left, right) => left - right), sizes: measured.sizes }
}

function actionBody(body: Record<string, unknown>, now: Date, purge: boolean) {
  const folder = mailFolderIdentity(body.folder), parsed = parseCleanupCriteria(body.criteria, now), uids = body.uids
  if (!Number.isSafeInteger(body.uidValidity) || (body.uidValidity as number) < 1 || (body.uidValidity as number) > 0xffffffff) return fail('VALIDATION', 'the observed uidValidity is required', { stateChanged: false })
  if (!Array.isArray(uids) || !uids.length || uids.length > MAILBOX_ACTION_MAX || uids.some(uid => !Number.isSafeInteger(uid) || uid < 1 || uid > 0xffffffff) || new Set(uids).size !== uids.length) {
    return fail('VALIDATION', 'the previewed message set must hold 1 to 5000 distinct UIDs', { stateChanged: false })
  }
  if (purge) {
    const confirm = body.confirm as Record<string, unknown> | undefined
    if (!confirm || typeof confirm !== 'object' || Array.isArray(confirm) || Object.keys(confirm).length !== 2 || confirm.folder !== folder || confirm.count !== uids.length) {
      return fail('VALIDATION', 'permanent deletion requires a confirmation naming the folder and the message count', { stateChanged: false, reason: 'confirmation_required' })
    }
  }
  return { folder, uidValidity: body.uidValidity as number, uids: uids as number[], ...parsed }
}

/** /api/webmail/disk-usage: per-folder usage, quota, cleanup preview, move to Trash and permanent delete from Trash. */
export async function handleMailboxUsageRoute(request: Request, url: URL, method: string, ports: SealedImapPorts<MailboxUsageClient>): Promise<Response | null> {
  const route = ({ '/api/webmail/disk-usage': 'usage', '/api/webmail/disk-usage/preview': 'preview', '/api/webmail/disk-usage/cleanup': 'cleanup', '/api/webmail/disk-usage/purge': 'purge' } as Record<string, string | undefined>)[url.pathname]
  if (!route) return null
  const read = route === 'usage' || route === 'preview'
  if (method !== (read ? 'GET' : 'POST')) return methodNotAllowed([read ? 'GET' : 'POST'])
  const now = (ports.now ?? (() => new Date()))()
  if (route === 'usage') {
    if (url.search) return fail('VALIDATION', 'disk usage accepts no query selectors', { stateChanged: false })
    return mailboxJson(await withSealedImap(request, ports, (client, mailbox) => readMailboxUsage(client, mailbox, now)))
  }
  if (route === 'preview') {
    const query = queryCriteria(url), parsed = parseCleanupCriteria(query.criteria, now)
    return mailboxJson(await withSealedImap(request, ports, async (client, mailbox) => {
      const capabilities = await client.capabilities(mailbox), listed = await client.listMailboxes(mailbox)
      const entry = requireSelectable(listed.entries, query.folder), trash = mailTrashFolder(listed.entries)
      const found = await matching(client, mailbox, entry.name, parsed.search), batch = found.uids.slice(0, MAILBOX_ACTION_MAX)
      const bytes = (uids: number[]): number => uids.reduce((sum, uid) => sum + found.sizes.get(uid)!, 0)
      return { mailbox, observedAt: now.toISOString(), folder: entry.name, name: entry.displayName ?? entry.name, uidValidity: found.uidValidity, criteria: parsed.criteria,
        matched: found.uids.length, matchedBytes: bytes(found.uids), batch: { uids: batch, count: batch.length, bytes: bytes(batch) }, actionLimit: MAILBOX_ACTION_MAX,
        trash, isTrash: trash !== null && sameFolder(trash, entry.name), capabilities: { move: capabilities.has('MOVE'), uidPlus: capabilities.has('UIDPLUS') } }
    }))
  }
  const purge = route === 'purge'
  const input = actionBody(await strictMailboxBody(request, url, ['folder', 'uidValidity', 'criteria', 'uids', ...(purge ? ['confirm'] : [])], ['folder', 'uidValidity', 'criteria', 'uids', ...(purge ? ['confirm'] : [])]), now, purge)
  let mailboxAddress = ''
  const result = await withSealedImap(request, ports, async (client, mailbox, attempt) => {
    mailboxAddress = mailbox
    const listed = await client.listMailboxes(mailbox), entry = requireSelectable(listed.entries, input.folder), trash = mailTrashFolder(listed.entries)
    if (!trash) return fail('PRECONDITION_FAILED', 'this mailbox has no Trash folder', { stateChanged: false, reason: 'trash_missing' })
    if (purge !== sameFolder(trash, entry.name)) return fail('VALIDATION', purge ? 'permanent deletion is available only in Trash' : 'messages in Trash are removed with permanent deletion', { stateChanged: false })
    const current = await matching(client, mailbox, entry.name, input.search, input.uidValidity), present = new Set(current.uids)
    if (input.uids.some(uid => !present.has(uid))) return fail('CONFLICT', 'the previewed messages changed; preview again', { stateChanged: false, reason: 'cleanup_set_changed' })
    const requestedBytes = input.uids.reduce((sum, uid) => sum + current.sizes.get(uid)!, 0)
    await attempt()
    const effect = purge ? await client.expungeUidSet(entry.name, input.uids, input.uidValidity, mailbox, MAILBOX_ACTION_MAX)
      : await client.moveUidSet(entry.name, input.uids, trash, input.uidValidity, mailbox, MAILBOX_ACTION_MAX)
    const done = 'removed' in effect ? effect.removed : effect.moved
    const counts = async (folder: string) => { const status = await client.mailboxStatus(folder, ['MESSAGES', 'UNSEEN'], mailbox); return { folder, messages: status.messages ?? 0, unseen: status.unseen ?? 0 } }
    const folders = purge ? [await counts(entry.name)] : [await counts(entry.name), await counts(trash)]
    const base = { operation: purge ? 'delete-permanently' as const : 'move-to-trash' as const, folder: entry.name, trash, requested: input.uids.length, requestedBytes,
      completed: done.length, remaining: effect.remaining, folders }
    if (!done.length && !effect.accepted) return { outcome: 'refused' as const, remaining: effect.remaining.length }
    return { ...base, outcome: done.length === input.uids.length && effect.accepted ? 'confirmed' as const : done.length ? 'partial' as const : 'unknown' as const,
      stateChanged: done.length > 0 || effect.accepted, ...(done.length === input.uids.length && effect.accepted ? {} : { verificationRequired: true as const }) }
  })
  // A server refusal proven by the re-read (nothing left the folder) is not widened into an unknown outcome.
  if (result.outcome === 'refused') return fail('PRECONDITION_FAILED', 'the mail server refused the cleanup; nothing was changed', { stateChanged: false, reason: 'cleanup_refused', remaining: result.remaining })
  if (ports.audit) {
    try { await ports.audit(request, { action: purge ? 'webmail.cleanup.deleted' : 'webmail.cleanup.moved', mailbox: mailboxAddress, detail: { folder: result.folder, requested: result.requested, completed: result.completed, outcome: result.outcome } }) } catch {
      return fail('SERVICE_UNAVAILABLE', 'the cleanup ran but could not be recorded; review the folder before retrying', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    }
  }
  return mailboxJson(result)
}
