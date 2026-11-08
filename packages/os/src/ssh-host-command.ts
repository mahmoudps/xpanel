import { fail } from '@xpanel/core'

/** Reviewed argv for the SSH page: exact journal reads, unit start and stop, and the SELinux port label. No shell, no caller-chosen unit or path. */
const JOURNALCTL = '/usr/bin/journalctl', SYSTEMCTL = '/usr/bin/systemctl', SEMANAGE = '/usr/sbin/semanage', RUNUSER = '/usr/sbin/runuser'
export const SSH_LOGIN_LINES = 2000
export const SSH_COUNT_LINES = 30000
export const SSH_SERVICE_UNITS = ['ssh.service', 'sshd.service'] as const
export const SSH_SOCKET_UNIT = 'ssh.socket'
const FIELDS = '--output-fields=MESSAGE,_SYSTEMD_UNIT,_UID,_COMM,_EXE'
// journalctl(1) --show-cursor format: serial, sequence, boot, monotonic, realtime and hash fields, all hexadecimal.
const CURSOR = /^s=[0-9a-f]{32};i=[0-9a-f]{1,16};b=[0-9a-f]{32};m=[0-9a-f]{1,16};t=[0-9a-f]{1,16};x=[0-9a-f]{1,16}$/
export const isSshJournalCursor = (value: unknown): value is string => typeof value === 'string' && CURSOR.test(value)
const unitOk = (unit: unknown): unit is typeof SSH_SERVICE_UNITS[number] => (SSH_SERVICE_UNITS as readonly unknown[]).includes(unit)
const portOk = (port: unknown): port is number => typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535

/** The last entry only with no cursor: a new alarm starts at the present, never from history. */
export const sshLoginsArgv = (unit: string, cursor: string | null): string[] => {
  if (!unitOk(unit) || cursor !== null && !isSshJournalCursor(cursor)) return fail('VALIDATION', 'unsupported SSH journal read', { stateChanged: false })
  return [JOURNALCTL, '--unit', unit, '--no-pager', '--output=json', FIELDS, ...(cursor === null ? ['--lines=1'] : ['--after-cursor', cursor, `--lines=${SSH_LOGIN_LINES}`])]
}

export const sshCountArgv = (unit: string, range: 'today' | 'all'): string[] => {
  if (!unitOk(unit)) return fail('VALIDATION', 'unsupported SSH journal read', { stateChanged: false })
  return [JOURNALCTL, '--unit', unit, '--no-pager', '--output=cat', `--lines=${SSH_COUNT_LINES}`, ...(range === 'today' ? ['--since', 'today'] : [])]
}

export const sshServiceArgv = (verb: 'start' | 'stop', unit: string): string[] => {
  if (!unitOk(unit) && unit !== SSH_SOCKET_UNIT) return fail('VALIDATION', 'unsupported SSH unit', { stateChanged: false })
  return [SYSTEMCTL, verb, '--', unit]
}

export const SSH_PORT_LIST = [SEMANAGE, 'port', '-l'] as const
export const sshPortLabelArgv = (mode: '-a' | '-m', port: number): string[] => {
  if (!portOk(port)) return fail('VALIDATION', 'SSH port must be 1-65535', { stateChanged: false })
  return [SEMANAGE, 'port', mode, '-t', 'ssh_port_t', '-p', 'tcp', String(port)]
}

export const SHELL_JAIL_SUDOERS_TEST = ['/usr/sbin/visudo', '-cf', '/etc/sudoers.d/xpanel-shell-jail'] as const

/** One fixed read as the account through its own login shell; the shell text never holds request input. */
export const SHELL_JAIL_LIST_HOMES = 'ls -A /home'
export const SHELL_JAIL_LIST_TMP = 'ls -A /tmp'
export const shellJailProbeArgv = (username: string, command: typeof SHELL_JAIL_LIST_HOMES | typeof SHELL_JAIL_LIST_TMP | string): string[] => {
  if (!/^[a-z][a-z0-9]{0,15}$/.test(username) || ![SHELL_JAIL_LIST_HOMES, SHELL_JAIL_LIST_TMP].includes(command) && !/^ls -A \/home[1-9]?[0-9]?\/[a-z][a-z0-9]{0,15}$/.test(command)) return fail('VALIDATION', 'unsupported shell jail probe', { stateChanged: false })
  return [RUNUSER, '-u', username, '--', '/opt/xpanel/bin/jailshell', '-c', command]
}

const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((item, index) => item === b[index])

export function isSshHostCommand(argv: readonly string[]): boolean {
  if (!Array.isArray(argv) || argv.some(item => typeof item !== 'string')) return false
  if (same(argv, SSH_PORT_LIST) || same(argv, SHELL_JAIL_SUDOERS_TEST)) return true
  if (argv[0] === JOURNALCTL) {
    const unit = argv[2]!, cursor = argv[6] === '--after-cursor' ? argv[7]! : null
    return unitOk(unit) && (cursor === null ? same(argv, sshLoginsArgv(unit, null)) || same(argv, sshCountArgv(unit, 'today')) || same(argv, sshCountArgv(unit, 'all')) : isSshJournalCursor(cursor) && same(argv, sshLoginsArgv(unit, cursor)))
  }
  if (argv[0] === SYSTEMCTL) return ['start', 'stop'].includes(argv[1]!) && argv[2] === '--' && argv.length === 4 && (unitOk(argv[3]) || argv[3] === SSH_SOCKET_UNIT)
  if (argv[0] === SEMANAGE) { const port = Number(argv.at(-1)); return (argv[2] === '-a' || argv[2] === '-m') && portOk(port) && same(argv, sshPortLabelArgv(argv[2], port)) }
  if (argv[0] === RUNUSER) { try { return same(argv, shellJailProbeArgv(argv[2]!, argv[6]!)) } catch { return false } }
  return false
}
