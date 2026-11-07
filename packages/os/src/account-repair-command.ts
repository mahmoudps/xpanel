/**
 * Reviewed grammar for Account Repair over one saved home. Ownership runs as root through find -execdir and chown -h, so a
 * tenant cannot turn a path component into a symlink under a running repair; only single-link files and directories are
 * touched, so a hard link to a root file is left alone. Modes are never changed.
 */
const FIND = '/usr/bin/find'
const CHOWN = '/usr/bin/chown'
export interface AccountRepairIdentity { username: string; uid: number; gid: number; home: string }

const bad = (): never => { throw new Error('unsupported_account_repair_command') }
const id = (value: number): string => Number.isSafeInteger(value) && value >= 1000 && value <= 60000 ? String(value) : bad()
const HOME = /^\/home[1-9]?[0-9]?\/([a-z][a-z0-9]{0,15})$/
const root = (identity: AccountRepairIdentity): string => HOME.exec(identity.home)?.[1] === identity.username ? identity.home : bad()
const match = (identity: AccountRepairIdentity): string[] => [root(identity), '-xdev', '!', '-type', 'l', '(', '-type', 'd', '-o', '-links', '1', ')', '(', '!', '-uid', id(identity.uid), '-o', '!', '-gid', id(identity.gid), ')']

/** find(1) -print names each path it repairs, so the job log is the report. */
export const accountOwnerRepairArgv = (identity: AccountRepairIdentity): string[] => [FIND, ...match(identity), '-print', '-execdir', CHOWN, '-h', `${id(identity.uid)}:${id(identity.gid)}`, '{}', '+']
/** The same match with no effect: the first printed path is the evidence, and a repair must leave none. */
export const accountOwnerCheckArgv = (identity: AccountRepairIdentity): string[] => [FIND, ...match(identity), '-print', '-quit']

const same = (argv: readonly string[], expected: readonly string[]): boolean => argv.length === expected.length && expected.every((value, index) => value === argv[index])
export function isAccountRepairCommand(argv: readonly unknown[]): boolean {
  if (!Array.isArray(argv) || argv.some(item => typeof item !== 'string') || argv[0] !== FIND) return false
  const args = argv as string[], user = HOME.exec(args[1] ?? '')?.[1], uid = args[args.indexOf('-uid') + 1], gid = args[args.indexOf('-gid') + 1]
  if (!user || !/^[0-9]{4,5}$/.test(uid ?? '') || !/^[0-9]{4,5}$/.test(gid ?? '')) return false
  const identity = { username: user, uid: Number(uid), gid: Number(gid), home: args[1]! }
  return [accountOwnerRepairArgv, accountOwnerCheckArgv].some(build => { try { return same(args, build(identity)) } catch { return false } })
}
