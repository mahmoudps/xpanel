import { isIP } from 'node:net'
import { join } from 'node:path'
import { assessMailboxMetadataAuthority, fail, isXpanelError } from '@xpanel/core'
import type { MailboxMetadataAuthority } from '@xpanel/core'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import type { EmailSender } from '../alert-delivery.ts'
import { mailboxJson, methodNotAllowed, strictMailboxBody } from './folder-admin.ts'
import type { SealedMailboxAuditEvent, SealedMailboxSession } from './folder-admin.ts'
import { captureMailboxMetadataAuthority } from './metadata-authority.ts'
import type { MailboxMetadataAuthorityStore } from './metadata-authority.ts'

/** Contact Information and plus addressing of one sealed mailbox; the agent renders plusFolders into its Sieve policy. */
export const PLUS_FOLDER_MODES = ['off', 'create', 'existing'] as const
export const MAX_NOTIFY_ADDRESSES = 5
export interface MailboxSettingsFields { addresses: string[]; loginAlerts: boolean; alertKnownRanges: boolean; plusFolders: typeof PLUS_FOLDER_MODES[number] }
export interface MailboxSettingsRecord extends MailboxSettingsFields { mailbox: string; ownerAuthority: MailboxMetadataAuthority; updatedAt: string }
export interface MailboxSettingsPorts {
  open: (request: Request) => Promise<SealedMailboxSession>
  store: MailboxMetadataAuthorityStore & Pick<StateStore, 'rootDir' | 'getWriterLock'>
  audit: (request: Request, event: SealedMailboxAuditEvent) => Promise<void>
  /** The host reconcile that re-renders the mailbox Sieve policy; absent leaves plus addressing pending. */
  reconcile?: () => Promise<boolean>
  /** Server mail sender; absent means no notice can be sent. */
  email?: EmailSender | null
  now?: () => Date
}

export const DEFAULT_MAILBOX_SETTINGS: MailboxSettingsFields = { addresses: [], loginAlerts: false, alertKnownRanges: false, plusFolders: 'off' }
const unchanged = { stateChanged: false }
const ADDRESS = /^[^\s@<>,;]{1,64}@[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/
const KEYS = ['addresses', 'loginAlerts', 'alertKnownRanges', 'plusFolders'] as const
const settingsFile = (root: string, mailbox: string): string => join(root, 'extended', 'webmail', 'mailbox-settings', `${encodeURIComponent(mailbox)}.json`)
const seenFile = (root: string, mailbox: string): string => join(root, 'extended', 'webmail', 'login-seen', `${encodeURIComponent(mailbox)}.json`)

export function parseMailboxSettings(value: Record<string, unknown>): MailboxSettingsFields {
  const { addresses, loginAlerts, alertKnownRanges, plusFolders } = value
  if (!Array.isArray(addresses) || addresses.length > MAX_NOTIFY_ADDRESSES) return fail('VALIDATION', `at most ${MAX_NOTIFY_ADDRESSES} notification addresses`, unchanged)
  const normal = addresses.map(item => typeof item === 'string' ? item.trim().toLowerCase() : '')
  if (normal.some(item => !ADDRESS.test(item)) || new Set(normal).size !== normal.length) return fail('VALIDATION', 'a notification address is invalid', { ...unchanged, reason: 'invalid_address' })
  if (typeof loginAlerts !== 'boolean' || typeof alertKnownRanges !== 'boolean') return fail('VALIDATION', 'login alert switches must be true or false', unchanged)
  if (!(PLUS_FOLDER_MODES as readonly unknown[]).includes(plusFolders)) return fail('VALIDATION', 'plusFolders must be off, create or existing', unchanged)
  return { addresses: normal, loginAlerts, alertKnownRanges, plusFolders: plusFolders as MailboxSettingsFields['plusFolders'] }
}

const readRecord = async (root: string, mailbox: string, authority: MailboxMetadataAuthority): Promise<MailboxSettingsFields | null> => {
  const stored = await readJsonIfExists<Record<string, unknown>>(settingsFile(root, mailbox))
  if (stored === null || assessMailboxMetadataAuthority(stored.mailbox, stored.ownerAuthority, authority) !== 'match') return null
  try { return parseMailboxSettings(stored) } catch { return null }
}

/** /24 of IPv4, /48 of IPv6: a location's network, as cPanel's previously used range. */
export const loginRange = (ip: string): string => isIP(ip) === 4 ? ip.split('.').slice(0, 3).join('.') : ip.split(':').slice(0, 3).join(':')

export interface LoginSeen { ips: Record<string, string>; notifiedAt: Record<string, string> }
const DAY = 86400000
/** Whether this sign-in deserves a notice: never for a known IP, at most once in 24 hours per IP, ranges only when asked. */
export function loginAlertDue(seen: LoginSeen, ip: string, alertKnownRanges: boolean, now: number): boolean {
  if (Object.hasOwn(seen.ips, ip)) return false
  if (!alertKnownRanges && Object.keys(seen.ips).some(known => loginRange(known) === loginRange(ip))) return false
  const last = seen.notifiedAt[ip]
  return last === undefined || now - Date.parse(last) >= DAY
}

/** Called after a successful mailbox sign-in. A failed notice never blocks the sign-in. */
export async function noteMailboxLogin(input: { rootDir: string; store: MailboxMetadataAuthorityStore; mailbox: string; ip: string; email: EmailSender | null; serverName: string; now?: Date }): Promise<void> {
  const when = input.now ?? new Date(), mailbox = input.mailbox.toLowerCase()
  try {
    const authority = await captureMailboxMetadataAuthority(input.store, mailbox), settings = await readRecord(input.rootDir, mailbox, authority)
    if (!settings?.loginAlerts || !settings.addresses.length) return
    const seen = await readJsonIfExists<LoginSeen>(seenFile(input.rootDir, mailbox)) ?? { ips: {}, notifiedAt: {} }
    const due = loginAlertDue(seen, input.ip, settings.alertKnownRanges, when.getTime())
    const ips = Object.fromEntries(Object.entries({ ...seen.ips, [input.ip]: when.toISOString() }).sort((a, b) => b[1].localeCompare(a[1])).slice(0, 200))
    await atomicWriteJson(seenFile(input.rootDir, mailbox), { ips, notifiedAt: due ? { ...seen.notifiedAt, [input.ip]: when.toISOString() } : seen.notifiedAt }, 0o640)
    if (due && input.email) await input.email({ to: settings.addresses, subject: `New sign-in to ${mailbox}`, text: `${mailbox} signed in to webmail on ${input.serverName}.\nAddress: ${input.ip}\nTime: ${when.toISOString().slice(0, 16).replace('T', ' ')} UTC\n` })
  } catch { /* the sign-in already succeeded; a missed notice is not a sign-in failure */ }
}

export async function handleMailboxSettingsRoute(request: Request, url: URL, method: string, ports: MailboxSettingsPorts): Promise<Response | null> {
  if (url.pathname !== '/api/webmail/mailbox-settings') return null
  if (method !== 'GET' && method !== 'PUT') return methodNotAllowed(['GET', 'PUT'])
  const session = await ports.open(request), mailbox = session.record.mailbox.trim().toLowerCase()
  const authority = await captureMailboxMetadataAuthority(ports.store, mailbox)
  if (authority.accountId !== session.record.accountId.toLowerCase() || authority.serviceUserId !== session.record.serviceUserId.toLowerCase()) return fail('FORBIDDEN', 'mailbox lifetime changed; sign in again', unchanged)
  const domain = mailbox.slice(mailbox.lastIndexOf('@') + 1)
  const view = async (): Promise<Record<string, unknown>> => ({ context: { mailbox }, settings: await readRecord(ports.store.rootDir, mailbox, authority) ?? DEFAULT_MAILBOX_SETTINGS, senderAvailable: !!ports.email, hostedDomain: domain })
  if (method === 'GET') { if (url.search) return fail('VALIDATION', 'mailbox settings accept no query selectors', unchanged); return mailboxJson(await view()) }
  let fields: MailboxSettingsFields
  try { fields = parseMailboxSettings(await strictMailboxBody(request, url, KEYS, KEYS)) } catch (error) {
    if (isXpanelError(error)) return fail(error.code, error.message, { ...error.detail, ...unchanged })
    throw error
  }
  const before = await readRecord(ports.store.rootDir, mailbox, authority) ?? DEFAULT_MAILBOX_SETTINGS
  const lease = await ports.store.getWriterLock().acquire()
  try {
    await lease.assertFencingToken()
    const record: MailboxSettingsRecord = { mailbox, ownerAuthority: authority, ...fields, updatedAt: (ports.now ?? (() => new Date()))().toISOString() }
    await atomicWriteJson(settingsFile(ports.store.rootDir, mailbox), record, 0o640, () => lease.assertFencingToken())
  } finally { await lease.release() }
  // cPanel tells the stored address when login alerts go off, so a hijacker cannot switch them off unseen.
  if (before.loginAlerts && !fields.loginAlerts && before.addresses.length && ports.email) await ports.email({ to: before.addresses, subject: `Login alerts turned off for ${mailbox}`, text: `Login alerts for ${mailbox} were turned off.\n` }).catch(() => undefined)
  const applied = before.plusFolders === fields.plusFolders ? true : await (ports.reconcile?.() ?? Promise.resolve(false)).catch(() => false)
  await ports.audit(request, { action: 'webmail.mailbox-settings.updated', mailbox, detail: { addresses: fields.addresses.length, loginAlerts: fields.loginAlerts, plusFolders: fields.plusFolders } })
  return mailboxJson({ ...await view(), stateChanged: true, plusApplied: applied })
}
