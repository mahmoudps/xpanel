/**
 * Reviewed grammar for Repair Mailbox Permissions over one account's ~/mail tree. Ownership runs as root through
 * find -execdir and chown -h, so a tenant cannot turn a path component into a symlink under a running repair; only
 * single-link files and directories are touched, so a hard link to a root file is left alone. Modes run as the account
 * afterwards: chmod follows symlinks, and the account cannot change anything it could not already change.
 */
const FIND = '/usr/bin/find'
const SETPRIV = '/usr/bin/setpriv'
const CHOWN = '/usr/bin/chown'
const CHMOD = '/usr/bin/chmod'
const DIR_MODES = 'u+rwx,g-w,o-rwx'
const FILE_MODES = 'u+rw,g-w,o-rwx'

export interface MailboxRepairIdentity { username: string; uid: number; gid: number; home: string }
export type MailboxRepairStep = 'owner' | 'directories' | 'files'
export const MAILBOX_REPAIR_STEPS: readonly MailboxRepairStep[] = ['owner', 'directories', 'files']

const bad = (): never => { throw new Error('unsupported_mailbox_repair_command') }
const id = (value: number): string => Number.isSafeInteger(value) && value >= 1000 && value <= 60000 ? String(value) : bad()
const root = (identity: MailboxRepairIdentity): string => /^[a-z][a-z0-9]{0,15}$/.test(identity.username) && identity.home === '/home/' + identity.username ? identity.home + '/mail' : bad()
const asAccount = (identity: MailboxRepairIdentity): string[] => [SETPRIV, '--reuid', id(identity.uid), '--regid', id(identity.gid), '--clear-groups', '--no-new-privs', '--']
const ownerMatch = (identity: MailboxRepairIdentity): string[] => [root(identity), '-xdev', '!', '-type', 'l', '(', '-type', 'd', '-o', '-links', '1', ')', '(', '!', '-uid', id(identity.uid), '-o', '!', '-gid', id(identity.gid), ')']

/** find(1) -print names each path it repairs, so the job log is the report. */
export function mailboxRepairArgv(identity: MailboxRepairIdentity, step: MailboxRepairStep): string[] {
  if (step === 'owner') return [FIND, ...ownerMatch(identity), '-print', '-execdir', CHOWN, '-h', `${id(identity.uid)}:${id(identity.gid)}`, '{}', '+']
  const [type, modes, wanted] = step === 'directories' ? ['d', DIR_MODES, '-u=rwx'] : ['f', FILE_MODES, '-u=rw']
  return [...asAccount(identity), FIND, root(identity), '-xdev', '-type', type, '(', '-perm', '/g=w,o=rwx', '-o', '!', '-perm', wanted, ')', '-print', '-exec', CHMOD, modes, '{}', '+']
}
/** The same match with no effect: any printed path is a repair that did not hold. */
export const mailboxRepairCheckArgv = (identity: MailboxRepairIdentity): string[] => [FIND, ...ownerMatch(identity), '-print', '-quit']

const same = (argv: readonly string[], expected: readonly string[]): boolean => argv.length === expected.length && expected.every((value, index) => value === argv[index])
const USER = /^\/home\/([a-z][a-z0-9]{0,15})\/mail$/
const attempt = (build: () => string[]): string[] | null => { try { return build() } catch { return null } }

/** Executor and host job admission: every value is rebuilt from the argv and compared whole. */
export function isMailboxRepairCommand(argv: readonly unknown[]): boolean {
  if (!Array.isArray(argv) || argv.some(item => typeof item !== 'string')) return false
  const args = argv as string[], asRoot = args[0] === FIND
  const path = asRoot ? args[1] : args[9], user = USER.exec(path ?? '')?.[1]
  if (!user) return false
  const uid = asRoot ? args[args.indexOf('-uid') + 1] : args[2], gid = asRoot ? args[args.indexOf('-gid') + 1] : args[4]
  if (!/^[0-9]{4,5}$/.test(uid ?? '') || !/^[0-9]{4,5}$/.test(gid ?? '')) return false
  const identity = { username: user, uid: Number(uid), gid: Number(gid), home: '/home/' + user }
  return [mailboxRepairCheckArgv, ...MAILBOX_REPAIR_STEPS.map(step => (value: MailboxRepairIdentity) => mailboxRepairArgv(value, step))].some(build => { const rebuilt = attempt(() => build(identity)); return !!rebuilt && same(args, rebuilt) })
}
