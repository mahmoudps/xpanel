import { fail, msgid } from '@xpanel/core'
import type { HostJobCommandStep, HostJobPlan, HostJobRun } from './host-job-contract.ts'
import {
  DOVECONF_MAIL_PLUGINS_ARGV, MAILBOX_MAINTENANCE_OPERATIONS, isMailboxMaintenanceJobCommand, isMaintenanceMailbox, mailboxFoldersArgv, mailboxMaintenanceArgv, mailboxQuotaArgv,
} from '../../../packages/os/src/mailbox-maintenance-command.ts'
import type { MailboxMaintenanceOperation } from '../../../packages/os/src/mailbox-maintenance-command.ts'

export type MaintenanceRun = (argv: string[]) => Promise<{ ok: boolean; code: number | null; stdout: string }>
export type MaintenanceReason = 'user_unknown' | 'command_failed' | 'quota_error' | 'malformed_output'
export interface QuotaResource { root: string; type: 'STORAGE' | 'MESSAGE'; value: number; limit: number | null; percent: number }
export interface QuotaRead { state: 'read' | 'unavailable'; reason: MaintenanceReason | null; resources: QuotaResource[] }
export interface FolderUsage { name: string; messages: number; vsizeBytes: number }
export interface FoldersRead { state: 'read' | 'unavailable'; reason: MaintenanceReason | null; folders: FolderUsage[]; truncated: boolean; totalMessages: number | null; totalVsizeBytes: number | null }
export type FtsState = 'configured' | 'not_configured' | 'unavailable'
export interface MaintenanceMailbox { login: string; account: string; savedQuotaMb: number | null }
export interface MailboxMaintenanceReport { mailbox: string; account: string; savedQuotaMb: number | null; quota: QuotaRead; folders: FoldersRead }
export interface MailboxMaintenanceRead { observedAt: string; fts: FtsState; jobsAvailable: boolean; mailboxes: MaintenanceMailbox[]; mailboxesTruncated: boolean; report: MailboxMaintenanceReport | null }
export interface MaintenanceSnapshot {
  accounts: readonly { id: string; username: string; status: string }[]
  serviceUsers: readonly { accountId: string; login: string; services: { email: boolean }; mailboxQuotaMb: number | 'unlimited' }[]
}

export const MAILBOX_MAINTENANCE_JOB_KINDS: Readonly<Record<MailboxMaintenanceOperation, string>> = { 'quota-recalc': 'mail.maintenance.quota-recalc', resync: 'mail.maintenance.resync', index: 'mail.maintenance.index' }
// shortcut: validateHostJobPlan admits 1..32 steps, so a bulk job holds at most 32 mailboxes; raise both together if 50 is required.
export const MAILBOX_MAINTENANCE_BULK_MAX = 32
// Both bounds keep a worst-case read (254-character logins, 1024-character folder names) under the API's 1 MiB host response limit.
export const MAILBOX_LIST_MAX = 2000
export const FOLDER_ROWS_MAX = 200
const QUOTA_ROWS_MAX = 32
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/
const UNSAFE_ALL = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/g
const USERNAME = /^[a-z][a-z0-9]{0,15}$/
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
// doveadm -f json prints every value as a JSON string; numbers are accepted too.
const count = (value: unknown): number | null => {
  const number = typeof value === 'string' && /^(?:0|[1-9][0-9]{0,15})$/.test(value) ? Number(value) : value
  return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : null
}
const rows = (stdout: string): Record<string, unknown>[] | null => {
  let parsed: unknown
  try { parsed = JSON.parse(stdout) } catch { return null }
  return Array.isArray(parsed) && parsed.every(object) ? parsed : null
}
// doveadm(1) EXIT CODES: 67 means the user does not exist.
const failed = (code: number | null): MaintenanceReason => code === 67 ? 'user_unknown' : 'command_failed'

/** doveadm-quota(1) quota get: one row per quota root and resource with root, type (STORAGE in kilobytes or MESSAGE), value, limit ("-" when unlimited) and percent. */
export function parseQuotaGet(result: { ok: boolean; code: number | null; stdout: string } | null): QuotaRead {
  const none = (reason: MaintenanceReason): QuotaRead => ({ state: 'unavailable', reason, resources: [] })
  if (!result || !result.ok || result.code !== 0) return none(failed(result?.code ?? null))
  const parsed = rows(result.stdout)
  if (!parsed || parsed.length > QUOTA_ROWS_MAX) return none('malformed_output')
  const resources: QuotaResource[] = []
  for (const row of parsed) {
    if (typeof row.root !== 'string' || row.root.length < 1 || row.root.length > 128 || UNSAFE.test(row.root) || row.type !== 'STORAGE' && row.type !== 'MESSAGE') return none('malformed_output')
    // Dovecot prints "error" in the value columns when the quota backend failed for this root.
    if (row.value === 'error' || row.limit === 'error') return none('quota_error')
    const value = count(row.value), limit = row.limit === '-' ? null : count(row.limit), percent = count(row.percent)
    if (value === null || percent === null || row.limit !== '-' && limit === null) return none('malformed_output')
    resources.push({ root: row.root, type: row.type, value, limit, percent })
  }
  return { state: 'read', reason: null, resources }
}

/** doveadm-mailbox(1) mailbox status "messages vsize": one row per matching mailbox with mailbox, messages and vsize (virtual size in bytes). */
export function parseMailboxStatus(result: { ok: boolean; code: number | null; stdout: string } | null): FoldersRead {
  const none = (reason: MaintenanceReason): FoldersRead => ({ state: 'unavailable', reason, folders: [], truncated: false, totalMessages: null, totalVsizeBytes: null })
  if (!result || !result.ok || result.code !== 0) return none(failed(result?.code ?? null))
  const parsed = rows(result.stdout)
  if (!parsed) return none('malformed_output')
  const folders: FolderUsage[] = []
  let totalMessages = 0, totalVsizeBytes = 0
  for (const row of parsed) {
    const messages = count(row.messages), vsizeBytes = count(row.vsize)
    if (typeof row.mailbox !== 'string' || row.mailbox.length < 1 || row.mailbox.length > 1024 || !row.mailbox.isWellFormed() || messages === null || vsizeBytes === null) return none('malformed_output')
    totalMessages += messages; totalVsizeBytes += vsizeBytes
    if (!Number.isSafeInteger(totalVsizeBytes) || !Number.isSafeInteger(totalMessages)) return none('malformed_output')
    // Folder names are tenant-chosen; control and bidi characters are shown as replacement characters.
    if (folders.length < FOLDER_ROWS_MAX) folders.push({ name: row.mailbox.replace(UNSAFE_ALL, '\ufffd'), messages, vsizeBytes })
  }
  return { state: 'read', reason: null, folders, truncated: parsed.length > FOLDER_ROWS_MAX, totalMessages, totalVsizeBytes }
}

/** doveconf(1) -h mail_plugins: the global plugin list that doveadm loads; FTS is configured only when it names fts. */
export function parseMailPlugins(result: { ok: boolean; code: number | null; stdout: string } | null): FtsState {
  if (!result || !result.ok || result.code !== 0 || result.stdout.length > 4096 || UNSAFE.test(result.stdout.replace(/\n$/, ''))) return 'unavailable'
  return result.stdout.trim().split(/\s+/).includes('fts') ? 'configured' : 'not_configured'
}

/** Saved service users with email enabled whose account is not being removed; the only mailboxes maintenance can name. */
export function maintenanceMailboxes(snapshot: MaintenanceSnapshot): { mailboxes: MaintenanceMailbox[]; truncated: boolean } {
  const accounts = new Map(snapshot.accounts.filter(account => account.status !== 'terminating' && USERNAME.test(account.username)).map(account => [account.id, account.username]))
  const all = snapshot.serviceUsers.flatMap(user => user.services.email === true && isMaintenanceMailbox(user.login) && accounts.has(user.accountId)
    ? [{ login: user.login, account: accounts.get(user.accountId)!, savedQuotaMb: typeof user.mailboxQuotaMb === 'number' && Number.isSafeInteger(user.mailboxQuotaMb) && user.mailboxQuotaMb >= 0 ? user.mailboxQuotaMb : null }] : [])
    .sort((a, b) => a.login < b.login ? -1 : a.login > b.login ? 1 : 0)
  return { mailboxes: all.slice(0, MAILBOX_LIST_MAX), truncated: all.length > MAILBOX_LIST_MAX }
}

const attempt = (run: MaintenanceRun, argv: string[]) => run(argv).catch(() => null)

export async function readMailboxMaintenance(input: { run: MaintenanceRun; snapshot: MaintenanceSnapshot; mailbox: MaintenanceMailbox | null; jobsAvailable: boolean; now?: () => Date }): Promise<MailboxMaintenanceRead> {
  const fts = parseMailPlugins(await attempt(input.run, [...DOVECONF_MAIL_PLUGINS_ARGV]))
  const selected = input.mailbox
  const report = selected ? { mailbox: selected.login, account: selected.account, savedQuotaMb: selected.savedQuotaMb,
    quota: parseQuotaGet(await attempt(input.run, mailboxQuotaArgv(selected.login))), folders: parseMailboxStatus(await attempt(input.run, mailboxFoldersArgv(selected.login))) } : null
  // A report read carries only the selected mailbox; the picker list comes from the unselected read.
  const { mailboxes, truncated } = selected ? { mailboxes: [selected], truncated: false } : maintenanceMailboxes(input.snapshot)
  return { observedAt: (input.now?.() ?? new Date()).toISOString(), fts, jobsAvailable: input.jobsAvailable, mailboxes, mailboxesTruncated: truncated, report }
}

const TITLES: Readonly<Record<MailboxMaintenanceOperation, { named: string; numbered: string; summary: string; timeoutMs: number }>> = {
  'quota-recalc': { named: msgid('Recalculate quota: {mailbox}'), numbered: msgid('Recalculate quota: mailbox {number}'), summary: 'Recalculate Dovecot quota', timeoutMs: 600_000 },
  resync: { named: msgid('Rebuild mailbox indexes: {mailbox}'), numbered: msgid('Rebuild mailbox indexes: mailbox {number}'), summary: 'Rebuild Dovecot mailbox indexes', timeoutMs: 1_800_000 },
  index: { named: msgid('Update the search index: {mailbox}'), numbered: msgid('Update the search index: mailbox {number}'), summary: 'Update the Dovecot search index', timeoutMs: 1_800_000 },
}

/** One host job for 1..32 saved mailboxes: one step per mailbox, then a fresh read of each proves the result. */
export function buildMailboxMaintenancePlan(input: { operation: MailboxMaintenanceOperation; mailboxes: readonly string[] }): HostJobPlan {
  const { operation, mailboxes } = input
  if (!(MAILBOX_MAINTENANCE_OPERATIONS as readonly string[]).includes(operation) || !Array.isArray(mailboxes) || mailboxes.length < 1 || mailboxes.length > MAILBOX_MAINTENANCE_BULK_MAX
    || !mailboxes.every(isMaintenanceMailbox) || new Set(mailboxes).size !== mailboxes.length) return fail('VALIDATION', `select 1..${MAILBOX_MAINTENANCE_BULK_MAX} distinct saved mailboxes`, { stateChanged: false })
  const copy = TITLES[operation]
  const list = [...mailboxes]
  return {
    kind: MAILBOX_MAINTENANCE_JOB_KINDS[operation],
    summary: copy.summary + (list.length === 1 ? ' for ' + list[0] : ' for ' + list.length + ' mailboxes'),
    accountId: null, fingerprint: { operation, mailboxes: list }, detail: { operation, mailboxes: list },
    steps: list.map((mailbox, index): HostJobCommandStep => {
      // Step titles are bounded to 160 characters; a long login is named by its position instead.
      const named = mailbox.length <= 160 - copy.named.length + '{mailbox}'.length
      return { id: 'mailbox-' + (index + 1), ...(named ? { title: copy.named, titleValues: { mailbox } } : { title: copy.numbered, titleValues: { number: String(index + 1) } }),
        argv: mailboxMaintenanceArgv(operation, mailbox), timeoutMs: copy.timeoutMs, mutates: true }
    }),
    policy: argv => isMailboxMaintenanceJobCommand(argv, operation),
    verify: async (run: HostJobRun) => {
      const results: { mailbox: string; ok: boolean }[] = []
      for (const mailbox of list) {
        const argv = operation === 'quota-recalc' ? mailboxQuotaArgv(mailbox) : mailboxFoldersArgv(mailbox)
        const result = await run(argv, { timeoutMs: 60_000 }).catch(() => null)
        const read = !!result && !result.timedOut && (operation === 'quota-recalc' ? parseQuotaGet(result).state : parseMailboxStatus(result).state) === 'read'
        results.push({ mailbox, ok: read })
      }
      return { ok: results.every(item => item.ok), detail: { operation, checked: results.length, results } }
    },
  }
}
