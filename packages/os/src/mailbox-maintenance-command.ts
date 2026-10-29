/**
 * Reviewed Dovecot mailbox maintenance grammar: doveadm(1) quota get/recalc, mailbox status, force-resync and index,
 * plus `doveconf -h mail_plugins`. Every argv names exactly one literal mailbox login after `-u`; never `-A`, `-F`,
 * `-S` or a `*`/`?` user mask (doveadm(1) expands those in -u). The only wildcard is the documented mailbox mask.
 */
const DOVEADM = '/usr/bin/doveadm'
const DOVECONF = '/usr/bin/doveconf'
const LOCAL = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9_-])?$/
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** A saved service login (local@domain, lowercase): the local part starts with a letter or digit, so it can never read as an option. */
export const isMaintenanceMailbox = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 254) return false
  const at = value.indexOf('@')
  if (at < 1 || at !== value.lastIndexOf('@')) return false
  const local = value.slice(0, at), labels = value.slice(at + 1).split('.')
  return LOCAL.test(local) && !local.includes('..') && labels.length >= 2 && labels.every(label => LABEL.test(label))
}

export const MAILBOX_MAINTENANCE_OPERATIONS = ['quota-recalc', 'resync', 'index'] as const
export type MailboxMaintenanceOperation = typeof MAILBOX_MAINTENANCE_OPERATIONS[number]
export const isMailboxMaintenanceOperation = (value: unknown): value is MailboxMaintenanceOperation => (MAILBOX_MAINTENANCE_OPERATIONS as readonly unknown[]).includes(value)

// doveadm-mailbox(1) mailbox status: "fields" is one space-separated argument, followed by the mailbox mask.
export const MAILBOX_STATUS_FIELDS = 'messages vsize'
// doveconf(1) -h prints only the value; mail_plugins holds plugin names, never a secret.
export const DOVECONF_MAIL_PLUGINS_ARGV = [DOVECONF, '-h', 'mail_plugins'] as const

function invalid(): never { throw new Error('unsupported_mailbox_maintenance_command') }
const user = (mailbox: string): string => isMaintenanceMailbox(mailbox) ? mailbox : invalid()
export const mailboxQuotaArgv = (mailbox: string): string[] => [DOVEADM, '-f', 'json', 'quota', 'get', '-u', user(mailbox)]
export const mailboxFoldersArgv = (mailbox: string): string[] => [DOVEADM, '-f', 'json', 'mailbox', 'status', '-u', user(mailbox), MAILBOX_STATUS_FIELDS, '*']
/**
 * doveadm-quota(1) "quota recalc" recalculates the current quota usage; doveadm-force-resync(1) fixes broken mailbox
 * indexes for every mailbox matching the mask; doveadm-index(1) adds unindexed INBOX messages to the index and, when
 * full text search is enabled, to the FTS database.
 */
export const mailboxMaintenanceArgv = (operation: MailboxMaintenanceOperation, mailbox: string): string[] =>
  operation === 'quota-recalc' ? [DOVEADM, 'quota', 'recalc', '-u', user(mailbox)]
    : operation === 'resync' ? [DOVEADM, 'force-resync', '-u', user(mailbox), '*']
      : operation === 'index' ? [DOVEADM, 'index', '-u', user(mailbox), 'INBOX'] : invalid()

const strings = (argv: readonly unknown[]): argv is string[] => Array.isArray(argv) && argv.every(value => typeof value === 'string')
const same = (argv: readonly string[], expected: readonly string[]): boolean => argv.length === expected.length && expected.every((value, index) => value === argv[index])

/** Executor admission for the observations: quota, folder usage and the FTS plugin check. */
export function isMailboxMaintenanceCommand(argv: readonly unknown[]): boolean {
  if (!strings(argv)) return false
  if (same(argv, DOVECONF_MAIL_PLUGINS_ARGV)) return true
  const mailbox = argv[6]
  return isMaintenanceMailbox(mailbox) && (same(argv, mailboxQuotaArgv(mailbox)) || same(argv, mailboxFoldersArgv(mailbox)))
}

/** Host job policy: one maintenance step for one mailbox, optionally restricted to one operation. */
export function isMailboxMaintenanceJobCommand(argv: readonly unknown[], operation?: MailboxMaintenanceOperation): boolean {
  if (!strings(argv)) return false
  const mailbox = argv[argv.indexOf('-u') + 1]
  return isMaintenanceMailbox(mailbox) && (operation ? [operation] : MAILBOX_MAINTENANCE_OPERATIONS).some(item => same(argv, mailboxMaintenanceArgv(item, mailbox)))
}
