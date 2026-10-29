import { fail, isXpanelError } from '@xpanel/core'
import { ImapProtocolClient, decodeImapMailboxName, encodeImapMailboxName } from './imap.ts'
import type { ImapCommandOutcome, ImapConnectionConfig, ImapMailboxEntry } from './imap.ts'
import { imapDialPlan } from './idle.ts'

export interface SealedMailboxSession {
  record: { sessionId: string; mailbox: string; accountId: string; serviceUserId: string }
  password: string
}
export interface SealedMailboxAuditEvent { action: string; mailbox: string; detail: Record<string, unknown> }
/** Trusted composition ports. The mailbox always comes from `open`, never from request input. */
export interface SealedImapPorts<C> {
  /** Fresh sealed-mailbox authority for this request (server: authorizeNativeMailboxRequest with the page tool id). */
  open: (request: Request) => Promise<SealedMailboxSession>
  clientFactory?: (config: ImapConnectionConfig) => C
  env?: NodeJS.ProcessEnv
  audit?: (request: Request, event: SealedMailboxAuditEvent) => Promise<void>
  now?: () => Date
}
type ImapBase = Pick<ImapProtocolClient, 'connect' | 'login' | 'logout'>
export type MailFolderAdminClient = ImapBase & Pick<ImapProtocolClient, 'listMailboxes' | 'mailboxStatus' | 'createMailbox' | 'renameMailbox' | 'deleteMailbox' | 'setMailboxSubscription'>

export interface MailFolderView {
  /** Wire (modified UTF-7) name: the folder identity sent back by clients. */
  folder: string
  name: string
  nameDecoded: boolean
  leaf: string
  parent: string | null
  depth: number
  delimiter: string | null
  specialUse: string | null
  system: boolean
  selectable: boolean
  subscribed: boolean | null
  children: number
  messages: number | null
  unseen: number | null
}
export interface MailFolderListView { mailbox: string; observedAt: string; subscriptionsObserved: boolean; statusComplete: boolean; folders: MailFolderView[] }
export interface MailFolderMutation {
  operation: 'create' | 'rename' | 'delete' | 'subscribe' | 'unsubscribe'
  folder: string
  outcome: 'confirmed' | 'unknown'
  stateChanged: boolean
  verificationRequired?: true
  serverCode: string | null
  view: MailFolderListView
}

const IMAP_LIMITS = { maxLiteralBytes: 64 * 1024, maxResponseLineBytes: 1024 * 1024, maxSearchResults: 50000 }
const STATUS_FOLDER_MAX = 500
const BODY_MAX_BYTES = 256 * 1024
// RFC 6154 special-use attributes.
const SPECIAL_USE = ['\\All', '\\Archive', '\\Drafts', '\\Flagged', '\\Junk', '\\Sent', '\\Trash']
const DEFAULT_SYSTEM = ['SENT', 'DRAFTS', 'TRASH', 'JUNK', 'ARCHIVE']
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const sameName = (left: string, right: string): boolean => left === right || (left.toUpperCase() === 'INBOX' && right.toUpperCase() === 'INBOX')
const sameSession = (left: SealedMailboxSession, right: SealedMailboxSession): boolean => !!right?.record
  && (['sessionId', 'mailbox', 'accountId', 'serviceUserId'] as const).every(key => left.record[key] === right.record[key]) && left.password === right.password

export const mailboxJson = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
})
export const methodNotAllowed = (allowed: readonly string[]): Response => new Response(null, { status: 405, headers: { allow: allowed.join(', '), 'cache-control': 'no-store' } })

/** Strict JSON object body: bounded, exact keys, no query selectors. */
export async function strictMailboxBody(request: Request, url: URL, allowed: readonly string[], required: readonly string[]): Promise<Record<string, unknown>> {
  if (url.search) return fail('VALIDATION', 'mailbox operations accept no query selectors', { stateChanged: false })
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (!Number.isFinite(declared) || declared > BODY_MAX_BYTES) return fail('VALIDATION', 'the request body is too large', { stateChanged: false })
  const text = await request.text()
  let body: unknown
  try { body = Buffer.byteLength(text, 'utf8') <= BODY_MAX_BYTES ? JSON.parse(text) : undefined } catch { body = undefined }
  if (!object(body) || Object.keys(body).some(key => !allowed.includes(key)) || required.some(key => !(key in body))) {
    return fail('VALIDATION', 'the request requires only the supported fields', { stateChanged: false })
  }
  return body
}

/** One authenticated IMAP session for the sealed mailbox; authority is re-read after login, before a mutation and at the end. */
export async function withSealedImap<C extends ImapBase, T>(
  request: Request, ports: SealedImapPorts<C>, run: (client: C, mailbox: string, attempt: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const session = await ports.open(request), mailbox = session?.record?.mailbox
  if (typeof mailbox !== 'string' || !mailbox.includes('@') || typeof session.password !== 'string') return fail('PRECONDITION_FAILED', 'mailbox access is unavailable', { stateChanged: false })
  const env = ports.env ?? process.env
  const host = env.XPANEL_IMAP_HOST || '127.0.0.1', port = Number(env.XPANEL_IMAP_PORT || '143'), timeoutMs = Number(env.XPANEL_IMAP_TIMEOUT_MS || '15000')
  const plan = imapDialPlan(host, port, env.XPANEL_IMAP_TLS)
  if (!plan || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) return fail('PRECONDITION_FAILED', 'the mail server connection configuration is unavailable', { stateChanged: false })
  const client = (ports.clientFactory ?? ((config: ImapConnectionConfig) => new ImapProtocolClient(config) as unknown as C))({ host, port, tls: plan.tls, rejectUnauthorized: true, timeoutMs, ...IMAP_LIMITS })
  const fresh = async (): Promise<void> => {
    if (!sameSession(session, await ports.open(request))) fail('FORBIDDEN', 'mailbox authorization changed; sign in again', { stateChanged: false })
  }
  let attempted = false
  try {
    await client.connect(); await client.login(mailbox, session.password); await fresh()
    const result = await run(client, mailbox, async () => { await fresh(); attempted = true })
    await fresh()
    return result
  } catch (error) {
    if (attempted) return fail(isXpanelError(error) && error.code !== 'VALIDATION' ? error.code : 'PRECONDITION_FAILED', 'the mailbox change could not be verified', {
      stateChanged: true, unknownOutcome: true, verificationRequired: true, reason: 'mailbox_change_unverified',
    })
    if (isXpanelError(error) && !/\bIMAP\b/i.test(error.message)) throw error
    return fail(isXpanelError(error) ? error.code : 'PRECONDITION_FAILED', 'the mail server could not be read', { stateChanged: false, reason: 'mail_server_unavailable' })
  } finally { await client.logout().catch(() => undefined) }
}

/** The wire name a client received from a folder listing; existence is checked against a fresh LIST. */
export function mailFolderIdentity(value: unknown): string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && /^[\x20-\x7e]+$/.test(value) && !/[%*]/.test(value)
    ? value : fail('VALIDATION', 'the mail folder is invalid', { stateChanged: false })
}

/** One folder level: 1-64 characters, no controls, bidi overrides, wildcards, quotes, slashes, the hierarchy delimiter or a leading dot/tilde. */
export function mailFolderLeafName(value: unknown, delimiter: string | null): string {
  const leaf = typeof value === 'string' ? value.normalize('NFC') : ''
  if (!leaf || leaf !== leaf.trim() || [...leaf].length > 64 || !leaf.isWellFormed() || /[\u0000-\u001f\u007f-\u009f\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069%*"\\/]/u.test(leaf)
    || /^[.~]/.test(leaf) || (delimiter !== null && leaf.includes(delimiter)) || leaf.toUpperCase() === 'INBOX') {
    return fail('VALIDATION', 'folder names use 1 to 64 characters without control characters, wildcards, quotes, slashes, the folder separator or a leading dot', { stateChanged: false, reason: 'mail_folder_name_invalid' })
  }
  return leaf
}

export const mailFolderSpecialUse = (entry: ImapMailboxEntry): string | null => {
  const attributes = entry.attributes.map(item => item.toLowerCase())
  return SPECIAL_USE.find(flag => attributes.includes(flag.toLowerCase())) ?? null
}
export const mailFolderSelectable = (entry: ImapMailboxEntry): boolean => !entry.attributes.some(item => ['\\noselect', '\\nonexistent'].includes(item.toLowerCase()))
const parentOf = (entry: ImapMailboxEntry): string | null => {
  const at = entry.delimiter ? entry.name.lastIndexOf(entry.delimiter) : -1
  return at > 0 ? entry.name.slice(0, at) : null
}
const isSystem = (entry: ImapMailboxEntry): boolean => {
  const parent = parentOf(entry), leaf = parent === null ? entry.name : entry.name.slice(parent.length + entry.delimiter!.length)
  return entry.name.toUpperCase() === 'INBOX' || mailFolderSpecialUse(entry) !== null
    || (DEFAULT_SYSTEM.includes(leaf.toUpperCase()) && (parent === null || parent.toUpperCase() === 'INBOX'))
}
const descendants = (entries: readonly ImapMailboxEntry[], entry: ImapMailboxEntry): ImapMailboxEntry[] =>
  entry.delimiter ? entries.filter(item => item !== entry && item.name.startsWith(entry.name + entry.delimiter)) : []

/** The RFC 6154 \Trash folder, else a selectable top-level (or INBOX-prefixed) folder named Trash. */
export function mailTrashFolder(entries: readonly ImapMailboxEntry[]): string | null {
  const selectable = entries.filter(mailFolderSelectable)
  return (selectable.find(entry => mailFolderSpecialUse(entry) === '\\Trash')
    ?? selectable.find(entry => entry.name.toUpperCase() === 'TRASH' || (entry.delimiter !== null && entry.name.toUpperCase() === 'INBOX' + entry.delimiter + 'TRASH')))?.name ?? null
}

const findEntry = (entries: readonly ImapMailboxEntry[], folder: string): ImapMailboxEntry | undefined => entries.find(entry => sameName(entry.name, folder))
const requireEntry = (entries: readonly ImapMailboxEntry[], folder: string): ImapMailboxEntry =>
  findEntry(entries, folder) ?? fail('NOT_FOUND', 'that mail folder no longer exists', { stateChanged: false, reason: 'mail_folder_missing' })
const protectedRefusal = (): never => fail('CONFLICT', 'system and special-use folders cannot be renamed or deleted', { stateChanged: false, reason: 'protected_folder' })

const order = (left: MailFolderView, right: MailFolderView): number => {
  if (left.folder.toUpperCase() === 'INBOX') return -1
  if (right.folder.toUpperCase() === 'INBOX') return 1
  return left.folder < right.folder ? -1 : left.folder > right.folder ? 1 : 0
}

export async function readMailFolders(client: Pick<ImapProtocolClient, 'listMailboxes' | 'mailboxStatus'>, mailbox: string, now: () => Date): Promise<{ view: MailFolderListView; entries: ImapMailboxEntry[] }> {
  const listed = await client.listMailboxes(mailbox)
  let statusComplete = true, measured = 0
  const folders: MailFolderView[] = []
  for (const entry of listed.entries) {
    const selectable = mailFolderSelectable(entry), parent = parentOf(entry)
    let counts: { messages?: number; unseen?: number } | null = null
    if (selectable && measured++ < STATUS_FOLDER_MAX) {
      try { counts = await client.mailboxStatus(entry.name, ['MESSAGES', 'UNSEEN'], mailbox) } catch (error) {
        if (!isXpanelError(error) || error.detail.reason !== 'imap_status_unavailable') throw error
      }
    }
    if (selectable && counts === null) statusComplete = false
    const leafWire = parent === null ? entry.name : entry.name.slice(parent.length + entry.delimiter!.length)
    folders.push({ folder: entry.name, name: entry.displayName ?? entry.name, nameDecoded: entry.displayName !== null, leaf: decodeImapMailboxName(leafWire) ?? leafWire,
      parent, depth: entry.delimiter ? entry.name.split(entry.delimiter).length - 1 : 0, delimiter: entry.delimiter, specialUse: mailFolderSpecialUse(entry),
      system: isSystem(entry) || descendants(listed.entries, entry).some(isSystem), selectable, subscribed: entry.subscribed, children: descendants(listed.entries, entry).length,
      messages: counts?.messages ?? null, unseen: counts?.unseen ?? null })
  }
  return { view: { mailbox, observedAt: now().toISOString(), subscriptionsObserved: listed.subscriptionsObserved, statusComplete, folders: folders.sort(order) }, entries: listed.entries }
}

const refused = (outcome: ImapCommandOutcome): never => fail(outcome.code === 'ALREADYEXISTS' ? 'CONFLICT' : 'PRECONDITION_FAILED', 'the mail server refused the folder change', {
  stateChanged: false, reason: outcome.code === 'ALREADYEXISTS' ? 'folder_exists' : 'mail_folder_refused', serverCode: outcome.code,
})
/** The fresh re-read decides: effect visible is confirmed; server refusal with no effect is refused; otherwise unknown. */
function settle(operation: MailFolderMutation['operation'], folder: string, outcome: ImapCommandOutcome, effect: boolean | null, view: MailFolderListView): MailFolderMutation | { refused: ImapCommandOutcome } {
  if (effect === true) return { operation, folder, outcome: 'confirmed', stateChanged: true, serverCode: outcome.code, view }
  // Returned, not thrown: a proven refusal must not be widened into an unknown outcome.
  if (effect === false && !outcome.ok) return { refused: outcome }
  return { operation, folder, outcome: 'unknown', stateChanged: true, verificationRequired: true, serverCode: outcome.code, view }
}

const reservedName = (wire: string, parent: string | null, delimiter: string | null): boolean => (parent === null || parent.toUpperCase() === 'INBOX')
  && DEFAULT_SYSTEM.includes((parent === null ? wire : wire.slice(parent.length + (delimiter ?? '').length)).toUpperCase())

/** /api/webmail/folders: list, create, rename, delete and subscription for the sealed mailbox only. */
export async function handleMailFolderAdminRoute(request: Request, url: URL, method: string, ports: SealedImapPorts<MailFolderAdminClient>): Promise<Response | null> {
  const route = ({ '/api/webmail/folders': 'root', '/api/webmail/folders/rename': 'rename', '/api/webmail/folders/delete': 'delete', '/api/webmail/folders/subscription': 'subscription' } as Record<string, string | undefined>)[url.pathname]
  if (!route) return null
  const allowed = route === 'root' ? ['GET', 'POST'] : ['POST']
  if (!allowed.includes(method)) return methodNotAllowed(allowed)
  const now = ports.now ?? (() => new Date())
  if (method === 'GET') {
    if (url.search) return fail('VALIDATION', 'the folder list accepts no query selectors', { stateChanged: false })
    return mailboxJson(await withSealedImap(request, ports, async (client, mailbox) => (await readMailFolders(client, mailbox, now)).view))
  }
  const shape = { root: [['name', 'parent'], ['name', 'parent']], rename: [['folder', 'name'], ['folder', 'name']], delete: [['folder', 'confirm'], ['folder']], subscription: [['folder', 'subscribed'], ['folder', 'subscribed']] }[route]!
  const body = await strictMailboxBody(request, url, shape[0]!, shape[1]!)
  let mailboxAddress = ''
  const settled = await withSealedImap(request, ports, async (client, mailbox, attempt): Promise<MailFolderMutation | { refused: ImapCommandOutcome }> => {
    mailboxAddress = mailbox
    const before = (await readMailFolders(client, mailbox, now)).entries
    if (route === 'root') {
      const parent = body.parent === null ? null : requireEntry(before, mailFolderIdentity(body.parent))
      if (parent && parent.attributes.some(item => item.toLowerCase() === '\\noinferiors')) return fail('CONFLICT', 'that folder cannot contain subfolders', { stateChanged: false, reason: 'folder_no_inferiors' })
      const delimiter = parent ? parent.delimiter : findEntry(before, 'INBOX')?.delimiter ?? null
      if (parent && delimiter === null) return fail('CONFLICT', 'this mail server does not support subfolders', { stateChanged: false, reason: 'folder_hierarchy_unsupported' })
      const wire = (parent ? parent.name + delimiter : '') + encodeImapMailboxName(mailFolderLeafName(body.name, delimiter))
      if (wire.length > 1024 || (delimiter !== null && wire.split(delimiter).length > 16)) return fail('VALIDATION', 'the folder path is too long', { stateChanged: false })
      if (findEntry(before, wire)) return fail('CONFLICT', 'a folder with that name already exists', { stateChanged: false, reason: 'folder_exists' })
      if (reservedName(wire, parent?.name ?? null, delimiter)) return protectedRefusal()
      await attempt()
      const outcome = await client.createMailbox(wire, mailbox), after = await readMailFolders(client, mailbox, now)
      return settle('create', wire, outcome, !!findEntry(after.entries, wire), after.view)
    }
    const entry = requireEntry(before, mailFolderIdentity(body.folder))
    if (route === 'subscription') {
      if (typeof body.subscribed !== 'boolean') return fail('VALIDATION', 'the subscription state must be true or false', { stateChanged: false })
      await attempt()
      const outcome = await client.setMailboxSubscription(entry.name, body.subscribed, mailbox), after = await readMailFolders(client, mailbox, now)
      const observed = after.view.subscriptionsObserved ? findEntry(after.entries, entry.name)?.subscribed === body.subscribed : null
      return settle(body.subscribed ? 'subscribe' : 'unsubscribe', entry.name, outcome, observed, after.view)
    }
    if (isSystem(entry) || descendants(before, entry).some(isSystem)) return protectedRefusal()
    if (route === 'rename') {
      const parent = parentOf(entry)
      const wire = (parent === null ? '' : parent + entry.delimiter) + encodeImapMailboxName(mailFolderLeafName(body.name, entry.delimiter))
      if (wire === entry.name) return fail('VALIDATION', 'the new folder name is the same as the current name', { stateChanged: false })
      if (wire.length > 1024) return fail('VALIDATION', 'the folder path is too long', { stateChanged: false })
      if (findEntry(before, wire)) return fail('CONFLICT', 'a folder with that name already exists', { stateChanged: false, reason: 'folder_exists' })
      if (reservedName(wire, parent, entry.delimiter)) return protectedRefusal()
      await attempt()
      const outcome = await client.renameMailbox(entry.name, wire, mailbox), after = await readMailFolders(client, mailbox, now)
      return settle('rename', wire, outcome, !!findEntry(after.entries, wire) && !findEntry(after.entries, entry.name), after.view)
    }
    if (descendants(before, entry).length) return fail('CONFLICT', 'delete or move this folder\'s subfolders first', { stateChanged: false, reason: 'folder_has_children' })
    const messages = mailFolderSelectable(entry) ? (await client.mailboxStatus(entry.name, ['MESSAGES'], mailbox)).messages ?? 0 : 0
    const confirm = body.confirm
    if (confirm !== undefined && (!object(confirm) || Object.keys(confirm).some(key => !['folder', 'messages'].includes(key))
      || typeof confirm.folder !== 'string' || !Number.isSafeInteger(confirm.messages))) return fail('VALIDATION', 'the delete confirmation names the folder and its message count', { stateChanged: false })
    if (confirm === undefined && messages > 0) return fail('CONFLICT', 'the folder still contains messages; confirm its message count to delete it', { stateChanged: false, reason: 'folder_not_empty', messages })
    if (confirm !== undefined && (confirm.folder !== entry.name || confirm.messages !== messages)) return fail('CONFLICT', 'the folder changed since it was read; review it again', { stateChanged: false, reason: 'folder_changed', messages })
    await attempt()
    const outcome = await client.deleteMailbox(entry.name, mailbox), after = await readMailFolders(client, mailbox, now)
    return settle('delete', entry.name, outcome, !findEntry(after.entries, entry.name), after.view)
  })
  if ('refused' in settled) return refused(settled.refused)
  const result = settled
  if (ports.audit) {
    try { await ports.audit(request, { action: 'webmail.folder.' + result.operation, mailbox: mailboxAddress, detail: { folder: result.folder, outcome: result.outcome } }) } catch {
      return fail('SERVICE_UNAVAILABLE', 'the folder change was made but could not be recorded; review it before retrying', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    }
  }
  return mailboxJson(result)
}
