import { isIP } from 'node:net'
import { posix } from 'node:path'

/** Reviewed fail2ban, ClamAV and isolation-observation grammar. Every argv is fixed except bounded identities. */
export const FAIL2BAN_CLIENT = '/usr/bin/fail2ban-client'
export const CLAMSCAN = '/usr/bin/clamscan'
export const FRESHCLAM = '/usr/bin/freshclam'
const NICE = '/usr/bin/nice'
const SYSTEMCTL = '/usr/bin/systemctl'
const GETENT = '/usr/bin/getent'

// Stricter than fail2ban's own names: no leading '-' so a jail can never read as an option.
export const isFail2banJail = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)
/** One plain IPv4 or IPv6 address, exactly as fail2ban-client prints it; no CIDR, zone id or hostname. */
export const isFail2banAddress = (value: unknown): value is string => typeof value === 'string' && /^[0-9A-Fa-f:.]{2,45}$/.test(value) && isIP(value) !== 0
export const isAccountUsername = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9]{0,15}$/.test(value)
const isUid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value < 0xffff_ffff
const isPhpVersion = (value: unknown): value is string => typeof value === 'string' && /^[5-9]\.[0-9]{1,2}$/.test(value)
/** A canonical absolute account home (store home after realpath): <base>/<username>, never a top-level directory. */
export const isScanTarget = (value: unknown): value is string => typeof value === 'string' && value.length <= 1024 && posix.isAbsolute(value) && posix.normalize(value) === value
  && value.split('/').length >= 3 && value.split('/').slice(1).every(part => /^[A-Za-z0-9_][A-Za-z0-9._-]{0,254}$/.test(part) && part !== '..') && isAccountUsername(posix.basename(value))

export const FAIL2BAN_STATUS_ARGV = [FAIL2BAN_CLIENT, 'status'] as const
export const fail2banJailStatusArgv = (jail: string): string[] => isFail2banJail(jail) ? [FAIL2BAN_CLIENT, 'status', jail] : invalid()
// fail2ban-client(1): "set <JAIL> unbanip <IP> ... unbans <IP> (in <JAIL>)".
export const fail2banUnbanArgv = (jail: string, address: string): string[] => isFail2banJail(jail) && isFail2banAddress(address) ? [FAIL2BAN_CLIENT, 'set', jail, 'unbanip', address] : invalid()
export const CLAMSCAN_VERSION_ARGV = [CLAMSCAN, '--version'] as const
// freshclam(1) --quiet: only output error messages.
export const FRESHCLAM_UPDATE_ARGV = [FRESHCLAM, '--quiet'] as const
/**
 * clamscan(1): recurse, print infected files only, never follow symlinks (a tenant link must not make root
 * read files outside the home), and skip files or archives above the documented default size bounds.
 * nice(1) keeps a long root scan from starving the panel on a single vCPU.
 */
export const clamscanHomeArgv = (target: string): string[] => isScanTarget(target)
  ? [NICE, '-n', '19', CLAMSCAN, '--recursive', '--infected', '--follow-dir-symlinks=0', '--follow-file-symlinks=0', '--max-filesize=100M', '--max-scansize=400M', target] : invalid()
export const SLICE_SHOW_PROPERTIES = '--property=LoadState,ActiveState'
export const FPM_SHOW_PROPERTIES = '--property=LoadState,ActiveState,User,Group,Slice'
export const accountSliceShowArgv = (uid: number): string[] => isUid(uid) ? [SYSTEMCTL, 'show', `xpanel-${uid}.slice`, SLICE_SHOW_PROPERTIES] : invalid()
export const fpmUnitShowArgv = (username: string, version: string): string[] => isAccountUsername(username) && isPhpVersion(version)
  ? [SYSTEMCTL, 'show', `xpanel-php-fpm-${username}-${version}.service`, FPM_SHOW_PROPERTIES] : invalid()
export const getentPasswdArgv = (username: string): string[] => isAccountUsername(username) ? [GETENT, '--', 'passwd', username] : invalid()

function invalid(): never { throw new Error('unsupported_security_tools_command') }
const strings = (argv: readonly unknown[]): argv is string[] => Array.isArray(argv) && argv.every(value => typeof value === 'string')
const same = (argv: readonly string[], expected: readonly string[]): boolean => argv.length === expected.length && expected.every((value, index) => value === argv[index])
const sliceUid = (unit: string): number => { const match = /^xpanel-([1-9][0-9]{0,9})\.slice$/.exec(unit); return match ? Number(match[1]) : 0 }

/** Executor admission for observations and the single-address unban. */
export function isSecurityToolsCommand(argv: readonly unknown[]): boolean {
  if (!strings(argv)) return false
  if (same(argv, FAIL2BAN_STATUS_ARGV) || same(argv, CLAMSCAN_VERSION_ARGV)) return true
  if (argv[0] === FAIL2BAN_CLIENT) return argv.length === 3 ? argv[1] === 'status' && isFail2banJail(argv[2]) : argv.length === 5 && argv[1] === 'set' && isFail2banJail(argv[2]) && argv[3] === 'unbanip' && isFail2banAddress(argv[4])
  if (argv[0] === SYSTEMCTL && argv.length === 4 && argv[1] === 'show') {
    if (argv[3] === SLICE_SHOW_PROPERTIES) return isUid(sliceUid(argv[2]!))
    const match = /^xpanel-php-fpm-([a-z][a-z0-9]{0,15})-([5-9]\.[0-9]{1,2})\.service$/.exec(argv[2]!)
    return argv[3] === FPM_SHOW_PROPERTIES && !!match
  }
  return argv.length === 4 && argv[0] === GETENT && argv[1] === '--' && argv[2] === 'passwd' && isAccountUsername(argv[3])
}

/** Host job policy for antivirus jobs: one account-home scan or one signature update. */
export function isAntivirusJobCommand(argv: readonly unknown[]): boolean {
  if (!strings(argv)) return false
  if (same(argv, FRESHCLAM_UPDATE_ARGV)) return true
  const target = argv.at(-1)
  return isScanTarget(target) && same(argv, clamscanHomeArgv(target))
}
