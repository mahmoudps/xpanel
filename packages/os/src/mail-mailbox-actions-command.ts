import { isMaintenanceMailbox } from './mailbox-maintenance-command.ts'
import { saLearnArgv, saLearnParts } from './mailx-command.ts'
import type { SpamStoreOwner } from './mailx-command.ts'

/** Reviewed doveadm and learner grammar for actions a sealed mailbox session starts. One literal mailbox after -u; never -A or a mask. */
const DOVEADM = '/usr/bin/doveadm'
const RSPAMC = '/usr/bin/rspamc'
const FOLDERS = ['INBOX', 'Junk'] as const
export type MailLearnFolder = typeof FOLDERS[number]
export const MAIL_LEARN_DIR_PREFIX = '/tmp/xpanel-learn-'
const SAMPLE = /^\/tmp\/xpanel-learn-[A-Za-z0-9]{6}\/message\.eml$/

const bad = (): never => { throw new Error('unsupported_mail_mailbox_command') }
const user = (mailbox: string): string => isMaintenanceMailbox(mailbox) ? mailbox : bad()
/** doveadm-fetch(1): one message by UID; the pager format prints `text:`, the raw message and a form feed. */
export const mailFetchTextArgv = (mailbox: string, folder: MailLearnFolder, uid: number): string[] =>
  FOLDERS.includes(folder) && Number.isSafeInteger(uid) && uid >= 1 && uid <= 0xffffffff ? [DOVEADM, 'fetch', '-u', user(mailbox), 'text', 'mailbox', folder, 'uid', String(uid)] : bad()
/** rspamc(1) learn_spam/learn_ham and sa-learn(1) --spam/--ham read one message file. */
export function mailLearnFileArgv(engine: 'rspamd' | 'spamassassin', direction: 'spam' | 'ham', path: string, owner?: SpamStoreOwner | null): string[] {
  if (!SAMPLE.test(path) || !['spam', 'ham'].includes(direction)) return bad()
  return engine === 'rspamd' ? [RSPAMC, direction === 'spam' ? 'learn_spam' : 'learn_ham', path] : engine === 'spamassassin' && owner ? saLearnArgv(owner, direction === 'spam' ? '--spam' : '--ham', path) : bad()
}
/** doveadm-fts(1) rescan marks the whole index for rebuilding; doveadm-index(1) then fills it for every folder. */
export const mailFtsRescanArgv = (mailbox: string): string[] => [DOVEADM, 'fts', 'rescan', '-u', user(mailbox)]
export const mailIndexAllArgv = (mailbox: string): string[] => [DOVEADM, 'index', '-u', user(mailbox), '*']

const same = (argv: readonly string[], expected: readonly string[]): boolean => argv.length === expected.length && expected.every((value, index) => value === argv[index])
const attempt = (build: () => string[]): string[] | null => { try { return build() } catch { return null } }
const strings = (argv: readonly unknown[]): argv is string[] => Array.isArray(argv) && argv.every(value => typeof value === 'string')
/** Host job policy for a reindex. */
export function isMailReindexCommand(argv: readonly unknown[]): boolean {
  if (!strings(argv)) return false
  const mailbox = argv[argv.indexOf('-u') + 1] ?? ''
  return [mailFtsRescanArgv, mailIndexAllArgv].some(build => { const rebuilt = attempt(() => build(mailbox)); return !!rebuilt && same(argv, rebuilt) })
}
/** Executor admission for the single-message training read and learn. */
export function isMailMailboxActionCommand(argv: readonly unknown[]): boolean {
  if (!strings(argv)) return false
  if (argv[0] === DOVEADM) { const rebuilt = attempt(() => mailFetchTextArgv(argv[3] ?? '', argv[6] as MailLearnFolder, Number(argv[8]))); return !!rebuilt && same(argv, rebuilt) }
  const parts = saLearnParts(argv)
  if (parts) { const rebuilt = attempt(() => mailLearnFileArgv('spamassassin', parts.flag === '--spam' ? 'spam' : 'ham', parts.path, parts.owner)); return !!rebuilt && same(argv, rebuilt) }
  const direction = argv[0] !== RSPAMC ? null : argv[1] === 'learn_spam' ? 'spam' : argv[1] === 'learn_ham' ? 'ham' : null
  const rebuilt = direction ? attempt(() => mailLearnFileArgv('rspamd', direction, argv[2] ?? '')) : null
  return !!rebuilt && same(argv, rebuilt)
}
